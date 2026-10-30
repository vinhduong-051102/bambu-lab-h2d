import { randomInt } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { z } from 'zod';
import { env } from '../../config/env';
import {
  buildFixRequest,
  buildRequest,
  CAD_FILES,
  CadJobStore,
  CadWorkerClient,
  CadWorkerError,
  FIGURE_SIDES,
  guideTaskKey,
  lineageOf,
  MeshWorkerClient,
  type Attachment,
  type CadFileName,
  type CadJob,
  type CadWorkerApi,
  type MeshColour,
  type MeshParams,
  type MeshWorkerApi,
  type SideViews,
} from '../../domain/cad/cadJobs';
import type { PrinterState } from '../../domain/PrinterState';
import type { BambuColourCatalogue } from '../../domain/filaments/bambuColors';
import { colourCatalogue, customFilaments, recipeBook } from './filaments';
import { customLabel } from '../../domain/filaments/customFilaments';
import { familyOf } from '../../domain/filaments/bambuColors';
import { suggestMix } from '../../domain/filaments/colourMixing';
import { saveStudioImport, safeFileName } from '../../domain/studio/studioImports';
import { serveFile } from './timelapse';
import { startTask } from '../../domain/backgroundTasks';
import { handler, json, readJsonBody } from '../http';

/** Models the dashboard offers for writing a model; the first is used when a request names none */
const CAD_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (chính xác nhất)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (nhanh, tốn ít lượt hơn)' },
];

const MAX_CODE_BYTES = 200 * 1024;
// What the worker refuses at once is answered at once; a guide being drawn goes on in the background
const GUIDE_WAIT_MS = 1500;
const MAX_JOB_LIST = 100;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
// PNG, JPEG and WebP by their first bytes: the mesh worker opens any of them, whatever the file is called
const IMAGE_SIGNATURES = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x52, 0x49, 0x46, 0x46]];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'webp'];
// Pictures pasted into a revision, sent as base64 (data: URLs) in its JSON
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const imagesField = z.array(z.string()).max(MAX_ATTACHMENTS, `Tối đa ${MAX_ATTACHMENTS} ảnh.`).default([]);

let workerOverride: CadWorkerApi | null = null;
let meshWorkerOverride: MeshWorkerApi | null = null;
let storeOverride: CadJobStore | null = null;

/** Tests replace the CAD container with a fake; null restores CAD_WORKER_URL */
export function setCadWorker(worker: CadWorkerApi | null): void {
  workerOverride = worker;
}

/** Tests replace the mesh container with a fake; null restores MESH_WORKER_URL */
export function setMeshWorker(worker: MeshWorkerApi | null): void {
  meshWorkerOverride = worker;
}

/** Tests keep jobs in a temporary folder; null restores CAD_JOBS_DIR */
export function setCadJobStore(store: CadJobStore | null): void {
  storeOverride = store;
}

const worker = (): CadWorkerApi | null => workerOverride ?? (env.CAD_WORKER_URL ? new CadWorkerClient(env.CAD_WORKER_URL) : null);
const meshWorker = (): MeshWorkerApi | null =>
  meshWorkerOverride ?? (env.MESH_WORKER_URL ? new MeshWorkerClient(env.MESH_WORKER_URL) : null);
const store = () => storeOverride ?? new CadJobStore(path.resolve(env.CAD_JOBS_DIR));

const disabled = () =>
  json({ success: false, error: 'CAD_DISABLED', message: 'Chưa cấu hình CAD_WORKER_URL (docker-compose.cad.yml, docs/cad.md).' }, 501);
const meshDisabled = () =>
  json({ success: false, error: 'MESH_DISABLED', message: 'Chưa cấu hình MESH_WORKER_URL (docker-compose.mesh3d.yml, docs/cad.md).' }, 501);
const jobNotFound = () => json({ success: false, error: 'JOB_NOT_FOUND', message: 'Không tìm thấy mô hình này.' }, 404);
const workerFailed = (err: CadWorkerError) =>
  json({ success: false, error: err.code, message: err.message }, err.status >= 500 || err.status < 400 ? 502 : err.status);

const invalidPayload = (error: z.ZodError) => {
  const issue = error.issues[0];
  return json({ success: false, error: 'INVALID_PAYLOAD', message: `${issue.path.join('.') || '(gốc)'}: ${issue.message}` }, 400);
};

/**
 * A job whose status still says running though the worker no longer runs it (the container restarted)
 * is shown as failed; `running` is null when that could not be asked.
 */
function settle(job: CadJob, running: string[] | null): CadJob {
  if (job.state !== 'running' || !running || running.includes(job.id)) return job;
  return { ...job, state: 'failed', error: 'Container CAD đã khởi động lại giữa chừng: tạo lại mô hình.' };
}

