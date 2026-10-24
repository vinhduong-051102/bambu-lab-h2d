import { promises as fs } from 'fs';
import path from 'path';
import type { PrinterFileStorage } from '../../bambu/BambuFtpClient';

/**
 * Timelapse videos the printer records in /timelapse on its storage (video_<date>_<time>.mp4, with a
 * thumbnail of the same name in /timelapse/thumbnail). Videos and thumbnails are copied to a local cache
 * the first time they are watched, so the dashboard can seek in them without going back to the printer.
 */

export interface TimelapseVideo {
  name: string;
  size: number;
  /** When the printer finished writing the video, i.e. about when the print ended (ISO); null when unknown */
  ended_at: string | null;
  /** The date and time in the file name, as the printer's clock wrote it (its own time zone) */
  name_time: string | null;
  has_thumbnail: boolean;
}

const VIDEO_DIR = '/timelapse';
const THUMBNAIL_DIR = '/timelapse/thumbnail';
const VIDEO_RE = /^[\w.-]+\.(mp4|avi)$/i;
/** The printer's listing is cached this long: every dashboard refresh would otherwise open an FTPS session */
const LIST_TTL_MS = 30_000;

export const isVideoName = (name: string) => VIDEO_RE.test(name) && !name.startsWith('.');
const thumbnailName = (video: string) => video.replace(/\.[^.]+$/, '.jpg');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The time of a printer listing entry. Bambu's FTP server sends Unix `ls` dates in UTC: "Oct 11 16:51" for
 * the last six months (no year: the latest such date not after `now`), "Oct 11  2025" before that.
 * An ISO date (from MLSD) passes through.
 */
export function parseListingTime(raw: string | null, now = new Date()): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw;
  const match = raw.trim().match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(?:(\d{1,2}):(\d{2})|(\d{4}))$/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  if (month < 0) return null;
  const day = Number(match[2]);
  if (match[5]) return new Date(Date.UTC(Number(match[5]), month, day)).toISOString();
  const [hour, minute] = [Number(match[3]), Number(match[4])];
  let date = new Date(Date.UTC(now.getUTCFullYear(), month, day, hour, minute));
  // A date in the future belongs to last year (a December file listed in January)
  if (date.getTime() > now.getTime() + 24 * 3600 * 1000) date = new Date(Date.UTC(now.getUTCFullYear() - 1, month, day, hour, minute));
  return date.toISOString();
}

/** "video_2026-10-12_00-32-49.mp4" → "2026-10-12 00:32:49" */
export function nameTime(name: string): string | null {
  const match = name.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}` : null;
}

export class TimelapseLibrary {
  private listing: { at: number; videos: TimelapseVideo[] } | null = null;
  private downloads = new Map<string, Promise<string>>();

  constructor(
    private readonly storage: () => PrinterFileStorage,
    private readonly cacheDir: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Newest first */
  async list(force = false): Promise<TimelapseVideo[]> {
    if (!force && this.listing && this.now().getTime() - this.listing.at < LIST_TTL_MS) return this.listing.videos;
    const storage = this.storage();
    const entries = await storage.list(VIDEO_DIR);
    let thumbnails = new Set<string>();
    if (entries.some((e) => e.isDirectory && e.name === 'thumbnail')) {
      try {
        thumbnails = new Set((await storage.list(THUMBNAIL_DIR)).map((e) => e.name));
      } catch {
        // Videos are still listed without their thumbnails
      }
    }
    const videos = entries
      .filter((e) => !e.isDirectory && isVideoName(e.name))
      .map((e) => ({
        name: e.name,
        size: e.size,
        ended_at: parseListingTime(e.modifiedAt, this.now()),
        name_time: nameTime(e.name),
        has_thumbnail: thumbnails.has(thumbnailName(e.name)),
      }))
      .sort((a, b) => (b.ended_at ?? b.name).localeCompare(a.ended_at ?? a.name));
    this.listing = { at: this.now().getTime(), videos };
    return videos;
  }

  /** Local path of the video, copied from the printer the first time; null when the printer has no such video */
  async video(name: string): Promise<string | null> {
    const entry = (await this.list()).find((v) => v.name === name);
    if (!entry) return null;
    return this.fetch(path.posix.join(VIDEO_DIR, name), name, entry.size);
  }

  async thumbnail(name: string): Promise<string | null> {
    const entry = (await this.list()).find((v) => v.name === name);
    if (!entry?.has_thumbnail) return null;
    const thumb = thumbnailName(name);
    return this.fetch(path.posix.join(THUMBNAIL_DIR, thumb), path.join('thumbnail', thumb), null);
  }

  /** One download per file at a time; a cached copy of the expected size is used as it is */
  private fetch(remote: string, local: string, size: number | null): Promise<string> {
    const target = path.join(this.cacheDir, local);
    const running = this.downloads.get(target);
    if (running) return running;
    const job = (async () => {
      try {
        const stat = await fs.stat(target);
        if (size === null || stat.size === size) return target;
      } catch {
        // Not cached yet
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Downloaded beside the target first, so a broken transfer never looks like a finished video
      const part = `${target}.part`;
      try {
        await this.storage().download(remote, part);
        await fs.rename(part, target);
      } catch (err) {
        await fs.rm(part, { force: true });
        throw err;
      }
      return target;
    })().finally(() => this.downloads.delete(target));
    this.downloads.set(target, job);
    return job;
  }
}

/** The print whose end is closest to the video's, within `toleranceMs` */
export function matchPrint<P extends { id: string; ended_at: string | null }>(
  video: TimelapseVideo,
  prints: P[],
  toleranceMs = 20 * 60 * 1000
): P | null {
  if (!video.ended_at) return null;
  const end = Date.parse(video.ended_at);
  let best: P | null = null;
  let bestGap = toleranceMs;
  for (const print of prints) {
    if (!print.ended_at) continue;
    const gap = Math.abs(Date.parse(print.ended_at) - end);
    if (gap <= bestGap) {
      best = print;
      bestGap = gap;
    }
  }
  return best;
}
