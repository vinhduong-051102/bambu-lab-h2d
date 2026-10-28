import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createServer as createHttpsServer } from 'https';
import type { Duplex } from 'stream';
import next from 'next';
import { env } from './src/config/env';
import { logger } from './src/logger/logger';
import { startGateway } from './src/runtime/bootstrap';
import { checkAuthorization, requiresAuth } from './src/server/auth';
import { loadOrCreateCertificate } from './src/server/tls';
import { createWebSocketHub } from './src/server/websocket';

function maskString(str: string): string {
  if (!str) return '********';
  if (str.length <= 4) return '****';
  return str.slice(0, 4) + '*'.repeat(str.length - 4);
}

function printBanner(): void {
  const base = `http://${env.HTTP_HOST}:${env.HTTP_PORT}`;
  console.log(`
Bambu H2D Gateway (Next.js)
---------------------------

Printer:
  Host: ${env.BAMBU_HOST}
  Port: ${env.BAMBU_PORT}
  Serial: ${maskString(env.BAMBU_SERIAL)}
  Real Printer Mode: ${env.BAMBU_REAL_PRINTER ? 'ENABLED (Commands active)' : 'DISABLED (Read-only / Safety mode)'}

MQTT:
  Status: connecting...

Web Dashboard:
  ${base}${env.HTTPS_PORT ? `
  https://${env.HTTP_HOST}:${env.HTTPS_PORT}` : ''}

REST API Endpoints:
  - Capabilities: ${base}/api/capabilities
  - Printer State: ${base}/api/printer
  - Printer Info:  ${base}/api/printer/info
  - Printer AMS:   ${base}/api/ams
  - Audit Logs:    ${base}/api/commands

Camera Snapshot API:
  ${base}/api/camera/snapshot

WebSocket:
  ws://${env.HTTP_HOST}:${env.HTTP_PORT}/ws
`);
}

async function main(): Promise<void> {
  printBanner();

  const dev = process.env.NODE_ENV !== 'production';
  const app = next({ dev, hostname: env.HTTP_HOST, port: env.HTTP_PORT });
  await app.prepare();
  const handleRequest = app.getRequestHandler();
  const handleNextUpgrade = app.getUpgradeHandler();

  // The printer runtime must exist before any Route Handler runs
  const gateway = await startGateway();
  const wsHub = createWebSocketHub(gateway.printerService);

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');

    if (requiresAuth(pathname)) {
      const failure = checkAuthorization(req.headers);
      if (failure) {
        res.writeHead(failure.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(failure.body));
        return;
      }
    }

    handleRequest(req, res).catch((err) => {
      logger.error({ error: err instanceof Error ? err.message : String(err), url: req.url }, 'Unhandled request error');
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');

    if (pathname !== '/ws') {
      // Next.js dev server HMR and any other upgrade traffic
      handleNextUpgrade(req, socket, head);
      return;
    }

    const failure = checkAuthorization(req.headers);
    if (failure) {
      socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify(failure.body)}`);
      return;
    }

    wsHub.handleUpgrade(req, socket, head);
  };

  const servers = [createServer(onRequest)];
  if (env.HTTPS_PORT) {
    servers.push(createHttpsServer(loadOrCreateCertificate(env.HTTPS_CERT_FILE, env.HTTPS_KEY_FILE, env.HTTPS_HOSTNAMES), onRequest));
  }

  servers.forEach((server, i) => {
    const [kind, port] = i === 0 ? ['HTTP', env.HTTP_PORT] : ['HTTPS', env.HTTPS_PORT];
    server.on('upgrade', onUpgrade);
    server.listen(port, env.HTTP_HOST, () => {
      logger.info({ host: env.HTTP_HOST, port, dev }, `${kind} server started`);
    });
    server.on('error', (err) => {
      logger.error({ error: err.message }, `Failed to start ${kind} server`);
      process.exit(1);
    });
  });

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Gateway...');
    wsHub.close();
    await gateway.stop();
    servers.forEach((server) => server.close());
    await app.close();
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