async function runningJobs(jobs: CadJob[]): Promise<string[] | null> {
  const busy = jobs.filter((job) => job.state === 'running');
  if (busy.length === 0) return null;
  // Only the workers that have such a job are asked; one that can't be asked leaves the jobs as they are
  const ask = async (w: CadWorkerApi | MeshWorkerApi | null, needed: boolean) =>
    !needed ? [] : w ? w.health().then((health) => health.running, () => null) : null;
  const [cad, mesh] = await Promise.all([
    ask(worker(), busy.some((job) => job.source !== 'mesh')),
    ask(meshWorker(), busy.some((job) => job.source === 'mesh')),
  ]);
  return cad && mesh ? [...cad, ...mesh] : null;
}

const jobSchema = z.object({
  prompt: z.string().trim().min(3, 'Mô tả quá ngắn.'),
  model: z.string().optional(),
  // A revision: the prompt says what to change in that job's model
  parent_id: z.string().optional(),
  // Pictures pasted with the prompt (data: URLs or base64), for Claude to look at
  images: imagesField,
});

const buildSchema = z.object({
  code: z.string().min(1, 'Thiếu code.').refine((code) => Buffer.byteLength(code) <= MAX_CODE_BYTES, 'Code dài quá 200 KB.'),
  title: z.string().trim().max(120).optional(),
  prompt: z.string().trim().optional(),
  parent_id: z.string().optional(),
});

// GET /api/cad - Whether AI modelling is set up, whether its container answers, and the models it offers
export const getCad = handler(async () => {
  const w = worker();
  const m = meshWorker();
  if (!w && !m) return json({ enabled: false });
  const failed = (err: unknown) => ({ online: false, claude: false, error: err instanceof Error ? err.message : String(err) });
  // null for a worker that is not set up: the dashboard then only offers the other kind of model
  const [health, mesh] = await Promise.all([
    w ? w.health().then((h) => ({ online: true, claude: h.claude, error: null }), failed) : null,
    m ? m.health().then((h) => ({ online: true, claude: h.claude, loaded: h.loaded ?? false, error: null }), failed) : null,
  ]);
  return json({
    enabled: true,
    worker: health,
    mesh,
    models: CAD_MODELS,
    default_model: CAD_MODELS.some((m) => m.id === env.CAD_AI_MODEL) ? env.CAD_AI_MODEL : CAD_MODELS[0].id,
    // Bambu materials with their own colours, for painting figures in colours one can buy (empty offline)
    bambu_materials: m ? ((await colourCatalogue())?.materials(4) ?? []) : [],
    bambu_families: m ? ((await colourCatalogue())?.families() ?? []) : [],
    studio_imports: !!env.STUDIO_IMPORT_DIR,
  });
});

// GET /api/cad/guide - The modelling rules and build123d primer Claude works from, for other agents (Antigravity)
export const getCadGuide = handler(async () => {
  const guide = await fs.readFile(path.resolve('cad/guide.md'), 'utf8').catch(() => null);
  if (guide === null) return json({ success: false, error: 'GUIDE_NOT_FOUND', message: 'Không tìm thấy cad/guide.md.' }, 404);
  return new Response(guide, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
});

// GET /api/cad/jobs?limit=30 - Models, newest first
export const listCadJobs = handler(async ({ request }) => {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 30);
  const jobs = await store().list(Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_JOB_LIST) : 30);
  const running = await runningJobs(jobs);
  return json({ success: true, jobs: await Promise.all(jobs.map((job) => withMixes(settle(job, running)))) });
});

/** The latest jobs as the list shows them (a job its worker no longer runs is settled as interrupted), for the task
 * panel; null when the CAD feature is off */
export async function recentCadJobs(limit: number): Promise<CadJob[] | null> {
  if (!worker() && !meshWorker()) return null;
  const jobs = await store().list(limit);
  const running = await runningJobs(jobs);
  return jobs.map((job) => settle(job, running));
}

// POST /api/cad/jobs - {prompt, model?, parent_id?, images?}: Claude designs a model (or changes parent_id's) in the background
export const createCadJob = handler(async ({ request }) => {
  const w = worker();
  if (!w) return disabled();
  const body = jobSchema.safeParse(await readJsonBody(request));
  if (!body.success) return invalidPayload(body.error);
  const model = body.data.model ?? env.CAD_AI_MODEL;
  if (!CAD_MODELS.some((m) => m.id === model)) {
    return json({ success: false, error: 'UNSUPPORTED_MODEL', message: `Model không hỗ trợ: ${model}.` }, 400);
  }

  let files: { request: string; code?: string; attachments: Attachment[] };
  if (body.data.parent_id) {
    const parent = await store().get(body.data.parent_id);
    const parentCode = await store().filePath(body.data.parent_id, 'model.py');
    if (!parent || !parentCode) return jobNotFound();
    const pasted = pastedImages(body.data.images, await store().attachments(parent.id));
    if (pasted instanceof Response) return pasted;
    files = {
      request: buildRequest(body.data.prompt, { request: await store().request(parent.id), prompt: parent.prompt }, pasted.names),
      code: await fs.readFile(parentCode, 'utf8'),
      attachments: pasted.attachments,
    };
  } else {
    const pasted = pastedImages(body.data.images, []);
    if (pasted instanceof Response) return pasted;
    files = { request: buildRequest(body.data.prompt, undefined, pasted.names), attachments: pasted.attachments };
  }

  const meta = await store().create(
    { prompt: body.data.prompt, source: 'claude', model, parent_id: body.data.parent_id ?? null, title: null },
    files
  );
  try {
    await w.generate(meta.id, model);
  } catch (err) {
    if (err instanceof CadWorkerError) return workerFailed(err);
    throw err;
  }
  return json({ success: true, job: await store().get(meta.id) }, 202);
});

