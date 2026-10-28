import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { engGetPath, setEngWorkerUrl } from '../src/api/routes/eng';
import { createTestApp, type TestApp } from './helpers/testApp';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** Stands in for mesh3d/worker.py's /eng routes */
function fakeWorker() {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    seen.push({ method: req.method ?? '', url: req.url ?? '', body: text ? JSON.parse(text) : undefined });
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/eng/validate' && req.method === 'POST') {
      return reply(200, { ok: true, result: { kind: 'validate', status: 'FAIL', checks: [{ id: 'a.inverted', status: 'FAIL' }] } });
    }
    if (req.url === '/eng/fea/configure') {
      return reply(422, { ok: false, error: 'INVALID_INPUT', message: 'material', details: [{ path: 'material', message: 'Cần E' }] });
    }
    if (req.url === '/eng/analyses/a-20261028-120000-ab12/files/result.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PNG);
    }
    if (req.url === '/eng/analyses?model_id=m-20261028-120000-ab12') return reply(200, { ok: true, analyses: [] });
    if (req.url === '/eng/check' && req.method === 'POST') return reply(200, { ok: true, report: { status: 'WARNING' }, results: {} });
    if (req.url === '/eng/checks/20261028-101211-01bd') return reply(200, { ok: true, report: null, results: {} });
    reply(404, { ok: false, error: 'NOT_FOUND', message: 'Không có.' });
  });
  return { server, seen };
}

describe('Engineering analysis (/api/eng)', () => {
  let app: TestApp;
  let worker: ReturnType<typeof fakeWorker>;

  beforeEach(async () => {
    const stateStore = new PrinterStateStore('TEST_SERIAL_ENG');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_ENG', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);
    worker = fakeWorker();
    await new Promise<void>((resolve) => worker.server.listen(0, '127.0.0.1', resolve));
    setEngWorkerUrl(`http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`);
  });

  afterEach(async () => {
    setEngWorkerUrl(null);
    await new Promise<void>((resolve) => worker.server.close(() => resolve()));
    app.close();
  });

  it('passes a tool call through and turns ok into success', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/eng/validate', payload: { model_id: 'm-20261028-120000-ab12' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().result.status).toBe('FAIL');
    expect(worker.seen[0]).toMatchObject({ method: 'POST', url: '/eng/validate', body: { model_id: 'm-20261028-120000-ab12' } });
  });

  it('keeps the worker\'s errors and their field paths', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/eng/fea/configure', payload: { model_id: 'm-20261028-120000-ab12', config: {} } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ success: false, error: 'INVALID_INPUT', details: [{ path: 'material' }] });
  });

  it('serves result files and query strings', async () => {
    const png = await app.inject({ method: 'GET', url: '/api/eng/analyses/a-20261028-120000-ab12/files/result.png' });
    expect(png.statusCode).toBe(200);
    expect(png.headers.get('content-type')).toContain('image/png');
    expect(Array.from(png.rawBody)).toEqual(Array.from(PNG));
    const list = await app.inject({ method: 'GET', url: '/api/eng/analyses?model_id=m-20261028-120000-ab12' });
    expect(list.json()).toMatchObject({ success: true, analyses: [] });
  });

  it('runs and reads the design tab\'s check of a job', async () => {
    const run = await app.inject({ method: 'POST', url: '/api/eng/check', payload: { job_id: '20261028-101211-01bd', print: { nozzle_mm: 0.4 } } });
    expect(run.json()).toMatchObject({ success: true, report: { status: 'WARNING' } });
    expect(worker.seen[0]).toMatchObject({ method: 'POST', url: '/eng/check', body: { job_id: '20261028-101211-01bd' } });
    const last = await app.inject({ method: 'GET', url: '/api/eng/checks/20261028-101211-01bd' });
    expect(last.json()).toEqual({ success: true, report: null, results: {} });
    expect(engGetPath(['checks', '../jobs'])).toBeNull();
  });

  it('refuses unknown tools and paths that leave the analysis folder', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/eng/delete-everything', payload: {} })).statusCode).toBe(404);
    expect(engGetPath(['analyses', 'a-20261028-120000-ab12', 'files', '..', 'x'])).toBeNull();
    expect(engGetPath(['analyses', '../etc'])).toBeNull();
    expect(engGetPath(['models'])).toBe('models');
    expect(worker.seen).toHaveLength(0);
  });
});
