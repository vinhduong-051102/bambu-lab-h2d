import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearTasks, getTask, retryTask, startTask } from '../src/domain/backgroundTasks';
import { clampTuning, diagnose, setAnalyst, type Doctor, type Tuning } from '../src/domain/retryDoctor';
import { CODE_MODEL_DOCTOR, GUIDE_DOCTOR } from '../src/domain/cad/cadDoctors';

const info = { kind: 'cad-guide', label: 'Cánh tay robot', page: 'cad' };

describe('retrying a failed task the way its failure says', () => {
  beforeEach(clearTasks);
  afterEach(() => setAnalyst(null));

  it('gives a guide that ran out of time longer and a coarser mesh, then no video, then stops', async () => {
    const timedOut = { error: 'Vẽ hướng dẫn lắp quá 420 giây.', details: [] };
    const first = await diagnose('cad-guide', GUIDE_DOCTOR, timedOut, {});
    expect(first).toMatchObject({ by: 'rule', tuning: { timeout_s: 840, grid_cells: 300 }, stop: null });
    expect(first.changes).toEqual(['Thời gian cho phép (giây): 840', 'Độ mịn lưới khi vẽ (ô trên bề rộng mô hình; ít hơn thì nhanh hơn): 300']);
    const longest = await diagnose('cad-guide', GUIDE_DOCTOR, timedOut, { timeout_s: 1800, grid_cells: 300 });
    expect(longest.tuning).toMatchObject({ video: false });
    const spent = await diagnose('cad-guide', GUIDE_DOCTOR, timedOut, { timeout_s: 1800, grid_cells: 300, video: false });
    expect(spent.stop).toMatch(/chỉnh hết mức/);
  });

  it('stops on what running again cannot mend, before the task’s own rules', async () => {
    const out = await diagnose('cad-model', CODE_MODEL_DOCTOR, { error: 'Đã hết lượt dùng Claude của gói hiện tại, thử lại sau.', details: [] }, {});
    expect(out).toMatchObject({ by: 'rule', stop: expect.stringMatching(/hồi lượt/) });
  });

  it('asks Claude about a failure no rule knows, keeping only the task’s knobs within their bounds', async () => {
    setAnalyst(async () => ({ cause: 'Lưới quá dày.', tuning: { grid_cells: 50, video: false, rm_rf: true }, stop: '', hint: '' }));
    const out = await diagnose('cad-guide', GUIDE_DOCTOR, { error: 'MemoryError', details: [] }, {});
    expect(out).toMatchObject({ by: 'claude', cause: 'Lưới quá dày.', tuning: { grid_cells: 100, video: false }, stop: null });
    expect(clampTuning(GUIDE_DOCTOR, { timeout_s: '9' })).toEqual({});
  });

  it('runs again as it was, and says so, when Claude cannot be asked', async () => {
    setAnalyst(async () => {
      throw new Error('Không tìm thấy lệnh claude');
    });
    const out = await diagnose('cad-guide', GUIDE_DOCTOR, { error: 'Lạ', details: [] }, { video: true });
    expect(out).toMatchObject({ by: 'none', tuning: { video: true }, stop: null });
    expect(out.cause).toMatch(/Không phân tích được/);
  });

  it('hands the work the settings the analysis gives, and shows the analysis', async () => {
    const seen: Tuning[] = [];
    await startTask(
      'cad-guide:1',
      async (_, tuning) => {
        seen.push(tuning);
        if (seen.length === 1) throw new Error('Vẽ hướng dẫn lắp quá 420 giây.');
        return 'ok';
      },
      { info, waitMs: 1000, doctor: GUIDE_DOCTOR }
    );
    expect(getTask('cad-guide:1')).toMatchObject({ attempt: 1, diagnosis: null, error: 'Vẽ hướng dẫn lắp quá 420 giây.' });
    await retryTask('cad-guide:1');
    await expect.poll(() => getTask('cad-guide:1')?.running).toBe(false);
    expect(seen).toEqual([{}, { timeout_s: 840, grid_cells: 300 }]);
    expect(getTask('cad-guide:1')).toMatchObject({
      attempt: 2,
      error: null,
      tuning: { timeout_s: 840, grid_cells: 300 },
      diagnosis: { by: 'rule', cause: expect.stringMatching(/không kịp/) },
    });
  });

  it('stops a failure that comes back with the same settings instead of running it a third time', async () => {
    // Nothing to turn: a container that does not answer is tried once more as it was
    const doctor: Doctor = { about: 'x', knobs: {}, rules: [] };
    let runs = 0;
    await startTask(
      'eng-check:1',
      async () => {
        runs++;
        throw new Error('Container mesh3d không kết nối được (http://mesh3d:8000).');
      },
      { info: { ...info, kind: 'eng-check' }, waitMs: 1000, doctor }
    );
    await retryTask('eng-check:1');
    await expect.poll(() => getTask('eng-check:1')?.running).toBe(false);
    expect(runs).toBe(2);
    await retryTask('eng-check:1');
    await expect.poll(() => getTask('eng-check:1')?.running).toBe(false);
    expect(runs).toBe(2);
    expect(getTask('eng-check:1')).toMatchObject({ attempt: 3, error: expect.stringMatching(/^Không chạy lại: lỗi này đã lặp lại 2 lần/) });
  });
});
