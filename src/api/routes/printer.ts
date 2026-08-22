import { FastifyInstance } from 'fastify';
import { PrinterService } from '../../domain/PrinterService.js';
import { PrinterManager } from '../../domain/PrinterManager.js';

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

  // 1. GET /api/printer - Standard State Endpoint
  fastify.get('/api/printer', async (request, reply) => {
    const service = getService();
    if (!service) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'No printer registered' });
    }
    return service.stateStore.getState();
  });

  // 2. GET /api/printer/info - System Info (NO Access Code exposed)
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
      updatedAt: state.updatedAt,
    };
  });

  // 3. GET /api/printer/errors - HMS & System Error Codes
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

  // 4. GET /api/printers - Multi-Printer List
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

  // 5. GET /api/printers/:serial - Get specific printer by Serial
  fastify.get('/api/printers/:serial', async (request, reply) => {
    const { serial } = request.params as { serial: string };
    const service = getService(serial);
    if (!service) {
      return reply.status(404).send({ error: 'Not Found', message: `Printer with serial '${serial}' not found` });
    }
    return service.stateStore.getState();
  });
}
