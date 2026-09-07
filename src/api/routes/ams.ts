import { FastifyInstance } from 'fastify';
import { PrinterService } from '../../domain/PrinterService.js';
import { AMSTray } from '../../domain/PrinterState.js';
import { BambuCommandBuilder } from '../../bambu/commands/BambuCommandBuilder.js';
import { AmsCommandTracker } from '../../domain/commands/AmsCommandTracker.js';

export async function amsRoutes(
  fastify: FastifyInstance,
  options: { printerService: PrinterService }
): Promise<void> {
  const { printerService } = options;
  const tracker = AmsCommandTracker.getInstance();

  // 1. GET /api/ams - Fetch current AMS state & active tray
  fastify.get('/api/ams', async () => {
    const state = printerService.stateStore.getState();
    tracker.verifyTelemetry(state);

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

    return {
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
    };
  });

  // 2. POST /api/ams/load - Load specified tray index (0..3) with Idempotency Guard (Req 15)
  fastify.post('/api/ams/load', async (request, reply) => {
    // Idempotency Check: Reject concurrent commands if another AMS action is in progress
    const pendingCmd = tracker.getActiveCommand();
    if (pendingCmd) {
      return reply.status(409).send({
        success: false,
        error: 'AMS_COMMAND_IN_PROGRESS',
        commandId: pendingCmd.commandId,
        message: `Thao tác AMS (${pendingCmd.type}) đang được thực hiện. Vui lòng chờ lệnh hoàn tất.`,
      });
    }

    const body = (request.body || {}) as { amsId?: number; trayId?: number; target?: number; temp?: number };
    const amsId = typeof body.amsId === 'number' ? body.amsId : 0;
    const trayId = typeof body.trayId === 'number' ? body.trayId : (typeof body.target === 'number' ? body.target : 0);
    const target = trayId;
    const temp = typeof body.temp === 'number' ? body.temp : 220;

    const payload = BambuCommandBuilder.buildAmsChangeFilamentPayload(target, temp, temp);
    const record = tracker.createCommand({
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
        tracker.markSent(record.commandId);
      } else {
        tracker.markFailed(record.commandId, 'MQTT client failed to publish payload');
        return reply.status(503).send({
          success: false,
          commandId: record.commandId,
          status: 'FAILED',
          error: 'MQTT_DISCONNECTED',
          message: 'Không thể gửi lệnh MQTT tới máy in (MQTT disconnected).',
        });
      }
    }

    return reply.send({
      success: true,
      commandId: record.commandId,
      status: 'SENT',
      target,
      message: `Đã gửi lệnh nạp nhựa từ AMS khay #${target} (Nhiệt độ ${temp}°C).`,
    });
  });

  // 3. POST /api/ams/unload - Unload active filament (target 255)
  fastify.post('/api/ams/unload', async (_request, reply) => {
    const pendingCmd = tracker.getActiveCommand();
    if (pendingCmd) {
      return reply.status(409).send({
        success: false,
        error: 'AMS_COMMAND_IN_PROGRESS',
        commandId: pendingCmd.commandId,
        message: `Thao tác AMS (${pendingCmd.type}) đang được thực hiện. Vui lòng chờ lệnh hoàn tất.`,
      });
    }

    const payload = BambuCommandBuilder.buildAmsChangeFilamentPayload(255, 220, 220);
    const record = tracker.createCommand({
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
        tracker.markSent(record.commandId);
      } else {
        tracker.markFailed(record.commandId, 'MQTT client failed to publish payload');
        return reply.status(503).send({
          success: false,
          commandId: record.commandId,
          status: 'FAILED',
          error: 'MQTT_DISCONNECTED',
          message: 'Không thể gửi lệnh MQTT rút nhựa (MQTT disconnected).',
        });
      }
    }

    return reply.send({
      success: true,
      commandId: record.commandId,
      status: 'SENT',
      message: 'Đã gửi lệnh rút nhựa khỏi đầu in về bộ AMS.',
    });
  });

  // 4. POST /api/ams/setting - Update filament color, type & temp limits for a tray
  fastify.post('/api/ams/setting', async (request, reply) => {
    const body = (request.body || {}) as {
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

    const record = tracker.createCommand({
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
        tracker.markSent(record.commandId);
      } else {
        tracker.markFailed(record.commandId, 'MQTT client failed to publish payload');
      }
    }

    return reply.send({
      success: true,
      commandId: record.commandId,
      status: 'SENT',
      message: `Đã cập nhật thông tin khay AMS #${trayId} (Loại: ${type}, Màu: ${color}).`,
      amsId,
      trayId,
    });
  });

  // 5. POST /api/ams/retry - Retry AMS operation on error/tangle
  fastify.post('/api/ams/retry', async (_request, reply) => {
    const payload = BambuCommandBuilder.buildAmsControlPayload('retry');
    const record = tracker.createCommand({
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
        tracker.markSent(record.commandId);
      } else {
        tracker.markFailed(record.commandId, 'MQTT client failed to publish payload');
      }
    }

    return reply.send({
      success: true,
      commandId: record.commandId,
      status: 'SENT',
      protocolConfidence: 'PROTOCOL_UNVERIFIED',
      message: 'Đã gửi lệnh Retry kéo/đùn nhựa AMS.',
    });
  });

  // 6. GET /api/ams/:amsId/tray/:trayId/rfid - Fetch RFID info for specified slot (Req 11)
  fastify.get('/api/ams/:amsId/tray/:trayId/rfid', async (request, reply) => {
    const { amsId: amsIdStr, trayId: trayIdStr } = request.params as { amsId: string; trayId: string };
    const amsId = parseInt(amsIdStr, 10) || 0;
    const slotId = parseInt(trayIdStr, 10) || 0;

    const payload = BambuCommandBuilder.buildAmsGetRfidPayload(amsId, slotId);
    const record = tracker.createCommand({
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
        tracker.markSent(record.commandId);
      }
    }

    const state = printerService.stateStore.getState();
    const targetUnit = (state.ams || []).find((u) => u.id === String(amsId));
    const targetTray = targetUnit?.trays.find((t) => t.id === String(slotId));

    return reply.send({
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
  fastify.get('/api/ams/debug', async () => {
    const state = printerService.stateStore.getState();
    tracker.verifyTelemetry(state);

    const lastCommand = tracker.getLastCommand();
    const lastResponse = tracker.getLastResponse();
    const commandHistory = tracker.getAllCommands();

    return {
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
    };
  });

  // 8. GET /api/ams/command/:commandId - Check status of specific AMS command
  fastify.get('/api/ams/command/:commandId', async (request, reply) => {
    const { commandId } = request.params as { commandId: string };
    const state = printerService.stateStore.getState();
    tracker.verifyTelemetry(state);

    const record = tracker.getCommand(commandId);
    if (!record) {
      return reply.status(404).send({
        success: false,
        error: 'COMMAND_NOT_FOUND',
        message: `AMS command with ID '${commandId}' was not found.`,
      });
    }

    return reply.send({
      success: true,
      record,
    });
  });
}
