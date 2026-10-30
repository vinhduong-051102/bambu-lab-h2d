import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { getTask, type TaskState } from '../backgroundTasks';

/**
 * Models designed by AI (docs/cad.md). Each job is a folder in CAD_JOBS_DIR, shared with the CAD and mesh
 * containers: the gateway writes job.json (who asked for what), request.md (Claude's brief for a technical
 * model, or for Claude's review of a figure), input.png (a picture for a figure) and views/<side>.png (its other
 * sides, for "Dựng nhiều góc"), or attachments/ (pictures the user pasted into a revision, for Claude to look at);
 * the workers write model.py (build123d code), concept.png (the figure's picture, background removed), sides.png
 * (the sides a figure was shaped from), fix.py (Claude's changes to a figure),
 * out/ (model.stl, model.step, preview.png, report.json) and status.json.
 */

export type CadJobSource = 'claude' | 'code' | 'mesh';
export type CadJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface CadJobMeta {
  id: string;
  /** What the user asked for (for a revision: what to change) */
  prompt: string;
  /**
   * claude: written by Claude in the CAD container; code: model.py sent ready-made (Antigravity, the API);
   * mesh: a figure Claude modelled in Blender from a picture and/or a description, or Claude's fix of one (model
   * is the Claude model, parent_id the figure fixed or made again); figures from before were Hunyuan3D-2's
   */
  source: CadJobSource;
  model: string | null;
  /** The job this one revises */
  parent_id: string | null;
  title: string | null;
  created_at: string;
  /** Files put into Studio's import folder from this job */
  sent: { name: string; at: string }[];
}

export interface CadBuildReport {
  ok: boolean;
  error?: string;
  traceback?: string;
  size_mm?: number[];
  volume_cm3?: number;
  solids?: number;
  mesh?: { triangles: number; watertight: boolean; open_edges: number; non_manifold_edges: number };
  warnings?: string[];
  seconds?: number;
  /** An assembly laid out for printing (cad/print_layout.py): its plates, and with several, one 3MF each */
  print_layout?: { plates: { n: number; parts: string[] }[]; plate_files?: string[] };
  /**
   * A coloured figure's filaments: slot n is paint state n in model.3mf. source_hex is the texture's own colour
   * for that slot and delta_e how far the filament is from it; mix, added by the gateway when it is far, is the
   * Bambu Studio mixing recipe that comes closest
   */
  palette?: {
    slot: number;
    hex: string;
    label: string | null;
    share: number;
    source_hex?: string;
    delta_e?: number;
    mix?: PaletteMix | null;
    /** ams: loaded in the AMS; custom: one of the user's filaments; bambu: a Bambu colour to buy or load */
    origin?: 'ams' | 'custom' | 'bambu' | null;
  }[] | null;
  /** How the colours were asked for (palette mode, count, material, filaments) */
  colour_request?: { palette: string; colours: number; material: string; filaments: string } | null;
}

/** A Bambu Studio mixing recipe for a colour no chosen filament has */
export interface PaletteMix {
  components: { key: string; hex: string; percent: number; name: string | null }[];
  hex: string;
  delta_e: number;
}

export interface CadResult {
  title: string;
  summary: string;
  assumptions: string[];
  parameters: { name: string; value: number; description: string }[];
  warnings: string[];
  /** Claude's review of a figure: every problem it found, worst first, and whether it fixed it */
  issues?: { problem: string; fixed: boolean; how: string }[];
}

/** One step a worker went through, with its times; detail says what it did (a build's outcome, MB downloaded) */
export interface CadStep {
  id: string;
  started_at: string;
  finished_at: string | null;
  detail: string | null;
}

/** How far the current step is: denoising steps, MB downloaded */
export interface CadProgress {
  done: number;
  total: number | null;
  unit: string | null;
}