// POST /api/cad/builds - {code, title?, prompt?, parent_id?}: builds ready-made build123d code (Antigravity, the API)
export const buildCadCode = handler(async ({ request }) => {
  const w = worker();
  if (!w) return disabled();
  const body = buildSchema.safeParse(await readJsonBody(request));
  if (!body.success) return invalidPayload(body.error);
  if (body.data.parent_id && !(await store().get(body.data.parent_id))) return jobNotFound();

  const meta = await store().create(
    {
      prompt: body.data.prompt || body.data.title || 'Code build123d gửi trực tiếp',
      source: 'code',
      model: null,
      parent_id: body.data.parent_id ?? null,
      title: body.data.title || null,
    },
    { code: body.data.code }
  );
  try {
    await w.build(meta.id);
  } catch (err) {
    if (err instanceof CadWorkerError) return workerFailed(err);
    throw err;
  }
  return json({ success: true, job: await store().get(meta.id) }, 201);
});

// GET /api/cad/jobs/:id - One model: progress, Claude's summary, the build report and which files exist
export const getCadJob = handler<{ id: string }>(async ({ params }) => {
  const job = await store().get(params.id);
  if (!job) return jobNotFound();
  return json({ success: true, job: await withMixes(settle(job, await runningJobs([job]))) });
});

// POST /api/cad/jobs/:id/cancel - Stops Claude working on a model
export const cancelCadJob = handler<{ id: string }>(async ({ params }) => {
  const job = await store().get(params.id);
  if (!job) return jobNotFound();
  const w = job.source === 'mesh' ? meshWorker() : worker();
  if (!w) return job.source === 'mesh' ? meshDisabled() : disabled();
  try {
    await w.cancel(params.id);
  } catch (err) {
    if (err instanceof CadWorkerError) return workerFailed(err);
    throw err;
  }
  return json({ success: true, job: await store().get(params.id) });
});

// POST /api/cad/jobs/:id/retry - Runs a failed (or cancelled) model again in place, as it was asked: Claude from the
// same request.md, ready-made code built again, a figure from the same picture and settings, a fix of the same figure
export const retryCadJob = handler<{ id: string }>(async ({ params }) => {
  const job = await store().get(params.id);
  if (!job) return jobNotFound();
  if (job.state === 'running' || job.state === 'queued') {
    return json({ success: false, error: 'JOB_RUNNING', message: 'Bản này đang chạy.' }, 409);
  }
  const model = job.model ?? env.CAD_AI_MODEL;
  try {
    if (job.source !== 'mesh') {
      const w = worker();
      if (!w) return disabled();
      if (job.source === 'code') await w.build(job.id);
      else await w.generate(job.id, model);
    } else {
      const m = meshWorker();
      if (!m) return meshDisabled();
      if (job.input === 'fix' && job.parent_id) await m.fix(job.id, job.parent_id, model);
      else {
        const asked = await store().meshParams(job.id);
        if (!asked) {
          return json(
            { success: false, error: 'NO_PARAMS', message: 'Bản này tạo trước khi lưu thông số nên không chạy lại tại chỗ được: dùng “Làm lại” để tạo bản mới.' },
            409
          );
        }
        await m.generate(job.id, asked);
      }
    }
  } catch (err) {
    if (err instanceof CadWorkerError) return workerFailed(err);
    throw err;
  }
  return json({ success: true, job: await store().get(job.id) }, 202);
});

// DELETE /api/cad/jobs/:id?family=1 - Deletes a model (with family=1 also every fix, revision and remake made from
// it); refused while one of them is being made
export const deleteCadJob = handler<{ id: string }>(async ({ request, params }) => {
  const job = await store().get(params.id);
  if (!job) return jobNotFound();
  const family = ['1', 'true'].includes(new URL(request.url).searchParams.get('family') ?? '');
  const all = family ? await store().list(Number.MAX_SAFE_INTEGER) : [job];
  const ids = new Set(family ? lineageOf(job.id, all) : [job.id]);
  const busy = all.filter((j) => ids.has(j.id) && (j.state === 'running' || j.state === 'queued'));
  const running = await runningJobs(busy);
  if (busy.some((j) => settle(j, running).state === 'running' || j.state === 'queued')) {
    return json({ success: false, error: 'JOB_BUSY', message: 'Có bản đang được dựng hoặc sửa: hủy hoặc chờ xong rồi xóa.' }, 409);
  }
  return json({ success: true, deleted: await store().remove(job.id, family) });
});

