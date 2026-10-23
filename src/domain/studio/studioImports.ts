import { promises as fs } from 'fs';
import path from 'path';
import { describeRepair, repairStl, StlParseError, type RepairReport } from './meshRepair';

// Files Bambu Studio can open with File → Import / Open
export const STUDIO_FILE_RE = /\.(3mf|stl|obj|step|stp)$/i;

/** Folder (inside STUDIO_IMPORT_DIR) that keeps STL files as sent when the import repaired them */
const ORIGINALS_DIR = '.originals';
/** Larger STL files are imported as they are: the repair holds the whole mesh in memory */
const MAX_REPAIR_BYTES = 200 * 1024 * 1024;

export type ImportRepair = (RepairReport & { summary: string }) | { skipped: string };

export interface StudioImport {
  /** File name in the import folder, which Studio sees at /imports/<name> */
  name: string;
  repair: ImportRepair | null;
}

/** Browser-supplied name → a plain file name with no path or control characters */
export function safeFileName(name: string): string {
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

/** An STL with its mesh repaired, or the file unchanged (other formats, too large, unreadable) */
function repairImport(name: string, data: Uint8Array): { content: Uint8Array; repair: ImportRepair | null } {
  if (!/\.stl$/i.test(name)) return { content: data, repair: null };
  if (data.byteLength > MAX_REPAIR_BYTES) {
    return { content: data, repair: { skipped: 'File lớn hơn 200 MB nên không tự sửa lưới.' } };
  }
  try {
    const { stl, report } = repairStl(data);
    return { content: report.changed ? new Uint8Array(stl) : data, repair: { ...report, summary: describeRepair(report) } };
  } catch (err) {
    const reason = err instanceof StlParseError ? err.message : `Lỗi khi sửa lưới: ${err instanceof Error ? err.message : String(err)}`;
    return { content: data, repair: { skipped: reason } };
  }
}

/**
 * Puts a model into Studio's import folder under a free name (`name` must be a safe file name Studio can
 * open), repairing STL meshes on the way. Written to a temp name first so Studio never sees a half-copied file.
 */
export async function saveStudioImport(dir: string, name: string, original: Uint8Array): Promise<StudioImport> {
  await fs.mkdir(dir, { recursive: true });
  const stored = await freeName(dir, name);
  const { content, repair } = repairImport(stored, original);
  const tempPath = path.join(dir, `.${stored}.part`);
  try {
    // The file as sent stays available (in a dot folder Studio's file dialog hides) when the repair changed it
    if (repair && 'changed' in repair && repair.changed) {
      await fs.mkdir(path.join(dir, ORIGINALS_DIR), { recursive: true });
      await fs.writeFile(path.join(dir, ORIGINALS_DIR, stored), original);
    }
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, path.join(dir, stored));
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    throw err;
  }
  return { name: stored, repair };
}
