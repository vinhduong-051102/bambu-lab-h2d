import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import type { PrinterFileEntry, PrinterFileStorage } from '../src/bambu/BambuFtpClient';
import { PrintJournal } from '../src/domain/prints/PrintJournal';
import { matchPrint, nameTime, parseListingTime, TimelapseLibrary } from '../src/domain/timelapse/TimelapseLibrary';
import { setTimelapseStores } from '../src/api/routes/timelapse';
import { createTestApp, type TestApp } from './helpers/testApp';

const VIDEO = Buffer.from('0123456789abcdefghij'); // 20 bytes standing in for an mp4
const NOW = new Date('2026-10-25T08:00:00.000Z');

class PrinterTimelapses implements PrinterFileStorage {
  downloads: string[] = [];
  lists = 0;
  files: Record<string, PrinterFileEntry[]> = {
    '/timelapse': [
      { name: 'thumbnail', path: '/timelapse/thumbnail', size: 0, isDirectory: true, modifiedAt: 'Oct 12 20:21' },
      { name: 'video_2026-10-12_00-32-49.mp4', path: '', size: VIDEO.length, isDirectory: false, modifiedAt: 'Oct 11 16:51' },
      { name: 'video_2026-10-13_02-33-28.mp4', path: '', size: VIDEO.length, isDirectory: false, modifiedAt: 'Oct 12 20:21' },
      { name: 'notes.txt', path: '', size: 3, isDirectory: false, modifiedAt: 'Oct 12 20:21' },
    ],
    '/timelapse/thumbnail': [{ name: 'video_2026-10-13_02-33-28.jpg', path: '', size: 4, isDirectory: false, modifiedAt: 'Oct 12 20:21' }],
  };

  async list(dir = '/') {
    this.lists++;
    return this.files[dir] ?? [];
  }
  async upload() {
    throw new Error('not used');
  }
  async download(remotePath: string, localPath: string) {
    this.downloads.push(remotePath);
    await fs.writeFile(localPath, remotePath.endsWith('.jpg') ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : VIDEO);
  }
  async remove() {
    throw new Error('not used');
  }
}

