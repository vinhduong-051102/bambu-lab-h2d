import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { z } from 'zod';
import { studioRequestSchema } from '../studio/aiOptimize';
import type { PrintFeedback } from '../studio/aiSessions';
import type { TimelapseReview } from '../timelapse/TimelapseReviewer';

/**
 * Print history: one folder per print with record.json and its photos (the printer camera's shot when
 * the print ended, plus any the user uploads). The settings come from Bambu Studio, which posts them as
 * a "setup" when it sends the print; the recorder pairs the setup with the print by job name.
 */

/** What Studio posts when it sends a print (studio/bambustudio/ai-button.patch, SelectMachineDialog) */
export const printSetupSchema = studioRequestSchema
  .omit({ goal: true, follow_up: true })
  .extend({
    job_name: z.string().min(1).max(200),
    // The AI proposal last applied in Studio before this print, if any
    ai_session_id: z.string().max(64).nullable().default(null),
  });
export type PrintSetup = z.infer<typeof printSetupSchema> & { received_at: string };

/** unknown: the print ended while the gateway wasn't running, and the printer had moved on to another job */
export type PrintStatus = 'printing' | 'finished' | 'failed' | 'unknown';

export interface PrintPhoto {
  name: string;
  source: 'camera' | 'upload';
  taken_at: string;
}

export interface PrintRecord {
  id: string;
  job_name: string;
  /** null when the gateway first saw the print already running */
  started_at: string | null;
  /** null while printing, and when the print ended while the gateway wasn't running */
  ended_at: string | null;
  status: PrintStatus;
  /** null for a print that wasn't sent from this Studio (or whose setup didn't arrive) */
  setup: PrintSetup | null;
  photos: PrintPhoto[];
  feedback: (PrintFeedback & { at: string }) | null;
  /** The name of the printer's timelapse video of this print, when it was paired by hand (see matchPrint) */
  timelapse?: string;
  /** The local AI's review of the print's timelapse, once the user chose to use it for later prints */
  video_review?: TimelapseReview;
}

export interface PrintSummary {
  id: string;
  job_name: string;
  started_at: string | null;
  ended_at: string | null;
  status: PrintStatus;
  process_preset: string | null;
  filaments: string[];
  ai_session_id: string | null;
  photos: PrintPhoto[];
  feedback_outcome: PrintFeedback['outcome'] | null;
}

export const PHOTO_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// 20261022-141503-a1b2c3, as for AI sessions: sortable by time and safe as a folder name
const ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const PHOTO_RE = /^(camera|upload)-\d{8}-\d{6}-[0-9a-f]{4}\.(jpg|png|webp)$/;
/** A setup older than this is for a print that never started */
const SETUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const isPrintId = (id: string) => ID_RE.test(id);
export const isPhotoName = (name: string) => PHOTO_RE.test(name);

function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Studio and the printer may disagree on case, spacing or a trailing .3mf/.gcode: compare without them */
const jobKey = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/(\.gcode)?(\.3mf)?$/, '')
    .replace(/\s+/g, ' ');

export class PrintJournal {
  constructor(private readonly dir: string) {}

  private folder(id: string): string {
    if (!isPrintId(id)) throw new Error(`Invalid print id: ${id}`);
    return path.join(this.dir, id);
  }

  private pendingFile(jobName: string): string {
    return path.join(this.dir, 'pending', `${createHash('sha1').update(jobKey(jobName)).digest('hex')}.json`);
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Written beside the target first, so a crash never leaves half a file behind
    await fs.writeFile(`${file}.part`, JSON.stringify(value, null, 1));
    await fs.rename(`${file}.part`, file);
  }

  private save(record: PrintRecord): Promise<void> {
    return this.writeJson(path.join(this.folder(record.id), 'record.json'), record);
  }

  /** Keeps Studio's setup until the print with that job name starts; a newer one replaces it */
  async savePendingSetup(setup: PrintSetup): Promise<void> {
    await this.writeJson(this.pendingFile(setup.job_name), setup);
  }

  /** The setup Studio sent for this job (removed once taken), or null when there is none recent enough */
  async takePendingSetup(jobName: string, now = new Date()): Promise<PrintSetup | null> {
    const file = this.pendingFile(jobName);
    let setup: PrintSetup;
    try {
      setup = JSON.parse(await fs.readFile(file, 'utf8')) as PrintSetup;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    await fs.rm(file, { force: true });
    return now.getTime() - Date.parse(setup.received_at) <= SETUP_MAX_AGE_MS ? setup : null;
  }

  async create(jobName: string, startedAt: Date | null, setup: PrintSetup | null, now = new Date()): Promise<PrintRecord> {
    const record: PrintRecord = {
      id: `${stamp(now)}-${randomBytes(3).toString('hex')}`,
      job_name: jobName,
      started_at: startedAt?.toISOString() ?? null,
      ended_at: null,
      status: 'printing',
      setup,
      photos: [],
      feedback: null,
    };
    await this.save(record);
    return record;
  }

  async get(id: string): Promise<PrintRecord | null> {
    if (!isPrintId(id)) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(this.folder(id), 'record.json'), 'utf8')) as PrintRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Applies `change` to the stored record and saves it; null when there is no such print */
  async update(id: string, change: (record: PrintRecord) => void): Promise<PrintRecord | null> {
    const record = await this.get(id);
    if (!record) return null;
    change(record);
    await this.save(record);
    return record;
  }

  /** Newest first */
  async list(limit: number): Promise<PrintRecord[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const ids = names.filter(isPrintId).sort().reverse().slice(0, limit);
    const records = await Promise.all(ids.map((id) => this.get(id)));
    return records.filter((r): r is PrintRecord => r !== null);
  }

  async addPhoto(id: string, data: Uint8Array, source: PrintPhoto['source'], ext: string, now = new Date()): Promise<PrintRecord | null> {
    if (!PHOTO_TYPES[ext]) throw new Error(`Unsupported photo type: ${ext}`);
    if (!(await this.get(id))) return null;
    const name = `${source}-${stamp(now)}-${randomBytes(2).toString('hex')}${ext}`;
    await fs.writeFile(path.join(this.folder(id), name), data);
    return this.update(id, (record) => {
      record.photos.push({ name, source, taken_at: now.toISOString() });
    });
  }

  /** Absolute path of a photo of this print, or null when the names aren't valid */
  photoPath(id: string, name: string): string | null {
    return isPrintId(id) && isPhotoName(name) ? path.join(this.folder(id), name) : null;
  }

  async removePhoto(id: string, name: string): Promise<PrintRecord | null> {
    const file = this.photoPath(id, name);
    if (!file) return null;
    const record = await this.update(id, (r) => {
      r.photos = r.photos.filter((p) => p.name !== name);
    });
    if (record) await fs.rm(file, { force: true });
    return record;
  }
}

export function summarizePrint(record: PrintRecord): PrintSummary {
  return {
    id: record.id,
    job_name: record.job_name,
    started_at: record.started_at,
    ended_at: record.ended_at,
    status: record.status,
    process_preset: record.setup?.process_preset ?? null,
    filaments: record.setup?.filaments.map((f) => f.preset) ?? [],
    ai_session_id: record.setup?.ai_session_id ?? null,
    photos: record.photos,
    feedback_outcome: record.feedback?.outcome ?? null,
  };
}
