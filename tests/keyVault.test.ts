import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAiVault, postAiVaultFetch } from '../src/api/routes/ai';
import { applyVaultTokens, setVaultFetch } from '../src/domain/ai/keyVault';
import { setRuntime } from '../src/runtime/runtime';

const VARS = ['KV_SERVER', 'KV_DIR', 'KV_API_KEY', 'KV_KEY_PRIMARY', 'KV_KEY_FALLBACK', 'CLAUDE_TOKENS_FILE', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FALLBACK'] as const;
const ctx = { params: Promise.resolve({}) };
const fetchToken = (plan: string, otp: string) =>
  postAiVaultFetch(new Request('http://localhost/api/ai/vault/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan, otp }) }), ctx as never);

const seal = (key: Buffer, data: Buffer, aad: string) => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
};
const raw = (key: KeyObject) => Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x as string, 'base64url');

/** A KeyVault as the guide describes it: the key under a data key, the data key wrapped for the recipient */
function fakeVault(recipient: KeyObject, keys: Record<string, string>, calls: string[]) {
  const exports = new Map<string, { keyId: string; dek: Buffer; aad: string }>();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push(`${init?.method} ${url.pathname}`);
    if ((init?.headers as Record<string, string>)['X-API-Key'] !== 'kv_test') return Response.json({ detail: 'API key không hợp lệ' }, { status: 401 });
    if (url.pathname === '/api/v1/keys') return Response.json(Object.keys(keys).map((name) => ({ id: `id-${name}`, name })));
    if (url.pathname === '/api/v1/exports') {
      const name = String(body.key_id).replace(/^id-/, '');
      const exportId = `exp${exports.size}`;
      const aad = `kv-export-v1|${exportId}|${body.key_id}|rcp1`;
      const dek = randomBytes(32);
      exports.set(exportId, { keyId: body.key_id, dek, aad });
      return Response.json({ export_id: exportId, key_id: body.key_id, key_name: name, recipient_id: 'rcp1', aad, ciphertext: seal(dek, Buffer.from(keys[name]), aad).toString('base64') });
    }
    const unlock = url.pathname.match(/^\/api\/v1\/exports\/([^/]+)\/unlock$/);
    if (unlock) {
      if (body.otp !== '123456') return Response.json({ detail: 'OTP không hợp lệ' }, { status: 401 });
      const { dek, aad } = exports.get(unlock[1])!;
      const eph = generateKeyPairSync('x25519');
      const ephPub = raw(eph.privateKey);
      const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey(recipient) });
      const kek = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.concat([Buffer.from('keyvault-export-wrap-v1'), ephPub, raw(recipient)]), 32));
      return Response.json({ aad, wrapped_key: Buffer.concat([ephPub, seal(kek, dek, aad)]).toString('base64') });
    }
    return Response.json({ detail: 'Not Found' }, { status: 404 });
  }) as typeof fetch;
}

describe('fetching the Claude tokens from the KeyVault', () => {
  const saved = VARS.map((k) => process.env[k]);
  let dir: string;
  let calls: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keyvault-'));
    const { privateKey } = generateKeyPairSync('x25519');
    writeFileSync(join(dir, 'recipient.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(join(dir, 'kv-request.json'), JSON.stringify({ request_id: 'r1', api_key: 'kv_test' }));
    Object.assign(process.env, {
      KV_SERVER: 'http://vault.test/',
      KV_DIR: dir,
      KV_KEY_PRIMARY: 'claude-primary',
      KV_KEY_FALLBACK: 'id-claude-fallback',
      CLAUDE_TOKENS_FILE: join(dir, 'claude', 'tokens.json'),
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-from-env',
    });
    delete process.env.KV_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FALLBACK;
    calls = [];
    setVaultFetch(fakeVault(privateKey, { 'claude-primary': 'sk-ant-oat01-one\n', 'claude-fallback': 'sk-ant-oat01-two', other: 'not a token' }, calls));
    setRuntime({ printerService: {} as never });
  });
  afterEach(() => {
    setVaultFetch(null);
    VARS.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  });

  it('opens each plan’s key with a one-time code, puts it to use and keeps it for the workers', async () => {
    const res = await fetchToken('primary', '123456');
    expect(await res.json()).toMatchObject({ success: true, plan: 'primary', keyName: 'claude-primary' });
    expect(calls).toEqual(['GET /api/v1/keys', 'POST /api/v1/exports', 'POST /api/v1/exports/exp0/unlock']);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-one');
    // The fallback's key named by its id
    expect((await fetchToken('fallback', '123456')).status).toBe(200);
    const file = JSON.parse(readFileSync(process.env.CLAUDE_TOKENS_FILE!, 'utf8'));
    expect(file).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-one', CLAUDE_CODE_OAUTH_TOKEN_FALLBACK: 'sk-ant-oat01-two' });

    // At the next start they win over .env
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-from-env';
    await applyVaultTokens();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-one');
    const status = await (await getAiVault(new Request('http://localhost/api/ai/vault'), ctx as never)).json();
    expect(status).toMatchObject({ ready: true, server: 'http://vault.test', plans: [{ key: 'primary', vaultKey: 'claude-primary' }, { key: 'fallback' }] });
    expect(status.plans[0].fetchedAt).toBeTruthy();
    expect(JSON.stringify(status)).not.toContain('sk-ant-oat01');
  });

  it('says why when the code, the key or the registration is wrong, and keeps the token it had', async () => {
    const wrongOtp = await fetchToken('primary', '000000');
    expect(wrongOtp.status).toBe(401);
    expect((await wrongOtp.json()).message).toMatch(/OTP không hợp lệ/);
    expect((await fetchToken('primary', '12345')).status).toBe(400);
    expect((await fetchToken('both', '123456')).status).toBe(400);

    process.env.KV_KEY_PRIMARY = 'missing';
    expect((await (await fetchToken('primary', '123456')).json()).message).toMatch(/không có key "missing"/);
    process.env.KV_KEY_PRIMARY = 'other';
    expect((await (await fetchToken('primary', '123456')).json()).message).toMatch(/không phải token Claude/);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-from-env');

    writeFileSync(join(dir, 'kv-request.json'), JSON.stringify({ request_id: 'r1' }));
    const status = await (await getAiVault(new Request('http://localhost/api/ai/vault'), ctx as never)).json();
    expect(status).toMatchObject({ ready: false, problem: expect.stringMatching(/API key/) });
    expect((await fetchToken('primary', '123456')).status).toBe(400);
  });
});
