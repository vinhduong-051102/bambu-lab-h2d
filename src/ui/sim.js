/**
 * Helpers for the simulation page (SimCard): the result CSVs of a run (mesh3d/sim/chrono_run.py) as series to plot,
 * and how its state and checks read. Plain JS so the tests import it without React.
 */

export const SIM_STATES = {
  queued: { color: 'default', text: 'Đang chờ' },
  running: { color: 'processing', text: 'Đang chạy' },
  completed: { color: 'success', text: 'Xong' },
  failed: { color: 'error', text: 'Lỗi' },
  cancelled: { color: 'default', text: 'Đã hủy' },
};

export const isSimBusy = (state) => state === 'queued' || state === 'running';

/** A run's file through the gateway: name is "joint_results.csv" or "blender/playback.mp4" */
export const simFileUrl = (simId, name) => `/api/sim/runs/${encodeURIComponent(simId)}/files/${name}`;

/** CSV text (no quoted commas: the worker writes none) as rows of {column: string} */
export function parseCsv(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const head = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(head.map((key, i) => [key, cells[i] ?? '']));
  });
}

/**
 * Series per item from rows keyed by `keyColumn` ("item" in joint_results.csv, "body" in body_transforms.csv,
 * "body" in contacts.csv): {id: {t: number[], [column]: number[]}} for the numeric columns asked for. Empty cells
 * (a joint without an effort) become null, so the chart leaves a gap instead of drawing zero.
 * @returns {Record<string, Record<string, (number | null)[]>>}
 */
export function seriesBy(rows, keyColumn, columns) {
  /** @type {Record<string, Record<string, (number | null)[]>>} */
  const out = {};
  for (const row of rows) {
    const id = row[keyColumn];
    const s = (out[id] ??= { t: [], ...Object.fromEntries(columns.map((c) => [c, []])) });
    s.t.push(Number(row.t));
    for (const c of columns) s[c].push(row[c] === '' || row[c] === undefined ? null : Number(row[c]));
  }
  return out;
}

/** Joint kinds whose value is an angle (rad), shown in degrees */
const ANGULAR = new Set(['revolute', 'cylindrical', 'rotational_motor', 'rotational_spring_damper']);

/** What a joint's value, rate and effort are, with the factor from SI to the unit shown */
export function jointUnits(kind) {
  if (ANGULAR.has(kind)) {
    return {
      value: { label: 'Góc', unit: '°', scale: 180 / Math.PI },
      rate: { label: 'Tốc độ góc', unit: '°/s', scale: 180 / Math.PI },
      effort: { label: kind === 'rotational_motor' ? 'Mômen động cơ' : 'Mômen lò xo', unit: 'N·m', scale: 1 },
    };
  }
  return {
    value: { label: kind === 'spring_damper' ? 'Chiều dài' : 'Vị trí', unit: 'mm', scale: 1000 },
    rate: { label: 'Vận tốc', unit: 'mm/s', scale: 1000 },
    effort: { label: kind === 'linear_actuator' ? 'Lực động cơ' : 'Lực lò xo', unit: 'N', scale: 1 },
  };
}

/** Every `step`-th point and the last, so a long run stays a light SVG */
export function thin(xs, ys, maxPoints = 600) {
  const step = Math.max(1, Math.ceil(xs.length / maxPoints));
  const out = [];
  for (let i = 0; i < xs.length; i += step) out.push([xs[i], ys[i]]);
  if (xs.length && (xs.length - 1) % step !== 0) out.push([xs[xs.length - 1], ys[ys.length - 1]]);
  return out;
}

/** "3/4 đạt", with the failed checks' ids */
export function checksSummary(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const judged = list.filter((c) => c.passed === true || c.passed === false);
  const failed = judged.filter((c) => c.passed === false).map((c) => c.id);
  return { passed: judged.length - failed.length, total: judged.length, failed };
}

/** A number for a table: 4 significant digits, small and large ones in exponent form */
export function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  return abs >= 1e5 || abs < 1e-3 ? n.toExponential(2) : String(Number(n.toPrecision(4)));
}
