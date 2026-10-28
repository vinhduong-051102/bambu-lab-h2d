import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { env } from '../src/config/env';
import { setSimWorkerUrl } from '../src/api/routes/sim';
import { createTestApp, type TestApp } from './helpers/testApp';

const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]);

/** Stands in for mesh3d/worker.py's /sim routes: records requests, answers as the worker would */
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
    if (req.url === '/sim/runs' && req.method === 'POST') return reply(202, { ok: true, sim_id: 's-20261028-120000-ab12', state: 'queued' });
    if (req.url === '/sim/mechanisms/m-20261028-120000-ab12/joints') {
      return reply(422, { ok: false, error: 'INVALID_PART', message: 'Không thêm được: Không có body \'ghost\'.', details: [{ path: 'joints[1].body_b', message: 'Không có body \'ghost\'.' }] });
    }
    if (req.url === '/sim/runs/s-20261028-120000-ab12/files/blender/playback.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      return res.end(MP4);
    }
    if (req.url === '/sim/runs/s-20261028-120000-ab12') return reply(200, { ok: true, status: { state: 'running', progress: 0.4 } });
    reply(404, { ok: false, error: 'NOT_FOUND', message: 'Không có.' });
  });
  return { server, seen };
}

describe('Mechanism simulation (/api/sim)', () => {
  let app: TestApp;
  let worker: ReturnType<typeof fakeWorker>;

  beforeEach(async () => {
    const stateStore = new PrinterStateStore('TEST_SERIAL_SIM');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_SIM', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);
    worker = fakeWorker();
    await new Promise<void>((resolve) => worker.server.listen(0, '127.0.0.1', resolve));
    setSimWorkerUrl(`http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`);
  });

  afterEach(async () => {
    app.close();
    setSimWorkerUrl(null);
    await new Promise((resolve) => worker.server.close(resolve));
  });

  it('starts a run in the mesh worker and passes its answer back', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sim/runs', payload: { mechanism_id: 'm-20261028-120000-ab12', simulation: { duration: 2 } } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ success: true, sim_id: 's-20261028-120000-ab12', state: 'queued' });
    expect(worker.seen[0]).toEqual({ method: 'POST', url: '/sim/runs', body: { mechanism_id: 'm-20261028-120000-ab12', simulation: { duration: 2 } } });
  });

  it('keeps the worker\'s validation errors and status code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sim/mechanisms/m-20261028-120000-ab12/joints',
      payload: { joint: { id: 'j2', type: 'revolute', body_a: 'base', body_b: 'ghost' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ success: false, error: 'INVALID_PART', details: [{ path: 'joints[1].body_b' }] });
  });

  it('reads a run\'s state', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sim/runs/s-20261028-120000-ab12' });
    expect(res.json()).toEqual({ success: true, status: { state: 'running', progress: 0.4 } });
  });

  it('streams Blender\'s video as the worker sent it', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sim/runs/s-20261028-120000-ab12/files/blender/playback.mp4' });
    expect(res.statusCode).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(res.rawBody)).toEqual(MP4);
  });

  it('refuses ids and parts it does not know before asking the worker', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/sim/runs/..%2F..%2Fetc' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/sim/mechanisms/m-20261028-120000-ab12/bodies', payload: {} })).statusCode).toBe(404);
    expect(worker.seen).toEqual([]);
  });

  it('says when the mesh worker is not set up', async () => {
    setSimWorkerUrl(null);
    const saved = env.MESH_WORKER_URL;
    env.MESH_WORKER_URL = undefined;
    try {
      const res = await app.inject({ method: 'GET', url: '/api/sim/runs' });
      expect(res.statusCode).toBe(501);
      expect(res.json()).toMatchObject({ error: 'SIM_DISABLED' });
    } finally {
      env.MESH_WORKER_URL = saved;
    }
  });
});
