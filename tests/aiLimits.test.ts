import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeLimits, parseLimitHeaders, setLimitsFetch } from '../src/domain/ai/claudeLimits';
import { activePlan, barColor, formatReset, percent, planState } from '../src/ui/aiLimits.js';

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

const TOKENS = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FALLBACK'] as const;

describe('Claude plan limits', () => {
  const saved: Record<string, string | undefined> = {};
  let calls: { auth: string | null; body: any }[];

  beforeEach(() => {
    for (const k of TOKENS) saved[k] = process.env[k];
    calls = [];
  });
  afterEach(() => {
    for (const k of TOKENS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
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

  it('checks both plans with the smallest call, never returns a token, and keeps the answer', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-one';
    process.env.CLAUDE_CODE_OAUTH_TOKEN_FALLBACK = 'tok-two';
    answer({
      'tok-one': { status: 200, headers: HEADERS },
      'tok-two': { status: 429, headers: { ...HEADERS, 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-5h-utilization': '1.0' } },
    });
    const first = await claudeLimits(true);
    expect(calls.map((c) => c.auth)).toEqual(['Bearer tok-one', 'Bearer tok-two']);
    expect(calls[0].body.max_tokens).toBe(1);
    expect(first.plans.map((p) => [p.key, p.status, p.fiveHour.utilization, p.error])).toEqual([
      ['primary', 'allowed', 0.52, null],
      // Out of usage is an answer, not an error
      ['fallback', 'rejected', 1, null],
    ]);
    expect(JSON.stringify(first)).not.toContain('tok-');
    // Within 5 minutes: no new call
    const again = await claudeLimits();
    expect(again.fresh).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('says which plan is missing, repeated or refused', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-bad';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FALLBACK;
    answer({ 'tok-bad': { status: 401, body: { error: { message: 'Invalid bearer token' } } } });
    const { plans } = await claudeLimits(true);
    expect(plans[0].error).toContain('claude setup-token');
    expect(plans[0].error).toContain('Invalid bearer token');
    expect(plans[1]).toMatchObject({ configured: false, error: null });

    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-one';
    process.env.CLAUDE_CODE_OAUTH_TOKEN_FALLBACK = 'tok-one';
    answer({ 'tok-one': { status: 200, headers: HEADERS } });
    const twin = await claudeLimits(true);
    expect(twin.plans[1].error).toContain('Trùng token');
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
