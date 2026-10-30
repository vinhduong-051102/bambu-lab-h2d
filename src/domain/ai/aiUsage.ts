/**
 * What each AI task cost: tokens, the price Claude Code puts on them, and how much of the Claude plan's 5-hour and
 * 7-day allowance it used.
 *
 * - AI modelling and figure jobs (cad/worker.py, mesh3d/review.py) keep Claude's whole stream in their folder
 *   (claude.jsonl): its result line(s) say the tokens and cost, and its rate_limit_event lines the plan's use before
 *   and after each call. Read from there, so jobs made before this module count too.
 * - Calls the gateway makes itself (timelapse reviews, naming a model's parts) and Studio's "AI tối ưu" (claude -p
 *   in Studio's container, which sends its result back with the proposal) are appended to a ledger, AI_USAGE_FILE.
 *
 * Cost is Claude Code's own figure at API list prices ("costBasis": "list"): on a subscription nothing is billed per
 * task, the plan's allowance is what runs out. The plan share is the rise in the allowance used during the task,
 * which also counts anything else using the same plan at that time (another job, Claude Code elsewhere).
 */
import { promises as fs } from 'fs';
import path from 'path';

export type AiFeature = 'cad' | 'figure' | 'timelapse' | 'parts' | 'studio';

export const AI_FEATURES: Record<AiFeature, string> = {
  cad: 'Thiết kế AI (mô hình CAD)',
  figure: 'Nhân vật / sửa mẫu từ ảnh',
  timelapse: 'Đánh giá timelapse',
  parts: 'Nhận diện chi tiết mẫu',
  studio: 'AI tối ưu trong Studio',
};

export interface AiTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** Part of output */
  thinking: number;
}

/** A plan window's use (0…1) at the task's first and last call, and the rise between them */
export interface PlanWindowUse {
  from: number;
  to: number;
  used: number;
  resets_at: string | null;
}

export interface AiUsageEntry {
  id: string;
  feature: AiFeature;
  title: string;
  at: string;
  models: string[];
  tokens: AiTokens;
  cost_usd: number | null;
  turns: number | null;
  duration_ms: number | null;
  ok: boolean;
  plan: { five_hour?: PlanWindowUse; seven_day?: PlanWindowUse } | null;
}

export interface AiUsageTask extends AiUsageEntry {
  total_tokens: number;
  /** Shares of the period's cost and tokens, 0…1 */
  cost_share: number | null;
  token_share: number;
}

export interface AiUsageSummary {
  since: string | null;
  totals: { runs: number; tokens: AiTokens; total_tokens: number; cost_usd: number; plan_five_hour: number; plan_seven_day: number };
  features: { feature: AiFeature; label: string; runs: number; total_tokens: number; cost_usd: number; cost_share: number | null; token_share: number }[];
  tasks: AiUsageTask[];
}

const zero = (): AiTokens => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, thinking: 0 });
const total = (t: AiTokens) => t.input + t.output + t.cache_read + t.cache_write;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

type Json = Record<string, any>;

/**
 * The usage in Claude Code's result lines (`claude -p --output-format json|stream-json`) and its rate_limit_event
 * lines' unifiedWindows, in order
 */