const meshSchema = z.object({
  prompt: z.string().trim().default(''),
  height_mm: z.coerce.number().min(10, 'Chiều cao tối thiểu 10 mm.').max(300, 'Chiều cao tối đa 300 mm.').default(80),
  base: z.preprocess((v) => v === true || v === 'true' || v === '1' || v === 'on', z.boolean()).default(false),
  // The Claude model that makes or finishes it (CAD_MODELS); default CAD_AI_MODEL
  model: z.string().optional(),
  // Hunyuan3D-2's seed, for a figure from a picture; random when not given
  seed: z.coerce.number().int().min(0).optional(),
  // "Make again": the parent's picture (with a new seed) or description, afresh
  parent_id: z.string().optional(),
  // Colour: Claude paints the figure in up to `colours` filaments (from those offered; from a picture, in the
  // picture's colours), or in the ones loaded in the AMS
  colour: z.preprocess((v) => v === true || v === 'true' || v === '1' || v === 'on', z.boolean()).default(false),
  colours: z.coerce.number().int().min(2, 'Tối thiểu 2 màu.').max(8, 'Tối đa 8 màu.').default(4),
  // prefer: what is loaded in the AMS first, then the user's own filaments, then Bambu's colours to buy
  palette: z.enum(['auto', 'prefer', 'ams', 'bambu', 'custom']).default('auto'),
  // For palette=bambu (default "PLA Basic") and prefer (default: the family most of the AMS holds): the Bambu
  // material whose colours to use, e.g. "PLA Basic", or a whole family, "family:PLA"
  material: z.string().trim().max(60).default(''),
  // For palette=custom: the saved filaments to choose from (comma-separated ids; all when empty)
  filaments: z.string().trim().max(2000).default(''),
  // "Dựng nhiều góc": Hunyuan3D-2mv from four sides, MV-Adapter drawing those not uploaded (image_left, image_back,
  // image_right, which are used whenever they come)
  multiview: z.preprocess((v) => v === true || v === 'true' || v === '1' || v === 'on', z.boolean()).default(false),
});

/**
 * The filaments loaded in the AMS, in the order Studio lists them after syncing (unit by unit, slot by slot,
 * empty slots left out): a coloured figure painted with these needs no filament changes in Studio
 */
export function amsPalette(
  state: PrinterState,
  catalogue: BambuColourCatalogue | null = null
): { hex: string; label: string; material: string | null }[] {
  return (state.ams ?? []).flatMap((unit, u) =>
    (unit.trays ?? [])
      .filter((tray) => !tray.isEmpty && tray.color)
      .map((tray) => {
        const hex = tray.color!.startsWith('#') ? tray.color!.slice(0, 7) : `#${tray.color!.slice(0, 6)}`;
        const official = catalogue?.identify(tray.infoIdx, hex);
        const name = `${tray.subBrand || tray.type || 'filament'}${official ? ` ${official.name} (${official.code})` : ''}`;
        return { hex, label: `AMS ${u + 1} khay ${Number(tray.id) + 1}: ${name}`, material: tray.type || null };
      })
  );
}

/**
 * A Bambu material's own colours, as the figure's colours snap to them: "PLA Basic Orange (10300)". "family:PLA"
 * takes every PLA material's (they print together), for more colours to choose from.
 */
export function bambuSnap(catalogue: BambuColourCatalogue, material: string): { hex: string; label: string }[] {
  const colours = material.startsWith('family:') ? catalogue.ofFamily(material.slice(7)) : catalogue.ofMaterial(material);
  return colours.map((c) => ({ hex: c.hex[0], label: `${c.material} ${c.name} (${c.code})` }));
}

/**
 * "Ưu tiên màu có sẵn": the AMS's loaded filaments first, then the user's own, then Bambu's colours of one
 * material or family (by default the family most of the AMS holds, else PLA) as the ones to buy. The worker takes
 * a lower tier whenever it is close enough; with none of them at all, plain colours from the texture.
 */
