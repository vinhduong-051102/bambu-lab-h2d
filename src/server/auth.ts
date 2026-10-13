import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import { env } from '../config/env';

export interface AuthFailure {
  status: 401;
  body: { error: string; message: string };
}

export type AuthHeaders = Pick<IncomingHttpHeaders, 'authorization' | 'cookie'>;

export const SESSION_COOKIE = 'gateway_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Paths guarded by GATEWAY_API_KEY. The dashboard page and Next.js assets stay public,
 * matching the old Fastify hook which only exempted the static dashboard files.
 * /api/auth/* is public so the dashboard can exchange the key for a session cookie.
 */
export function requiresAuth(pathname: string): boolean {
  if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
    return false;
  }
  return pathname === '/ws' || pathname === '/api' || pathname.startsWith('/api/');
}

export function isAuthEnabled(): boolean {
  return !!env.GATEWAY_API_KEY && env.GATEWAY_API_KEY.trim() !== '';
}

/**
 * Accepts either `Authorization: Bearer <GATEWAY_API_KEY>` (API clients) or the session cookie set by
 * POST /api/auth/login (the dashboard: browsers can't attach headers to <img> streams or WebSockets).
 */
export function checkAuthorization(headers: AuthHeaders): AuthFailure | null {
  // If GATEWAY_API_KEY is not set, running in open local development mode
  if (!isAuthEnabled()) {
    return null;
  }

  const authHeader = headers.authorization;
  if (!authHeader) {
    if (hasValidSessionCookie(headers.cookie)) {
      return null;
    }
    return unauthorized('Missing Authorization header. Expected Bearer token.');
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return unauthorized('Invalid Authorization header format. Expected "Bearer <GATEWAY_API_KEY>".');
  }

  if (!isValidApiKey(parts[1])) {
    return unauthorized('Invalid Gateway API Key.');
  }

  return null;
}

export function isValidApiKey(candidate: string): boolean {
  return isAuthEnabled() && safeEqual(candidate, env.GATEWAY_API_KEY!);
}

export function hasValidSessionCookie(cookieHeader: string | undefined): boolean {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  return isAuthEnabled() && !!token && safeEqual(token, sessionToken());
}

export function buildSessionCookie(secure: boolean): string {
  return serializeCookie(sessionToken(), SESSION_MAX_AGE_SECONDS, secure);
}

export function buildClearedSessionCookie(secure: boolean): string {
  return serializeCookie('', 0, secure);
}

// Derived from the key so the cookie never carries the key itself, and rotating the key revokes sessions.
function sessionToken(): string {
  return createHmac('sha256', env.GATEWAY_API_KEY!).update('bambu-gateway-dashboard-session').digest('hex');
}

function serializeCookie(value: string, maxAge: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function unauthorized(message: string): AuthFailure {
  return { status: 401, body: { error: 'Unauthorized', message } };
}
