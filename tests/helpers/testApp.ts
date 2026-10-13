import type { PrinterService } from '../../src/domain/PrinterService';
import type { PrinterManager } from '../../src/domain/PrinterManager';
import { setRuntime } from '../../src/runtime/runtime';

type RouteModule = Record<string, unknown>;
type RouteHandler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response> | Response;

interface CompiledRoute {
  pattern: RegExp;
  paramNames: string[];
  dynamicSegments: number;
  module: RouteModule;
}

// Every App Router route handler, keyed by file path (e.g. ../../app/api/ams/load/route.ts)
const routeModules = import.meta.glob<RouteModule>('../../app/api/**/route.ts', { eager: true });

const routes: CompiledRoute[] = Object.entries(routeModules)
  .map(([file, module]) => {
    const segments = file.replace('../../app', '').replace(/\/route\.ts$/, '').split('/').filter(Boolean);
    const paramNames: string[] = [];
    const source = segments
      .map((segment) => {
        const dynamic = segment.match(/^\[(.+)\]$/);
        if (dynamic) {
          paramNames.push(dynamic[1]);
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { pattern: new RegExp(`^/${source}$`), paramNames, dynamicSegments: paramNames.length, module };
  })
  // Static segments win over dynamic ones, as in Next.js routing
  .sort((a, b) => a.dynamicSegments - b.dynamicSegments);

export interface InjectOptions {
  method: string;
  url: string;
  payload?: unknown;
  /** multipart/form-data body (the Request sets the boundary header itself) */
  form?: FormData;
}

export interface InjectResponse {
  statusCode: number;
  headers: Headers;
  body: string;
  rawBody: Uint8Array;
  json(): any;
}

export interface TestApp {
  inject(options: InjectOptions): Promise<InjectResponse>;
  close(): void;
}

/**
 * Registers the printer runtime and serves requests through the real Next.js Route Handlers,
 * standing in for the Fastify `inject` API the tests were written against.
 */
export function createTestApp(printerService: PrinterService, printerManager?: PrinterManager): TestApp {
  setRuntime({ printerService, printerManager });

  return {
    async inject({ method, url, payload, form }) {
      const { pathname } = new URL(url, 'http://localhost');
      let response: Response | undefined;

      for (const route of routes) {
        const match = route.pattern.exec(pathname);
        if (!match) continue;

        const routeHandler = route.module[method.toUpperCase()] as RouteHandler | undefined;
        if (!routeHandler) {
          response = Response.json({ error: 'Method Not Allowed' }, { status: 405 });
          break;
        }

        const params = Object.fromEntries(route.paramNames.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
        const request = new Request(new URL(url, 'http://localhost'), {
          method,
          headers: payload !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          body: form ?? (payload !== undefined ? JSON.stringify(payload) : undefined),
        });
        response = await routeHandler(request, { params: Promise.resolve(params) });
        break;
      }

      response ??= Response.json({ error: 'Not Found' }, { status: 404 });
      const rawBody = new Uint8Array(await response.arrayBuffer());
      const body = new TextDecoder().decode(rawBody);
      return {
        statusCode: response.status,
        headers: response.headers,
        body,
        rawBody,
        json: () => JSON.parse(body),
      };
    },
    close() {
      setRuntime(undefined);
    },
  };
}
