import type { BambuColourCatalogue } from '../../domain/filaments/bambuColors';
import { colourCatalogue } from './filaments';
import { AMSTray, PrinterState } from '../../domain/PrinterState';
import type { PrinterService } from '../../domain/PrinterService';
import { BambuCommandBuilder } from '../../bambu/commands/BambuCommandBuilder';
import { AmsCommandRecord, AmsCommandTracker, AmsCommandType, snapshotBaseline } from '../../domain/commands/AmsCommandTracker';
import { findTray, findTrayByIndex, trayIndexOf, trayLoadTemp, UNLOAD_TARGET } from '../../domain/ams/amsTrays';
import { env } from '../../config/env';
import { handler, HttpError, json, readJsonBody } from '../http';

const tracker = () => AmsCommandTracker.getInstance();

// Bambu generic filament profiles, used as tray_info_idx when the client doesn't name a profile
const GENERIC_PROFILE_IDS: Record<string, string> = {
  'PLA': 'GFL99',
  'PLA-CF': 'GFL98',
  'PETG': 'GFG99',
  'ABS': 'GFB99',
  'ASA': 'GFB98',
  'TPU': 'GFU99',
  'PC': 'GFC99',
  'PA': 'GFN99',
  'PA-CF': 'GFN98',
  'PVA': 'GFS99',
};

// AMS commands publish straight to MQTT, so they need the same safety gate as PrinterCommandService.
function assertRealPrinterMode(): void {
  if (!env.BAMBU_REAL_PRINTER) {
    throw new HttpError(403, {
      success: false,
      error: 'TEST_MODE_RESTRICTED',
      message: 'Command execution blocked: BAMBU_REAL_PRINTER is set to false. Set BAMBU_REAL_PRINTER=true in .env to allow sending commands to real printer.',
    });
  }
}

function badRequest(error: string, message: string): never {
  throw new HttpError(400, { success: false, error, message });
}

// Idempotency Check: Reject concurrent commands if another AMS action is in progress
function assertNoPendingCommand(state: PrinterState): void {
  tracker().verifyTelemetry(state);
  const pendingCmd = tracker().getActiveCommand();
  if (pendingCmd) {
    throw new HttpError(409, {
      success: false,
      error: 'AMS_COMMAND_IN_PROGRESS',
      commandId: pendingCmd.commandId,
      message: `Thao tác AMS (${pendingCmd.type}) đang được thực hiện. Vui lòng chờ lệnh hoàn tất.`,
    });
  }
}

function assertNotPrinting(state: PrinterState): void {
  if (state.state === 'RUNNING') {
    throw new HttpError(409, {
      success: false,
      error: 'PRINTER_BUSY',
      message: 'Máy in đang in. Tạm dừng (pause) trước khi thay nhựa.',
    });
  }
}

function readInt(value: unknown, field: string, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    badRequest('INVALID_PARAMETER', `Thiếu tham số ${field}.`);
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    badRequest('INVALID_PARAMETER', `${field} phải là số nguyên không âm.`);
  }
  return value;
}

function trayLabel(amsId: number, slotId: number): string {
  return amsId >= 128 ? `AMS HT ${amsId - 127}` : `AMS ${amsId + 1} – Khay ${slotId + 1}`;
}

/**
 * Creates the tracker record, publishes it and returns the error response if publishing failed.
 */
async function publishTracked(
  printerService: PrinterService,
  options: { type: AmsCommandType; amsId: number; trayId: number; target: number; payload: Record<string, unknown>; protocolConfidence?: 'CONFIRMED' | 'PROTOCOL_UNVERIFIED' },
): Promise<{ record: AmsCommandRecord; failure: Response | null }> {
  const record = tracker().createCommand({
    type: options.type,
    amsId: options.amsId,
    trayId: options.trayId,
    target: options.target,
    rawRequest: options.payload,
    protocolConfidence: options.protocolConfidence ?? 'CONFIRMED',
    serial: printerService.serial,
    baseline: snapshotBaseline(printerService.stateStore.getState()),
  });

  if (printerService.mqttClient) {
    const published = await printerService.mqttClient.publishRequest(options.payload);
    if (!published) {
      tracker().markFailed(record.commandId, 'MQTT client failed to publish payload');
      return {
        record,
        failure: json({
          success: false,
          commandId: record.commandId,
          status: 'FAILED',
          error: 'MQTT_DISCONNECTED',
          message: 'Không thể gửi lệnh MQTT tới máy in (MQTT disconnected).',
        }, 503),
      };
    }
    tracker().markSent(record.commandId);
  }
  return { record, failure: null };
}

