import { env } from '../../config/env';
import { handler, json, readJsonBody } from '../http';

/**
 * Mechanism simulation (docs/mechanical-simulation.md): Project Chrono and the Blender playback run in the mesh
 * container, whose worker keeps the mechanisms and runs; these routes pass requests through to its /sim routes,
 * the way the CAD routes reach the CAD worker. Answers (JSON, or a result file) come back as the worker sent them.
 */

// The worker answers at once: runs and playback go on in the background
const TIMEOUT_MS = 30000;
const PARTS = new Set(['joints', 'actuators', 'forces']);
const ID_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;
const FILE_RE = /^[a-z0-9_.-]{1,64}$/i;

let workerUrlOverride: string | null = null;

/** Tests point the routes at a fake worker; null restores MESH_WORKER_URL */
export function setSimWorkerUrl(url: string | null): void {
  workerUrlOverride = url;
}

const workerUrl = (): string | null => workerUrlOverride ?? env.MESH_WORKER_URL ?? null;

const notFound = (message: string) => json({ success: false, error: 'NOT_FOUND', message }, 404);

async function forward(method: 'GET' | 'POST', route: string, body?: unknown): Promise<Response> {
  const base = workerUrl();
  if (!base) {
    return json({ success: false, error: 'SIM_DISABLED', message: 'Chưa cấu hình MESH_WORKER_URL (docker-compose.mesh3d.yml, docs/mechanical-simulation.md).' }, 501);
  }
  let res: Response;
  try {
    res = await fetch(new URL(`/sim/${route}`, base), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'không trả lời kịp' : 'không kết nối được';
    return json({ success: false, error: 'SIM_WORKER_UNREACHABLE', message: `Container mesh3d ${reason} (${base}).` }, 502);
  }
  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  if (type.startsWith('application/json')) {
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data) return json({ success: false, error: 'SIM_WORKER_ERROR', message: `Container mesh3d trả lỗi HTTP ${res.status}.` }, 502);
    // The worker's {ok} becomes the gateway's {success}
    const { ok, ...rest } = data;
    return json({ success: Boolean(ok), ...rest }, res.status);
  }
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
}

/** A JSON object body, or {} when there is none */
async function objectBody(request: Request): Promise<Record<string, unknown>> {
  const body = await readJsonBody(request);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** The mechanism format and rules for the agent (mesh3d/sim/guide.md), as Markdown */
export const getSimGuide = handler(async () => forward('GET', 'guide'));

export const listMechanisms = handler(async () => forward('GET', 'mechanisms'));

export const createMechanism = handler(async ({ request }) => forward('POST', 'mechanisms', await objectBody(request)));

export const getMechanism = handler<{ id: string }>(async ({ params }) =>
  ID_RE.test(params.id) ? forward('GET', `mechanisms/${params.id}`) : notFound('Mã cơ cấu không hợp lệ.')
);

export const addMechanismPart = handler<{ id: string; part: string }>(async ({ request, params }) => {
  if (!ID_RE.test(params.id) || !PARTS.has(params.part)) return notFound('Chỉ thêm được joints, actuators hoặc forces.');
  return forward('POST', `mechanisms/${params.id}/${params.part}`, await objectBody(request));
});

export const validateMechanism = handler(async ({ request }) => forward('POST', 'validate', await objectBody(request)));

export const listSimRuns = handler(async () => forward('GET', 'runs'));

/** The worker's runs as data (the task panel): null when the worker is off or unreachable */
export async function simRunList(): Promise<{ sim_id: string; name: string; state: string; progress?: number; created_at: string }[] | null> {
  const res = await forward('GET', 'runs');
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { runs?: unknown } | null;
  return Array.isArray(data?.runs) ? (data.runs as never) : null;
}

/** Why a run failed, from its results (the task panel) */
export async function simRunError(simId: string): Promise<string | null> {
  const res = await forward('GET', `runs/${simId}/results`);
  const data = (await res.json().catch(() => null)) as { summary?: { error?: string | null }; error?: string | null } | null;
  return data?.summary?.error ?? data?.error ?? null;
}

export const startSimRun = handler(async ({ request }) => forward('POST', 'runs', await objectBody(request)));

export const getSimRun = handler<{ id: string }>(async ({ params }) =>
  ID_RE.test(params.id) ? forward('GET', `runs/${params.id}`) : notFound('Mã mô phỏng không hợp lệ.')
);

export const getSimResults = handler<{ id: string }>(async ({ params }) =>
  ID_RE.test(params.id) ? forward('GET', `runs/${params.id}/results`) : notFound('Mã mô phỏng không hợp lệ.')
);

export const cancelSimRun = handler<{ id: string }>(async ({ params }) =>
  ID_RE.test(params.id) ? forward('POST', `runs/${params.id}/cancel`, {}) : notFound('Mã mô phỏng không hợp lệ.')
);

export const playSimRun = handler<{ id: string }>(async ({ request, params }) =>
  ID_RE.test(params.id) ? forward('POST', `runs/${params.id}/play`, await objectBody(request)) : notFound('Mã mô phỏng không hợp lệ.')
);

export const getSimFile = handler<{ id: string; name: string }>(async ({ params }) =>
  ID_RE.test(params.id) && FILE_RE.test(params.name)
    ? forward('GET', `runs/${params.id}/files/${params.name}`)
    : notFound('Không có file này.')
);

/** Blender's files: blender/playback.mp4, playback.blend, preview.png, check.json, blender.log */
export const getSimBlenderFile = handler<{ id: string; name: string }>(async ({ params }) =>
  ID_RE.test(params.id) && FILE_RE.test(params.name)
    ? forward('GET', `runs/${params.id}/files/blender/${params.name}`)
    : notFound('Không có file này.')
);