export function fromClaude(results: Json[], windows: Json[]): Omit<AiUsageEntry, 'id' | 'feature' | 'title' | 'at'> {
  const tokens = zero();
  const models = new Set<string>();
  let cost: number | null = null;
  let turns: number | null = null;
  let duration: number | null = null;
  let ok = results.length > 0;
  for (const r of results) {
    const perModel = r.modelUsage && typeof r.modelUsage === 'object' ? Object.entries(r.modelUsage as Record<string, Json>) : [];
    if (perModel.length) {
      for (const [model, u] of perModel) {
        models.add(model);
        tokens.input += num(u.inputTokens);
        tokens.output += num(u.outputTokens);
        tokens.cache_read += num(u.cacheReadInputTokens);
        tokens.cache_write += num(u.cacheCreationInputTokens);
        tokens.thinking += num(u.thinkingTokens);
      }
    } else if (r.usage) {
      tokens.input += num(r.usage.input_tokens);
      tokens.output += num(r.usage.output_tokens);
      tokens.cache_read += num(r.usage.cache_read_input_tokens);
      tokens.cache_write += num(r.usage.cache_creation_input_tokens);
      tokens.thinking += num(r.usage.output_tokens_details?.thinking_tokens);
    }
    if (typeof r.total_cost_usd === 'number') cost = (cost ?? 0) + r.total_cost_usd;
    if (typeof r.num_turns === 'number') turns = (turns ?? 0) + r.num_turns;
    if (typeof r.duration_ms === 'number') duration = (duration ?? 0) + r.duration_ms;
    if (r.is_error) ok = false;
  }
  return { models: [...models], tokens, cost_usd: cost, turns, duration_ms: duration, ok, plan: planUse(windows) };
}

/** How much of each plan window the calls used: the rise from the first to the last report (all of the last when the window started over in between) */
export function planUse(windows: Json[]): AiUsageEntry['plan'] {
  const out: NonNullable<AiUsageEntry['plan']> = {};
  for (const key of ['five_hour', 'seven_day'] as const) {
    const seen = windows.map((w) => w?.[key]).filter((w) => w && typeof w.utilization === 'number');
    if (!seen.length) continue;
    const first = seen[0];
    const last = seen[seen.length - 1];
    const reset = first.resetsAt !== last.resetsAt;
    out[key] = {
      from: first.utilization,
      to: last.utilization,
      used: Math.round(Math.max(0, reset ? last.utilization : last.utilization - first.utilization) * 1e4) / 1e4,
      resets_at: typeof last.resetsAt === 'number' ? new Date(last.resetsAt * 1000).toISOString() : null,
    };
  }
  return Object.keys(out).length ? out : null;
}

/** The result and rate-limit lines of a Claude Code stream (claude.jsonl) */
export function readStream(text: string): { results: Json[]; windows: Json[] } {
  const results: Json[] = [];
  const windows: Json[] = [];
  for (const line of text.split('\n')) {
    const isResult = line.includes('"type":"result"');
    const isLimit = line.includes('"rate_limit_event"');
    if (!isResult && !isLimit) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'result') results.push(event);
      else if (event.type === 'rate_limit_event' && event.rate_limit_info?.unifiedWindows) windows.push(event.rate_limit_info.unifiedWindows);
    } catch {
      // A line cut off by a run that was stopped
    }
  }
  return { results, windows };
}

async function readJson(file: string): Promise<Json | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;
const jobCache = new Map<string, { stamp: string; entry: AiUsageEntry | null }>();

/** One entry per AI modelling or figure job that ran Claude, from its claude.jsonl (kept while the file is unchanged) */
export async function jobUsage(jobsDir: string): Promise<AiUsageEntry[]> {
  const names = await fs.readdir(jobsDir).catch(() => [] as string[]);
  const entries = await Promise.all(
    names.filter((n) => JOB_ID_RE.test(n)).map(async (id) => {
      const dir = path.join(jobsDir, id);
      const stat = await fs.stat(path.join(dir, 'claude.jsonl')).catch(() => null);
      if (!stat) return null;
      const statusStat = await fs.stat(path.join(dir, 'status.json')).catch(() => null);
      const stamp = `${stat.mtimeMs}:${stat.size}:${statusStat?.mtimeMs ?? 0}`;
      const cached = jobCache.get(dir);
      if (cached?.stamp === stamp) return cached.entry;
      const { results, windows } = readStream(await fs.readFile(path.join(dir, 'claude.jsonl'), 'utf8'));
      const meta = (await readJson(path.join(dir, 'job.json'))) ?? {};
      const status = (await readJson(path.join(dir, 'status.json'))) ?? {};
      const entry: AiUsageEntry | null =
        results.length || windows.length
          ? {
              id,
              feature: meta.source === 'mesh' ? 'figure' : 'cad',
              title: String(status.result?.title || meta.title || meta.prompt || id).slice(0, 120),
              at: status.started_at || meta.created_at || new Date(stat.mtimeMs).toISOString(),
              ...fromClaude(results, windows),
            }
          : null;
      if (entry && !results.length) entry.ok = false;
      jobCache.set(dir, { stamp, entry });
      return entry;
    })
  );
  return entries.filter((e): e is AiUsageEntry => e !== null);
}

