import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import type { PrintRecord } from '../prints/PrintJournal';
import { PRINT_ISSUE_LABELS, PRINT_OUTCOME_LABELS } from '../studio/aiSessions';

/**
 * "AI nhận xét" on a timelapse: a vision model running locally in Ollama looks at frames of the printer's
 * timelapse and says what went wrong and what to change next time. The review is kept beside the cached
 * video; only when the user chooses to use it is it copied to the print and that print's AI proposal, where
 * "AI tối ưu" reads it with the past prints.
 *
 * The H2D records one frame per layer with the toolhead parked, so frames spread evenly through the video
 * are the print at evenly spaced heights; the last frame is the finished plate.
 */

const ISSUES = Object.keys(PRINT_ISSUE_LABELS) as [keyof typeof PRINT_ISSUE_LABELS, ...(keyof typeof PRINT_ISSUE_LABELS)[]];
const OUTCOMES = Object.keys(PRINT_OUTCOME_LABELS) as [keyof typeof PRINT_OUTCOME_LABELS, ...(keyof typeof PRINT_OUTCOME_LABELS)[]];

/** What the model answers, checked as it comes back */
export const reviewAnswerSchema = z.object({
  summary: z.string().max(2000),
  outcome_guess: z.enum(OUTCOMES),
  issues: z.array(z.enum(ISSUES)).max(ISSUES.length),
  observations: z
    .array(z.object({ frame: z.number().int(), problem: z.string().max(500) }))
    .max(20),
  suggestions: z.array(z.string().max(500)).max(10),
});
export type ReviewAnswer = z.infer<typeof reviewAnswerSchema>;

export interface TimelapseReview extends ReviewAnswer {
  video: string;
  model: string;
  at: string;
  /** The print in the history the video shows, when there is one */
  print_id: string | null;
  /** Each frame's place in the video, 0-100 % (frame numbers in observations are 1-based indexes into this) */
  frames_at: number[];
  /** When the user chose to use it for later prints, and on which print; null while it is only a review */
  used: { at: string; print_id: string } | null;
}

export type ReviewState =
  | { status: 'none' }
  | { status: 'running'; started_at: string }
  | { status: 'failed'; error: string; at: string }
  | { status: 'done'; review: TimelapseReview };

/** JSON schema Ollama constrains the answer to */
const ANSWER_FORMAT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    outcome_guess: { type: 'string', enum: OUTCOMES },
    issues: { type: 'array', items: { type: 'string', enum: ISSUES } },
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { frame: { type: 'integer' }, problem: { type: 'string' } },
        required: ['frame', 'problem'],
      },
    },
    suggestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'outcome_guess', 'issues', 'observations', 'suggestions'],
};

const SYSTEM_PROMPT = [
  'Bạn là kỹ thuật viên in 3D FDM lâu năm, đang xem timelapse của một bản in trên máy Bambu Lab H2D (2 đầu phun, buồng kín).',
  'Các ảnh là khung hình của timelapse theo thứ tự thời gian: mỗi khung chụp khi đầu in đã đỗ sang bên, nên vật in ở các độ cao tăng dần; ảnh cuối là bản in đã xong.',
  'Nhiệm vụ: tìm lỗi THẤY ĐƯỢC trong ảnh và đề xuất cách chỉnh cho lần in sau.',
  'Quy tắc:',
  '- Chỉ nêu lỗi thấy rõ: vật bong/cong góc khỏi bàn, rối sợi (spaghetti), lệch lớp, thiếu phần, support đổ, kéo sợi rõ, phần nhô xệ, vật bị đầu in xô lệch. Không đoán lỗi không nhìn thấy.',
  '- Ảnh có độ phân giải thấp: đừng chấm bề mặt mịn hay sai kích thước nhỏ trừ khi lỗi rõ ràng.',
  '- Không thấy lỗi thì issues và observations để trống, outcome_guess là "success". Đừng bịa lỗi cho có.',
  '- observations: số khung (bắt đầu từ 1) và lỗi thấy ở khung đó.',
  '- suggestions: việc cụ thể cho lần in sau (tên cài đặt Bambu Studio và hướng chỉnh, cách đặt vật, support, brim, keo bàn...), gắn với lỗi đã thấy. Không có lỗi thì có thể để trống.',
  '- Viết bằng tiếng Việt, ngắn gọn.',
].join('\n');

