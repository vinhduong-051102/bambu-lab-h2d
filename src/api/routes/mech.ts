import { env } from '../../config/env';
import { handler, json, readJsonBody } from '../http';

/**
 * Mechanical model (docs/mechanical-model.md): designs as revisions of parts, joints, gears, motors and loads,
 * checked (DOF, conflicts, gears, interference) and simulated through the existing Chrono pipeline, in the mesh
 * container. These routes pass requests through to its /mech routes.
 */

// A simulation waits for its run (up to wait_s ≤ 600 s) before answering
const TIMEOUT_MS = 12 * 60 * 1000;
const DESIGN_RE = /^d-\d{8}-\d{6}-[0-9a-f]{4}$/;
const SIM_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;
const DESIGN_ACTIONS = new Set(['validate', 'simulate', 'repairs', 'apply']);

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
    return null;
  }
  if (parts.length === 1 && (head === 'designs' || head === 'import')) return head;
  if (parts.length === 2 && head === 'designs' && DESIGN_RE.test(id)) return parts.join('/');
  if (parts.length === 3 && head === 'designs' && DESIGN_RE.test(id) && DESIGN_ACTIONS.has(action)) return parts.join('/');
  return null;
}

async function forward(method: 'GET' | 'POST', route: string, body?: unknown): Promise<Response> {
  const base = workerUrl();
  if (!base) return json({ success: false, error: 'MECH_DISABLED', message: 'Chưa cấu hình MESH_WORKER_URL.' }, 501);
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
    return json({ success: false, error: 'MECH_WORKER_UNREACHABLE', message: `Container mesh3d ${late ? 'không trả lời kịp' : 'không kết nối được'} (${base}).` }, 502);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('application/json')) {
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': type || 'text/plain; charset=utf-8' } });
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data) return json({ success: false, error: 'MECH_WORKER_ERROR', message: `Container mesh3d trả lỗi HTTP ${res.status}.` }, 502);
  const { ok, ...rest } = data;
  return json({ success: Boolean(ok), ...rest }, res.status);
}

export const getMech = handler<{ path: string[] }>(async ({ request, params }) => {
  const route = mechPath('GET', params.path ?? []);
  if (!route) return json({ success: false, error: 'NOT_FOUND', message: 'Không có đường dẫn này.' }, 404);
  return forward('GET', route + new URL(request.url).search);
});

export const postMech = handler<{ path: string[] }>(async ({ request, params }) => {
  const route = mechPath('POST', params.path ?? []);
  if (!route) return json({ success: false, error: 'NOT_FOUND', message: 'Không có thao tác này.' }, 404);
  const body = await readJsonBody(request);
  return forward('POST', route, body && typeof body === 'object' && !Array.isArray(body) ? body : {});
});
