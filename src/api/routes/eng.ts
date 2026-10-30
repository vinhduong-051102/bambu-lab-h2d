import { env } from '../../config/env';
import { getTask, startTask } from '../../domain/backgroundTasks';
import { handler, json, readJsonBody } from '../http';

/**
 * Engineering analysis of 3D-printed parts (docs/engineering-analysis.md): geometry, assembly, clearance, motion
 * (Chrono), FEA (gmsh + CalculiX), printability, reports and Blender renders run in the mesh container; these routes
 * pass requests through to its /eng routes. Answers (JSON, or a result file) come back as the worker sent them.
 */

// Geometry checks, the motion run with its wait and the Blender renders answer when they are done; FEA answers at once
const TIMEOUT_MS = 15 * 60 * 1000;
const POST_ROUTES = new Set([
  'inspect',
  'validate',
  'assembly',
  'clearance',
  'motion/configure',
  'motion/run',
  'fea/configure',
  'fea/run',
  'printability',
  'report',
  'visualize',
  'check',
]);
const ID_RE = /^[a-z][a-z0-9-]{5,63}$/;
const JOB_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;
const FILE_PART_RE = /^[A-Za-z0-9_.-]{1,80}$/;
// A design job's check goes on when the page closes; what the worker refuses at once is answered at once
const CHECK_WAIT_MS = 1500;
const checkTask = (jobId: string) => `eng-check:${jobId}`;

let workerUrlOverride: string | null = null;

/** Tests point the routes at a fake worker; null restores MESH_WORKER_URL */
export function setEngWorkerUrl(url: string | null): void {
  workerUrlOverride = url;
}

const workerUrl = (): string | null => workerUrlOverride ?? env.MESH_WORKER_URL ?? null;

const notFound = (message: string) => json({ success: false, error: 'NOT_FOUND', message }, 404);

/** The worker path a GET may reach: models, analyses and their files, nothing else */
export function engGetPath(parts: string[]): string | null {
  if (parts.length === 1 && (parts[0] === 'models' || parts[0] === 'analyses')) return parts[0];
  // The latest check of a design job (the dashboard's "Kiểm tra kỹ thuật")
  if (parts.length === 2 && parts[0] === 'checks' && JOB_RE.test(parts[1])) return parts.join('/');
  if (parts.length === 2 && (parts[0] === 'models' || parts[0] === 'analyses') && ID_RE.test(parts[1])) return parts.join('/');
  if (parts.length >= 4 && parts.length <= 6 && parts[0] === 'analyses' && ID_RE.test(parts[1]) && parts[2] === 'files') {
    return parts.slice(3).every((p) => FILE_PART_RE.test(p) && p !== '..' && p !== '.') ? parts.join('/') : null;
  }
  return null;
}

async function forward(method: 'GET' | 'POST', route: string, body?: unknown): Promise<Response> {
  const base = workerUrl();
  if (!base) {
    return json({ success: false, error: 'ENG_DISABLED', message: 'Chưa cấu hình MESH_WORKER_URL (docs/engineering-analysis.md).' }, 501);
  }
  let res: Response;
  try {
    res = await fetch(new URL(`/eng/${route}`, base), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Node's fetch gives up on a worker that sends no headers for 5 minutes (undici's headersTimeout), whatever the signal
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    const reason =
      (err instanceof Error && err.name === 'TimeoutError') || code === 'UND_ERR_HEADERS_TIMEOUT'
        ? 'không trả lời kịp (phép tính quá lâu)'
        : 'không kết nối được';
    return json({ success: false, error: 'ENG_WORKER_UNREACHABLE', message: `Container mesh3d ${reason} (${base}).` }, 502);
  }
  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  if (type.startsWith('application/json')) {
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data) return json({ success: false, error: 'ENG_WORKER_ERROR', message: `Container mesh3d trả lỗi HTTP ${res.status}.` }, 502);
    const { ok, ...rest } = data;
    return json({ success: Boolean(ok), ...rest }, res.status);
  }
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
}

export const getEng = handler<{ path: string[] }>(async ({ request, params }) => {
  const route = engGetPath(params.path ?? []);
  if (!route) return notFound('Không có đường dẫn này.');
  const query = new URL(request.url).search;
  const res = await forward('GET', route + query);
  if (params.path?.[0] !== 'checks' || !res.ok) return res;
  // The latest check, and the one running now (or how the last one ended) for the page to keep watching
  const data = (await res.json()) as Record<string, unknown>;
  return json({ ...data, task: getTask(checkTask(params.path[1])) });
});

/** What the worker said beyond its message: the error code, and each field it refused with why */
function workerDetails(status: number, data: Record<string, unknown>): string[] {
  const lines = [`HTTP ${status}${data.error ? ` · ${String(data.error)}` : ''}`];
  if (Array.isArray(data.details)) {
    for (const d of data.details as { path?: string; message?: string }[]) lines.push(d.path ? `${d.path}: ${d.message ?? ''}` : String(d.message ?? JSON.stringify(d)));
  }
  return lines;
}

/** The worker's JSON answer to a check, kept as it came for whoever started it */
async function runCheck(body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await forward('POST', 'check', body);
  const data = ((await res.json().catch(() => null)) ?? { success: false, message: `HTTP ${res.status}` }) as Record<string, unknown>;
  return { status: res.status, data };
}

export const postEng = handler<{ path: string[] }>(async ({ request, params }) => {
  const route = (params.path ?? []).join('/');
  if (!POST_ROUTES.has(route)) return notFound('Không có thao tác này.');
  const raw = await readJsonBody(request);
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (route !== 'check' || typeof body.job_id !== 'string' || !JOB_RE.test(body.job_id)) return forward('POST', route, body);

  const key = checkTask(body.job_id);
  const { started, state, outcome } = await startTask(key, () => runCheck(body), {
    info: { kind: 'eng-check', label: typeof body.name === 'string' && body.name ? body.name : body.job_id, page: 'cad' },
    waitMs: CHECK_WAIT_MS,
    failed: ({ status, data }) => (status < 400 && data.success ? null : String(data.message ?? `HTTP ${status}`)),
    explain: ({ status, data }) => (status < 400 && data.success ? [] : workerDetails(status, data)),
  });
  if (outcome && 'value' in outcome) return json(outcome.value.data, outcome.value.status);
  if (outcome) throw outcome.error;
  // Still running (or one already was): the page reads GET /api/eng/checks/<job> until it ends
  return json({ success: true, running: true, started, task: state }, 202);
});
