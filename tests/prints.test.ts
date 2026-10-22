import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import type { PrinterStateStatus } from '../src/domain/PrinterState';
import { PrintJournal, type PrintSetup } from '../src/domain/prints/PrintJournal';
import { PrintRecorder } from '../src/domain/prints/PrintRecorder';
import { AiSessionStore } from '../src/domain/studio/aiSessions';
import { setPrintStores } from '../src/api/routes/prints';
import { createTestApp, type TestApp } from './helpers/testApp';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);

const setupBody = {
  version: 1 as const,
  job_name: 'Plate01_Bracket',
  printer_preset: 'Bambu Lab H2D 0.4 nozzle',
  process_preset: '0.20mm Standard @BBL H2D',
  nozzle_diameters: [0.4, 0.4],
  filaments: [{ preset: 'Bambu PETG HF @BBL H2D', type: 'PETG' }],
  settings: { layer_height: '0.2', enable_support: '1' },
  objects: [
    { name: 'Bracket.stl', instances: 1, size_mm: [40, 20, 60] as [number, number, number], volume_mm3: 9000, surface_area_mm2: 6000, base_area_mm2: 300, overhang_area_mm2: 120, triangles: 900 },
  ],
  ai_session_id: null,
};

function setState(store: PrinterStateStore, status: PrinterStateStatus, jobName: string | null) {
  const state = store.getState();
  store.updateState({ ...state, state: status, job: { ...state.job, name: jobName } });
}

describe('PrintJournal', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(path.join(os.tmpdir(), 'prints-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('hands a pending setup to the print with the same job name, once', async () => {
    const journal = new PrintJournal(dir);
    const setup: PrintSetup = { ...setupBody, received_at: new Date().toISOString() };
    await journal.savePendingSetup(setup);
    expect(await journal.takePendingSetup('  plate01_bracket.gcode.3mf ')).toMatchObject({ job_name: 'Plate01_Bracket' });
    expect(await journal.takePendingSetup('Plate01_Bracket')).toBeNull();
  });

  it('drops a setup older than a day', async () => {
    const journal = new PrintJournal(dir);
    await journal.savePendingSetup({ ...setupBody, received_at: '2026-01-01T00:00:00.000Z' });
    expect(await journal.takePendingSetup('Plate01_Bracket', new Date('2026-01-03T00:00:00.000Z'))).toBeNull();
  });

  it('refuses ids and photo names that could leave its folder', async () => {
    const journal = new PrintJournal(dir);
    expect(await journal.get('../etc')).toBeNull();
    expect(journal.photoPath('20261022-100000-abcdef', '../record.json')).toBeNull();
  });
});

describe('PrintRecorder', () => {
  let dir: string;
  let store: PrinterStateStore;
  let journal: PrintJournal;
  let frame: Buffer | null;
  let recorder: PrintRecorder;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'prints-'));
    store = new PrinterStateStore('TEST_SERIAL_PRINTS');
    journal = new PrintJournal(dir);
    frame = JPEG;
    recorder = new PrintRecorder(journal, store, { getLatestFrame: () => frame }, { photoDelayMs: 0 });
    recorder.start();
  });

  afterEach(() => {
    recorder.stop();
    store.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a print from start to finish with Studio settings and a camera photo', async () => {
    await journal.savePendingSetup({ ...setupBody, received_at: new Date().toISOString() });
    setState(store, 'IDLE', null);
    setState(store, 'RUNNING', 'Plate01_Bracket');
    setState(store, 'RUNNING', 'Plate01_Bracket');
    setState(store, 'FINISHED', 'Plate01_Bracket');
    await recorder.idle();

    const [print] = await journal.list(10);
    expect(print).toMatchObject({ job_name: 'Plate01_Bracket', status: 'finished', setup: { process_preset: '0.20mm Standard @BBL H2D' } });
    expect(print.started_at).not.toBeNull();
    expect(print.ended_at).not.toBeNull();
    expect(print.photos).toEqual([expect.objectContaining({ source: 'camera', name: expect.stringMatching(/^camera-.*\.jpg$/) })]);
    expect(existsSync(journal.photoPath(print.id, print.photos[0].name)!)).toBe(true);
  });

  it('marks a failed print, and still records one without settings or camera frame', async () => {
    frame = null;
    setState(store, 'IDLE', null);
    setState(store, 'RUNNING', 'Unknown job');
    setState(store, 'FAILED', 'Unknown job');
    await recorder.idle();
    const [print] = await journal.list(10);
    expect(print).toMatchObject({ status: 'failed', setup: null, photos: [] });
  });

  it('picks up a print already running when the gateway starts, without a start time', async () => {
    setState(store, 'RUNNING', 'Plate01_Bracket');
    await recorder.idle();
    const [print] = await journal.list(10);
    expect(print).toMatchObject({ status: 'printing', started_at: null });
  });

  it('keeps filling the open record after a restart instead of opening another', async () => {
    setState(store, 'IDLE', null);
    setState(store, 'RUNNING', 'Plate01_Bracket');
    await recorder.idle();
    recorder.stop();

    const restarted = new PrintRecorder(journal, store, { getLatestFrame: () => frame }, { photoDelayMs: 0 });
    restarted.start();
    setState(store, 'RUNNING', 'Plate01_Bracket');
    setState(store, 'FINISHED', 'Plate01_Bracket');
    await restarted.idle();
    restarted.stop();

    const prints = await journal.list(10);
    expect(prints).toHaveLength(1);
    expect(prints[0].status).toBe('finished');
  });
});

