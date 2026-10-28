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
