import { promises as fs } from 'fs';
import path from 'path';
import { BAMBU_COLOR_CODES_URL, BambuColourCatalogue, parseCatalogue } from './bambuColors';
import { BAMBU_MIX_RECIPES_URL, parseRecipes, type MixRecipe } from './colourMixing';

/**
 * Data files from Bambu Studio's repository (the colour catalogue, the mixing recipes), each from its cached copy,
 * downloaded the first time it is asked for. null when it can't be had (offline on first use): callers then go
 * without. A failed download is tried again on the next call.
 */
function cachedResource<T>(parse: (json: unknown) => T) {
  let loading: Promise<T | null> | null = null;
  let override: T | null | undefined;
  return {
    get(cacheFile: string, url: string): Promise<T | null> {
      if (override !== undefined) return Promise.resolve(override);
      loading ??= load(cacheFile, url, parse).then((value) => {
        if (value === null) loading = null;
        return value;
      });
      return loading;
    },
    /** Tests use data of their own; undefined restores the file */
    set(value: T | null | undefined) {
      override = value;
    },
  };
}

async function load<T>(cacheFile: string, url: string, parse: (json: unknown) => T): Promise<T | null> {
  try {
    return parse(JSON.parse(await fs.readFile(cacheFile, 'utf8')));
  } catch {
    // not cached yet, or unreadable: fetch it
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const text = await res.text();
    const value = parse(JSON.parse(text));
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, text);
    return value;
  } catch {
    return null;
  }
}

const catalogue = cachedResource((json) => new BambuColourCatalogue(parseCatalogue(json)));
const recipes = cachedResource<MixRecipe[]>(parseRecipes);

export const bambuColours = (cacheFile: string, url = BAMBU_COLOR_CODES_URL) => catalogue.get(cacheFile, url);
export const setBambuColours = (value: BambuColourCatalogue | null | undefined) => catalogue.set(value);

export const mixRecipes = (cacheFile: string, url = BAMBU_MIX_RECIPES_URL) => recipes.get(cacheFile, url);
export const setMixRecipes = (value: MixRecipe[] | null | undefined) => recipes.set(value);
