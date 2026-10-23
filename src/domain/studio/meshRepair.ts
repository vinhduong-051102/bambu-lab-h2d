/**
 * STL repair for files sent to Bambu Studio from the dashboard: welds the triangle soup into a connected
 * mesh, drops degenerate and duplicate faces, makes neighbouring faces agree on orientation (and turns
 * inside-out parts outward), and closes holes. Studio's own "Fix model" only exists on Windows, so the
 * Linux container never repairs anything itself.
 */

export interface RepairReport {
  /** Triangles in the file as sent */
  triangles_in: number;
  /** Triangles in the repaired file */
  triangles_out: number;
  degenerate_removed: number;
  duplicates_removed: number;
  /** Faces flipped to agree with their neighbours */
  faces_flipped: number;
  /** Closed parts that were inside out (pointing inward) and were turned outward */
  parts_inverted: number;
  holes_filled: number;
  /** Edges with a face on one side only, left after filling the holes it could close safely */
  open_edges_left: number;
  /** Edges shared by more than two faces; reported, not changed */
  non_manifold_edges: number;
  /** Every edge has exactly two faces after the repair */
  watertight: boolean;
  /** Whether anything was changed */
  changed: boolean;
  /** The repair would have left the mesh worse than it came, so the file was kept as sent */
  kept_original?: boolean;
}

export interface RepairResult {
  stl: Buffer;
  report: RepairReport;
}

export class StlParseError extends Error {}

/** Holes with more edges than this are left open: a fan over a large opening would distort the model */
const MAX_HOLE_EDGES = 2000;

/** Vertices closer than this (mm) are the same point; STL repeats each vertex per face, with float noise */
const WELD_TOLERANCE_MM = 1e-4;

