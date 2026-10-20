import { promises as fs } from 'fs';
import path from 'path';
import { env } from '../../config/env';
import { handler, json } from '../http';

const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

// Files Bambu Studio can open with File → Import / Open
const STUDIO_FILE_RE = /\.(3mf|stl|obj|step|stp)$/i;

const importDir = (): string | null => (env.STUDIO_IMPORT_DIR ? path.resolve(env.STUDIO_IMPORT_DIR) : null);

/** Browser-supplied name → a plain file name with no path or control characters */
function safeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f<>:"|?*]/g, '_').trim();
  return base === '.' || base === '..' ? '' : base;
}

/** "part.stl" → "part (2).stl" when the name is taken, so an upload never replaces a file Studio has open */
async function freeName(dir: string, name: string): Promise<string> {
  const match = name.match(/^(.*?)((?:\.gcode)?\.[^.]+)$/);
  const [stem, ext] = match ? [match[1], match[2]] : [name, ''];
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    try {
      await fs.access(path.join(dir, candidate));
    } catch {
      return candidate;
    }
  }
}

// GET /api/studio - embedded Bambu Studio settings for the dashboard card
export const getStudio = handler(() =>
  json({
    enabled: !!env.STUDIO_URL,
    url: env.STUDIO_URL ?? null,
    importsEnabled: !!importDir(),
  })
);

// POST /api/studio/import - multipart "file": copy a model from the user's computer into Studio's /imports
export const importToStudio = handler(async ({ request }) => {
  const dir = importDir();
  if (!dir) {
    return json({ success: false, error: 'STUDIO_IMPORTS_DISABLED', message: 'Chưa cấu hình STUDIO_IMPORT_DIR.' }, 501);
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_IMPORT_BYTES) {
    return json({ success: false, error: 'FILE_TOO_LARGE', message: 'File vượt quá 1 GB.' }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ success: false, error: 'INVALID_PAYLOAD', message: 'Expected multipart/form-data with a "file" field.' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return json({ success: false, error: 'INVALID_PAYLOAD', message: 'Missing "file" field.' }, 400);
  }
  const name = safeFileName(file.name);
  if (!name || !STUDIO_FILE_RE.test(name)) {
    return json(
      { success: false, error: 'UNSUPPORTED_FILE_TYPE', message: 'Chỉ gửi được file .3mf, .stl, .obj, .step, .stp vào Studio.' },
      415
    );
  }

  await fs.mkdir(dir, { recursive: true });
  const stored = await freeName(dir, name);
  // Written to a temp name first so Studio never sees a half-copied file
  const tempPath = path.join(dir, `.${stored}.part`);
  try {
    await fs.writeFile(tempPath, new Uint8Array(await file.arrayBuffer()));
    await fs.rename(tempPath, path.join(dir, stored));
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    return json({ success: false, error: 'WRITE_FAILED', message: `Không lưu được file: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
  return json({ success: true, name: stored, studioPath: `/imports/${stored}` }, 201);
});
