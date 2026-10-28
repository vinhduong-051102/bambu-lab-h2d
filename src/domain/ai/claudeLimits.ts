/**
 * How much of each Claude subscription the project uses is left: CLAUDE_CODE_OAUTH_TOKEN and
 * CLAUDE_CODE_OAUTH_TOKEN_FALLBACK (two plans, possibly of two organisations), the tokens `claude setup-token` makes.
 *
 * Those tokens may only call the model: Anthropic's usage endpoint (/api/oauth/usage, what Claude Code's /usage
 * reads) wants the user:profile scope they lack. Every model call, though, answers with the plan's limits in its
 * headers (anthropic-ratelimit-unified-*): the share of the 5-hour and the 7-day allowance used, when each resets,
 * and whether calls are allowed. So each check is the smallest call there is (one token of Haiku), which uses a
 * sliver of the plan; results are kept for CACHE_MS. The tokens never leave this module.
 */

export const LIMIT_TOKENS = [
  { key: 'primary', env: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Gói 1 (chính)' },
  { key: 'fallback', env: 'CLAUDE_CODE_OAUTH_TOKEN_FALLBACK', label: 'Gói 2 (dự phòng)' },
] as const;

const API_URL = 'https://api.anthropic.com/v1/messages';
// The cheapest model: the check reads headers, not the answer
const PROBE_MODEL = 'claude-haiku-5-5';
const CACHE_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 20000;

export interface LimitWindow {
  /** Share of the allowance used, 0…1 */
  utilization: number | null;
  /** ISO time it starts over */
  resetsAt: string | null;
  /** "allowed", "allowed_warning" or "rejected" */
  status: string | null;
}

export interface PlanLimits {
  key: string;
  label: string;
  configured: boolean;
  /** The organisation's id, shortened: tells the two plans apart without showing the token */
  organization: string | null;
  /** Whether a call goes through now */
  status: string | null;
  fiveHour: LimitWindow;
  sevenDay: LimitWindow;
  /** Which window limits the plan now ("five_hour", "seven_day") */
  limitedBy: string | null;
  /** Usage beyond the plan (extra paid usage): "allowed" or "rejected" */
  overage: string | null;
  checkedAt: string;
  error: string | null;
}

type HeaderGetter = { get(name: string): string | null };

const number = (v: string | null) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const time = (v: string | null) => {
  const n = number(v);
  return n === null ? null : new Date(n * 1000).toISOString();
};

/** The limits from a model call's response headers */
export function parseLimitHeaders(headers: HeaderGetter): Omit<PlanLimits, 'key' | 'label' | 'configured' | 'checkedAt' | 'error'> {
  const h = (name: string) => headers.get(`anthropic-ratelimit-unified-${name}`);
  const window = (w: string): LimitWindow => ({ utilization: number(h(`${w}-utilization`)), resetsAt: time(h(`${w}-reset`)), status: h(`${w}-status`) });
  const org = headers.get('anthropic-organization-id');
  return {
    organization: org ? `${org.slice(0, 8)}…` : null,
    status: h('status'),
    fiveHour: window('5h'),
    sevenDay: window('7d'),
    limitedBy: h('representative-claim'),
    overage: h('overage-status'),
  };
}

const empty = (): LimitWindow => ({ utilization: null, resetsAt: null, status: null });

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
let cache: { at: number; plans: PlanLimits[] } | null = null;

/** Tests answer the calls themselves; null restores fetch. Clears the cache. */
export function setLimitsFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
  cache = null;
}

async function probe(token: string): Promise<Omit<PlanLimits, 'key' | 'label' | 'configured' | 'checkedAt'>> {
  let res: Response;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      // A subscription token is accepted for Claude Code's own calls
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ...parseLimitHeaders({ get: () => null }), fiveHour: empty(), sevenDay: empty(), error: `Không gọi được Anthropic: ${err instanceof Error ? err.message : String(err)}` };
  }
  const limits = parseLimitHeaders(res.headers);
  // A plan out of usage answers 429 with the same headers: that is a result, not an error
  if (res.ok || res.status === 429 || limits.status) {
    await res.body?.cancel().catch(() => undefined);
    return { ...limits, error: null };
  }
  const text = await res.text().catch(() => '');
  const message = (() => {
    try {
      return JSON.parse(text)?.error?.message as string;
    } catch {
      return text.slice(0, 200);
    }
  })();
  const reason = res.status === 401 ? 'Token không hợp lệ hoặc đã hết hạn: chạy lại claude setup-token.' : `Anthropic trả HTTP ${res.status}`;
  return { ...limits, error: `${reason}${message ? ` (${message})` : ''}` };
}

/** Both plans' limits: from the cache when it is under CACHE_MS old, unless `refresh` */
export async function claudeLimits(refresh = false): Promise<{ plans: PlanLimits[]; cachedAt: string; fresh: boolean }> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) {
    return { plans: cache.plans, cachedAt: new Date(cache.at).toISOString(), fresh: false };
  }
  const seen = new Set<string>();
  const plans = await Promise.all(
    LIMIT_TOKENS.map(async ({ key, env, label }): Promise<PlanLimits> => {
      const token = process.env[env]?.trim() ?? '';
      const checkedAt = new Date().toISOString();
      const base = { key, label, checkedAt };
      if (!token) {
        return { ...base, configured: false, organization: null, status: null, fiveHour: empty(), sevenDay: empty(), limitedBy: null, overage: null, error: null };
      }
      if (seen.has(token)) {
        return { ...base, configured: true, organization: null, status: null, fiveHour: empty(), sevenDay: empty(), limitedBy: null, overage: null, error: 'Trùng token với gói 1: hai biến đang trỏ vào cùng một gói.' };
      }
      seen.add(token);
      return { ...base, configured: true, ...(await probe(token)) };
    })
  );
  cache = { at: Date.now(), plans };
  return { plans, cachedAt: new Date(cache.at).toISOString(), fresh: true };
}
