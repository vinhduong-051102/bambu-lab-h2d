import path from 'path';
import { env } from '../../config/env';
import { aiUsage } from '../../domain/ai/aiUsage';
import { claudeLimits } from '../../domain/ai/claudeLimits';
import { handler, json } from '../http';

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
