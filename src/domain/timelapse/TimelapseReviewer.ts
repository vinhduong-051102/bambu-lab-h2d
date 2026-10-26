import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import type { PrintRecord } from '../prints/PrintJournal';
import { PRINT_ISSUE_LABELS, PRINT_OUTCOME_LABELS } from '../studio/aiSessions';

/**
 * "AI nhận xét" on a timelapse: Claude looks at frames of the printer's timelapse and says what is wrong with
 * the print and what to change next time. The review is kept beside the cached video; only when the user
 * chooses to use it is it copied to the print and that print's AI proposal, where "AI tối ưu" reads it with
 * the past prints.
 *
 * The H2D records one frame per layer with the toolhead parked, so frames spread through the video are the
 * print at increasing heights and the last frame is the finished plate. The print takes a small part of the
 * camera's view, so the last frame goes at the camera's full resolution: shrunk, its surface defects
 * disappear. (Local models in Ollama were tried first, Qwen3-VL 8B and 30B: they could not tell a print with
 * wavy walls and a rough top from a clean one, and answered differently each run.)
 */

const ISSUES = Object.keys(PRINT_ISSUE_LABELS) as [keyof typeof PRINT_ISSUE_LABELS, ...(keyof typeof PRINT_ISSUE_LABELS)[]];
const OUTCOMES = Object.keys(PRINT_OUTCOME_LABELS) as [keyof typeof PRINT_OUTCOME_LABELS, ...(keyof typeof PRINT_OUTCOME_LABELS)[]];

/** Where the frames are taken (0-100 % of the video): three while printing, then the finished print */
export const FRAME_PLACES = [25, 50, 75, 100];
/** The frames while printing are this wide; the finished print keeps the camera's resolution */
const PROGRESS_WIDTH = 1024;

/** A text field of the answer: a model that says too much is cut short rather than refused */
const text = (max: number) => z.string().transform((s) => (s.length > max ? `${s.slice(0, max)}…` : s));

/** What the model answers, checked as it comes back */
export const reviewAnswerSchema = z.object({
  // Asked for first, so the model looks at the finished print before it judges it
  final_check: text(3000),
  summary: text(2000),
  outcome_guess: z.enum(OUTCOMES),
  issues: z.array(z.enum(ISSUES)).transform((issues) => [...new Set(issues)]),
  observations: z.array(z.object({ frame: z.number().int(), problem: text(500) })).transform((list) => list.slice(0, 20)),
  suggestions: z.array(text(500)).transform((list) => list.slice(0, 10)),
});
export type ReviewAnswer = z.infer<typeof reviewAnswerSchema>;

export interface TimelapseReview extends Omit<ReviewAnswer, 'final_check'> {
  /** Missing in reviews made before the model was asked to look at the finished print first */
  final_check?: string;
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

/** JSON schema the answer is held to */
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    final_check: { type: 'string' },
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
  required: ['final_check', 'summary', 'outcome_guess', 'issues', 'observations', 'suggestions'],
};

