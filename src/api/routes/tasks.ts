import { listTasks, retryTask } from '../../domain/backgroundTasks';
import { handler, json, readJsonBody } from '../http';
import { recentCadJobs } from './cad';
import { simRunError, simRunList } from './sim';

/**
 * The dashboard's task panel: everything the user waits on that goes on when the page closes, in one list. The
 * gateway's own background tasks (engineering checks, assembly guides, part analyses, simulation setups, timelapse
 * reviews, measuring the earlier prints), the AI models (CAD and mesh workers) and the recorded simulation runs. A
 * failed one says why, with details, and how to run it again (`retry_url`, POST).
 */

export interface PanelTask {
  key: string;
  kind: string;
  label: string;
  /** The dashboard tab its result is on */
  page: string | null;
  state: 'running' | 'failed' | 'done';
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  details: string[];
  progress: { done: number; total: number | null; unit?: string | null } | null;
  /** POST here runs it again; null when it cannot be run again from the panel (with `retry_hint` saying how) */
  retry_url: string | null;
  retry_hint?: string;
}

// Finished ones stay listed this long; failed ones longer, until they are run again or dismissed in the panel
const DONE_FOR_MS = 24 * 3600 * 1000;
const FAILED_FOR_MS = 3 * 24 * 3600 * 1000;
const CAD_JOBS = 40;

const recent = (at: string | null, ms: number, now: number) => !at || now - new Date(at).getTime() <= ms;

async function cadTasks(now: number): Promise<PanelTask[]> {
  const jobs = (await recentCadJobs(CAD_JOBS).catch(() => null)) ?? [];
  return jobs.flatMap((job): PanelTask[] => {
    const running = job.state === 'running' || job.state === 'queued';
    const failed = job.state === 'failed';
    if (!running && !(failed && recent(job.finished_at, FAILED_FOR_MS, now)) && !(job.state === 'done' && recent(job.finished_at, DONE_FOR_MS, now))) {
      return [];
    }
    return [
      {
        key: `cad:${job.id}`,
        kind: job.source === 'mesh' ? 'cad-figure' : 'cad-model',
        label: job.title || job.prompt.split('\n')[0].replace(/^#+\s*/, '').slice(0, 100),
        page: 'cad',
        state: running ? 'running' : failed ? 'failed' : 'done',
        started_at: job.started_at ?? job.created_at,
        finished_at: job.finished_at,
        error: job.error,
        details: job.error_details ?? [],
        progress: job.progress,
        retry_url: failed && job.retryable ? `/api/cad/jobs/${encodeURIComponent(job.id)}/retry` : null,
        ...(failed && !job.retryable && { retry_hint: 'Bản này tạo trước khi lưu thông số: dùng “Làm lại” trên thẻ mẫu để tạo bản mới.' }),
      },
    ];
  });
}

async function simTasks(now: number): Promise<PanelTask[]> {
  const runs = (await simRunList().catch(() => null)) ?? [];
  const shown = runs.filter((r) => r.state === 'queued' || r.state === 'running' || (r.state === 'failed' && recent(r.created_at, FAILED_FOR_MS, now)));
  return Promise.all(
    shown.map(async (run): Promise<PanelTask> => {
      const failed = run.state === 'failed';
      return {
        key: `sim-run:${run.sim_id}`,
        kind: 'sim-run',
        label: run.name || run.sim_id,
        page: 'sim',
        state: failed ? 'failed' : 'running',
        started_at: run.created_at,
        finished_at: null,
        error: failed ? ((await simRunError(run.sim_id).catch(() => null)) ?? 'Lần chạy lỗi.') : null,
        details: [`Mã lần chạy: ${run.sim_id}`],
        progress: !failed && typeof run.progress === 'number' ? { done: Math.round(run.progress * 100), total: 100, unit: '%' } : null,
        // A run belongs to its model's setup revision: run it from there, so the result lands on that revision
        retry_url: null,
        ...(failed && { retry_hint: 'Sửa cấu hình rồi bấm “Chạy ghi kết quả” trong ⚙️ Mô phỏng của mẫu.' }),
      };
    })
  );
}

function gatewayTasks(now: number): PanelTask[] {
  return listTasks()
    .filter((t) => t.running || recent(t.finished_at, t.error ? FAILED_FOR_MS : DONE_FOR_MS, now))
    .map((t) => ({
      key: t.key,
      kind: t.kind,
      label: t.label,
      page: t.page ?? null,
      state: t.running ? 'running' : t.error ? 'failed' : 'done',
      started_at: t.started_at,
      finished_at: t.finished_at,
      error: t.error,
      details: t.details,
      progress: t.progress,
      retry_url: !t.running && t.error ? `/api/tasks/retry?key=${encodeURIComponent(t.key)}` : null,
    }));
}

const ORDER = { running: 0, failed: 1, done: 2 } as const;

// GET /api/tasks - Running, failed and recently finished background tasks, running first
export const getTasks = handler(async () => {
  const now = Date.now();
  const [cad, sim] = await Promise.all([cadTasks(now), simTasks(now)]);
  const tasks = [...gatewayTasks(now), ...cad, ...sim].sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || (b.started_at ?? '').localeCompare(a.started_at ?? '')
  );
  return json({ success: true, tasks });
});

// POST /api/tasks/retry?key= - Runs one of the gateway's background tasks again, as it was first started
export const retryGatewayTask = handler(async ({ request }) => {
  const url = new URL(request.url);
  const body = (await readJsonBody(request).catch(() => null)) as { key?: unknown } | null;
  const key = url.searchParams.get('key') ?? (typeof body?.key === 'string' ? body.key : null);
  if (!key) return json({ success: false, error: 'INVALID_PAYLOAD', message: 'Thiếu key của tác vụ.' }, 400);
  const state = await retryTask(key);
  if (!state) return json({ success: false, error: 'TASK_NOT_RETRYABLE', message: 'Không có tác vụ này, hoặc nó đang chạy.' }, 409);
  return json({ success: true, task: { key, ...state } }, 202);
});
