import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { env } from '../src/config/env';
import { buildRequest, CadJobStore, CadWorkerError, newJobId, type CadBuildReport, type CadWorkerApi } from '../src/domain/cad/cadJobs';
import { setCadJobStore, setCadWorker } from '../src/api/routes/cad';
import { writeStl } from '../src/domain/studio/meshRepair';
import { createTestApp, type TestApp } from './helpers/testApp';

const CUBE = writeStl(
  [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10],
  [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
);

const REPORT: CadBuildReport = {
  ok: true,
  size_mm: [10, 10, 10],
  volume_cm3: 1,
  solids: 1,
  mesh: { triangles: 12, watertight: true, open_edges: 0, non_manifold_edges: 0 },
  warnings: [],
};

/** Stands in for the CAD container: writes what cad/worker.py would into the shared job folder */
class FakeWorker implements CadWorkerApi {
  generated: { id: string; model: string }[] = [];
  built: string[] = [];
  cancelled: string[] = [];
  guided: string[] = [];
  running: string[] = [];
  fail: CadWorkerError | null = null;

  constructor(private readonly dir: string) {}

  async health() {
    return { ok: true, claude: true, running: this.running };
  }

  async generate(id: string, model: string) {
    if (this.fail) throw this.fail;
    this.generated.push({ id, model });
    this.running.push(id);
    await this.status(id, { state: 'running', step: 'building', notes: ['• Đang dựng hộp'], builds: 1 });
  }

  async build(id: string) {
    this.built.push(id);
    await this.writeOutputs(id);
    await this.status(id, { state: 'done', report: REPORT });
    return REPORT;
  }

  async cancel(id: string) {
    this.cancelled.push(id);
    this.running = this.running.filter((r) => r !== id);
    await this.status(id, { state: 'cancelled', error: 'Đã hủy.' });
  }

  async guide(id: string) {
    this.guided.push(id);
    const folder = path.join(this.dir, id, 'out', 'guide');
    await fs.mkdir(folder, { recursive: true });
    const steps = [{ n: 1, parts: ['base'], text: 'Đặt base làm khung.', given: false, onto: null, joints: [], image: 'step-01.png' }];
    await fs.writeFile(path.join(folder, 'guide.json'), JSON.stringify({ ok: true, order: 'mechanism', steps, video: 'assembly.mp4' }));
    await fs.writeFile(path.join(folder, 'step-01.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(path.join(folder, 'assembly.mp4'), Buffer.from('0123456789'));
    const guide = { ok: true, steps: 1, video: 'assembly.mp4', error: null };
    await this.status(id, { guide });
    return guide;
  }

  /** Claude finishing the job */
  async finish(id: string) {
    this.running = this.running.filter((r) => r !== id);
    await fs.writeFile(path.join(this.dir, id, 'model.py'), 'result = Box(10, 10, 10)\n');
    await this.writeOutputs(id);
    await this.status(id, {
      state: 'done',
      report: REPORT,
      result: { title: 'Hộp vuông 10 mm', summary: 'Một khối lập phương.', assumptions: [], parameters: [], warnings: [] },
    });
  }

  private async writeOutputs(id: string) {
    const out = path.join(this.dir, id, 'out');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'model.stl'), CUBE);
    await fs.writeFile(path.join(out, 'model.step'), 'ISO-10303-21;\n');
    await fs.writeFile(path.join(out, 'preview.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }

  private async status(id: string, fields: Record<string, unknown>) {
    const file = path.join(this.dir, id, 'status.json');
    const current = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'));
    await fs.writeFile(file, JSON.stringify({ notes: [], builds: 0, error: null, result: null, report: null, ...current, ...fields }));
  }
}

describe('AI modelling API (/api/cad)', () => {
  let app: TestApp;
  let jobsDir: string;
  let importDir: string;
  let worker: FakeWorker;

  beforeEach(async () => {
    const stateStore = new PrinterStateStore('TEST_SERIAL_CAD');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_CAD', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);

    jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cad-jobs-'));
    importDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cad-imports-'));
    worker = new FakeWorker(jobsDir);
    setCadJobStore(new CadJobStore(jobsDir));
    setCadWorker(worker);
    env.STUDIO_IMPORT_DIR = importDir;
  });

  afterEach(async () => {
    app.close();
    setCadJobStore(null);
    setCadWorker(null);
    env.STUDIO_IMPORT_DIR = undefined;
    await fs.rm(jobsDir, { recursive: true, force: true });
    await fs.rm(importDir, { recursive: true, force: true });
  });

  const create = (payload: unknown) => app.inject({ method: 'POST', url: '/api/cad/jobs', payload });

  it('reports the worker and the models it offers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/cad' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      worker: { online: true, claude: true },
      default_model: 'claude-opus-5-5',
      studio_imports: true,
    });
  });

  it('is off without CAD_WORKER_URL', async () => {
    setCadWorker(null);
    const saved = { cad: env.CAD_WORKER_URL, mesh: env.MESH_WORKER_URL };
    env.CAD_WORKER_URL = undefined;
    env.MESH_WORKER_URL = undefined;
    try {
      expect((await app.inject({ method: 'GET', url: '/api/cad' })).json()).toEqual({ enabled: false });
      expect((await create({ prompt: 'Một cái hộp' })).statusCode).toBe(501);
    } finally {
      env.CAD_WORKER_URL = saved.cad;
      env.MESH_WORKER_URL = saved.mesh;
    }
  });

  it('starts Claude on a new model with its brief, and follows its progress', async () => {
    const res = await create({ prompt: 'Hộp vuông cạnh 10 mm', model: 'claude-sonnet-5-5' });
    expect(res.statusCode).toBe(202);
    const { job } = res.json();
    expect(worker.generated).toEqual([{ id: job.id, model: 'claude-sonnet-5-5' }]);
    expect(job).toMatchObject({ source: 'claude', state: 'running', step: 'building', notes: ['• Đang dựng hộp'] });
    expect(await fs.readFile(path.join(jobsDir, job.id, 'request.md'), 'utf8')).toContain('Hộp vuông cạnh 10 mm');

    await worker.finish(job.id);
    const done = (await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}` })).json().job;
    expect(done).toMatchObject({
      state: 'done',
      title: 'Hộp vuông 10 mm',
      report: { size_mm: [10, 10, 10] },
      files: { code: true, stl: true, step: true, preview: true },
    });
  });

  it('rejects short prompts and unknown models', async () => {
    expect((await create({ prompt: 'a' })).statusCode).toBe(400);
    expect((await create({ prompt: 'Một cái hộp', model: 'gpt-5' })).json().error).toBe('UNSUPPORTED_MODEL');
    expect(worker.generated).toHaveLength(0);
  });

  it('passes on a worker that cannot be reached', async () => {
    worker.fail = new CadWorkerError(502, 'CAD_WORKER_UNREACHABLE', 'Container CAD không kết nối được.');
    const res = await create({ prompt: 'Một cái hộp' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('CAD_WORKER_UNREACHABLE');
  });

  it('shows a job the worker no longer runs as failed', async () => {
    const { job } = (await create({ prompt: 'Một cái hộp' })).json();
    worker.running = [];
    const res = (await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}` })).json();
    expect(res.job).toMatchObject({ state: 'failed', error: expect.stringContaining('khởi động lại') });
  });

  it('shows why a model failed, lists it among the tasks and runs it again in place', async () => {
    const { job } = (await create({ prompt: 'Một cái hộp' })).json();
    // Claude stopped with its last build broken, saying why on stderr
    worker.running = [];
    const status = path.join(jobsDir, job.id, 'status.json');
    const before = JSON.parse(await fs.readFile(status, 'utf8'));
    await fs.writeFile(
      status,
      JSON.stringify({ ...before, state: 'failed', error: 'Claude chạy quá 40 phút nên đã bị dừng', report: { ok: false, error: 'NameError: Box2' }, finished_at: new Date().toISOString() })
    );
    await fs.writeFile(path.join(jobsDir, job.id, 'claude.err'), 'Lỗi một\nLỗi hai\n');
    const failed = (await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}` })).json().job;
    expect(failed).toMatchObject({ state: 'failed', retryable: true });
    expect(failed.error_details[0]).toBe('Lần dựng cuối: NameError: Box2');
    expect(failed.error_details).toContain('Claude: Đang dựng hộp');
    expect(failed.error_details.slice(-3)).toEqual(['claude.err:', 'Lỗi một', 'Lỗi hai']);

    const tasks = (await app.inject({ method: 'GET', url: '/api/tasks' })).json().tasks;
    expect(tasks).toContainEqual(expect.objectContaining({ key: `cad:${job.id}`, state: 'failed', retry_url: `/api/cad/jobs/${job.id}/retry` }));

    const retried = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/retry`, payload: {} });
    expect(retried.statusCode).toBe(202);
    expect(worker.generated.map((g) => g.id)).toEqual([job.id, job.id]);
    expect(retried.json().job.state).toBe('running');
    expect((await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/retry`, payload: {} })).statusCode).toBe(409);
  });

  it('revises a model starting from its code and brief', async () => {
    const { job } = (await create({ prompt: 'Hộp vuông cạnh 10 mm' })).json();
    await worker.finish(job.id);

    const res = await create({ prompt: 'Cao gấp đôi', parent_id: job.id });
    expect(res.statusCode).toBe(202);
    const revision = res.json().job;
    expect(revision.parent_id).toBe(job.id);
    const brief = await fs.readFile(path.join(jobsDir, revision.id, 'request.md'), 'utf8');
    expect(brief).toContain('Hộp vuông cạnh 10 mm');
    expect(brief).toContain('# Sửa lại\n\nCao gấp đôi');
    expect(await fs.readFile(path.join(jobsDir, revision.id, 'model.py'), 'utf8')).toBe('result = Box(10, 10, 10)\n');

    expect((await create({ prompt: 'Cao gấp đôi', parent_id: 'missing-job' })).statusCode).toBe(404);
  });

  it('puts the pictures pasted into a revision next to its brief', async () => {
    const { job } = (await create({ prompt: 'Hộp vuông cạnh 10 mm' })).json();
    await worker.finish(job.id);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

    const revision = (await create({ prompt: 'Thêm rãnh như ảnh', parent_id: job.id, images: [jpeg.toString('base64')] })).json().job;
    expect(await fs.readFile(path.join(jobsDir, revision.id, 'attachments', '1.jpg'))).toEqual(jpeg);
    expect(await fs.readFile(path.join(jobsDir, revision.id, 'request.md'), 'utf8')).toContain(
      '# Sửa lại\n\nThêm rãnh như ảnh\n\nẢnh người dùng gửi kèm yêu cầu này (mở bằng Read và xem kỹ trước khi sửa): attachments/1.jpg\n\nmodel.py'
    );
  });

  it('builds ready-made code (Antigravity) right away', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/cad/builds', payload: { code: 'result = Box(10, 10, 10)', title: 'Khối thử' } });
    expect(res.statusCode).toBe(201);
    const { job } = res.json();
    expect(worker.built).toEqual([job.id]);
    expect(job).toMatchObject({ source: 'code', title: 'Khối thử', state: 'done', files: { stl: true } });
    expect(await fs.readFile(path.join(jobsDir, job.id, 'model.py'), 'utf8')).toBe('result = Box(10, 10, 10)');
  });

  it('cancels a running job', async () => {
    const { job } = (await create({ prompt: 'Một cái hộp' })).json();
    const res = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/cancel`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(worker.cancelled).toEqual([job.id]);
    expect(res.json().job.state).toBe('cancelled');
  });

  it('deletes a version, keeping the ones made from it in the group, or a whole group', async () => {
    const { job: first } = (await create({ prompt: 'Hộp vuông cạnh 10 mm' })).json();
    await worker.finish(first.id);
    const { job: second } = (await create({ prompt: 'Cao 20 mm', parent_id: first.id })).json();
    await worker.finish(second.id);
    const { job: third } = (await create({ prompt: 'Bo góc', parent_id: second.id })).json();

    // Still being made: neither it nor its group can go
    expect((await app.inject({ method: 'DELETE', url: `/api/cad/jobs/${first.id}?family=1` })).statusCode).toBe(409);
    await worker.finish(third.id);

    const one = await app.inject({ method: 'DELETE', url: `/api/cad/jobs/${second.id}` });
    expect(one.json()).toEqual({ success: true, deleted: [second.id] });
    const moved = (await app.inject({ method: 'GET', url: `/api/cad/jobs/${third.id}` })).json().job;
    expect(moved.parent_id).toBe(first.id);

    const all = await app.inject({ method: 'DELETE', url: `/api/cad/jobs/${first.id}?family=1` });
    expect(all.json().deleted.sort()).toEqual([first.id, third.id].sort());
    expect((await app.inject({ method: 'GET', url: '/api/cad/jobs' })).json().jobs).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/cad/jobs/${first.id}` })).statusCode).toBe(404);
  });

  it('sends a finished model to Studio under its title, and refuses one still running', async () => {
    const { job } = (await create({ prompt: 'Hộp vuông cạnh 10 mm' })).json();
    const early = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/studio`, payload: {} });
    expect(early.statusCode).toBe(409);

    await worker.finish(job.id);
    const res = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/studio`, payload: { format: 'step' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Hop-vuong-10-mm.step', studioPath: '/imports/Hop-vuong-10-mm.step' });
    expect(await fs.readFile(path.join(importDir, 'Hop-vuong-10-mm.step'), 'utf8')).toBe('ISO-10303-21;\n');

    const stl = (await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/studio`, payload: {} })).json();
    expect(stl).toMatchObject({ name: 'Hop-vuong-10-mm.stl', repair: { changed: false } });
    const sent = (await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}` })).json().job.sent;
    expect(sent.map((s: { name: string }) => s.name)).toEqual(['Hop-vuong-10-mm.step', 'Hop-vuong-10-mm.stl']);
  });

  it('serves the files of a job, and nothing else', async () => {
    const { job } = (await create({ prompt: 'Hộp vuông cạnh 10 mm' })).json();
    await worker.finish(job.id);

    const preview = await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}/files/preview.png` });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/png');
    const stl = await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}/files/model.stl?download=1` });
    expect(stl.headers.get('content-disposition')).toBe('attachment; filename="Hop-vuong-10-mm.stl"');
    expect(Buffer.from(stl.rawBody)).toEqual(CUBE);

    expect((await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}/files/job.json` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/cad/jobs/..%2F..%2Fetc/files/model.py` })).statusCode).toBe(404);
  });

  it('draws and serves the assembly guide of a model with components', async () => {
    const { job } = (await create({ prompt: 'Bản lề hai chi tiết' })).json();
    await worker.finish(job.id);
    // A single part has nothing to put together
    expect((await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/guide` })).statusCode).toBe(409);

    await fs.writeFile(path.join(jobsDir, job.id, 'out', 'assembly.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const drawn = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/guide` });
    expect(drawn.statusCode).toBe(200);
    expect(drawn.json()).toMatchObject({ success: true, guide: { steps: 1 }, job: { files: { guide: true }, guide: { ok: true, steps: 1 } } });
    expect(worker.guided).toEqual([job.id]);

    const step = await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}/guide/step-01.png` });
    expect(step.statusCode).toBe(200);
    expect(step.headers.get('content-type')).toBe('image/png');
    expect((await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}/guide/guide.json` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}/guide/..%2Fmodel.png` })).statusCode).toBe(404);
    const steps = (await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}/files/guide.json` })).json();
    expect(steps.steps[0].parts).toEqual(['base']);

    // The video seeks with Range requests
    const part = await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}/files/assembly.mp4`, headers: { range: 'bytes=2-5' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(Buffer.from(part.rawBody).toString()).toBe('2345');
  });

  it('sends an assembly laid out on several plates to Studio one plate per file', async () => {
    const { job } = (await create({ prompt: 'Cánh tay robot 4 trục' })).json();
    await worker.finish(job.id);
    const out = path.join(jobsDir, job.id, 'out');
    await fs.mkdir(path.join(out, 'plates'), { recursive: true });
    await fs.writeFile(path.join(out, 'model.3mf'), 'all plates');
    await fs.writeFile(path.join(out, 'plates', 'plate-1.3mf'), 'plate one');
    await fs.writeFile(path.join(out, 'plates', 'plate-2.3mf'), 'plate two');
    const statusFile = path.join(jobsDir, job.id, 'status.json');
    const status = JSON.parse(await fs.readFile(statusFile, 'utf8'));
    status.report.print_layout = { plates: [{ n: 1, parts: ['base'] }, { n: 2, parts: ['arm'] }], plate_files: ['plates/plate-1.3mf', 'plates/plate-2.3mf'] };
    await fs.writeFile(statusFile, JSON.stringify(status));

    const sent = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/studio`, payload: { format: '3mf' } });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().names).toEqual(['Hop-vuong-10-mm-ban-1.3mf', 'Hop-vuong-10-mm-ban-2.3mf']);
    expect(await fs.readFile(path.join(importDir, 'Hop-vuong-10-mm-ban-2.3mf'), 'utf8')).toBe('plate two');
    const sentList = (await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}` })).json().job.sent;
    expect(sentList).toHaveLength(2);

    const plate = await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}/plates/2` });
    expect(plate.statusCode).toBe(200);
    expect(plate.headers.get('content-disposition')).toBe('attachment; filename="Hop-vuong-10-mm-ban-2.3mf"');
    expect((await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}/plates/3` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}/plates/..%2Fmodel` })).statusCode).toBe(404);
  });

  it('lists jobs newest first', async () => {
    const first = (await create({ prompt: 'Mô hình thứ nhất' })).json().job;
    const second = (await create({ prompt: 'Mô hình thứ hai' })).json().job;
    const { jobs } = (await app.inject({ method: 'GET', url: '/api/cad/jobs' })).json();
    expect(jobs.map((j: { id: string }) => j.id)).toEqual([second.id, first.id].sort().reverse());
  });
});

describe('CAD job helpers', () => {
  it('makes sortable job ids the worker accepts', () => {
    const id = newJobId(new Date('2026-10-23T09:15:02Z'));
    expect(id).toMatch(/^20261023-091502-[0-9a-f]{4}$/);
  });

  it('builds a revision brief on the previous one', () => {
    expect(buildRequest(' Giá đỡ ')).toBe('# Yêu cầu\n\nGiá đỡ\n');
    const brief = buildRequest('Dày hơn', { request: '# Yêu cầu\n\nGiá đỡ\n', prompt: 'Giá đỡ' });
    expect(brief.startsWith('# Yêu cầu\n\nGiá đỡ\n\n# Sửa lại\n\nDày hơn\n')).toBe(true);
  });
});