function serializeTray(fil: AMSTray, catalogue: BambuColourCatalogue | null) {
  const official = catalogue?.identify(fil.infoIdx, fil.color) ?? null;
  return {
    id: fil.id,
    type: fil.type || 'UNKNOWN',
    subBrand: fil.subBrand || fil.subBrands || 'N/A',
    color: fil.color ? (fil.color.startsWith('#') ? fil.color : `#${fil.color}`) : '#FFFFFF',
    rawColor: fil.rawColor || null,
    remaining: fil.remain ?? null,
    diameter: fil.diameter ?? null,
    weight: fil.weight ?? null,
    uuid: fil.uuid || null,
    tagUid: fil.tagUid || null,
    infoIdx: fil.infoIdx ?? null,
    nozzleTempMin: fil.nozzleTempMin ?? null,
    nozzleTempMax: fil.nozzleTempMax ?? null,
    state: fil.state ?? null,
    isActive: fil.isActive ?? false,
    isTarget: fil.isTarget ?? false,
    isEmpty: fil.isEmpty ?? false,
    isLoaded: fil.isLoaded ?? false,
    loadedExtruderId: fil.loadedExtruderId ?? null,
    // The Bambu colour this is (by material id and colour), e.g. "Cyan" and spool code "10603"; null otherwise
    colorName: official?.name ?? null,
    colorCode: official?.code ?? null,
  };
}

// 1. GET /api/ams - Fetch current AMS state & active tray
export const getAms = handler(async ({ printerService }) => {
  const catalogue = await colourCatalogue();
  const state = printerService.stateStore.getState();
  tracker().verifyTelemetry(state);

  const normalizedUnits = (state.ams || []).map((unit) => ({
    id: unit.id,
    temperature: unit.temperature ?? null,
    humidity: unit.humidity ?? null,
    humidityRaw: unit.humidityRaw ?? null,
    status: unit.status ?? null,
    trays: (unit.trays || []).map((tray) => serializeTray(tray, catalogue)),
    activeTrayId: unit.activeTrayId ?? null,
    targetTrayId: unit.targetTrayId ?? null,
    currentTrayId: unit.currentTrayId ?? null,
    exists: unit.exists ?? true,
  }));

  return json({
    units: normalizedUnits,
    activeTrayId: state.amsActiveTrayId ?? null,
    targetTrayId: state.amsTargetTrayId ?? null,
    currentTrayId: state.amsCurrentTrayId ?? null,
    loadedTrays: state.amsLoadedTrays ?? [],
    amsStatus: state.amsStatus ?? null,
    trayNow: state.amsTrayNow ?? null,
    trayTar: state.amsTrayTar ?? null,
    trayPre: state.amsTrayPre ?? null,
    amsExistBits: state.amsExistBits ?? null,
    trayExistBits: state.trayExistBits ?? null,
    trayIsBblBits: state.trayIsBblBits ?? null,
  });
});

// 2. POST /api/ams/load - Feed the filament of one AMS tray into the toolhead
export const loadAms = handler(async ({ printerService, request }) => {
  assertRealPrinterMode();
  const state = printerService.stateStore.getState();

  const body = ((await readJsonBody(request)) || {}) as { amsId?: unknown; slotId?: unknown; trayId?: unknown; temp?: unknown };
  const amsId = readInt(body.amsId, 'amsId', 0);
  // `trayId` is the pre-H2D name of the slot inside the unit
  const slotId = readInt(body.slotId ?? body.trayId, 'slotId');

  const tray = findTray(state, amsId, slotId);
  if (!tray) badRequest('TRAY_NOT_FOUND', `${trayLabel(amsId, slotId)} không tồn tại (chưa có telemetry AMS hoặc sai amsId/slotId).`);
  if (tray.isEmpty) badRequest('TRAY_EMPTY', `${trayLabel(amsId, slotId)} đang trống.`);
  if (tray.isLoaded) badRequest('TRAY_ALREADY_LOADED', `${trayLabel(amsId, slotId)} đã được nạp vào đầu in.`);

  const target = trayIndexOf(amsId, slotId);
  let tarTemp = trayLoadTemp(tray);
  if (body.temp !== undefined) {
    if (typeof body.temp !== 'number' || !Number.isFinite(body.temp)) badRequest('INVALID_PARAMETER', 'temp phải là số.');
    const min = tray.nozzleTempMin ?? 160;
    const max = tray.nozzleTempMax ?? 300;
    if (body.temp < min || body.temp > max) {
      badRequest('INVALID_TEMPERATURE', `Nhiệt độ ${body.temp}°C nằm ngoài khoảng ${min}–${max}°C của ${tray.type ?? 'nhựa'} trong khay.`);
    }
    tarTemp = body.temp;
  }

  assertNotPrinting(state);
  assertNoPendingCommand(state);

  // Purge temperature for the filament being pushed out (the one currently in the active extruder)
  const current = state.amsActiveTrayId !== null && state.amsActiveTrayId !== undefined
    ? findTrayByIndex(state, state.amsActiveTrayId)
    : null;
  const currTemp = current ? trayLoadTemp(current, tarTemp) : tarTemp;

  const payload = BambuCommandBuilder.buildAmsLoadFilamentPayload(amsId, slotId, currTemp, tarTemp);
  const { record, failure } = await publishTracked(printerService, { type: 'load', amsId, trayId: slotId, target, payload });
  if (failure) return failure;

  return json({
    success: true,
    commandId: record.commandId,
    status: 'SENT',
    amsId,
    slotId,
    target,
    temp: tarTemp,
    message: `Đã gửi lệnh nạp nhựa từ ${trayLabel(amsId, slotId)} (${tray.type ?? '?'}, ${tarTemp}°C).`,
  });
});