/** What the history knows about the print, so the model knows the material and what the user saw */
export function describePrint(print: PrintRecord | null): string[] {
  if (!print) return ['Không có thông tin về bản in này trong lịch sử.'];
  const setup = print.setup;
  const lines = [`Tên bản in: ${print.job_name}`, `Máy in báo: ${print.status === 'failed' ? 'in hỏng / bị dừng' : print.status === 'finished' ? 'in xong' : 'đang in'}`];
  if (setup) {
    lines.push(`Preset in: ${setup.process_preset}`);
    const used = setup.filaments.filter((f) => f.used !== false);
    if (used.length) lines.push(`Filament: ${used.map((f) => (f.type ? `${f.preset} (${f.type})` : f.preset)).join('; ')}`);
  }
  if (print.feedback) {
    const fb = print.feedback;
    lines.push(
      `Người dùng báo: ${PRINT_OUTCOME_LABELS[fb.outcome]}${fb.issues.length ? `; lỗi: ${fb.issues.map((i) => PRINT_ISSUE_LABELS[i]).join(', ')}` : ''}`
    );
    if (fb.note.trim()) lines.push(`Ghi chú của người dùng: ${JSON.stringify(fb.note.trim().slice(0, 500))}`);
  }
  return lines;
}

export function buildReviewPrompt(print: PrintRecord | null, framesAt: number[]): string {
  return [
    ...describePrint(print),
    '',
    `Có ${framesAt.length} khung hình, ở các vị trí ${framesAt.map((p, i) => `#${i + 1} ${p}%`).join(', ')} của timelapse.`,
    `Mã lỗi dùng cho issues: ${ISSUES.map((i) => `${i} (${PRINT_ISSUE_LABELS[i]})`).join('; ')}.`,
    `outcome_guess: success (${PRINT_OUTCOME_LABELS.success}), usable (${PRINT_OUTCOME_LABELS.usable}), failed (${PRINT_OUTCOME_LABELS.failed}).`,
    'Trả lời bằng JSON theo schema.',
  ].join('\n');
}

/** Places (0-100 %) of `count` frames spread over the video, the last one at the very end */
export function framePlaces(count: number): number[] {
  if (count <= 1) return [100];
  return Array.from({ length: count }, (_, i) => Math.round((i * 100) / (count - 1)));
}

export interface FrameSource {
  /** JPEG frames at these places (0-100 %) of the video */
  frames(video: string, places: number[]): Promise<Buffer[]>;
}

export interface VisionModel {
  readonly name: string;
  review(system: string, prompt: string, images: Buffer[]): Promise<unknown>;
}

/** Frames cut with ffmpeg (the gateway's own, from @ffmpeg-installer) */
export class FfmpegFrames implements FrameSource {
  constructor(private readonly ffmpeg: string, private readonly width = 1024) {}

