import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { mechPath, setMechWorkerUrl } from '../src/api/routes/mech';
import { setSimLiveUrl } from '../src/api/routes/simLive';
import { clearTasks } from '../src/domain/backgroundTasks';
import { CAN_SIMULATE, partMotion, rotate } from '../src/ui/modelSim';
import { createTestApp, type TestApp } from './helpers/testApp';

const DESIGN = 'd-20261029-010203-ab12';
const BAD = 'd-20261029-010203-dead';
const SESSION = 'l-20261029-010203-5e55';

type Seen = { method: string; url: string; body: unknown }[];

function server(route: (req: IncomingMessage, body: unknown, reply: (status: number, body: unknown) => void) => void | Promise<void>) {
  const seen: Seen = [];
  const s: Server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    seen.push({ method: req.method ?? '', url: req.url ?? '', body });
    await route(req, body, (status, out) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
    });
  });
  return { server: s, seen };
}

// The slow model's setup answers when the test lets it
let releaseSetup: () => void = () => {};

/** Stands in for mesh3d/worker.py's /mech routes */
function fakeWorker() {
  const setupDone = new Promise<void>((resolve) => (releaseSetup = resolve));
  return server(async (req, body, reply) => {
    if (req.url === '/mech/models/setup' && (body as { job_id?: string })?.job_id === 'slow-01') {
      await setupDone;
      return reply(200, { ok: true, model_id: 'job-slow-01', design_id: DESIGN, revision: 1, state: 'READY' });
    }
    if (req.url === '/mech/models/job-slow-01') return reply(200, { ok: true, model_id: 'job-slow-01', design_id: null, state: 'NOT_CONFIGURED' });
    if (req.url === '/mech/designs' && req.method === 'POST') return reply(200, { ok: true, design_id: DESIGN, revision: 1, status: 'warning' });
    if (req.url === `/mech/designs/${DESIGN}/simulate`) {
      return reply(422, { ok: false, error: 'NOT_VALID', message: 'Mô hình chưa chạy được', details: { diagnostics: [{ code: 'MOTOR_ON_LOCKED_PAIR', joints: ['weld'] }] } });
    }
    if (req.url === `/mech/designs/${DESIGN}?revision=2`) return reply(200, { ok: true, design_id: DESIGN, revision: 2 });
    if (req.url === '/mech/models/job-crank-001') return reply(200, { ok: true, model_id: 'job-crank-001', design_id: DESIGN, revision: 3, state: 'READY' });
    if (req.url === '/mech/models/job-broken-01') return reply(200, { ok: true, model_id: 'job-broken-01', design_id: BAD, revision: 1, state: 'INVALID' });
    if (req.url === `/mech/designs/${DESIGN}/viewer?revision=3`) {
      return reply(200, { ok: true, design_id: DESIGN, revision: 3, mechanism: { schema_version: 1, bodies: [] }, origin: { design_id: DESIGN, revision: '3' }, parts: { crank: { body: 'crank' } }, joints: [] });
    }
    if (req.url === `/mech/designs/${BAD}/viewer`) {
      return reply(422, { ok: false, error: 'NOT_VALID', message: 'Mô hình chưa chạy được', details: { diagnostics: [{ code: 'MOTOR_ON_LOCKED_PAIR', parts: ['base', 'crank'], joints: ['weld'] }] } });
    }
    reply(404, { ok: false, error: 'NOT_FOUND', message: 'Không có.' });
  });
}

/** Stands in for the sim-live container: one session of revision 2 of the design, still open */
function fakeLive() {
  return server((req, _body, reply) => {
    if (req.url === '/live' && req.method === 'GET') {
      return reply(200, { ok: true, sessions: [{ session_id: 'l-20261029-000000-0ld0', source: { design_id: DESIGN, revision: '2' }, t: 4, running: true }] });
    }
    if (req.url === '/live' && req.method === 'POST') return reply(201, { ok: true, session_id: SESSION, scene: { bodies: [] }, state: { t: 0, running: false } });
    if (req.url?.endsWith('/stop')) return reply(200, { ok: true });
    reply(404, { ok: false, message: 'Không có.' });
  });
}

