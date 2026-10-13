/**
 * Parses Bambu Studio G-code into line segments grouped by feature type and layer, for the 3D
 * toolpath preview. Runs in the browser; the gateway only serves the staged .gcode.3mf.
 *
 * Understands what Bambu Studio emits for the H2D: `; CHANGE_LAYER` / `; Z_HEIGHT:` layer markers,
 * `; FEATURE:` sections, relative extrusion (M83), absolute positioning, and G2/G3 arcs (which make
 * up a large share of the moves). Machine start/end G-code (purge lines, homing) is skipped, like
 * Bambu Studio's own preview.
 */

export const TRAVEL = 'Travel';

export interface ToolpathFeature {
  name: string;
  /** xyz pairs: every 2 vertices (6 floats) form one segment, ordered by layer */
  positions: Float32Array;
  /** layerEnds[i] = number of vertices belonging to layers 0..i */
  layerEnds: Uint32Array;
}

export interface Toolpath {
  layers: { z: number | null }[];
  features: ToolpathFeature[];
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  segmentCount: number;
}

/** Arc tessellation: chord length and max angle per step */
const ARC_SEGMENT_MM = 0.5;
const ARC_MAX_STEP_RAD = Math.PI / 18;

class FeatureBuilder {
  private data = new Float32Array(1024);
  private length = 0;
  readonly layerEnds: number[] = [];

  constructor(readonly name: string) {}

  get vertexCount(): number {
    return this.length / 3;
  }

