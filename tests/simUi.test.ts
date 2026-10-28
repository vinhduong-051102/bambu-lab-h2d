import { describe, expect, it } from 'vitest';
import { checksSummary, formatNumber, isSimBusy, jointUnits, parseCsv, seriesBy, simFileUrl, thin } from '../src/ui/sim.js';

const CSV = `t,item,kind,value,rate,effort,fx,fy,fz,tx,ty,tz,violation
0,bearing,revolute,0,0,,0,0,1,0,0,0,0
0,motor,rotational_motor,0,0,0.5,0,0,0,0,0,0,0
0.01,bearing,revolute,0.0628,6.28,,0,0,1,0,0,0,0
0.01,motor,rotational_motor,0.0628,6.28,0.25,0,0,0,0,0,0,0
`;

describe('simulation page helpers', () => {
  it('reads a run CSV into series per joint, a missing effort as a gap', () => {
    const series = seriesBy(parseCsv(CSV), 'item', ['value', 'effort']);
    expect(Object.keys(series)).toEqual(['bearing', 'motor']);
    expect(series.motor.t).toEqual([0, 0.01]);
    expect(series.motor.effort).toEqual([0.5, 0.25]);
    expect(series.bearing.effort).toEqual([null, null]);
    expect(series.bearing.value).toEqual([0, 0.0628]);
  });

  it('shows angles in degrees and positions in millimetres', () => {
    expect(jointUnits('revolute').value.unit).toBe('°');
    expect(jointUnits('revolute').value.scale).toBeCloseTo(180 / Math.PI);
    expect(jointUnits('rotational_motor').effort.unit).toBe('N·m');
    expect(jointUnits('prismatic').value).toMatchObject({ unit: 'mm', scale: 1000 });
    expect(jointUnits('linear_actuator').effort.unit).toBe('N');
  });

  it('thins long series but keeps the last point', () => {
    const xs = Array.from({ length: 1001 }, (_, i) => i);
    const points = thin(xs, xs, 100);
    expect(points.length).toBeLessThanOrEqual(102);
    expect(points[0]).toEqual([0, 0]);
    expect(points[points.length - 1]).toEqual([1000, 1000]);
    expect(thin([0, 1], [5, 6])).toEqual([[0, 5], [1, 6]]);
  });

  it('counts the checks that were judged', () => {
    const checks = [
      { id: 'finite', passed: true },
      { id: 'mesh.ratio', passed: false },
      { id: 'still', passed: null },
    ];
    expect(checksSummary(checks)).toEqual({ passed: 1, total: 2, failed: ['mesh.ratio'] });
    expect(checksSummary(undefined)).toEqual({ passed: 0, total: 0, failed: [] });
  });

  it('formats numbers and file URLs', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(12.34567)).toBe('12.35');
    expect(formatNumber(0.00012)).toBe('1.20e-4');
    expect(formatNumber(null)).toBe('—');
    expect(simFileUrl('s-20261028-130000-a5e3', 'blender/playback.mp4')).toBe('/api/sim/runs/s-20261028-130000-a5e3/files/blender/playback.mp4');
    expect(isSimBusy('running')).toBe(true);
    expect(isSimBusy('completed')).toBe(false);
  });
});
