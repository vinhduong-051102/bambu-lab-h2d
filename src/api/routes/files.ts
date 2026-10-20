import { z } from 'zod';
import type { PrinterFileEntry } from '../../bambu/BambuFtpClient';
import { printerStorage } from '../../bambu/printerStorage';
import { handler, json } from '../http';

// Bambu Studio uploads to /cache, OrcaSlicer and this gateway to the FTPS root
const LIST_DIRECTORIES = ['/', '/cache'];

const remotePathSchema = z
  .string()
  .regex(/^\/[^\0]+$/, 'Path must be absolute')
  .refine((p) => !p.split('/').includes('..'), 'Invalid path');

const ftpError = (err: unknown) =>
  json(
    {
      success: false,
      error: 'FTPS_ERROR',
      message: `Không kết nối được bộ nhớ máy in qua FTPS (cổng 990): ${err instanceof Error ? err.message : String(err)}`,
    },
    502
  );

// GET /api/files - files on the printer storage (FTPS root and /cache)
export const getFiles = handler(async () => {
  const storage = printerStorage();
  const files: (PrinterFileEntry & { printable: boolean })[] = [];

  for (const dir of LIST_DIRECTORIES) {
    try {
      const entries = await storage.list(dir);
      for (const entry of entries) {
        if (!entry.isDirectory) files.push({ ...entry, printable: /\.3mf$/i.test(entry.name) });
      }
    } catch (err) {
      // /cache does not exist on every printer; the root must be reachable
      if (dir === '/') return ftpError(err);
    }
  }

  files.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
  return json({ count: files.length, files });
});

// DELETE /api/files/:id - id is the URL-encoded absolute path, e.g. %2Fpart.gcode.3mf
export const deleteFile = handler<{ id: string }>(async ({ params }) => {
  const parsed = remotePathSchema.safeParse(decodeURIComponent(params.id));
  if (!parsed.success) {
    return json({ success: false, error: 'INVALID_PAYLOAD', message: 'Invalid file path', details: parsed.error.issues }, 400);
  }

  try {
    await printerStorage().remove(parsed.data);
    return json({ success: true, path: parsed.data });
  } catch (err) {
    return ftpError(err);
  }
});