async function preferredColours(state: PrinterState, count: number, material: string, filamentIds: string): Promise<MeshColour> {
  const catalogue = await colourCatalogue();
  const loaded = amsPalette(state, catalogue).map((p) => ({ hex: p.hex, label: p.label, tier: 1, origin: 'ams' as const }));
  const wanted = new Set(filamentIds.split(',').map((s) => s.trim()).filter(Boolean));
  const owned = (await customFilaments().list())
    .filter((f) => wanted.size === 0 || wanted.has(f.id))
    .map((f) => ({ hex: f.hex, label: customLabel(f), tier: 2, origin: 'custom' as const }));
  let buy: { hex: string; label: string; tier: number; origin: 'bambu' }[] = [];
  if (catalogue) {
    const families = (state.ams ?? []).flatMap((u) => (u.trays ?? []).filter((t) => !t.isEmpty && t.type).map((t) => familyOf(t.type!)));
    const counts = new Map<string, number>();
    for (const f of families) if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
    const mostLoaded = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    buy = bambuSnap(catalogue, material || `family:${mostLoaded ?? 'PLA'}`).map((c) => ({ ...c, tier: 3, origin: 'bambu' as const }));
  }
  const snap = [...loaded, ...owned, ...buy];
  return snap.length >= 2 ? { count, snap } : { count };
}

/** A palette colour this far from the texture's own (Lab ΔE) gets a mixing recipe suggested */
const MIX_SUGGEST_DELTA_E = 6;

/**
 * A coloured figure's palette with, for each colour the chosen filaments miss by more than MIX_SUGGEST_DELTA_E,
 * the Bambu Studio mixing recipe closest to the texture's own colour (its PLA Basic primaries named)
 */
async function withMixes(job: CadJob): Promise<CadJob> {
  const palette = job.report?.palette;
  if (!palette?.some((p) => p.source_hex && (p.delta_e ?? 0) > MIX_SUGGEST_DELTA_E)) return job;
  const [recipes, catalogue] = await Promise.all([recipeBook(), colourCatalogue()]);
  if (!recipes) return job;
  return {
    ...job,
    report: {
      ...job.report!,
      palette: palette.map((p) => {
        if (!p.source_hex || (p.delta_e ?? 0) <= MIX_SUGGEST_DELTA_E) return p;
        const best = suggestMix(recipes, p.source_hex);
        if (!best || best.deltaE >= (p.delta_e ?? Infinity)) return { ...p, mix: null };
        return {
          ...p,
          mix: {
            components: best.recipe.components.map((c) => {
              const official = catalogue?.identify('GFA00', c.hex);
              return { ...c, name: official ? `PLA Basic ${official.name} (${official.code})` : null };
            }),
            hex: best.recipe.hex,
            delta_e: best.deltaE,
          },
        };
      }),
    },
  };
}

const imageType = (data: Uint8Array) => IMAGE_SIGNATURES.findIndex((sig) => sig.every((byte, i) => data[i] === byte));
const isImage = (data: Uint8Array) => imageType(data) >= 0;

/**
 * The pictures pasted into a revision, numbered after the ones its parent already had (`inherited`, kept with it,
 * since the parent's brief names them): every attachment for the new job and the names of the new ones; or the
 * error response for a picture that is too big or not a PNG, JPEG or WebP
 */
function pastedImages(images: string[], inherited: Attachment[]): { attachments: Attachment[]; names: string[] } | Response {
  const added: Attachment[] = [];
  for (const image of images) {
    const data = new Uint8Array(Buffer.from(image.replace(/^data:[^,]*,/, ''), 'base64'));
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      return json({ success: false, error: 'FILE_TOO_LARGE', message: `Ảnh dán vào vượt quá ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.` }, 413);
    }
    const type = imageType(data);
    if (type < 0) return json({ success: false, error: 'UNSUPPORTED_FILE_TYPE', message: 'Chỉ dán được ảnh PNG, JPEG hoặc WebP.' }, 415);
    added.push({ name: `${inherited.length + added.length + 1}.${IMAGE_EXTENSIONS[type]}`, data });
  }
  return { attachments: [...inherited, ...added], names: added.map((a) => a.name) };
}

/**
 * POST /api/cad/meshes - A figure (character, statue, decoration) from a picture and/or a description: multipart
 * with "image" (PNG/JPEG/WebP), optionally its other sides "image_left", "image_back", "image_right", and the
 * fields prompt, height_mm, base, model, seed, parent_id, multiview and the colour fields (or JSON without a
 * picture). From a picture Hunyuan3D-2 shapes it on the GPU and Claude finishes it in Blender; from a description
 * Claude makes it in Blender. In the background; 202 with the job.
 */
