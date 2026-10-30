/**
 * Work the dashboard waits on (an engineering check, an assembly guide, a part analysis, a simulation setup) runs
 * here, detached from the request that started it: closing the page does not stop it, and whoever opens the page
 * again reads how far it is from `get` and keeps watching. The result itself is stored where the work stores it
 * (the worker's files); this keeps only whether it is running, since when, and the error it ended with. Kept in
 * memory: a gateway restart forgets what was running (the workers finish it anyway).
 */

export interface TaskState {
  running: boolean;
  started_at: string;
  finished_at: string | null;
  /** Why the last run failed, until the next one starts */
  error: string | null;
}

export interface Started<T> {
  /** false: one was already running, nothing new started */
  started: boolean;
  state: TaskState;
  /** The run's outcome when it ended within `waitMs`; null when it is still running (or none was started) */
  outcome: { value: T } | { error: unknown } | null;
}

// The custom server (server.ts) and the Next.js route bundles load separate copies of this module, and a task
// started by one route is read by another, so the tasks live on globalThis
const globalForTasks = globalThis as unknown as { __bambuBackgroundTasks?: Map<string, TaskState> };
const tasks = (globalForTasks.__bambuBackgroundTasks ??= new Map());

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The task `key` (kind:id), running or last finished; null when none has run since the gateway started */
export function getTask(key: string): TaskState | null {
  const task = tasks.get(key);
  return task ? { ...task } : null;
}

/**
 * Runs `work` as task `key` unless one is already running. Waits up to `waitMs` for it, so what ends at once (a
 * refused request) is answered as before; `failed` turns a value into the task's error (a worker's `ok: false`).
 */
export async function startTask<T>(
  key: string,
  work: () => Promise<T>,
  { waitMs = 0, failed }: { waitMs?: number; failed?: (value: T) => string | null } = {}
): Promise<Started<T>> {
  const current = tasks.get(key);
  if (current?.running) return { started: false, state: { ...current }, outcome: null };
  const state: TaskState = { running: true, started_at: new Date().toISOString(), finished_at: null, error: null };
  tasks.set(key, state);
  const run = (async () => {
    try {
      const value = await work();
      state.error = failed?.(value) ?? null;
      return { value };
    } catch (err) {
      state.error = errorText(err);
      return { error: err };
    } finally {
      state.running = false;
      state.finished_at = new Date().toISOString();
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([run, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), waitMs)))]);
  clearTimeout(timer);
  return { started: true, state: { ...state }, outcome };
}

/** Tests start from no tasks */
export function clearTasks(): void {
  tasks.clear();
}
