import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'http';
import net from 'net';
import type { Duplex } from 'stream';
import { logger } from '../logger/logger';

/**
 * text-to-cad's CAD Viewer on a port of its own (CAD_VIEWER_PORT, docs/text-to-cad.md). The viewer is cadgen's engine
 * in the CAD container, which serves only loopback names (a DNS-rebinding guard) and every page only with its token:
 * the container forwards its loopback port to CAD_VIEWER_UPSTREAM, and this passes every request and upgrade on with
 * the Host set to a loopback name. The token stays the engine's: a page opens only from a link the dashboard asks
 * the worker for (POST /api/cad/jobs/:id/viewer). A port of its own because the viewer's page and routes are at the
 * root of its origin.
 */

/** The headers a request goes on with: the same, its Host a loopback name the engine admits */
export function viewerHeaders(headers: IncomingMessage['headers'], upstream: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = value;
  }
  out.host = `127.0.0.1:${upstream.port || 80}`;
  return out;
}

export function createCadViewerProxy(upstreamUrl: string) {
  const upstream = new URL(upstreamUrl);
  const port = Number(upstream.port || 80);

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const forward = httpRequest(
      { host: upstream.hostname, port, method: req.method, path: req.url, headers: viewerHeaders(req.headers, upstream) },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
        answer.pipe(res);
      }
    );
    forward.on('error', (err) => {
      logger.warn({ error: err.message, url: req.url }, 'CAD Viewer unreachable');
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('CAD Viewer (container cad) không trả lời: kiểm tra docker-compose.cad.yml.');
      } else {
        res.destroy();
      }
    });
    req.pipe(forward);
  };

  /** An upgrade (a WebSocket) as raw bytes both ways, after its request line and headers with the Host set */
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = net.connect(port, upstream.hostname, () => {
      const headers = viewerHeaders(req.headers, upstream);
      const lines = Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${name}: ${v}`));
      target.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    const close = () => {
      target.destroy();
      socket.destroy();
    };
    target.on('error', close);
    socket.on('error', close);
  };

  return { onRequest, onUpgrade };
}