interface WorkerStatus {
  state: Exclude<CadJobState, 'queued'>;
  step: string | null;
  steps?: CadStep[];
  progress?: CadProgress | null;
  /**
   * A figure's input: an uploaded picture, or one drawn from its prompt (decides which steps are ahead); fix:
   * Claude reviewing and fixing a figure
   */
  input?: 'image' | 'prompt' | 'fix';
  /**
   * claude: made or fixed by Claude in Blender, whose steps are not known ahead; hunyuan: shaped by Hunyuan3D-2
   * from its picture (those steps are ahead), then finished by Claude in Blender
   */
  maker?: FigureMaker;
  /** A figure being coloured (the paint steps are ahead) */
  colour?: boolean;
  /** A figure shaped from several sides: the ones uploaded, or those MV-Adapter draws (its steps are ahead) */
  views?: FigureViews | null;
  notes: string[];
  builds: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result: CadResult | null;
  report: CadBuildReport | null;
  /** The assembly guide drawn after the last build of a model with `components` (cad/assembly_guide.py) */
  guide?: CadGuideOutcome | null;
}

export interface CadJob extends CadJobMeta {
  state: CadJobState;
  step: string | null;
  steps: CadStep[];
  progress: CadProgress | null;
  input: 'image' | 'prompt' | 'fix' | null;
  maker: FigureMaker | null;
  colour: boolean;
  views: FigureViews | null;
  notes: string[];
  builds: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result: CadResult | null;
  report: CadBuildReport | null;
  /** The assembly guide of a model with `components`, as last drawn */
  guide: CadGuideOutcome | null;
  /** "Vẽ lại" of its assembly guide, running in the gateway (it goes on when the page closes) or how it ended */
  guide_task: TaskState | null;
  /** A failed job's details under its error: the last build's error, Claude's last notes, Claude Code's stderr */
  error_details: string[];
  /** Whether POST /api/cad/jobs/:id/retry can run it again in place (a figure needs the settings it was asked with) */
  retryable: boolean;
  /**
   * threemf: a coloured figure's 3MF, its faces painted with the filaments in report.palette; fix: the fix.py
   * of an older Claude review; views: the six sides Claude checked the figure from; sides: the sides a figure was
   * shaped from; shaped: the preview of the figure as Hunyuan3D-2 shaped it, before Claude finished it; blend: the
   * Blender scene Claude left
   */
  files: {
    code: boolean;
    stl: boolean;
    step: boolean;
    preview: boolean;
    concept: boolean;
    threemf: boolean;
    fix: boolean;
    views: boolean;
    sides: boolean;
    shaped: boolean;
    blend: boolean;
    /** The parts assembled (components declared in model.py): what is simulated, where preview is the print layout */
    assembly: boolean;
    /** Its assembly guide: steps (guide.json, a picture each) and a video (assembly.mp4) */
    guide: boolean;
  };
}

/** Files of a job the API serves, by name, with where they are in its folder */
export const CAD_FILES = {
  'model.py': { path: 'model.py', type: 'text/x-python; charset=utf-8' },
  'model.stl': { path: 'out/model.stl', type: 'model/stl' },
  'model.step': { path: 'out/model.step', type: 'model/step' },
  'preview.png': { path: 'out/preview.png', type: 'image/png' },
  'concept.png': { path: 'concept.png', type: 'image/png' },
  'model.3mf': { path: 'out/model.3mf', type: 'model/3mf' },
  'report.json': { path: 'out/report.json', type: 'application/json; charset=utf-8' },
  'fix.py': { path: 'fix.py', type: 'text/x-python; charset=utf-8' },
  'views.png': { path: 'out/views.png', type: 'image/png' },
  'sides.png': { path: 'sides.png', type: 'image/png' },
  'shaped.png': { path: 'source/preview.png', type: 'image/png' },
  'scene.blend': { path: 'out/scene.blend', type: 'application/x-blender' },
  'assembly.png': { path: 'out/assembly.png', type: 'image/png' },
  'guide.json': { path: 'out/guide/guide.json', type: 'application/json; charset=utf-8' },
  'assembly.mp4': { path: 'out/guide/assembly.mp4', type: 'video/mp4' },
} as const;
export type CadFileName = keyof typeof CAD_FILES;

const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;
const GUIDE_PICTURE_RE = /^(step-\d{2,3}|done)\.png$/;

