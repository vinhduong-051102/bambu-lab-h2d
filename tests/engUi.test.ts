import { describe, expect, it } from 'vitest';
import { engFileUrl, missingData, printConfig, sortedChecks, statusCounts } from '../src/ui/eng.js';

describe('design tab engineering check helpers', () => {
  it('turns the form into a print config, leaving unknowns out', () => {
    const config = printConfig({ printer: ' Bambu Lab H2D ', nozzle_mm: '0,4', walls: '3', infill_percent: '', hole_shrink_mm: 'abc' });
    expect(config).toEqual({ printer: 'Bambu Lab H2D', nozzle_mm: 0.4, walls: 3 });
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
