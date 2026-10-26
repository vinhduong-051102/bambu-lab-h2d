import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Models designed by AI (docs/cad.md). Each job is a folder in CAD_JOBS_DIR, shared with the CAD and mesh
 * containers: the gateway writes job.json (who asked for what), request.md (Claude's brief for a technical
 * model, or for Claude's review of a figure) or input.png (a picture for a figure); the workers write model.py
 * (build123d code), concept.png (the figure's picture, background removed), fix.py (Claude's changes to a figure),
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
   * mesh: a figure Hunyuan3D-2 made from a picture (uploaded, or drawn from the prompt), or Claude's fix of one
   * (model is then the Claude model, parent_id the figure fixed)
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
  /** A figure being coloured (the paint steps are ahead) */
  colour?: boolean;
  notes: string[];
  builds: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result: CadResult | null;
  report: CadBuildReport | null;
}

export interface CadJob extends CadJobMeta {
  state: CadJobState;
  step: string | null;
  steps: CadStep[];
  progress: CadProgress | null;
  input: 'image' | 'prompt' | 'fix' | null;
  colour: boolean;
  notes: string[];
  builds: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result: CadResult | null;
  report: CadBuildReport | null;
  /**
   * threemf: a coloured figure's 3MF, its faces painted with the filaments in report.palette; fix: the fix.py
   * of Claude's review; views: the six sides it reviewed the figure from
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
} as const;
export type CadFileName = keyof typeof CAD_FILES;

const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;

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
    files: { request?: string; code?: string; image?: Uint8Array }
  ): Promise<CadJobMeta> {
    const id = newJobId();
    const dir = path.join(this.dir, id);
    await fs.mkdir(dir, { recursive: true });
    const full: CadJobMeta = { id, ...meta, created_at: new Date().toISOString(), sent: [] };
    if (files.request !== undefined) await fs.writeFile(path.join(dir, 'request.md'), files.request);
    if (files.code !== undefined) await fs.writeFile(path.join(dir, 'model.py'), files.code);
    if (files.image !== undefined) await fs.writeFile(path.join(dir, 'input.png'), files.image);
    await writeJson(path.join(dir, 'job.json'), full);
    return full;
  }

  async get(id: string): Promise<CadJob | null> {
    const dir = this.jobDir(id);
    if (!dir) return null;
    const meta = await readJson<CadJobMeta>(path.join(dir, 'job.json'));
    if (!meta) return null;
    const status = await readJson<WorkerStatus>(path.join(dir, 'status.json'));
    const [code, stl, step, preview, concept, threemf, fix, views] = await Promise.all(
      (['model.py', 'model.stl', 'model.step', 'preview.png', 'concept.png', 'model.3mf', 'fix.py', 'views.png'] as const).map(
        (name) => exists(path.join(dir, CAD_FILES[name].path))
      )
    );
    return {
      ...meta,
      title: status?.result?.title || meta.title,
      state: status?.state ?? 'queued',
      step: status?.step ?? null,
      steps: status?.steps ?? [],
      progress: status?.progress ?? null,
      input: status?.input ?? null,
      colour: status?.colour ?? false,
      notes: status?.notes ?? [],
      builds: status?.builds ?? 0,
      started_at: status?.started_at ?? null,
      finished_at: status?.finished_at ?? null,
      error: status?.error ?? null,
      result: status?.result ?? null,
      report: status?.report ?? null,
      files: { code, stl, step, preview, concept, threemf, fix, views },
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

/** Claude's brief for a new model, or for changing the model of `parent` (whose brief it was given) */
export function buildRequest(prompt: string, parent?: { request: string | null; prompt: string }): string {
  if (!parent) return `# Yêu cầu\n\n${prompt.trim()}\n`;
  const previous = parent.request?.trim() || `# Yêu cầu\n\n${parent.prompt.trim()}`;
  return `${previous}\n\n# Sửa lại\n\n${prompt.trim()}\n\nmodel.py là mô hình hiện có: sửa nó theo yêu cầu này, giữ nguyên những gì không được nhắc tới.\n`;
}

/**
 * Claude's brief for reviewing and fixing a figure: what it is meant to be (or the brief of the fix it builds on),
 * its size and colours, and what the user wants changed, or nothing: then Claude looks for problems itself
 */
export function buildFixRequest(
  instruction: string,
  parent: { title: string | null; prompt: string; request: string | null; result: CadResult | null; report: CadBuildReport | null }
): string {
  const ask = instruction.trim()
    ? `# Cần sửa\n\n${instruction.trim()}\n\nSửa đúng điều này trước, rồi những lỗi khác làm hỏng bản in nếu thấy.`
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
  return `# Mô hình cần xem lại\n\nNhân vật do Hunyuan3D-2 dựng từ ảnh (concept.png).\n\n${facts.join('\n')}\n\n${ask}\n`;
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
}

export interface MeshWorkerHealth extends CadWorkerHealth {
  /** Hunyuan3D-2 is in GPU memory (otherwise the next figure first loads it, ~2 minutes) */
  loaded: boolean;
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
  seed: number;
  /** null: one colour, no texture */
  colour: MeshColour | null;
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
