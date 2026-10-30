/** Formatting for the AI usage statistics (system/AiUsageCard.tsx, /api/ai/usage) */

/** 1234 → "1,2k", 2001637 → "2,00M" */
export function formatTokens(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace('.', ',')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace('.', ',')}k`;
  return String(n);
}

/** 0.9965 → "$1,00", 0.0042 → "$0,004", null → "—" */
export function formatUsd(v) {
  if (v === null || v === undefined) return '—';
  const digits = v !== 0 && Math.abs(v) < 0.01 ? 3 : 2;
  return `$${v.toFixed(digits).replace('.', ',')}`;
}

/** A share 0…1 as "18,6 %"; null → "—" */
export function formatShare(v, digits = 1) {
  if (v === null || v === undefined) return '—';
  return `${(v * 100).toFixed(digits).replace('.', ',')} %`;
}

/** The rise in a plan window's use during a task: "+9 %", "<1 %" when it moved less than the 1 % the plan reports in */
export function formatPlanUse(window) {
  if (!window) return '—';
  if (window.used <= 0) return '<1 %';
  return `+${Math.round(window.used * 100)} %`;
}

/** Days of the period picker: 7, 30, 0 (all) */
export const USAGE_PERIODS = [
  { value: 7, label: '7 ngày' },
  { value: 30, label: '30 ngày' },
  { value: 0, label: 'Tất cả' },
];

// Charts (system/AiUsageCharts.tsx). The dashboard is dark: the reference palette's dark steps, validated against
// the card surface #121826 (dataviz validate_palette.js: CVD ΔE ≥ 8.4 adjacent, all ≥ 3:1). A feature keeps its
// colour whichever features the period has.
export const FEATURE_ORDER = ['cad', 'figure', 'timelapse', 'parts', 'studio'];
export const FEATURE_COLORS = { cad: '#3987e5', figure: '#d95926', timelapse: '#199e70', parts: '#c98500', studio: '#d55181' };
export const CHART_INK = { primary: '#f0efec', secondary: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', baseline: '#383835', surface: '#121826' };

const pad = (n) => String(n).padStart(2, '0');
/** The local day of a time, "2026-10-29" */
export function dayKey(time) {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Cost per day and feature, every day of the period (the last `days`, or from the first task when 0), oldest first:
 * {days: [{day, label, total, parts: {feature: usd}}], features: [those with any cost, in FEATURE_ORDER]}
 */
export function dailyCost(tasks, days, now = new Date()) {
  const first = tasks.length ? Math.min(...tasks.map((t) => Date.parse(t.at))) : now.getTime();
  const start = new Date(days > 0 ? now.getTime() - (days - 1) * 86400000 : first);
  start.setHours(0, 0, 0, 0);
  const out = [];
  for (let d = new Date(start); d <= now; d.setDate(d.getDate() + 1)) {
    out.push({ day: dayKey(d), label: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`, total: 0, parts: /** @type {Record<string, number>} */ ({}) });
  }
  const byDay = new Map(out.map((d) => [d.day, d]));
  const seen = new Set();
  for (const t of tasks) {
    const d = byDay.get(dayKey(t.at));
    if (!d || !t.cost_usd) continue;
    d.parts[t.feature] = (d.parts[t.feature] ?? 0) + t.cost_usd;
    d.total += t.cost_usd;
    seen.add(t.feature);
  }
  return { days: out, features: FEATURE_ORDER.filter((f) => seen.has(f)) };
}

/** The plan's 5-hour and 7-day use (0…1) as the tasks saw it, at each task's start and end, oldest first */
export function planTimeline(tasks) {
  const points = [];
  for (const t of tasks) {
    const five = t.plan?.five_hour;
    const seven = t.plan?.seven_day;
    if (!five && !seven) continue;
    const start = Date.parse(t.at);
    points.push({ t: start, five: five?.from ?? null, seven: seven?.from ?? null, title: t.title });
    points.push({ t: start + (t.duration_ms ?? 0), five: five?.to ?? null, seven: seven?.to ?? null, title: t.title });
  }
  return points.sort((a, b) => a.t - b.t);
}

/** The `n` tasks that cost most */
export function topTasks(tasks, n = 8) {
  return [...tasks].filter((t) => t.cost_usd).sort((a, b) => b.cost_usd - a.cost_usd).slice(0, n);
}

/** What the tokens are, with each part's share */
export function tokenParts(tokens) {
  const parts = [
    { key: 'input', label: 'Vào', value: tokens.input, color: FEATURE_COLORS.cad },
    { key: 'output', label: 'Ra (cả suy nghĩ)', value: tokens.output, color: FEATURE_COLORS.figure },
    { key: 'cache_read', label: 'Đọc cache', value: tokens.cache_read, color: FEATURE_COLORS.timelapse },
    { key: 'cache_write', label: 'Ghi cache', value: tokens.cache_write, color: FEATURE_COLORS.parts },
  ];
  const sum = parts.reduce((s, p) => s + p.value, 0);
  return parts.map((p) => ({ ...p, share: sum ? p.value / sum : 0 }));
}

/** A round axis top at or above `v`, and its ticks: 0.73 → {max: 0.8, ticks: [0, 0.2, 0.4, 0.6, 0.8]} */
export function niceScale(v, count = 4) {
  if (!(v > 0)) return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const raw = v / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const max = Number((Math.ceil(v / step - 1e-9) * step).toPrecision(12));
  const ticks = [];
  for (let k = 0; k * step <= max + step / 2; k++) ticks.push(Number((k * step).toPrecision(12)));
  return { max, ticks };
}
