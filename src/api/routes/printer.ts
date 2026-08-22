import { FastifyInstance } from 'fastify';
import { PrinterService } from '../../domain/PrinterService.js';
import { PrinterManager } from '../../domain/PrinterManager.js';
import { env } from '../../config/env.js';
import { discoverTemperatureFields } from '../../utils/temperatureDiscovery.js';

export async function printerRoutes(
  fastify: FastifyInstance,
  options: { printerService?: PrinterService; printerManager?: PrinterManager }
): Promise<void> {
  const getService = (serial?: string): PrinterService | undefined => {
    if (options.printerManager) {
      return options.printerManager.getPrinter(serial);
    }
    return options.printerService;
  };

  // Helper handler for diagnostics
  const handleDiagnostics = async (serial?: string) => {
    const service = getService(serial);
    if (!service) {
      return { error: 'Service Unavailable', message: 'No printer registered' };
    }
    const state = service.stateStore.getState();
    const rawPayload = service.stateStore.getRawPayload();

    const tempCandidates = rawPayload?.print
      ? discoverTemperatureFields(rawPayload.print, 'print').map((candidate) => {
          let semantic = 'unknown';
          if (candidate.path.includes('extruder')) semantic = 'extruder';
          else if (candidate.path.includes('nozzle')) semantic = 'nozzle';
          else if (candidate.path.includes('bed')) semantic = 'bed';
          else if (candidate.path.includes('ctc') || candidate.path.includes('chamber')) semantic = 'chamber';
          else if (candidate.path.includes('ams')) semantic = 'ams';

          return {
            path: candidate.path,
            value: candidate.value,
            confidence: candidate.path.includes('extruder') || candidate.path.includes('bed') ? 'CONFIRMED' : 'POSSIBLE',
            semantic,
          };
        })
      : [];

    return {
      nozzleCount: state.temperatures.nozzles.length,
      extruderCount: state.extruders.length,
      activeNozzleId: state.temperatures.nozzle.activeNozzleId ?? null,
      machineNozzleTemperature: state.temperatures.nozzle,
      nozzles: state.temperatures.nozzles,
      extruders: state.extruders,
      temperatureCandidates: tempCandidates,
      rawPayload,
      historyDiffs: service.stateStore.getPayloadHistory(),
    };
  };

  // 1. GET /api/printer - Standard State Endpoint
  fastify.get('/api/printer', async (request, reply) => {
    const service = getService();
    if (!service) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'No printer registered' });
    }
    return {
      ...service.stateStore.getState(),
      realPrinterMode: env.BAMBU_REAL_PRINTER,
    };
  });

  // 2. GET /api/printer/diagnostics - Diagnostic Endpoint
  fastify.get('/api/printer/diagnostics', async (request, reply) => {
    const result = await handleDiagnostics();
    if ('error' in result) {
      return reply.status(503).send(result);
    }
    return result;
  });

  // 3. GET /api/printer/:serial/diagnostics - Serial Diagnostic Endpoint
  fastify.get('/api/printer/:serial/diagnostics', async (request, reply) => {
    const { serial } = request.params as { serial: string };
    const result = await handleDiagnostics(serial);
    if ('error' in result) {
      return reply.status(404).send(result);
    }
    return result;
  });

  // 4. GET /api/printer/info - System Info
  fastify.get('/api/printer/info', async (request, reply) => {
    const service = getService();
    if (!service) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'No printer registered' });
    }
    const state = service.stateStore.getState();

    return {
      model: state.model || 'Bambu Lab H2D',
      serial: state.serial,
      firmware: state.firmware || 'Unknown',
      online: state.online,
      realPrinterMode: env.BAMBU_REAL_PRINTER,
      updatedAt: state.updatedAt,
    };
  });

  // 5. GET /api/printer/raw - Get Raw MQTT JSON Payload
  fastify.get('/api/printer/raw', async (request, reply) => {
    const service = getService();
    if (!service) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'No printer registered' });
    }
    const rawPayload = service.stateStore.getRawPayload();
    return {
      serial: service.serial,
      hasRawPayload: rawPayload !== null,
      rawPayload,
    };
  });

  // 6. GET /api/printer/errors - HMS & System Error Codes
  fastify.get('/api/printer/errors', async (request, reply) => {
    const service = getService();
    if (!service) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'No printer registered' });
    }
    const state = service.stateStore.getState();

    return {
      serial: state.serial,
      online: state.online,
      hmsErrors: state.hmsErrors || [],
      errorState: state.state === 'FAILED',
    };
  });

  // 7. GET /api/printers - Multi-Printer List
  fastify.get('/api/printers', async () => {
    if (options.printerManager) {
      const all = options.printerManager.getAllPrinters();
      return {
        count: all.length,
        printers: all.map((p) => {
          const state = p.stateStore.getState();
          return {
            serial: p.serial,
            model: state.model || 'Bambu Lab H2D',
            online: state.online,
            state: state.state,
          };
        }),
      };
    }

    const service = options.printerService;
    if (!service) {
      return { count: 0, printers: [] };
    }
    const state = service.stateStore.getState();
    return {
      count: 1,
      printers: [
        {
          serial: service.serial,
          model: state.model || 'Bambu Lab H2D',
          online: state.online,
          state: state.state,
        },
      ],
    };
  });

  // 8. GET /api/printers/:serial - Get specific printer by Serial
  fastify.get('/api/printers/:serial', async (request, reply) => {
    const { serial } = request.params as { serial: string };
    const service = getService(serial);
    if (!service) {
      return reply.status(404).send({ error: 'Not Found', message: `Printer with serial '${serial}' not found` });
    }
    return service.stateStore.getState();
  });
}