export const createMeshJob = handler(async ({ request, printerService }) => {
  const m = meshWorker();
  if (!m) return meshDisabled();
  if (Number(request.headers.get('content-length') ?? 0) > (FIGURE_SIDES.length + 1) * MAX_IMAGE_BYTES + 64 * 1024) {
    return json({ success: false, error: 'FILE_TOO_LARGE', message: 'Ảnh vượt quá 15 MB.' }, 413);
  }

  let fields: Record<string, unknown>;
  let image: Uint8Array | undefined;
  let views: SideViews = {};
  if ((request.headers.get('content-type') ?? '').includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json({ success: false, error: 'INVALID_PAYLOAD', message: 'Expected multipart/form-data.' }, 400);
    }
    fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'));
    for (const name of ['image', ...FIGURE_SIDES.map((side) => `image_${side}`)]) {
      const file = form.get(name);
      if (!(file instanceof File) || file.size === 0) continue;
      const data = new Uint8Array(await file.arrayBuffer());
      if (data.byteLength > MAX_IMAGE_BYTES) return json({ success: false, error: 'FILE_TOO_LARGE', message: 'Ảnh vượt quá 15 MB.' }, 413);
      if (!isImage(data)) {
        return json({ success: false, error: 'UNSUPPORTED_FILE_TYPE', message: 'Chỉ nhận ảnh PNG, JPEG hoặc WebP.' }, 415);
      }
      if (name === 'image') image = data;
      else views = { ...views, [name.slice('image_'.length)]: data };
    }
    if (Object.keys(views).length && !image && !fields.parent_id) {
      return json({ success: false, error: 'NO_FRONT_IMAGE', message: 'Ảnh các góc khác cần đi kèm ảnh mặt trước.' }, 400);
    }
  } else {
    fields = ((await readJsonBody(request)) ?? {}) as Record<string, unknown>;
  }
  const body = meshSchema.safeParse(fields);
  if (!body.success) return invalidPayload(body.error);
  const model = body.data.model ?? env.CAD_AI_MODEL;
  if (!CAD_MODELS.some((c) => c.id === model)) {
    return json({ success: false, error: 'UNSUPPORTED_MODEL', message: `Model không hỗ trợ: ${model}.` }, 400);
  }
  let prompt = body.data.prompt;

  if (body.data.parent_id) {
    let parent = await store().get(body.data.parent_id);
    // Made again from a fix: from the figure the fixes started from, whose picture and description it has
    while (parent?.input === 'fix' && parent.parent_id) parent = await store().get(parent.parent_id);
    if (!parent || parent.source !== 'mesh') return jobNotFound();
    // The parent's other sides go with its picture, not with a new one
    if (!image && !Object.keys(views).length) views = await store().views(parent.id);
    image ??= (await store().inputImage(parent.id)) ?? undefined;
    if (!prompt) prompt = parent.prompt;
  }
  if (!image && prompt.length < 3) {
    return json({ success: false, error: 'NO_INPUT', message: 'Cần ảnh hoặc mô tả mô hình (ít nhất 3 ký tự).' }, 400);
  }
  let colour: MeshColour | null = null;
  if (body.data.colour) {
    if (body.data.palette === 'prefer') {
      colour = await preferredColours(printerService.stateStore.getState(), body.data.colours, body.data.material, body.data.filaments);
    } else if (body.data.palette === 'custom') {
      const wanted = new Set(body.data.filaments.split(',').map((s) => s.trim()).filter(Boolean));
      const saved = (await customFilaments().list()).filter((f) => wanted.size === 0 || wanted.has(f.id));
      if (saved.length < 2) {
        return json({ success: false, error: 'TOO_FEW_FILAMENTS', message: 'Chọn ít nhất 2 filament trong "Filament của tôi".' }, 409);
      }
      colour = { count: body.data.colours, snap: saved.map((f) => ({ hex: f.hex, label: customLabel(f) })) };
    } else if (body.data.palette === 'bambu') {
      const catalogue = await colourCatalogue();
      if (!catalogue) {
        return json({ success: false, error: 'CATALOGUE_UNAVAILABLE', message: 'Chưa tải được bảng màu Bambu (cần mạng ở lần đầu).' }, 503);
      }
      const snap = bambuSnap(catalogue, body.data.material || 'PLA Basic');
      if (snap.length < 2) {
        return json({ success: false, error: 'UNKNOWN_MATERIAL', message: `Bambu không có đủ màu cho loại nhựa "${body.data.material}".` }, 400);
      }
      colour = { count: body.data.colours, snap };
    } else if (body.data.palette === 'ams') {
      const palette = amsPalette(printerService.stateStore.getState(), await colourCatalogue());
      if (palette.length < 2) {
        return json({ success: false, error: 'AMS_TOO_FEW_COLOURS', message: 'AMS cần ít nhất 2 khay có filament để tô màu theo AMS.' }, 409);
      }
      colour = { palette };
    } else {
      colour = { count: body.data.colours };
    }
    const { palette, colours, material, filaments } = body.data;
    colour.request = { palette, colours, material, filaments };
  }

  const params: MeshParams = {
    prompt,
    height_mm: body.data.height_mm,
    base: body.data.base,
    colour,
    model,
    seed: body.data.seed ?? randomInt(1, 2 ** 31 - 1),
    multiview: Boolean(image) && body.data.multiview,
  };
  const meta = await store().create(
    { prompt: prompt || 'Mô hình từ ảnh', source: 'mesh', model, parent_id: body.data.parent_id ?? null, title: null },
    image ? { image, views, mesh: params } : { mesh: params }
  );
  try {
    await m.generate(meta.id, params);
  } catch (err) {
    if (err instanceof CadWorkerError) return workerFailed(err);
    throw err;
  }
  return json({ success: true, job: await store().get(meta.id) }, 202);
});