describe('Mechanical model (/api/mech)', () => {
  let app: TestApp;
  let worker: ReturnType<typeof fakeWorker>;
  let live: ReturnType<typeof fakeLive>;

  beforeEach(async () => {
    clearTasks();
    const stateStore = new PrinterStateStore('TEST_SERIAL_MECH');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_MECH', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);
    worker = fakeWorker();
    live = fakeLive();
    await new Promise<void>((resolve) => worker.server.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => live.server.listen(0, '127.0.0.1', resolve));
    setMechWorkerUrl(`http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`);
    setSimLiveUrl(`http://127.0.0.1:${(live.server.address() as AddressInfo).port}`);
  });

  afterEach(async () => {
    releaseSetup();
    setMechWorkerUrl(null);
    setSimLiveUrl(null);
    await new Promise<void>((resolve) => worker.server.close(() => resolve()));
    await new Promise<void>((resolve) => live.server.close(() => resolve()));
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
    expect(mechPath('GET', ['models', 'job-crank-001'])).toBe('models/job-crank-001');
    expect(mechPath('GET', ['models', '../etc'])).toBeNull();
    expect(mechPath('POST', ['models', 'setup'])).toBe('models/setup');
    expect(mechPath('POST', ['models', 'job-crank-001'])).toBeNull();
  });

  it('keeps setting a model up when its page goes, and shows it to the page opened again', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/mech/models/setup', payload: { job_id: 'slow-01' } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ success: true, running: true, model_id: 'job-slow-01' });
    const reading = await app.inject({ method: 'GET', url: '/api/mech/models/job-slow-01' });
    expect(reading.json()).toMatchObject({ state: 'NOT_CONFIGURED', setup_task: { running: true } });
    releaseSetup();
    await expect.poll(async () => (await app.inject({ method: 'GET', url: '/api/mech/models/job-slow-01' })).json().setup_task.running).toBe(false);
    expect(worker.seen.filter((r) => r.url === '/mech/models/setup')).toHaveLength(1);
  });

  it("a model's state: a session of an older revision does not make the new one RUNNING", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/mech/models/job-crank-001' });
    expect(res.json()).toMatchObject({ success: true, state: 'READY', live: null, live_stale: [{ revision: 2 }] });
  });

  it('opens the current revision in the viewer, replacing the earlier session', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/mech/designs/${DESIGN}/live`, payload: { revision: 3 } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ success: true, session_id: SESSION, revision: 3, parts: { crank: { body: 'crank' } } });
    expect(live.seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /live', 'POST /live/l-20261029-000000-0ld0/stop', 'POST /live']);
    // The mechanism the worker compiled, with where it came from, so the session is found by its revision
    expect(live.seen[2].body).toMatchObject({ mechanism: { schema_version: 1 }, origin: { design_id: DESIGN, revision: '3' }, paused: false });
    expect(res.json()).not.toHaveProperty('mechanism');
  });

  it('refuses to open an invalid model, naming what is at fault, and starts nothing', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/mech/designs/${BAD}/live`, payload: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ success: false, error: 'NOT_VALID', details: { diagnostics: [{ parts: ['base', 'crank'], joints: ['weld'] }] } });
    expect(live.seen).toEqual([]);
  });
});

describe('A component moving with its body (modelSim.js)', () => {
  /** A turn about Z as a Chrono quaternion */
  const aboutZ = (deg: number) => [Math.cos((deg * Math.PI) / 360), 0, 0, Math.sin((deg * Math.PI) / 360)];

  it('rotates by Chrono quaternions (w first)', () => {
    const quarter = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]; // 90° about Z
    rotate(quarter, [1, 0, 0]).forEach((v, i) => expect(v).toBeCloseTo([0, 1, 0][i], 12));
  });

  it("a crank's pin: where it is after a quarter turn and how fast it goes", () => {
    // Body frame at the world origin (a mech group); the pin 30 mm out on X; turning at 2π rad/s about Z
    const initial = { p: [0, 0, 0], q: [1, 0, 0, 0] };
    const pose = { p: [0, 0, 0], q: aboutZ(90) };
    const m = partMotion([30, 0, 0], initial, pose, [0, 0, 0], [0, 0, 2 * Math.PI]);
    m.position_mm.forEach((v: number, i: number) => expect(v).toBeCloseTo([0, 30, 0][i], 9));
    expect(m.displacement_mm).toBeCloseTo(30 * Math.SQRT2, 9);
    expect(m.speed_mm_s).toBeCloseTo(2 * Math.PI * 30, 9);
    expect(m.rpm).toBeCloseTo(60, 9);
  });

  it('a shaft turning in place: its centre does not move; no speed without the solver saying', () => {
    const m = partMotion([0, 0, 7.5], { p: [0, 0, 0], q: [1, 0, 0, 0] }, { p: [0, 0, 0], q: aboutZ(137) }, null, null);
    expect(m.displacement_mm).toBeCloseTo(0, 9);
    expect(m.speed_mm_s).toBeNull();
    expect(CAN_SIMULATE.has('INVALID')).toBe(false);
    expect(CAN_SIMULATE.has('NEEDS_VALIDATION')).toBe(false);
  });
});