let ledgerOverride: string | null = null;

/** Tests keep their own ledger; null restores AI_USAGE_FILE */
export function setAiUsageFile(file: string | null): void {
  ledgerOverride = file;
}

export const ledgerFile = () => path.resolve(ledgerOverride ?? process.env.AI_USAGE_FILE ?? './data/ai/usage.jsonl');

/** Adds a task to the ledger; never fails the task it describes */
export async function recordAiUsage(entry: AiUsageEntry): Promise<void> {
  try {
    const file = ledgerFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(entry) + '\n');
  } catch {
    // Statistics only
  }
}

/** The ledger entry for one Claude Code call (`--output-format json` result, and the stream's limit reports when there are any) */
export function claudeEntry(feature: AiFeature, title: string, result: Json | null, windows: Json[] = [], at = new Date()): AiUsageEntry {
  return {
    id: `${feature}-${at.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    feature,
    title: title.slice(0, 120),
    at: at.toISOString(),
    ...fromClaude(result ? [result] : [], windows),
  };
}

export async function ledgerUsage(): Promise<AiUsageEntry[]> {
  const text = await fs.readFile(ledgerFile(), 'utf8').catch(() => '');
  const out: AiUsageEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A half-written line
    }
  }
  return out;
}

/** Every task since `since` (all when null), newest first, with its share of the period, and totals per feature */
export function summarize(entries: AiUsageEntry[], since: Date | null): AiUsageSummary {
  const picked = entries.filter((e) => !since || Date.parse(e.at) >= since.getTime()).sort((a, b) => b.at.localeCompare(a.at));
  const tokens = zero();
  let cost = 0;
  let five = 0;
  let seven = 0;
  for (const e of picked) {
    for (const k of Object.keys(tokens) as (keyof AiTokens)[]) tokens[k] += e.tokens[k];
    cost += e.cost_usd ?? 0;
    five += e.plan?.five_hour?.used ?? 0;
    seven += e.plan?.seven_day?.used ?? 0;
  }
  const all = total(tokens);
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
  const features = (Object.keys(AI_FEATURES) as AiFeature[])
    .map((feature) => {
      const mine = picked.filter((e) => e.feature === feature);
      const t = mine.reduce((s, e) => s + total(e.tokens), 0);
      const c = mine.reduce((s, e) => s + (e.cost_usd ?? 0), 0);
      return { feature, label: AI_FEATURES[feature], runs: mine.length, total_tokens: t, cost_usd: c, cost_share: cost > 0 ? c / cost : null, token_share: share(t, all) };
    })
    .filter((f) => f.runs > 0)
    .sort((a, b) => b.cost_usd - a.cost_usd || b.total_tokens - a.total_tokens);
  return {
    since: since?.toISOString() ?? null,
    totals: { runs: picked.length, tokens, total_tokens: all, cost_usd: cost, plan_five_hour: five, plan_seven_day: seven },
    features,
    tasks: picked.map((e) => ({
      ...e,
      total_tokens: total(e.tokens),
      cost_share: e.cost_usd !== null && cost > 0 ? e.cost_usd / cost : null,
      token_share: share(total(e.tokens), all),
    })),
  };
}

/** All tasks: the AI jobs' own records and the ledger */
export async function aiUsage(jobsDir: string, since: Date | null): Promise<AiUsageSummary> {
  const [jobs, ledger] = await Promise.all([jobUsage(jobsDir), ledgerUsage()]);
  return summarize([...jobs, ...ledger], since);
}
