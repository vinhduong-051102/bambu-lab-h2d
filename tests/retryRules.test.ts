import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearTasks, getTask, retryTask, startTask } from '../src/domain/backgroundTasks';
import { diagnose, setAnalyst, type Doctor } from '../src/domain/retryDoctor';
import { actionsFor, deleteRule, editRule, learn, listRules, patternFor, rulesFile } from '../src/domain/retryRules';
import { setRuntime } from '../src/runtime/runtime';
import { GUIDE_DOCTOR } from '../src/domain/cad/cadDoctors';
import { describeActions } from '../src/ui/tasks';
import { deleteRetryRule, getRetryRules, patchRetryRule } from '../src/api/routes/tasks';

const ctx = { params: Promise.resolve({}) };
const call = (route: typeof getRetryRules, url: string, init?: RequestInit) => route(new Request(`http://localhost${url}`, init), ctx as never);

const info = { kind: 'cad-guide', label: 'Cánh tay robot', page: 'cad' };
const ODD = 'MemoryError: không cấp được 2048 MB khi dựng lưới /app/data/cad/jobs/ab12cd34ef/mesh.stl';

/** Fails once with `error`, then works; retried once: returns how many times Claude was asked */
async function failOnceThenRetry(key: string, error: string) {
  let runs = 0;
  await startTask(
    key,
    async () => {
      if (++runs === 1) throw new Error(error);
      return 'ok';
    },
    { info, waitMs: 1000, doctor: GUIDE_DOCTOR }
  );
  await retryTask(key);
  await expect.poll(() => getTask(key)?.running).toBe(false);
  return getTask(key)!;
}

describe('rules learned from retries', () => {
  let asked = 0;
  beforeEach(() => {
    clearTasks();
    rmSync(rulesFile(), { force: true });
    asked = 0;
    setAnalyst(async () => {
      asked++;
      return { cause: 'Lưới quá dày cho bộ nhớ.', tuning: { grid_cells: 200 }, stop: '', hint: '' };
    });
  });
  afterEach(() => setAnalyst(null));

  it('leaves what differs between runs open in the pattern', () => {
    const pattern = patternFor(ODD);
    const re = new RegExp(pattern, 'i');
    expect(re.test(ODD)).toBe(true);
    expect(re.test('MemoryError: không cấp được 512 MB khi dựng lưới /app/data/cad/jobs/ffff0000aa/mesh.stl')).toBe(true);
    expect(re.test('MemoryError: hết đĩa')).toBe(false);
    expect(new RegExp(patternFor('Vẽ "Cánh tay" quá 420 giây.')).test('Vẽ "Bánh răng" quá 840 giây.')).toBe(true);
  });

  it('keeps what Claude found once the run after it worked, and mends the same failure next time without Claude', async () => {
    const first = await failOnceThenRetry('cad-guide:1', ODD);
    expect(first).toMatchObject({ error: null, diagnosis: { by: 'claude' } });
    await expect.poll(async () => (await listRules()).length).toBe(1);
    const [rule] = await listRules();
    expect(rule).toMatchObject({ kind: 'cad-guide', cause: 'Lưới quá dày cho bộ nhớ.', actions: { grid_cells: { set: 200 } }, hits: 1, enabled: true });

    const second = await failOnceThenRetry('cad-guide:2', ODD.replace('2048', '4096').replace('ab12cd34ef', '99aa88bb77'));
    expect(asked).toBe(1);
    expect(second).toMatchObject({ error: null, tuning: { grid_cells: 200 }, diagnosis: { by: 'learned', rule_id: rule.id } });
    await expect.poll(async () => (await listRules())[0].hits).toBe(2);
  });

  it('does not learn from a retry that failed, nor for another kind of task', async () => {
    let runs = 0;
    await startTask('cad-guide:3', async () => { runs++; throw new Error(ODD); }, { info, waitMs: 1000, doctor: GUIDE_DOCTOR });
    await retryTask('cad-guide:3');
    await expect.poll(() => getTask('cad-guide:3')?.running).toBe(false);
    expect(runs).toBe(2);
    expect(await listRules()).toEqual([]);

    await failOnceThenRetry('cad-guide:4', ODD);
    await expect.poll(async () => (await listRules()).length).toBe(1);
    const other: Doctor = { about: 'x', knobs: { grid_cells: { type: 'number', min: 100, max: 1000, describe: 'Lưới' } }, rules: [] };
    expect((await diagnose('eng-check', other, { error: ODD, details: [] }, {})).by).toBe('claude');
  });

  it('switches off a rule that keeps failing, and Claude is asked again', async () => {
    await failOnceThenRetry('cad-guide:5', ODD);
    await expect.poll(async () => (await listRules()).length).toBe(1);
    for (const key of ['cad-guide:6', 'cad-guide:7']) {
      await startTask(key, async () => { throw new Error(ODD); }, { info, waitMs: 1000, doctor: GUIDE_DOCTOR });
      await retryTask(key);
      await expect.poll(() => getTask(key)?.running).toBe(false);
      expect(getTask(key)?.diagnosis).toMatchObject({ by: 'learned' });
    }
    await expect.poll(async () => (await listRules())[0]).toMatchObject({ misses: 2, hits: 1, enabled: false });
    expect((await diagnose('cad-guide', GUIDE_DOCTOR, { error: ODD, details: [] }, {})).by).toBe('claude');
  });

  it('scales a number from the value that failed, from the knob’s default when unset, and leaves it to Claude when spent', async () => {
    expect(actionsFor({ timeout_s: 840 }, { timeout_s: 1680, video: false })).toEqual({ timeout_s: { scale: 2 }, video: { set: false } });
    expect(describeActions({ timeout_s: { scale: 2 }, video: { set: false } })).toBe('timeout_s ×2; video: tắt');
    await learn({ kind: 'cad-guide', error: 'Lạ: treo ở bước 3', cause: 'Chậm.', before: { timeout_s: 840 }, after: { timeout_s: 1680 }, hint: null, label: 'x' });
    const fresh = await diagnose('cad-guide', GUIDE_DOCTOR, { error: 'Lạ: treo ở bước 7', details: [] }, {});
    expect(fresh).toMatchObject({ by: 'learned', tuning: { timeout_s: 840 } });
    const spent = await diagnose('cad-guide', GUIDE_DOCTOR, { error: 'Lạ: treo ở bước 7', details: [] }, { timeout_s: 1800 });
    expect(spent.by).toBe('claude');
  });

  it('lists, switches off, corrects and deletes rules over the API', async () => {
    setRuntime({ printerService: {} as never });
    await failOnceThenRetry('cad-guide:9', ODD);
    await expect.poll(async () => (await listRules()).length).toBe(1);
    const list = await call(getRetryRules, '/api/tasks/rules');
    const { rules } = (await list.json()) as { rules: { id: string }[] };
    const id = rules[0].id;
    const off = await call(patchRetryRule, `/api/tasks/rules?id=${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }), headers: { 'Content-Type': 'application/json' } });
    expect(off.status).toBe(200);
    expect((await listRules())[0].enabled).toBe(false);
    const bad = await call(patchRetryRule, `/api/tasks/rules?id=${id}`, { method: 'PATCH', body: JSON.stringify({ pattern: '([' }), headers: { 'Content-Type': 'application/json' } });
    expect(bad.status).toBe(400);
    await expect(editRule('nope', { enabled: true })).resolves.toBeNull();
    expect((await call(deleteRetryRule, `/api/tasks/rules?id=${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await deleteRule(id)).toBe(false);
    expect(await listRules()).toEqual([]);
  });
});