const fixSchema = z.object({
  // What to fix; empty: Claude looks for problems itself
  prompt: z.string().trim().default(''),
  model: z.string().optional(),
  // Pictures pasted with it (data: URLs or base64): what is wrong, or how it should look
  images: imagesField,
});

/**
 * POST /api/cad/jobs/:id/fix - {prompt?, model?, images?}: Claude reviews a finished figure against its picture and fixes it
 * (feet, loose bits, rough surfaces, holes, or what the prompt asks) in the mesh container. A new job, so the
 * figure stays as it was; 202 with the job.
 */
export const fixMeshJob = handler<{ id: string }>(async ({ request, params }) => {
  const m = meshWorker();
  if (!m) return meshDisabled();
  const body = fixSchema.safeParse((await readJsonBody(request)) ?? {});
  if (!body.success) return invalidPayload(body.error);
  const model = body.data.model ?? env.CAD_AI_MODEL;
  if (!CAD_MODELS.some((c) => c.id === model)) {
    return json({ success: false, error: 'UNSUPPORTED_MODEL', message: `Model không hỗ trợ: ${model}.` }, 400);
  }
  const parent = await store().get(params.id);
  if (!parent || parent.source !== 'mesh') return jobNotFound();
  if (parent.state !== 'done' || !parent.files.stl) {
    return json({ success: false, error: 'MODEL_NOT_READY', message: 'Mô hình chưa dựng xong nên chưa sửa được.' }, 409);
  }

  const pasted = pastedImages(body.data.images, await store().attachments(parent.id));
  if (pasted instanceof Response) return pasted;

  const meta = await store().create(
    {
      prompt: body.data.prompt || (pasted.names.length ? 'Sửa theo ảnh gửi kèm' : 'Claude tự xem và sửa lỗi'),
      source: 'mesh',
      model,
      parent_id: parent.id,
      title: parent.title,
    },
    {
      request: buildFixRequest(body.data.prompt, { ...parent, request: await store().request(parent.id) }, pasted.names),
      attachments: pasted.attachments,
    }
  );
  try {
    await m.fix(meta.id, parent.id, model);
  } catch (err) {
    if (err instanceof CadWorkerError) return workerFailed(err);
    throw err;
  }
  return json({ success: true, job: await store().get(meta.id) }, 202);
});

/** "Giá đỡ điện thoại 60°" → "Gia-do-dien-thoai-60" for file names */
function fileStem(job: CadJob): string {
  const words = (job.title || job.prompt)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return safeFileName(words) || `cad-${job.id}`;
}

// POST /api/cad/jobs/:id/studio - {format?: "stl" | "step"}: puts the model into Studio's /imports folder
export const sendCadToStudio = handler<{ id: string }>(async ({ request, params }) => {
  if (!env.STUDIO_IMPORT_DIR) {
    return json({ success: false, error: 'STUDIO_IMPORTS_DISABLED', message: 'Chưa cấu hình STUDIO_IMPORT_DIR.' }, 501);
  }
  const body = z.object({ format: z.enum(['stl', 'step', '3mf']).default('stl') }).safeParse((await readJsonBody(request)) ?? {});
  if (!body.success) return invalidPayload(body.error);
  const job = await store().get(params.id);
  if (!job) return jobNotFound();
  if (body.data.format === 'step' && job.state === 'done' && !job.files.step) {
    return json({ success: false, error: 'NO_STEP', message: 'Mô hình này chỉ có STL (dựng từ ảnh nên không có STEP).' }, 409);
  }
  if (body.data.format === '3mf' && job.state === 'done' && !job.files.threemf) {
    return json({ success: false, error: 'NO_3MF', message: 'Mô hình này không tô màu và không chia bàn in nên không có 3MF.' }, 409);
  }
  const formatFile = { stl: 'model.stl', step: 'model.step', '3mf': 'model.3mf' } as const;
  const file = await store().filePath(job.id, formatFile[body.data.format]);
  if (!file || job.state !== 'done') {
    return json({ success: false, error: 'MODEL_NOT_READY', message: 'Mô hình chưa dựng xong nên chưa gửi được.' }, 409);
  }

  // Several plates: one file each, since Studio drops the plates of a 3MF it did not write and centres it all on one
  const plates = body.data.format === '3mf' ? (job.report?.print_layout?.plates.length ?? 0) : 0;
  if (plates > 1) {
    const names: string[] = [];
    for (let n = 1; n <= plates; n++) {
      const plateFile = await store().plateFile(job.id, n);
      if (!plateFile) return json({ success: false, error: 'MODEL_NOT_READY', message: `Thiếu file của bàn ${n}: dựng lại mô hình.` }, 409);
      const saved = await saveStudioImport(path.resolve(env.STUDIO_IMPORT_DIR), `${fileStem(job)}-ban-${n}.3mf`, await fs.readFile(plateFile));
      await store().markSent(job.id, saved.name);
      names.push(saved.name);
    }
    return json({ success: true, name: names[0], names, studioPath: `/imports/${names[0]}`, studioPaths: names.map((n) => `/imports/${n}`) }, 201);
  }
  const saved = await saveStudioImport(path.resolve(env.STUDIO_IMPORT_DIR), `${fileStem(job)}.${body.data.format}`, await fs.readFile(file));
  await store().markSent(job.id, saved.name);
  return json({ success: true, name: saved.name, studioPath: `/imports/${saved.name}`, ...(saved.repair && { repair: saved.repair }) }, 201);
});

