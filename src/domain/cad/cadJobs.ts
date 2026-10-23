import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Models designed by AI (docs/cad.md). Each job is a folder in CAD_JOBS_DIR, shared with the CAD container:
 * the gateway writes job.json (who asked for what) and request.md (Claude's brief); the container's worker
 * writes model.py (build123d code), out/ (model.stl, model.step, preview.png, report.json) and status.json.
 */

export type CadJobSource = 'claude' | 'code';
export type CadJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface CadJobMeta {
  id: string;
  /** What the user asked for (for a revision: what to change) */
  prompt: string;
  /** claude: written by Claude in the container; code: model.py sent ready-made (Antigravity, the API) */
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
}

export interface CadResult {
  title: string;
  summary: string;
  assumptions: string[];
  parameters: { name: string; value: number; description: string }[];
  warnings: string[];
}

interface WorkerStatus {
  state: Exclude<CadJobState, 'queued'>;
  step: string | null;
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
  notes: string[];
  builds: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result: CadResult | null;
  report: CadBuildReport | null;
  files: { code: boolean; stl: boolean; step: boolean; preview: boolean };
}

/** Files of a job the API serves, by name, with where they are in its folder */
export const CAD_FILES = {
  'model.py': { path: 'model.py', type: 'text/x-python; charset=utf-8' },
  'model.stl': { path: 'out/model.stl', type: 'model/stl' },
  'model.step': { path: 'out/model.step', type: 'model/step' },
  'preview.png': { path: 'out/preview.png', type: 'image/png' },
  'report.json': { path: 'out/report.json', type: 'application/json; charset=utf-8' },
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
   * revision Claude starts from, the parent's.
   */
  async create(meta: Omit<CadJobMeta, 'id' | 'created_at' | 'sent'>, files: { request?: string; code?: string }): Promise<CadJobMeta> {
    const id = newJobId();
    const dir = path.join(this.dir, id);
    await fs.mkdir(dir, { recursive: true });
    const full: CadJobMeta = { id, ...meta, created_at: new Date().toISOString(), sent: [] };
    if (files.request !== undefined) await fs.writeFile(path.join(dir, 'request.md'), files.request);
    if (files.code !== undefined) await fs.writeFile(path.join(dir, 'model.py'), files.code);
    await writeJson(path.join(dir, 'job.json'), full);
    return full;
  }

  async get(id: string): Promise<CadJob | null> {
    const dir = this.jobDir(id);
    if (!dir) return null;
    const meta = await readJson<CadJobMeta>(path.join(dir, 'job.json'));
    if (!meta) return null;
    const status = await readJson<WorkerStatus>(path.join(dir, 'status.json'));
    const [code, stl, step, preview] = await Promise.all(
      (['model.py', 'model.stl', 'model.step', 'preview.png'] as const).map((name) => exists(path.join(dir, CAD_FILES[name].path)))
    );
    return {
      ...meta,
      title: status?.result?.title || meta.title,
      state: status?.state ?? 'queued',
      step: status?.step ?? null,
      notes: status?.notes ?? [],
      builds: status?.builds ?? 0,
      started_at: status?.started_at ?? null,
      finished_at: status?.finished_at ?? null,
      error: status?.error ?? null,
      result: status?.result ?? null,
      report: status?.report ?? null,
      files: { code, stl, step, preview },
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

export class CadWorkerClient implements CadWorkerApi {
  constructor(private readonly baseUrl: string) {}

  private async call<T>(method: 'GET' | 'POST', route: string, body: unknown, timeoutMs: number): Promise<T> {
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
      throw new CadWorkerError(502, 'CAD_WORKER_UNREACHABLE', `Container CAD ${reason} (${this.baseUrl}).`);
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
    if (!res.ok || !data) {
      throw new CadWorkerError(res.status, data?.error ?? 'CAD_WORKER_ERROR', data?.message ?? `Container CAD trả lỗi HTTP ${res.status}.`);
    }
    return data;
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