// 3. POST /api/ams/unload - Retract the loaded filament back into the AMS
export const unloadAms = handler(async ({ printerService }) => {
  assertRealPrinterMode();
  const state = printerService.stateStore.getState();
  assertNotPrinting(state);
  assertNoPendingCommand(state);

  const loaded = state.amsActiveTrayId !== null && state.amsActiveTrayId !== undefined
    ? findTrayByIndex(state, state.amsActiveTrayId)
    : null;
  const temp = trayLoadTemp(loaded);

  const payload = BambuCommandBuilder.buildAmsUnloadFilamentPayload(temp);
  const { record, failure } = await publishTracked(printerService, { type: 'unload', amsId: 255, trayId: 255, target: UNLOAD_TARGET, payload });
  if (failure) return failure;

  return json({
    success: true,
    commandId: record.commandId,
    status: 'SENT',
    temp,
    message: 'Đã gửi lệnh rút nhựa khỏi đầu in về bộ AMS.',
  });
});

// 4. POST /api/ams/setting - Update filament profile, color & temp limits for a tray
export const updateAmsSetting = handler(async ({ printerService, request }) => {
  assertRealPrinterMode();
  const state = printerService.stateStore.getState();

  const body = ((await readJsonBody(request)) || {}) as {
    amsId?: unknown;
    slotId?: unknown;
    trayId?: unknown;
    color?: unknown;
    type?: unknown;
    trayInfoIdx?: unknown;
    minTemp?: unknown;
    maxTemp?: unknown;
  };

  const amsId = readInt(body.amsId, 'amsId', 0);
  const slotId = readInt(body.slotId ?? body.trayId, 'slotId');
  if ((state.ams ?? []).length > 0 && !findTray(state, amsId, slotId)) {
    badRequest('TRAY_NOT_FOUND', `${trayLabel(amsId, slotId)} không tồn tại.`);
  }

  const type = typeof body.type === 'string' && body.type.trim() ? body.type.trim().toUpperCase() : null;
  if (!type) badRequest('INVALID_PARAMETER', 'Thiếu loại nhựa (type).');
  const color = typeof body.color === 'string' ? body.color.trim() : '';
  if (!/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color)) {
    badRequest('INVALID_COLOR', 'color phải là mã hex dạng #RRGGBB hoặc #RRGGBBAA.');
  }
  const trayInfoIdx = typeof body.trayInfoIdx === 'string' && body.trayInfoIdx.trim()
    ? body.trayInfoIdx.trim()
    : GENERIC_PROFILE_IDS[type];
  if (!trayInfoIdx) {
    badRequest('UNKNOWN_FILAMENT_PROFILE', `Không có profile mặc định cho ${type}; truyền trayInfoIdx (vd. "GFL99").`);
  }
  const minTemp = body.minTemp ?? 190;
  const maxTemp = body.maxTemp ?? 240;
  if (typeof minTemp !== 'number' || typeof maxTemp !== 'number' || minTemp <= 0 || maxTemp < minTemp || maxTemp > 350) {
    badRequest('INVALID_TEMPERATURE', 'minTemp/maxTemp không hợp lệ (cần 0 < minTemp ≤ maxTemp ≤ 350).');
  }

  assertNoPendingCommand(state);

  const payload = BambuCommandBuilder.buildAmsFilamentSettingPayload({
    amsId,
    slotId,
    trayInfoIdx,
    trayType: type,
    trayColor: color,
    nozzleTempMin: minTemp,
    nozzleTempMax: maxTemp,
  });
  const { record, failure } = await publishTracked(printerService, { type: 'setting', amsId, trayId: slotId, target: slotId, payload });
  if (failure) return failure;

  return json({
    success: true,
    commandId: record.commandId,
    status: 'SENT',
    message: `Đã gửi cài đặt cho ${trayLabel(amsId, slotId)} (Loại: ${type}, Màu: ${color}).`,
    amsId,
    slotId,
    trayId: slotId,
  });
});