// GET /api/cad/jobs/:id/files/:name?download=1 - model.py, model.stl, model.step, model.3mf, preview.png, concept.png,
// report.json, or a fixed figure's fix.py and views.png
export const getCadFile = handler<{ id: string; name: string }>(async ({ request, params }) => {
  if (!(params.name in CAD_FILES)) return json({ success: false, error: 'FILE_NOT_FOUND', message: 'Không có file này.' }, 404);
  const name = params.name as CadFileName;
  const file = await store().filePath(params.id, name);
  const job = file && (await store().get(params.id));
  if (!file || !job) return json({ success: false, error: 'FILE_NOT_FOUND', message: 'Không có file này.' }, 404);

  // The assembly guide's video plays in the card, which seeks with Range requests
  if (name === 'assembly.mp4' && !new URL(request.url).searchParams.has('download')) {
    return serveFile(request, file, CAD_FILES[name].type, 'no-cache');
  }
  const headers: Record<string, string> = { 'Content-Type': CAD_FILES[name].type, 'Cache-Control': 'no-cache' };
  if (new URL(request.url).searchParams.has('download')) {
    const ext = path.extname(name);
    headers['Content-Disposition'] = `attachment; filename="${fileStem(job)}${ext}"`;
  }
  return new Response(new Uint8Array(await fs.readFile(file)), { headers });
});

// GET /api/cad/jobs/:id/guide/:picture - A picture of the assembly guide: step-01.png… (each step), done.png
export const getCadGuidePicture = handler<{ id: string; picture: string }>(async ({ params }) => {
  const file = await store().guidePicture(params.id, params.picture);
  if (!file) return json({ success: false, error: 'FILE_NOT_FOUND', message: 'Không có ảnh này.' }, 404);
  return new Response(new Uint8Array(await fs.readFile(file)), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' } });
});

// POST /api/cad/jobs/:id/guide - Draws the assembly guide (steps and video) of a built model with `components` again,
// for one built before guides were drawn; ~1 minute for twenty parts. It goes on when the page closes: 202 while it
// runs, and the job's `guide_task` says how far it is
export const remakeCadGuide = handler<{ id: string }>(async ({ params }) => {
  const job = await store().get(params.id);
  if (!job) return jobNotFound();
  if (job.source === 'mesh' || !job.files.assembly) {
    return json({ success: false, error: 'NO_ASSEMBLY', message: 'Mô hình không khai báo components nên không có hướng dẫn lắp.' }, 409);
  }
  const w = worker();
  if (!w) return disabled();
  const { outcome } = await startTask(guideTaskKey(params.id), () => w.guide(params.id), {
    info: { kind: 'cad-guide', label: job.title || job.prompt.slice(0, 80), page: 'cad' },
    waitMs: GUIDE_WAIT_MS,
    failed: (guide) => (guide.ok ? null : guide.error ?? 'Không vẽ được hướng dẫn lắp.'),
    // A guide drawn without its video still counts, the reason why is kept
    explain: (guide) => (guide.ok && guide.error ? [`Không có video: ${guide.error}`] : []),
  });
  if (outcome && 'value' in outcome) {
    const guide = outcome.value;
    return json({ success: guide.ok, guide, job: await store().get(params.id) }, guide.ok ? 200 : 500);
  }
  if (outcome) {
    if (outcome.error instanceof CadWorkerError) return workerFailed(outcome.error);
    throw outcome.error;
  }
  return json({ success: true, running: true, job: await store().get(params.id) }, 202);
});

// GET /api/cad/jobs/:id/plates/:n - Plate n's own 3MF of an assembly laid out on several plates (downloaded as
// <name>-ban-<n>.3mf)
export const getCadPlate = handler<{ id: string; n: string }>(async ({ params }) => {
  const n = Number(params.n);
  const file = await store().plateFile(params.id, n);
  const job = file && (await store().get(params.id));
  if (!file || !job) return json({ success: false, error: 'FILE_NOT_FOUND', message: 'Không có bàn in này.' }, 404);
  return new Response(new Uint8Array(await fs.readFile(file)), {
    headers: { 'Content-Type': 'model/3mf', 'Cache-Control': 'no-cache', 'Content-Disposition': `attachment; filename="${fileStem(job)}-ban-${n}.3mf"` },
  });
});
