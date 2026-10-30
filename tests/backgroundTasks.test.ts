import { beforeEach, describe, expect, it } from 'vitest';
import { clearTasks, getTask, startTask } from '../src/domain/backgroundTasks';

describe('background tasks (work that goes on when the page closes)', () => {
  beforeEach(clearTasks);

  it('answers what ends at once, and keeps how it ended', async () => {
    const { started, outcome } = await startTask('t:fast', async () => 42, { waitMs: 1000 });
    expect(started).toBe(true);
    expect(outcome).toEqual({ value: 42 });
    expect(getTask('t:fast')).toMatchObject({ running: false, error: null });
  });

  it('runs on past the wait, once, and records its error', async () => {
    let finish!: () => void;
    const work = () => new Promise<{ ok: boolean }>((resolve) => (finish = () => resolve({ ok: false })));
    const first = await startTask('t:slow', work, { failed: (r) => (r.ok ? null : 'Hỏng') });
    expect(first.outcome).toBeNull();
    expect(getTask('t:slow')).toMatchObject({ running: true, finished_at: null });
    // A second start while it runs is the same task
    expect((await startTask('t:slow', work)).started).toBe(false);
    finish();
    await expect.poll(() => getTask('t:slow')?.running).toBe(false);
    expect(getTask('t:slow')).toMatchObject({ error: 'Hỏng' });
  });

  it('keeps a thrown error as the message', async () => {
    const { outcome } = await startTask('t:throw', async () => { throw new Error('Mất kết nối'); }, { waitMs: 1000 });
    expect(outcome && 'error' in outcome).toBe(true);
    expect(getTask('t:throw')?.error).toBe('Mất kết nối');
    expect(getTask('t:none')).toBeNull();
  });
});