const SYSTEM_PROMPT = [
  'Bạn là kỹ thuật viên kiểm tra chất lượng in 3D FDM lâu năm, đang xem timelapse của một bản in trên máy Bambu Lab H2D (2 đầu phun, buồng kín).',
  'Mỗi khung timelapse chụp khi đầu in đã đỗ sang bên, từ camera góc rộng của máy; khung cuối là bản in đã xong, ở độ phân giải gốc của camera.',
  'Nhiệm vụ: đánh giá chất lượng bản in và đề xuất hướng chỉnh cho lần in sau.',
  'Cách làm:',
  '- final_check: xem kỹ khung cuối và tả lần lượt (1) thành bên: các lớp có đều, thẳng, mịn không, có gợn sóng, lồi lõm, lệch lớp, hở lớp không; (2) mặt trên: phẳng mịn hay sần, gợn sóng, lỗ, thiếu nhựa, phồng; (3) đế và brim: có bong, cong góc, lởm chởm không. Tả cả cái tốt lẫn cái xấu; hình dạng cố ý của mô hình (hoa văn, thành gợn) không phải lỗi.',
  '- observations: lỗi thấy ở từng khung (số khung bắt đầu từ 1), để biết lỗi bắt đầu từ lúc nào: bong khỏi bàn, rối sợi, lệch lớp, support đổ, phần nhô xệ, thành bắt đầu gợn.',
  '- summary: kết luận ngắn, có mức độ (tốt / lỗi nhỏ / lỗi rõ / hỏng). Bản in tốt thì nói tốt, có lỗi thì đừng bỏ qua. Camera ở xa: điều không chắc thì nói là cần kiểm tra lại bằng mắt.',
  '- issues: mã các lỗi thấy rõ. outcome_guess: "success" khi không có lỗi đáng kể, "usable" khi có lỗi nhưng vẫn dùng được, "failed" khi hỏng.',
  '- suggestions: hướng chỉnh cho lần sau gắn với lỗi đã thấy: tên cài đặt trong Bambu Studio và tăng hay giảm. Không đưa con số cụ thể: "AI tối ưu" sẽ chọn con số dựa trên cài đặt thật.',
  '- Viết bằng tiếng Việt.',
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

/** `files`: the frames' names, in order, as the model reads them */
export function buildReviewPrompt(print: PrintRecord | null, files: string[], framesAt: number[]): string {
  return [
    `Đọc ${files.length} ảnh trong thư mục này: ${files.map((f, i) => `${f} (khung ${i + 1}, ${framesAt[i]}% timelapse)`).join(', ')}.`,
    '',
    ...describePrint(print),
    '',
    `Mã lỗi dùng cho issues: ${ISSUES.map((i) => `${i} (${PRINT_ISSUE_LABELS[i]})`).join('; ')}.`,
    `outcome_guess: success (${PRINT_OUTCOME_LABELS.success}), usable (${PRINT_OUTCOME_LABELS.usable}), failed (${PRINT_OUTCOME_LABELS.failed}).`,
  ].join('\n');
}

export interface FrameSource {
  /** JPEG frames at these places (0-100 %) of the video, at most `width` wide (null: the camera's own width) */
  frames(video: string, places: number[], width: number | null): Promise<Buffer[]>;
}

export interface VisionModel {
  readonly name: string;
  /**
   * The model's answer, held to `schema`. The images reach it as files named frame-1.jpg, frame-2.jpg… in
   * the folder it works in, so `prompt(files)` names them.
   */
  review(system: string, prompt: (files: string[]) => string, images: Buffer[], schema: object): Promise<unknown>;
}

/** Frames cut with ffmpeg (the gateway's own, from @ffmpeg-installer) */
export class FfmpegFrames implements FrameSource {
  constructor(private readonly ffmpeg: string) {}

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

  async frames(video: string, places: number[], width: number | null): Promise<Buffer[]> {
    const seconds = await this.duration(video);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timelapse-frames-'));
    try {
      const frames: Buffer[] = [];
      for (const [i, place] of places.entries()) {
        const out = path.join(dir, `${i}.jpg`);
        // The very end has no frame to seek to: the last one is read from just before it
        const at = place >= 100 ? ['-sseof', '-0.3'] : ['-ss', ((seconds * place) / 100).toFixed(3)];
        const scale = width ? ['-vf', `scale='min(${width},iw)':-2`] : [];
        const { code, stderr } = await this.run(['-v', 'error', '-y', ...at, '-i', video, '-frames:v', '1', ...scale, '-q:v', '2', out]);
        if (code !== 0) throw new Error(`ffmpeg không cắt được khung hình: ${stderr.trim().split('\n').pop() ?? code}`);
        frames.push(await fs.readFile(out));
      }
      return frames;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

/** What went wrong with a `claude -p` run, in words the dashboard can show */
export function claudeError(detail: string): string {
  const lowered = detail.toLowerCase();
  if (detail.includes('401') || /authenticat|oauth|token|log ?in/.test(lowered)) {
    return `Claude chưa đăng nhập được: đặt CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) trong .env của gateway rồi khởi động lại. (${detail})`;
  }
  if (lowered.includes('limit')) return `Đã hết lượt dùng Claude của gói hiện tại, thử lại sau. (${detail})`;
  return `Claude không trả về nhận xét: ${detail}`;
}

/**
 * Claude, through Claude Code (`claude -p`) on the gateway's machine, on the Claude subscription in
 * CLAUDE_CODE_OAUTH_TOKEN. It may only read: the frames are files in a folder of their own.
 */
export class ClaudeCodeVision implements VisionModel {
  constructor(
    readonly name: string,
    private readonly command = 'claude',
    private readonly timeoutMs = 10 * 60 * 1000
  ) {}

  async review(system: string, prompt: (files: string[]) => string, images: Buffer[], schema: object): Promise<unknown> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timelapse-review-'));
    try {
      const files = images.map((_, i) => `frame-${i + 1}.jpg`);
      await Promise.all(images.map((image, i) => fs.writeFile(path.join(dir, files[i]), image)));
      const args = [
        '-p',
        '--model', this.name,
        '--tools', 'Read',
        '--allowedTools', 'Read',
        // The user's own settings, hooks and sessions stay out of it
        '--setting-sources', '',
        '--no-session-persistence',
        '--max-turns', '12',
        '--append-system-prompt', system,
        '--json-schema', JSON.stringify(schema),
        '--output-format', 'json',
      ];
      const { code, stdout, stderr } = await this.run(args, dir, prompt(files));
      let result: { is_error?: boolean; result?: string; structured_output?: unknown } | null = null;
      try {
        result = JSON.parse(stdout);
      } catch {
        // Reported below
      }
      if (!result || result.is_error || !result.structured_output) {
        throw new Error(claudeError(result?.result || stderr.trim().slice(-500) || `claude thoát với mã ${code}`));
      }
      return result.structured_output;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  private run(args: string[], cwd: string, input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Claude chưa xong sau ${Math.round(this.timeoutMs / 60000)} phút, đã dừng.`));
      }, this.timeoutMs);
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-8000)));
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          err.code === 'ENOENT'
            ? new Error('Không tìm thấy lệnh claude (Claude Code) trên máy chạy gateway: cài Claude Code rồi khởi động lại gateway.')
            : err
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(input);
    });
  }
}

/**
 * Runs reviews one at a time and keeps each in <dir>/<video>.json. A failed run is remembered until the next
 * try, so the dashboard can say why.
 */
export class TimelapseReviewer {
  private running = new Map<string, string>();
  private failed = new Map<string, { error: string; at: string }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly frameSource: FrameSource,
    private readonly model: VisionModel,
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
        const file = await localFile();
        const progress = await this.frameSource.frames(file, FRAME_PLACES.slice(0, -1), PROGRESS_WIDTH);
        const finished = await this.frameSource.frames(file, FRAME_PLACES.slice(-1), null);
        const raw = await this.model.review(
          SYSTEM_PROMPT,
          (files) => buildReviewPrompt(print, files, FRAME_PLACES),
          [...progress, ...finished],
          ANSWER_SCHEMA
        );
        const answer = reviewAnswerSchema.parse(raw);
        const review: TimelapseReview = {
          video,
          model: this.model.name,
          at: this.now().toISOString(),
          print_id: print?.id ?? null,
          frames_at: FRAME_PLACES,
          ...answer,
          // Frames the model made up are dropped
          observations: answer.observations.filter((o) => o.frame >= 1 && o.frame <= FRAME_PLACES.length),
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
