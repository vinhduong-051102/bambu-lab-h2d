import { AMSTray } from '../../domain/PrinterState';
import { BambuCommandBuilder } from '../../bambu/commands/BambuCommandBuilder';
import { AmsCommandTracker } from '../../domain/commands/AmsCommandTracker';
import { handler, json, readJsonBody } from '../http';

const tracker = () => AmsCommandTracker.getInstance();

// 1. GET /api/ams - Fetch current AMS state & active tray
export const getAms = handler(({ printerService }) => {
  const state = printerService.stateStore.getState();
  tracker().verifyTelemetry(state);

  const amsList = state.ams || [];

  const normalizedUnits = amsList.map((unit) => {
    const trays = (unit.trays || []).map((fil: AMSTray) => ({
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
      state: fil.state ?? null,
      isActive: fil.isActive ?? false,
      isTarget: fil.isTarget ?? false,
      isEmpty: fil.isEmpty ?? false,
      isLoaded: fil.isLoaded ?? false,
    }));

    return {
      id: unit.id,
      temperature: unit.temperature ?? null,
      humidity: unit.humidity ?? null,
      humidityRaw: unit.humidityRaw ?? null,
      status: unit.status ?? null,
      trays,
      activeTrayId: unit.activeTrayId ?? null,
      targetTrayId: unit.targetTrayId ?? null,
      currentTrayId: unit.currentTrayId ?? null,
      exists: unit.exists ?? true,
    };
  });

  return json({
    units: normalizedUnits,
    activeTrayId: state.amsActiveTrayId ?? null,
    targetTrayId: state.amsTargetTrayId ?? null,
    currentTrayId: state.amsCurrentTrayId ?? null,
    trayNow: state.amsTrayNow ?? null,
    trayTar: state.amsTrayTar ?? null,
    trayPre: state.amsTrayPre ?? null,
    amsExistBits: state.amsExistBits ?? null,
    trayExistBits: state.trayExistBits ?? null,
    trayIsBblBits: state.trayIsBblBits ?? null,
  });
});

// 2. POST /api/ams/load - Load specified tray index (0..3) with Idempotency Guard (Req 15)
export const loadAms = handler(async ({ printerService, request }) => {
  // Idempotency Check: Reject concurrent commands if another AMS action is in progress
  const pendingCmd = tracker().getActiveCommand();
  if (pendingCmd) {
    return json({
      success: false,
      error: 'AMS_COMMAND_IN_PROGRESS',
      commandId: pendingCmd.commandId,
      message: `Thao tác AMS (${pendingCmd.type}) đang được thực hiện. Vui lòng chờ lệnh hoàn tất.`,
    }, 409);
  }

  const body = ((await readJsonBody(request)) || {}) as { amsId?: number; trayId?: number; target?: number; temp?: number };
  const amsId = typeof body.amsId === 'number' ? body.amsId : 0;
  const trayId = typeof body.trayId === 'number' ? body.trayId : (typeof body.target === 'number' ? body.target : 0);
  const target = trayId;
  const temp = typeof body.temp === 'number' ? body.temp : 220;

  const payload = BambuCommandBuilder.buildAmsChangeFilamentPayload(target, temp, temp);
  const record = tracker().createCommand({
    type: 'load',
    amsId,
    trayId,
    target,
    rawRequest: payload,
    protocolConfidence: 'CONFIRMED',
    serial: printerService.serial,
  });

  if (printerService.mqttClient) {
    const published = await printerService.mqttClient.publishRequest(payload);
    if (published) {
      tracker().markSent(record.commandId);
    } else {
      tracker().markFailed(record.commandId, 'MQTT client failed to publish payload');
      return json({
        success: false,
        commandId: record.commandId,
        status: 'FAILED',
        error: 'MQTT_DISCONNECTED',
        message: 'Không thể gửi lệnh MQTT tới máy in (MQTT disconnected).',
      }, 503);
    }
  }

  return json({
    success: true,
    commandId: record.commandId,
    status: 'SENT',
    target,
    message: `Đã gửi lệnh nạp nhựa từ AMS khay #${target} (Nhiệt độ ${temp}°C).`,
  });
});

// 3. POST /api/ams/unload - Unload active filament (target 255)
export const unloadAms = handler(async ({ printerService }) => {
  const pendingCmd = tracker().getActiveCommand();
  if (pendingCmd) {
    return json({
      success: false,
      error: 'AMS_COMMAND_IN_PROGRESS',
      commandId: pendingCmd.commandId,
      message: `Thao tác AMS (${pendingCmd.type}) đang được thực hiện. Vui lòng chờ lệnh hoàn tất.`,
    }, 409);
  }

  const payload = BambuCommandBuilder.buildAmsChangeFilamentPayload(255, 220, 220);
  const record = tracker().createCommand({
    type: 'unload',
    amsId: 0,
    trayId: 255,
    target: 255,
    rawRequest: payload,
    protocolConfidence: 'CONFIRMED',
    serial: printerService.serial,
  });

  if (printerService.mqttClient) {
    const published = await printerService.mqttClient.publishRequest(payload);
    if (published) {
      tracker().markSent(record.commandId);
    } else {
      tracker().markFailed(record.commandId, 'MQTT client failed to publish payload');
      return json({
        success: false,
        commandId: record.commandId,
        status: 'FAILED',
        error: 'MQTT_DISCONNECTED',
        message: 'Không thể gửi lệnh MQTT rút nhựa (MQTT disconnected).',
      }, 503);
    }
  }

  return json({
    success: true,
    commandId: record.commandId,
    status: 'SENT',
    message: 'Đã gửi lệnh rút nhựa khỏi đầu in về bộ AMS.',
  });
});

