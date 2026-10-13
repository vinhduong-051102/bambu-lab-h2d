import { describe, it, expect } from 'vitest';
import { parseGcode, TRAVEL } from '../src/ui/gcodeToolpath';

// Positions are float32, so compare at 0.1 µm
const segmentsOf = (positions: Float32Array) => {
  const out: number[][] = [];
  for (let i = 0; i < positions.length; i += 6) {
    out.push(Array.from(positions.slice(i, i + 6), (v) => Math.round(v * 1e4) / 1e4));
  }
  return out;
};

const GCODE = [
  '; HEADER_BLOCK_START',
  '; HEADER_BLOCK_END',
  'G28',
  'G1 X0 Y0 Z0.3 F600',
  'G1 X50 Y0 E5 ; purge line, machine start G-code',
  '; MACHINE_START_GCODE_END',
  'G90',
  'M83',
  '; CHANGE_LAYER',
  '; Z_HEIGHT: 0.2',
  'G1 X10 Y10 Z0.2 F60000',
  '; FEATURE: Outer wall',
  'G1 X20 Y10 E.5',
  'G1 E-.8',
  'G1 X20 Y20',
  '; FEATURE: Inner wall',
  'G1 X10 Y20 E.4',
  '; CHANGE_LAYER',
  '; Z_HEIGHT: 0.4',
  'G1 Z.4',
  '; FEATURE: Outer wall',
  'G1 X10 Y10 E.4',
  'G21',
  '; MACHINE_END_GCODE_START',
  'G1 X300 Y300 E10 ; end G-code is not drawn',
].join('\n');

describe('G-code toolpath parser (3D preview)', () => {
  const toolpath = parseGcode(GCODE);
  const feature = (name: string) => toolpath.features.find((f) => f.name === name)!;

  it('splits layers on CHANGE_LAYER with their Z heights', () => {
    expect(toolpath.layers).toEqual([{ z: 0.2 }, { z: 0.4 }]);
  });

  it('groups extrusion by feature and moves without extrusion as travel', () => {
    expect(segmentsOf(feature('Outer wall').positions)).toEqual([
      [10, 10, 0.2, 20, 10, 0.2],
      [10, 20, 0.4, 10, 10, 0.4],
    ]);
    expect(segmentsOf(feature('Inner wall').positions)).toEqual([[20, 20, 0.2, 10, 20, 0.2]]);
    // the retraction-only line moves nowhere; the X20 Y20 move after it is travel
    expect(segmentsOf(feature(TRAVEL).positions)).toContainEqual([20, 10, 0.2, 20, 20, 0.2]);
  });

  it('records per-layer vertex ranges so the layer slider can use draw ranges', () => {
    expect(Array.from(feature('Outer wall').layerEnds)).toEqual([2, 4]);
    expect(Array.from(feature('Inner wall').layerEnds)).toEqual([2, 2]);
  });

  it('skips extrusion in machine start/end G-code and computes bounds from extrusion only', () => {
    const extruded = toolpath.features.filter((f) => f.name !== TRAVEL).flatMap((f) => segmentsOf(f.positions));
    expect(extruded.some((s) => s.includes(50) || s.includes(300))).toBe(false);
    // the real move from the end of the purge line to the first point is drawn as travel
    expect(segmentsOf(feature(TRAVEL).positions)[0]).toEqual([50, 0, 0.3, 10, 10, 0.2]);
    expect(segmentsOf(feature(TRAVEL).positions).some((s) => s.includes(300))).toBe(false);
    expect(toolpath.bounds?.min[0]).toBe(10);
    expect(toolpath.bounds?.max[0]).toBe(20);
    expect(toolpath.bounds?.max[2]).toBeCloseTo(0.4, 5);
  });

  it('tessellates G2/G3 arcs on the circle and ends exactly at the target', () => {
    const arcs = parseGcode([
      'M83',
      '; CHANGE_LAYER',
      '; Z_HEIGHT: 0.2',
      'G1 X10 Y0 Z0.2',
      '; FEATURE: Outer wall',
      'G3 X-10 Y0 I-10 J0 E1', // counter-clockwise half circle through +Y
      'G2 X10 Y0 I10 J0 E1', // clockwise half circle back, also through +Y
    ].join('\n'));
    const segs = segmentsOf(arcs.features.find((f) => f.name === 'Outer wall')!.positions);
    expect(segs.length).toBeGreaterThan(20);
    for (const [x1, y1] of segs) expect(Math.hypot(x1, y1)).toBeCloseTo(10, 3);
    expect(segs.every(([, y1, , , y2]) => y1 >= -1e-6 && y2 >= -1e-6)).toBe(true);
    const last = segs[segs.length - 1];
    expect([last[3], last[4]]).toEqual([10, 0]);
  });

  it('handles absolute extrusion (M82) and G-code without Bambu markers', () => {
    const plain = parseGcode(['G90', 'M82', 'G92 E0', 'G1 X0 Y0 Z0.2', 'G1 X5 Y0 E1', 'G1 X5 Y5 E1', 'G1 X0 Y5 E2'].join('\n'));
    expect(plain.layers).toHaveLength(1);
    expect(segmentsOf(plain.features.find((f) => f.name === 'Custom')!.positions)).toEqual([
      [0, 0, 0.2, 5, 0, 0.2],
      [5, 5, 0.2, 0, 5, 0.2],
    ]);
    expect(segmentsOf(plain.features.find((f) => f.name === TRAVEL)!.positions)).toContainEqual([
      5, 0, 0.2, 5, 5, 0.2,
    ]);
  });
});
