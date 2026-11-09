/**
 * Which Claude subscription a task runs on: "auto" (the plans fetched from the KeyVault in turn, the next once one is
 * out of usage), or only one of them (its KeyVault key's id), to keep the others' allowance for something else. The
 * dashboard picks the default for every task (AI_PLAN_FILE); an AI model or figure can be given its own when it is
 * made, kept in its job.json for the workers (cad/worker.py, mesh3d/review.py) and its retries.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { claudePlans } from './claudePlans';

/** "auto", or a plan's id (its key on the KeyVault) */
export type AiPlan = string;

export const isAiPlan = (value: unknown): value is AiPlan => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;

const tokenOf = (plan: AiPlan) => claudePlans().find((p) => p.id === plan)?.token.trim() || null;

/** The plans that can be picked: auto, and each plan fetched from the KeyVault */
export function availablePlans(): { plan: AiPlan; label: string; configured: boolean }[] {
  const plans = claudePlans();
  return [
    { plan: 'auto', label: plans.length > 1 ? 'Tự động (lần lượt các gói, hết lượt thì gói kế)' : 'Tự động', configured: plans.length > 0 },
    ...plans.map((p) => ({ plan: p.id, label: `Chỉ ${p.name}`, configured: true })),
  ];
}

/** A plan's name (its KeyVault key); null for auto */
export function planName(plan: AiPlan): string | null {
  return plan === 'auto' ? null : (claudePlans().find((p) => p.id === plan)?.name ?? null);
}

/** Why `plan` cannot be used now; null when it can */
export function planProblem(plan: AiPlan): string | null {
  if (!claudePlans().length) return 'Chưa có gói Claude nào: lấy token từ KeyVault (Hệ thống → KeyVault).';
  if (plan === 'auto' || tokenOf(plan)) return null;
  return 'Gói Claude này không còn (KeyVault đã thu hồi key, hoặc chưa lấy token): chọn gói khác.';
}

/**
 * The tokens a call may use, in order, for `plan`: only that subscription's, or every plan's (`ordered`: the order
 * "auto" uses, the ones out of usage last). A plan that is gone falls back to "auto".
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
    return isAiPlan(plan) && (plan === 'auto' || tokenOf(plan)) ? plan : 'auto';
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
