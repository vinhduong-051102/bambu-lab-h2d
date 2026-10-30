import { beforeEach, describe, expect, it } from 'vitest';
import { clearTasks, getTask, listTasks, retryTask, startTask } from '../src/domain/backgroundTasks';
import { dismissKey, elapsed, endedSince, visibleTasks } from '../src/ui/tasks';

const info = { kind: 'eng-check', label: 'Giá đỡ', page: 'cad' };

describe('background tasks (work that goes on when the page closes)', () => {
  beforeEach(clearTasks);

  it('answers what ends at once, and keeps how it ended', async () => {
    const { started, outcome } = await startTask('t:fast', async () => 42, { info, waitMs: 1000 });
    expect(started).toBe(true);
    expect(outcome).toEqual({ value: 42 });
    expect(getTask('t:fast')).toMatchObject({ running: false, error: null, label: 'Giá đỡ', kind: 'eng-check' });
  });

  it('runs on past the wait, once, and records its error with details', async () => {
    let finish!: () => void;
    const work = () => new Promise<{ ok: boolean }>((resolve) => (finish = () => resolve({ ok: false })));
    const first = await startTask('t:slow', work, { info, failed: (r) => (r.ok ? null : 'Hỏng'), explain: () => ['HTTP 422 · INVALID_INPUT'] });
    expect(first.outcome).toBeNull();
    expect(getTask('t:slow')).toMatchObject({ running: true, finished_at: null });
    // A second start while it runs is the same task
    expect((await startTask('t:slow', work, { info })).started).toBe(false);
    finish();
    await expect.poll(() => getTask('t:slow')?.running).toBe(false);
    expect(getTask('t:slow')).toMatchObject({ error: 'Hỏng', details: ['HTTP 422 · INVALID_INPUT'] });
  });

  it('keeps a thrown error as the message and its cause as details', async () => {
    const err = new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:8000') });
    const { outcome } = await startTask('t:throw', async () => { throw err; }, { info, waitMs: 1000 });
    expect(outcome && 'error' in outcome).toBe(true);
    expect(getTask('t:throw')).toMatchObject({ error: 'fetch failed', details: ['Nguyên nhân: connect ECONNREFUSED 127.0.0.1:8000'] });
    expect(getTask('t:none')).toBeNull();
  });

  it('runs a failed task again as it was started, and reports its progress', async () => {
    let calls = 0;
    await startTask(
      't:retry',
      async (progress) => {
        calls++;
        progress(1, 2);
        if (calls === 1) throw new Error('Lần đầu hỏng');
        progress(2, 2);
      },
      { info, waitMs: 1000 }
    );
    expect(getTask('t:retry')).toMatchObject({ error: 'Lần đầu hỏng', progress: { done: 1, total: 2 } });
    const again = await retryTask('t:retry');
    expect(again).not.toBeNull();
    await expect.poll(() => getTask('t:retry')?.running).toBe(false);
    expect(getTask('t:retry')).toMatchObject({ error: null, progress: { done: 2, total: 2 } });
    expect(calls).toBe(2);
    expect(listTasks().map((t) => t.key)).toEqual(['t:retry']);
    expect(await retryTask('t:missing')).toBeNull();
  });
});

describe('task panel helpers', () => {
  const task = (key: string, state: string, finished_at: string | null = null) => ({ key, state, started_at: '2026-10-30T13:00:00Z', finished_at });

  it('hides a dismissed run but shows the next run of the same task', () => {
    const failed = task('cad:1', 'failed', '2026-10-30T13:20:00Z');
    const dismissed = new Set([dismissKey(failed)]);
    expect(visibleTasks([failed, task('cad:2', 'running')], dismissed).map((t: { key: string }) => t.key)).toEqual(['cad:2']);
    expect(visibleTasks([task('cad:1', 'failed', '2026-10-30T14:00:00Z')], dismissed)).toHaveLength(1);
  });

  it('notices the tasks that ended since the last read', () => {
    const before = [task('a', 'running'), task('b', 'running'), task('c', 'failed')];
    const now = [task('a', 'done'), task('b', 'running'), task('c', 'failed')];
    expect(endedSince(before, now).map((t: { key: string }) => t.key)).toEqual(['a']);
  });

  it('says how long a task ran', () => {
    expect(elapsed('2026-10-30T13:00:00Z', '2026-10-30T13:00:42Z')).toBe('42 giây');
    expect(elapsed('2026-10-30T13:00:00Z', '2026-10-30T13:20:00Z')).toBe('20 phút');
    expect(elapsed('2026-10-30T13:00:00Z', '2026-10-30T14:05:00Z')).toBe('1 giờ 5 phút');
  });
});