  addSegment(layer: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): void {
    // Close out earlier layers this feature had no moves in
    while (this.layerEnds.length < layer) this.layerEnds.push(this.vertexCount);
    if (this.length + 6 > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = x1;
    this.data[this.length++] = y1;
    this.data[this.length++] = z1;
    this.data[this.length++] = x2;
    this.data[this.length++] = y2;
    this.data[this.length++] = z2;
  }

  finish(layerCount: number): ToolpathFeature {
    while (this.layerEnds.length < layerCount) this.layerEnds.push(this.vertexCount);
    return { name: this.name, positions: this.data.slice(0, this.length), layerEnds: Uint32Array.from(this.layerEnds) };
  }
}

export function parseGcode(text: string): Toolpath {
  const builders = new Map<string, FeatureBuilder>();
  const layers: { z: number | null }[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let segmentCount = 0;

  // Without the start marker (hand-written or other slicers' G-code) everything is the body
  let inBody = !text.includes('; MACHINE_START_GCODE_END');
  let feature = 'Custom';
  let absolute = true;
  let relativeE = false;
  let x: number | null = null;
  let y: number | null = null;
  let z: number | null = null;
  let e = 0;

  const builderFor = (name: string) => {
    let builder = builders.get(name);
    if (!builder) {
      builder = new FeatureBuilder(name);
      builders.set(name, builder);
    }
    return builder;
  };

  const addSegment = (extruding: boolean, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => {
    if (x1 === x2 && y1 === y2 && z1 === z2) return;
    const layer = Math.max(0, layers.length - 1);
    builderFor(extruding ? feature : TRAVEL).addSegment(layer, x1, y1, z1, x2, y2, z2);
    segmentCount++;
    if (extruding) {
      for (const [px, py, pz] of [[x1, y1, z1], [x2, y2, z2]]) {
        if (px < min[0]) min[0] = px;
        if (py < min[1]) min[1] = py;
        if (pz < min[2]) min[2] = pz;
        if (px > max[0]) max[0] = px;
        if (py > max[1]) max[1] = py;
        if (pz > max[2]) max[2] = pz;
      }
    }
  };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (raw.charCodeAt(0) === 59 /* ; */) {
      if (raw.startsWith('; FEATURE:')) feature = raw.slice(10).trim() || 'Custom';
      else if (raw.startsWith('; CHANGE_LAYER')) layers.push({ z: null });
      else if (raw.startsWith('; Z_HEIGHT:') && layers.length > 0) layers[layers.length - 1].z = Number(raw.slice(11));
      else if (raw.startsWith('; MACHINE_START_GCODE_END')) inBody = true;
      else if (raw.startsWith('; MACHINE_END_GCODE_START')) break;
      continue;
    }

    const semicolon = raw.indexOf(';');
    const code = (semicolon === -1 ? raw : raw.slice(0, semicolon)).trim();
    if (!code) continue;
    const tokens = code.split(/\s+/);
    const cmd = tokens[0];

    if (cmd === 'G90') absolute = true;
    else if (cmd === 'G91') absolute = false;
    else if (cmd === 'M83') relativeE = true;
    else if (cmd === 'M82') relativeE = false;
    else if (cmd === 'G92') {
      for (let t = 1; t < tokens.length; t++) if (tokens[t][0] === 'E') e = Number(tokens[t].slice(1)) || 0;
    }
    if (cmd !== 'G0' && cmd !== 'G1' && cmd !== 'G2' && cmd !== 'G3') continue;

    let px: number | undefined, py: number | undefined, pz: number | undefined;
    let pe: number | undefined, pi = 0, pj = 0;
    for (let t = 1; t < tokens.length; t++) {
      const value = Number(tokens[t].slice(1));
      if (Number.isNaN(value)) continue;
      switch (tokens[t][0]) {
        case 'X': px = value; break;
        case 'Y': py = value; break;
        case 'Z': pz = value; break;
        case 'E': pe = value; break;
        case 'I': pi = value; break;
        case 'J': pj = value; break;
      }
    }

    const nx: number | null = px === undefined ? x : absolute ? px : (x ?? 0) + px;
    const ny: number | null = py === undefined ? y : absolute ? py : (y ?? 0) + py;
    const nz: number | null = pz === undefined ? z : absolute ? pz : (z ?? 0) + pz;
    let extruding = false;
    if (pe !== undefined) {
      extruding = relativeE ? pe > 0 : pe > e;
      e = relativeE ? e + pe : pe;
    }

    // Until X, Y and Z are all known there is nothing to draw from
    if (!inBody || x === null || y === null || z === null || nx === null || ny === null || nz === null) {
      x = nx;
      y = ny;
      z = nz;
      continue;
    }

    if (cmd === 'G2' || cmd === 'G3') {
      const cx = x + pi;
      const cy = y + pj;
      const radius = Math.hypot(x - cx, y - cy);
      const start = Math.atan2(y - cy, x - cx);
      let sweep = Math.atan2(ny - cy, nx - cx) - start;
      if (cmd === 'G3' && sweep <= 0) sweep += 2 * Math.PI; // counter-clockwise
      if (cmd === 'G2' && sweep >= 0) sweep -= 2 * Math.PI; // clockwise
      const steps = Math.max(1, Math.ceil(Math.max((Math.abs(sweep) * radius) / ARC_SEGMENT_MM, Math.abs(sweep) / ARC_MAX_STEP_RAD)));
      let ax = x, ay = y, az = z;
      for (let s = 1; s <= steps; s++) {
        const last = s === steps;
        const angle = start + (sweep * s) / steps;
        const bx = last ? nx : cx + radius * Math.cos(angle);
        const by = last ? ny : cy + radius * Math.sin(angle);
        const bz = z + ((nz - z) * s) / steps;
        addSegment(extruding, ax, ay, az, bx, by, bz);
        ax = bx;
        ay = by;
        az = bz;
      }
    } else {
      addSegment(extruding, x, y, z, nx, ny, nz);
    }
    x = nx;
    y = ny;
    z = nz;
  }

  const layerCount = Math.max(1, layers.length);
  return {
    layers: layers.length > 0 ? layers : [{ z: null }],
    features: [...builders.values()].map((b) => b.finish(layerCount)),
    bounds: Number.isFinite(min[0]) ? { min, max } : null,
    segmentCount,
  };
}

/** Bambu Studio-like colours per feature type */
export const FEATURE_COLORS: Record<string, string> = {
  'Outer wall': '#ff7d38',
  'Inner wall': '#ffe7a0',
  'Overhang wall': '#3b5bff',
  'Sparse infill': '#b03029',
  'Internal solid infill': '#9654cc',
  'Top surface': '#f04040',
  'Bottom surface': '#6a9fd8',
  'Bridge': '#4d80ba',
  'Gap infill': '#ffffff',
  'Floating vertical shell': '#d7a96b',
  'Support': '#2ebd5e',
  'Support interface': '#00805a',
  'Support transition': '#7fbf7f',
  'Brim': '#00876e',
  'Skirt': '#00876e',
  'Prime tower': '#b3e1ff',
  'Ironing': '#ff8cb6',
  'Custom': '#5c9ead',
  [TRAVEL]: '#6b7280',
};

export const featureColor = (name: string): string => FEATURE_COLORS[name] ?? '#a3a3a3';
