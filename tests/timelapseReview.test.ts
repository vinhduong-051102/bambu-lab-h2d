import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import type { PrinterFileStorage } from '../src/bambu/BambuFtpClient';
import { PrintJournal } from '../src/domain/prints/PrintJournal';
import { AiSessionStore } from '../src/domain/studio/aiSessions';
import { TimelapseLibrary } from '../src/domain/timelapse/TimelapseLibrary';
import {
  buildReviewPrompt,
  ClaudeCodeVision,
  claudeError,
  FRAME_PLACES,
  TimelapseReviewer,
  type FrameSource,
  type VisionModel,
} from '../src/domain/timelapse/TimelapseReviewer';
import { setTimelapseStores } from '../src/api/routes/timelapse';
import { renderReview } from '../src/ui/timelapseReview.js';
import { createTestApp, type TestApp } from './helpers/testApp';

const VIDEO_NAME = 'video_2026-10-13_02-33-28.mp4';
const NOW = new Date('2026-10-25T08:00:00.000Z');

const ANSWER = {
  final_check: 'Thành bên đều; mặt trên phẳng; góc trái của đế cong lên khỏi bàn.',
  summary: 'Góc trái bong khỏi bàn từ giữa bản in.',
  outcome_guess: 'usable',
  issues: ['warping', 'warping'],
  observations: [
    { frame: 2, problem: 'Góc trái cong lên' },
    { frame: 9, problem: 'Khung không có' },
  ],
  suggestions: ['Thêm brim', 'Tăng nhiệt độ bàn', 'Giảm quạt lớp đầu', 'Dán keo', 'Đặt vật giữa bàn', 'In chậm lớp đầu', 'Lau bàn', 'Sấy nhựa', 'Kiểm tra bàn', 'Dùng mouse ears', 'Bật buồng nóng'],
};

