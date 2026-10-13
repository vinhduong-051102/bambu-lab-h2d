import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from '../src/config/env';
import { checkAuthorization, requiresAuth, SESSION_COOKIE } from '../src/server/auth';
import { getSession, login, logout } from '../src/api/routes/auth';

const KEY = 'test-gateway-key';

const loginRequest = (body: unknown) =>
  new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const cookieFrom = (res: Response) => res.headers.get('set-cookie')!.split(';')[0];

describe('Gateway auth (Bearer header + dashboard session cookie)', () => {
  const originalKey = env.GATEWAY_API_KEY;

  beforeEach(() => {
    env.GATEWAY_API_KEY = KEY;
  });

  afterEach(() => {
    env.GATEWAY_API_KEY = originalKey;
  });

  it('guards /api and /ws but leaves /api/auth/* and the page public', () => {
    expect(requiresAuth('/api/printer')).toBe(true);
    expect(requiresAuth('/ws')).toBe(true);
    expect(requiresAuth('/api/auth/login')).toBe(false);
    expect(requiresAuth('/api/auth/session')).toBe(false);
    expect(requiresAuth('/')).toBe(false);
  });

  it('accepts a valid Bearer token and rejects a wrong one', () => {
    expect(checkAuthorization({ authorization: `Bearer ${KEY}` })).toBeNull();
    expect(checkAuthorization({ authorization: 'Bearer nope' })?.status).toBe(401);
    expect(checkAuthorization({})?.status).toBe(401);
  });

  it('login with the right key sets an HttpOnly cookie that authorizes later requests', async () => {
    const res = await login(loginRequest({ key: KEY }));
    expect(res.status).toBe(200);

    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain(KEY);

    const cookie = cookieFrom(res);
    expect(checkAuthorization({ cookie: `other=1; ${cookie}` })).toBeNull();

    const session = await getSession(new Request('http://localhost/api/auth/session', { headers: { cookie } })).json();
    expect(session).toEqual({ authRequired: true, authenticated: true });
  });

  it('login with a wrong or missing key is rejected without a cookie', async () => {
    for (const body of [{ key: 'wrong' }, {}, 'not-json']) {
      const res = await login(loginRequest(body));
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('a forged cookie, or a cookie from a rotated key, is rejected', async () => {
    expect(checkAuthorization({ cookie: `${SESSION_COOKIE}=forged` })?.status).toBe(401);

    const cookie = cookieFrom(await login(loginRequest({ key: KEY })));
    env.GATEWAY_API_KEY = 'rotated-key';
    expect(checkAuthorization({ cookie })?.status).toBe(401);
  });

  it('logout clears the cookie', () => {
    expect(logout(new Request('http://localhost/api/auth/logout', { method: 'POST' })).headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('everything is open when GATEWAY_API_KEY is empty', async () => {
    env.GATEWAY_API_KEY = '';
    expect(checkAuthorization({})).toBeNull();
    const session = await getSession(new Request('http://localhost/api/auth/session')).json();
    expect(session).toEqual({ authRequired: false, authenticated: true });
  });
});
