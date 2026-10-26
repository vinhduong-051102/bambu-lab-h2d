import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { env } from '../src/config/env';
import { CadJobStore, type MeshParams, type MeshWorkerApi } from '../src/domain/cad/cadJobs';
import { setCadJobStore, setCadWorker, setMeshWorker } from '../src/api/routes/cad';
import { normalizePrinterState } from '../src/domain/normalizePrinterState';
import { createTestApp, type TestApp } from './helpers/testApp';

const PNG: Uint8Array<ArrayBuffer> = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Stands in for the mesh container: records what it was asked and writes what mesh3d/worker.py would */
class FakeMeshWorker implements MeshWorkerApi {
  generated: { id: string; params: MeshParams }[] = [];
  fixed: { id: string; parentId: string; model: string }[] = [];
  cancelled: string[] = [];
  running: string[] = [];

  constructor(private readonly dir: string) {}

  async health() {
    return { ok: true, claude: true, running: this.running, loaded: false };
  }

  async generate(id: string, params: MeshParams) {
    this.generated.push({ id, params });
    this.running.push(id);
    await fs.writeFile(path.join(this.dir, id, 'status.json'), JSON.stringify({ state: 'running', step: 'queued', notes: [] }));
  }

  async fix(id: string, parentId: string, model: string) {
    this.fixed.push({ id, parentId, model });
    this.running.push(id);
    await fs.writeFile(path.join(this.dir, id, 'status.json'), JSON.stringify({ state: 'running', step: 'starting', input: 'fix', notes: [] }));
  }

  async cancel(id: string) {
    this.cancelled.push(id);
    this.running = this.running.filter((r) => r !== id);
    await fs.writeFile(path.join(this.dir, id, 'status.json'), JSON.stringify({ state: 'cancelled', error: 'Đã hủy.' }));
  }

  async finish(id: string) {
    this.running = this.running.filter((r) => r !== id);
    const out = path.join(this.dir, id, 'out');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'model.stl'), 'solid x\nendsolid x\n');
    await fs.writeFile(path.join(this.dir, id, 'concept.png'), PNG);
    await fs.writeFile(
      path.join(this.dir, id, 'status.json'),
      JSON.stringify({ state: 'done', result: { title: 'Mèo ngồi', summary: '', assumptions: [], parameters: [], warnings: [] }, report: { ok: true } })
    );
  }
}

/** An AMS tray in the printer's own report */
const tray = (id: string, type: string, color: string) => ({ id, tray_type: type, tray_sub_brands: `${type} Basic`, tray_color: color, state: 11 });

