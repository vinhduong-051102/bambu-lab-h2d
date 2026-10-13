import {
  buildClearedSessionCookie,
  buildSessionCookie,
  hasValidSessionCookie,
  isAuthEnabled,
  isValidApiKey,
} from '../../server/auth';
import { json, readJsonBody } from '../http';

// These routes are exempt from the auth gate (see requiresAuth) and need no printer runtime.

const isSecureRequest = (request: Request) =>
  new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';

// GET /api/auth/session - Whether the dashboard must log in before calling the API
export function getSession(request: Request): Response {
  const authRequired = isAuthEnabled();
  return json({
    authRequired,
    authenticated: !authRequired || hasValidSessionCookie(request.headers.get('cookie') ?? undefined),
  });
}

// POST /api/auth/login - Exchange GATEWAY_API_KEY for an HttpOnly session cookie
export async function login(request: Request): Promise<Response> {
  if (!isAuthEnabled()) {
    return json({ success: true, authRequired: false });
  }

  const body = (await readJsonBody(request).catch(() => null)) as { key?: unknown } | null | undefined;
  if (typeof body?.key !== 'string' || !isValidApiKey(body.key)) {
    return json({ success: false, error: 'Unauthorized', message: 'Invalid Gateway API Key.' }, 401);
  }

  return json({ success: true }, 200, { 'Set-Cookie': buildSessionCookie(isSecureRequest(request)) });
}

// POST /api/auth/logout - Clear the dashboard session cookie
export function logout(request: Request): Response {
  return json({ success: true }, 200, { 'Set-Cookie': buildClearedSessionCookie(isSecureRequest(request)) });
}
