import path from 'path';
import { env } from '../../config/env';
import { availablePlans, defaultPlan, isAiPlan, planProblem, setDefaultPlan } from '../../domain/ai/aiPlan';
import { aiUsage } from '../../domain/ai/aiUsage';
import { claudeLimits } from '../../domain/ai/claudeLimits';
import { fetchFromVault, VaultError, vaultStatus } from '../../domain/ai/keyVault';
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

// GET /api/ai/plan - The Claude subscription tasks run on unless one is given its own (auto: Gói 1, then Gói 2 once it is
// out of usage), and the ones that can be picked
export const getAiPlan = handler(async () => json({ success: true, plan: await defaultPlan(), plans: availablePlans() }));

// PUT /api/ai/plan - {plan: "auto" | "primary" | "fallback"}: picks it for every task from now on; a running one keeps its own
export const putAiPlan = handler(async ({ request }) => {
  const plan = ((await readJsonBody(request).catch(() => null)) as { plan?: unknown } | null)?.plan;
  if (!isAiPlan(plan)) return json({ success: false, error: 'INVALID_PAYLOAD', message: 'plan phải là auto, primary hoặc fallback.' }, 400);
  const problem = planProblem(plan);
  if (problem) return json({ success: false, error: 'PLAN_NOT_CONFIGURED', message: problem }, 400);
  await setDefaultPlan(plan);
  return json({ success: true, plan, plans: availablePlans() });
});

// GET /api/ai/vault - Whether the Claude tokens can be fetched from the KeyVault (KV_SERVER), the key each plan takes and
// when it was last fetched
export const getAiVault = handler(async () => json({ success: true, ...(await vaultStatus()) }));

// POST /api/ai/vault/fetch - {plan: "primary" | "fallback", otp}: fetches that plan's token from the KeyVault with a
// one-time code from Google Authenticator and puts it to use at once (the workers read it before each run)
export const postAiVaultFetch = handler(async ({ request }) => {
  const body = (await readJsonBody(request).catch(() => null)) as { plan?: unknown; otp?: unknown } | null;
  if ((body?.plan !== 'primary' && body?.plan !== 'fallback') || typeof body?.otp !== 'string') {
    return json({ success: false, error: 'INVALID_PAYLOAD', message: 'Cần plan (primary hoặc fallback) và otp.' }, 400);
  }
  try {
    return json({ success: true, plan: body.plan, ...(await fetchFromVault(body.plan, body.otp)) });
  } catch (err) {
    if (err instanceof VaultError) return json({ success: false, error: 'VAULT_FETCH_FAILED', message: err.message }, err.status);
    throw err;
  }
});
