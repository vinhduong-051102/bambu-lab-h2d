/**
 * Rules learned from retries: when Claude analysed a failure no rule knew and the run after it succeeded, what the
 * failure looked like and what fixed it are kept as a rule, so the same failure next time is mended without asking
 * Claude. A rule is data, not code (RETRY_RULES_FILE, JSON): a pattern made from the error with its numbers, paths, ids
 * and quoted names left open, the task kind it belongs to, and what to do — knobs set to a value or scaled from the one
 * that failed, a hint for Claude's own work. Each use is counted: one that keeps failing turns itself off and Claude
 * is asked again. The task panel lists them, to read, switch off or delete (GET/PATCH/DELETE /api/tasks/rules).
 */
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type { Tuning } from './retryDoctor';

/** What a rule does to a knob: set it, or scale the value it failed with (more time: ×2) */
export type KnobAction = { set: number | boolean } | { scale: number };

export interface LearnedRule {
  id: string;
  /** The task kind it is for (cad-guide, eng-check, cad-model, …) */
  kind: string;
  /** A regular expression (source, matched case-insensitively) on the error and its details */
  pattern: string;
  cause: string;
  actions: Record<string, KnobAction>;
  /** For Claude's own work: what to do differently */
  hint: string | null;
  /** The error it was learned from, as it was */
  example: string;
  /** The task it was learned from */
  learned_from: string;
  created_at: string;
  updated_at: string;
  /** Retries it mended / did not */
  hits: number;
  misses: number;
  last_used_at: string | null;
  enabled: boolean;
}

/** A rule that failed this many times, more often than it worked, switches itself off */
export const MISSES_TO_DISABLE = 2;

let fileOverride: string | null = null;
/** Tests keep their own rules; null restores RETRY_RULES_FILE */
export function setRulesFile(file: string | null): void {
  fileOverride = file;
}
export const rulesFile = () => path.resolve(fileOverride ?? process.env.RETRY_RULES_FILE ?? './data/ai/retry-rules.json');

async function readRules(): Promise<LearnedRule[]> {
  try {
    const data = JSON.parse(await fs.readFile(rulesFile(), 'utf8'));
    return Array.isArray(data?.rules) ? data.rules : [];
  } catch {
    return [];
  }
}

// The custom server and the Next.js route bundles load separate copies of this module and both write the file:
// one queue on globalThis keeps their read-modify-writes apart
const globalForRules = globalThis as unknown as { __bambuRetryRulesQueue?: Promise<unknown> };

function update<T>(change: (rules: LearnedRule[]) => T): Promise<T> {
  const run = (globalForRules.__bambuRetryRulesQueue ?? Promise.resolve()).then(async () => {
    const rules = await readRules();
    const out = change(rules);
    const file = rulesFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ rules }, null, 2));
    // Windows refuses to replace a file someone is reading (a diagnosis outside this queue): a moment later it can
    for (let i = 0; ; i++) {
      try {
        await fs.rename(tmp, file);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (i >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return out;
  });
  globalForRules.__bambuRetryRulesQueue = run.catch(() => undefined);
  return run;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What changes from one run to the next in the same failure: left open in the pattern, longest first
const VARIABLE: [RegExp, string][] = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[0-9a-f-]+'],
  [/(?:[A-Za-z]:)?(?:[\\/][\w.\-]+){2,}/g, '\\S+'],
  [/"[^"\n]{1,80}"|'[^'\n]{1,80}'|“[^”\n]{1,80}”/g, '.+?'],
  [/\b[0-9a-f]{8,}\b/gi, '[0-9a-f]+'],
  [/\d+(?:[.,]\d+)?/g, '\\d+(?:[.,]\\d+)?'],
];

/**
 * A pattern for an error: its first line, the parts that differ between runs (numbers, paths, ids, quoted names) left
 * open, the rest as written. "Vẽ hướng dẫn lắp quá 420 giây." matches the same failure at 840 seconds.
 */
export function patternFor(error: string): string {
  const line = error.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const text = line.slice(0, 200);
  const marks: { at: number; end: number; re: string }[] = [];
  for (const [re, open] of VARIABLE) {
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      const end = at + m[0].length;
      if (!marks.some((k) => at < k.end && end > k.at)) marks.push({ at, end, re: open });
    }
  }
  marks.sort((a, b) => a.at - b.at);
  let out = '';
  let pos = 0;
  for (const m of marks) {
    out += escape(text.slice(pos, m.at)) + m.re;
    pos = m.end;
  }
  return out + escape(text.slice(pos));
}

