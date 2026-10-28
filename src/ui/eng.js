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

/** The groups of the form, in order */
export const PRINT_GROUPS = [
  { key: 'machine', title: 'Máy in và vật liệu', help: 'In bằng máy nào, loại nhựa gì.' },
  {
    key: 'settings',
    title: 'Cách in (lấy trong Bambu Studio)',
    help: 'Các thông số trong hồ sơ in của Bambu Studio, mục "Chất lượng" và "Độ bền". Không chắc thì bấm "Dùng hồ sơ chuẩn".',
  },
  {
    key: 'calibration',
    title: 'Độ chính xác của máy (đo bằng mẫu in thử)',
    help:
      'Máy in nào cũng in lỗ hơi nhỏ đi và trục hơi to ra. Muốn biết chi tiết có lắp vừa không thì in mẫu hiệu chuẩn ' +
      '(nút ở dưới), đo bằng thước kẹp rồi điền vào. Chưa đo thì để trống: phần lắp ghép sẽ ghi "chưa đánh giá", không đoán.',
  },
];

/**
 * The print setup fields: key, group, label, unit, whether it is a number, a plain explanation, the usual value,
 * values to pick from, and the picture that shows it (PrintIllustration)
 */
export const PRINT_FIELDS = [
  { key: 'printer', group: 'machine', label: 'Máy in', type: 'text', picture: 'printer', help: 'Tên máy in.', options: ['Bambu Lab H2D'] },
  {
    key: 'filament',
    group: 'machine',
    label: 'Loại nhựa (filament)',
    type: 'text',
    picture: 'spool',
    placeholder: 'PLA, PETG…',
    help: 'Ghi trên cuộn nhựa. PLA dễ in nhất; PETG dẻo và chịu nhiệt hơn; ABS/ASA chịu nhiệt, cần buồng kín.',
    options: ['PLA', 'PLA Matte', 'PETG', 'PETG-CF', 'ABS', 'ASA', 'TPU 95A', 'PA-CF'],
  },
  { key: 'brand', group: 'machine', label: 'Hãng nhựa', type: 'text', picture: 'spool', help: 'Ghi trên nhãn cuộn nhựa (Bambu, eSun…). Không bắt buộc.', options: ['Bambu Lab', 'eSun', 'Polymaker', 'Sunlu'] },
  {
    key: 'nozzle_mm',
    group: 'settings',
    label: 'Cỡ đầu phun',
    unit: 'mm',
    type: 'number',
    picture: 'nozzle',
    help: 'Lỗ đầu phun: sợi nhựa đùn ra rộng chừng ấy. Thành và lỗ nhỏ hơn 2 lần cỡ này khó in.',
    typical: 'Máy Bambu mặc định 0.4 mm (in trên đầu phun).',
    options: ['0.2', '0.4', '0.6', '0.8'],
  },
  {
    key: 'layer_height_mm',
    group: 'settings',
    label: 'Chiều cao lớp',
    unit: 'mm',
    type: 'number',
    picture: 'layers',
    help: 'Mỗi lớp nhựa dày bao nhiêu. Lớp mỏng mịn hơn nhưng in lâu hơn.',
    typical: 'Thường 0.2 mm (hồ sơ "0.20mm Standard").',
    options: ['0.08', '0.12', '0.16', '0.20', '0.24', '0.28'],
  },
  {
    key: 'walls',
    group: 'settings',
    label: 'Số lớp vỏ (thành)',
    type: 'number',
    picture: 'walls',
    help: 'Số đường nhựa chạy quanh viền mỗi lớp, tạo thành vỏ ngoài. Nhiều vỏ thì chắc hơn.',
    typical: 'Bambu Studio mặc định 2; chi tiết chịu lực thường 3–4.',
    options: ['2', '3', '4', '6'],
  },
  {
    key: 'infill_percent',
    group: 'settings',
    label: 'Độ đặc bên trong (infill)',
    unit: '%',
    type: 'number',
    picture: 'infill',
    help: 'Bên trong vỏ được in thưa hay dày. 100 % là đặc hoàn toàn.',
    typical: 'Mặc định 15 %; chi tiết chịu lực 30–50 %.',
    options: ['10', '15', '25', '40', '100'],
  },
  {
    key: 'overhang_limit_deg',
    group: 'settings',
    label: 'Phần nhô ra tối đa không cần đỡ',
    unit: '°',
    type: 'number',
    picture: 'overhang',
    help: 'Mặt nghiêng chìa ra ngoài quá góc này (so với phương thẳng đứng) phải có support đỡ bên dưới, nếu không sẽ võng.',
    typical: 'Thường khoảng 45°. Máy và quạt tốt có thể tới 55–60°.',
    options: ['40', '45', '50', '55', '60'],
  },
  {
    key: 'hole_shrink_mm',
    group: 'calibration',
    label: 'Lỗ in ra nhỏ đi',
    unit: 'mm',
    type: 'number',
    picture: 'hole',
    help: 'Vẽ lỗ 10 mm, in ra đo được 9.85 mm thì điền 0.15 (đo đường kính).',
    typical: 'Thường 0.1–0.3 mm.',
    calibration: true,
  },
  {
    key: 'shaft_growth_mm',
    group: 'calibration',
    label: 'Trục in ra to thêm',
    unit: 'mm',
    type: 'number',
    picture: 'shaft',
    help: 'Vẽ trục 10 mm, in ra đo được 10.1 mm thì điền 0.1 (đo đường kính).',
    typical: 'Thường 0–0.15 mm.',
    calibration: true,
  },
  {
    key: 'xy_tolerance_mm',
    group: 'calibration',
    label: 'Sai lệch kích thước ngoài ±',
    unit: 'mm',
    type: 'number',
    picture: 'tolerance',
    help: 'In khối 20 mm, đo các cạnh; lệch nhiều nhất bao nhiêu so với 20 thì điền bấy nhiêu.',
    typical: 'Thường ±0.05–0.1 mm.',
    calibration: true,
  },
  {
    key: 'min_clearance_mm',
    group: 'calibration',
    label: 'Khe hở nhỏ nhất mà chốt còn xoay được',
    unit: 'mm mỗi bên',
    type: 'number',
    picture: 'clearance',
    help:
      'Mẫu thử có 5 khe khắc số 0.1 … 0.5 (khe hở mỗi bên). Đẩy chốt rời vào từng khe: khe nhỏ nhất mà chốt vào hết và ' +
      'xoay được không cần ấn, điền số khắc ở khe đó.',
    typical: 'Thường 0.1–0.2 mm mỗi bên.',
    calibration: true,
    // The analysis compares diametral clearances: a gap on each side counts twice
    scale: 2,
  },
];

