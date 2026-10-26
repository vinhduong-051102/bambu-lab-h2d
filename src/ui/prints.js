/**
 * Print history helpers (the page itself is src/ui/prints/PrintHistoryCard.tsx): times, settings lists and
 * diffs, and how prints and the printer's timelapse videos share one list.
 */

export const STATUS_LABELS = { printing: 'Đang in', finished: 'Hoàn thành', failed: 'Lỗi', unknown: 'Không rõ' };

/** Escapes text from the API (job names, notes and preset names are typed by users) for innerHTML */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "dd/mm HH:MM" in local time, "—" when missing or unparseable */
export function formatPrintTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Labelled keys first (in the labels' order), then the rest alphabetically */
export function orderSettingKeys(keys, labels = {}) {
  const set = new Set(keys);
  const labelled = Object.keys(labels).filter((k) => set.has(k));
  const labelledSet = new Set(labelled);
  const rest = [...set].filter((k) => !labelledSet.has(k)).sort((a, b) => a.localeCompare(b));
  return [...labelled, ...rest];
}

// Settings are Bambu Studio's serialized strings; per-extruder vectors ("200,500") are compared as-is
const settingText = (value) => (value === undefined || value === null ? null : String(value));

/**
 * A print's settings as one list: the process settings, then each filament's as "filament#2:key" (the
 * same names the AI sessions use). null when Studio sent no settings.
 */
export function printSettings(setup) {
  if (!setup?.settings) return null;
  const settings = { ...setup.settings };
  (setup.filaments ?? []).forEach((filament, i) => {
    for (const [key, value] of Object.entries(filament.settings ?? {})) settings[`filament#${i + 1}:${key}`] = value;
  });
  return settings;
}

/**
 * The settings whose values differ between two prints: [{ key, label, a, b }], a/b null when the key
 * is missing on that side. Returns null when either print has no settings to compare.
 */
export function diffSettings(settingsA, settingsB, labels = {}) {
  if (!settingsA || !settingsB) return null;
  const keys = new Set([...Object.keys(settingsA), ...Object.keys(settingsB)]);
  const differing = [...keys].filter((k) => settingText(settingsA[k]) !== settingText(settingsB[k]));
  return orderSettingKeys(differing, labels).map((key) => ({
    key,
    label: labels[key] ?? null,
    a: settingText(settingsA[key]),
    b: settingText(settingsB[key]),
  }));
}

/**
 * Rows of one print's settings: only the labelled ones by default, every key with `all`, narrowed by
 * `filter` (matches key, label or value, case-insensitive).
 */
export function listSettings(settings, labels = {}, { all = false, filter = '' } = {}) {
  if (!settings) return [];
  const keys = all ? Object.keys(settings) : Object.keys(labels).filter((k) => k in settings);
  const q = filter.trim().toLowerCase();
  return orderSettingKeys(keys, labels)
    .map((key) => ({ key, label: labels[key] ?? null, value: settingText(settings[key]) ?? '' }))
    .filter((row) => !q || [row.key, row.label ?? '', row.value].some((t) => t.toLowerCase().includes(q)));
}

export function photoUrl(printId, name) {
  return `/api/prints/${encodeURIComponent(printId)}/photos/${encodeURIComponent(name)}`;
}

/**
 * The history's rows, newest first: each print with its video (or null), and the videos whose print isn't
 * in the list, placed by when they ended. Videos paired with no print are left out. A print still printing
 * counts as now.
 */
export function historyItems(prints, videos = [], now = Date.now()) {
  const ids = new Set(prints.map((p) => p.id));
  const byPrint = new Map(videos.filter((v) => v.print && ids.has(v.print.id)).map((v) => [v.print.id, v]));
  const time = (iso) => Date.parse(iso ?? '') || 0;
  const printTime = (p) => (p.ended_at ? time(p.ended_at) : p.status === 'printing' ? now : time(p.started_at));
  const items = [
    ...prints.map((print) => ({ print, video: byPrint.get(print.id) ?? null, at: printTime(print) })),
    ...videos.filter((v) => v.print && !ids.has(v.print.id)).map((video) => ({ print: null, video, at: time(video.ended_at) })),
  ];
  return items.sort((a, b) => b.at - a.at).map(({ print, video }) => ({ print, video }));
}
