import path from 'path';
import { env } from '../../config/env';
import { bambuColours, mixRecipes } from '../../domain/filaments/catalogueStore';
import { CustomFilamentStore, customFilamentSchema } from '../../domain/filaments/customFilaments';
import { handler, json, readJsonBody } from '../http';

/** Bambu's colour catalogue, loaded (and the first time downloaded) on demand */
export const colourCatalogue = () => bambuColours(path.resolve(env.BAMBU_COLOR_CODES_FILE));
/** Bambu Studio's colour mixing recipes, likewise */
export const recipeBook = () => mixRecipes(path.resolve(env.BAMBU_MIX_RECIPES_FILE));

let customOverride: CustomFilamentStore | null = null;

/** Tests keep custom filaments in a temporary file; null restores CUSTOM_FILAMENTS_FILE */
export function setCustomFilamentStore(store: CustomFilamentStore | null): void {
  customOverride = store;
}

export const customFilaments = () => customOverride ?? new CustomFilamentStore(path.resolve(env.CUSTOM_FILAMENTS_FILE));

// GET /api/filaments/colors?material=PLA%20Basic - Bambu Lab's own filament colours: every one, or one material's
export const getFilamentColours = handler(async ({ request }) => {
  const catalogue = await colourCatalogue();
  if (!catalogue) {
    return json(
      { success: false, error: 'CATALOGUE_UNAVAILABLE', message: 'Chưa tải được bảng màu Bambu (cần mạng ở lần đầu).' },
      503
    );
  }
  const material = new URL(request.url).searchParams.get('material');
  const colours = material ? catalogue.colours.filter((c) => c.material === material) : catalogue.colours;
  return json({ success: true, materials: catalogue.materials(), families: catalogue.families(), colours });
});

// GET /api/filaments/custom - "Filament của tôi": filaments the user saved (other brands, custom colours)
export const listCustomFilaments = handler(async () => json({ success: true, filaments: await customFilaments().list() }));

// POST /api/filaments/custom - {name, brand?, material, hex}: saves a filament for painting figures later
export const addCustomFilament = handler(async ({ request }) => {
  const body = customFilamentSchema.safeParse(await readJsonBody(request));
  if (!body.success) {
    const issue = body.error.issues[0];
    return json({ success: false, error: 'INVALID_PAYLOAD', message: `${issue.path.join('.') || '(gốc)'}: ${issue.message}` }, 400);
  }
  try {
    return json({ success: true, filament: await customFilaments().add(body.data) }, 201);
  } catch (err) {
    return json({ success: false, error: 'TOO_MANY_FILAMENTS', message: err instanceof Error ? err.message : String(err) }, 409);
  }
});

// DELETE /api/filaments/custom/:id
export const deleteCustomFilament = handler<{ id: string }>(async ({ params }) =>
  (await customFilaments().remove(params.id))
    ? json({ success: true })
    : json({ success: false, error: 'FILAMENT_NOT_FOUND', message: 'Không tìm thấy filament này.' }, 404)
);