/** What drawing an assembly guide came to: its steps, and its video unless ffmpeg failed (`error` says why) */
export interface CadGuideOutcome {
  ok: boolean;
  steps?: number;
  video?: string | null;
  error?: string | null;
}

/** "20261023-091502-a1b2": sorts by creation time, and fits the worker's job id rule */
export function newJobId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Replaced whole, so the worker never reads half a file */
async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.writeFile(`${file}.part`, JSON.stringify(data, null, 2));
  await fs.rename(`${file}.part`, file);
}

export class CadJobStore {
  constructor(private readonly dir: string) {}

  private jobDir(id: string): string | null {
    return JOB_ID_RE.test(id) ? path.join(this.dir, id) : null;
  }

  /**
   * A new job folder. For Claude, `request` is its brief (request.md); `code` is a ready model.py, or for a
   * revision Claude starts from, the parent's; `image` is the picture a figure is made from (input.png).
   */
  async create(
    meta: Omit<CadJobMeta, 'id' | 'created_at' | 'sent'>,
    files: { request?: string; code?: string; image?: Uint8Array; views?: SideViews; attachments?: Attachment[]; mesh?: MeshParams }
  ): Promise<CadJobMeta> {
    const id = newJobId();
    const dir = path.join(this.dir, id);
    await fs.mkdir(dir, { recursive: true });
    const full: CadJobMeta = { id, ...meta, created_at: new Date().toISOString(), sent: [] };
    if (files.request !== undefined) await fs.writeFile(path.join(dir, 'request.md'), files.request);
    if (files.code !== undefined) await fs.writeFile(path.join(dir, 'model.py'), files.code);
    if (files.image !== undefined) await fs.writeFile(path.join(dir, 'input.png'), files.image);
    // A figure's settings, so "Thử lại" makes it again as it was asked
    if (files.mesh !== undefined) await writeJson(path.join(dir, MESH_PARAMS), files.mesh);
    const sides = Object.entries(files.views ?? {}).filter((entry): entry is [string, Uint8Array] => !!entry[1]);
    if (sides.length) {
      await fs.mkdir(path.join(dir, 'views'), { recursive: true });
      await Promise.all(sides.map(([side, data]) => fs.writeFile(path.join(dir, 'views', `${side}.png`), data)));
    }
    if (files.attachments?.length) {
      await fs.mkdir(path.join(dir, ATTACHMENTS_DIR), { recursive: true });
      await Promise.all(files.attachments.map((a) => fs.writeFile(path.join(dir, ATTACHMENTS_DIR, a.name), a.data)));
    }
    await writeJson(path.join(dir, 'job.json'), full);
    return full;
  }

  async get(id: string): Promise<CadJob | null> {
    const dir = this.jobDir(id);
    if (!dir) return null;
    const meta = await readJson<CadJobMeta>(path.join(dir, 'job.json'));
    if (!meta) return null;
    const status = await readJson<WorkerStatus>(path.join(dir, 'status.json'));
    const names = ['model.py', 'model.stl', 'model.step', 'preview.png', 'concept.png', 'model.3mf', 'fix.py', 'views.png', 'sides.png', 'shaped.png', 'scene.blend', 'assembly.png', 'guide.json'] as const;
    const [code, stl, step, preview, concept, threemf, fix, views, sides, shaped, blend, assembly, guide] = await Promise.all(
      names.map((name) => exists(path.join(dir, CAD_FILES[name].path)))
    );
    return {
      ...meta,
      title: status?.result?.title || meta.title,
      state: status?.state ?? 'queued',
      step: status?.step ?? null,
      steps: status?.steps ?? [],
      progress: status?.progress ?? null,
      input: status?.input ?? null,
      maker: status?.maker ?? null,
      colour: status?.colour ?? false,
      views: status?.views ?? null,
      notes: status?.notes ?? [],
      builds: status?.builds ?? 0,
      started_at: status?.started_at ?? null,
      finished_at: status?.finished_at ?? null,
      error: status?.error ?? null,
      result: status?.result ?? null,
      report: status?.report ?? null,
      // A fix's source/ is the version before it, already shown as such: only a figure Hunyuan3D shaped has its own
      files: { code, stl, step, preview, concept, threemf, fix, views, sides, shaped: shaped && status?.maker === 'hunyuan', blend, assembly, guide },
      guide: status?.guide ?? null,
      guide_task: getTask(guideTaskKey(id)),
      error_details: status?.state === 'failed' ? await failureDetails(dir, status) : [],
      retryable:
        meta.source === 'claude'
          ? await exists(path.join(dir, 'request.md'))
          : meta.source === 'code'
            ? code
            : status?.input === 'fix'
              ? Boolean(meta.parent_id)
              : await exists(path.join(dir, MESH_PARAMS)),
    };
  }

