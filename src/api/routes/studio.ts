import { promises as fs } from 'fs';
import os from 'os';
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

/** Whether a host name or IP is this machine, i.e. Studio's container runs next to the gateway */
function isThisMachine(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === os.hostname().toLowerCase()) return true;
  return Object.values(os.networkInterfaces()).some((addrs) => addrs?.some((a) => a.address.toLowerCase() === host));
}

/**
 * STUDIO_URL as seen from the browser: a STUDIO_ALT_URLS entry on the host the dashboard was opened
 * with, else (when Studio runs on this machine) STUDIO_URL pointed at that host, so it works over LAN,
 * Tailscale or localhost alike instead of only the address written in .env.
 */
function studioUrlFor(request: Request): string | null {
  if (!env.STUDIO_URL) return null;
  const studio = new URL(env.STUDIO_URL);
  let requestHost: string;
  try {
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
    requestHost = new URL(`http://${host.split(',')[0].trim()}`).hostname;
  } catch {
    return env.STUDIO_URL;
  }
  const alt = env.STUDIO_ALT_URLS.find((url) => new URL(url).hostname === requestHost);
  if (alt) return alt;
  if (!requestHost || requestHost === studio.hostname || !isThisMachine(studio.hostname)) return env.STUDIO_URL;
  studio.hostname = requestHost;
  return studio.toString();
}

// GET /api/studio - embedded Bambu Studio settings for the dashboard card
export const getStudio = handler(({ request }) =>
  json({
    enabled: !!env.STUDIO_URL,
    url: studioUrlFor(request),
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
