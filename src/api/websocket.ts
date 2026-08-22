import { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import { PrinterStateStore } from '../domain/PrinterStateStore.js';
import { logger } from '../logger/logger.js';

export async function websocketRoutes(
  fastify: FastifyInstance,
  options: { stateStore: PrinterStateStore }
): Promise<void> {
  const { stateStore } = options;
  const connectedClients = new Set<WebSocket>();

  // Subscribe to printer state updates to broadcast to active clients
  stateStore.subscribe((state) => {
    const payload = JSON.stringify({
      type: 'printer.state',
      data: state,
    });

    for (const client of connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  });

  // Subscribe to printer connection changes
  stateStore.subscribeConnection((online) => {
    const payload = JSON.stringify({
      type: 'printer.connection',
      data: { online },
    });

    for (const client of connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  });

  fastify.get('/ws', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    connectedClients.add(socket);
    logger.info({ remoteAddress: req.ip }, 'WebSocket client connected');

    // 1. Send current state immediately on connection
    const initialStatePayload = JSON.stringify({
      type: 'printer.state',
      data: stateStore.getState(),
    });
    socket.send(initialStatePayload);

    socket.on('close', () => {
      connectedClients.delete(socket);
      logger.info('WebSocket client disconnected');
    });

    socket.on('error', (err: Error) => {
      connectedClients.delete(socket);
      logger.error({ error: err.message }, 'WebSocket client error');
    });
  });
}