  /** Newest first */
  async list(limit: number): Promise<CadJob[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const ids = names.filter((name) => JOB_ID_RE.test(name)).sort().reverse().slice(0, limit);
    const jobs = await Promise.all(ids.map((id) => this.get(id)));
    return jobs.filter((job): job is CadJob => job !== null);
  }

  /** The picture a figure was made from as uploaded, which "make again" reuses; null when it came from its prompt */
  async inputImage(id: string): Promise<Uint8Array | null> {
    const dir = this.jobDir(id);
    if (!dir) return null;
    return fs.readFile(path.join(dir, 'input.png')).catch(() => null);
  }

  /** The other sides uploaded with a figure's picture, which "make again" reuses with it */
  async views(id: string): Promise<SideViews> {
    const dir = this.jobDir(id);
    if (!dir) return {};
    const found = await Promise.all(
      FIGURE_SIDES.map(async (side) => [side, await fs.readFile(path.join(dir, 'views', `${side}.png`)).catch(() => null)] as const)
    );
    return Object.fromEntries(found.filter(([, data]) => data !== null));
  }

  /** The pictures pasted into a job's revisions so far, which its own revisions keep: its brief names them */
  async attachments(id: string): Promise<Attachment[]> {
    const dir = this.jobDir(id);
    if (!dir) return [];
    const names = await fs.readdir(path.join(dir, ATTACHMENTS_DIR)).catch(() => [] as string[]);
    return Promise.all(names.sort().map(async (name) => ({ name, data: await fs.readFile(path.join(dir, ATTACHMENTS_DIR, name)) })));
  }

  /** The brief Claude got for a job, which a revision builds on */
  async request(id: string): Promise<string | null> {
    const dir = this.jobDir(id);
    if (!dir) return null;
    return fs.readFile(path.join(dir, 'request.md'), 'utf8').catch(() => null);
  }

  /** Where a job's file is on disk, or null when the job or the file does not exist */
  async filePath(id: string, name: CadFileName): Promise<string | null> {
    const dir = this.jobDir(id);
    if (!dir) return null;
    const file = path.join(dir, CAD_FILES[name].path);
    return (await exists(file)) ? file : null;
  }

  /** Plate n's own 3MF of an assembly laid out on several plates (out/plates/plate-<n>.3mf), or null */
  async plateFile(id: string, n: number): Promise<string | null> {
    const dir = this.jobDir(id);
    if (!dir || !Number.isInteger(n) || n < 1) return null;
    const file = path.join(dir, 'out', 'plates', `plate-${n}.3mf`);
    return (await exists(file)) ? file : null;
  }

  /** The settings a figure was asked with (written since retrying came in); null for older ones */
  async meshParams(id: string): Promise<MeshParams | null> {
    const dir = this.jobDir(id);
    return dir ? readJson<MeshParams>(path.join(dir, MESH_PARAMS)) : null;
  }

  /** A picture of a job's assembly guide (step-01.png…, done.png), or null when there is none */
  async guidePicture(id: string, name: string): Promise<string | null> {
    const dir = this.jobDir(id);
    if (!dir || !GUIDE_PICTURE_RE.test(name)) return null;
    const file = path.join(dir, 'out', 'guide', name);
    return (await exists(file)) ? file : null;
  }

