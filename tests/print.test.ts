import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { normalizePrinterState } from '../src/domain/normalizePrinterState';
import { PrintJobManager, toRemoteName } from '../src/domain/print/PrintJobManager';
import { buildAmsMappingPayload, listAvailableTrays, suggestMapping } from '../src/domain/print/amsMapping';
import { parseThreeMf } from '../src/bambu/ThreeMfParser';
import type { PrinterFileStorage } from '../src/bambu/BambuFtpClient';
import { env } from '../src/config/env';
import { createTestApp, type TestApp } from './helpers/testApp';

const PLATE_GCODE = [
  '; HEADER_BLOCK_START',
  '; BambuStudio 02.02.00.85',
  '; HEADER_BLOCK_END',
  '; CONFIG_BLOCK_START',
  '; filament_colour = #FFFFFF;#000000;#FF0000;#00AEFF',
  '; CONFIG_BLOCK_END',
  'G28',
].join('\n');

/** A 4-filament H2D project whose plate 1 uses filaments 1 (PLA white, left) and 3 (PLA red, right) */
function buildSliced3mf(options: { sliced?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const sliced = options.sliced ?? true;
  const files: Record<string, Uint8Array> = {
    '3D/3dmodel.model': strToU8('<model/>'),
    'Metadata/project_settings.config': strToU8(
      JSON.stringify({
        printer_model: 'Bambu Lab H2D',
        filament_colour: ['#FFFFFF', '#000000', '#FF0000', '#00AEFF'],
        filament_type: ['PLA', 'PETG', 'PLA', 'PLA'],
      })
    ),
    'Metadata/model_settings.config': strToU8(
      '<config><plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Bracket"/></plate></config>'
    ),
  };
  if (sliced) {
    files['Metadata/plate_1.gcode'] = strToU8(PLATE_GCODE);
    files['Metadata/plate_1.gcode.md5'] = strToU8('0123456789abcdef0123456789abcdef');
    files['Metadata/plate_1.png'] = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    files['Metadata/slice_info.config'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="02.02.00.85"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value="O1D"/>
    <metadata key="nozzle_diameters" value="0.4,0.4"/>
    <metadata key="prediction" value="3720"/>
    <metadata key="weight" value="42.50"/>
    <metadata key="filament_maps" value="1 1 2 2"/>
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#FFFFFF" used_m="5.10" used_g="15.20" />
    <filament id="3" tray_info_idx="GFA00" type="PLA" color="#FF0000" used_m="9.00" used_g="27.30" />
  </plate>
</config>`);
  }
  return new Uint8Array(zipSync(files));
}

const amsReport = {
  print: {
    gcode_state: 'IDLE',
    fun: '3EC18FFF9CFF', // developer mode enabled (bit 0x20000000 clear)
    ams: {
      ams_exist_bits: '1',
      tray_exist_bits: '7',
      ams: [
        {
          id: '0',
          temp: '30',
          humidity: '2',
          tray: [
            { id: '0', tray_type: 'PLA', tray_color: 'FFFFFFFF', remain: 90, state: 11 },
            { id: '1', tray_type: 'PETG', tray_color: '000000FF', remain: 70, state: 11 },
            { id: '2', tray_type: 'PLA', tray_color: 'EE1111FF', remain: 60, state: 11 },
            { id: '3', state: 0 },
          ],
        },
      ],
    },
  },
};

class MockStorage implements PrinterFileStorage {
  uploads: { localPath: string; remotePath: string; size: number }[] = [];
  removed: string[] = [];
  failUpload: Error | null = null;
  files = [
    { name: 'Bracket.gcode.3mf', path: '/Bracket.gcode.3mf', size: 1234, isDirectory: false, modifiedAt: '2026-10-01T10:00:00.000Z' },
    { name: 'timelapse', path: '/timelapse', size: 0, isDirectory: true, modifiedAt: null },
  ];
  remoteContent = buildSliced3mf();

  async list(dir = '/') {
    if (dir === '/cache') throw new Error('550 No such directory');
    return this.files;
  }
  async upload(localPath: string, remotePath: string, onProgress?: (bytes: number) => void) {
    if (this.failUpload) throw this.failUpload;
    const { size } = await fs.stat(localPath);
    onProgress?.(size);
    this.uploads.push({ localPath, remotePath, size });
  }
  async download(_remotePath: string, localPath: string) {
    await fs.writeFile(localPath, this.remoteContent);
  }
  async remove(remotePath: string) {
    this.removed.push(remotePath);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('3MF parsing', () => {
  it('reads sliced plates, used filaments, slicer extruder assignment and project filament count', () => {
    const info = parseThreeMf(buildSliced3mf());

    expect(info.projectFilamentCount).toBe(4);
    expect(info.printerModel).toBe('Bambu Lab H2D');
    expect(info.slicerVersion).toBe('02.02.00.85');
    expect(info.plates).toHaveLength(1);

    const plate = info.plates[0];
    expect(plate.index).toBe(1);
    expect(plate.name).toBe('Bracket');
    expect(plate.gcodePath).toBe('Metadata/plate_1.gcode');
    expect(plate.gcodeMd5).toBe('0123456789ABCDEF0123456789ABCDEF');
    expect(plate.predictionSeconds).toBe(3720);
    expect(plate.thumbnail).toMatch(/^data:image\/png;base64,/);
    expect(plate.filaments.map((f) => [f.index, f.type, f.color, f.extruder])).toEqual([
      [0, 'PLA', '#FFFFFF', 1],
      [2, 'PLA', '#FF0000', 2],
    ]);
  });

  it('rejects projects without sliced G-code and non-zip files', () => {
    expect(() => parseThreeMf(buildSliced3mf({ sliced: false }))).toThrow(/Export plate sliced file/);
    expect(() => parseThreeMf(strToU8('not a zip'))).toThrow(/not a valid 3MF/);
  });
});

describe('AMS mapping for project_file', () => {
  it('builds project-length ams_mapping and the H2 ams_mapping2 table', () => {
    const plateFilaments = parseThreeMf(buildSliced3mf()).plates[0].filaments;
    const payload = buildAmsMappingPayload(4, plateFilaments, { 0: 0, 2: 6 });

    expect(payload.amsMapping).toEqual([0, -1, 6, -1]);
    expect(payload.amsMapping2).toEqual([
      { ams_id: 0, slot_id: 0 },
      { ams_id: 255, slot_id: 255 },
      { ams_id: 1, slot_id: 2 },
      { ams_id: 255, slot_id: 255 },
    ]);
    expect(payload.useAms).toBe(true);

    const external = buildAmsMappingPayload(1, [{ ...plateFilaments[0] }], { 0: 254 });
    expect(external).toEqual({ amsMapping: [254], amsMapping2: [{ ams_id: 254, slot_id: 254 }], useAms: false });
  });

  it('suggests a loaded tray of the same material with the closest colour', () => {
    const store = new PrinterStateStore('S');
    const state = normalizePrinterState(store.getState(), amsReport);
    const trays = listAvailableTrays(state);
    store.destroy();

    expect(trays.find((t) => t.trayIndex === 3)?.isEmpty).toBe(true);
    const plateFilaments = parseThreeMf(buildSliced3mf()).plates[0].filaments;
    expect(suggestMapping(plateFilaments, trays)).toEqual({ 0: 0, 2: 2 });
  });

  it('makes FTPS-safe remote names', () => {
    expect(toRemoteName('Giá đỡ điện thoại v2.gcode.3mf')).toBe('Gia_do_dien_thoai_v2.gcode.3mf');
    expect(toRemoteName('C:\\models\\part.3mf')).toBe('part.3mf');
  });
});

describe('Print job API (/api/print/*)', () => {
  let app: TestApp;
  let stateStore: PrinterStateStore;
  let printerService: PrinterService;
  let mqtt: { publishRequest: ReturnType<typeof vi.fn>; isConnected: () => boolean; connected: boolean };
  let storage: MockStorage;
  let manager: PrintJobManager;
  const originalRealPrinter = env.BAMBU_REAL_PRINTER;

  const prepare = async () => {
    const form = new FormData();
    form.append('file', new File([buildSliced3mf()], 'Bracket.gcode.3mf'));
    const res = await app.inject({ method: 'POST', url: '/api/print/prepare', form });
    expect(res.statusCode).toBe(201);
    return res.json().staged;
  };

  const start = (stagedId: string, amsMapping: Record<string, number | null> = { '0': 0, '2': 2 }) =>
    app.inject({ method: 'POST', url: '/api/print/start', payload: { stagedId, plateIndex: 1, amsMapping } });

  const report = (print: Record<string, unknown>) => manager.ingestReport({ print });

  beforeEach(async () => {
    manager = PrintJobManager.getInstance();
    manager.reset();
    manager.stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'print-test-'));
    storage = new MockStorage();
    manager.setStorageFactory(() => storage);

    stateStore = new PrinterStateStore('TEST_SERIAL_H2D');
    const capabilityRegistry = new CapabilityRegistry();
    mqtt = { publishRequest: vi.fn(async () => true), connected: true, isConnected: () => mqtt.connected };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    printerService = new PrinterService({
      serial: 'TEST_SERIAL_H2D',
      stateStore,
      capabilityRegistry,
      commandService,
      mqttClient: mqtt as any,
    });

    stateStore.updateState(normalizePrinterState(stateStore.getState(), amsReport));
    stateStore.setOnline(true);
    report(amsReport.print);
    env.BAMBU_REAL_PRINTER = true;

    app = createTestApp(printerService);
  });

  afterEach(async () => {
    env.BAMBU_REAL_PRINTER = originalRealPrinter;
    manager.reset();
    stateStore.destroy();
    app.close();
    await fs.rm(manager.stagingDir, { recursive: true, force: true });
  });

  it('prepare returns plates, filaments, live trays and a suggested mapping', async () => {
    const staged = await prepare();
    expect(staged.remoteName).toBe('/Bracket.gcode.3mf');
    expect(staged.projectFilamentCount).toBe(4);
    expect(staged.plates[0].suggestedMapping).toEqual({ 0: 0, 2: 2 });
    expect(staged.trays).toHaveLength(4);
  });

  it('prepare rejects non-3MF files and unsliced projects', async () => {
    const gcode = new FormData();
    gcode.append('file', new File(['G28'], 'part.gcode'));
    expect((await app.inject({ method: 'POST', url: '/api/print/prepare', form: gcode })).statusCode).toBe(415);

    const unsliced = new FormData();
    unsliced.append('file', new File([buildSliced3mf({ sliced: false })], 'part.3mf'));
    const res = await app.inject({ method: 'POST', url: '/api/print/prepare', form: unsliced });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('NOT_SLICED');
  });

  it('uploads over FTPS, sends project_file and confirms the start from printer reports', async () => {
    const staged = await prepare();
    const res = await start(staged.id);
    expect(res.statusCode).toBe(202);
    const jobId = res.json().job.id;
    await flush();
    await flush();

    expect(storage.uploads).toHaveLength(1);
    expect(storage.uploads[0].remotePath).toBe('/Bracket.gcode.3mf');

    expect(mqtt.publishRequest).toHaveBeenCalledTimes(1);
    const sent = mqtt.publishRequest.mock.calls[0][0].print;
    expect(sent).toMatchObject({
      command: 'project_file',
      param: 'Metadata/plate_1.gcode',
      url: 'ftp:///Bracket.gcode.3mf',
      md5: '0123456789ABCDEF0123456789ABCDEF',
      bed_type: 'auto',
      use_ams: true,
      ams_mapping: [0, -1, 2, -1],
      ams_mapping2: [
        { ams_id: 0, slot_id: 0 },
        { ams_id: 255, slot_id: 255 },
        { ams_id: 0, slot_id: 2 },
        { ams_id: 255, slot_id: 255 },
      ],
      subtask_name: 'Bracket',
      bed_leveling: true,
      flow_cali: true,
      timelapse: false,
    });
    expect(manager.getJob(jobId)?.status).toBe('SENT');

    report({ command: 'project_file', sequence_id: sent.sequence_id, result: 'success', reason: '' });
    expect(manager.getJob(jobId)?.status).toBe('ACCEPTED');

    report({ gcode_state: 'PREPARE' });
    expect(manager.getJob(jobId)?.status).toBe('PREPARING');

    report({ gcode_state: 'RUNNING', subtask_name: 'Bracket' });
    const job = (await app.inject({ method: 'GET', url: `/api/print/jobs/${jobId}` })).json().job;
    expect(job.status).toBe('PRINTING');
    expect(job.history.map((h: any) => h.status)).toEqual(['UPLOADING', 'UPLOADED', 'SENT', 'ACCEPTED', 'PREPARING', 'PRINTING']);
  });

  it('reports the printer rejecting the command', async () => {
    const staged = await prepare();
    const jobId = (await start(staged.id)).json().job.id;
    await flush();
    await flush();
    const seq = mqtt.publishRequest.mock.calls[0][0].print.sequence_id;

    report({ command: 'project_file', sequence_id: seq, result: 'fail', reason: 'file not found' });
    const job = manager.getJob(jobId)!;
    expect(job.status).toBe('FAILED');
    expect(job.message).toContain('file not found');
  });

  it('ignores a stale FAILED state from the previous job but catches a real failure', async () => {
    report({ gcode_state: 'FAILED', print_error: 0 });
    const staged = await prepare();
    const jobId = (await start(staged.id)).json().job.id;
    await flush();
    await flush();

    report({ gcode_state: 'FAILED' });
    expect(manager.getJob(jobId)?.status).toBe('SENT');

    report({ gcode_state: 'PREPARE' });
    report({ gcode_state: 'FAILED', print_error: 0x07008012, hms: [{ attr: 0x07008012, code: 0x00020015 }] });
    const job = manager.getJob(jobId)!;
    expect(job.status).toBe('FAILED');
    expect(job.printError).toBe('0700-8012');
    expect(job.hmsErrors).toContain('0700-8012-0002-0015');
  });

  it('fails the job when the FTPS upload fails, without sending MQTT', async () => {
    storage.failUpload = new Error('connect ECONNREFUSED 192.168.1.100:990');
    const staged = await prepare();
    const jobId = (await start(staged.id)).json().job.id;
    await flush();

    expect(manager.getJob(jobId)?.status).toBe('FAILED');
    expect(manager.getJob(jobId)?.message).toContain('ECONNREFUSED');
    expect(mqtt.publishRequest).not.toHaveBeenCalled();
  });

  it('enforces safety mode, connection, developer mode, idle state, single job and a valid mapping', async () => {
    const staged = await prepare();

    env.BAMBU_REAL_PRINTER = false;
    expect((await start(staged.id)).json().error).toBe('TEST_MODE_RESTRICTED');
    env.BAMBU_REAL_PRINTER = true;

    mqtt.connected = false;
    expect((await start(staged.id)).statusCode).toBe(503);
    mqtt.connected = true;

    report({ fun: '3EC1AFFF9CFF' }); // signature required → developer mode off
    const devMode = await start(staged.id);
    expect(devMode.statusCode).toBe(412);
    expect(devMode.json().error).toBe('DEVELOPER_MODE_REQUIRED');
    report({ fun: '3EC18FFF9CFF' });

    report({ gcode_state: 'RUNNING' });
    expect((await start(staged.id)).json().error).toBe('PRINTER_BUSY');
    report({ gcode_state: 'IDLE' });

    const emptyTray = await start(staged.id, { '0': 0, '2': 3 });
    expect(emptyTray.statusCode).toBe(400);
    expect(emptyTray.json().error).toBe('INVALID_AMS_MAPPING');
    expect(emptyTray.json().details.errors[0]).toContain('đang trống');

    const unmapped = await start(staged.id, { '0': 0 });
    expect(unmapped.json().details.errors[0]).toContain('chưa chọn khay');

    expect((await start(staged.id)).statusCode).toBe(202);
    expect((await start(staged.id)).json().error).toBe('PRINT_JOB_IN_PROGRESS');
  });

  it('prints a file already on the printer without uploading it again', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/print/prepare-remote', payload: { path: '/Bracket.gcode.3mf' } });
    expect(res.statusCode).toBe(201);
    const staged = res.json().staged;
    expect(staged.source).toBe('printer');

    expect((await start(staged.id)).statusCode).toBe(202);
    await flush();
    expect(storage.uploads).toHaveLength(0);
    expect(mqtt.publishRequest.mock.calls[0][0].print.url).toBe('ftp:///Bracket.gcode.3mf');
  });

  it('lists and deletes printer files over FTPS', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/files' });
    expect(list.statusCode).toBe(200);
    expect(list.json().files).toEqual([expect.objectContaining({ path: '/Bracket.gcode.3mf', printable: true })]);

    const del = await app.inject({ method: 'DELETE', url: `/api/files/${encodeURIComponent('/Bracket.gcode.3mf')}` });
    expect(del.statusCode).toBe(200);
    expect(storage.removed).toEqual(['/Bracket.gcode.3mf']);
  });
});
