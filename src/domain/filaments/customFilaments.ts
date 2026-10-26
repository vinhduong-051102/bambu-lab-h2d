import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { z } from 'zod';

/**
 * "Filament của tôi": filaments the user owns or buys that Bambu's catalogue doesn't have (other brands, custom
 * colours), saved so figures can be painted in them later. One JSON file.
 */

export interface CustomFilament {
  id: string;
  /** e.g. "Cam đất" */
  name: string;
  /** e.g. "eSun"; empty for unknown */
  brand: string;
  /** e.g. "PLA", "PETG" */
  material: string;
  /** "#RRGGBB" */
  hex: string;
  created_at: string;
}

export const customFilamentSchema = z.object({
  name: z.string().trim().min(1, 'Cần tên màu.').max(60),
  brand: z.string().trim().max(40).default(''),
  material: z.string().trim().min(1, 'Cần loại nhựa.').max(40),
  hex: z
    .string()
    .trim()
    .regex(/^#?[0-9a-fA-F]{6}$/, 'Mã màu dạng #RRGGBB.')
    .transform((v) => `#${v.replace('#', '').toUpperCase()}`),
});

const MAX_FILAMENTS = 200;

export class CustomFilamentStore {
  constructor(private readonly file: string) {}

  async list(): Promise<CustomFilament[]> {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return Array.isArray(data?.filaments) ? data.filaments : [];
    } catch {
      return [];
    }
  }

  private async save(filaments: CustomFilament[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    // Replaced whole, so a crash never leaves half a file
    await fs.writeFile(`${this.file}.part`, JSON.stringify({ filaments }, null, 2));
    await fs.rename(`${this.file}.part`, this.file);
  }

  async add(input: z.infer<typeof customFilamentSchema>): Promise<CustomFilament> {
    const filaments = await this.list();
    if (filaments.length >= MAX_FILAMENTS) throw new Error(`Tối đa ${MAX_FILAMENTS} filament.`);
    const filament: CustomFilament = { id: randomBytes(4).toString('hex'), ...input, created_at: new Date().toISOString() };
    await this.save([...filaments, filament]);
    return filament;
  }

  async remove(id: string): Promise<boolean> {
    const filaments = await this.list();
    const kept = filaments.filter((f) => f.id !== id);
    if (kept.length === filaments.length) return false;
    await this.save(kept);
    return true;
  }
}

/** How a custom filament is named on a figure's palette: "eSun PLA Cam đất" */
export const customLabel = (f: CustomFilament) => [f.brand, f.material, f.name].filter(Boolean).join(' ');