/**
 * Bambu Studio's own standard profile, which the user picks on purpose (it fills only what that profile says; the
 * printer's measured tolerances are never part of a preset)
 */
export const PRINT_PRESETS = [
  {
    key: 'h2d-pla-standard',
    label: 'Bambu H2D · PLA · 0.4 mm · 0.20mm Standard',
    values: { printer: 'Bambu Lab H2D', filament: 'PLA', nozzle_mm: '0.4', layer_height_mm: '0.20', walls: '2', infill_percent: '15' },
  },
  {
    key: 'h2d-pla-strong',
    label: 'Bambu H2D · PLA · 0.4 mm · chi tiết chịu lực (4 vỏ, 40 %)',
    values: { printer: 'Bambu Lab H2D', filament: 'PLA', nozzle_mm: '0.4', layer_height_mm: '0.20', walls: '4', infill_percent: '40' },
  },
  {
    key: 'h2d-petg-standard',
    label: 'Bambu H2D · PETG · 0.4 mm · 0.20mm Standard',
    values: { printer: 'Bambu Lab H2D', filament: 'PETG', nozzle_mm: '0.4', layer_height_mm: '0.20', walls: '2', infill_percent: '15' },
  },
];

/**
 * The form's values as a print config: empty fields are left out (unknown, so what needs them is not evaluated),
 * numbers parsed (a comma works as the decimal point), the tolerances marked as measured when the user says so
 */
export function printConfig(form, measured = false) {
  /** @type {Record<string, string | number>} */
  const out = {};
  for (const field of PRINT_FIELDS) {
    const raw = form?.[field.key];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    if (field.type === 'number') {
      const n = Number(String(raw).trim().replace(',', '.'));
      if (Number.isFinite(n)) out[field.key] = Math.round(n * (field.scale ?? 1) * 1e6) / 1e6;
    } else {
      out[field.key] = String(raw).trim();
    }
  }
  if (PRINT_FIELDS.some((f) => f.calibration && out[f.key] !== undefined)) {
    out.tolerance_source = measured ? 'calibration' : 'user';
  }
  return out;
}

/** The CAD job that builds the tolerance calibration print (cad/calibration.py, docs/cad.md "Hiệu chuẩn dung sai") */
export const CALIBRATION_BUILD = {
  title: 'Mẫu in hiệu chuẩn dung sai',
  code: ['from calibration import calibration_plate', 'result = calibration_plate()'].join('\n'),
};

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
