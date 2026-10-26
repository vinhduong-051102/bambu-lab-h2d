import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { PrintJournal, type PrintRecord } from '../src/domain/prints/PrintJournal';
import { buildUserPrompt, type StudioRequest } from '../src/domain/studio/aiOptimize';
import {
  analysisKey,
  baseName,
  describeFeature,
  describeParts,
  findImportFile,
  matchParts,
  ModelParts,
  ModelPartsStore,
  partSettings,
  partSimilarity,
  type ModelAnalysis,
  type PartFeature,
  type PartsWorker,
} from '../src/domain/studio/modelParts';
import type { VisionModel } from '../src/domain/timelapse/TimelapseReviewer';
import { setModelParts } from '../src/api/routes/parts';
import { setAiProposalSource, setAiSessionStore } from '../src/api/routes/studio';
import { AiSessionStore } from '../src/domain/studio/aiSessions';
import { createTestApp, type TestApp } from './helpers/testApp';

const object = (name: string, height = 11) => ({
  name,
  instances: 1,
  size_mm: [194, 37.6, height] as [number, number, number],
  volume_mm3: 16029,
  surface_area_mm2: 14154,
  base_area_mm2: 1835,
  overhang_area_mm2: 545,
  triangles: 22120,
});

const feature = (id: string, kind: PartFeature['kind'], metrics: PartFeature['metrics'], count = 1): PartFeature => ({
  id,
  kind,
  count,
  metrics,
  where: { x: [0, 10], y: [0, 10], z: [0, 11] },
  colour: 'đỏ',
});

const wall = (thin: number, height: number) => feature('F2', 'thin_wall', { thin_mm: thin, median_mm: thin * 3, area_mm2: 5000, height_mm: height });
const bridge = (span: number) =>
  feature('F3', 'ceiling', { area_mm2: 112, angle_from_flat_deg: 0, flat_share: 1, height_mm: 10.4, gap_below_mm: 10.4, over: 'plate', span_mm: span }, 4);

const analysis = (key: string, name: string, features: PartFeature[], extra: Partial<ModelAnalysis> = {}): ModelAnalysis => ({
  key,
  file: name,
  object: { name, size_mm: [194, 37.6, 11], volume_mm3: 16029, surface_area_mm2: 14154, base_area_mm2: 1835, overhang_area_mm2: 545 },
  analyzed_at: '2026-10-26T10:00:00.000Z',
  matched: true,
  size_mm: [194, 37.6, 11],
  features,
  ...extra,
});

const printRecord = (id: string, jobName: string, outcome: 'success' | 'usable' | 'failed', issues: string[] = []): PrintRecord =>
  ({
    id,
    job_name: jobName,
    started_at: '2026-10-25T06:38:35.000Z',
    ended_at: '2026-10-25T07:51:00.000Z',
    status: 'finished',
    photos: [],
    feedback: { outcome, issues, note: '', at: '2026-10-25T08:00:00.000Z' },
    setup: {
      job_name: jobName,
      version: 1,
      printer_preset: 'Bambu Lab H2D 0.4 nozzle',
      process_preset: '0.20mm Standard @BBL H2D',
      nozzle_diameters: [0.4, 0.4],
      filaments: [{ preset: 'Bambu PETG Basic', type: 'PETG', settings: { nozzle_temperature: '255,255', fan_max_speed: '30' } }],
      settings: { wall_loops: '3', outer_wall_speed: '200,200,200', bridge_speed: '50' },
      objects: [object(`${jobName}.stl`)],
      ai_session_id: null,
      received_at: '2026-10-25T06:38:00.000Z',
    },
  }) as unknown as PrintRecord;