class FakeFrames implements FrameSource {
  asked: { video: string; places: number[]; width: number | null }[] = [];
  async frames(video: string, places: number[], width: number | null) {
    this.asked.push({ video, places, width });
    return places.map(() => Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
}

class FakeModel implements VisionModel {
  readonly name = 'fake-claude';
  prompts: string[] = [];
  images: number[] = [];
  constructor(private answer: unknown = ANSWER) {}
  async review(_system: string, prompt: (files: string[]) => string, images: Buffer[]) {
    this.prompts.push(prompt(images.map((_, i) => `frame-${i + 1}.jpg`)));
    this.images.push(images.length);
    return this.answer;
  }
}

const printer: PrinterFileStorage = {
  async list(dir = '/') {
    return dir === '/timelapse' ? [{ name: VIDEO_NAME, path: '', size: 4, isDirectory: false, modifiedAt: 'Oct 12 20:21' }] : [];
  },
  async upload() {
    throw new Error('not used');
  },
  async download(_remote: string, local: string) {
    await fs.writeFile(local, 'mp4!');
  },
  async remove() {
    throw new Error('not used');
  },
};

describe('TimelapseReviewer', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(path.join(os.tmpdir(), 'reviews-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('names the frames and what the history knows about the print', () => {
    const prompt = buildReviewPrompt(null, ['frame-1.jpg', 'frame-2.jpg'], [50, 100]);
    expect(prompt).toContain('frame-2.jpg (khung 2, 100% timelapse)');
    expect(prompt).toContain('Không có thông tin về bản in này');
  });

  it('reviews frames while printing and the finished print at full resolution, and keeps the review', async () => {
    const frames = new FakeFrames();
    const model = new FakeModel();
    const reviewer = new TimelapseReviewer(dir, frames, model, () => NOW);
    expect(await reviewer.state(VIDEO_NAME)).toEqual({ status: 'none' });

    const run = reviewer.start(VIDEO_NAME, async () => '/cache/v.mp4', null);
    expect((await reviewer.state(VIDEO_NAME)).status).toBe('running');
    await run;

    const state = await reviewer.state(VIDEO_NAME);
    expect(state).toMatchObject({ status: 'done', review: { video: VIDEO_NAME, model: 'fake-claude', frames_at: FRAME_PLACES, issues: ['warping'] } });
    if (state.status !== 'done') throw new Error('not done');
    // Frames the model made up are dropped, and a model that says too much is cut short, not refused
    expect(state.review.observations).toEqual([{ frame: 2, problem: 'Góc trái cong lên' }]);
    expect(state.review.suggestions).toHaveLength(10);
    expect(state.review.final_check).toBe(ANSWER.final_check);
    // Only a review until the user uses it
    expect(state.review.used).toBeNull();
    expect(frames.asked).toEqual([
      { video: '/cache/v.mp4', places: [25, 50, 75], width: 1024 },
      { video: '/cache/v.mp4', places: [100], width: null },
    ]);
    expect(model.images).toEqual([4]);
    expect(model.prompts[0]).toContain('frame-4.jpg (khung 4, 100% timelapse)');
  });

  it('says why a review failed, until the next try', async () => {
    const reviewer = new TimelapseReviewer(dir, new FakeFrames(), new FakeModel({ summary: 'thiếu trường' }), () => NOW);
    await reviewer.start(VIDEO_NAME, async () => '/cache/v.mp4', null);
    expect(await reviewer.state(VIDEO_NAME)).toMatchObject({ status: 'failed' });
  });
});

describe('Claude through claude -p', () => {
  it('explains a missing Claude Code, a bad token and a used-up plan', async () => {
    const vision = new ClaudeCodeVision('claude-opus-5-5', 'no-such-claude-command');
    await expect(vision.review('', () => '', [Buffer.from('x')], {})).rejects.toThrow('Không tìm thấy lệnh claude');
    expect(claudeError('Invalid API key · Please run /login')).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(claudeError('401 OAuth token has expired')).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(claudeError('Claude usage limit reached')).toContain('hết lượt dùng');
    expect(claudeError('something else')).toBe('Claude không trả về nhận xét: something else');
  });
});

describe('Timelapse review API', () => {
  let app: TestApp;
  let stateStore: PrinterStateStore;
  let dirs: string[];
  let journal: PrintJournal;
  let sessions: AiSessionStore;
  let model: FakeModel;

  beforeEach(() => {
    dirs = ['cache', 'prints', 'sessions'].map((n) => mkdtempSync(path.join(os.tmpdir(), `review-${n}-`)));
    journal = new PrintJournal(dirs[1]);
    sessions = new AiSessionStore(dirs[2]);
    model = new FakeModel();
    setTimelapseStores(
      new TimelapseLibrary(() => printer, dirs[0], () => NOW),
      journal,
      new TimelapseReviewer(path.join(dirs[0], 'reviews'), new FakeFrames(), model, () => NOW),
      sessions
    );
    stateStore = new PrinterStateStore('TEST_SERIAL_REVIEW');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    app = createTestApp(new PrinterService({ serial: 'TEST_SERIAL_REVIEW', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any }));
  });

  afterEach(() => {
    setTimelapseStores(null);
    stateStore.destroy();
    app.close();
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  async function waitDone() {
    for (let i = 0; i < 50; i++) {
      const body = (await app.inject({ method: 'GET', url: `/api/timelapse/${VIDEO_NAME}/review` })).json();
      if (body.status !== 'running') return body;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('review never ended');
  }

  it('reviews the video of the print the user picked, and uses it for later prints only when asked', async () => {
    const session = await sessions.create(
      { version: 1, goal: 'balanced', printer_preset: 'p', process_preset: 'q', nozzle_diameters: [0.4], filaments: [], settings: {}, objects: [] },
      { summary: '', changes: [], rejected: [] },
      null
    );
    const print = await journal.create('Plate03_Den', null, {
      version: 1,
      job_name: 'Plate03_Den',
      printer_preset: 'p',
      process_preset: '0.20mm Standard @BBL H2D',
      nozzle_diameters: [0.4],
      filaments: [{ preset: 'Bambu PETG HF @BBL H2D', type: 'PETG' }],
      settings: {},
      objects: [],
      ai_session_id: session.id,
      received_at: NOW.toISOString(),
    });

    const none = (await app.inject({ method: 'GET', url: `/api/timelapse/${VIDEO_NAME}/review` })).json();
    expect(none).toMatchObject({ status: 'none', model: 'claude-opus-5-5' });
    expect(none.issues.find((i: { id: string }) => i.id === 'warping').label).toBe('Cong vênh, bong khỏi bàn');

    const res = await app.inject({ method: 'POST', url: `/api/timelapse/${VIDEO_NAME}/review`, payload: { print_id: print.id } });
    expect(res.statusCode).toBe(202);
    const done = await waitDone();
    expect(done).toMatchObject({ status: 'done', review: { print_id: print.id, model: 'fake-claude' } });
    expect(model.prompts[0]).toContain('Filament: Bambu PETG HF @BBL H2D (PETG)');
    expect(done.review.used).toBeNull();
    expect((await journal.get(print.id))?.video_review).toBeUndefined();
    expect((await sessions.get(session.id))?.video_review).toBeUndefined();

    const used = await app.inject({ method: 'POST', url: `/api/timelapse/${VIDEO_NAME}/review/use` });
    expect(used.statusCode).toBe(200);
    expect(used.json().review.used).toMatchObject({ print_id: print.id });
    expect((await journal.get(print.id))?.video_review?.summary).toBe(ANSWER.summary);
    expect((await sessions.get(session.id))?.video_review?.issues).toEqual(['warping']);

    const unused = await app.inject({ method: 'DELETE', url: `/api/timelapse/${VIDEO_NAME}/review/use` });
    expect(unused.json().review.used).toBeNull();
    expect((await journal.get(print.id))?.video_review).toBeUndefined();
    expect((await sessions.get(session.id))?.video_review).toBeUndefined();
    expect((await waitDone()).status).toBe('done');
  });

  it('asks which print before using a review of an unpaired video', async () => {
    await app.inject({ method: 'POST', url: `/api/timelapse/${VIDEO_NAME}/review` });
    expect((await waitDone()).review.print_id).toBeNull();
    const res = await app.inject({ method: 'POST', url: `/api/timelapse/${VIDEO_NAME}/review/use` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('PRINT_REQUIRED');

    const print = await journal.create('Plate01', null, null);
    const picked = await app.inject({ method: 'POST', url: `/api/timelapse/${VIDEO_NAME}/review/use`, payload: { print_id: print.id } });
    expect(picked.statusCode).toBe(200);
    expect((await journal.get(print.id))?.video_review?.used?.print_id).toBe(print.id);
  });

  it('refuses prints and videos that do not exist', async () => {
    const unknownPrint = await app.inject({ method: 'POST', url: `/api/timelapse/${VIDEO_NAME}/review`, payload: { print_id: '20990101-000000-abcdef' } });
    expect(unknownPrint.statusCode).toBe(404);
    const badId = await app.inject({ method: 'POST', url: `/api/timelapse/${VIDEO_NAME}/review`, payload: { print_id: '../x' } });
    expect(badId.statusCode).toBe(400);
    const unknownVideo = await app.inject({ method: 'POST', url: '/api/timelapse/video_2099-01-01_00-00-00.mp4/review' });
    expect(unknownVideo.statusCode).toBe(404);
  });
});

describe('review rendering', () => {
  it('shows the guess, issues, where they were seen and the advice, escaped', () => {
    const html = renderReview(
      {
        ...ANSWER,
        observations: [{ frame: 2, problem: '<b>cong</b>' }],
        model: 'qwen3-vl:8b',
        at: NOW.toISOString(),
        frames_at: [0, 50, 100],
        video: VIDEO_NAME,
        print_id: null,
        used: null,
      },
      { outcomes: [{ id: 'usable', label: 'Có lỗi nhưng dùng được' }], issues: [{ id: 'warping', label: 'Cong vênh' }] }
    );
    expect(html).toContain('AI đoán: Có lỗi nhưng dùng được');
    expect(html).toContain('<li>Cong vênh</li>');
    expect(html).toContain('50%</span> &lt;b&gt;cong&lt;/b&gt;');
    expect(html).toContain('<li>Thêm brim</li>');
  });
});
