import { FastifyInstance } from 'fastify';
import { PrinterService } from '../../domain/PrinterService.js';
import { AMSTray } from '../../domain/PrinterState.js';
import { BambuCommandBuilder } from '../../bambu/commands/BambuCommandBuilder.js';

export async function amsRoutes(
  fastify: FastifyInstance,
  options: { printerService: PrinterService }
): Promise<void> {
  const { printerService } = options;

  // GET /api/ams - Fetch current AMS state & active tray
  fastify.get('/api/ams', async () => {
    const state = printerService.stateStore.getState();
    const amsList = state.ams || [];

    const normalizedUnits = amsList.map((unit) => {
      const trays = (unit.trays || []).map((fil: AMSTray, idx: number) => ({
        id: idx,
        filamentType: fil.type || 'UNKNOWN',
        color: fil.color ? (fil.color.startsWith('#') ? fil.color : `#${fil.color}`) : '#FFFFFF',
        remaining: fil.remain ?? null,
      }));

      return {
        id: unit.id,
        trays,
      };
    });

    return {
      units: normalizedUnits,
      activeTrayId: state.amsActiveTrayId ?? null,
    };
  });

  // POST /api/ams/load - Load specified tray index (0..3) or custom target
  fastify.post('/api/ams/load', async (request, reply) => {
    const body = (request.body || {}) as { target?: number; temp?: number };
    const target = typeof body.target === 'number' ? body.target : 0;
    const temp = typeof body.temp === 'number' ? body.temp : 220;

    const payload = BambuCommandBuilder.buildAmsChangeFilamentPayload(target, temp, temp);
    if (printerService.mqttClient) {
      await printerService.mqttClient.publishRequest(payload);
    }

    return reply.send({
      success: true,
      message: `Đã gửi lệnh nạp nhựa từ AMS khay #${target} (Nhiệt độ ${temp}°C).`,
      target,
    });
  });

  // POST /api/ams/unload - Unload active filament (target 255)
  fastify.post('/api/ams/unload', async (_request, reply) => {
    const payload = BambuCommandBuilder.buildAmsChangeFilamentPayload(255, 220, 220);
    if (printerService.mqttClient) {
      await printerService.mqttClient.publishRequest(payload);
    }

    return reply.send({
      success: true,
      message: 'Đã gửi lệnh rút nhựa khỏi đầu in về bộ AMS.',
    });
  });

  // POST /api/ams/setting - Update filament color, type & temp limits for a tray
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
      maxTemp
    );

    if (printerService.mqttClient) {
      await printerService.mqttClient.publishRequest(payload);
    }

    return reply.send({
      success: true,
      message: `Đã cập nhật thông tin khay AMS #${trayId} (Loại: ${type}, Màu: ${color}).`,
      amsId,
      trayId,
    });
  });

  // POST /api/ams/retry - Retry AMS operation on error/tangle
  fastify.post('/api/ams/retry', async (_request, reply) => {
    const payload = BambuCommandBuilder.buildAmsControlPayload('retry');
    if (printerService.mqttClient) {
      await printerService.mqttClient.publishRequest(payload);
    }

    return reply.send({
      success: true,
      message: 'Đã gửi lệnh Retry kéo/đùn nhựa AMS.',
    });
  });
}
