import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { normalizePrinterState } from '../src/domain/normalizePrinterState';
import { createTestApp, type TestApp } from './helpers/testApp';
import { AmsCommandTracker } from '../src/domain/commands/AmsCommandTracker';
import { decodeExtruderSlot, trayIndexOf } from '../src/domain/ams/amsTrays';
import { env } from '../src/config/env';

const NONE = 0xffff;
const slotWord = (amsId: number, slotId: number) => (amsId << 8) | slotId;

function tray(id: string, type: string, color: string, min: number, max: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    tray_type: type,
    tray_sub_brands: `${type} Basic`,
    tray_color: color,
    tray_diameter: '1.75',
    tray_weight: '1000',
    tray_info_idx: type === 'PLA' ? 'GFA00' : 'GFG00',
    nozzle_temp_min: String(min),
    nozzle_temp_max: String(max),
    remain: 80,
    tag_uid: `RFID-${id}`,
    tray_uuid: `UUID-${id}`,
    state: 11,
    ...extra,
  };
}

// Shape taken from a real H2D report: tray_now stays "255", the loaded slot is in device.extruder.info[].snow
function h2dReport(snow0 = NONE, snow1 = 0xfeff, star0 = snow0) {
  return {
    print: {
      gcode_state: 'IDLE',
      ams_status: 0,
      device: {
        extruder: {
          info: [
            { id: 0, temp: 32, snow: snow0, spre: NONE, star: star0, hnow: 0, hpre: 0, htar: 0, stat: 0 },
            { id: 1, temp: 32, snow: snow1, spre: snow1, star: snow1, hnow: 1, hpre: 1, htar: 1, stat: 0 },
          ],
          state: 2,
        },
        nozzle: { src_id: 0, tar_id: 0, info: [{ id: 0, diameter: 0.4 }, { id: 1, diameter: 0.4 }] },
      },
      ams: {
        ams_exist_bits: '3',
        tray_exist_bits: 'ee',
        tray_now: '255',
        tray_tar: '255',
        tray_pre: '255',
        ams: [
          {
            id: '0',
            temp: '31.6',
            humidity: '1',
            humidity_raw: '40',
            tray: [
              { id: '0', state: 10 },
              tray('1', 'PLA', '4DAFDAFF', 190, 240),
              tray('2', 'PETG', '000000FF', 230, 260),
              tray('3', 'PETG', 'DBC8B6FF', 230, 260),
            ],
          },
          {
            id: '1',
            temp: '30.0',
            tray: [tray('0', 'PLA', 'FF0000FF', 190, 230), { id: '1', state: 10 }],
          },
        ],
      },
    },
  };
}