  /**
   * Deletes a job's folder, with `family` also every job made from it (its fixes, revisions and remakes, and
   * theirs). Alone, the jobs made from it move up to its own parent, so its versions stay together. Returns the ids
   * deleted; [] when the job does not exist
   */
  async remove(id: string, family = false): Promise<string[]> {
    const dir = this.jobDir(id);
    const meta = dir ? await readJson<CadJobMeta>(path.join(dir, 'job.json')) : null;
    if (!dir || !meta) return [];
    const all = await this.list(Number.MAX_SAFE_INTEGER);
    const ids = family ? lineageOf(id, all) : [id];
    if (!family) {
      for (const child of all.filter((job) => job.parent_id === id)) {
        const file = path.join(this.dir, child.id, 'job.json');
        const childMeta = await readJson<CadJobMeta>(file);
        if (childMeta) await writeJson(file, { ...childMeta, parent_id: meta.parent_id });
      }
    }
    await Promise.all(ids.map((one) => fs.rm(path.join(this.dir, one), { recursive: true, force: true })));
    return ids;
  }

  async markSent(id: string, name: string): Promise<void> {
    const dir = this.jobDir(id);
    if (!dir) return;
    const file = path.join(dir, 'job.json');
    const meta = await readJson<CadJobMeta>(file);
    if (!meta) return;
    meta.sent = [...(meta.sent ?? []), { name, at: new Date().toISOString() }];
    await writeJson(file, meta);
  }
}

/** `id` and every job descended from it (by parent_id), among `jobs` */
export function lineageOf(id: string, jobs: Pick<CadJobMeta, 'id' | 'parent_id'>[]): string[] {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) ids.push(...jobs.filter((job) => job.parent_id === ids[i]).map((job) => job.id));
  return ids;
}

/** The sides of a figure besides its front picture (input.png), as Hunyuan3D-2mv names them */
export const FIGURE_SIDES = ['left', 'back', 'right'] as const;
export type FigureSide = (typeof FIGURE_SIDES)[number];
export type SideViews = Partial<Record<FigureSide, Uint8Array>>;
/** How a figure got its other sides: uploaded with its picture, or drawn by MV-Adapter */
export type FigureViews = 'uploaded' | 'drawn';
/** Who made a figure (see WorkerStatus.maker) */
export type FigureMaker = 'claude' | 'hunyuan';

/** A picture the user pasted into a revision: attachments/<name> in the job's folder */
export interface Attachment {
  name: string;
  data: Uint8Array;
}

export const ATTACHMENTS_DIR = 'attachments';

/** The line of a brief that points Claude at the pictures pasted with it (none: nothing) */
function attachmentLine(names: string[]): string {
  if (!names.length) return '';
  const files = names.map((name) => `${ATTACHMENTS_DIR}/${name}`).join(', ');
  return `\n\nẢnh người dùng gửi kèm yêu cầu này (mở bằng Read và xem kỹ trước khi sửa): ${files}`;
}

const MESH_PARAMS = 'mesh-params.json';
const STDERR_LINES = 12;

/**
 * What else is known about a failed job, in the order it helps: the last build's error (build123d's traceback
 * ends with it), what the last build step said, Claude's last notes, and the end of Claude Code's or the worker's
 * stderr (claude.err, worker.err) when it wrote any
 */
async function failureDetails(dir: string, status: WorkerStatus): Promise<string[]> {
  const lines: string[] = [];
  const report = status.report as (CadBuildReport & { error?: string }) | null;
  if (report?.error) lines.push(`Lần dựng cuối: ${report.error}`);
  const last = [...(status.steps ?? [])].reverse().find((s) => s.detail);
  if (last?.detail) lines.push(`Bước cuối (${last.id}): ${last.detail}`);
  for (const note of (status.notes ?? []).slice(-3)) lines.push(`Claude: ${note.replace(/^•\s*/, '')}`);
  for (const name of ['claude.err', 'worker.err']) {
    const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '');
    const tail = text.trim().split(/\r?\n/).slice(-STDERR_LINES).filter(Boolean);
    if (tail.length) lines.push(`${name}:`, ...tail);
  }
  return lines;
}

