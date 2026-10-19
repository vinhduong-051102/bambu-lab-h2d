import { promises as fs } from 'fs';
import path from 'path';
import { z } from 'zod';
import { env } from '../../config/env';
import { PrintJobManager } from '../../domain/print/PrintJobManager';
import { isSupportedUpload } from '../../domain/print/fileTypes';
import { commandErrorResponse, handler, json, readJsonBody } from '../http';
import { installedNozzle } from './print';

const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;

// A bare file name inside STUDIO_EXPORT_DIR: no directories, so nothing outside the folder is reachable
const prepareSchema = z.object({
  name: z
    .string({ required_error: 'name is required' })
    .min(1)
    .refine((n) => n === path.basename(n) && !n.includes('/') && !n.includes('\\') && n !== '..', 'Invalid file name')
    .refine(isSupportedUpload, 'Only .3mf, .stl, .obj, .step and .stp files can be printed'),
});

const exportDir = (): string | null => (env.STUDIO_EXPORT_DIR ? path.resolve(env.STUDIO_EXPORT_DIR) : null);

// ThreeMfParseError, matched by name (see commandErrorResponse for why not instanceof)
const parseErrorResponse = (err: unknown): Response | null =>
  err instanceof Error && err.name === 'ThreeMfParseError'
    ? json({ success: false, error: (err as { code?: string }).code, message: err.message }, 422)
    : null;

// GET /api/studio - embedded Bambu Studio settings + printable files it exported (newest first)
export const getStudio = handler(async () => {
  const dir = exportDir();
  const files: { name: string; size: number; modifiedAt: string }[] = [];
  let exportError: string | null = null;

  if (dir) {
    try {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !isSupportedUpload(entry.name)) continue;
        const stat = await fs.stat(path.join(dir, entry.name));
        files.push({ name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString() });
      }
    } catch (err) {
      exportError = `Không đọc được thư mục xuất của Studio: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return json({
    enabled: !!env.STUDIO_URL,
    url: env.STUDIO_URL ?? null,
    exportsEnabled: !!dir,
    exportError,
    files,
  });
});

// POST /api/studio/prepare - stage a file Bambu Studio exported, like POST /api/print/prepare
export const prepareStudioFile = handler(async ({ printerService, request }) => {
  const dir = exportDir();
  if (!dir) {
    return json({ success: false, error: 'STUDIO_EXPORTS_DISABLED', message: 'Chưa cấu hình STUDIO_EXPORT_DIR.' }, 501);
  }
  const parsed = prepareSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return json({ success: false, error: 'INVALID_PAYLOAD', message: 'Invalid file name', details: parsed.error.issues }, 400);
  }

  const filePath = path.join(dir, parsed.data.name);
  let data: Uint8Array;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    if (stat.size > MAX_EXPORT_BYTES) {
      return json({ success: false, error: 'FILE_TOO_LARGE', message: 'File vượt quá 1 GB.' }, 413);
    }
    data = new Uint8Array(await fs.readFile(filePath));
  } catch {
    return json({ success: false, error: 'FILE_NOT_FOUND', message: `Không tìm thấy ${parsed.data.name} trong thư mục xuất của Studio.` }, 404);
  }

  const manager = PrintJobManager.getInstance();
  try {
    const staged = await manager.stage({
      fileName: parsed.data.name,
      data,
      source: 'local',
      nozzle: installedNozzle(printerService),
    });
    return json({ success: true, staged: manager.describeStaged(staged, printerService) }, 201);
  } catch (err) {
    return parseErrorResponse(err) ?? commandErrorResponse(err);
  }
});
