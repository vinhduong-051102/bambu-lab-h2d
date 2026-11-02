import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAiPlan, putAiPlan } from '../src/api/routes/ai';
import { availablePlans, defaultPlan, planProblem, setPlanFile, tokensForPlan } from '../src/domain/ai/aiPlan';
import { activePlan, planOptions } from '../src/ui/aiLimits.js';
import { setRuntime } from '../src/runtime/runtime';

const TOKENS = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FALLBACK'] as const;
const ctx = { params: Promise.resolve({}) };
const put = (plan: unknown) =>
  putAiPlan(new Request('http://localhost/api/ai/plan', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) }), ctx as never);

describe('picking the Claude subscription tasks run on', () => {
  const saved = TOKENS.map((k) => process.env[k]);
  beforeEach(() => {
    setPlanFile(join(mkdtempSync(join(tmpdir(), 'ai-plan-')), 'plan.json'));
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'one';
    process.env.CLAUDE_CODE_OAUTH_TOKEN_FALLBACK = 'two';
    setRuntime({ printerService: {} as never });
  });
  afterEach(() => {
    setPlanFile(null);
    TOKENS.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  });

  it('runs on both in turn until one is picked, then only on that one', async () => {
    expect(await defaultPlan()).toBe('auto');
    expect(tokensForPlan('auto', ['two', 'one'])).toEqual(['two', 'one']);
    expect(tokensForPlan('fallback', ['one', 'two'])).toEqual(['two']);
    expect((await put('fallback')).status).toBe(200);
    expect(await defaultPlan()).toBe('fallback');
    const body = await (await getAiPlan(new Request('http://localhost/api/ai/plan'), ctx as never)).json();
    expect(body).toMatchObject({ plan: 'fallback', plans: [{ plan: 'auto' }, { plan: 'primary', configured: true }, { plan: 'fallback', configured: true }] });
  });

  it('refuses a subscription whose token is not set, and anything that is not a plan', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FALLBACK;
    expect(planProblem('fallback')).toMatch(/CLAUDE_CODE_OAUTH_TOKEN_FALLBACK/);
    expect(availablePlans().find((p) => p.plan === 'fallback')?.configured).toBe(false);
    expect((await put('fallback')).status).toBe(400);
    expect((await put('both')).status).toBe(400);
    expect(await defaultPlan()).toBe('auto');
    // Its token gone after it was picked: tasks run on what there is
    expect(tokensForPlan('fallback', ['one'])).toEqual(['one']);
  });

  it('shows the picked one as the one in use, and offers only what is set up', () => {
    const limits = [
      { key: 'primary', configured: true, status: 'allowed' },
      { key: 'fallback', configured: true, status: 'allowed' },
    ];
    expect(activePlan(limits)).toBe('primary');
    expect(activePlan(limits, 'fallback')).toBe('fallback');
    expect(planOptions([{ plan: 'auto', label: 'x', configured: true }, { plan: 'fallback', label: 'y', configured: false }], true)).toEqual([
      { value: 'auto', label: 'Gói: tự động', disabled: false },
      { value: 'fallback', label: 'Gói 2', disabled: true },
    ]);
  });
});
