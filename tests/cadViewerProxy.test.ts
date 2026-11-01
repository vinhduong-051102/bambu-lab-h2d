import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { createCadViewerProxy, viewerHeaders } from '../src/server/cadViewerProxy';

/** The CAD container's forward of cadgen's engine, which admits only loopback Host names (a DNS-rebinding guard) */
function fakeEngine(): Promise<Server> {
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Host is not a local name' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'cad=1; Path=/' });
      res.end(JSON.stringify({ method: req.method, url: req.url, cookie: req.headers.cookie ?? null, body }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('CAD Viewer port (text-to-cad)', () => {
  const servers: Server[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));

  it('passes requests on with a loopback Host, keeping the rest', async () => {
    const engine = await fakeEngine();
    servers.push(engine);
    const upstream = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
    const viewer = createCadViewerProxy(upstream);
    const front = createServer(viewer.onRequest);
    servers.push(front);
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;

    // As a browser on the LAN would send it: the dashboard's own host name
    const res = await fetch(`${base}/doc-1?token=1.abc`, { headers: { Host: 'printer.lan:3444', Cookie: 'cad=1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBe('cad=1; Path=/');
    expect(await res.json()).toEqual({ method: 'GET', url: '/doc-1?token=1.abc', cookie: 'cad=1', body: '' });

    const posted = await fetch(`${base}/__cad/api/x`, { method: 'POST', body: '{"a":1}' });
    expect((await posted.json()).body).toBe('{"a":1}');
  });

  it('answers 502 when the container does not', async () => {
    const viewer = createCadViewerProxy('http://127.0.0.1:1');
    const front = createServer(viewer.onRequest);
    servers.push(front);
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
    const res = await fetch(`http://127.0.0.1:${(front.address() as AddressInfo).port}/`);
    expect(res.status).toBe(502);
  });

  it('rewrites only the Host header', () => {
    const headers = viewerHeaders({ host: 'printer.lan:3444', origin: 'https://printer.lan:3444', 'sec-fetch-site': 'same-origin' }, new URL('http://bambu-cad:8001'));
    expect(headers).toEqual({ host: '127.0.0.1:8001', origin: 'https://printer.lan:3444', 'sec-fetch-site': 'same-origin' });
  });
});
