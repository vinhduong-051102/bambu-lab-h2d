import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { logger } from '../logger/logger.js';
import { PrinterStateStore } from '../domain/PrinterStateStore.js';
import { BambuCameraService } from '../bambu/BambuCameraService.js';
import { healthRoutes } from '../api/routes/health.js';
import { printerRoutes } from '../api/routes/printer.js';
import { cameraRoutes } from '../api/routes/camera.js';
import { websocketRoutes } from '../api/websocket.js';

export async function createServer(
  stateStore: PrinterStateStore,
  cameraService?: BambuCameraService
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

  await fastify.register(healthRoutes);
  await fastify.register(printerRoutes, { stateStore });
  if (cameraService) {
    await fastify.register(cameraRoutes, { cameraService });
  }
  await fastify.register(websocketRoutes, { stateStore });

  return fastify;
}


