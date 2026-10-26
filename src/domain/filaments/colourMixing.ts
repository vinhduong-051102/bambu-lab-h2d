import { deltaE, hexToLab } from './bambuColors';

/**
 * Bambu Studio's colour mixing recipes (resources/filament_mixing/standard_color_recipes.json): PLA Basic's
 * primaries (Cyan, Magenta, Yellow, White or Red, Yellow, Blue, White) mixed two or three at a time in 5 % steps
 * from 20 to 80 %, each with the colour it printed as, measured (a few interpolated). Studio mixes them itself;
 * this only finds the recipe that comes closest to a colour no filament has.
 */

export const BAMBU_MIX_RECIPES_URL =
  'https://raw.githubusercontent.com/bambulab/BambuStudio/master/resources/filament_mixing/standard_color_recipes.json';

export interface MixRecipe {
  /** "CMYW" or "RYBW": which primaries */
  mode: string;
  material: string;
  components: { key: string; hex: string; percent: number }[];
  /** The colour it printed as */
  hex: string;
  lab: [number, number, number];
  source: string;
}

export interface MixSuggestion {
  recipe: MixRecipe;
  /** Lab ΔE between the colour wanted and the recipe's printed colour */
  deltaE: number;
}

interface RawRecipe {
  mode: string;
  material: string;
  components: { key: string; rgb: string }[];
  ratios: number[];
  measured_lab?: [number, number, number];
  measured_rgb?: string;
  source?: string;
}

export function parseRecipes(json: unknown): MixRecipe[] {
  const entries = (json as { entries?: RawRecipe[] })?.entries;
  if (!Array.isArray(entries)) throw new Error('standard_color_recipes.json has no "entries" list');
  return entries
    .filter((e) => e.measured_rgb && Array.isArray(e.components) && e.components.length === e.ratios?.length)
    .map((e) => ({
      mode: e.mode,
      material: e.material,
      components: e.components.map((c, i) => ({ key: c.key, hex: c.rgb.toUpperCase(), percent: e.ratios[i] })),
      hex: e.measured_rgb!.toUpperCase(),
      lab: e.measured_lab ?? hexToLab(e.measured_rgb!),
      source: e.source ?? 'measured',
    }));
}

/** The recipe whose printed colour comes closest to `hex`, or null with no recipes */
export function suggestMix(recipes: MixRecipe[], hex: string): MixSuggestion | null {
  const target = hexToLab(hex);
  let best: MixSuggestion | null = null;
  for (const recipe of recipes) {
    const d = Math.hypot(recipe.lab[0] - target[0], recipe.lab[1] - target[1], recipe.lab[2] - target[2]);
    if (!best || d < best.deltaE) best = { recipe, deltaE: d };
  }
  return best && { ...best, deltaE: Math.round(best.deltaE * 10) / 10 };
}

/** How far a printed colour is from the one wanted, in words the dashboard shows (Lab ΔE76) */
export function deltaLabel(d: number): 'giống' | 'gần đúng' | 'hơi lệch' | 'lệch rõ' {
  if (d <= 2.5) return 'giống';
  if (d <= 6) return 'gần đúng';
  if (d <= 12) return 'hơi lệch';
  return 'lệch rõ';
}

export { deltaE };