/** Triangle soup: 9 floats per face (3 vertices × xyz) */
export function parseStl(data: Uint8Array): Float32Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength >= 84) {
    const count = view.getUint32(80, true);
    // Binary STL is exactly 84 + 50 × count bytes; an ASCII file starting with "solid" can't match that
    if (84 + count * 50 === data.byteLength) {
      const out = new Float32Array(count * 9);
      for (let f = 0; f < count; f++) {
        const base = 84 + f * 50 + 12; // skip the stored normal
        for (let k = 0; k < 9; k++) out[f * 9 + k] = view.getFloat32(base + k * 4, true);
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(data);
  if (!/^\s*solid/i.test(text)) throw new StlParseError('Không đọc được file STL (không phải STL nhị phân hay ASCII hợp lệ).');
  const values: number[] = [];
  for (const match of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)) {
    values.push(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  if (values.length === 0 || values.length % 9 !== 0 || values.some((v) => !Number.isFinite(v))) {
    throw new StlParseError('File STL ASCII bị hỏng: số đỉnh không hợp lệ.');
  }
  return Float32Array.from(values);
}

/** Binary STL with recomputed face normals */
export function writeStl(positions: Float32Array | number[], faces: Uint32Array | number[]): Buffer {
  const count = faces.length / 3;
  const out = Buffer.alloc(84 + count * 50);
  out.write('Repaired by bambu-lab-h2d gateway', 0, 'ascii');
  out.writeUInt32LE(count, 80);
  for (let f = 0; f < count; f++) {
    const [a, b, c] = [faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]];
    const p = (i: number, k: number) => positions[i * 3 + k];
    const ux = p(b, 0) - p(a, 0), uy = p(b, 1) - p(a, 1), uz = p(b, 2) - p(a, 2);
    const vx = p(c, 0) - p(a, 0), vy = p(c, 1) - p(a, 1), vz = p(c, 2) - p(a, 2);
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const base = 84 + f * 50;
    out.writeFloatLE(nx, base);
    out.writeFloatLE(ny, base + 4);
    out.writeFloatLE(nz, base + 8);
    for (let v = 0; v < 3; v++) {
      const i = [a, b, c][v];
      for (let k = 0; k < 3; k++) out.writeFloatLE(p(i, k), base + 12 + v * 12 + k * 4);
    }
  }
  return out;
}

const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

export function repairStl(data: Uint8Array): RepairResult {
  const soup = parseStl(data);
  const trianglesIn = soup.length / 9;

  // 1. Weld: one index per distinct point
  const positions: number[] = [];
  const index = new Map<string, number>();
  const corner = new Uint32Array(trianglesIn * 3);
  for (let i = 0; i < trianglesIn * 3; i++) {
    const x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2];
    const key = `${Math.round(x / WELD_TOLERANCE_MM)},${Math.round(y / WELD_TOLERANCE_MM)},${Math.round(z / WELD_TOLERANCE_MM)}`;
    let id = index.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      index.set(key, id);
      positions.push(x, y, z);
    }
    corner[i] = id;
  }

  // 2. Degenerate faces (repeated corner, or no area) and duplicates (same three corners)
  const areaTwice = (a: number, b: number, c: number) => {
    const p = (i: number, k: number) => positions[i * 3 + k];
    const ux = p(b, 0) - p(a, 0), uy = p(b, 1) - p(a, 1), uz = p(b, 2) - p(a, 2);
    const vx = p(c, 0) - p(a, 0), vy = p(c, 1) - p(a, 1), vz = p(c, 2) - p(a, 2);
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };
  let faces: number[] = [];
  let degenerate = 0;
  let duplicates = 0;
  const seen = new Set<string>();
  for (let f = 0; f < trianglesIn; f++) {
    const a = corner[f * 3], b = corner[f * 3 + 1], c = corner[f * 3 + 2];
    // Only faces that collapsed onto a repeated corner: a thin face with three distinct corners in line
    // still closes the gap between its neighbours, and removing it opens the mesh
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    faces.push(a, b, c);
  }

  // 3. Orientation: walk each connected part across manifold edges; a neighbour must run the shared
  //    edge the other way, else it is flipped. Then a part with negative volume is turned outward.
  const faceCount = () => faces.length / 3;
  const buildEdges = () => {
    const edges = new Map<string, number[]>();
    for (let f = 0; f < faceCount(); f++) {
      for (let k = 0; k < 3; k++) {
        const key = edgeKey(faces[f * 3 + k], faces[f * 3 + ((k + 1) % 3)]);
        const list = edges.get(key);
        if (list) list.push(f);
        else edges.set(key, [f]);
      }
    }
    return edges;
  };
  const runsForward = (f: number, a: number, b: number) => {
    for (let k = 0; k < 3; k++) if (faces[f * 3 + k] === a && faces[f * 3 + ((k + 1) % 3)] === b) return true;
    return false;
  };
  const flip = (f: number) => {
    const t = faces[f * 3 + 1];
    faces[f * 3 + 1] = faces[f * 3 + 2];
    faces[f * 3 + 2] = t;
  };

  // Connected parts across manifold edges (two faces). With `orient`, a neighbour that runs the shared edge
  // the same way as the face it was reached from is flipped (f runs a→b, so a consistent neighbour runs b→a).
  let flipped = 0;
  const findParts = (edges: Map<string, number[]>, orient: boolean): number[][] => {
    const part = new Int32Array(faceCount()).fill(-1);
    const parts: number[][] = [];
    for (let start = 0; start < faceCount(); start++) {
      if (part[start] !== -1) continue;
      const members: number[] = [];
      const queue = [start];
      part[start] = parts.length;
      while (queue.length) {
        const f = queue.pop()!;
        members.push(f);
        for (let k = 0; k < 3; k++) {
          const a = faces[f * 3 + k], b = faces[f * 3 + ((k + 1) % 3)];
          const shared = edges.get(edgeKey(a, b))!;
          if (shared.length !== 2) continue;
          const g = shared[0] === f ? shared[1] : shared[0];
          if (part[g] !== -1) continue;
          if (orient && runsForward(g, a, b)) {
            flip(g);
            flipped++;
          }
          part[g] = parts.length;
          queue.push(g);
        }
      }
      parts.push(members);
    }
    return parts;
  };

  let edges = buildEdges();
  findParts(edges, true);
  if (flipped > 0) edges = buildEdges();

  // 4. Holes: boundary edges (one face) chained into loops and closed with a fan around the loop's centre
  const next = new Map<number, number[]>();
  for (const [key, list] of edges) {
    if (list.length !== 1) continue;
    const [x, y] = key.split(',').map(Number);
    // The face runs a→b along this edge, so the hole runs b→a
    const [a, b] = runsForward(list[0], x, y) ? [x, y] : [y, x];
    const out = next.get(b);
    if (out) out.push(a);
    else next.set(b, [a]);
  }
  let holesFilled = 0;
  const used = new Set<string>();
  for (const [from, targets] of next) {
    for (const firstTo of targets) {
      if (used.has(`${from}>${firstTo}`)) continue;
      const loop = [from];
      let at = firstTo;
      used.add(`${from}>${firstTo}`);
      let closed = false;
      while (loop.length <= MAX_HOLE_EDGES) {
        if (at === from) {
          closed = true;
          break;
        }
        loop.push(at);
        const options = (next.get(at) ?? []).filter((t) => !used.has(`${at}>${t}`));
        // A vertex where two holes touch is ambiguous: such a loop is left open
        if (options.length !== 1) break;
        used.add(`${at}>${options[0]}`);
        at = options[0];
      }
      if (!closed || loop.length < 3) continue;
      let fill: number[];
      if (loop.length === 3) {
        fill = [loop[0], loop[1], loop[2]];
      } else {
        const centre = [0, 0, 0];
        for (const v of loop) for (let k = 0; k < 3; k++) centre[k] += positions[v * 3 + k] / loop.length;
        const c = positions.length / 3;
        positions.push(centre[0], centre[1], centre[2]);
        fill = loop.flatMap((v, i) => [v, loop[(i + 1) % loop.length], c]);
      }
      // A crack whose sides are (nearly) in line would be closed with zero-area triangles, which are
      // themselves a defect: leave it open, it has no width to print anyway
      let sliver = false;
      for (let i = 0; i < fill.length && !sliver; i += 3) sliver = areaTwice(fill[i], fill[i + 1], fill[i + 2]) < 1e-12;
      if (sliver) {
        if (loop.length > 3) positions.length -= 3;
        continue;
      }
      faces.push(...fill);
      holesFilled++;
    }
  }
  if (holesFilled > 0) edges = buildEdges();

  // 5. A closed part with negative volume (divergence theorem) points inward: turn it outward. Open parts
  //    are left as they are, since their volume says nothing about which side is outside.
  let invertedParts = 0;
  for (const members of findParts(edges, false)) {
    const closedPart = members.every((f) =>
      [0, 1, 2].every((k) => edges.get(edgeKey(faces[f * 3 + k], faces[f * 3 + ((k + 1) % 3)]))!.length === 2)
    );
    if (!closedPart) continue;
    let volume = 0;
    for (const f of members) {
      const p = (i: number) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
      const [a, b, c] = [p(faces[f * 3]), p(faces[f * 3 + 1]), p(faces[f * 3 + 2])];
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    if (volume < 0) {
      for (const f of members) flip(f);
      invertedParts++;
    }
  }

  let openEdges = 0;
  let nonManifold = 0;
  for (const list of edges.values()) {
    if (list.length === 1) openEdges++;
    else if (list.length > 2) nonManifold++;
  }

  // The file as sent, welded: a repair that leaves more open or non-manifold edges than this made it worse
  const before = new Map<string, number>();
  for (let f = 0; f < trianglesIn; f++) {
    for (let k = 0; k < 3; k++) {
      const a = corner[f * 3 + k], b = corner[f * 3 + ((k + 1) % 3)];
      if (a !== b) before.set(edgeKey(a, b), (before.get(edgeKey(a, b)) ?? 0) + 1);
    }
  }
  let defectsBefore = 0;
  for (const n of before.values()) if (n !== 2) defectsBefore++;
  const worse = openEdges + nonManifold > defectsBefore;

  const changed = !worse && (degenerate > 0 || duplicates > 0 || flipped > 0 || invertedParts > 0 || holesFilled > 0);
  if (worse) {
    return {
      stl: Buffer.from(data),
      report: {
        triangles_in: trianglesIn,
        triangles_out: trianglesIn,
        degenerate_removed: 0,
        duplicates_removed: 0,
        faces_flipped: 0,
        parts_inverted: 0,
        holes_filled: 0,
        open_edges_left: [...before.values()].filter((n) => n === 1).length,
        non_manifold_edges: [...before.values()].filter((n) => n > 2).length,
        watertight: defectsBefore === 0,
        changed: false,
        kept_original: true,
      },
    };
  }
  return {
    stl: changed ? writeStl(positions, faces) : Buffer.from(data),
    report: {
      triangles_in: trianglesIn,
      triangles_out: faces.length / 3,
      degenerate_removed: degenerate,
      duplicates_removed: duplicates,
      faces_flipped: flipped,
      parts_inverted: invertedParts,
      holes_filled: holesFilled,
      open_edges_left: openEdges,
      non_manifold_edges: nonManifold,
      watertight: openEdges === 0 && nonManifold === 0,
      changed,
      kept_original: false,
    },
  };
}

/** One line for the user, e.g. "đã vá 2 lỗ, bỏ 14 mặt suy biến" */
export function describeRepair(report: RepairReport): string {
  const parts: string[] = [];
  if (report.holes_filled) parts.push(`vá ${report.holes_filled} lỗ`);
  if (report.faces_flipped) parts.push(`lật ${report.faces_flipped} mặt ngược`);
  if (report.parts_inverted) parts.push(`lật ${report.parts_inverted} phần bị lộn trong ra ngoài`);
  if (report.degenerate_removed) parts.push(`bỏ ${report.degenerate_removed} mặt suy biến`);
  if (report.duplicates_removed) parts.push(`bỏ ${report.duplicates_removed} mặt trùng`);
  const done = report.kept_original
    ? 'giữ nguyên file gốc (sửa tự động không làm lưới tốt hơn)'
    : parts.length
      ? `đã ${parts.join(', ')}`
      : 'lưới không có lỗi cần sửa';
  const left: string[] = [];
  if (report.open_edges_left) left.push(`${report.open_edges_left} cạnh hở chưa vá được`);
  if (report.non_manifold_edges) left.push(`${report.non_manifold_edges} cạnh non-manifold`);
  return left.length ? `${done}; còn ${left.join(', ')}` : done;
}
