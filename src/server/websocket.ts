import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { PrinterService } from '../domain/PrinterService';
import { logger } from '../logger/logger';

/**
 * Real-time event stream on /ws. Next.js Route Handlers cannot accept WebSocket upgrades,
 * so the custom server hands /ws upgrades to this hub.
 */
export function createWebSocketHub(printerService: PrinterService) {
  const { stateStore, commandService } = printerService;
  const wss = new WebSocketServer({ noServer: true });

  const broadcast = (type: string, data: unknown) => {
    const payload = JSON.stringify({ type, data });
    for (const client of wss.clients) {
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
  commandService.on('command.started', (data) => broadcast('command.started', data));
  commandService.on('command.completed', (data) => broadcast('command.completed', data));
  commandService.on('command.failed', (data) => broadcast('command.failed', data));

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    logger.info({ remoteAddress: req.socket.remoteAddress }, 'WebSocket client connected');

    // Send initial state frame on connect
    socket.send(JSON.stringify({ type: 'printer.state', data: stateStore.getState() }));

    socket.on('close', () => {
      logger.info('WebSocket client disconnected');
    });

    socket.on('error', (err: Error) => {
      logger.error({ error: err.message }, 'WebSocket client error');
    });
  });

  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
