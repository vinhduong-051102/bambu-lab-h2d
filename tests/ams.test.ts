import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { PrinterStateStore } from '../src/domain/PrinterStateStore.js';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry.js';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService.js';
import { PrinterService } from '../src/domain/PrinterService.js';
import { normalizePrinterState } from '../src/domain/normalizePrinterState.js';
import { createServer } from '../src/server/server.js';
import { AmsCommandTracker } from '../src/domain/commands/AmsCommandTracker.js';

describe('AMS Control & Telemetry Protocol Test Suite (18 Mandatory Test Cases)', () => {
  let app: FastifyInstance;
  let stateStore: PrinterStateStore;
  let capabilityRegistry: CapabilityRegistry;
  let commandService: PrinterCommandService;
  let printerService: PrinterService;
  let mockMqttClient: any;
  let tracker: AmsCommandTracker;

  const rawH2dTelemetry = {
    print: {
      gcode_state: 'IDLE',
      ams: {
        ams_exist_bits: '1',
        tray_exist_bits: '15',
        tray_is_bbl_bits: '15',
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
              {
                id: '0',
                tray_type: 'PETG',
                tray_sub_brands: 'PETG Basic',
                tray_color: 'DBC8B6FF',
                tray_diameter: '1.75',
                tray_weight: '1000',
                remain: 100,
                tag_uid: 'RFID123456',
                tray_uuid: 'UUID-PETG-001',
                state: 11,
              },
              {
                id: '1',
                tray_type: 'PLA',
                tray_sub_brands: 'PLA Basic',
                tray_color: '00FF00FF',
                tray_diameter: '1.75',
                tray_weight: '1000',
                remain: 80,
                tag_uid: 'RFID123457',
                tray_uuid: 'UUID-PLA-002',
                state: 11,
              },
              {
                id: '2',
                tray_type: 'ABS',
                tray_sub_brands: 'ABS Tough',
                tray_color: 'FF0000FF',
                tray_diameter: '1.75',
                tray_weight: '1000',
                remain: 50,
                tag_uid: 'RFID123458',
                tray_uuid: 'UUID-ABS-003',
                state: 11,
              },
              {
                id: '3',
                tray_type: 'TPU',
                tray_sub_brands: 'TPU 95A',
                tray_color: '0000FFFF',
                tray_diameter: '1.75',
                tray_weight: '750',
                remain: 30,
                tag_uid: 'RFID123459',
                tray_uuid: 'UUID-TPU-004',
                state: 11,
              },
            ],
          },
        ],
      },
    },
  };

  beforeEach(async () => {
    stateStore = new PrinterStateStore('TEST_SERIAL_AMS');
    capabilityRegistry = new CapabilityRegistry();
    mockMqttClient = {
      publishRequest: async () => true,
    };

    commandService = new PrinterCommandService(capabilityRegistry, stateStore, mockMqttClient);
    printerService = new PrinterService({
      serial: 'TEST_SERIAL_AMS',
      stateStore,
      capabilityRegistry,
      commandService,
      mqttClient: mockMqttClient,
    });

    tracker = AmsCommandTracker.getInstance();
    tracker.clear();

    app = await createServer(printerService);
    await app.ready();
  });

  afterEach(async () => {
    stateStore.destroy();
    await app.close();
  });

  // Test 1: Load Tray 0
  it('1. Should post load command for Tray 0 and transition status correctly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ams/load',
      payload: { amsId: 0, trayId: 0, target: 0, temp: 220 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('SENT');
    expect(body.commandId).toBeDefined();

    const cmd = tracker.getCommand(body.commandId);
    expect(cmd).toBeDefined();
    expect(cmd?.target).toBe(0);
    expect(cmd?.status).toBe('WAITING_FOR_PRINTER');
  });

  // Test 2: Load Tray 1
  it('2. Should post load command for Tray 1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ams/load',
      payload: { amsId: 0, trayId: 1, target: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().target).toBe(1);
  });

  // Test 3: Load Tray 2
  it('3. Should post load command for Tray 2', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ams/load',
      payload: { amsId: 0, trayId: 2, target: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().target).toBe(2);
  });

  // Test 4: Load Tray 3
  it('4. Should post load command for Tray 3', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ams/load',
      payload: { amsId: 0, trayId: 3, target: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().target).toBe(3);
  });

  // Test 5: Unload
  it('5. Should post unload command with target 255', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ams/unload',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('SENT');

    const cmd = tracker.getCommand(body.commandId);
    expect(cmd?.target).toBe(255);
  });

  // Test 6: Retry
  it('6. Should post retry command marked as PROTOCOL_UNVERIFIED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ams/retry',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.protocolConfidence).toBe('PROTOCOL_UNVERIFIED');
  });

  // Test 7: Setting Tray
  it('7. Should update tray settings via POST /api/ams/setting', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ams/setting',
      payload: {
        amsId: 0,
        trayId: 0,
        color: '#FF5733',
        type: 'PETG',
        minTemp: 220,
        maxTemp: 260,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  // Test 8: Printer does not respond -> TIMEOUT handling
  it('8. Should handle printer timeout when no matching telemetry is received', async () => {
    const cmd = tracker.createCommand({
      type: 'load',
      amsId: 0,
      trayId: 1,
      target: 1,
      rawRequest: { command: 'ams_change_filament', target: 1 },
    });
    tracker.markSent(cmd.commandId);

    // Verify after timeout period
    const initialState = stateStore.getState();
    tracker.verifyTelemetry(initialState, 0); // 0ms timeout threshold

    expect(cmd.status).toBe('TIMEOUT');
    expect(cmd.error).toContain('timed out');
  });

  // Test 9: MQTT disconnect
  it('9. Should return HTTP 503 if MQTT client fails to publish request', async () => {
    printerService.mqttClient!.publishRequest = async () => false;

    const res = await app.inject({
      method: 'POST',
      url: '/api/ams/load',
      payload: { amsId: 0, trayId: 0 },
    });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('MQTT_DISCONNECTED');
  });

  // Test 10: Invalid tray / target
  it('10. Should fallback gracefully for invalid or missing tray payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ams/load',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().target).toBe(0);
  });

  // Test 11: CRITICAL - tray_now = 255 sentinel value must NOT map to Tray 0!
  it('11. CRITICAL: tray_now = "255" sentinel must set activeTrayId to null (NOT Tray 0)', () => {
    const currentState = stateStore.getState();
    const updatedState = normalizePrinterState(currentState, rawH2dTelemetry);

    expect(updatedState.amsTrayNow).toBe('255');
    expect(updatedState.amsActiveTrayId).toBeNull();

    const amsUnit = updatedState.ams![0];
    expect(amsUnit.activeTrayId).toBeNull();
    amsUnit.trays.forEach((tray) => {
      expect(tray.isActive).toBe(false);
    });
  });

  // Test 12: AMS unit empty / not present
  it('12. Should handle telemetry payload with no AMS units', () => {
    const currentState = stateStore.getState();
    const noAmsPayload = { print: { gcode_state: 'IDLE' } };
    const updatedState = normalizePrinterState(currentState, noAmsPayload);

    expect(updatedState.ams).toEqual([]);
    expect(updatedState.amsActiveTrayId).toBeUndefined();
  });

  // Test 13: Tray empty (remain: 0 or state: 0)
  it('13. Should flag tray as isEmpty when remain is 0 or state is 0', () => {
    const emptyPayload = {
      print: {
        ams: {
          ams: [
            {
              id: '0',
              tray: [{ id: '0', tray_type: 'PLA', remain: 0, state: 0 }],
            },
          ],
        },
      },
    };

    const currentState = stateStore.getState();
    const updated = normalizePrinterState(currentState, emptyPayload);
    const tray = updated.ams![0].trays[0];

    expect(tray.isEmpty).toBe(true);
    expect(tray.remain).toBe(0);
  });

  // Test 14: RFID Tray metadata preservation & Color normalization
  it('14. Should preserve RFID metadata and normalize hex colors', () => {
    const currentState = stateStore.getState();
    const updated = normalizePrinterState(currentState, rawH2dTelemetry);
    const tray0 = updated.ams![0].trays[0];

    expect(tray0.rawColor).toBe('DBC8B6FF');
    expect(tray0.color).toBe('#DBC8B6');
    expect(tray0.tagUid).toBe('RFID123456');
    expect(tray0.uuid).toBe('UUID-PETG-001');
    expect(tray0.subBrand).toBe('PETG Basic');
  });

  // Test 15: Multiple AMS units
  it('15. Should parse multiple AMS units correctly', () => {
    const multiAmsPayload = {
      print: {
        ams: {
          ams: [
            { id: '0', temp: '30', tray: [{ id: '0', tray_type: 'PLA' }] },
            { id: '1', temp: '32', tray: [{ id: '0', tray_type: 'PETG' }] },
          ],
        },
      },
    };

    const currentState = stateStore.getState();
    const updated = normalizePrinterState(currentState, multiAmsPayload);

    expect(updated.ams!.length).toBe(2);
    expect(updated.ams![0].id).toBe('0');
    expect(updated.ams![1].id).toBe('1');
  });

  // Test 16: Multiple Trays per AMS
  it('16. Should parse all 4 trays per AMS unit', () => {
    const currentState = stateStore.getState();
    const updated = normalizePrinterState(currentState, rawH2dTelemetry);

    expect(updated.ams![0].trays.length).toBe(4);
    expect(updated.ams![0].trays[0].type).toBe('PETG');
    expect(updated.ams![0].trays[1].type).toBe('PLA');
    expect(updated.ams![0].trays[2].type).toBe('ABS');
    expect(updated.ams![0].trays[3].type).toBe('TPU');
  });

  // Test 17: Duplicate MQTT messages -> State stability
  it('17. Should maintain state stability on duplicate MQTT reports', () => {
    const state1 = normalizePrinterState(stateStore.getState(), rawH2dTelemetry);
    stateStore.updateState(state1);

    const state2 = normalizePrinterState(stateStore.getState(), rawH2dTelemetry);
    stateStore.updateState(state2);

    expect(state2.amsActiveTrayId).toBeNull();
    expect(state2.ams![0].trays.length).toBe(4);
  });

  // Test 19: Idempotency Guard (HTTP 409 Conflict)
  it('19. Should return HTTP 409 Conflict if another AMS command is already pending', async () => {
    // Issue first load command
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/ams/load',
      payload: { amsId: 0, trayId: 0 },
    });
    expect(res1.statusCode).toBe(200);

    // Issue second concurrent load command
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/ams/load',
      payload: { amsId: 0, trayId: 1 },
    });

    expect(res2.statusCode).toBe(409);
    const body2 = res2.json();
    expect(body2.success).toBe(false);
    expect(body2.error).toBe('AMS_COMMAND_IN_PROGRESS');
  });

  // Test 20: AMS RFID Read Request
  it('20. Should trigger ams_get_rfid command and return slot rfid data', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ams/0/tray/0/rfid',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.commandId).toBeDefined();
    expect(body.rfidData.amsId).toBe(0);
    expect(body.rfidData.slotId).toBe(0);
  });

  // Test 21: Multi-field Telemetry Verifier HMS Failure Detection
  it('21. Should fail active AMS command if printer reports HMS hardware error', () => {
    const cmd = tracker.createCommand({
      type: 'load',
      amsId: 0,
      trayId: 0,
      target: 0,
      rawRequest: { command: 'ams_change_filament', target: 0 },
    });
    tracker.markSent(cmd.commandId);

    const errorState = {
      ...stateStore.getState(),
      hmsErrors: [{ attr: 'AMS_TANGLE', code: '0300_8000' }],
    };

    tracker.verifyTelemetry(errorState as any);

    expect(cmd.status).toBe('FAILED');
    expect(cmd.error).toContain('0300_8000');
  });
});