describe('Print history API', () => {
  let app: TestApp;
  let stateStore: PrinterStateStore;
  let printDir: string;
  let sessionDir: string;
  let journal: PrintJournal;
  let sessions: AiSessionStore;

  beforeEach(() => {
    printDir = mkdtempSync(path.join(os.tmpdir(), 'prints-'));
    sessionDir = mkdtempSync(path.join(os.tmpdir(), 'ai-sessions-'));
    journal = new PrintJournal(printDir);
    sessions = new AiSessionStore(sessionDir);
    setPrintStores(journal, sessions);
    stateStore = new PrinterStateStore('TEST_SERIAL_PRINT_API');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_PRINT_API', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);
  });

  afterEach(() => {
    setPrintStores(null);
    stateStore.destroy();
    app.close();
    rmSync(printDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('keeps the setup Studio sends until the print starts', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/prints/setup', payload: setupBody });
    expect(res.statusCode).toBe(200);
    expect(await journal.takePendingSetup('Plate01_Bracket')).toMatchObject({ settings: { enable_support: '1' } });

    const bad = await app.inject({ method: 'POST', url: '/api/prints/setup', payload: { ...setupBody, job_name: '' } });
    expect(bad.statusCode).toBe(400);
  });

  it('lists prints with the report choices and setting labels', async () => {
    await journal.create('Plate01_Bracket', new Date(), null);
    const body = (await app.inject({ method: 'GET', url: '/api/prints' })).json();
    expect(body.prints).toEqual([expect.objectContaining({ job_name: 'Plate01_Bracket', status: 'printing', photos: [] })]);
    expect(body.outcomes.map((o: { id: string }) => o.id)).toEqual(['success', 'usable', 'failed']);
    expect(body.setting_labels.enable_support).toBe('Bật support');
  });

  it('saves a report on the print and copies it to its AI proposal', async () => {
    const session = await sessions.create(
      { version: 1, goal: 'balanced', printer_preset: 'p', process_preset: 'q', nozzle_diameters: [0.4], filaments: [], settings: {}, objects: [] },
      { summary: '', changes: [], rejected: [] },
      null
    );
    const print = await journal.create('Plate01_Bracket', new Date(), { ...setupBody, ai_session_id: session.id, received_at: new Date().toISOString() });

    const res = await app.inject({
      method: 'POST',
      url: `/api/prints/${print.id}/feedback`,
      payload: { outcome: 'usable', issues: ['stringing'], note: 'Hơi kéo sợi' },
    });
    expect(res.statusCode).toBe(200);
    expect((await journal.get(print.id))?.feedback).toMatchObject({ outcome: 'usable', issues: ['stringing'] });
    expect((await sessions.get(session.id))?.feedback).toMatchObject({ outcome: 'usable', note: 'Hơi kéo sợi' });
  });

  it('uploads, serves and deletes photos', async () => {
    const print = await journal.create('Plate01_Bracket', new Date(), null);
    const form = new FormData();
    form.append('file', new File([JPEG], 'photo.jpg', { type: 'image/jpeg' }));
    const upload = await app.inject({ method: 'POST', url: `/api/prints/${print.id}/photos`, form });
    expect(upload.statusCode).toBe(201);
    const { photo } = upload.json();
    expect(photo).toMatchObject({ source: 'upload', name: expect.stringMatching(/^upload-.*\.jpg$/) });

    const image = await app.inject({ method: 'GET', url: `/api/prints/${print.id}/photos/${photo.name}` });
    expect(image.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(image.rawBody)).toEqual(JPEG);

    const del = await app.inject({ method: 'DELETE', url: `/api/prints/${print.id}/photos/${photo.name}` });
    expect(del.statusCode).toBe(200);
    expect((await journal.get(print.id))?.photos).toEqual([]);
  });

  it('refuses other file types and unknown prints', async () => {
    const print = await journal.create('Plate01_Bracket', new Date(), null);
    const form = new FormData();
    form.append('file', new File(['x'], 'notes.txt', { type: 'text/plain' }));
    const upload = await app.inject({ method: 'POST', url: `/api/prints/${print.id}/photos`, form });
    expect(upload.statusCode).toBe(415);
    const missing = await app.inject({ method: 'GET', url: '/api/prints/20990101-000000-abcdef' });
    expect(missing.statusCode).toBe(404);
  });
});
