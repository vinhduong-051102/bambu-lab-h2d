import { env } from '../../config/env';
import { getTask, startTask } from '../../domain/backgroundTasks';
import { handler, json, readJsonBody } from '../http';
import { liveJson } from './simLive';

/**
 * Mechanical model (docs/mechanical-model.md): designs as revisions of parts, joints, gears, motors and loads,
 * checked (DOF, conflicts, gears, interference) and simulated through the existing Chrono pipeline, in the mesh
 * container. These routes pass requests through to its /mech routes.
 *
 * A 3D model's own simulation (docs/model-simulation.md) adds two things only the gateway can do, as it sees both
 * containers: POST /api/mech/designs/:id/live compiles the design in the mesh worker and opens it as a live Chrono
 * session in sim-live; GET /api/mech/models/:id adds that session (RUNNING or PAUSED) to the state the worker reads.
 */

// A simulation waits for its run (up to wait_s ≤ 600 s) before answering
const TIMEOUT_MS = 12 * 60 * 1000;
const DESIGN_RE = /^d-\d{8}-\d{6}-[0-9a-f]{4}$/;
const SIM_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;
const DESIGN_ACTIONS = new Set(['validate', 'simulate', 'repairs', 'apply', 'live']);
const MODEL_RE = /^[a-z0-9][a-z0-9_.-]{0,80}$/;
// Setting a model up goes on when the page closes; what the worker refuses at once is answered at once
const SETUP_WAIT_MS = 1500;
/** The task that sets up a model's simulation: by its eng model id (a design job's is job-<job id>) */
const setupTask = (modelId: string) => `mech-setup:${modelId}`;

let workerUrlOverride: string | null = null;

/** Tests point the routes at a fake worker; null restores MESH_WORKER_URL */
export function setMechWorkerUrl(url: string | null): void {
  workerUrlOverride = url;
}

const workerUrl = (): string | null => workerUrlOverride ?? env.MESH_WORKER_URL ?? null;

/** The worker path a request may reach, or null */
export function mechPath(method: 'GET' | 'POST', parts: string[]): string | null {
  const [head, id, action, runId] = parts;
  if (method === 'GET') {
    if (parts.length === 1 && (head === 'designs' || head === 'capabilities' || head === 'guide')) return head;
    if (parts.length === 2 && head === 'designs' && DESIGN_RE.test(id)) return parts.join('/');
    if (parts.length === 4 && head === 'designs' && DESIGN_RE.test(id) && action === 'runs' && SIM_RE.test(runId)) return parts.join('/');
    if (parts.length === 3 && head === 'designs' && DESIGN_RE.test(id) && action === 'viewer') return parts.join('/');
    if (parts.length === 2 && head === 'models' && MODEL_RE.test(id)) return parts.join('/');
    return null;
  }
  if (parts.length === 1 && (head === 'designs' || head === 'import')) return head;
  if (parts.length === 2 && head === 'models' && id === 'setup') return 'models/setup';
  if (parts.length === 2 && head === 'designs' && DESIGN_RE.test(id)) return parts.join('/');
  if (parts.length === 3 && head === 'designs' && DESIGN_RE.test(id) && DESIGN_ACTIONS.has(action)) return parts.join('/');
  return null;
}

async function forward(method: 'GET' | 'POST', route: string, body?: unknown): Promise<Response> {
  const res = await reach(method, route, body);
  if (res.status === 0) return json(res.data, 502);
  if (!res.json) return res.raw!;
  return json(res.data, res.status);
}

type Reached = { status: number; data: Record<string, unknown>; json: boolean; raw?: Response };