/** The background task that draws a job's assembly guide again (POST /api/cad/jobs/:id/guide) */
export const guideTaskKey = (id: string) => `cad-guide:${id}`;

/**
 * Claude's brief for a new model, or for changing the model of `parent` (whose brief it was given); `attached`
 * names the pictures pasted with the prompt
 */
export function buildRequest(prompt: string, parent?: { request: string | null; prompt: string }, attached: string[] = []): string {
  if (!parent) return `# Yêu cầu\n\n${prompt.trim()}${attachmentLine(attached)}\n`;
  const previous = parent.request?.trim() || `# Yêu cầu\n\n${parent.prompt.trim()}`;
  return `${previous}\n\n# Sửa lại\n\n${prompt.trim()}${attachmentLine(attached)}\n\nmodel.py là mô hình hiện có: sửa nó theo yêu cầu này, giữ nguyên những gì không được nhắc tới.\n`;
}

/**
 * Claude's brief for reviewing and fixing a figure: what it is meant to be (or the brief of the fix it builds on),
 * its size and colours, and what the user wants changed (words and/or the pictures named in `attached`), or nothing:
 * then Claude looks for problems itself
 */
export function buildFixRequest(
  instruction: string,
  parent: { title: string | null; prompt: string; request: string | null; result: CadResult | null; report: CadBuildReport | null },
  attached: string[] = []
): string {
  const ask =
    instruction.trim() || attached.length
      ? `# Cần sửa\n\n${instruction.trim() || 'Xem ảnh gửi kèm.'}${attachmentLine(attached)}\n\nSửa đúng điều này trước, rồi những lỗi khác làm hỏng bản in nếu thấy.`
      : '# Cần sửa\n\nKhông có yêu cầu cụ thể: tự xem mô hình, tìm và sửa những gì làm bản in hỏng (đổ, gãy, mảnh rời, lỗ hở, bề mặt sần) hoặc khác hẳn ảnh gốc.';
  if (parent.request) return `${parent.request.trim()}\n\n# Sửa tiếp\n\nsource/ là bản đã sửa lần trước.\n\n${ask}\n`;
  const params = Object.fromEntries((parent.result?.parameters ?? []).map((p) => [p.name, p.value]));
  const size = parent.report?.size_mm?.join(' × ');
  const facts = [
    `- Tên: ${parent.title || parent.result?.title || 'chưa đặt'}`,
    `- Mô tả của người dùng: ${parent.prompt}`,
    ...(parent.result?.assumptions ?? []).map((a) => `- ${a}`),
    size ? `- Kích thước hiện tại: ${size} mm (X × Y × Z)` : null,
    params.height_mm ? `- Chiều cao nhân vật đã chọn: ${params.height_mm} mm, chưa tính đế` : null,
    params.base !== undefined ? `- Đế tròn: ${params.base ? 'có' : 'không'}` : null,
    parent.report?.palette?.length
      ? `- Tô ${parent.report.palette.length} màu filament (model.3mf): ${parent.report.palette.map((p) => p.label || p.hex).join(', ')}`
      : '- In một màu',
  ].filter(Boolean);
  return `# Mô hình cần xem lại\n\nNhân vật dựng từ ảnh (concept.png) hoặc mô tả.\n\n${facts.join('\n')}\n\n${ask}\n`;
}

export class CadWorkerError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'CadWorkerError';
  }
}

export interface CadWorkerHealth {
  ok: boolean;
  claude: boolean;
  running: string[];
}

/** The worker's HTTP API (cad/worker.py) */
export interface CadWorkerApi {
  health(): Promise<CadWorkerHealth>;
  generate(id: string, model: string): Promise<void>;
  build(id: string): Promise<CadBuildReport>;
  cancel(id: string): Promise<void>;
  /** Draws the assembly guide of a built assembly again */
  guide(id: string): Promise<CadGuideOutcome>;
}

/** JSON over HTTP to a worker container; errors as CadWorkerError with the worker's message */
class WorkerHttp {
  constructor(
    protected readonly baseUrl: string,
    private readonly label: string
  ) {}

