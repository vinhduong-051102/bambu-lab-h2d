import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import type { PrinterFileStorage } from '../src/bambu/BambuFtpClient';
import { setPrinterStorageFactory } from '../src/bambu/printerStorage';
import { env } from '../src/config/env';
import { writeStl } from '../src/domain/studio/meshRepair';
import { createTestApp, type TestApp } from './helpers/testApp';

class MockStorage implements PrinterFileStorage {
  removed: string[] = [];
  files = [
    { name: 'Bracket.gcode.3mf', path: '/Bracket.gcode.3mf', size: 1234, isDirectory: false, modifiedAt: '2026-10-01T10:00:00.000Z' },
    { name: 'timelapse', path: '/timelapse', size: 0, isDirectory: true, modifiedAt: null },
  ];

  async list(dir = '/') {
    if (dir === '/cache') throw new Error('550 No such directory');
    return this.files;
  }
  async upload() {
    throw new Error('not used');
  }
  async download() {
    throw new Error('not used');
  }
  async remove(remotePath: string) {
    this.removed.push(remotePath);
  }
}

describe('Studio & printer files API', () => {
  let app: TestApp;
  let stateStore: PrinterStateStore;
  let storage: MockStorage;

  beforeEach(() => {
    stateStore = new PrinterStateStore('TEST_SERIAL_STUDIO');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({
      serial: 'TEST_SERIAL_STUDIO',
      stateStore,
      capabilityRegistry,
      commandService,
      mqttClient: mqtt as any,
    });
    storage = new MockStorage();
    setPrinterStorageFactory(() => storage);
    app = createTestApp(printerService);
  });

  afterEach(() => {
    setPrinterStorageFactory(null);
    stateStore.destroy();
    app.close();
  });

  it('lists and deletes printer files over FTPS', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/files' });
    expect(list.statusCode).toBe(200);
    expect(list.json().files).toEqual([expect.objectContaining({ path: '/Bracket.gcode.3mf', printable: true })]);

    const del = await app.inject({ method: 'DELETE', url: `/api/files/${encodeURIComponent('/Bracket.gcode.3mf')}` });
    expect(del.statusCode).toBe(200);
    expect(storage.removed).toEqual(['/Bracket.gcode.3mf']);
  });

  it('no longer serves the removed LAN print endpoints', async () => {
    for (const url of ['/api/print/prepare', '/api/print/start', '/api/print/jobs', '/api/studio/prepare']) {
      const res = await app.inject({ method: url.endsWith('jobs') ? 'GET' : 'POST', url });
      expect(res.statusCode, url).toBe(404);
    }
  });

  describe('embedded Bambu Studio', () => {
    let importDir: string;

    const send = (name: string, content: string | Uint8Array = 'solid c\nendsolid c\n') => {
      const form = new FormData();
      form.append('file', new File([typeof content === 'string' ? content : new Uint8Array(content)], name));
      return app.inject({ method: 'POST', url: '/api/studio/import', form });
    };

    beforeEach(async () => {
      importDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-imports-'));
      env.STUDIO_URL = 'https://192.168.1.10:3101/';
      env.STUDIO_IMPORT_DIR = importDir;
    });

    afterEach(async () => {
      env.STUDIO_URL = undefined;
      env.STUDIO_IMPORT_DIR = undefined;
      await fs.rm(importDir, { recursive: true, force: true });
    });

    it('reports the stream URL and whether files can be sent in', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/studio' });
      expect(res.json()).toEqual({ enabled: true, url: 'https://192.168.1.10:3101/', importsEnabled: true });
    });

    it('points a Studio on this machine at the host the dashboard was opened with', async () => {
      env.STUDIO_URL = 'https://localhost:3101/';
      const viaTailscale = await app.inject({ method: 'GET', url: 'http://100.64.0.5:3000/api/studio' });
      expect(viaTailscale.json().url).toBe('https://100.64.0.5:3101/');
      const local = await app.inject({ method: 'GET', url: 'http://localhost:3000/api/studio' });
      expect(local.json().url).toBe('https://localhost:3101/');
    });

    it('prefers a STUDIO_ALT_URLS entry on the host the dashboard was opened with', async () => {
      env.STUDIO_URL = 'https://localhost:3101/';
      env.STUDIO_ALT_URLS = ['https://pc.example.ts.net:8443/'];
      try {
        const viaServe = await app.inject({ method: 'GET', url: 'https://pc.example.ts.net/api/studio' });
        expect(viaServe.json().url).toBe('https://pc.example.ts.net:8443/');
        const viaIp = await app.inject({ method: 'GET', url: 'http://100.64.0.5:3000/api/studio' });
        expect(viaIp.json().url).toBe('https://100.64.0.5:3101/');
      } finally {
        env.STUDIO_ALT_URLS = [];
      }
    });

    it('keeps a Studio on another machine as configured', async () => {
      const res = await app.inject({ method: 'GET', url: 'http://100.64.0.5:3000/api/studio' });
      expect(res.json().url).toBe('https://192.168.1.10:3101/');
    });

    it('stores the model where Studio sees it as /imports, never overwriting', async () => {
      const first = await send('Bracket.stl', 'one');
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ success: true, name: 'Bracket.stl', studioPath: '/imports/Bracket.stl' });

      expect((await send('Bracket.stl', 'two')).json().name).toBe('Bracket (2).stl');
      expect((await send('Plate.gcode.3mf', 'x')).statusCode).toBe(201);
      expect((await send('Plate.gcode.3mf', 'y')).json().name).toBe('Plate (2).gcode.3mf');

      expect(await fs.readFile(path.join(importDir, 'Bracket.stl'), 'utf8')).toBe('one');
      expect(await fs.readFile(path.join(importDir, 'Bracket (2).stl'), 'utf8')).toBe('two');
      expect((await fs.readdir(importDir)).filter((f) => f.endsWith('.part'))).toEqual([]);
    });

    it('repairs an STL mesh on import and keeps the file as sent', async () => {
      // Unit cube missing its last face
      const points = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].flat();
      const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4]].flat();
      const broken = writeStl(points, faces);

      const res = await send('Cube.stl', broken);
      expect(res.statusCode).toBe(201);
      expect(res.json().repair).toMatchObject({ changed: true, holes_filled: 1, watertight: true, summary: 'đã vá 1 lỗ' });
      expect((await fs.readFile(path.join(importDir, 'Cube.stl'))).readUInt32LE(80)).toBe(12);
      expect(await fs.readFile(path.join(importDir, '.originals', 'Cube.stl'))).toEqual(broken);

      // Not a mesh: imported as it is, with the reason
      const text = await send('Notes.stl', 'not a mesh');
      expect(text.json().repair.skipped).toMatch(/STL/);
      expect(await fs.readFile(path.join(importDir, 'Notes.stl'), 'utf8')).toBe('not a mesh');
      // Other formats aren't touched
      expect((await send('Part.3mf', 'x')).json().repair).toBeUndefined();
    });

    it('strips directories from the browser-supplied name and rejects other types', async () => {
      const res = await send('../../evil.stl');
      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe('evil.stl');
      expect(await fs.readdir(importDir)).toEqual(['evil.stl']);

      expect((await send('notes.txt')).statusCode).toBe(415);
    });

    it('is off without STUDIO_IMPORT_DIR / STUDIO_URL', async () => {
      env.STUDIO_IMPORT_DIR = undefined;
      env.STUDIO_URL = undefined;
      expect((await send('a.stl')).statusCode).toBe(501);
      expect((await app.inject({ method: 'GET', url: '/api/studio' })).json()).toEqual({
        enabled: false,
        url: null,
        importsEnabled: false,
      });
    });
  });
});
