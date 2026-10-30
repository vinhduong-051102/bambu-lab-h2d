import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { engGetPath, setEngWorkerUrl } from '../src/api/routes/eng';
import { clearTasks } from '../src/domain/backgroundTasks';
import { createTestApp, type TestApp } from './helpers/testApp';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** Stands in for mesh3d/worker.py's /eng routes */
function fakeWorker() {
  const seen: { method: string; url: string; body: unknown }[] = [];
  // The slow job's check answers when the test lets it
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
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
    if (req.url === '/eng/check' && req.method === 'POST' && (seen.at(-1)?.body as { job_id?: string })?.job_id === '20261029-120000-slow') {
      await released;
      return reply(200, { ok: true, report: { status: 'PASS' }, results: {} });
    }
    if (req.url === '/eng/check' && req.method === 'POST' && (seen.at(-1)?.body as { job_id?: string })?.job_id === '20261029-120000-bad1') {
      return reply(422, { ok: false, error: 'INVALID_INPUT', message: 'Thông số in sai', details: [{ path: 'print.nozzle_mm', message: 'Phải lớn hơn 0' }] });
    }
    if (req.url === '/eng/check' && req.method === 'POST') return reply(200, { ok: true, report: { status: 'WARNING' }, results: {} });
    if (req.url === '/eng/checks/20261029-120000-slow') return reply(200, { ok: true, report: null, results: {} });
    if (req.url === '/eng/checks/20261028-101211-01bd') return reply(200, { ok: true, report: null, results: {} });
    reply(404, { ok: false, error: 'NOT_FOUND', message: 'Không có.' });
  });
  return { server, seen, release };
}

describe('Engineering analysis (/api/eng)', () => {
  let app: TestApp;
  let worker: ReturnType<typeof fakeWorker>;

  beforeEach(async () => {
    clearTasks();
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
    worker.release();
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
    expect(last.json()).toMatchObject({ success: true, report: null, results: {}, task: { running: false, error: null } });
    expect(engGetPath(['checks', '../jobs'])).toBeNull();
  });

  it('keeps a long check running when its page goes, and shows it to the page opened again', async () => {
    const job = '20261029-120000-slow';
    const run = await app.inject({ method: 'POST', url: '/api/eng/check', payload: { job_id: job } });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toMatchObject({ success: true, running: true, started: true, task: { running: true } });
    // Opened again while it runs: the same check, not a second one
    const again = await app.inject({ method: 'POST', url: '/api/eng/check', payload: { job_id: job } });
    expect(again.json()).toMatchObject({ running: true, started: false });
    const reading = await app.inject({ method: 'GET', url: `/api/eng/checks/${job}` });
    expect(reading.json().task).toMatchObject({ running: true, finished_at: null });
    worker.release();
    await expect.poll(async () => (await app.inject({ method: 'GET', url: `/api/eng/checks/${job}` })).json().task.running).toBe(false);
    expect(worker.seen.filter((r) => r.url === '/eng/check')).toHaveLength(1);
  });

  it('lists a failed check on the task panel with its details, and runs it again from there', async () => {
    const job = '20261029-120000-bad1';
    const run = await app.inject({ method: 'POST', url: '/api/eng/check', payload: { job_id: job, name: 'Giá đỡ', print: { nozzle_mm: 0 } } });
    expect(run.statusCode).toBe(422);
    const tasks = (await app.inject({ method: 'GET', url: '/api/tasks' })).json().tasks;
    const task = tasks.find((t: { key: string }) => t.key === `eng-check:${job}`);
    expect(task).toMatchObject({
      kind: 'eng-check',
      label: 'Giá đỡ',
      state: 'failed',
      error: 'Thông số in sai',
      details: ['HTTP 422 · INVALID_INPUT', 'print.nozzle_mm: Phải lớn hơn 0'],
    });
    const again = await app.inject({ method: 'POST', url: task.retry_url, payload: {} });
    expect(again.statusCode).toBe(202);
    const state = async () =>
      (await app.inject({ method: 'GET', url: '/api/tasks' })).json().tasks.find((t: { key: string }) => t.key === `eng-check:${job}`).state;
    await expect.poll(state).toBe('failed');
    // Run again as first asked
    expect(worker.seen.filter((r) => r.url === '/eng/check').map((r) => r.body)).toEqual([
      { job_id: job, name: 'Giá đỡ', print: { nozzle_mm: 0 } },
      { job_id: job, name: 'Giá đỡ', print: { nozzle_mm: 0 } },
    ]);
    expect((await app.inject({ method: 'POST', url: '/api/tasks/retry?key=nope', payload: {} })).statusCode).toBe(409);
  });

  it('refuses unknown tools and paths that leave the analysis folder', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/eng/delete-everything', payload: {} })).statusCode).toBe(404);
    expect(engGetPath(['analyses', 'a-20261028-120000-ab12', 'files', '..', 'x'])).toBeNull();
    expect(engGetPath(['analyses', '../etc'])).toBeNull();
    expect(engGetPath(['models'])).toBe('models');
    expect(worker.seen).toHaveLength(0);
  });
});
