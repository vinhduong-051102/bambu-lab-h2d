/**
 * Helpers for the design tab's "Kiểm tra kỹ thuật" (EngCheck): the print setup typed in the form as the print
 * config the mesh worker reads (mesh3d/eng/schema.py), and how the checks' statuses read. Plain JS so the tests
 * import it without React.
 */

export const ENG_STATUS = {
  PASS: { color: 'success', text: 'Đạt' },
  WARNING: { color: 'warning', text: 'Cần xem' },
  FAIL: { color: 'error', text: 'Không đạt' },
  NOT_EVALUATED: { color: 'default', text: 'Chưa đánh giá' },
};

const ORDER = { FAIL: 0, WARNING: 1, NOT_EVALUATED: 2, PASS: 3 };

/** The print setup fields of the form: key, label, unit, and whether it is a number */
export const PRINT_FIELDS = [
  { key: 'printer', label: 'Máy in', type: 'text' },
  { key: 'filament', label: 'Filament', type: 'text', placeholder: 'PLA, PETG-CF…' },
  { key: 'brand', label: 'Hãng filament', type: 'text' },
  { key: 'nozzle_mm', label: 'Đầu phun', unit: 'mm', type: 'number' },
  { key: 'layer_height_mm', label: 'Chiều cao lớp', unit: 'mm', type: 'number' },
  { key: 'walls', label: 'Số thành', type: 'number' },
  { key: 'infill_percent', label: 'Infill', unit: '%', type: 'number' },
  { key: 'overhang_limit_deg', label: 'Góc nhô không support tối đa', unit: '°', type: 'number' },
  { key: 'hole_shrink_mm', label: 'Lỗ in ra nhỏ đi (đường kính)', unit: 'mm', type: 'number', calibration: true },
  { key: 'shaft_growth_mm', label: 'Trục in ra to thêm (đường kính)', unit: 'mm', type: 'number', calibration: true },
  { key: 'xy_tolerance_mm', label: 'Sai số XY ±', unit: 'mm', type: 'number', calibration: true },
  { key: 'min_clearance_mm', label: 'Khe hở lắp quay tối thiểu', unit: 'mm', type: 'number', calibration: true },
];

/**
 * The form's values as a print config: empty fields are left out (unknown, so what needs them is not evaluated),
 * numbers parsed (a comma works as the decimal point), the tolerances marked as measured when the user says so
 */
export function printConfig(form, measured = false) {
  const out = {};
  for (const field of PRINT_FIELDS) {
    const raw = form?.[field.key];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    if (field.type === 'number') {
      const n = Number(String(raw).trim().replace(',', '.'));
      if (Number.isFinite(n)) out[field.key] = n;
    } else {
      out[field.key] = String(raw).trim();
    }
  }
  if (PRINT_FIELDS.some((f) => f.calibration && out[f.key] !== undefined)) {
    out.tolerance_source = measured ? 'calibration' : 'user';
  }
  return out;
}

/** The checks of every analysis of a check, worst first, each with the analysis it came from */
export function sortedChecks(results) {
  const all = [];
  for (const [kind, result] of Object.entries(results ?? {})) {
    for (const check of result?.checks ?? []) all.push({ ...check, kind });
  }
  return all.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
}

/** How many checks have each status */
export function statusCounts(checks) {
  const counts = { FAIL: 0, WARNING: 0, NOT_EVALUATED: 0, PASS: 0 };
  for (const c of checks ?? []) if (c.status in counts) counts[c.status] += 1;
  return counts;
}

/** A file of an analysis through the gateway */
export const engFileUrl = (analysisId, name) => `/api/eng/analyses/${encodeURIComponent(analysisId)}/files/${name}`;

/** What the user still has to give, from every analysis, without repeats */
export function missingData(results) {
  return [...new Set(Object.values(results ?? {}).flatMap((r) => r?.missing ?? []))];
}