describe('finding the mesh of a Studio object', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'imports-'));
    for (const name of ['Plate03_Den_Can_Op.stl', 'Plate06_Lop.3mf', 'Plate06_Lop.stl', 'notes.txt']) await fs.writeFile(path.join(dir, name), name);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads past the suffixes Studio adds to repaired and copied objects', async () => {
    expect(baseName('Plate03_Den_Can_Op_fixed(1).stl')).toBe('plate03_den_can_op');
    expect(baseName('Plate06_Lop (2).stl')).toBe('plate06_lop');
    expect(await findImportFile(dir, 'Plate03_Den_Can_Op_fixed(1).stl')).toBe('Plate03_Den_Can_Op.stl');
    // An STL before a 3MF of the same model
    expect(await findImportFile(dir, 'Plate06_Lop (2).stl')).toBe('Plate06_Lop.stl');
    expect(await findImportFile(dir, 'Khối lập phương')).toBeNull();
    expect(await findImportFile(path.join(dir, 'missing'), 'Plate06_Lop.stl')).toBeNull();
  });

  it('keys an analysis by the file and the placement, not the object name', () => {
    const content = Buffer.from('solid');
    expect(analysisKey(content, object('a.stl'))).toBe(analysisKey(content, object('b.stl')));
    expect(analysisKey(content, object('a.stl'))).not.toBe(analysisKey(content, object('a.stl', 22)));
    expect(analysisKey(content, object('a.stl'))).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe('comparing parts', () => {
  it('scores alike parts of one kind high, different ones low, other kinds not at all', () => {
    expect(partSimilarity(wall(0.6, 11), wall(0.6, 11))).toBe(1);
    expect(partSimilarity(wall(0.6, 11), wall(0.7, 13))!).toBeGreaterThan(0.5);
    expect(partSimilarity(wall(0.6, 11), wall(2.4, 60))!).toBeLessThan(0.2);
    expect(partSimilarity(wall(0.6, 11), bridge(28))).toBeNull();
    const hole = (direction: string) => feature('F4', 'hole', { diameter_mm: 3, direction, length_mm: 5, round: true });
    expect(partSimilarity(hole('đứng'), hole('ngang'))).toBeNull();
  });

  it('describes parts in words with their repeats', () => {
    expect(describeFeature(bridge(27.8))).toBe('Mặt dưới phẳng (cầu, trần) ×4: 112 mm², nhịp 27.8 mm, ở cao 10.4 mm, cách bàn 10.4 mm');
    expect(describeFeature(wall(0.6, 11))).toBe('Thành mỏng: dày 0.6–1.8 mm, cao 11 mm, 5000 mm²');
  });

  it('reads the settings that shape a kind of part from the print, one value for agreeing variants', () => {
    const print = printRecord('p1', 'Plate07', 'success');
    expect(partSettings(print.setup!, 'thin_wall')).toBe('wall_loops=3; outer_wall_speed=200; nozzle_temperature=255; fan_max_speed=30');
    expect(partSettings(print.setup!, 'ceiling')).toBe('bridge_speed=50');
  });

  it('finds the most alike part of each earlier print, best first, and leaves unlike ones out', () => {
    const current = analysis('a', 'New.stl', [wall(0.6, 11), bridge(28)]);
    const good = { print: printRecord('good', 'Plate07', 'success'), analyses: [analysis('b', 'Plate07.stl', [wall(0.65, 12)])] };
    const bad = { print: printRecord('bad', 'Plate03', 'usable', ['weak']), analyses: [analysis('c', 'Plate03.stl', [wall(0.6, 11), wall(2.5, 60)])] };
    const [walls, bridges] = matchParts([current], [good, bad]);
    expect(walls.references.map((r) => [r.print.id, r.similarity])).toEqual([
      ['bad', 1],
      ['good', expect.any(Number)],
    ]);
    expect(bridges.references).toEqual([]);
  });

  it('writes the prompt section: names, alike parts, how they came out and their settings', () => {
    const current = analysis('a', 'New.stl', [wall(0.6, 11), bridge(28)], {
      description: 'Bốn mâm bánh xe nối bằng một thanh.',
      purpose: 'Trang trí.',
      components: [{ name: 'vành mâm', role: 'vành', features: ['F2'], risk: 'tách lớp' }],
    });
    const bad = {
      print: printRecord('bad', 'Plate03_Den_Can_Op', 'usable', ['weak', 'stringing']),
      analyses: [analysis('c', 'Plate03.stl', [wall(0.6, 11)], { components: [{ name: 'thành đèn', role: '', features: ['F2'], risk: '' }] })],
    };
    const lines = describeParts([current], [bad]);
    const text = lines.join('\n');
    expect(text).toContain('Thành phần của plate này (đo trên lưới)');
    expect(text).toContain('New.stl: Bốn mâm bánh xe nối bằng một thanh. Trang trí.');
    expect(text).toContain('- F2 "vành mâm": Thành mỏng: dày 0.6–1.8 mm');
    // Only the problems of this kind of part: stringing says nothing about a thin wall
    expect(text).toContain('Giống 100%: "thành đèn" của bản in Plate03_Den_Can_Op (2026-10-25): Thành mỏng: dày 0.6–1.8 mm, cao 11 mm, 5000 mm². Kết quả: Có lỗi nhưng dùng được; lỗi ở loại phần này: Yếu, nứt, tách lớp. Setting khi in: wall_loops=3');
    expect(text).not.toContain('Kéo sợi');
    expect(text).toContain('- F3: Mặt dưới phẳng (cầu, trần) ×4');
    expect(text).toContain('   Chưa in phần nào giống.');
    expect(describeParts([analysis('x', 'X.stl', [], { matched: false })], [bad])).toEqual([]);
  });
});

/** A mesh worker that answers with canned parts and writes the two renders */
class FakeWorker implements PartsWorker {
  calls = 0;
  constructor(private readonly dir: string, private readonly matched = true) {}
  async analyze(_file: string, key: string) {
    this.calls++;
    await fs.mkdir(path.join(this.dir, key), { recursive: true });
    await fs.writeFile(path.join(this.dir, key, 'views.png'), 'png');
    await fs.writeFile(path.join(this.dir, key, 'parts.png'), 'png');
    return this.matched
      ? { orientation: { matched: true }, size_mm: [194, 37.6, 11], features: [wall(0.6, 11), bridge(28)], views: ['views.png', 'parts.png'] }
      : { orientation: { matched: false, reason: 'Hướng đặt trong Studio không khớp file.' }, features: [] };
  }
}

class FakeNamer implements VisionModel {
  readonly name = 'claude-test';
  calls: { prompt: string; extension?: string }[] = [];
  constructor(private readonly delayMs = 0) {}
  async review(_system: string, prompt: (files: string[]) => string, _images: Buffer[], _schema: object, extension?: string) {
    this.calls.push({ prompt: prompt(['frame-1.png', 'frame-2.png']), extension });
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return {
      description: 'Bốn mâm bánh xe.',
      purpose: 'Trang trí.',
      components: [{ name: 'vành mâm', role: 'vành', features: ['F2', 'F99'], risk: 'tách lớp' }],
    };
  }
}

describe('measuring and naming a model', () => {
  let imports: string;
  let analyses: string;

  beforeEach(async () => {
    imports = mkdtempSync(path.join(os.tmpdir(), 'imports-'));
    analyses = mkdtempSync(path.join(os.tmpdir(), 'analyses-'));
    await fs.writeFile(path.join(imports, 'Plate07.stl'), 'solid plate07');
  });

  afterEach(() => {
    rmSync(imports, { recursive: true, force: true });
    rmSync(analyses, { recursive: true, force: true });
  });

  it('measures once, has Claude name the parts from the renders, and keeps the result', async () => {
    const worker = new FakeWorker(analyses);
    const namer = new FakeNamer();
    const parts = new ModelParts(imports, new ModelPartsStore(analyses), worker, namer);
    const [a, b] = await Promise.all([parts.analyze(object('Plate07_fixed.stl')), parts.analyze(object('Plate07.stl'))]);
    expect(worker.calls).toBe(1);
    expect(namer.calls).toHaveLength(1);
    expect(namer.calls[0].extension).toBe('png');
    expect(namer.calls[0].prompt).toContain('- F3 (màu đỏ): Mặt dưới phẳng (cầu, trần) ×4');
    expect(a).toEqual(b);
    // Ids Claude made up are dropped
    expect(a?.components).toEqual([{ name: 'vành mâm', role: 'vành', features: ['F2'], risk: 'tách lớp' }]);
    expect(await parts.analyze(object('Plate07.stl'))).toEqual(a);
    expect(worker.calls).toBe(1);
    expect(await parts.cached(object('Plate07.stl'))).toEqual(a);
    expect(await parts.analyze(object('Other.stl'))).toBeNull();
  });

  it('answers with the parts alone when the names take too long, and saves the names later', async () => {
    const namer = new FakeNamer(200);
    const parts = new ModelParts(imports, new ModelPartsStore(analyses), new FakeWorker(analyses), namer);
    const quick = await parts.analyze(object('Plate07.stl'), { nameWithinMs: 20 });
    expect(quick?.features).toHaveLength(2);
    expect(quick?.components).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await parts.cached(object('Plate07.stl')))?.components?.[0].name).toBe('vành mâm');
  });

  it('keeps a failed naming, and asks Claude again only when told to', async () => {
    const namer = new FakeNamer();
    const review = namer.review.bind(namer);
    namer.review = async () => {
      throw new Error('hết lượt');
    };
    const parts = new ModelParts(imports, new ModelPartsStore(analyses), new FakeWorker(analyses), namer);
    expect((await parts.analyze(object('Plate07.stl')))?.naming_error).toBe('hết lượt');
    namer.review = review;
    expect((await parts.analyze(object('Plate07.stl')))?.naming_error).toBe('hết lượt');
    const retried = await parts.analyze(object('Plate07.stl'), { retryNaming: true });
    expect(retried?.naming_error).toBeUndefined();
    expect(retried?.components?.[0].name).toBe('vành mâm');
  });

  it('keeps an object placed unlike its file as unmatched, without asking Claude', async () => {
    const namer = new FakeNamer();
    const parts = new ModelParts(imports, new ModelPartsStore(analyses), new FakeWorker(analyses, false), namer);
    const result = await parts.analyze(object('Plate07.stl'));
    expect(result).toMatchObject({ matched: false, reason: 'Hướng đặt trong Studio không khớp file.', features: [] });
    expect(namer.calls).toHaveLength(0);
  });
});