describe('AMS control & telemetry', () => {
  let app: TestApp;
  let stateStore: PrinterStateStore;
  let printerService: PrinterService;
  let mockMqttClient: any;
  let published: any[];
  let tracker: AmsCommandTracker;
  const originalRealPrinter = env.BAMBU_REAL_PRINTER;

  const ingest = (payload: any) => {
    tracker.recordRawResponse(payload);
    stateStore.updateState(normalizePrinterState(stateStore.getState(), payload));
    tracker.verifyTelemetry(stateStore.getState());
  };
  const lastPrint = () => published[published.length - 1].print;

  beforeEach(async () => {
    env.BAMBU_REAL_PRINTER = true;
    stateStore = new PrinterStateStore('TEST_SERIAL_AMS');
    const capabilityRegistry = new CapabilityRegistry();
    published = [];
    mockMqttClient = {
      publishRequest: async (payload: any) => {
        published.push(payload);
        return true;
      },
    };

    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mockMqttClient);
    printerService = new PrinterService({
      serial: 'TEST_SERIAL_AMS',
      stateStore,
      capabilityRegistry,
      commandService,
      mqttClient: mockMqttClient,
    });

    tracker = AmsCommandTracker.getInstance();
    tracker.clear();
    app = createTestApp(printerService);
  });

  afterEach(async () => {
    env.BAMBU_REAL_PRINTER = originalRealPrinter;
    stateStore.destroy();
    app.close();
  });

  it('blocks every AMS write command with 403 when BAMBU_REAL_PRINTER is false', async () => {
    env.BAMBU_REAL_PRINTER = false;
    const requests = [
      { method: 'POST', url: '/api/ams/load' },
      { method: 'POST', url: '/api/ams/unload' },
      { method: 'POST', url: '/api/ams/setting' },
      { method: 'POST', url: '/api/ams/retry' },
      { method: 'GET', url: '/api/ams/0/tray/0/rfid' },
    ] as const;
    for (const { method, url } of requests) {
      const res = await app.inject({ method, url, ...(method === 'POST' && { payload: { slotId: 1 } }) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error, url).toBe('TEST_MODE_RESTRICTED');
    }
    expect(published).toHaveLength(0);
  });

  describe('telemetry', () => {
    it('decodes H2 extruder slot words', () => {
      expect(decodeExtruderSlot(0x0002)).toEqual({ amsId: 0, slotId: 2 });
      expect(decodeExtruderSlot(0x0103)).toEqual({ amsId: 1, slotId: 3 });
      expect(decodeExtruderSlot(0x8000)).toEqual({ amsId: 128, slotId: 0 });
      expect(decodeExtruderSlot(0xffff)).toBeNull();
      expect(decodeExtruderSlot(0xfeff)).toBeNull(); // external spool, not an AMS tray
      expect(trayIndexOf(1, 0)).toBe(4);
      expect(trayIndexOf(128, 0)).toBe(128);
    });

    it('reports no loaded tray when every extruder is empty (tray_now "255" is ignored)', () => {
      ingest(h2dReport());
      const state = stateStore.getState();
      expect(state.amsTrayNow).toBe('255');
      expect(state.amsActiveTrayId).toBeNull();
      expect(state.amsLoadedTrays).toEqual([]);
      state.ams!.flatMap((u) => u.trays).forEach((t) => {
        expect(t.isActive).toBe(false);
        expect(t.isLoaded).toBe(false); // state 11 only means a spool sits in the slot
      });
    });

    it('marks the tray named by extruder.info[].snow as loaded, with its extruder', () => {
      ingest(h2dReport(slotWord(0, 2)));
      const state = stateStore.getState();
      expect(state.amsActiveTrayId).toBe(2);
      expect(state.amsLoadedTrays).toEqual([{ trayIndex: 2, amsId: 0, slotId: 2, extruderId: 0 }]);
      const t2 = state.ams![0].trays[2];
      expect(t2.isActive).toBe(true);
      expect(t2.isLoaded).toBe(true);
      expect(t2.loadedExtruderId).toBe(0);
      expect(state.ams![0].activeTrayId).toBe(2);
      expect(state.ams![1].activeTrayId).toBeNull();
    });

    it('maps a tray of the second AMS by unit, not by slot number', () => {
      ingest(h2dReport(slotWord(1, 0)));
      const state = stateStore.getState();
      expect(state.amsActiveTrayId).toBe(4);
      expect(state.ams![0].trays[0].isActive).toBe(false);
      expect(state.ams![1].trays[0].isActive).toBe(true);
    });

    it('refreshes tray flags from an extruder-only delta report', () => {
      ingest(h2dReport(slotWord(0, 1)));
      ingest({ print: { device: { extruder: { info: [{ id: 0, snow: NONE, star: NONE }] } } } });
      const state = stateStore.getState();
      expect(state.amsActiveTrayId).toBeNull();
      expect(state.ams![0].trays[1].isActive).toBe(false);
    });

    it('flags the target tray while a change is in progress', () => {
      ingest(h2dReport(NONE, 0xfeff, slotWord(0, 3)));
      const state = stateStore.getState();
      expect(state.amsTargetTrayId).toBe(3);
      expect(state.ams![0].trays[3].isTarget).toBe(true);
    });

    it('falls back to print.ams.tray_now on printers without extruder slot words', () => {
      ingest({ print: { ams: { tray_now: '5', ams: [{ id: '0', tray: [tray('0', 'PLA', 'FFFFFFFF', 190, 230)] }, { id: '1', tray: [tray('0', 'PLA', 'FFFFFFFF', 190, 230), tray('1', 'PLA', '000000FF', 190, 230)] }] } } });
      const state = stateStore.getState();
      expect(state.amsActiveTrayId).toBe(5);
      expect(state.ams![1].trays[1].isActive).toBe(true);
    });

    it('parses tray profile id and nozzle range', () => {
      ingest(h2dReport());
      const t1 = stateStore.getState().ams![0].trays[1];
      expect(t1.infoIdx).toBe('GFA00');
      expect(t1.nozzleTempMin).toBe(190);
      expect(t1.nozzleTempMax).toBe(240);
      expect(t1.color).toBe('#4DAFDA');
      expect(t1.rawColor).toBe('4DAFDAFF');
    });

    it('clears a tray whose spool was removed instead of keeping the old filament', () => {
      ingest(h2dReport());
      const report = h2dReport();
      report.print.ams.ams[0].tray[2] = { id: '2', state: 10 } as any;
      ingest(report);
      const t2 = stateStore.getState().ams![0].trays[2];
      expect(t2.isEmpty).toBe(true);
      expect(t2.type).toBeNull();
    });

    it('clears HMS errors when the printer reports an empty hms list', () => {
      ingest({ print: { hms: [{ attr: 0x07002000, code: 0x00020001 }] } });
      expect(stateStore.getState().hmsErrors).toHaveLength(1);
      ingest({ print: { gcode_state: 'IDLE' } });
      expect(stateStore.getState().hmsErrors).toHaveLength(1);
      ingest({ print: { hms: [] } });
      expect(stateStore.getState().hmsErrors).toHaveLength(0);
    });
  });

  describe('POST /api/ams/load', () => {
    beforeEach(() => ingest(h2dReport()));

    it('sends target, ams_id, slot_id and the tray temperature', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 2 } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('SENT');
      expect(body.target).toBe(2);
      expect(lastPrint()).toMatchObject({ command: 'ams_change_filament', target: 2, ams_id: 0, slot_id: 2, curr_temp: 245, tar_temp: 245 });
      expect(tracker.getCommand(body.commandId)?.status).toBe('WAITING_FOR_PRINTER');
    });

    it('uses the absolute index for a tray of the second AMS', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 1, slotId: 0 } });
      expect(res.statusCode).toBe(200);
      expect(lastPrint()).toMatchObject({ target: 4, ams_id: 1, slot_id: 0, tar_temp: 210 });
    });

    it('accepts the legacy trayId field as the slot', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, trayId: 1 } });
      expect(res.statusCode).toBe(200);
      expect(lastPrint()).toMatchObject({ target: 1, slot_id: 1, tar_temp: 215 });
    });

    it('uses the loaded filament temperature as curr_temp', async () => {
      ingest(h2dReport(slotWord(0, 1)));
      await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 3 } });
      expect(lastPrint()).toMatchObject({ curr_temp: 215, tar_temp: 245 });
    });

    it.each([
      [{ amsId: 0 }, 'INVALID_PARAMETER'],
      [{ amsId: 0, slotId: -1 }, 'INVALID_PARAMETER'],
      [{ amsId: 3, slotId: 0 }, 'TRAY_NOT_FOUND'],
      [{ amsId: 0, slotId: 0 }, 'TRAY_EMPTY'],
      [{ amsId: 0, slotId: 2, temp: 200 }, 'INVALID_TEMPERATURE'],
    ])('rejects %j with %s', async (payload, error) => {
      const res = await app.inject({ method: 'POST', url: '/api/ams/load', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(error);
      expect(published).toHaveLength(0);
    });

    it('rejects a tray that is already loaded', async () => {
      ingest(h2dReport(slotWord(0, 2)));
      const res = await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 2 } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('TRAY_ALREADY_LOADED');
    });

    it('refuses while printing', async () => {
      ingest({ print: { gcode_state: 'RUNNING' } });
      const res = await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 2 } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('PRINTER_BUSY');
    });

    it('returns 409 while another AMS command is pending', async () => {
      expect((await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 1 } })).statusCode).toBe(200);
      const res = await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 2 } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('AMS_COMMAND_IN_PROGRESS');
    });

    it('returns 503 when MQTT publish fails', async () => {
      mockMqttClient.publishRequest = async () => false;
      const res = await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 1 } });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('MQTT_DISCONNECTED');
    });

    it('completes once the extruder reports the target slot', async () => {
      const { commandId } = (await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 2 } })).json();
      ingest(h2dReport(NONE, 0xfeff, slotWord(0, 2)));
      expect(tracker.getCommand(commandId)?.status).toBe('WAITING_FOR_PRINTER');
      ingest(h2dReport(slotWord(0, 2)));
      expect(tracker.getCommand(commandId)?.status).toBe('COMPLETED');
    });

    it('waits for the AMS to finish the change, not just for snow to switch (live H2D sequence)', async () => {
      const { commandId } = (await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 1 } })).json();
      ingest({ print: { command: 'ams_change_filament', sequence_id: lastPrint().sequence_id, result: 'success', errno: 0 } });
      // snow/star jump to the target immediately while ams_status reports 0x0102 (filament change)
      ingest({ print: { ams_status: 0x0102, device: { extruder: { info: [{ id: 0, snow: slotWord(0, 1), star: slotWord(0, 1) }] } } } });
      expect(tracker.getCommand(commandId)?.status).toBe('VERIFYING');
      ingest({ print: { ams_status: 0 } });
      expect(tracker.getCommand(commandId)?.status).toBe('COMPLETED');
    });

    it('fails when the load stops on an AMS HMS error (live H2D sequence)', async () => {
      const { commandId } = (await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 1 } })).json();
      ingest({ print: { ams_status: 0x0102, device: { extruder: { info: [{ id: 0, snow: slotWord(0, 1), star: slotWord(0, 1) }] } } } });
      ingest({ print: { ams_status: 0x0300, hms: [{ attr: 117448960, code: 131109 }] } });
      const record = tracker.getCommand(commandId)!;
      expect(record.status).toBe('FAILED');
      expect(record.error).toContain('0700-2100-0002-0025');
    });

    it('moves to VERIFYING on a success reply and FAILED on a refusal', async () => {
      const first = (await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 2 } })).json();
      const seq = lastPrint().sequence_id;
      ingest({ print: { command: 'ams_change_filament', sequence_id: seq, result: 'success' } });
      const record = tracker.getCommand(first.commandId)!;
      expect(record.status).toBe('VERIFYING');
      expect(record.acknowledgedAt).not.toBeNull();

      tracker.clear();
      const second = (await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 3 } })).json();
      ingest({ print: { command: 'ams_change_filament', sequence_id: lastPrint().sequence_id, result: 'fail', reason: 'nozzle busy' } });
      const failed = tracker.getCommand(second.commandId)!;
      expect(failed.status).toBe('FAILED');
      expect(failed.error).toContain('nozzle busy');
    });

    it('ignores replies to other sequence ids', async () => {
      const { commandId } = (await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 2 } })).json();
      ingest({ print: { command: 'ams_change_filament', sequence_id: '1', result: 'fail' } });
      expect(tracker.getCommand(commandId)?.status).toBe('WAITING_FOR_PRINTER');
    });

    it('times out when telemetry never confirms', async () => {
      const { commandId } = (await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 2 } })).json();
      tracker.verifyTelemetry(stateStore.getState(), 0);
      const record = tracker.getCommand(commandId)!;
      expect(record.status).toBe('TIMEOUT');
      expect(record.error).toContain('timed out');
    });

    it('fails on a new AMS HMS error but not on old or non-AMS ones', async () => {
      ingest({ print: { hms: [{ attr: 0x07002000, code: 0x00020001 }] } });
      const { commandId } = (await app.inject({ method: 'POST', url: '/api/ams/load', payload: { amsId: 0, slotId: 2 } })).json();

      ingest({ print: { hms: [{ attr: 0x07002000, code: 0x00020001 }, { attr: 0x03002000, code: 0x00010001 }] } });
      expect(tracker.getCommand(commandId)?.status).toBe('WAITING_FOR_PRINTER');

      ingest({ print: { hms: [{ attr: 0x07012000, code: 0x00020002 }] } });
      const record = tracker.getCommand(commandId)!;
      expect(record.status).toBe('FAILED');
      expect(record.error).toContain('0701-2000-0002-0002');
    });
  });

  describe('POST /api/ams/unload', () => {
    it('sends the 255 sentinel and completes once no tray is loaded', async () => {
      ingest(h2dReport(slotWord(0, 1)));
      const res = await app.inject({ method: 'POST', url: '/api/ams/unload', payload: {} });
      expect(res.statusCode).toBe(200);
      expect(lastPrint()).toMatchObject({ command: 'ams_change_filament', target: 255, ams_id: 255, slot_id: 255, curr_temp: 215, tar_temp: 215 });
      const { commandId } = res.json();
      expect(tracker.getCommand(commandId)?.target).toBe(255);
      expect(tracker.getCommand(commandId)?.status).toBe('WAITING_FOR_PRINTER');

      ingest(h2dReport());
      expect(tracker.getCommand(commandId)?.status).toBe('COMPLETED');
    });

    it('does not complete immediately when nothing was loaded and the printer has not answered', async () => {
      ingest(h2dReport());
      const { commandId } = (await app.inject({ method: 'POST', url: '/api/ams/unload', payload: {} })).json();
      ingest(h2dReport());
      expect(tracker.getCommand(commandId)?.status).toBe('WAITING_FOR_PRINTER');
      ingest({ print: { command: 'ams_change_filament', sequence_id: lastPrint().sequence_id, result: 'success' } });
      expect(tracker.getCommand(commandId)?.status).toBe('COMPLETED');
    });
  });

  describe('POST /api/ams/setting', () => {
    beforeEach(() => ingest(h2dReport()));

    it('sends a Bambu generic profile id as tray_info_idx', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ams/setting',
        payload: { amsId: 1, slotId: 1, color: '#ff5733', type: 'petg', minTemp: 220, maxTemp: 260 },
      });
      expect(res.statusCode).toBe(200);
      expect(lastPrint()).toMatchObject({
        command: 'ams_filament_setting',
        ams_id: 1,
        tray_id: 1,
        slot_id: 1,
        tray_info_idx: 'GFG99',
        tray_type: 'PETG',
        tray_color: 'FF5733FF',
        nozzle_temp_min: 220,
        nozzle_temp_max: 260,
      });
    });

    it('completes when the printer acknowledges', async () => {
      const { commandId } = (await app.inject({ method: 'POST', url: '/api/ams/setting', payload: { slotId: 0, color: '#FFFFFF', type: 'PLA' } })).json();
      ingest({ print: { command: 'ams_filament_setting', sequence_id: lastPrint().sequence_id, result: 'success' } });
      expect(tracker.getCommand(commandId)?.status).toBe('COMPLETED');
    });

    it.each([
      [{ slotId: 0, color: 'red', type: 'PLA' }, 'INVALID_COLOR'],
      [{ slotId: 0, color: '#FFFFFF', type: 'PEEK' }, 'UNKNOWN_FILAMENT_PROFILE'],
      [{ slotId: 0, color: '#FFFFFF', type: 'PLA', minTemp: 250, maxTemp: 200 }, 'INVALID_TEMPERATURE'],
      [{ amsId: 5, slotId: 0, color: '#FFFFFF', type: 'PLA' }, 'TRAY_NOT_FOUND'],
    ])('rejects %j with %s', async (payload, error) => {
      const res = await app.inject({ method: 'POST', url: '/api/ams/setting', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(error);
    });

    it('returns 503 when MQTT publish fails', async () => {
      mockMqttClient.publishRequest = async () => false;
      const res = await app.inject({ method: 'POST', url: '/api/ams/setting', payload: { slotId: 0, color: '#FFFFFF', type: 'PLA' } });
      expect(res.statusCode).toBe(503);
    });
  });

  describe('retry & rfid', () => {
    it('sends retry even while a load is pending, marked PROTOCOL_UNVERIFIED', async () => {
      ingest(h2dReport());
      await app.inject({ method: 'POST', url: '/api/ams/load', payload: { slotId: 1 } });
      const res = await app.inject({ method: 'POST', url: '/api/ams/retry', payload: {} });
      expect(res.statusCode).toBe(200);
      expect(res.json().protocolConfidence).toBe('PROTOCOL_UNVERIFIED');
      expect(lastPrint()).toMatchObject({ command: 'ams_control', param: 'retry' });
    });

    it('returns 503 for retry when MQTT publish fails', async () => {
      mockMqttClient.publishRequest = async () => false;
      const res = await app.inject({ method: 'POST', url: '/api/ams/retry', payload: {} });
      expect(res.statusCode).toBe(503);
    });

    it('requests an RFID read and returns the cached tag data', async () => {
      ingest(h2dReport());
      const res = await app.inject({ method: 'GET', url: '/api/ams/0/tray/1/rfid' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.rfidData).toMatchObject({ amsId: 0, slotId: 1, tagUid: 'RFID-1' });
      expect(lastPrint()).toMatchObject({ command: 'ams_get_rfid', ams_id: 0, slot_id: 1 });
    });
  });

  it('GET /api/ams exposes loaded trays and per-tray extruder', async () => {
    ingest(h2dReport(slotWord(0, 3)));
    const body = (await app.inject({ method: 'GET', url: '/api/ams' })).json();
    expect(body.activeTrayId).toBe(3);
    expect(body.loadedTrays).toEqual([{ trayIndex: 3, amsId: 0, slotId: 3, extruderId: 0 }]);
    expect(body.units[0].trays[3]).toMatchObject({ isLoaded: true, loadedExtruderId: 0, nozzleTempMin: 230 });
  });
});
