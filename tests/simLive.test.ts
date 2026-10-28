import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { env } from '../src/config/env';
import { setSimLiveUrl } from '../src/api/routes/simLive';
import { createTestApp, type TestApp } from './helpers/testApp';

const SID = 'l-20261029-101500-ab12';
const STATE = { session_id: SID, t: 0.25, running: true, bodies: { box: { p: [0, 0, 0.01], q: [1, 0, 0, 0] } } };

/** Stands in for mesh3d/sim/live.py: records requests, answers as it would */
function fakeLive() {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    seen.push({ method: req.method ?? '', url: req.url ?? '', body: text ? JSON.parse(text) : undefined });
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/live' && req.method === 'POST') return reply(201, { ok: true, session_id: SID, scene: { bodies: [] }, state: STATE });
    if (req.url === `/live/${SID}/actions`) {
      const body = JSON.parse(text);
      if (body.body === 'ground') return reply(409, { ok: false, error: 'BODY_FIXED', message: 'ground là body cố định.' });
      return reply(200, { ok: true, t: 0.25, state: STATE });
    }
    if (req.url === `/live/${SID}/stream?hz=20`) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(STATE)}\n\n`);
      res.write(`data: ${JSON.stringify({ ...STATE, t: 0.3 })}\n\n`);
      return res.end('event: end\ndata: {}\n\n');
    }
    if (req.url === `/live/${SID}/mesh/box`) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(Buffer.from('solid box'));
    }
    reply(404, { ok: false, error: 'SESSION_NOT_FOUND', message: 'Không có phiên.' });
  });
  return { server, seen };
}

describe('Interactive simulation (/api/sim/live)', () => {
  let app: TestApp;
  let live: ReturnType<typeof fakeLive>;

  beforeEach(async () => {
    const stateStore = new PrinterStateStore('TEST_SERIAL_LIVE');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_LIVE', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);
    live = fakeLive();
    await new Promise<void>((resolve) => live.server.listen(0, '127.0.0.1', resolve));
    setSimLiveUrl(`http://127.0.0.1:${(live.server.address() as AddressInfo).port}`);
  });

  afterEach(async () => {
    app.close();
    setSimLiveUrl(null);
    await new Promise((resolve) => live.server.close(resolve));
  });

  it('starts a session and passes the answer back', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sim/live', payload: { mechanism_id: 'm-20261028-120000-ab12' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ success: true, session_id: SID, state: { t: 0.25 } });
    expect(live.seen[0]).toEqual({ method: 'POST', url: '/live', body: { mechanism_id: 'm-20261028-120000-ab12' } });
  });

  it('passes actions on, and the session\'s refusals with their status', async () => {
    const push = { action: 'push', body: 'box', force: [0, 0, 5], duration: 0.1 };
    const res = await app.inject({ method: 'POST', url: `/api/sim/live/${SID}/actions`, payload: push });
    expect(res.json()).toMatchObject({ success: true, t: 0.25 });
    expect(live.seen[0].body).toEqual(push);
    const refused = await app.inject({ method: 'POST', url: `/api/sim/live/${SID}/actions`, payload: { action: 'drag', body: 'ground' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ success: false, error: 'BODY_FIXED' });
  });

  it('streams the state as Server-Sent Events, unbuffered', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sim/live/${SID}/stream?hz=20` });
    expect(res.statusCode).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-transform');
    const events = res.body.split('\n\n').filter((e) => e.startsWith('data: '));
    expect(events.map((e) => JSON.parse(e.slice(6)).t)).toEqual([0.25, 0.3]);
    expect(res.body).toContain('event: end');
  });

  it('serves a body\'s mesh', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sim/live/${SID}/mesh/box` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('solid box');
  });

  it('refuses ids it does not know before asking the session server', async () => {
    for (const url of ['/api/sim/live/nope', '/api/sim/live/nope/state', `/api/sim/live/${SID}/mesh/..%2Fx`]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: '/api/sim/live/s-1/actions', payload: { action: 'pause' } })).statusCode).toBe(404);
    expect(live.seen).toHaveLength(0);
  });

  it('says when the container is not set up or not running', async () => {
    setSimLiveUrl(null);
    const saved = env.SIM_LIVE_URL;
    env.SIM_LIVE_URL = undefined;
    try {
      expect((await app.inject({ method: 'GET', url: '/api/sim/live' })).json().error).toBe('SIM_LIVE_DISABLED');
      env.SIM_LIVE_URL = 'http://127.0.0.1:9';
      const res = await app.inject({ method: 'GET', url: '/api/sim/live' });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('SIM_LIVE_UNREACHABLE');
    } finally {
      env.SIM_LIVE_URL = saved;
    }
  });
});
