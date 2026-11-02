import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { clearTasks, getTask, retryTask, setAutoRetryDelay, startTask } from '../src/domain/backgroundTasks';
import { setAnalyst } from '../src/domain/retryDoctor';
import { GUIDE_DOCTOR } from '../src/domain/cad/cadDoctors';

const info = { kind: 'cad-guide', label: 'Cánh tay robot', page: 'cad' };
const TIMED_OUT = 'Vẽ hướng dẫn lắp quá 420 giây.';

describe('running a failure a rule mends again on its own', () => {
  let asked = 0;
  beforeEach(() => {
    clearTasks();
    env.AUTO_RETRY_LIMIT = 2;
    setAutoRetryDelay(0);
    asked = 0;
    setAnalyst(async () => {
      asked++;
      return { cause: '?', tuning: {}, stop: '', hint: '' };
    });
  });
  afterEach(() => {
    env.AUTO_RETRY_LIMIT = 0;
    setAutoRetryDelay(null);
    setAnalyst(null);
  });

  it('runs it again with what the rule turns, without Claude and without "Thử lại"', async () => {
    const seen: object[] = [];
    await startTask(
      'cad-guide:1',
      async (_, tuning) => {
        seen.push(tuning);
        if (seen.length === 1) throw new Error(TIMED_OUT);
        return 'ok';
      },
      { info, waitMs: 1000, doctor: GUIDE_DOCTOR }
    );
    await expect.poll(() => getTask('cad-guide:1')?.error === null && !getTask('cad-guide:1')?.running).toBe(true);
    expect(seen).toEqual([{}, { timeout_s: 840, grid_cells: 300 }]);
    expect(getTask('cad-guide:1')).toMatchObject({ attempt: 2, auto: true, diagnosis: { by: 'rule' } });
    expect(asked).toBe(0);
  });

  it('leaves a failure no rule knows to "Thử lại", and stops after AUTO_RETRY_LIMIT in a row', async () => {
    await startTask('cad-guide:2', async () => { throw new Error('Lỗi lạ'); }, { info, waitMs: 1000, doctor: GUIDE_DOCTOR });
    await new Promise((r) => setTimeout(r, 50));
    expect(getTask('cad-guide:2')).toMatchObject({ attempt: 1, auto_retry_at: null });

    let runs = 0;
    await startTask('cad-guide:3', async () => { runs++; throw new Error(TIMED_OUT); }, { info, waitMs: 1000, doctor: GUIDE_DOCTOR });
    await expect.poll(() => runs).toBe(3);
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toBe(3);
    expect(getTask('cad-guide:3')).toMatchObject({ attempt: 3, auto: true, auto_retry_at: null });
    // "Thử lại" by hand starts the count again
    await retryTask('cad-guide:3');
    await expect.poll(() => runs).toBe(5);
    expect(asked).toBe(0);
  });

  it('does nothing on its own when AUTO_RETRY_LIMIT is 0', async () => {
    env.AUTO_RETRY_LIMIT = 0;
    let runs = 0;
    await startTask('cad-guide:4', async () => { runs++; throw new Error(TIMED_OUT); }, { info, waitMs: 1000, doctor: GUIDE_DOCTOR });
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toBe(1);
  });
});
