import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { mechPath, setMechWorkerUrl } from '../src/api/routes/mech';
import { createTestApp, type TestApp } from './helpers/testApp';

const DESIGN = 'd-20261029-010203-ab12';

/** Stands in for mesh3d/worker.py's /mech routes */
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
    if (req.url === '/mech/designs' && req.method === 'POST') return reply(200, { ok: true, design_id: DESIGN, revision: 1, status: 'warning' });
    if (req.url === `/mech/designs/${DESIGN}/simulate`) {
      return reply(422, { ok: false, error: 'NOT_VALID', message: 'Mô hình chưa chạy được', details: { diagnostics: [{ code: 'MOTOR_ON_LOCKED_PAIR', joints: ['weld'] }] } });
    }
    if (req.url === `/mech/designs/${DESIGN}?revision=2`) return reply(200, { ok: true, design_id: DESIGN, revision: 2 });
    reply(404, { ok: false, error: 'NOT_FOUND', message: 'Không có.' });
  });
  return { server, seen };
}

describe('Mechanical model (/api/mech)', () => {
  let app: TestApp;
  let worker: ReturnType<typeof fakeWorker>;

  beforeEach(async () => {
    const stateStore = new PrinterStateStore('TEST_SERIAL_MECH');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_MECH', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);
    worker = fakeWorker();
    await new Promise<void>((resolve) => worker.server.listen(0, '127.0.0.1', resolve));
    setMechWorkerUrl(`http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`);
  });

  afterEach(async () => {
    setMechWorkerUrl(null);
    await new Promise<void>((resolve) => worker.server.close(() => resolve()));
    app.close();
  });

  it('creates a design through the worker', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/mech/designs', payload: { model: { schema: 'mech/1' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, design_id: DESIGN, status: 'warning' });
    expect(worker.seen[0]).toMatchObject({ method: 'POST', url: '/mech/designs', body: { model: { schema: 'mech/1' } } });
  });

  it('keeps a refusal with its diagnostics', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/mech/designs/${DESIGN}/simulate`, payload: { wait_s: 5 } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ success: false, error: 'NOT_VALID', details: { diagnostics: [{ code: 'MOTOR_ON_LOCKED_PAIR' }] } });
  });

  it('passes a revision query and refuses what is not a mech route', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/mech/designs/${DESIGN}?revision=2` });
    expect(res.json()).toMatchObject({ success: true, revision: 2 });
    expect((await app.inject({ method: 'POST', url: `/api/mech/designs/${DESIGN}/delete`, payload: {} })).statusCode).toBe(404);
    expect(mechPath('GET', ['designs', '../x'])).toBeNull();
    expect(mechPath('GET', ['designs', DESIGN, 'runs', 's-20261029-010203-ab12'])).toBe(`designs/${DESIGN}/runs/s-20261029-010203-ab12`);
    expect(mechPath('GET', ['guide'])).toBe('guide');
  });
});
