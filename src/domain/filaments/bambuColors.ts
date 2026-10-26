/**
 * Bambu Lab's own filament colours (filaments_color_codes.json from Bambu Studio's resources): 300-odd colours
 * of 40-odd materials, each with the code on its spool, the material id the AMS reads from the spool's RFID tag
 * (tray_info_idx, e.g. GFA00 = PLA Basic) and its sRGB value. Used to name what the AMS holds and to paint
 * figures in colours one can buy. Pure, so the dashboard uses it too; catalogueStore.ts loads the file.
 */

export const BAMBU_COLOR_CODES_URL =
  'https://raw.githubusercontent.com/bambulab/BambuStudio/master/resources/profiles/BBL/filament/filaments_color_codes.json';

export interface BambuColour {
  /** The code on the spool and in Bambu's store, e.g. "10300" */
  code: string;
  /** Material id, e.g. "GFA00" (what the AMS reports as infoIdx) */
  filamentId: string;
  /** Material name, e.g. "PLA Basic" */
  material: string;
  /** English colour name, e.g. "Orange" */
  name: string;
  /** "#RRGGBB"; a gradient or multi-colour spool lists several */
  hex: string[];
  kind: 'single' | 'gradient' | 'multi';
}

interface RawEntry {
  fila_color_code: string;
  fila_id: string;
  fila_color_type: string;
  fila_type: string;
  fila_color_name?: Record<string, string>;
  fila_color: string[];
}

const KINDS: Record<string, BambuColour['kind']> = { 单色: 'single', 渐变色: 'gradient', 多拼色: 'multi' };

/** "PLA Basic", "PLA-CF" → "PLA"; "PETG HF" → "PETG"; support materials belong to none */
export function familyOf(material: string): string | null {
  if (/^(support|pva)/i.test(material)) return null;
  return material.split(/[\s-]/)[0] || null;
}

export function parseCatalogue(json: unknown): BambuColour[] {
  const data = (json as { data?: RawEntry[] })?.data;
  if (!Array.isArray(data)) throw new Error('filaments_color_codes.json has no "data" list');
  return data
    .filter((e) => e.fila_id && e.fila_type && Array.isArray(e.fila_color) && e.fila_color.length > 0)
    .map((e) => ({
      code: String(e.fila_color_code),
      filamentId: e.fila_id,
      material: e.fila_type,
      name: e.fila_color_name?.en || e.fila_color_name?.zh || e.fila_color_code,
      hex: e.fila_color.map((c) => `#${c.replace('#', '').slice(0, 6).toUpperCase()}`),
      kind: KINDS[e.fila_color_type] ?? 'single',
    }));
}

// ---------- Colour distance (CIE Lab, ΔE76): what the eye sees as a different filament ----------

export function hexToLab(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92));
  const [r, g, b] = rgb;
  const xyz = [
    (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047,
    r * 0.2126 + g * 0.7152 + b * 0.0722,
    (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883,
  ].map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116));
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = hexToLab(a);
  const [l2, a2, b2] = hexToLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// A tray's colour within this of a catalogue colour of its material is taken to be that colour (the RFID tag
// stores the exact value, so a Bambu spool matches at ~0; a third-party colour picked by hand rarely comes close)
const MATCH_DELTA_E = 6;

export class BambuColourCatalogue {
  constructor(readonly colours: BambuColour[]) {}

  /** Single-colour entries of a material, e.g. "PLA Basic" */
  ofMaterial(material: string): BambuColour[] {
    return this.colours.filter((c) => c.material === material && c.kind === 'single');
  }

  /**
   * Single-colour entries of every material of a family ("PLA": PLA Basic, Matte, Silk, -CF …), leaving out
   * see-through and patterned materials, whose listed colour isn't how a solid print looks
   */
  ofFamily(family: string): BambuColour[] {
    return this.colours.filter(
      (c) => c.kind === 'single' && familyOf(c.material) === family && !/translucent|marble/i.test(c.material)
    );
  }

  /** Families of two or more materials, with their single colours: one can print them together */
  families(): { family: string; materials: number; colours: number }[] {
    const found = new Map<string, { materials: Set<string>; colours: number }>();
    for (const c of this.colours) {
      const family = familyOf(c.material);
      if (!family || c.kind !== 'single') continue;
      const entry = found.get(family) ?? { materials: new Set(), colours: 0 };
      entry.materials.add(c.material);
      entry.colours += 1;
      found.set(family, entry);
    }
    return [...found]
      .filter(([, v]) => v.materials.size >= 2)
      .map(([family, v]) => ({ family, materials: v.materials.size, colours: v.colours }))
      .sort((a, b) => b.colours - a.colours);
  }

  /** Materials with at least `min` single colours, most colours first */
  materials(min = 2): { material: string; filamentId: string; colours: number }[] {
    const counts = new Map<string, { filamentId: string; colours: number }>();
    for (const c of this.colours) {
      if (c.kind !== 'single') continue;
      const entry = counts.get(c.material) ?? { filamentId: c.filamentId, colours: 0 };
      entry.colours += 1;
      counts.set(c.material, entry);
    }
    return [...counts]
      .filter(([, v]) => v.colours >= min)
      .map(([material, v]) => ({ material, ...v }))
      .sort((a, b) => b.colours - a.colours || a.material.localeCompare(b.material));
  }

  /**
   * The Bambu colour an AMS tray holds: its material id (infoIdx) and colour must match a catalogue entry, the
   * colour within MATCH_DELTA_E. null for third-party filament or a colour Bambu doesn't make.
   */
  identify(filamentId: string | null | undefined, hex: string | null | undefined): BambuColour | null {
    if (!filamentId || !hex || !/^#?[0-9a-f]{6}/i.test(hex)) return null;
    const value = hex.startsWith('#') ? hex.slice(0, 7) : `#${hex.slice(0, 6)}`;
    let best: BambuColour | null = null;
    let bestDistance = Infinity;
    for (const c of this.colours) {
      if (c.filamentId !== filamentId || c.kind !== 'single') continue;
      const d = deltaE(value, c.hex[0]);
      if (d < bestDistance) {
        best = c;
        bestDistance = d;
      }
    }
    return bestDistance <= MATCH_DELTA_E ? best : null;
  }
}