describe('parts API and "AI tối ưu"', () => {
  let app: TestApp;
  let imports: string;
  let analyses: string;
  let history: string;
  let journal: PrintJournal;
  let stateStore: PrinterStateStore;

  beforeEach(async () => {
    imports = mkdtempSync(path.join(os.tmpdir(), 'imports-'));
    analyses = mkdtempSync(path.join(os.tmpdir(), 'analyses-'));
    history = mkdtempSync(path.join(os.tmpdir(), 'prints-'));
    await fs.writeFile(path.join(imports, 'Plate07.stl'), 'solid plate07');
    await fs.writeFile(path.join(imports, 'New.stl'), 'solid new');
    journal = new PrintJournal(history);
    // The prompt route also reads the AI sessions: an empty folder, not the gateway's own
    setAiSessionStore(new AiSessionStore(path.join(history, 'sessions')));
    setModelParts(new ModelParts(imports, new ModelPartsStore(analyses), new FakeWorker(analyses), new FakeNamer()), journal);
    stateStore = new PrinterStateStore('TEST_SERIAL_PARTS');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    app = createTestApp(new PrinterService({ serial: 'TEST_SERIAL_PARTS', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any }));
  });

  afterEach(() => {
    setModelParts(null);
    setAiProposalSource(null);
    setAiSessionStore(null);
    stateStore.destroy();
    app.close();
    for (const dir of [imports, analyses, history]) rmSync(dir, { recursive: true, force: true });
  });

  async function reportedPrint() {
    const { setup } = printRecord('x', 'Plate07', 'success');
    const print = await journal.create('Plate07', new Date('2026-10-25T06:38:35Z'), setup);
    await journal.update(print.id, (r) => {
      r.status = 'finished';
      r.feedback = { outcome: 'success', issues: [], note: '', at: '2026-10-25T08:00:00.000Z' };
    });
    return print;
  }

  it('measures a print\'s objects on request and lists them with their renders', async () => {
    const print = await reportedPrint();
    const before = (await app.inject({ method: 'GET', url: `/api/prints/${print.id}/parts` })).json();
    expect(before.objects).toEqual([{ name: 'Plate07.stl', status: 'pending', analysis: null }]);

    const after = (await app.inject({ method: 'POST', url: `/api/prints/${print.id}/parts` })).json();
    expect(after.objects[0]).toMatchObject({ status: 'done', analysis: { matched: true, components: [{ name: 'vành mâm' }] } });
    expect(after.objects[0].analysis.features[0].text).toMatch(/^Thành mỏng: dày 0.6/);
    const image = await app.inject({ method: 'GET', url: `/api/studio/parts/${after.objects[0].analysis.key}/parts.png` });
    expect(image.headers.get('content-type')).toBe('image/png');
    expect((await app.inject({ method: 'GET', url: `/api/studio/parts/${after.objects[0].analysis.key}/x.png` })).statusCode).toBe(404);
  });

  it('measures every earlier print in the background', async () => {
    await reportedPrint();
    expect((await app.inject({ method: 'POST', url: '/api/studio/parts/backfill' })).statusCode).toBe(202);
    let state;
    for (let i = 0; i < 50; i++) {
      state = (await app.inject({ method: 'GET', url: '/api/studio/parts/backfill' })).json();
      if (!state.running) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(state).toMatchObject({ running: false, total: 1, done: 1, failed: [] });
  });

  it('puts the plate\'s parts and alike parts printed before in the prompt', async () => {
    const print = await reportedPrint();
    await app.inject({ method: 'POST', url: `/api/prints/${print.id}/parts` });
    const request: StudioRequest = {
      version: 1,
      goal: 'balanced',
      printer_preset: 'Bambu Lab H2D 0.4 nozzle',
      process_preset: '0.20mm Standard @BBL H2D',
      nozzle_diameters: [0.4, 0.4],
      filaments: [{ preset: 'Bambu PETG Basic', type: 'PETG' }],
      settings: { wall_loops: '2' },
      objects: [object('New.stl')],
    };
    const res = (await app.inject({ method: 'POST', url: '/api/studio/ai-optimize/prompt', payload: request })).json();
    expect(res.user).toContain('Thành phần của plate này (đo trên lưới)');
    expect(res.user).toContain('Giống 100%: "vành mâm" của bản in Plate07');
    expect(res.user).toContain('Setting khi in: wall_loops=3; outer_wall_speed=200; nozzle_temperature=255; fan_max_speed=30');
    expect(res.system).toContain('Thành phần của plate này');
    // Without parts, the prompt is as before
    expect(buildUserPrompt(request, null)).not.toContain('Thành phần của plate này');
  });
});
