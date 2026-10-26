import { promises as fs } from 'fs';
import path from 'path';
import { env } from '../../config/env';
import { AI_SETTINGS } from '../../domain/studio/aiOptimize';
import { PHOTO_TYPES, PrintJournal, printSetupSchema, summarizePrint } from '../../domain/prints/PrintJournal';
import { AiSessionStore, feedbackSchema, PRINT_ISSUE_LABELS, PRINT_OUTCOME_LABELS } from '../../domain/studio/aiSessions';
import { handler, json, readJsonBody } from '../http';

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_PRINT_LIST = 200;

let journalOverride: PrintJournal | null = null;
let sessionStoreOverride: AiSessionStore | null = null;

/** Tests keep the print history (and the AI sessions reports are copied to) in temporary folders */
export function setPrintStores(journal: PrintJournal | null, sessions: AiSessionStore | null = null): void {
  journalOverride = journal;
  sessionStoreOverride = sessions;
}

const journal = () => journalOverride ?? new PrintJournal(path.resolve(env.PRINT_HISTORY_DIR));
const sessionStore = () => sessionStoreOverride ?? new AiSessionStore(path.resolve(env.STUDIO_AI_DATA_DIR));

const notFound = () => json({ success: false, error: 'PRINT_NOT_FOUND', message: 'Không tìm thấy bản in này.' }, 404);

const invalidPayload = (error: { issues: { path: PropertyKey[]; message: string }[] }) => {
  const issue = error.issues[0];
  return json({ success: false, error: 'INVALID_PAYLOAD', message: `${issue.path.join('.') || '(gốc)'}: ${issue.message}` }, 400);
};

// GET /api/prints?limit=50 - Print history, newest first, with the report choices (outcomes, issues)
export const listPrints = handler(async ({ request }) => {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 50);
  const records = await journal().list(Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_PRINT_LIST) : 50);
  return json({
    success: true,
    prints: records.map(summarizePrint),
    outcomes: Object.entries(PRINT_OUTCOME_LABELS).map(([id, label]) => ({ id, label })),
    issues: Object.entries(PRINT_ISSUE_LABELS).map(([id, label]) => ({ id, label })),
    // Vietnamese names of the settings the AI tunes, for comparing prints
    setting_labels: Object.fromEntries(Object.entries(AI_SETTINGS).map(([key, spec]) => [key, spec.label])),
  });
});

// GET /api/prints/:id - One print in full: the settings Studio sent, photos and report
export const getPrint = handler<{ id: string }>(async ({ params }) => {
  const record = await journal().get(params.id);
  return record ? json({ success: true, print: record }) : notFound();
});

// POST /api/prints/setup - Bambu Studio, when it sends a print: the presets and settings it was sliced with
export const savePrintSetup = handler(async ({ request }) => {
  const body = printSetupSchema.safeParse(await readJsonBody(request));
  if (!body.success) return invalidPayload(body.error);
  await journal().savePendingSetup({ ...body.data, received_at: new Date().toISOString() });
  return json({ success: true });
});

// POST /api/prints/:id/feedback - {outcome, issues, note}: the report on this print, copied to its AI proposal
export const savePrintFeedback = handler<{ id: string }>(async ({ request, params }) => {
  const body = feedbackSchema.safeParse(await readJsonBody(request));
  if (!body.success) return invalidPayload(body.error);
  const at = new Date();
  const record = await journal().update(params.id, (r) => {
    r.feedback = { ...body.data, at: at.toISOString() };
  });
  if (!record) return notFound();
  // The AI proposal's own report, so the AI's track record stays in one place
  const sessionId = record.setup?.ai_session_id;
  if (sessionId) await sessionStore().saveFeedback(sessionId, body.data, at);
  return json({ success: true, feedback_at: record.feedback?.at });
});

// POST /api/prints/:id/photos - multipart "file": a photo of the print (JPEG, PNG or WebP)
export const uploadPrintPhoto = handler<{ id: string }>(async ({ request, params }) => {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_PHOTO_BYTES) {
    return json({ success: false, error: 'FILE_TOO_LARGE', message: 'Ảnh vượt quá 20 MB.' }, 413);
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
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.type];
  if (!ext) {
    return json({ success: false, error: 'UNSUPPORTED_FILE_TYPE', message: 'Chỉ nhận ảnh JPEG, PNG hoặc WebP.' }, 415);
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return json({ success: false, error: 'FILE_TOO_LARGE', message: 'Ảnh vượt quá 20 MB.' }, 413);
  }
  const record = await journal().addPhoto(params.id, new Uint8Array(await file.arrayBuffer()), 'upload', ext);
  return record ? json({ success: true, photo: record.photos[record.photos.length - 1] }, 201) : notFound();
});

// GET /api/prints/:id/photos/:name - The photo itself
export const getPrintPhoto = handler<{ id: string; name: string }>(async ({ params }) => {
  const file = journal().photoPath(params.id, params.name);
  if (!file) return notFound();
  try {
    const data = await fs.readFile(file);
    return new Response(new Uint8Array(data), {
      headers: { 'Content-Type': PHOTO_TYPES[path.extname(file)], 'Cache-Control': 'private, max-age=86400, immutable' },
    });
  } catch {
    return notFound();
  }
});

// DELETE /api/prints/:id/photos/:name - Removes a photo from the print
export const deletePrintPhoto = handler<{ id: string; name: string }>(async ({ params }) => {
  const record = await journal().removePhoto(params.id, params.name);
  return record ? json({ success: true }) : notFound();
});
