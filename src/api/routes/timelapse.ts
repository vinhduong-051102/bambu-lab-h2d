import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { env } from '../../config/env';
import { printerStorage } from '../../bambu/printerStorage';
import { PrintJournal } from '../../domain/prints/PrintJournal';
import { isVideoName, matchPrint, TimelapseLibrary } from '../../domain/timelapse/TimelapseLibrary';
import { handler, json } from '../http';

let library: TimelapseLibrary | null = null;
let journalOverride: PrintJournal | null = null;

/** One library for the whole gateway: it caches the printer's listing and the downloads in progress */
const timelapses = () => (library ??= new TimelapseLibrary(printerStorage, path.resolve(env.TIMELAPSE_CACHE_DIR)));
const journal = () => journalOverride ?? new PrintJournal(path.resolve(env.PRINT_HISTORY_DIR));

/** Tests use their own library and print history; null restores the defaults */
export function setTimelapseStores(lib: TimelapseLibrary | null, prints: PrintJournal | null = null): void {
  library = lib;
  journalOverride = prints;
}

const printerUnreachable = (err: unknown) =>
  json(
    {
      success: false,
      error: 'FTPS_ERROR',
      message: `Không đọc được timelapse trên máy in qua FTPS: ${err instanceof Error ? err.message : String(err)}`,
    },
    502
  );

const notFound = () => json({ success: false, error: 'TIMELAPSE_NOT_FOUND', message: 'Máy in không có video timelapse này.' }, 404);

// GET /api/timelapse?refresh=1 - Timelapse videos on the printer, newest first, each with the print it shows
export const listTimelapses = handler(async ({ request }) => {
  const refresh = new URL(request.url).searchParams.get('refresh') === '1';
  let videos;
  try {
    videos = await timelapses().list(refresh);
  } catch (err) {
    return printerUnreachable(err);
  }
  const prints = await journal().list(500);
  return json({
    success: true,
    videos: videos.map((video) => {
      const print = matchPrint(video, prints);
      return { ...video, print: print && { id: print.id, job_name: print.job_name, status: print.status } };
    }),
  });
});

/** The file, whole or the byte range the browser asks for (video players seek with Range requests) */
async function serveFile(request: Request, file: string, type: string, cache: string): Promise<Response> {
  const { size } = await fs.stat(file);
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
  const range = request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range || (range[1] === '' && range[2] === '')) {
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: { ...headers, 'Content-Length': String(size) },
    });
  }
  // "bytes=-500" is the last 500 bytes
  let start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
  let end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  }
  return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
  });
}

// GET /api/timelapse/:name - The video (copied from the printer on first view), with Range support
export const getTimelapseVideo = handler<{ name: string }>(async ({ request, params }) => {
  if (!isVideoName(params.name)) return notFound();
  let file: string | null;
  try {
    file = await timelapses().video(params.name);
  } catch (err) {
    return printerUnreachable(err);
  }
  if (!file) return notFound();
  const type = path.extname(file).toLowerCase() === '.avi' ? 'video/x-msvideo' : 'video/mp4';
  return serveFile(request, file, type, 'private, max-age=86400');
});

// GET /api/timelapse/:name/thumbnail - The printer's thumbnail of the video
export const getTimelapseThumbnail = handler<{ name: string }>(async ({ request, params }) => {
  if (!isVideoName(params.name)) return notFound();
  let file: string | null;
  try {
    file = await timelapses().thumbnail(params.name);
  } catch (err) {
    return printerUnreachable(err);
  }
  if (!file) return notFound();
  return serveFile(request, file, 'image/jpeg', 'private, max-age=86400');
});
