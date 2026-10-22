import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { z } from 'zod';
import { settingRef, type AiOptimizeResult, type PastPrint, type StudioRequest } from './aiOptimize';

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
  changes: z
    .array(
      z.object({
        key: z.string().max(100),
        value: z.string().max(200),
        // Filament changes only, as in the proposal
        target: z.literal('filament').optional(),
        filament: z.number().int().optional(),
      })
    )
    .max(800),
});
type AppliedChange = z.infer<typeof appliedSchema>['changes'][number];

export interface AiSession {
  id: string;
  created_at: string;
  /** The session this one re-asked, with the comment the user gave on it */
  previous_id: string | null;
  comment: string | null;
  goal: StudioRequest['goal'];
  printer_preset: string;
  process_preset: string;
  /** Missing in sessions saved before past prints went into the prompt, as are the areas below */
  nozzle_diameters?: number[];
  filaments: StudioRequest['filaments'];
  objects: {
    name: string;
    size_mm: [number, number, number];
    surface_area_mm2?: number;
    overhang_area_mm2?: number;
  }[];
  /** Values the proposal was made against, for the settings it touched, by settingRef */
  settings_before: Record<string, string>;
  result: AiOptimizeResult;
  applied: { at: string; changes: AppliedChange[] } | null;
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
    const before: Record<string, string> = {};
    for (const c of [...result.changes, ...result.rejected]) {
      const settings = c.target === 'filament' ? request.filaments[(c.filament ?? 0) - 1]?.settings : request.settings;
      const value = settings?.[c.key];
      if (value !== undefined) before[settingRef(c)] = value;
    }
    const session: AiSession = {
      id: newSessionId(now),
      created_at: now.toISOString(),
      previous_id: followUp?.previousId ?? null,
      comment: followUp?.comment ?? null,
      goal: request.goal,
      printer_preset: request.printer_preset,
      process_preset: request.process_preset,
      nozzle_diameters: request.nozzle_diameters,
      filaments: request.filaments,
      objects: request.objects.map((o) => ({
        name: o.name,
        size_mm: o.size_mm,
        surface_area_mm2: o.surface_area_mm2,
        overhang_area_mm2: o.overhang_area_mm2,
      })),
      settings_before: before,
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

  /** The newest `limit` sessions, newest first */
  private async newest(limit: number): Promise<AiSession[]> {
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
    return sessions.filter((s): s is AiSession => s !== null);
  }

  /** Newest first */
  async list(limit: number): Promise<AiSessionSummary[]> {
    return (await this.newest(limit)).map((s) => ({
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

  /**
   * Earlier prints of plates like `request`, for the prompt: only sessions the user applied and then
   * reported on, so the changes are known to have been printed. Most similar first, newest on a tie.
   */
  async pastPrints(request: StudioRequest, limit = PAST_PRINT_LIMIT): Promise<PastPrint[]> {
    const plate = plateOf(request);
    return (await this.newest(PAST_PRINT_SCAN))
      .filter((s) => s.applied && s.feedback)
      .map((s) => ({ session: s, score: similarity(plate, plateOf(s), request, s) }))
      .filter((c): c is { session: AiSession; score: number } => c.score !== null)
      // Stable sort over the newest-first list keeps newer sessions first on a tie
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ session: s }) => toPastPrint(s));
  }

  async markApplied(id: string, changes: AppliedChange[], now = new Date()): Promise<AiSession | null> {
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

// The newest sessions searched for past prints, and how many go into a prompt
const PAST_PRINT_SCAN = 300;
const PAST_PRINT_LIMIT = 5;
const NOTE_LIMIT = 300;

interface PlateShape {
  materials: Set<string>;
  /** Tallest object, mm */
  height: number;
  /** Share of the surface that overhangs, or null when the areas are unknown */
  overhang: number | null;
}

type PlateSource = { filaments: StudioRequest['filaments']; objects: AiSession['objects'] };

function plateOf({ filaments, objects }: PlateSource): PlateShape {
  const surface = objects.reduce((sum, o) => sum + (o.surface_area_mm2 ?? NaN), 0);
  const overhang = objects.reduce((sum, o) => sum + (o.overhang_area_mm2 ?? NaN), 0);
  return {
    // A filament without a type is matched by its preset name
    materials: new Set(filaments.map((f) => (f.type ?? f.preset).trim().toUpperCase())),
    height: Math.max(0, ...objects.map((o) => o.size_mm[2])),
    overhang: surface > 0 && Number.isFinite(overhang) ? overhang / surface : null,
  };
}

const sameNumbers = (a: number[], b: number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

/**
 * How alike two plates are, or null when the earlier print says nothing about this one: no material in
 * common, or a different nozzle. What went right or wrong with PLA is no lesson for PETG.
 */
function similarity(plate: PlateShape, past: PlateShape, request: StudioRequest, session: AiSession): number | null {
  if (plate.materials.size > 0 && ![...plate.materials].some((m) => past.materials.has(m))) return null;
  if (session.nozzle_diameters && !sameNumbers(session.nozzle_diameters, request.nozzle_diameters)) return null;

  let score = 0;
  if (plate.materials.size === past.materials.size && [...plate.materials].every((m) => past.materials.has(m))) score += 1;
  if (session.process_preset === request.process_preset) score += 3;
  if (session.goal === request.goal) score += 2;
  if (plate.height > 0 && past.height > 0) {
    const ratio = Math.max(plate.height, past.height) / Math.min(plate.height, past.height);
    score += ratio <= 1.5 ? 2 : ratio <= 3 ? 1 : 0;
  }
  if (plate.overhang !== null && past.overhang !== null) {
    const diff = Math.abs(plate.overhang - past.overhang);
    score += diff <= 0.05 ? 2 : diff <= 0.15 ? 1 : 0;
  }
  return score;
}

function toPastPrint(s: AiSession): PastPrint {
  const feedback = s.feedback!;
  const note = feedback.note.trim();
  return {
    created_at: s.created_at,
    goal: s.goal,
    process_preset: s.process_preset,
    filaments: s.filaments.map((f) => (f.type ? `${f.preset} (${f.type})` : f.preset)),
    objects: s.objects.map((o) => `${o.name} ${o.size_mm.map((n) => Math.round(n)).join('×')} mm`),
    changes: s.applied!.changes.map((c) => {
      const ref = settingRef(c);
      const label = s.result.changes.find((p) => settingRef(p) === ref)?.label;
      return { key: ref, ...(label ? { label } : {}), before: s.settings_before[ref] ?? null, after: c.value };
    }),
    outcome: PRINT_OUTCOME_LABELS[feedback.outcome],
    issues: feedback.issues.map((i) => PRINT_ISSUE_LABELS[i]),
    note: note.length > NOTE_LIMIT ? `${note.slice(0, NOTE_LIMIT)}…` : note,
  };
}
