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
