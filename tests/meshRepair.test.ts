import { describe, it, expect } from 'vitest';
import { describeRepair, parseStl, repairStl, writeStl } from '../src/domain/studio/meshRepair';

// Unit cube, 12 outward-facing triangles (counter-clockwise seen from outside)
const CUBE_POINTS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const CUBE_FACES = [
  [0, 2, 1], [0, 3, 2], // bottom
  [4, 5, 6], [4, 6, 7], // top
  [0, 1, 5], [0, 5, 4], // front
  [1, 2, 6], [1, 6, 5], // right
  [2, 3, 7], [2, 7, 6], // back
  [3, 0, 4], [3, 4, 7], // left
];

function cube(faces = CUBE_FACES, offset = 0): Buffer {
  const positions = CUBE_POINTS.flat().map((v, i) => (i % 3 === 0 ? v + offset : v));
  return writeStl(positions, faces.flat());
}

describe('STL repair', () => {
  it('leaves a clean closed mesh untouched', () => {
    const input = cube();
    const { stl, report } = repairStl(input);
    expect(report).toMatchObject({ changed: false, watertight: true, triangles_out: 12 });
    expect(stl.equals(input)).toBe(true);
    expect(describeRepair(report)).toBe('lưới không có lỗi cần sửa');
  });

  it('closes a missing face', () => {
    const { stl, report } = repairStl(cube(CUBE_FACES.slice(0, 11)));
    expect(report).toMatchObject({ holes_filled: 1, watertight: true, changed: true, triangles_out: 12 });
    expect(repairStl(stl).report.changed).toBe(false);
  });

  it('flips a face that disagrees with its neighbours', () => {
    const faces = CUBE_FACES.map((f, i) => (i === 7 ? [f[0], f[2], f[1]] : f));
    const { report } = repairStl(cube(faces));
    expect(report).toMatchObject({ faces_flipped: 1, watertight: true });
  });

  it('turns an inside-out part outward', () => {
    const inverted = CUBE_FACES.map((f) => [f[0], f[2], f[1]]);
    const { stl, report } = repairStl(cube(inverted));
    expect(report.parts_inverted).toBe(1);
    // Every stored normal now points away from the cube's centre
    const soup = parseStl(stl);
    const raw = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
    for (let f = 0; f < soup.length / 9; f++) {
      const n = [0, 1, 2].map((k) => raw.getFloat32(84 + f * 50 + k * 4, true));
      const centre = [0, 1, 2].map((k) => (soup[f * 9 + k] + soup[f * 9 + 3 + k] + soup[f * 9 + 6 + k]) / 3 - 0.5);
      expect(n[0] * centre[0] + n[1] * centre[1] + n[2] * centre[2]).toBeGreaterThan(0);
    }
  });

  it('drops duplicate and collapsed faces', () => {
    const positions = CUBE_POINTS.flat();
    const faces = [...CUBE_FACES, CUBE_FACES[0], [0, 0, 1]].flat();
    const { report } = repairStl(writeStl(positions, faces));
    expect(report).toMatchObject({ duplicates_removed: 1, degenerate_removed: 1, watertight: true, triangles_out: 12 });
  });

  it('reads ASCII STL', () => {
    const facets = CUBE_FACES.map((f) => `facet normal 0 0 0\nouter loop\n${f.map((v) => `vertex ${CUBE_POINTS[v].join(' ')}`).join('\n')}\nendloop\nendfacet`);
    const ascii = Buffer.from(`solid cube\n${facets.join('\n')}\nendsolid cube\n`);
    expect(repairStl(ascii).report).toMatchObject({ triangles_in: 12, watertight: true });
  });

  it('rejects a file that is not STL', () => {
    expect(() => repairStl(Buffer.from('not a mesh at all'))).toThrow(/STL/);
  });
});
