/**
 * How the Claude plans' limits read on the system page (ClaudeLimitsCard): the state of a plan and when a window
 * starts over. Plain JS so the tests import it without React.
 */

/** A plan's state in a word or two and its colour, from its limits (or why they are not known) */
export function planState(plan) {
  if (!plan?.configured) return { color: 'default', text: 'Chưa cài' };
  if (plan.error) return { color: 'error', text: 'Lỗi' };
  if (plan.status === 'rejected') return { color: 'error', text: 'Hết lượt' };
  const used = Math.max(plan.fiveHour?.utilization ?? 0, plan.sevenDay?.utilization ?? 0);
  if (plan.status === 'allowed_warning' || used >= 0.8) return { color: 'warning', text: 'Sắp hết' };
  if (plan.status === 'allowed') return { color: 'success', text: 'Dùng được' };
  return { color: 'default', text: 'Chưa rõ' };
}

/** The share used as a whole percent, or null */
export const percent = (utilization) =>
  typeof utilization === 'number' && Number.isFinite(utilization) ? Math.round(utilization * 100) : null;

/** The colour of a usage bar: green, then amber from 80 %, red when full */
export const barColor = (utilization) => (utilization >= 1 ? '#ef4444' : utilization >= 0.8 ? '#f59e0b' : '#10b981');

/** "sau 2 giờ 15 phút (03:20 29/10)": when a window starts over, from now */
export function formatReset(iso, now = Date.now()) {
  if (!iso) return '—';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  const minutes = Math.max(0, Math.round((at - now) / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const span = days ? `${days} ngày ${hours} giờ` : hours ? `${hours} giờ ${mins} phút` : `${mins} phút`;
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `sau ${span} (${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)})`;
}

/** Which plan the gateway's Claude jobs start on: the first that is configured and not out of usage */
export function activePlan(plans) {
  return (plans ?? []).find((p) => p.configured && !p.error && p.status !== 'rejected')?.key ?? null;
}
