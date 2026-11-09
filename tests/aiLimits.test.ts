import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeLimits, parseLimitHeaders, setLimitsFetch } from '../src/domain/ai/claudeLimits';
import { activePlan, barColor, formatReset, percent, planState } from '../src/ui/aiLimits.js';
import { DEFAULT_PLANS, setPlans } from './helpers/plans';

// What Anthropic answered for a real plan (2026-10-29), organisation id shortened
const HEADERS = {
  'anthropic-organization-id': '235c7649-0000-0000-0000-000000000000',
  'anthropic-ratelimit-unified-5h-reset': '1793215200',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.52',
  'anthropic-ratelimit-unified-7d-reset': '1793782800',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.25',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-status': 'allowed',
};

describe('Claude plan limits', () => {
  let calls: { auth: string | null; body: any }[];

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    setPlans(DEFAULT_PLANS);
    setLimitsFetch(null);
  });

  /** Answers like Anthropic: each token its own headers or status */
  const answer = (byToken: Record<string, { status: number; headers?: Record<string, string>; body?: unknown }>) =>
    setLimitsFetch((async (_url: any, init: any) => {
      const auth = new Headers(init.headers).get('authorization');
      calls.push({ auth, body: JSON.parse(init.body) });
      const r = byToken[(auth ?? '').replace('Bearer ', '')];
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
    }) as typeof fetch);

  it('reads the 5-hour and 7-day windows from the headers', () => {
    const limits = parseLimitHeaders(new Headers(HEADERS));
    expect(limits).toEqual({
      organization: '235c7649…',
      status: 'allowed',
      fiveHour: { utilization: 0.52, resetsAt: new Date(1793215200 * 1000).toISOString(), status: 'allowed' },
      sevenDay: { utilization: 0.25, resetsAt: new Date(1793782800 * 1000).toISOString(), status: 'allowed' },
      limitedBy: 'five_hour',
      overage: 'rejected',
    });
  });

  it('checks every plan with the smallest call, never returns a token, and keeps the answer', async () => {
    setPlans([
      ['k1', 'cla_one', 'tok-one'],
      ['k2', 'cla_two', 'tok-two'],
    ]);
    answer({
      'tok-one': { status: 200, headers: HEADERS },
      'tok-two': { status: 429, headers: { ...HEADERS, 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-5h-utilization': '1.0' } },
    });
    const first = await claudeLimits(true);
    expect(calls.map((c) => c.auth)).toEqual(['Bearer tok-one', 'Bearer tok-two']);
    expect(calls[0].body.max_tokens).toBe(1);
    expect(first.plans.map((p) => [p.key, p.status, p.fiveHour.utilization, p.error])).toEqual([
      ['k1', 'allowed', 0.52, null],
      // Out of usage is an answer, not an error
      ['k2', 'rejected', 1, null],
    ]);
    expect(JSON.stringify(first)).not.toContain('tok-');
    // Within 5 minutes: no new call
    const again = await claudeLimits();
    expect(again.fresh).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('says which plan is repeated or refused, and lists none when there is none', async () => {
    setPlans([['k1', 'cla_bad', 'tok-bad']]);
    answer({ 'tok-bad': { status: 401, body: { error: { message: 'Invalid bearer token' } } } });
    const { plans } = await claudeLimits(true);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ key: 'k1', label: 'cla_bad', configured: true });
    expect(plans[0].error).toContain('KeyVault');
    expect(plans[0].error).toContain('Invalid bearer token');

    setPlans([]);
    expect((await claudeLimits(true)).plans).toEqual([]);

    setPlans([
      ['k1', 'cla_one', 'tok-one'],
      ['k2', 'cla_same', 'tok-one'],
    ]);
    answer({ 'tok-one': { status: 200, headers: HEADERS } });
    const twin = await claudeLimits(true);
    expect(twin.plans[1].error).toContain('Trùng token với gói cla_one');
    expect(calls.filter((c) => c.auth === 'Bearer tok-one')).toHaveLength(1);
  });
});

describe('Claude plans on the system page', () => {
  const plan = (over: object) => ({ configured: true, error: null, status: 'allowed', fiveHour: { utilization: 0.3 }, sevenDay: { utilization: 0.2 }, ...over });

  it('names a plan\'s state', () => {
    expect(planState(plan({}))).toEqual({ color: 'success', text: 'Dùng được' });
    expect(planState(plan({ sevenDay: { utilization: 0.85 } })).text).toBe('Sắp hết');
    expect(planState(plan({ status: 'rejected' })).text).toBe('Hết lượt');
    expect(planState(plan({ error: 'x' })).text).toBe('Lỗi');
    expect(planState({ configured: false }).text).toBe('Chưa cài');
  });

  it('shows usage and when it starts over', () => {
    expect(percent(0.523)).toBe(52);
    expect(percent(null)).toBeNull();
    expect(barColor(0.5)).toBe('#10b981');
    expect(barColor(0.85)).toBe('#f59e0b');
    expect(barColor(1)).toBe('#ef4444');
    const now = Date.parse('2026-10-29T01:00:00Z');
    expect(formatReset('2026-10-29T03:15:00Z', now)).toMatch(/^sau 2 giờ 15 phút \(/);
    expect(formatReset('2026-11-01T05:00:00Z', now)).toMatch(/^sau 3 ngày 4 giờ/);
    expect(formatReset(null, now)).toBe('—');
  });

  it('knows which plan the jobs start on', () => {
    expect(activePlan([{ key: 'primary', ...plan({ status: 'rejected' }) }, { key: 'fallback', ...plan({}) }])).toBe('fallback');
    expect(activePlan([{ key: 'primary', ...plan({}) }, { key: 'fallback', ...plan({}) }])).toBe('primary');
    expect(activePlan([])).toBeNull();
  });
});
