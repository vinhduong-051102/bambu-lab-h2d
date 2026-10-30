/**
 * Work the dashboard waits on (an engineering check, an assembly guide, a part analysis, a simulation setup, a
 * timelapse review, measuring the earlier prints) runs here, detached from the request that started it: closing the
 * page does not stop it, and whoever opens the page again reads how far it is from `getTask` and keeps watching. The
 * dashboard's task panel lists them all (`listTasks`), with why one failed and a way to run it again (`retryTask`).
 * The result itself is stored where the work stores it (the worker's files); this keeps only whether it runs, since
 * when, how far, and how it ended. Kept in memory: a gateway restart forgets them (the workers finish anyway).
 */

/** What the task panel shows of a task, and where on the dashboard its result is */
export interface TaskInfo {
  /** eng-check, cad-guide, print-parts, mech-setup, timelapse-review, parts-backfill */
  kind: string;
  /** What it is about, in the user's words: the model's or the print's name */
  label: string;
  /** The dashboard tab its result shows on (cad, sim, prints) */
  page?: string;
}

export interface TaskState extends TaskInfo {
  running: boolean;
  started_at: string;
  finished_at: string | null;
  /** Why the last run failed, until the next one starts */
  error: string | null;
  /** More about the failure (what the worker said, which field, …) or about a run that ended with problems */
  details: string[];
  /** For work made of steps (measuring every earlier print): how many are done */
  progress: { done: number; total: number } | null;
}

export interface Started<T> {
  /** false: one was already running, nothing new started */
  started: boolean;
  state: TaskState;
  /** The run's outcome when it ended within `waitMs`; null when it is still running (or none was started) */
  outcome: { value: T } | { error: unknown } | null;
}

export interface TaskOptions<T> {
  info: TaskInfo;
  /** How long the request waits for the work, so what ends at once (a refused request) is answered as before */
  waitMs?: number;
  /** Turns a value into the task's error (a worker's `ok: false`) */
  failed?: (value: T) => string | null;
  /** Details of a run that failed (or ended with problems), shown under its error */
  explain?: (value: T) => string[];
}

/** Lets work made of steps say how far it is */
export type Progress = (done: number, total: number, details?: string[]) => void;

type Entry = { state: TaskState; retry: () => Promise<Started<unknown>> };

// The custom server (server.ts) and the Next.js route bundles load separate copies of this module, and a task
// started by one route is read by another (the task panel), so the tasks live on globalThis
const globalForTasks = globalThis as unknown as { __bambuBackgroundTasks?: Map<string, Entry> };
const tasks = (globalForTasks.__bambuBackgroundTasks ??= new Map());

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A thrown error's own lines: its message's cause chain, the way Node's fetch reports a refused connection */
function errorDetails(err: unknown): string[] {
  const lines: string[] = [];
  let cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  for (let i = 0; cause && i < 3; i++) {
    lines.push(`Nguyên nhân: ${errorText(cause)}`);
    cause = cause instanceof Error ? (cause as Error & { cause?: unknown }).cause : undefined;
  }
  return lines;
}

/** The task `key` (kind:id), running or last finished; null when none has run since the gateway started */
export function getTask(key: string): TaskState | null {
  const entry = tasks.get(key);
  return entry ? { ...entry.state, details: [...entry.state.details] } : null;
}

/** Every task since the gateway started, newest first */
export function listTasks(): (TaskState & { key: string })[] {
  return [...tasks.entries()]
    .map(([key, entry]) => ({ key, ...entry.state, details: [...entry.state.details] }))
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

/**
 * Runs `work` as task `key` unless one is already running, and remembers it so it can be run again. Waits up to
 * `waitMs` for it.
 */
export async function startTask<T>(key: string, work: (progress: Progress) => Promise<T>, options: TaskOptions<T>): Promise<Started<T>> {
  const current = tasks.get(key);
  if (current?.state.running) return { started: false, state: { ...current.state }, outcome: null };
  const { info, waitMs = 0, failed, explain } = options;
  const state: TaskState = {
    ...info,
    running: true,
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    details: [],
    progress: null,
  };
  tasks.set(key, { state, retry: () => startTask(key, work, options) as Promise<Started<unknown>> });
  const progress: Progress = (done, total, details) => {
    state.progress = { done, total };
    if (details) state.details = details;
  };
  const run = (async () => {
    try {
      const value = await work(progress);
      state.error = failed?.(value) ?? null;
      if (explain) state.details = explain(value);
      return { value };
    } catch (err) {
      state.error = errorText(err);
      state.details = [...state.details, ...errorDetails(err)];
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

/** Runs task `key` again as it was first started; null when there is no such task, or it is running */
export async function retryTask(key: string): Promise<TaskState | null> {
  const entry = tasks.get(key);
  if (!entry || entry.state.running) return null;
  return (await entry.retry()).state;
}

/** Tests start from no tasks */
export function clearTasks(): void {
  tasks.clear();
}
