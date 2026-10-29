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