  protected async call<T>(method: 'GET' | 'POST', route: string, body: unknown, timeoutMs: number): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(route, this.baseUrl), {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'không trả lời kịp' : 'không kết nối được';
      throw new CadWorkerError(502, 'CAD_WORKER_UNREACHABLE', `Container ${this.label} ${reason} (${this.baseUrl}).`);
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
    if (!res.ok || !data) {
      throw new CadWorkerError(res.status, data?.error ?? 'CAD_WORKER_ERROR', data?.message ?? `Container ${this.label} trả lỗi HTTP ${res.status}.`);
    }
    return data;
  }
}

export class CadWorkerClient extends WorkerHttp implements CadWorkerApi {
  constructor(baseUrl: string) {
    super(baseUrl, 'CAD');
  }

  health() {
    return this.call<CadWorkerHealth>('GET', '/health', undefined, 3000);
  }

  async generate(id: string, model: string) {
    await this.call('POST', `/jobs/${id}/generate`, { model }, 10000);
  }

  async build(id: string) {
    // The worker allows a model 180 s to build
    return (await this.call<{ report: CadBuildReport }>('POST', `/jobs/${id}/build`, {}, 200000)).report;
  }

  async cancel(id: string) {
    await this.call('POST', `/jobs/${id}/cancel`, {}, 10000);
  }

  async guide(id: string) {
    // The worker allows a guide 420 s (a frame of video for every step's every move)
    return (await this.call<{ guide: CadGuideOutcome }>('POST', `/jobs/${id}/guide`, {}, 450000)).guide;
  }
}

export interface MeshWorkerHealth extends CadWorkerHealth {
  /** A Hunyuan3D-2 shape model is in GPU memory (the first figure after a while loads it, ~1 minute) */
  loaded?: boolean;
}

/**
 * A figure's colours: `count` found in its texture; the same, each moved to the nearest of `snap` (one Bambu
 * material's own colours); or the filaments loaded in the AMS, in Studio's order
 */
export type MeshColour = (
  | {
      count: number;
      /** With tiers (prefer): loaded in the AMS (1), the user's own (2), Bambu's to buy (3), lower first */
      snap?: { hex: string; label: string; tier?: number; origin?: 'ams' | 'custom' | 'bambu' }[];
    }
  | { palette: { hex: string; label: string; material: string | null }[] }
) & {
  /** How the dashboard asked, kept in the report so "make again" asks the same */
  request?: { palette: string; colours: number; material: string; filaments: string };
};

export interface MeshParams {
  prompt: string;
  height_mm: number;
  base: boolean;
  /** null: one colour */
  colour: MeshColour | null;
  /** The Claude model that makes or finishes it */
  model: string;
  /** Hunyuan3D-2's random seed, for a figure from a picture: another seed, another shape */
  seed: number;
  /** "Dựng nhiều góc" without uploaded sides: MV-Adapter draws them (uploaded ones are always used) */
  multiview: boolean;
}

/** The mesh worker's HTTP API (mesh3d/worker.py) */
export interface MeshWorkerApi {
  health(): Promise<MeshWorkerHealth>;
  generate(id: string, params: MeshParams): Promise<void>;
  /** Claude reviews and fixes the figure of `parentId` in job `id` (mesh3d/review.py) */
  fix(id: string, parentId: string, model: string): Promise<void>;
  cancel(id: string): Promise<void>;
}

export class MeshWorkerClient extends WorkerHttp implements MeshWorkerApi {
  constructor(baseUrl: string) {
    super(baseUrl, 'mesh3d');
  }

  health() {
    return this.call<MeshWorkerHealth>('GET', '/health', undefined, 3000);
  }

  async generate(id: string, params: MeshParams) {
    await this.call('POST', `/jobs/${id}/generate`, params, 10000);
  }

  async fix(id: string, parentId: string, model: string) {
    // The worker copies the figure and its picture before it answers
    await this.call('POST', `/jobs/${id}/fix`, { parent_id: parentId, model }, 30000);
  }

  async cancel(id: string) {
    await this.call('POST', `/jobs/${id}/cancel`, {}, 10000);
  }
}
