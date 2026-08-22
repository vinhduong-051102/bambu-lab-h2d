import { env } from './config/env.js';
import { logger } from './logger/logger.js';
import { PrinterStateStore } from './domain/PrinterStateStore.js';
import { normalizePrinterState } from './domain/normalizePrinterState.js';
import { BambuMqttClient } from './bambu/BambuMqttClient.js';
import { BambuMessageParser } from './bambu/BambuMessageParser.js';
import { createServer } from './server/server.js';
import { BambuTopics } from './bambu/BambuTopics.js';

function maskString(str: string): string {
  if (!str) return '********';
  if (str.length <= 4) return '****';
  return str.slice(0, 4) + '*'.repeat(str.length - 4);
}

async function main(): Promise<void> {
  const maskedSerial = maskString(env.BAMBU_SERIAL);

  console.log(`
Bambu H2D Gateway
-----------------

Printer:
  Host: ${env.BAMBU_HOST}
  Port: ${env.BAMBU_PORT}
  Serial: ${maskedSerial}

MQTT:
  Status: connecting...

Web Dashboard:
  http://${env.HTTP_HOST}:${env.HTTP_PORT}

REST API:
  http://${env.HTTP_HOST}:${env.HTTP_PORT}/api/printer

WebSocket:
  ws://${env.HTTP_HOST}:${env.HTTP_PORT}/ws
`);

  // 1. Initialize Printer State Store
  const stateStore = new PrinterStateStore(env.BAMBU_SERIAL, env.PRINTER_OFFLINE_TIMEOUT_MS);

  // 2. Initialize Fastify Server
  const server = await createServer(stateStore);

  try {
    await server.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
    logger.info({ host: env.HTTP_HOST, port: env.HTTP_PORT }, 'HTTP server started');
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to start HTTP server');
    process.exit(1);
  }

  // 3. Initialize Bambu MQTT Client
  const mqttClient = new BambuMqttClient({
    host: env.BAMBU_HOST,
    port: env.BAMBU_PORT,
    serial: env.BAMBU_SERIAL,
    accessCode: env.BAMBU_ACCESS_CODE,
  });

  // Handle incoming MQTT messages
  mqttClient.onMessage((topic, message) => {
    const rawPayload = BambuMessageParser.parseJsonPayload(message);
    if (!rawPayload) {
      return;
    }

    stateStore.setRawPayload(rawPayload as Record<string, unknown>);
    const currentState = stateStore.getState();
    const nextState = normalizePrinterState(currentState, rawPayload);
    stateStore.updateState(nextState);
  });

  // Attempt connection to printer
  try {
    await mqttClient.connect();
    console.log(`
MQTT:
  Status: connected

Subscribed:
  ${BambuTopics.getReportTopic(env.BAMBU_SERIAL)}
`);
    await mqttClient.subscribeReports();
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Initial MQTT connection attempt failed. Gateway will auto-retry in background.');
  }

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Gateway...');
    stateStore.destroy();
    await mqttClient.disconnect();
    await server.close();
    logger.info('Gateway shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal error during startup');
  process.exit(1);
});
