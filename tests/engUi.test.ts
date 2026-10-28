import { describe, expect, it } from 'vitest';
import { checkedSettings, engFileUrl, fixKind, fixLine, fixRequest, missingData, printConfig, settingsSummary, sortedChecks, statusCounts } from '../src/ui/eng.js';

describe('design tab engineering check helpers', () => {
  it('turns the form into a print config, leaving unknowns out', () => {
    const config = printConfig({ printer: ' Bambu Lab H2D ', nozzle_mm: '0,4', walls: '3', infill_percent: '', hole_shrink_mm: 'abc' });
    expect(config).toEqual({ printer: 'Bambu Lab H2D', nozzle_mm: 0.4, walls: 3 });
  });

  it('counts the gap engraved on the calibration slot on both sides', () => {
    // The slot is marked 0.2 (each side): a diametral clearance of 0.4
    expect(printConfig({ min_clearance_mm: '0.2' }).min_clearance_mm).toBe(0.4);
    expect(printConfig({ hole_shrink_mm: '0.15' }).hole_shrink_mm).toBe(0.15);
  });

  it('says where the tolerances come from only when some are given', () => {
    expect(printConfig({ hole_shrink_mm: '0.15' })).toEqual({ hole_shrink_mm: 0.15, tolerance_source: 'user' });
    expect(printConfig({ hole_shrink_mm: '0.15' }, true).tolerance_source).toBe('calibration');
    expect(printConfig({ nozzle_mm: '0.4' }, true).tolerance_source).toBeUndefined();
  });

  it('puts failures first and counts the statuses', () => {
    const results = {
      validate: { checks: [{ id: 'a', status: 'PASS' }, { id: 'b', status: 'WARNING' }], missing: ['print.walls'] },
      printability: { checks: [{ id: 'c', status: 'NOT_EVALUATED' }, { id: 'd', status: 'FAIL' }], missing: ['print.walls', 'print.nozzle_mm'] },
    };
    expect(sortedChecks(results).map((c) => c.id)).toEqual(['d', 'b', 'c', 'a']);
    expect(sortedChecks(results)[0].kind).toBe('printability');
    expect(statusCounts(sortedChecks(results))).toEqual({ FAIL: 1, WARNING: 1, NOT_EVALUATED: 1, PASS: 1 });
    expect(missingData(results)).toEqual(['print.walls', 'print.nozzle_mm']);
    expect(sortedChecks(undefined)).toEqual([]);
  });

  it('links an analysis file through the gateway', () => {
    expect(engFileUrl('a-20261028-120000-ab12', 'report.html')).toBe('/api/eng/analyses/a-20261028-120000-ab12/files/report.html');
  });
});

describe('what to do after the engineering check', () => {
  it('picks an action for each result', () => {
    expect(fixKind({ id: 'model.wall', status: 'FAIL' })).toBe('claude');
    expect(fixKind({ id: 'model.hole2.horizontal', status: 'WARNING' })).toBe('claude');
    expect(fixKind({ id: 'model.bodies', status: 'WARNING' })).toBe('split');
    expect(fixKind({ id: 'fit.bracket.hole1.arm.shaft1', status: 'FAIL', value: 0.15, limit: 0.2 })).toBe('clearance');
    expect(fixKind({ id: 'fit.bracket.hole1.arm.shaft1', status: 'NOT_EVALUATED' })).toBe('calibrate');
    expect(fixKind({ id: 'model.hole1.tolerance', status: 'NOT_EVALUATED' })).toBe('calibrate');
    // Nothing to do about a pass, or about a check no button can fix
    expect(fixKind({ id: 'model.wall', status: 'PASS' })).toBeNull();
    expect(fixKind({ id: 'strength_basis', status: 'WARNING' })).toBeNull();
  });

  it('writes the request for Claude with the numbers, the place and the print setup', () => {
    const text = fixRequest(
      [
        { id: 'model.wall', status: 'WARNING', title: 'model: độ dày thành', detail: 'Chỗ mỏng ~1 mm.', where: { thinnest_at: [[1, 2, 3]] } },
        { id: 'fit.a.hole1.b.shaft1', status: 'FAIL', title: 'Lắp ghép a.hole1 / b.shaft1', value: 0.12, limit: 0.4 },
      ],
      { nozzle_mm: 0.4, walls: 2, min_clearance_mm: 0.4 }
    );
    expect(text).toContain('Cỡ đầu phun 0.4 mm');
    expect(text).toContain('Số lớp vỏ (thành) 2');
    // The slot gap is shown as engraved: each side
    expect(text).toContain('0.2 mm mỗi bên');
    expect(text).toContain('quanh [1,2,3] mm');
    // 0.4 − 0.12 = 0.28, up to the next 0.05
    expect(text).toContain('Tăng đường kính lỗ thêm 0.30 mm');
  });

  it('reads the print setup a check used, as the form shows it', () => {
    const results = { inspect: { inputs: {} }, printability: { inputs: { print: { printer: 'Bambu Lab H2D', walls: 4, infill_percent: 40, nozzle_mm: null } } } };
    const print = checkedSettings(results);
    expect(settingsSummary(print)).toEqual([
      { key: 'printer', label: 'Máy in', value: 'Bambu Lab H2D' },
      { key: 'walls', label: 'Số lớp vỏ (thành)', value: '4' },
      { key: 'infill_percent', label: 'Độ đặc bên trong (infill)', value: '40 %' },
    ]);
    expect(checkedSettings({})).toBeNull();
  });
});

describe('the request for Claude names each place once', () => {
  it('does not repeat an area the detail already gives', () => {
    const line = fixLine({ id: 'model.overhang', status: 'WARNING', title: 'model: phần nhô', detail: 'vùng [-1, 0, 0]…[1, 2, 3] mm.', where: { min: [-1, 0, 0], max: [1, 2, 3] } });
    expect(line.match(/\[-1/g)).toHaveLength(1);
  });
});
