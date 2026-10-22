import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { z } from 'zod';
import type { AiOptimizeResult, StudioRequest } from './aiOptimize';

/**
 * Every "AI tối ưu" answer is kept as a session (one JSON file each): what was on the plate, what the AI
 * proposed and why, the user's comment when it was a re-ask, which changes the user applied, and the
 * user's report on how the print came out. Studio lists sessions in its print report dialog.
 */

const OUTCOMES = ['success', 'usable', 'failed'] as const;
const ISSUES = [
  'warping', 'adhesion', 'support_removal', 'support_surface', 'overhang', 'stringing', 'layer_shift',
  'weak', 'under_extrusion', 'surface', 'dimension', 'too_slow', 'too_much_material',
] as const;

/** How the print came out, as offered in Studio's report dialog */
export const PRINT_OUTCOME_LABELS: Record<(typeof OUTCOMES)[number], string> = {
  success: 'Thành công',
  usable: 'Có lỗi nhưng dùng được',
  failed: 'Hỏng, phải in lại',
};

/** Problems the user can tick; Studio shows them as checkboxes, so changing this list needs no rebuild */
export const PRINT_ISSUE_LABELS: Record<(typeof ISSUES)[number], string> = {
  warping: 'Cong vênh, bong khỏi bàn',
  adhesion: 'Lớp đầu không bám',
  support_removal: 'Support khó gỡ',
  support_surface: 'Mặt tiếp xúc support xấu',
  overhang: 'Phần nhô bị chảy, xệ',
  stringing: 'Kéo sợi (stringing)',
  layer_shift: 'Lệch lớp',
  weak: 'Yếu, nứt, tách lớp',
  under_extrusion: 'Thiếu nhựa, hở',
  surface: 'Bề mặt, đường nối xấu',
  dimension: 'Sai kích thước, lắp không vừa',
  too_slow: 'In quá lâu',
  too_much_material: 'Tốn nhựa hơn cần',
};

export const feedbackSchema = z.object({
  outcome: z.enum(OUTCOMES),
  issues: z.array(z.enum(ISSUES)).max(ISSUES.length).default([]),
  note: z.string().max(4000).default(''),
});
export type PrintFeedback = z.infer<typeof feedbackSchema>;

export const appliedSchema = z.object({
  changes: z.array(z.object({ key: z.string().max(100), value: z.string().max(200) })).max(200),
});

export interface AiSession {
  id: string;
  created_at: string;
  /** The session this one re-asked, with the comment the user gave on it */
  previous_id: string | null;
  comment: string | null;
  goal: StudioRequest['goal'];
  printer_preset: string;
  process_preset: string;
  filaments: StudioRequest['filaments'];
  objects: { name: string; size_mm: [number, number, number] }[];
  /** Values the proposal was made against, for the keys it touched */
  settings_before: Record<string, string>;
  result: AiOptimizeResult;
  applied: { at: string; changes: { key: string; value: string }[] } | null;
  feedback: (PrintFeedback & { at: string }) | null;
}

/** One line of the session list Studio shows */
export interface AiSessionSummary {
  id: string;
  created_at: string;
  objects: string[];
  process_preset: string;
  filaments: string[];
  summary: string;
  change_count: number;
  comment: string | null;
  applied_at: string | null;
  feedback_outcome: PrintFeedback['outcome'] | null;
}

// 20261022-141503-a1b2c3: sortable by time, and safe as a file name
const SESSION_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

export const isSessionId = (id: string) => SESSION_ID_RE.test(id);

function newSessionId(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

export class AiSessionStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!isSessionId(id)) throw new Error(`Invalid AI session id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  private async write(session: AiSession): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    // Written beside the target first, so a crash never leaves half a session behind
    const target = this.file(session.id);
    await fs.writeFile(`${target}.part`, JSON.stringify(session, null, 1));
    await fs.rename(`${target}.part`, target);
  }

  async create(
    request: StudioRequest,
    result: AiOptimizeResult,
    followUp: { previousId: string; comment: string } | null,
    now = new Date()
  ): Promise<AiSession> {
    const touched = new Set([...result.changes.map((c) => c.key), ...result.rejected.map((r) => r.key)]);
    const session: AiSession = {
      id: newSessionId(now),
      created_at: now.toISOString(),
      previous_id: followUp?.previousId ?? null,
      comment: followUp?.comment ?? null,
      goal: request.goal,
      printer_preset: request.printer_preset,
      process_preset: request.process_preset,
      filaments: request.filaments,
      objects: request.objects.map((o) => ({ name: o.name, size_mm: o.size_mm })),
      settings_before: Object.fromEntries(Object.entries(request.settings).filter(([key]) => touched.has(key))),
      result,
      applied: null,
      feedback: null,
    };
    await this.write(session);
    return session;
  }

  /** The session, or null when there is no such id */
  async get(id: string): Promise<AiSession | null> {
    if (!isSessionId(id)) return null;
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as AiSession;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Newest first */
  async list(limit: number): Promise<AiSessionSummary[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const ids = names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter(isSessionId)
      .sort()
      .reverse()
      .slice(0, limit);
    const sessions = await Promise.all(ids.map((id) => this.get(id)));
    return sessions
      .filter((s): s is AiSession => s !== null)
      .map((s) => ({
        id: s.id,
        created_at: s.created_at,
        objects: s.objects.map((o) => o.name),
        process_preset: s.process_preset,
        filaments: s.filaments.map((f) => f.preset),
        summary: s.result.summary,
        change_count: s.result.changes.length,
        comment: s.comment,
        applied_at: s.applied?.at ?? null,
        feedback_outcome: s.feedback?.outcome ?? null,
      }));
  }

  async markApplied(id: string, changes: { key: string; value: string }[], now = new Date()): Promise<AiSession | null> {
    const session = await this.get(id);
    if (!session) return null;
    session.applied = { at: now.toISOString(), changes };
    await this.write(session);
    return session;
  }

  async saveFeedback(id: string, feedback: PrintFeedback, now = new Date()): Promise<AiSession | null> {
    const session = await this.get(id);
    if (!session) return null;
    session.feedback = { ...feedback, at: now.toISOString() };
    await this.write(session);
    return session;
  }
}
