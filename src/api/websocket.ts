import { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import { PrinterService } from '../domain/PrinterService.js';
import { PrinterStateStore } from '../domain/PrinterStateStore.js';
import { logger } from '../logger/logger.js';

export async function websocketRoutes(
  fastify: FastifyInstance,
  options: { stateStore?: PrinterStateStore; printerService?: PrinterService }
): Promise<void> {
  const stateStore = options.printerService ? options.printerService.stateStore : options.stateStore!;
  const commandService = options.printerService ? options.printerService.commandService : undefined;
  const connectedClients = new Set<WebSocket>();

  const broadcast = (type: string, data: unknown) => {
    const payload = JSON.stringify({ type, data });
    for (const client of connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  };

  // 1. Telemetry State Broadcast
  stateStore.subscribe((state) => {
    broadcast('printer.state', state);

    // Fine-grained sub-events
    broadcast('printer.temperature', state.temperatures);
    broadcast('printer.progress', {
      progress: state.progress,
      job: state.job,
    });
    broadcast('printer.ams', state.ams);
    if (state.hmsErrors && state.hmsErrors.length > 0) {
      broadcast('printer.error', { hmsErrors: state.hmsErrors });
    }
  });

  // 2. Connection State Broadcast
  stateStore.subscribeConnection((online) => {
    broadcast('printer.connection', { online });
  });

  // 3. Command Execution Events Broadcast
  if (commandService) {
    commandService.on('command.started', (data) => {
      broadcast('command.started', data);
    });

    commandService.on('command.completed', (data) => {
      broadcast('command.completed', data);
    });

    commandService.on('command.failed', (data) => {
      broadcast('command.failed', data);
    });
  }

  // WebSocket /ws Endpoint Handler
  fastify.get('/ws', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    connectedClients.add(socket);
    logger.info({ remoteAddress: req.ip }, 'WebSocket client connected');

    // Send initial state frame on connect
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