// 4. POST /api/ams/setting - Update filament color, type & temp limits for a tray
export const updateAmsSetting = handler(async ({ printerService, request }) => {
  const body = ((await readJsonBody(request)) || {}) as {
    amsId?: number;
    trayId?: number;
    color?: string;
    type?: string;
    minTemp?: number;
    maxTemp?: number;
  };

  const amsId = body.amsId ?? 0;
  const trayId = body.trayId ?? 0;
  const color = body.color || '#3B82F6';
  const type = body.type || 'PLA';
  const minTemp = body.minTemp ?? 190;
  const maxTemp = body.maxTemp ?? 240;

  const payload = BambuCommandBuilder.buildAmsFilamentSettingPayload(
    amsId,
    trayId,
    type,
    color,
    minTemp,
    maxTemp,
    type
  );

  const record = tracker().createCommand({
    type: 'setting',
    amsId,
    trayId,
    target: trayId,
    rawRequest: payload,
    protocolConfidence: 'CONFIRMED',
    serial: printerService.serial,
  });

  if (printerService.mqttClient) {
    const published = await printerService.mqttClient.publishRequest(payload);
    if (published) {
      tracker().markSent(record.commandId);
    } else {
      tracker().markFailed(record.commandId, 'MQTT client failed to publish payload');
    }
  }

  return json({
    success: true,
    commandId: record.commandId,
    status: 'SENT',
    message: `Đã cập nhật thông tin khay AMS #${trayId} (Loại: ${type}, Màu: ${color}).`,
    amsId,
    trayId,
  });
});

// 5. POST /api/ams/retry - Retry AMS operation on error/tangle
export const retryAms = handler(async ({ printerService }) => {
  const payload = BambuCommandBuilder.buildAmsControlPayload('retry');
  const record = tracker().createCommand({
    type: 'retry',
    amsId: 0,
    trayId: 0,
    target: 0,
    rawRequest: payload,
    protocolConfidence: 'PROTOCOL_UNVERIFIED',
    serial: printerService.serial,
  });

  if (printerService.mqttClient) {
    const published = await printerService.mqttClient.publishRequest(payload);
    if (published) {
      tracker().markSent(record.commandId);
    } else {
      tracker().markFailed(record.commandId, 'MQTT client failed to publish payload');
    }
  }

  return json({
    success: true,
    commandId: record.commandId,
    status: 'SENT',
    protocolConfidence: 'PROTOCOL_UNVERIFIED',
    message: 'Đã gửi lệnh Retry kéo/đùn nhựa AMS.',
  });
});

// 6. GET /api/ams/:amsId/tray/:trayId/rfid - Fetch RFID info for specified slot (Req 11)
export const getAmsTrayRfid = handler<{ amsId: string; trayId: string }>(async ({ printerService, params }) => {
  const { amsId: amsIdStr, trayId: trayIdStr } = params;
  const amsId = parseInt(amsIdStr, 10) || 0;
  const slotId = parseInt(trayIdStr, 10) || 0;

  const payload = BambuCommandBuilder.buildAmsGetRfidPayload(amsId, slotId);
  const record = tracker().createCommand({
    type: 'rfid',
    amsId,
    trayId: slotId,
    target: slotId,
    rawRequest: payload,
    protocolConfidence: 'CONFIRMED',
    serial: printerService.serial,
  });

  if (printerService.mqttClient) {
    const published = await printerService.mqttClient.publishRequest(payload);
    if (published) {
      tracker().markSent(record.commandId);
    }
  }

  const state = printerService.stateStore.getState();
  const targetUnit = (state.ams || []).find((u) => u.id === String(amsId));
  const targetTray = targetUnit?.trays.find((t) => t.id === String(slotId));

  return json({
    success: true,
    commandId: record.commandId,
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

  const lastCommand = tracker().getLastCommand();
  const lastResponse = tracker().getLastResponse();
  const commandHistory = tracker().getAllCommands();

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
    active: {
      activeTrayId: state.amsActiveTrayId ?? null,
      targetTrayId: state.amsTargetTrayId ?? null,
      currentTrayId: state.amsCurrentTrayId ?? null,
      trayNow: state.amsTrayNow ?? null,
      trayTar: state.amsTrayTar ?? null,
      trayPre: state.amsTrayPre ?? null,
      amsExistBits: state.amsExistBits ?? null,
      trayExistBits: state.trayExistBits ?? null,
    },
    lastCommand,
    commandHistory,
    lastResponse,
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
