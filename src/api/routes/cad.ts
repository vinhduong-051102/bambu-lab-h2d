import { promises as fs } from 'fs';
import path from 'path';
import { z } from 'zod';
import { env } from '../../config/env';
import {
  buildRequest,
  CAD_FILES,
  CadJobStore,
  CadWorkerClient,
  CadWorkerError,
  type CadFileName,
  type CadJob,
  type CadWorkerApi,
} from '../../domain/cad/cadJobs';
import { saveStudioImport, safeFileName } from '../../domain/studio/studioImports';
import { handler, json, readJsonBody } from '../http';

/** Models the dashboard offers for writing a model; the first is used when a request names none */
const CAD_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (chính xác nhất)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (nhanh, tốn ít lượt hơn)' },
];

const MAX_PROMPT_CHARS = 4000;
const MAX_CODE_BYTES = 200 * 1024;
const MAX_JOB_LIST = 100;

let workerOverride: CadWorkerApi | null = null;
let storeOverride: CadJobStore | null = null;

/** Tests replace the CAD container with a fake; null restores CAD_WORKER_URL */
export function setCadWorker(worker: CadWorkerApi | null): void {
  workerOverride = worker;
}

/** Tests keep jobs in a temporary folder; null restores CAD_JOBS_DIR */
export function setCadJobStore(store: CadJobStore | null): void {
  storeOverride = store;
}

const worker = (): CadWorkerApi | null => workerOverride ?? (env.CAD_WORKER_URL ? new CadWorkerClient(env.CAD_WORKER_URL) : null);
const store = () => storeOverride ?? new CadJobStore(path.resolve(env.CAD_JOBS_DIR));

const disabled = () =>
  json({ success: false, error: 'CAD_DISABLED', message: 'Chưa cấu hình CAD_WORKER_URL (docker-compose.cad.yml, docs/cad.md).' }, 501);
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
  const w = worker();
  if (!w || !jobs.some((job) => job.state === 'running')) return null;
  return w.health().then((health) => health.running, () => null);
}

const jobSchema = z.object({
  prompt: z.string().trim().min(3, 'Mô tả quá ngắn.').max(MAX_PROMPT_CHARS, `Mô tả dài quá ${MAX_PROMPT_CHARS} ký tự.`),
  model: z.string().optional(),
  // A revision: the prompt says what to change in that job's model
  parent_id: z.string().optional(),
});

const buildSchema = z.object({
  code: z.string().min(1, 'Thiếu code.').refine((code) => Buffer.byteLength(code) <= MAX_CODE_BYTES, 'Code dài quá 200 KB.'),
  title: z.string().trim().max(120).optional(),
  prompt: z.string().trim().max(MAX_PROMPT_CHARS).optional(),
  parent_id: z.string().optional(),
});

// GET /api/cad - Whether AI modelling is set up, whether its container answers, and the models it offers
export const getCad = handler(async () => {
  const w = worker();
  if (!w) return json({ enabled: false });
  const health = await w.health().then(
    (h) => ({ online: true, claude: h.claude, error: null }),
    (err) => ({ online: false, claude: false, error: err instanceof Error ? err.message : String(err) })
  );
  return json({
    enabled: true,
    worker: health,
    models: CAD_MODELS,
    default_model: CAD_MODELS.some((m) => m.id === env.CAD_AI_MODEL) ? env.CAD_AI_MODEL : CAD_MODELS[0].id,
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
  return json({ success: true, jobs: jobs.map((job) => settle(job, running)) });
});

// POST /api/cad/jobs - {prompt, model?, parent_id?}: Claude designs a model (or changes parent_id's) in the background
export const createCadJob = handler(async ({ request }) => {
  const w = worker();
  if (!w) return disabled();
  const body = jobSchema.safeParse(await readJsonBody(request));
  if (!body.success) return invalidPayload(body.error);
  const model = body.data.model ?? env.CAD_AI_MODEL;
  if (!CAD_MODELS.some((m) => m.id === model)) {
    return json({ success: false, error: 'UNSUPPORTED_MODEL', message: `Model không hỗ trợ: ${model}.` }, 400);
  }

  let files: { request: string; code?: string };
  if (body.data.parent_id) {
    const parent = await store().get(body.data.parent_id);
    const parentCode = await store().filePath(body.data.parent_id, 'model.py');
    if (!parent || !parentCode) return jobNotFound();
    files = {
      request: buildRequest(body.data.prompt, { request: await store().request(parent.id), prompt: parent.prompt }),
      code: await fs.readFile(parentCode, 'utf8'),
    };
  } else {
    files = { request: buildRequest(body.data.prompt) };
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
  return json({ success: true, job: settle(job, await runningJobs([job])) });
});

// POST /api/cad/jobs/:id/cancel - Stops Claude working on a model
export const cancelCadJob = handler<{ id: string }>(async ({ params }) => {
  const w = worker();
  if (!w) return disabled();
  if (!(await store().get(params.id))) return jobNotFound();
  try {
    await w.cancel(params.id);
  } catch (err) {
    if (err instanceof CadWorkerError) return workerFailed(err);
    throw err;
  }
  return json({ success: true, job: await store().get(params.id) });
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
  const body = z.object({ format: z.enum(['stl', 'step']).default('stl') }).safeParse((await readJsonBody(request)) ?? {});
  if (!body.success) return invalidPayload(body.error);
  const job = await store().get(params.id);
  if (!job) return jobNotFound();
  const file = await store().filePath(job.id, body.data.format === 'step' ? 'model.step' : 'model.stl');
  if (!file || job.state !== 'done') {
    return json({ success: false, error: 'MODEL_NOT_READY', message: 'Mô hình chưa dựng xong nên chưa gửi được.' }, 409);
  }

  const saved = await saveStudioImport(path.resolve(env.STUDIO_IMPORT_DIR), `${fileStem(job)}.${body.data.format}`, await fs.readFile(file));
  await store().markSent(job.id, saved.name);
  return json({ success: true, name: saved.name, studioPath: `/imports/${saved.name}`, ...(saved.repair && { repair: saved.repair }) }, 201);
});

// GET /api/cad/jobs/:id/files/:name?download=1 - model.py, model.stl, model.step, preview.png or report.json
export const getCadFile = handler<{ id: string; name: string }>(async ({ request, params }) => {
  if (!(params.name in CAD_FILES)) return json({ success: false, error: 'FILE_NOT_FOUND', message: 'Không có file này.' }, 404);
  const name = params.name as CadFileName;
  const file = await store().filePath(params.id, name);
  const job = file && (await store().get(params.id));
  if (!file || !job) return json({ success: false, error: 'FILE_NOT_FOUND', message: 'Không có file này.' }, 404);

  const headers: Record<string, string> = { 'Content-Type': CAD_FILES[name].type, 'Cache-Control': 'no-cache' };
  if (new URL(request.url).searchParams.has('download')) {
    const ext = path.extname(name);
    headers['Content-Disposition'] = `attachment; filename="${fileStem(job)}${ext}"`;
  }
  return new Response(new Uint8Array(await fs.readFile(file)), { headers });
});