  private run(args: string[]): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-8000)));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
    });
  }

  async duration(video: string): Promise<number> {
    const { stderr } = await this.run(['-hide_banner', '-i', video]);
    const match = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) throw new Error('ffmpeg không đọc được độ dài video');
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }

  async frames(video: string, places: number[]): Promise<Buffer[]> {
    const seconds = await this.duration(video);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timelapse-frames-'));
    try {
      const frames: Buffer[] = [];
      for (const [i, place] of places.entries()) {
        const out = path.join(dir, `${i}.jpg`);
        // The very end has no frame to seek to: the last one is read from just before it
        const at = place >= 100 ? ['-sseof', '-0.3'] : ['-ss', ((seconds * place) / 100).toFixed(3)];
        const { code, stderr } = await this.run([
          '-v', 'error', '-y', ...at, '-i', video, '-frames:v', '1', '-vf', `scale=${this.width}:-2`, '-q:v', '3', out,
        ]);
        if (code !== 0) throw new Error(`ffmpeg không cắt được khung hình: ${stderr.trim().split('\n').pop() ?? code}`);
        frames.push(await fs.readFile(out));
      }
      return frames;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

/** A vision model in Ollama, its answer held to ANSWER_FORMAT */
export class OllamaVision implements VisionModel {
  constructor(
    private readonly baseUrl: string,
    readonly name: string,
    private readonly timeoutMs = 10 * 60 * 1000
  ) {}

  async review(system: string, prompt: string, images: Buffer[]): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(new URL('/api/chat', this.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.name,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt, images: images.map((img) => img.toString('base64')) },
          ],
          format: ANSWER_FORMAT,
          // Streamed, so a long answer never trips the HTTP client's wait for the response headers
          stream: true,
          options: { temperature: 0.2, num_ctx: 16384 },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`Không gọi được Ollama ở ${this.baseUrl} (đã chạy Ollama chưa?): ${err instanceof Error ? err.message : err}`);
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      if (res.status === 404) throw new Error(`Ollama chưa có model ${this.name}: chạy "ollama pull ${this.name}"`);
      throw new Error(`Ollama trả lỗi ${res.status}: ${detail.slice(0, 300)}`);
    }
    let content = '';
    let pending = '';
    const decoder = new TextDecoder();
    const take = (line: string) => {
      if (!line.trim()) return;
      const chunk = JSON.parse(line) as { message?: { content?: string }; error?: string };
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
      content += chunk.message?.content ?? '';
    };
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(part, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(take);
    }
    take(pending);
    try {
      return JSON.parse(content);
    } catch {
      throw new Error(`Model trả lời không phải JSON: ${content.slice(0, 200)}`);
    }
  }
}

/**
 * Runs reviews one at a time (the GPU holds one vision model) and keeps each in <dir>/<video>.json.
 * A failed run is remembered until the next try, so the dashboard can say why.
 */
export class TimelapseReviewer {
  private running = new Map<string, string>();
  private failed = new Map<string, { error: string; at: string }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly frameSource: FrameSource,
    private readonly model: VisionModel,
    private readonly frameCount = 10,
    private readonly now: () => Date = () => new Date()
  ) {}

  private file(video: string): string {
    return path.join(this.dir, `${video}.json`);
  }

  async state(video: string): Promise<ReviewState> {
    const started = this.running.get(video);
    if (started) return { status: 'running', started_at: started };
    const failed = this.failed.get(video);
    if (failed) return { status: 'failed', ...failed };
    try {
      return { status: 'done', review: JSON.parse(await fs.readFile(this.file(video), 'utf8')) as TimelapseReview };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'none' };
      throw err;
    }
  }

  private async write(review: TimelapseReview): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(`${this.file(review.video)}.part`, JSON.stringify(review, null, 1));
    await fs.rename(`${this.file(review.video)}.part`, this.file(review.video));
  }

  /** Records whether the finished review is used for later prints (null: no longer); null when there is none */
  async setUsed(video: string, used: TimelapseReview['used']): Promise<TimelapseReview | null> {
    const state = await this.state(video);
    if (state.status !== 'done') return null;
    const review = { ...state.review, used };
    await this.write(review);
    return review;
  }

  /**
   * Starts a review of `video` unless one is running; `localFile` gives the cached video. A new review is
   * only a review: it is not used for later prints until the user says so. Resolves when the review ends.
   */
  start(video: string, localFile: () => Promise<string>, print: PrintRecord | null): Promise<void> {
    if (this.running.has(video)) return Promise.resolve();
    this.running.set(video, this.now().toISOString());
    this.failed.delete(video);
    const job = this.queue.then(async () => {
      try {
        const places = framePlaces(this.frameCount);
        const frames = await this.frameSource.frames(await localFile(), places);
        const raw = await this.model.review(SYSTEM_PROMPT, buildReviewPrompt(print, places), frames);
        const answer = reviewAnswerSchema.parse(raw);
        const review: TimelapseReview = {
          video,
          model: this.model.name,
          at: this.now().toISOString(),
          print_id: print?.id ?? null,
          frames_at: places,
          ...answer,
          // Frames the model made up are dropped
          observations: answer.observations.filter((o) => o.frame >= 1 && o.frame <= places.length),
          used: null,
        };
        await this.write(review);
      } catch (err) {
        this.failed.set(video, { error: err instanceof Error ? err.message : String(err), at: this.now().toISOString() });
      } finally {
        this.running.delete(video);
      }
    });
    this.queue = job;
    return job;
  }
}