describe('timelapse listing', () => {
  it('reads the printer listing dates as UTC, with or without a year', () => {
    expect(parseListingTime('Oct 11 16:51', NOW)).toBe('2026-10-11T16:51:00.000Z');
    expect(parseListingTime('Dec 30 10:00', new Date('2027-01-02T00:00:00Z'))).toBe('2026-12-30T10:00:00.000Z');
    expect(parseListingTime('Oct 11  2025', NOW)).toBe('2025-10-11T00:00:00.000Z');
    expect(parseListingTime('2026-10-11T16:51:00.000Z', NOW)).toBe('2026-10-11T16:51:00.000Z');
    expect(parseListingTime('yesterday', NOW)).toBeNull();
    expect(nameTime('video_2026-10-12_00-32-49.mp4')).toBe('2026-10-12 00:32:49');
  });

  it('pairs a video with the print that ended closest to it', () => {
    const video = { name: 'v.mp4', size: 1, ended_at: '2026-10-11T16:51:00.000Z', name_time: null, has_thumbnail: false };
    const prints = [
      { id: 'a', ended_at: '2026-10-11T16:40:00.000Z' },
      { id: 'b', ended_at: '2026-10-11T16:50:10.000Z' },
      { id: 'c', ended_at: null },
    ];
    expect(matchPrint(video, prints)?.id).toBe('b');
    expect(matchPrint(video, [{ id: 'far', ended_at: '2026-10-11T12:00:00.000Z' }])).toBeNull();
  });

  it('pairs a video named on a print whatever the times, and keeps that print for it', () => {
    const video = { name: 'v.mp4', size: 1, ended_at: '2026-10-11T16:51:00.000Z', name_time: null, has_thumbnail: false };
    // The printer's clock was days behind
    const named = { id: 'named', ended_at: '2026-10-21T23:00:00.000Z', timelapse: 'v.mp4' };
    expect(matchPrint(video, [{ id: 'near', ended_at: '2026-10-11T16:50:10.000Z' }, named])?.id).toBe('named');
    const other = { ...video, name: 'other.mp4' };
    expect(matchPrint(other, [{ id: 'near', ended_at: '2026-10-11T16:50:10.000Z', timelapse: 'v.mp4' }])).toBeNull();
  });

  it('lists videos newest first, caches the listing and the downloads', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timelapse-'));
    try {
      const printer = new PrinterTimelapses();
      const library = new TimelapseLibrary(() => printer, dir, () => NOW);
      const videos = await library.list();
      expect(videos.map((v) => [v.name, v.has_thumbnail])).toEqual([
        ['video_2026-10-13_02-33-28.mp4', true],
        ['video_2026-10-12_00-32-49.mp4', false],
      ]);
      await library.list();
      expect(printer.lists).toBe(2); // the folder and its thumbnails, once

      const [a, b] = await Promise.all([library.video('video_2026-10-13_02-33-28.mp4'), library.video('video_2026-10-13_02-33-28.mp4')]);
      expect(a).toBe(b);
      await library.video('video_2026-10-13_02-33-28.mp4');
      expect(printer.downloads).toEqual(['/timelapse/video_2026-10-13_02-33-28.mp4']);
      expect(await library.thumbnail('video_2026-10-12_00-32-49.mp4')).toBeNull();
      expect(await library.video('../record.json')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Timelapse API', () => {
  let app: TestApp;
  let stateStore: PrinterStateStore;
  let cacheDir: string;
  let printDir: string;
  let journal: PrintJournal;

  beforeEach(() => {
    cacheDir = mkdtempSync(path.join(os.tmpdir(), 'timelapse-'));
    printDir = mkdtempSync(path.join(os.tmpdir(), 'prints-'));
    journal = new PrintJournal(printDir);
    setTimelapseStores(new TimelapseLibrary(() => new PrinterTimelapses(), cacheDir, () => NOW), journal);
    stateStore = new PrinterStateStore('TEST_SERIAL_TIMELAPSE');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_TIMELAPSE', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);
  });

  afterEach(() => {
    setTimelapseStores(null);
    stateStore.destroy();
    app.close();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(printDir, { recursive: true, force: true });
  });

  it('lists videos with the print each one shows', async () => {
    const print = await journal.create('Plate02', new Date('2026-10-12T18:30:00Z'), null);
    await journal.update(print.id, (r) => {
      r.status = 'finished';
      r.ended_at = '2026-10-12T20:20:30.000Z';
    });
    const body = (await app.inject({ method: 'GET', url: '/api/timelapse' })).json();
    expect(body.videos[0]).toMatchObject({ name: 'video_2026-10-13_02-33-28.mp4', print: { id: print.id, job_name: 'Plate02' } });
    expect(body.videos[1].print).toBeNull();
  });

  it('serves the video whole and by byte range, and the thumbnail', async () => {
    const whole = await app.inject({ method: 'GET', url: '/api/timelapse/video_2026-10-13_02-33-28.mp4' });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(whole.rawBody)).toEqual(VIDEO);

    const part = await app.inject({ method: 'GET', url: '/api/timelapse/video_2026-10-13_02-33-28.mp4', headers: { range: 'bytes=5-9' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 5-9/20');
    expect(Buffer.from(part.rawBody).toString()).toBe('56789');

    const outside = await app.inject({ method: 'GET', url: '/api/timelapse/video_2026-10-13_02-33-28.mp4', headers: { range: 'bytes=50-' } });
    expect(outside.statusCode).toBe(416);

    const thumb = await app.inject({ method: 'GET', url: '/api/timelapse/video_2026-10-13_02-33-28.mp4/thumbnail' });
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');
  });

  it('answers 404 for videos the printer does not have', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/timelapse/video_2099-01-01_00-00-00.mp4' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/timelapse/notes.txt' })).statusCode).toBe(404);
  });
});
