/**
 * Which Claude subscription a task runs on: "auto" (CLAUDE_CODE_OAUTH_TOKEN, then CLAUDE_CODE_OAUTH_TOKEN_FALLBACK
 * once the first is out of usage), or only one of them ("primary", "fallback"), to keep the other's allowance for
 * something else. The dashboard picks the default for every task (AI_PLAN_FILE); an AI model or figure can be given
 * its own when it is made, kept in its job.json for the workers (cad/worker.py, mesh3d/review.py) and its retries.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { LIMIT_TOKENS } from './claudeLimits';

export type AiPlan = 'auto' | 'primary' | 'fallback';
export const AI_PLANS: AiPlan[] = ['auto', 'primary', 'fallback'];

export const isAiPlan = (value: unknown): value is AiPlan => typeof value === 'string' && (AI_PLANS as string[]).includes(value);

const tokenOf = (plan: Exclude<AiPlan, 'auto'>) => process.env[LIMIT_TOKENS.find((t) => t.key === plan)!.env]?.trim() || null;

/** The plans that can be picked: auto always, one subscription when its token is set */
export function availablePlans(): { plan: AiPlan; label: string; configured: boolean }[] {
  return [
    { plan: 'auto', label: 'Tự động (Gói 1, hết lượt thì Gói 2)', configured: true },
    ...LIMIT_TOKENS.map((t) => ({ plan: t.key as AiPlan, label: `Chỉ ${t.label}`, configured: !!tokenOf(t.key) })),
  ];
}

/** Why `plan` cannot be used now; null when it can */
export function planProblem(plan: AiPlan): string | null {
  if (plan === 'auto' || tokenOf(plan)) return null;
  const token = LIMIT_TOKENS.find((t) => t.key === plan)!;
  return `${token.label} chưa được cấu hình: đặt ${token.env} trong .env.`;
}

/**
 * The tokens a call may use, in order, for `plan`: only that subscription's, or both (`ordered`: the order "auto"
 * uses, the one out of usage last). A plan whose token is not set falls back to "auto".
 */
export function tokensForPlan(plan: AiPlan, ordered: string[]): string[] {
  if (plan === 'auto') return ordered;
  const token = tokenOf(plan);
  return token ? [token] : ordered;
}

let fileOverride: string | null = null;
/** Tests keep their own setting; null restores AI_PLAN_FILE */
export function setPlanFile(file: string | null): void {
  fileOverride = file;
}
const planFile = () => path.resolve(fileOverride ?? process.env.AI_PLAN_FILE ?? './data/ai/plan.json');

/** The plan tasks run on unless one is given its own */
export async function defaultPlan(): Promise<AiPlan> {
  try {
    const plan = JSON.parse(await fs.readFile(planFile(), 'utf8'))?.plan;
    return isAiPlan(plan) ? plan : 'auto';
  } catch {
    return 'auto';
  }
}

export async function setDefaultPlan(plan: AiPlan): Promise<void> {
  const file = planFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.part`, JSON.stringify({ plan, updated_at: new Date().toISOString() }, null, 2));
  await fs.rename(`${file}.part`, file);
}
