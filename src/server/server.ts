import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { PrinterService } from '../domain/PrinterService.js';
import { PrinterManager } from '../domain/PrinterManager.js';
import { authenticateRequest } from './auth.js';

import { healthRoutes } from '../api/routes/health.js';
import { capabilitiesRoutes } from '../api/routes/capabilities.js';
import { printerRoutes } from '../api/routes/printer.js';
import { printRoutes } from '../api/routes/print.js';
import { temperatureRoutes } from '../api/routes/temperature.js';
import { fanRoutes } from '../api/routes/fans.js';
import { amsRoutes } from '../api/routes/ams.js';
import { fileRoutes } from '../api/routes/files.js';
import { commandRoutes } from '../api/routes/commands.js';
import { cameraRoutes } from '../api/routes/camera.js';
import { websocketRoutes } from '../api/websocket.js';

export async function createServer(
  printerService: PrinterService,
  printerManager?: PrinterManager
): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: false, // We use central Pino logger for custom logging
  });

  await fastify.register(cors, {
    origin: '*',
  });

  await fastify.register(websocket);

  await fastify.register(fastifyStatic, {
    root: path.resolve(process.cwd(), 'public'),
    prefix: '/',
  });

  // Attach Gateway API Key Authentication Hook
  fastify.addHook('preHandler', authenticateRequest);

  // Register All REST API & WebSocket Routes
  await fastify.register(healthRoutes);
  await fastify.register(capabilitiesRoutes, { capabilityRegistry: printerService.capabilityRegistry });
  await fastify.register(printerRoutes, { printerService, printerManager });
  await fastify.register(printRoutes, { printerService });
  await fastify.register(temperatureRoutes, { printerService });
  await fastify.register(fanRoutes, { printerService });
  await fastify.register(amsRoutes, { printerService });
  await fastify.register(fileRoutes);
  await fastify.register(commandRoutes, { printerService });

  if (printerService.cameraService) {
    await fastify.register(cameraRoutes, { cameraService: printerService.cameraService });
  }

  await fastify.register(websocketRoutes, { printerService });

  return fastify;
}