// 5. POST /api/ams/retry - Retry AMS operation on error/tangle.
// No in-progress guard: retry is exactly what unblocks a stuck load/unload.
export const retryAms = handler(async ({ printerService }) => {
  assertRealPrinterMode();

  const payload = BambuCommandBuilder.buildAmsControlPayload('retry');
  const { record, failure } = await publishTracked(printerService, {
    type: 'retry',
    amsId: 0,
    trayId: 0,
    target: 0,
    payload,
    protocolConfidence: 'PROTOCOL_UNVERIFIED',
  });
  if (failure) return failure;

  return json({
    success: true,
    commandId: record.commandId,
    status: 'SENT',
    protocolConfidence: 'PROTOCOL_UNVERIFIED',
    message: 'Đã gửi lệnh Retry kéo/đùn nhựa AMS.',
  });
});

// 6. GET /api/ams/:amsId/tray/:trayId/rfid - Ask the printer to re-read a tray's RFID tag (Req 11)
export const getAmsTrayRfid = handler<{ amsId: string; trayId: string }>(async ({ printerService, params }) => {
  assertRealPrinterMode();
  const state = printerService.stateStore.getState();

  const amsId = Number(params.amsId);
  const slotId = Number(params.trayId);
  if (!Number.isInteger(amsId) || amsId < 0 || !Number.isInteger(slotId) || slotId < 0) {
    badRequest('INVALID_PARAMETER', 'amsId và trayId phải là số nguyên không âm.');
  }
  assertNoPendingCommand(state);

  const payload = BambuCommandBuilder.buildAmsGetRfidPayload(amsId, slotId);
  const { record, failure } = await publishTracked(printerService, { type: 'rfid', amsId, trayId: slotId, target: slotId, payload });
  if (failure) return failure;

  const targetTray = findTray(state, amsId, slotId);
  return json({
    success: true,
    commandId: record.commandId,
    // Cached values from before the re-read; poll the command, then GET /api/ams for fresh data
    rfidData: {
      amsId,
      slotId,
      tagUid: targetTray?.tagUid || null,
      uuid: targetTray?.uuid || null,
      subBrand: targetTray?.subBrand || targetTray?.subBrands || null,
      rawColor: targetTray?.rawColor || null,
    },
  });
});

// 7. GET /api/ams/debug - Protocol debug & verification endpoint (Requirement 17)
export const getAmsDebug = handler(({ printerService }) => {
  const state = printerService.stateStore.getState();
  tracker().verifyTelemetry(state);

  return json({
    connection: {
      online: state.online,
      serial: printerService.serial,
      lastMessageAt: state.lastMessageAt,
    },
    rawAms: state.rawAmsPayload || state.rawExtensions?.ams || null,
    normalizedAms: state.ams || [],
    activeNozzle: {
      activeNozzleId: state.temperatures.nozzle.activeNozzleId ?? null,
      source: 'print.nozzle.src_id',
      confidence: state.temperatures.nozzle.activeNozzleId !== null ? 'CONFIRMED' : 'POSSIBLE',
    },
    extruderSlots: state.extruders.map((e) => ({ id: e.id, snow: e.snow, spre: e.spre, star: e.star })),
    active: {
      activeTrayId: state.amsActiveTrayId ?? null,
      targetTrayId: state.amsTargetTrayId ?? null,
      currentTrayId: state.amsCurrentTrayId ?? null,
      loadedTrays: state.amsLoadedTrays ?? [],
      amsStatus: state.amsStatus ?? null,
      trayNow: state.amsTrayNow ?? null,
      trayTar: state.amsTrayTar ?? null,
      trayPre: state.amsTrayPre ?? null,
      amsExistBits: state.amsExistBits ?? null,
      trayExistBits: state.trayExistBits ?? null,
    },
    lastCommand: tracker().getLastCommand(),
    commandHistory: tracker().getAllCommands(),
    lastResponse: tracker().getLastResponse(),
    protocolEvidence: {
      loadCommand: 'CONFIRMED',
      unloadCommand: 'CONFIRMED',
      settingCommand: 'CONFIRMED',
      rfidCommand: 'CONFIRMED',
      retryCommand: 'PROTOCOL_UNVERIFIED',
    },
  });
});

// 8. GET /api/ams/command/:commandId - Check status of specific AMS command
export const getAmsCommand = handler<{ commandId: string }>(({ printerService, params }) => {
  const { commandId } = params;
  const state = printerService.stateStore.getState();
  tracker().verifyTelemetry(state);

  const record = tracker().getCommand(commandId);
  if (!record) {
    return json({
      success: false,
      error: 'COMMAND_NOT_FOUND',
      message: `AMS command with ID '${commandId}' was not found.`,
    }, 404);
  }

  return json({
    success: true,
    record,
  });
});
