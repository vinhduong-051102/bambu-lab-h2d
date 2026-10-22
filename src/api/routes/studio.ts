import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import {
  AiOptimizeError,
  aiProposalSchema,
  buildPrompts,
  checkProposal,
  claudeProposalSource,
  optimizeSettings,
  PROPOSAL_JSON_SCHEMA,
  studioRequestSchema,
  type AiOptimizeResult,
  type FollowUp,
  type ProposalSource,
  type StudioRequest,
} from '../../domain/studio/aiOptimize';
import { AiSessionStore, appliedSchema, feedbackSchema, PRINT_ISSUE_LABELS, PRINT_OUTCOME_LABELS } from '../../domain/studio/aiSessions';
import { handler, json, readJsonBody } from '../http';

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

let proposalSourceOverride: ProposalSource | null = null;
let sessionStoreOverride: AiSessionStore | null = null;

/** Tests replace the Claude call with a canned proposal; null restores it */
export function setAiProposalSource(source: ProposalSource | null): void {
  proposalSourceOverride = source;
}

/** Tests keep sessions in a temporary folder; null restores STUDIO_AI_DATA_DIR */
export function setAiSessionStore(store: AiSessionStore | null): void {
  sessionStoreOverride = store;
}

const sessionStore = () => sessionStoreOverride ?? new AiSessionStore(path.resolve(env.STUDIO_AI_DATA_DIR));

/** The plate description Studio wrote, or the 400 response explaining what is wrong with it */
function parseStudioRequest(body: unknown): StudioRequest | Response {
  const parsed = studioRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  return json(
    { success: false, error: 'INVALID_PAYLOAD', message: `Dữ liệu từ Studio không hợp lệ: ${issue.path.join('.') || '(gốc)'} ${issue.message}` },
    400
  );
}

/** For "Hỏi lại AI": the proposal being answered (null once its session is gone) and the user's comment */
async function loadFollowUp(request: StudioRequest): Promise<FollowUp | null> {
  if (!request.follow_up) return null;
  const previous = await sessionStore().get(request.follow_up.session_id);
  return {
    previous: previous && { summary: previous.result.summary, changes: previous.result.changes },
    comment: request.follow_up.comment,
  };
}

/** Keeps the checked answer as a session; the response carries its id for Studio */
async function answerWithSession(request: StudioRequest, result: AiOptimizeResult): Promise<Response> {
  const followUp = request.follow_up ? { previousId: request.follow_up.session_id, comment: request.follow_up.comment } : null;
  const session = await sessionStore().create(request, result, followUp);
  return json({ success: true, session_id: session.id, ...result });
}

const hasClaudeCredentials = () => !!(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());

// POST /api/studio/ai-optimize - Studio's "AI tối ưu" button: plate description in, checked setting changes out
export const aiOptimize = handler(async ({ request, printerService }) => {
  if (!proposalSourceOverride && !hasClaudeCredentials()) {
    return json({ success: false, error: 'AI_DISABLED', message: 'Chưa cấu hình ANTHROPIC_API_KEY cho gateway.' }, 501);
  }
  const parsed = parseStudioRequest(await readJsonBody(request));
  if (parsed instanceof Response) return parsed;

  const source = proposalSourceOverride ?? claudeProposalSource(env.STUDIO_AI_MODEL);
  let result: AiOptimizeResult;
  try {
    result = await optimizeSettings(parsed, printerService.stateStore.getState(), source, await loadFollowUp(parsed));
  } catch (err) {
    if (err instanceof AiOptimizeError) {
      return json({ success: false, error: err.code, message: err.message }, 502);
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return json({ success: false, error: 'AI_AUTH_FAILED', message: 'ANTHROPIC_API_KEY không hợp lệ.' }, 502);
    }
    if (err instanceof Anthropic.RateLimitError) {
      return json({ success: false, error: 'AI_RATE_LIMITED', message: 'AI đang quá tải, thử lại sau ít phút.' }, 503);
    }
    if (err instanceof Anthropic.APIError) {
      return json({ success: false, error: 'AI_API_ERROR', message: `Lỗi từ Claude API (${err.status ?? 'mạng'}): ${err.message}` }, 502);
    }
    throw err;
  }
  return answerWithSession(parsed, result);
});