describe('AI figures (/api/cad/meshes)', () => {
  let app: TestApp;
  let jobsDir: string;
  let mesh: FakeMeshWorker;
  let stateStore: PrinterStateStore;

  beforeEach(async () => {
    stateStore = new PrinterStateStore('TEST_SERIAL_MESH');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_MESH', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);
    jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-jobs-'));
    mesh = new FakeMeshWorker(jobsDir);
    setCadJobStore(new CadJobStore(jobsDir));
    setMeshWorker(mesh);
  });

  afterEach(async () => {
    app.close();
    setCadJobStore(null);
    setMeshWorker(null);
    setCadWorker(null);
    env.STUDIO_IMPORT_DIR = undefined;
    await fs.rm(jobsDir, { recursive: true, force: true });
  });

  const upload = (fields: Record<string, string>, image?: Uint8Array<ArrayBuffer>) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    if (image) form.append('image', new File([image], 'cat.png', { type: 'image/png' }));
    return app.inject({ method: 'POST', url: '/api/cad/meshes', form });
  };

  it('is offered when only the mesh worker is set up', async () => {
    const saved = env.CAD_WORKER_URL;
    env.CAD_WORKER_URL = undefined;
    try {
      const res = (await app.inject({ method: 'GET', url: '/api/cad' })).json();
      expect(res).toMatchObject({ enabled: true, worker: null, mesh: { online: true, claude: true, loaded: false } });
    } finally {
      env.CAD_WORKER_URL = saved;
    }
  });

  it('makes a figure from an uploaded picture', async () => {
    const res = await upload({ height_mm: '60', base: 'true' }, PNG);
    expect(res.statusCode).toBe(202);
    const { job } = res.json();
    expect(job).toMatchObject({ source: 'mesh', model: 'hunyuan3d-2mini-turbo', prompt: 'Mô hình từ ảnh', state: 'running', step: 'queued' });
    expect(mesh.generated[0].params).toMatchObject({ prompt: '', height_mm: 60, base: true });
    expect(mesh.generated[0].params.seed).toBeGreaterThan(0);
    expect(new Uint8Array(await fs.readFile(path.join(jobsDir, job.id, 'input.png')))).toEqual(PNG);
  });

  it('makes a figure from a description alone, as JSON too', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/cad/meshes', payload: { prompt: 'Mèo ngồi đội mũ', seed: 7 } });
    expect(res.statusCode).toBe(202);
    expect(mesh.generated[0].params).toEqual({ prompt: 'Mèo ngồi đội mũ', height_mm: 80, base: false, seed: 7, colour: null });
  });

  it('colours a figure with as many filaments as asked', async () => {
    const res = await upload({ prompt: 'Mèo cam đội mũ đen', colour: 'true', colours: '5' });
    expect(res.statusCode).toBe(202);
    expect(mesh.generated[0].params.colour).toMatchObject({ count: 5 });
    expect((await upload({ prompt: 'Mèo', colour: 'true', colours: '12' })).statusCode).toBe(400);
  });

  it('colours a figure with the filaments loaded in the AMS, in Studio\'s order', async () => {
    const payload = {
      print: {
        ams: {
          ams: [
            { id: '0', tray: [tray('0', 'PETG', 'FFFFFFFF'), { id: '1', state: 10 }, tray('2', 'PLA', '000000FF')] },
            { id: '1', tray: [tray('0', 'PLA', 'FF8800FF')] },
          ],
        },
      },
    };
    stateStore.updateState(normalizePrinterState(stateStore.getState(), payload));
    const res = await upload({ prompt: 'Mèo cam', colour: 'true', palette: 'ams' });
    expect(res.statusCode).toBe(202);
    expect(mesh.generated[0].params.colour).toMatchObject({
      palette: [
        { hex: '#FFFFFF', label: 'AMS 1 khay 1: PETG Basic', material: 'PETG' },
        { hex: '#000000', label: 'AMS 1 khay 3: PLA Basic', material: 'PLA' },
        { hex: '#FF8800', label: 'AMS 2 khay 1: PLA Basic', material: 'PLA' },
      ],
    });
  });

  it('refuses AMS colours when the AMS has fewer than two filaments', async () => {
    const res = await upload({ prompt: 'Mèo cam', colour: 'true', palette: 'ams' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('AMS_TOO_FEW_COLOURS');
  });

  it('needs a picture or a description, and only takes pictures', async () => {
    expect((await upload({ prompt: 'a' })).json().error).toBe('NO_INPUT');
    expect((await upload({ prompt: 'Mèo' }, new Uint8Array(new TextEncoder().encode("not an image")))).statusCode).toBe(415);
    expect((await upload({ prompt: 'Mèo ngồi', height_mm: '500' })).statusCode).toBe(400);
    expect(mesh.generated).toHaveLength(0);
  });

  it('makes a figure again from the same picture with a new seed', async () => {
    const { job } = (await upload({ prompt: 'Mèo ngồi' }, PNG)).json();
    await mesh.finish(job.id);
    const res = await upload({ parent_id: job.id, height_mm: '100' });
    expect(res.statusCode).toBe(202);
    const again = res.json().job;
    expect(again.parent_id).toBe(job.id);
    expect(mesh.generated[1].params).toMatchObject({ prompt: 'Mèo ngồi', height_mm: 100 });
    expect(new Uint8Array(await fs.readFile(path.join(jobsDir, again.id, 'input.png')))).toEqual(PNG);
  });

  it('has Claude review and fix a finished figure as a new job, briefed with what it is and what to fix', async () => {
    const { job } = (await upload({ prompt: 'Goku đứng', height_mm: '80', base: 'true' }, PNG)).json();
    const early = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/fix`, payload: {} });
    expect(early.json().error).toBe('MODEL_NOT_READY');
    await mesh.finish(job.id);

    const res = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/fix`, payload: { prompt: 'Chân bị cụt' } });
    expect(res.statusCode).toBe(202);
    const fix = res.json().job;
    expect(fix).toMatchObject({ source: 'mesh', model: 'claude-opus-5-5', parent_id: job.id, prompt: 'Chân bị cụt', input: 'fix', title: 'Mèo ngồi' });
    expect(mesh.fixed).toEqual([{ id: fix.id, parentId: job.id, model: 'claude-opus-5-5' }]);
    const brief = await fs.readFile(path.join(jobsDir, fix.id, 'request.md'), 'utf8');
    expect(brief).toContain('Mô tả của người dùng: Goku đứng');
    expect(brief).toContain('# Cần sửa\n\nChân bị cụt');

    // Without words Claude looks for problems itself; a fix of a fix builds on the brief before it
    await fs.mkdir(path.join(jobsDir, fix.id, 'out'), { recursive: true });
    await fs.writeFile(path.join(jobsDir, fix.id, 'out', 'model.stl'), 'solid x\nendsolid x\n');
    await fs.writeFile(path.join(jobsDir, fix.id, 'status.json'), JSON.stringify({ state: 'done', input: 'fix', report: { ok: true } }));
    const again = (await app.inject({ method: 'POST', url: `/api/cad/jobs/${fix.id}/fix`, payload: { model: 'claude-sonnet-5-5' } })).json().job;
    expect(again.prompt).toBe('Claude tự xem và sửa lỗi');
    const second = await fs.readFile(path.join(jobsDir, again.id, 'request.md'), 'utf8');
    expect(second.startsWith(brief.trim())).toBe(true);
    expect(second).toContain('Không có yêu cầu cụ thể');

    // Making a fixed figure again starts from the picture the first one was made from
    const remake = (await upload({ parent_id: fix.id })).json().job;
    expect(remake.parent_id).toBe(fix.id);
    expect(mesh.generated.at(-1)!.params.prompt).toBe('Goku đứng');
    expect(new Uint8Array(await fs.readFile(path.join(jobsDir, remake.id, 'input.png')))).toEqual(PNG);
  });

  it('only fixes figures, with the models offered', async () => {
    const { job } = (await upload({ prompt: 'Mèo ngồi' })).json();
    await mesh.finish(job.id);
    const model = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/fix`, payload: { model: 'gpt-4' } });
    expect(model.json().error).toBe('UNSUPPORTED_MODEL');
    expect((await app.inject({ method: 'POST', url: '/api/cad/jobs/20261023-000000-zzzz/fix', payload: {} })).statusCode).toBe(404);
    expect(mesh.fixed).toHaveLength(0);
  });

  it('cancels on the mesh worker, and shows a figure it dropped as interrupted', async () => {
    const { job } = (await upload({ prompt: 'Mèo ngồi' })).json();
    const res = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/cancel`, payload: {} });
    expect(res.json().job.state).toBe('cancelled');
    expect(mesh.cancelled).toEqual([job.id]);

    const other = (await upload({ prompt: 'Chó ngồi' })).json().job;
    mesh.running = [];
    expect((await app.inject({ method: 'GET', url: `/api/cad/jobs/${other.id}` })).json().job.state).toBe('failed');
  });

  it('sends only the STL of a figure to Studio, and serves its picture', async () => {
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-imports-'));
    env.STUDIO_IMPORT_DIR = importDir;
    try {
      const { job } = (await upload({ prompt: 'Mèo ngồi' })).json();
      await mesh.finish(job.id);
      const step = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/studio`, payload: { format: 'step' } });
      expect(step.json().error).toBe('NO_STEP');
      const threemf = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/studio`, payload: { format: '3mf' } });
      expect(threemf.json().error).toBe('NO_3MF');

      // Coloured: the painted 3MF goes to Studio as it is
      await fs.writeFile(path.join(jobsDir, job.id, 'out', 'model.3mf'), 'PK-3mf');
      const painted = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/studio`, payload: { format: '3mf' } });
      expect(painted.statusCode).toBe(201);
      expect(painted.json().name).toBe('Meo-ngoi.3mf');
      expect(await fs.readFile(path.join(importDir, 'Meo-ngoi.3mf'), 'utf8')).toBe('PK-3mf');
      const stl = await app.inject({ method: 'POST', url: `/api/cad/jobs/${job.id}/studio`, payload: {} });
      expect(stl.statusCode).toBe(201);
      expect(stl.json().name).toBe('Meo-ngoi.stl');

      const picture = await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}/files/concept.png` });
      expect(picture.headers.get('content-type')).toBe('image/png');
      expect((await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}` })).json().job.files).toMatchObject({ concept: true, step: false, threemf: true });
    } finally {
      await fs.rm(importDir, { recursive: true, force: true });
    }
  });
});
