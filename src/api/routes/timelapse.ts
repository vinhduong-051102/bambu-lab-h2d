import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { z } from 'zod';
import { env } from '../../config/env';
import { printerStorage } from '../../bambu/printerStorage';
import { isPrintId, PrintJournal } from '../../domain/prints/PrintJournal';
import { AiSessionStore, PRINT_ISSUE_LABELS, PRINT_OUTCOME_LABELS } from '../../domain/studio/aiSessions';
import { isVideoName, matchPrint, TimelapseLibrary } from '../../domain/timelapse/TimelapseLibrary';
import { FfmpegFrames, OllamaVision, TimelapseReviewer, type TimelapseReview } from '../../domain/timelapse/TimelapseReviewer';
import { handler, json, readJsonBody } from '../http';

let library: TimelapseLibrary | null = null;
let reviewer: TimelapseReviewer | null = null;
let journalOverride: PrintJournal | null = null;
let sessionStoreOverride: AiSessionStore | null = null;

/** One library for the whole gateway: it caches the printer's listing and the downloads in progress */
const timelapses = () => (library ??= new TimelapseLibrary(printerStorage, path.resolve(env.TIMELAPSE_CACHE_DIR)));
/** One reviewer too: it runs one review at a time and remembers the ones running */
const reviews = () =>
  (reviewer ??= new TimelapseReviewer(
    path.resolve(env.TIMELAPSE_CACHE_DIR, 'reviews'),
    new FfmpegFrames(ffmpegInstaller.path),
    new OllamaVision(env.OLLAMA_URL, env.TIMELAPSE_AI_MODEL)
  ));
const journal = () => journalOverride ?? new PrintJournal(path.resolve(env.PRINT_HISTORY_DIR));
const sessionStore = () => sessionStoreOverride ?? new AiSessionStore(path.resolve(env.STUDIO_AI_DATA_DIR));

/** Tests use their own library, reviewer, print history and AI sessions; null restores the defaults */
export function setTimelapseStores(
  lib: TimelapseLibrary | null,
  prints: PrintJournal | null = null,
  review: TimelapseReviewer | null = null,
  sessions: AiSessionStore | null = null
): void {
  library = lib;
  journalOverride = prints;
  reviewer = review;
  sessionStoreOverride = sessions;
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

const reviewBodySchema = z.object({
  // The print the video shows, when the gateway could not pair them by time (the printer's clock drifts)
  print_id: z.string().refine(isPrintId, 'không phải mã bản in').nullable().default(null),
});

/** The model, and the outcome and issue names a review uses, beside its state */
const reviewInfo = () => ({
  model: env.TIMELAPSE_AI_MODEL,
  outcomes: Object.entries(PRINT_OUTCOME_LABELS).map(([id, label]) => ({ id, label })),
  issues: Object.entries(PRINT_ISSUE_LABELS).map(([id, label]) => ({ id, label })),
});

// GET /api/timelapse/:name/review - The local AI's review of the video: none, running, failed or done
export const getTimelapseReview = handler<{ name: string }>(async ({ params }) => {
  if (!isVideoName(params.name)) return notFound();
  return json({ success: true, ...reviewInfo(), ...(await reviews().state(params.name)) });
});

const invalidPayload = (error: z.ZodError) => {
  const issue = error.issues[0];
  return json({ success: false, error: 'INVALID_PAYLOAD', message: `${issue.path.join('.') || '(gốc)'}: ${issue.message}` }, 400);
};

// POST /api/timelapse/:name/review {print_id?} - Has the local vision model (Ollama) review the video. The
// review is only shown: POST .../review/use puts it to use for later prints
export const startTimelapseReview = handler<{ name: string }>(async ({ request, params }) => {
  if (!isVideoName(params.name)) return notFound();
  const body = reviewBodySchema.safeParse((await readJsonBody(request).catch(() => null)) ?? {});
  if (!body.success) return invalidPayload(body.error);
  let videos;
  try {
    videos = await timelapses().list();
  } catch (err) {
    return printerUnreachable(err);
  }
  const video = videos.find((v) => v.name === params.name);
  if (!video) return notFound();

  const prints = journal();
  const print = body.data.print_id ? await prints.get(body.data.print_id) : matchPrint(video, await prints.list(500));
  if (body.data.print_id && !print) {
    return json({ success: false, error: 'PRINT_NOT_FOUND', message: 'Không tìm thấy bản in này.' }, 404);
  }
  void reviews().start(
    video.name,
    async () => {
      const file = await timelapses().video(video.name);
      if (!file) throw new Error('Máy in không còn video này.');
      return file;
    },
    print
  );
  return json({ success: true, ...reviewInfo(), ...(await reviews().state(video.name)) }, 202);
});

const noReview = () => json({ success: false, error: 'REVIEW_NOT_FOUND', message: 'Video này chưa có nhận xét của AI.' }, 404);

/** Puts the review on the print and its AI proposal, or takes it off (null) */
async function copyToPrint(printId: string, review: TimelapseReview | null): Promise<void> {
  const print = await journal().update(printId, (r) => {
    if (review) r.video_review = review;
    else delete r.video_review;
  });
  // The AI proposal keeps it too: its past prints are what "AI tối ưu" reads
  const sessionId = print?.setup?.ai_session_id;
  if (sessionId) await sessionStore().saveVideoReview(sessionId, review);
}

// POST /api/timelapse/:name/review/use {print_id?} - Uses the review for later prints: it is saved on the print
// (the one it was made for, or print_id) and its AI proposal, where "AI tối ưu" reads it
export const useTimelapseReview = handler<{ name: string }>(async ({ request, params }) => {
  if (!isVideoName(params.name)) return notFound();
  const body = reviewBodySchema.safeParse((await readJsonBody(request).catch(() => null)) ?? {});
  if (!body.success) return invalidPayload(body.error);
  const state = await reviews().state(params.name);
  if (state.status !== 'done') return noReview();
  const printId = body.data.print_id ?? state.review.print_id;
  if (!printId) {
    return json({ success: false, error: 'PRINT_REQUIRED', message: 'Chọn bản in của video này trước.' }, 400);
  }
  if (!(await journal().get(printId))) {
    return json({ success: false, error: 'PRINT_NOT_FOUND', message: 'Không tìm thấy bản in này.' }, 404);
  }
  // A review moved to another print leaves the one it was on
  if (state.review.used && state.review.used.print_id !== printId) await copyToPrint(state.review.used.print_id, null);
  const review = await reviews().setUsed(params.name, { at: new Date().toISOString(), print_id: printId });
  await copyToPrint(printId, review);
  return json({ success: true, ...reviewInfo(), status: 'done', review });
});

// DELETE /api/timelapse/:name/review/use - Stops using the review for later prints (the review itself stays)
export const unuseTimelapseReview = handler<{ name: string }>(async ({ params }) => {
  if (!isVideoName(params.name)) return notFound();
  const state = await reviews().state(params.name);
  if (state.status !== 'done') return noReview();
  if (state.review.used) await copyToPrint(state.review.used.print_id, null);
  const review = await reviews().setUsed(params.name, null);
  return json({ success: true, ...reviewInfo(), status: 'done', review });
});