/** The worker's answer, its ok as success */
async function reach(method: 'GET' | 'POST', route: string, body?: unknown): Promise<Reached> {
  const base = workerUrl();
  if (!base) return { status: 501, json: true, data: { success: false, error: 'MECH_DISABLED', message: 'Chưa cấu hình MESH_WORKER_URL.' } };
  let res: Response;
  try {
    res = await fetch(new URL(`/mech/${route}`, base), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    const late = (err instanceof Error && err.name === 'TimeoutError') || code === 'UND_ERR_HEADERS_TIMEOUT';
    return { status: 0, json: true, data: { success: false, error: 'MECH_WORKER_UNREACHABLE', message: `Container mesh3d ${late ? 'không trả lời kịp' : 'không kết nối được'} (${base}).` } };
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('application/json')) {
    return { status: res.status, json: false, data: {}, raw: new Response(res.body, { status: res.status, headers: { 'Content-Type': type || 'text/plain; charset=utf-8' } }) };
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data) return { status: 0, json: true, data: { success: false, error: 'MECH_WORKER_ERROR', message: `Container mesh3d trả lỗi HTTP ${res.status}.` } };
  const { ok, ...rest } = data;
  return { status: res.status, json: true, data: { success: Boolean(ok), ...rest } };
}

type LiveSession = { session_id: string; source?: Record<string, string>; t: number; running: boolean };

async function liveSessions(): Promise<LiveSession[] | null> {
  const { status, data } = await liveJson('GET', '');
  return status === 200 && Array.isArray(data.sessions) ? (data.sessions as LiveSession[]) : null;
}

/** The worker's state of a model, with the live session of its current revision when one is open */
async function modelStatus(route: string): Promise<Response> {
  const res = await reach('GET', route);
  // The setup running now (started before the page was opened again, say) or how the last one ended
  const setup_task = getTask(setupTask(route.split('/')[1]));
  if (res.status !== 200 || !res.data.design_id) return json(res.status === 200 ? { ...res.data, setup_task } : res.data, res.status || 502);
  const sessions = await liveSessions();
  const data: Record<string, unknown> = { ...res.data, setup_task, live: null, live_available: sessions !== null };
  const mine = (sessions ?? []).filter((s) => s.source?.design_id === res.data.design_id);
  const current = mine.find((s) => s.source?.revision === String(res.data.revision));
  if (current) {
    data.live = { session_id: current.session_id, t: current.t, running: current.running, revision: res.data.revision };
    // A session is only the state of a revision that can run: never over INVALID or NEEDS_VALIDATION
    if (['READY', 'COMPLETED', 'FAILED'].includes(String(res.data.state))) data.state = current.running ? 'RUNNING' : 'PAUSED';
  }
  const stale = mine.filter((s) => s !== current);
  if (stale.length) data.live_stale = stale.map((s) => ({ session_id: s.session_id, revision: Number(s.source?.revision) }));
  return json(data, 200);
}

/** Opens a design revision in a live Chrono session: compiled by the worker (refused when it does not validate),
 * replacing an earlier session of the same design */
async function startLive(designId: string, body: Record<string, unknown>): Promise<Response> {
  const revision = Number.isInteger(body.revision) ? `?revision=${body.revision}` : '';
  const viewer = await reach('GET', `designs/${designId}/viewer${revision}`);
  if (viewer.status !== 200) return json(viewer.data, viewer.status || 502);
  for (const s of (await liveSessions()) ?? []) {
    if (s.source?.design_id === designId) await liveJson('POST', `/${s.session_id}/stop`, {});
  }
  const { mechanism, origin, success: _ok, ...rest } = viewer.data;
  const started = await liveJson('POST', '', {
    mechanism,
    origin,
    paused: body.paused === true,
    ...(body.simulation && typeof body.simulation === 'object' ? { simulation: body.simulation } : {}),
  });
  if (started.status >= 300) return json(started.data, started.status);
  return json({ ...started.data, ...rest }, started.status);
}

/** Sets a model's simulation up in the background: 202 while it runs, GET models/:id says when it is done */
async function setup(body: Record<string, unknown>): Promise<Response> {
  const modelId = typeof body.job_id === 'string' ? `job-${body.job_id}` : typeof body.model_id === 'string' ? body.model_id : null;
  if (!modelId || !MODEL_RE.test(modelId)) return forward('POST', 'models/setup', body);
  const { outcome, state } = await startTask(setupTask(modelId), () => reach('POST', 'models/setup', body), {
    waitMs: SETUP_WAIT_MS,
    failed: (res) => (res.status >= 200 && res.status < 300 && res.data.success ? null : String(res.data.message ?? `HTTP ${res.status}`)),
  });
  if (outcome && 'value' in outcome) return json(outcome.value.data, outcome.value.status || 502);
  if (outcome) throw outcome.error;
  return json({ success: true, running: true, model_id: modelId, task: state }, 202);
}

export const getMech = handler<{ path: string[] }>(async ({ request, params }) => {
  const route = mechPath('GET', params.path ?? []);
  if (!route) return json({ success: false, error: 'NOT_FOUND', message: 'Không có đường dẫn này.' }, 404);
  if (route.startsWith('models/')) return modelStatus(route);
  return forward('GET', route + new URL(request.url).search);
});

export const postMech = handler<{ path: string[] }>(async ({ request, params }) => {
  const route = mechPath('POST', params.path ?? []);
  if (!route) return json({ success: false, error: 'NOT_FOUND', message: 'Không có thao tác này.' }, 404);
  const raw = await readJsonBody(request);
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (route.endsWith('/live')) return startLive(route.split('/')[1], body);
  if (route === 'models/setup') return setup(body);
  return forward('POST', route, body);
});