function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/** The knob changes that mended it: a number scaled from the one that failed when there was one, else set */
export function actionsFor(before: Tuning, after: Tuning): Record<string, KnobAction> {
  const actions: Record<string, KnobAction> = {};
  for (const [name, value] of Object.entries(after)) {
    if (before[name] === value) continue;
    const was = before[name];
    if (typeof value === 'number' && typeof was === 'number' && was > 0) actions[name] = { scale: Math.round((value / was) * 100) / 100 };
    else actions[name] = { set: value };
  }
  return actions;
}

/** The settings a rule gives from `tuning` (not yet clamped to the knobs' bounds); `start` is a knob's value when unset */
export function applyActions(rule: LearnedRule, tuning: Tuning, start: (name: string) => number | undefined = () => undefined): Tuning {
  const out: Tuning = { ...tuning };
  for (const [name, action] of Object.entries(rule.actions)) {
    if ('set' in action) out[name] = action.set;
    else {
      const now = typeof tuning[name] === 'number' ? (tuning[name] as number) : start(name);
      if (typeof now === 'number') out[name] = Math.round(now * action.scale);
    }
  }
  return out;
}

/** The enabled rules of `kind` the failure's text matches, the most used first */
export async function matchingRules(kind: string, text: string): Promise<LearnedRule[]> {
  return (await readRules())
    .filter((r) => r.enabled && r.kind === kind && compile(r.pattern)?.test(text))
    .sort((a, b) => b.hits - a.hits || b.updated_at.localeCompare(a.updated_at));
}

export interface Lesson {
  kind: string;
  error: string;
  cause: string;
  before: Tuning;
  after: Tuning;
  hint: string | null;
  label: string;
}

/**
 * Keeps what mended a failure as a rule; the same failure of the same kind updates the rule it already has. Nothing
 * to keep when the error is empty.
 */
export async function learn(lesson: Lesson): Promise<LearnedRule | null> {
  const pattern = patternFor(lesson.error);
  if (!pattern.trim()) return null;
  const actions = actionsFor(lesson.before, lesson.after);
  const now = new Date().toISOString();
  return update((rules) => {
    const same = rules.find((r) => r.kind === lesson.kind && r.pattern === pattern);
    if (same) {
      Object.assign(same, { cause: lesson.cause, actions, hint: lesson.hint, enabled: true, misses: 0, updated_at: now });
      same.hits += 1;
      return { ...same };
    }
    const rule: LearnedRule = {
      id: randomUUID(),
      kind: lesson.kind,
      pattern,
      cause: lesson.cause,
      actions,
      hint: lesson.hint,
      example: lesson.error.slice(0, 500),
      learned_from: lesson.label,
      created_at: now,
      updated_at: now,
      hits: 1,
      misses: 0,
      last_used_at: null,
      enabled: true,
    };
    rules.push(rule);
    return { ...rule };
  });
}

/** Counts a retry a rule gave: mended or not; one that keeps failing switches itself off */
export function recordOutcome(id: string, ok: boolean): Promise<void> {
  return update((rules) => {
    const rule = rules.find((r) => r.id === id);
    if (!rule) return;
    if (ok) rule.hits += 1;
    else rule.misses += 1;
    rule.last_used_at = new Date().toISOString();
    if (rule.misses >= MISSES_TO_DISABLE && rule.misses > rule.hits) rule.enabled = false;
  });
}

export async function listRules(): Promise<LearnedRule[]> {
  return (await readRules()).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export class RuleError extends Error {}

/** Changes what a person may: switched on/off, the cause, the pattern (checked to be a valid expression) */
export function editRule(id: string, change: { enabled?: boolean; cause?: string; pattern?: string }): Promise<LearnedRule | null> {
  if (change.pattern !== undefined && (!change.pattern.trim() || !compile(change.pattern))) {
    return Promise.reject(new RuleError('Mẫu lỗi không phải biểu thức chính quy hợp lệ.'));
  }
  return update((rules) => {
    const rule = rules.find((r) => r.id === id);
    if (!rule) return null;
    if (typeof change.enabled === 'boolean') {
      rule.enabled = change.enabled;
      // Switched back on by hand: its misses so far no longer switch it off
      if (change.enabled) rule.misses = 0;
    }
    if (typeof change.cause === 'string' && change.cause.trim()) rule.cause = change.cause.trim();
    if (typeof change.pattern === 'string') rule.pattern = change.pattern;
    rule.updated_at = new Date().toISOString();
    return { ...rule };
  });
}

export function deleteRule(id: string): Promise<boolean> {
  return update((rules) => {
    const at = rules.findIndex((r) => r.id === id);
    if (at < 0) return false;
    rules.splice(at, 1);
    return true;
  });
}
