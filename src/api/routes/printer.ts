import { FastifyInstance } from 'fastify';
import { PrinterStateStore } from '../../domain/PrinterStateStore.js';
import { env } from '../../config/env.js';

export async function printerRoutes(
  fastify: FastifyInstance,
  options: { stateStore: PrinterStateStore }
): Promise<void> {
  const { stateStore } = options;

  fastify.get('/api/printer', async () => {
    return stateStore.getState();
  });

  fastify.get('/api/printer/raw', async (request, reply) => {
    if (!env.ENABLE_RAW_API) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Raw API is disabled via ENABLE_RAW_API environment variable',
      });
    }

    const raw = stateStore.getRawPayload();
    if (!raw) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No raw MQTT payload has been received yet',
      });
    }

    return raw;
  });
}
