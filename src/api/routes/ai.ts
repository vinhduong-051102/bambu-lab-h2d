import path from 'path';
import { env } from '../../config/env';
import { availablePlans, defaultPlan, isAiPlan, planProblem, setDefaultPlan } from '../../domain/ai/aiPlan';
import { aiUsage } from '../../domain/ai/aiUsage';
import { claudeLimits } from '../../domain/ai/claudeLimits';
import { handler, json, readJsonBody } from '../http';

/**
 * GET /api/ai/limits[?refresh=1]: how much of each Claude subscription the project uses is left (the 5-hour and
 * 7-day allowances, when they reset, whether calls go through). Kept for 5 minutes: each check is a tiny model call.
 */
export const getClaudeLimits = handler(async ({ request }) => {
  const refresh = new URL(request.url).searchParams.get('refresh') === '1';
  return json({ success: true, ...(await claudeLimits(refresh)) });
});

/**
 * GET /api/ai/usage[?days=30]: every AI task (AI models and figures, timelapse reviews, naming a model's parts,
 * Studio's "AI tối ưu") with its tokens, its cost at API list prices, its share of the period and the rise in the
 * plan's 5-hour and 7-day use while it ran; totals per feature. days=0: everything.
 */
export const getAiUsage = handler(async ({ request }) => {
  const days = Number(new URL(request.url).searchParams.get('days') ?? 30);
  const since = Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86400000) : null;
  return json({ success: true, ...(await aiUsage(path.resolve(env.CAD_JOBS_DIR), since)) });
});

// GET /api/ai/plan - The Claude subscription tasks run on unless one is given its own (auto: the plans in turn, the next
// once one is out of usage), and the ones that can be picked
export const getAiPlan = handler(async () => json({ success: true, plan: await defaultPlan(), plans: availablePlans() }));

// PUT /api/ai/plan - {plan: "auto" | <a plan's id>}: picks it for every task from now on; a running one keeps its own
export const putAiPlan = handler(async ({ request }) => {
  const plan = ((await readJsonBody(request).catch(() => null)) as { plan?: unknown } | null)?.plan;
  if (!isAiPlan(plan)) return json({ success: false, error: 'INVALID_PAYLOAD', message: 'plan phải là auto hoặc id của một gói.' }, 400);
  const problem = planProblem(plan);
  if (problem) return json({ success: false, error: 'PLAN_NOT_CONFIGURED', message: problem }, 400);
  await setDefaultPlan(plan);
  return json({ success: true, plan, plans: availablePlans() });
});
