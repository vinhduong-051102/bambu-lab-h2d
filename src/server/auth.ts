import type { IncomingHttpHeaders } from 'http';
import { env } from '../config/env';

export interface AuthFailure {
  status: 401;
  body: { error: string; message: string };
}

/**
 * Paths guarded by GATEWAY_API_KEY. The dashboard page and Next.js assets stay public,
 * matching the old Fastify hook which only exempted the static dashboard files.
 */
export function requiresAuth(pathname: string): boolean {
  return pathname === '/ws' || pathname === '/api' || pathname.startsWith('/api/');
}

export function checkAuthorization(headers: IncomingHttpHeaders): AuthFailure | null {
  // If GATEWAY_API_KEY is not set, running in open local development mode
  if (!env.GATEWAY_API_KEY || env.GATEWAY_API_KEY.trim() === '') {
    return null;
  }

  const authHeader = headers.authorization;
  if (!authHeader) {
    return unauthorized('Missing Authorization header. Expected Bearer token.');
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return unauthorized('Invalid Authorization header format. Expected "Bearer <GATEWAY_API_KEY>".');
  }

  if (parts[1] !== env.GATEWAY_API_KEY) {
    return unauthorized('Invalid Gateway API Key.');
  }

  return null;
}

function unauthorized(message: string): AuthFailure {
  return { status: 401, body: { error: 'Unauthorized', message } };
}
