/**
 * Why a background task failed, and how to run it so it does not fail the same way: what "Thử lại" does on the
 * task panel. Known failures are matched by rules (fast, no Claude); anything else Claude analyses, through
 * `claude -p` on the gateway, and may only turn the task's own knobs (more time, a coarser mesh, no video…) within
 * their bounds, or say that running it again cannot help. Work done by Claude itself (AI models, figures) also gets
 * the failure and the analysis in its prompt, so it carries on from what it did instead of repeating it.
 */
import { env } from '../config/env';
import { ClaudeCodeVision } from './timelapse/TimelapseReviewer';

export type Tuning = Record<string, number | boolean>;

/** One setting a retry may change */
export interface Knob {
  type: 'number' | 'boolean';
  min?: number;
  max?: number;
  /** What it does, for Claude and for the task panel */
  describe: string;
}

export interface Failure {
  error: string;
  details: string[];
}

/** What Claude's own work (an AI model, a figure) is told on a retry: the failure and the analysis of it */
export interface RetryNote extends Failure {
  cause?: string;
  hint?: string;
}

/** A rule: when the error matches, what is wrong and the settings to run with (or why running again won't help) */
export interface Rule {
  match: RegExp;
  cause: string;
  /** The settings to run with; null when there is nothing more to turn (the rule then stops) */
  tune?: (tuning: Tuning) => Tuning | null;
  /** Running again won't help until someone acts: what to do */
  stop?: string;
  /** For Claude's own work (AI models, figures): what to do differently, in its prompt */
  hint?: string;
}

/** How a task kind is retried: its knobs, its rules, and what Claude is told about it */
export interface Doctor {
  /** What the task does, for Claude */
  about: string;
  knobs: Record<string, Knob>;
  rules: Rule[];
}

export interface Diagnosis {
  by: 'rule' | 'claude' | 'none';
  cause: string;
  /** The settings changed, in words */
  changes: string[];
  tuning: Tuning;
  /** Set when running again is not going to help: why, and what to do */
  stop: string | null;
  /** For Claude's own work: what to do differently */
  hint: string | null;
}

