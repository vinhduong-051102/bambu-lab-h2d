import { env } from '../../config/env';
import { handler, json, readJsonBody } from '../http';

/**
 * Interactive simulation (docs/interactive-physics.md): a live Project Chrono session in the sim-live container
 * (mesh3d/sim/live.py) that the dashboard's viewer and the agent act on while it runs. These routes pass requests
 * through, as /api/sim does to the mesh worker; the state stream (Server-Sent Events) is passed through as it comes.
 */

const TIMEOUT_MS = 30000;
const SESSION_RE = /^l-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;
const BODY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

let liveUrlOverride: string | null = null;

/** Tests point the routes at a fake session server; null restores SIM_LIVE_URL */
export function setSimLiveUrl(url: string | null): void {
  liveUrlOverride = url;
}

const liveUrl = (): string | null => liveUrlOverride ?? env.SIM_LIVE_URL ?? null;

const disabled = () =>
  json({ success: false, error: 'SIM_LIVE_DISABLED', message: 'Chưa cấu hình SIM_LIVE_URL (docker-compose.sim-live.yml, docs/interactive-physics.md).' }, 501);
const badSession = () => json({ success: false, error: 'SESSION_NOT_FOUND', message: 'Mã phiên tương tác không hợp lệ.' }, 404);
const unreachable = (base: string, err: unknown) => {
  const reason = err instanceof Error && err.name === 'TimeoutError' ? 'không trả lời kịp' : 'không kết nối được';
  return json({ success: false, error: 'SIM_LIVE_UNREACHABLE', message: `Container sim-live ${reason} (${base}).` }, 502);
};

async function forward(method: 'GET' | 'POST', route: string, body?: unknown): Promise<Response> {
  const base = liveUrl();
  if (!base) return disabled();
  let res: Response;
  try {
    res = await fetch(new URL(`/live${route}`, base), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return unreachable(base, err);
  }
  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  if (type.startsWith('application/json')) {
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data) return json({ success: false, error: 'SIM_LIVE_ERROR', message: `Container sim-live trả lỗi HTTP ${res.status}.` }, 502);
    const { ok, ...rest } = data;
    return json({ success: Boolean(ok), ...rest }, res.status);
  }
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
}

/** A sim-live JSON answer for another route (the mechanical model starts and finds its sessions here) */
export async function liveJson(method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await forward(method, route, body);
  const data = ((await res.json().catch(() => null)) ?? { success: false, message: `HTTP ${res.status}` }) as Record<string, unknown>;
  return { status: res.status, data };
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  const body = await readJsonBody(request);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

// GET /api/sim/live - The sessions running
export const listLiveSessions = handler(async () => forward('GET', ''));

// POST /api/sim/live - {mechanism | mechanism_id | sim_id, simulation?, paused?}: starts a session → its scene and state
export const startLiveSession = handler(async ({ request }) => forward('POST', '', await objectBody(request)));

// GET /api/sim/live/:id - The scene (bodies, geometry, joints, motors, springs) and the latest state
export const getLiveSession = handler<{ id: string }>(async ({ params }) =>
  SESSION_RE.test(params.id) ? forward('GET', `/${params.id}`) : badSession()
);

// GET /api/sim/live/:id/state - The latest state, for a caller that does not stream (the agent)
export const getLiveState = handler<{ id: string }>(async ({ params }) =>
  SESSION_RE.test(params.id) ? forward('GET', `/${params.id}/state`) : badSession()
);

// POST /api/sim/live/:id/actions - {action, ...}: pause, resume, step, reset, speed, drag, release, push, twist,
// motor, gravity, spring, teleport, select
export const actOnLiveSession = handler<{ id: string }>(async ({ request, params }) =>
  SESSION_RE.test(params.id) ? forward('POST', `/${params.id}/actions`, await objectBody(request)) : badSession()
);

// POST /api/sim/live/:id/stop - Ends the session
export const stopLiveSession = handler<{ id: string }>(async ({ params }) =>
  SESSION_RE.test(params.id) ? forward('POST', `/${params.id}/stop`, {}) : badSession()
);

// GET /api/sim/live/:id/mesh/:body - A body's mesh file, for the viewer
export const getLiveMesh = handler<{ id: string; body: string }>(async ({ params }) =>
  SESSION_RE.test(params.id) && BODY_RE.test(params.body) ? forward('GET', `/${params.id}/mesh/${params.body}`) : badSession()
);

// GET /api/sim/live/:id/stream?hz=30 - The state as Server-Sent Events, passed through while the viewer listens
export const streamLiveSession = handler<{ id: string }>(async ({ request, params }) => {
  if (!SESSION_RE.test(params.id)) return badSession();
  const base = liveUrl();
  if (!base) return disabled();
  const hz = new URL(request.url).searchParams.get('hz') ?? '30';
  let res: Response;
  try {
    // No timeout: it lasts as long as the viewer listens, and ends when it goes (the request's signal)
    res = await fetch(new URL(`/live/${params.id}/stream?hz=${encodeURIComponent(hz)}`, base), { signal: request.signal });
  } catch (err) {
    return unreachable(base, err);
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    return json({ success: false, error: data?.error ?? 'SIM_LIVE_ERROR', message: data?.message ?? `HTTP ${res.status}` }, res.status);
  }
  return new Response(res.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      // no-transform: compression would hold the events back until a buffer fills
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
});