// POST /api/studio/ai-optimize/prompt - The prompts and output schema for a plate, for `claude -p` in Studio's
// container (signed in with a Claude subscription instead of the gateway's ANTHROPIC_API_KEY)
export const aiOptimizePrompt = handler(async ({ request, printerService }) => {
  const parsed = parseStudioRequest(await readJsonBody(request));
  if (parsed instanceof Response) return parsed;
  const prompts = buildPrompts(parsed, printerService.stateStore.getState(), await loadFollowUp(parsed));
  return json({ success: true, ...prompts, schema: PROPOSAL_JSON_SCHEMA });
});

// POST /api/studio/ai-optimize/check - {request, proposal}: the same checks as ai-optimize, on a proposal made elsewhere
export const aiOptimizeCheck = handler(async ({ request }) => {
  const body = (await readJsonBody(request)) as { request?: unknown; proposal?: unknown } | null;
  const parsed = parseStudioRequest(body?.request);
  if (parsed instanceof Response) return parsed;
  const proposal = aiProposalSchema.safeParse(body?.proposal);
  if (!proposal.success) {
    return json({ success: false, error: 'AI_NO_OUTPUT', message: 'AI không trả về kết quả hợp lệ.' }, 400);
  }
  return answerWithSession(parsed, checkProposal(proposal.data, parsed));
});

const MAX_SESSION_LIST = 100;

// GET /api/studio/ai-sessions?limit=30 - Recent AI answers, newest first, with the choices of Studio's print report
export const listAiSessions = handler(async ({ request }) => {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 30);
  const sessions = await sessionStore().list(Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_SESSION_LIST) : 30);
  return json({
    success: true,
    sessions,
    outcomes: Object.entries(PRINT_OUTCOME_LABELS).map(([id, label]) => ({ id, label })),
    issues: Object.entries(PRINT_ISSUE_LABELS).map(([id, label]) => ({ id, label })),
  });
});

const sessionNotFound = () => json({ success: false, error: 'SESSION_NOT_FOUND', message: 'Không tìm thấy lần đề xuất AI này.' }, 404);

/** A zod failure as the 400 response the session routes give */
const invalidPayload = (error: { issues: { path: (string | number)[]; message: string }[] }) => {
  const issue = error.issues[0];
  return json({ success: false, error: 'INVALID_PAYLOAD', message: `${issue.path.join('.') || '(gốc)'}: ${issue.message}` }, 400);
};

// GET /api/studio/ai-sessions/:id - One AI answer in full, with what was applied and the print report
export const getAiSession = handler<{ id: string }>(async ({ params }) => {
  const session = await sessionStore().get(params.id);
  return session ? json({ success: true, session }) : sessionNotFound();
});

// POST /api/studio/ai-sessions/:id/applied - {changes: [{key, value}]}: what Studio loaded into the process preset
export const markAiSessionApplied = handler<{ id: string }>(async ({ request, params }) => {
  const body = appliedSchema.safeParse(await readJsonBody(request));
  if (!body.success) return invalidPayload(body.error);
  const session = await sessionStore().markApplied(params.id, body.data.changes);
  return session ? json({ success: true, applied_at: session.applied?.at }) : sessionNotFound();
});

// POST /api/studio/ai-sessions/:id/feedback - {outcome, issues, note}: how the print with these settings came out
export const saveAiSessionFeedback = handler<{ id: string }>(async ({ request, params }) => {
  const body = feedbackSchema.safeParse(await readJsonBody(request));
  if (!body.success) return invalidPayload(body.error);
  const session = await sessionStore().saveFeedback(params.id, body.data);
  return session ? json({ success: true, feedback_at: session.feedback?.at }) : sessionNotFound();
});
