import type { PrinterService } from '../domain/PrinterService';
import type { PrinterManager } from '../domain/PrinterManager';
import { getRuntime } from '../runtime/runtime';

// A catch-all segment ([...path]) is the list of its segments
type Params = Record<string, string | string[]>;

export interface RouteContext<P extends Params = Params> {
  params: Promise<P>;
}

export interface HandlerArgs<P extends Params = Params> {
  request: Request;
  params: P;
  printerService: PrinterService;
  printerManager?: PrinterManager;
}

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

export class HttpError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof body === 'object' && body && 'message' in body ? String(body.message) : 'HTTP error');
  }
}

/**
 * Wraps a Next.js Route Handler: resolves the gateway runtime and dynamic params,
 * and converts thrown errors into JSON responses (mirrors the old Fastify error handler).
 */
export function handler<P extends Params = Params>(
  fn: (args: HandlerArgs<P>) => Promise<Response> | Response
) {
  return async (request: Request, context?: RouteContext<P>): Promise<Response> => {
    const runtime = getRuntime();
    if (!runtime) {
      return json({ error: 'Service Unavailable', message: 'No printer registered' }, 503);
    }

    try {
      const params = ((await context?.params) ?? {}) as P;
      return await fn({ request, params, ...runtime });
    } catch (err) {
      if (err instanceof HttpError) {
        return json(err.body, err.status);
      }
      return json(
        {
          success: false,
          error: (err instanceof Error && err.name) || 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
        500
      );
    }
  };
}

/**
 * Reads the request body as JSON. Returns undefined for an empty body, like Fastify did
 * when no Content-Type was sent; an empty body declared as JSON is a 400.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  const isJson = (request.headers.get('content-type') ?? '').includes('application/json');

  if (!text.trim()) {
    if (isJson) {
      throw new HttpError(400, {
        success: false,
        error: 'EMPTY_JSON_BODY',
        message: 'Request body cannot be empty when Content-Type is application/json.',
      });
    }
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, {
      success: false,
      error: 'INVALID_JSON_BODY',
      message: 'Request body is not valid JSON.',
    });
  }
}

interface DomainErrorLike {
  message: string;
  statusCode: number;
  errorCode: string;
  details?: unknown;
}

// Duck-typed rather than instanceof: domain errors can be thrown by service instances created in
// the custom server, whose class identities differ from the copies bundled by Next.js.
// Matches CommandExecutionError and PrintJobError.
function isDomainError(err: unknown): err is DomainErrorLike {
  return (
    err instanceof Error &&
    typeof (err as Partial<DomainErrorLike>).statusCode === 'number' &&
    typeof (err as Partial<DomainErrorLike>).errorCode === 'string'
  );
}

export function commandErrorResponse(err: unknown): Response {
  if (isDomainError(err)) {
    return json(
      { success: false, error: err.errorCode, message: err.message, ...(err.details !== undefined && { details: err.details }) },
      err.statusCode
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return json({ success: false, error: 'INTERNAL_ERROR', message }, 500);
}