/** Failures any task can meet: the worker container, or Claude itself */
const COMMON: Rule[] = [
  {
    match: /hết lượt dùng Claude|usage limit|rate.?limit/i,
    cause: 'Gói Claude đã hết lượt dùng trong khung giờ này.',
    stop: 'Chờ gói Claude hồi lượt (xem mục Chi phí AI) rồi thử lại.',
  },
  {
    match: /chưa đăng nhập được|CLAUDE_CODE_OAUTH_TOKEN|AI_DISABLED|\b401\b/i,
    cause: 'Claude chưa đăng nhập được trong container.',
    stop: 'Đặt CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) trong .env rồi khởi động lại container.',
  },
  {
    match: /không kết nối được|ECONNREFUSED|fetch failed|không trả lời \(/i,
    cause: 'Container worker không chạy hoặc vừa khởi động lại.',
    // Once more as it was: a container that was restarting answers now; twice the same and it stops (see retryTask)
    tune: (tuning) => tuning,
  },
];

/** A failure with the settings it ran with: the same twice and a retry stops instead of running it again */
export const SAME_FAILURE_LIMIT = 2;
export const failureSignature = (error: string, tuning: Tuning) => `${error}@${JSON.stringify(Object.entries(tuning).sort())}`;

const label = (name: string, knob: Knob, value: number | boolean) =>
  knob.type === 'boolean' ? `${knob.describe}: ${value ? 'bật' : 'tắt'}` : `${knob.describe}: ${value}`;

/** Changes, in words; only knobs that changed */
export function describeChanges(doctor: Doctor, before: Tuning, after: Tuning): string[] {
  return Object.entries(after)
    .filter(([name, value]) => doctor.knobs[name] && before[name] !== value)
    .map(([name, value]) => label(name, doctor.knobs[name], value));
}

/** Only the doctor's knobs, of their type, within their bounds */
export function clampTuning(doctor: Doctor, tuning: Record<string, unknown>): Tuning {
  const out: Tuning = {};
  for (const [name, value] of Object.entries(tuning)) {
    const knob = doctor.knobs[name];
    if (!knob) continue;
    if (knob.type === 'boolean' && typeof value === 'boolean') out[name] = value;
    if (knob.type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      out[name] = Math.min(Math.max(value, knob.min ?? -Infinity), knob.max ?? Infinity);
    }
  }
  return out;
}

/** What Claude answers about a failure */
export interface Analysis {
  cause: string;
  /** Knobs to change: {name: value} */
  tuning: Record<string, unknown>;
  /** Running again won't help: what to do instead; '' when it will */
  stop: string;
  /** For Claude's own work: what to do differently; '' when none */
  hint: string;
}

export type Analyst = (doctor: Doctor, failure: Failure, tuning: Tuning, kind: string) => Promise<Analysis>;

const SCHEMA = {
  type: 'object',
  properties: {
    cause: { type: 'string', description: 'Nguyên nhân, 1–2 câu tiếng Việt' },
    tuning: { type: 'object', description: 'Các núm cần đổi: {tên: giá trị}; {} nếu không đổi', additionalProperties: true },
    stop: { type: 'string', description: 'Nếu chạy lại không giúp được: cần người làm gì (tiếng Việt); "" nếu chạy lại được' },
    hint: { type: 'string', description: 'Với việc do Claude làm (mô hình AI, nhân vật): lần sau làm khác thế nào; "" nếu không' },
  },
  required: ['cause', 'tuning', 'stop', 'hint'],
};

const SYSTEM =
  'Bạn phân tích vì sao một tác vụ chạy ngầm trên dashboard máy in 3D bị lỗi, để lần chạy lại đi theo hướng đã sửa ' +
  'chứ không lặp lại y như cũ. Chỉ được đổi các "núm" được liệt kê, trong giới hạn của chúng. Nếu lỗi do thứ chạy ' +
  'lại không sửa được (thiếu file, cấu hình sai, dữ liệu hỏng) thì nói rõ cần người làm gì trong "stop". Trả lời ngắn, tiếng Việt.';

/** Claude, through `claude -p` on the gateway (no tools needed: everything is in the prompt) */
export const claudeAnalyst: Analyst = async (doctor, failure, tuning, kind) => {
  const claude = new ClaudeCodeVision(env.RETRY_AI_MODEL, 'claude', 3 * 60 * 1000, 'retry');
  const knobs = Object.entries(doctor.knobs)
    .map(([name, k]) => `- ${name} (${k.type}${k.type === 'number' ? `, ${k.min ?? '?'}–${k.max ?? '?'}` : ''}): ${k.describe}; hiện tại ${JSON.stringify(tuning[name] ?? 'mặc định')}`)
    .join('\n');
  const prompt = [
    `Tác vụ (${kind}): ${doctor.about}`,
    `Lỗi: ${failure.error}`,
    failure.details.length ? `Chi tiết:\n${failure.details.slice(0, 30).join('\n')}` : '',
    knobs ? `Các núm được đổi:\n${knobs}` : 'Tác vụ này không có núm nào để đổi: chỉ có thể chạy lại như cũ, hoặc dừng.',
  ]
    .filter(Boolean)
    .join('\n\n');
  const answer = (await claude.review(SYSTEM, () => prompt, [], SCHEMA, 'txt', kind)) as Partial<Analysis>;
  return {
    cause: String(answer.cause ?? ''),
    tuning: answer.tuning && typeof answer.tuning === 'object' ? answer.tuning : {},
    stop: String(answer.stop ?? ''),
    hint: String(answer.hint ?? ''),
  };
};

let analyst: Analyst = claudeAnalyst;
/** Tests answer for Claude */
export function setAnalyst(next: Analyst | null): void {
  analyst = next ?? claudeAnalyst;
}

/**
 * What went wrong and how to run it next: the first rule that matches (the common ones, the container or Claude;
 * then the task's own), else
 * Claude's analysis. A rule with nothing left to turn stops.
 */
export async function diagnose(kind: string, doctor: Doctor, failure: Failure, tuning: Tuning): Promise<Diagnosis> {
  const text = [failure.error, ...failure.details].join('\n');
  for (const rule of [...COMMON, ...doctor.rules]) {
    if (!rule.match.test(text)) continue;
    if (rule.stop) return { by: 'rule', cause: rule.cause, changes: [], tuning, stop: rule.stop, hint: null };
    const next = rule.tune ? rule.tune(tuning) : tuning;
    if (!next) {
      return {
        by: 'rule',
        cause: rule.cause,
        changes: [],
        tuning,
        stop: 'Đã chỉnh hết mức cho phép mà vẫn lỗi: cần người xem lại (mô hình quá lớn, hoặc lỗi khác).',
        hint: null,
      };
    }
    const tuned = { ...tuning, ...clampTuning(doctor, next) };
    return { by: 'rule', cause: rule.cause, changes: describeChanges(doctor, tuning, tuned), tuning: tuned, stop: null, hint: rule.hint ?? null };
  }
  try {
    const answer = await analyst(doctor, failure, tuning, kind);
    const tuned = { ...tuning, ...clampTuning(doctor, answer.tuning) };
    return {
      by: 'claude',
      cause: answer.cause || 'Claude không tìm ra nguyên nhân rõ ràng.',
      changes: describeChanges(doctor, tuning, tuned),
      tuning: tuned,
      stop: answer.stop.trim() || null,
      hint: answer.hint.trim() || null,
    };
  } catch (err) {
    // Without an analysis it still runs again, as it was, and says so
    return {
      by: 'none',
      cause: `Không phân tích được lỗi (${err instanceof Error ? err.message : String(err)}): chạy lại như cũ.`,
      changes: [],
      tuning,
      stop: null,
      hint: null,
    };
  }
}

/** A time knob twice as long, up to its max; null when it is already there */
export function longer(doctor: Doctor, tuning: Tuning, name: string, start: number): Tuning | null {
  const knob = doctor.knobs[name];
  const now = typeof tuning[name] === 'number' ? (tuning[name] as number) : start;
  if (now >= (knob.max ?? Infinity)) return null;
  return { ...tuning, [name]: Math.min(now * 2, knob.max ?? Infinity) };
}
