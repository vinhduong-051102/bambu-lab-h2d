import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { env } from '../src/config/env';
import { CadWorkerError } from '../src/domain/cad/cadJobs';
import { setCadConverter, setConvertJobsDir, type CadConverterApi, type ConvertRequest, type ConvertResult } from '../src/api/routes/cadConvert';
import { createTestApp, type TestApp } from './helpers/testApp';

const JOB_ID = '20261028-101500-ab12';

/** Stands in for the CAD container's POST /convert: writes the STLs cad/convert.py would */
class FakeConverter implements CadConverterApi {
  requests: ConvertRequest[] = [];
  fail: CadWorkerError | null = null;

  constructor(private readonly dir: string) {}

  async convert(request: ConvertRequest): Promise<ConvertResult> {
    this.requests.push(request);
    if (this.fail) throw this.fail;
    const out = path.join(this.dir, request.job_id ?? JOB_ID, 'out');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, '01-box.stl'), 'solid box\nendsolid box\n');
    await fs.writeFile(path.join(out, 'convert.json'), '{"ok": true}');
    const mesh = { triangles: 12, watertight: true, open_edges: 0, non_manifold_edges: 0 };
    return {
      ok: true,
      job_id: request.job_id ?? JOB_ID,
      source: request.filename ?? path.basename(request.file ?? ''),
      units: 'millimetre',
      tolerance_mm: request.tolerance_mm ?? 0.01,
      angular_tolerance_deg: request.angular_tolerance_deg ?? 0.5,
      solids: [{ name: 'box', file: '01-box.stl', volume_mm3: 1000, bbox: { min: [0, 0, 0], max: [20, 10, 5], size: [20, 10, 5] }, faces: 6, mesh }],
      warnings: [],
      seconds: 0.4,
    };
  }
}

describe('STEP/IGES to STL (/api/cad/convert)', () => {
  let app: TestApp;
  let jobsDir: string;
  let converter: FakeConverter;

  beforeEach(async () => {
    const stateStore = new PrinterStateStore('TEST_SERIAL_CONVERT');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_CONVERT', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);
    jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cad-convert-'));
    converter = new FakeConverter(jobsDir);
    setCadConverter(converter);
    setConvertJobsDir(jobsDir);
  });

  afterEach(async () => {
    app.close();
    setCadConverter(null);
    setConvertJobsDir(null);
    await fs.rm(jobsDir, { recursive: true, force: true });
  });

  const convert = (payload: unknown) => app.inject({ method: 'POST', url: '/api/cad/convert', payload });

  it('passes an upload to the worker and links each solid to its STL', async () => {
    const data = Buffer.from('ISO-10303-21;').toString('base64');
    const res = await convert({ data_base64: data, filename: 'parts.STEP', tolerance_mm: 0.02 });
    expect(res.statusCode).toBe(200);
    expect(converter.requests).toEqual([{ data_base64: data, filename: 'parts.STEP', tolerance_mm: 0.02 }]);
    const body = res.json();
    expect(body).toMatchObject({ success: true, job_id: JOB_ID, units: 'millimetre', report_url: `/api/cad/convert/${JOB_ID}/convert.json` });
    expect(body.solids[0]).toMatchObject({ name: 'box', volume_mm3: 1000, url: `/api/cad/convert/${JOB_ID}/01-box.stl` });

    const stl = await app.inject({ method: 'GET', url: `${body.solids[0].url}?download=1` });
    expect(stl.statusCode).toBe(200);
    expect(stl.headers.get('content-type')).toBe('model/stl');
    expect(stl.headers.get('content-disposition')).toContain('01-box.stl');
    expect(stl.body).toContain('solid box');
  });

  it('takes a multipart upload', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('ISO-10303-21;')]), 'bracket.igs');
    form.append('angular_tolerance_deg', '1');
    const res = await app.inject({ method: 'POST', url: '/api/cad/convert', form });
    expect(res.statusCode).toBe(200);
    expect(converter.requests[0]).toMatchObject({ filename: 'bracket.igs', angular_tolerance_deg: 1 });
    expect(Buffer.from(converter.requests[0].data_base64!, 'base64').toString()).toBe('ISO-10303-21;');
  });

  it('passes a file already in the jobs folder', async () => {
    const res = await convert({ file: `${JOB_ID}/parts.step` });
    expect(res.statusCode).toBe(200);
    expect(converter.requests).toEqual([{ file: `${JOB_ID}/parts.step` }]);
  });

  it('rejects requests the worker could not use', async () => {
    for (const payload of [{}, { data_base64: 'AAAA', filename: 'model.stl' }, { data_base64: 'AAAA' }, { file: 'x.step', tolerance_mm: 5 }, { file: 'x.step', job_id: '../etc' }]) {
      const res = await convert(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toBe('INVALID_PAYLOAD');
    }
    expect(converter.requests).toHaveLength(0);
  });

  it('passes on a file the worker could not read', async () => {
    converter.fail = new CadWorkerError(422, 'CONVERT_FAILED', 'Không đọc được file STEP: file hỏng hoặc không đúng định dạng ISO-10303-21.');
    const res = await convert({ data_base64: 'AAAA', filename: 'broken.step' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ success: false, error: 'CONVERT_FAILED', message: expect.stringContaining('STEP') });
  });

  it('serves only what a conversion writes', async () => {
    await convert({ data_base64: 'AAAA', filename: 'parts.step' });
    for (const url of [`/api/cad/convert/${JOB_ID}/model.py`, `/api/cad/convert/${JOB_ID}/..%2Fjob.json`, `/api/cad/convert/${JOB_ID}/02-missing.stl`, '/api/cad/convert/BAD/01-box.stl']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    const report = await app.inject({ method: 'GET', url: `/api/cad/convert/${JOB_ID}/convert.json` });
    expect(report.json()).toEqual({ ok: true });
  });

  it('is off without CAD_WORKER_URL', async () => {
    setCadConverter(null);
    const saved = env.CAD_WORKER_URL;
    env.CAD_WORKER_URL = undefined;
    try {
      expect((await convert({ data_base64: 'AAAA', filename: 'a.step' })).statusCode).toBe(501);
    } finally {
      env.CAD_WORKER_URL = saved;
    }
  });
});
