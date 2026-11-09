import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAiPlan, putAiPlan } from '../src/api/routes/ai';
import { availablePlans, defaultPlan, planName, planProblem, setPlanFile, tokensForPlan } from '../src/domain/ai/aiPlan';
import { activePlan, planOptions } from '../src/ui/aiLimits.js';
import { setRuntime } from '../src/runtime/runtime';
import { DEFAULT_PLANS, setPlans } from './helpers/plans';

const ctx = { params: Promise.resolve({}) };
const put = (plan: unknown) =>
  putAiPlan(new Request('http://localhost/api/ai/plan', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) }), ctx as never);

describe('picking the Claude plan tasks run on', () => {
  beforeEach(() => {
    setPlanFile(join(mkdtempSync(join(tmpdir(), 'ai-plan-')), 'plan.json'));
    setPlans([...DEFAULT_PLANS, ['k3', 'cla_three', 'sk-ant-test-three']]);
    setRuntime({ printerService: {} as never });
  });
  afterEach(() => {
    setPlanFile(null);
    setPlans(DEFAULT_PLANS);
  });

  it('runs on every plan in turn until one is picked, then only on that one', async () => {
    expect(await defaultPlan()).toBe('auto');
    expect(tokensForPlan('auto', ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
    expect(tokensForPlan('k3', ['sk-ant-test-one'])).toEqual(['sk-ant-test-three']);
    expect((await put('k3')).status).toBe(200);
    expect(await defaultPlan()).toBe('k3');
    expect(planName('k3')).toBe('cla_three');
    const body = await (await getAiPlan(new Request('http://localhost/api/ai/plan'), ctx as never)).json();
    expect(body).toMatchObject({
      plan: 'k3',
      plans: [{ plan: 'auto', configured: true }, { plan: 'k1', label: 'Chỉ cla_one' }, { plan: 'k2', label: 'Chỉ cla_two' }, { plan: 'k3', label: 'Chỉ cla_three' }],
    });
  });

  it('refuses a plan the KeyVault took back, and says when there is none at all', async () => {
    expect((await put('k3')).status).toBe(200);
    setPlans(DEFAULT_PLANS);
    expect(planProblem('k3')).toMatch(/không còn/);
    expect((await put('k3')).status).toBe(400);
    expect((await put('')).status).toBe(400);
    // Picked, then taken back: tasks run on what there is
    expect(await defaultPlan()).toBe('auto');
    expect(tokensForPlan('k3', ['sk-ant-test-one'])).toEqual(['sk-ant-test-one']);
    setPlans([]);
    expect(planProblem('auto')).toMatch(/Chưa có gói Claude/);
    expect(availablePlans()).toEqual([{ plan: 'auto', label: 'Tự động', configured: false }]);
  });

  it('shows the picked one as the one in use, and names the plans in the picker', () => {
    const limits = [
      { key: 'k1', configured: true, status: 'allowed' },
      { key: 'k2', configured: true, status: 'allowed' },
    ];
    expect(activePlan(limits)).toBe('k1');
    expect(activePlan(limits, 'k2')).toBe('k2');
    expect(planOptions([{ plan: 'auto', label: 'x', configured: true }, { plan: 'k2', label: 'Chỉ cla_two', configured: true }], true)).toEqual([
      { value: 'auto', label: 'Gói: tự động', disabled: false },
      { value: 'k2', label: 'cla_two', disabled: false },
    ]);
  });
});
