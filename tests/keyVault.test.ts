import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getKeyVault, postKeyVault } from '../src/api/routes/keyvault';
import { setLimitsFetch } from '../src/domain/ai/claudeLimits';
import { availablePlans } from '../src/domain/ai/aiPlan';
import { claudePlans } from '../src/domain/ai/claudePlans';
import { planList, refreshPlans, testVaultKey, useVaultKey } from '../src/domain/ai/keyVault';
import { checkServer, ensureKey, fetchKey, loadState, openExport, requestAccess, saveState, setVaultFetch, vaultView } from '../src/domain/keyvault/keyVaultClient';
import { setRuntime } from '../src/runtime/runtime';

const VARS = ['KV_SERVER', 'KV_DIR', 'CLAUDE_TOKENS_FILE'] as const;
const ctx = (action?: string) => ({ params: Promise.resolve(action ? { action } : {}) });
const post = (action: string, body: unknown = {}) =>
  postKeyVault(new Request(`http://localhost/api/keyvault/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ctx(action) as never);
const getView = async () => (await getKeyVault(new Request('http://localhost/api/keyvault'), ctx() as never)).json();

const seal = (key: Buffer, data: Buffer, aad: string) => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
};
const raw = (key: KeyObject) => Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x as string, 'base64url');

/** What the server does for an export: the key under a data key, the data key wrapped for the recipient's public key */
function sealFor(recipient: KeyObject, value: Buffer, aad: string) {
  const dek = randomBytes(32);
  const eph = generateKeyPairSync('x25519');
  const ephPub = raw(eph.privateKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey(recipient) });
  const kek = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.concat([Buffer.from('keyvault-export-wrap-v1'), ephPub, raw(recipient)]), 32));
  return { ciphertext: seal(dek, value, aad).toString('base64'), wrapped_key: Buffer.concat([ephPub, seal(kek, dek, aad)]).toString('base64') };
}

/** A KeyVault as the guide describes it, holding `keys` (name → value) for the recipient whose key is on disk */
function fakeVault(keys: Record<string, string>, calls: string[]) {
  let status = 'pending';
  const exports = new Map<string, { aad: string; sealed: { ciphertext: string; wrapped_key: string } }>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push(`${init?.method} ${url.pathname}`);
    if (url.pathname === '/api/v1/access-requests') {
      if (!body.public_key) return Response.json({ detail: [{ loc: ['body', 'public_key'], msg: 'Field required' }] }, { status: 422 });
      return Response.json({ request_id: 'req1', claim_token: 'ct1' });
    }
    const request = url.pathname.match(/^\/api\/v1\/access-requests\/req1(\/claim|\/activate)?$/);
    if (request) {
      if (headers['X-Claim-Token'] !== 'ct1') return Response.json({ detail: 'Claim token sai' }, { status: 401 });
      if (!request[1]) return Response.json({ status, review_note: 'ok', claim_expires_at: '2026-11-16T00:00:00' });
      if (request[1] === '/claim') {
        status = 'claimed';
        const pub = raw(await ensureKey()).toString('base64');
        return Response.json({ api_key: 'kv_test', recipient_id: 'rcp1', totp_secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/KeyVault:gw?secret=JBSWY3DPEHPK3PXP', granted_keys: [], public_key: pub });
      }
      return body.otp === '123456' ? Response.json({ ok: true }) : Response.json({ detail: 'OTP không hợp lệ' }, { status: 401 });
    }
    if (headers['X-API-Key'] !== 'kv_test') return Response.json({ detail: 'API key không hợp lệ' }, { status: 401 });
    if (url.pathname === '/api/v1/keys') return Response.json(Object.keys(keys).map((name) => ({ id: `id-${name}`, name, size_bytes: keys[name].length, description: '' })));
    if (url.pathname === '/api/v1/exports') {
      const name = String(body.key_id).replace(/^id-/, '');
      if (!(name in keys)) return Response.json({ detail: 'Key không tồn tại hoặc bạn không được cấp quyền' }, { status: 404 });
      const exportId = `exp${exports.size}`;
      const aad = `kv-export-v1|${exportId}|${body.key_id}|rcp1`;
      const sealed = sealFor(await ensureKey(), Buffer.from(keys[name]), aad);
      exports.set(exportId, { aad, sealed });
      return Response.json({ export_id: exportId, key_id: body.key_id, key_name: name, recipient_id: 'rcp1', aad, ciphertext: sealed.ciphertext });
    }
    const unlock = url.pathname.match(/^\/api\/v1\/exports\/([^/]+)\/unlock$/);
    if (unlock) {
      if (body.otp !== '123456') return Response.json({ detail: 'OTP không hợp lệ' }, { status: 401 });
      const e = exports.get(unlock[1])!;
      return Response.json({ aad: e.aad, wrapped_key: e.sealed.wrapped_key });
    }
    return Response.json({ detail: 'Not Found' }, { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, approve: () => (status = 'approved') };
}

/** Anthropic for the limits probe: a "good" token works, any other is refused */
function fakeAnthropic(calls: string[]) {
  setLimitsFetch((async (_input: string | URL | Request, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '');
    calls.push(`probe ${token.slice(-4)}`);
    if (token.startsWith('sk-ant-good')) {
      return new Response('{}', {
        status: 200,
        headers: { 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': '0.25', 'anthropic-ratelimit-unified-7d-utilization': '0.5' },
      });
    }
    return Response.json({ error: { message: 'invalid x-api-key' } }, { status: 401 });
  }) as typeof fetch);
}

describe('KeyVault', () => {
  const saved = VARS.map((k) => process.env[k]);
  let dir: string;
  let calls: string[];

  beforeEach(() => {
    // A copy of the configuration: folders of its own, no plans yet
    dir = mkdtempSync(join(tmpdir(), 'keyvault-'));
    Object.assign(process.env, {
      KV_SERVER: 'http://100.112.133.34:8000',
      KV_DIR: join(dir, 'keyvault'),
      CLAUDE_TOKENS_FILE: join(dir, 'claude', 'tokens.json'),
    });
    calls = [];
    setRuntime({ printerService: {} as never });
  });
  afterEach(() => {
    setVaultFetch(null);
    setLimitsFetch(null);
    VARS.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  });

  it('opens what was sealed for its own public key, and nothing else', async () => {
    const priv = await ensureKey();
    const aad = 'kv-export-v1|e1|k1|r1';
    const sealed = sealFor(priv, Buffer.from('sk-ant-secret'), aad);
    expect(openExport(priv, sealed.ciphertext, sealed.wrapped_key, aad).toString()).toBe('sk-ant-secret');
    expect(() => openExport(priv, sealed.ciphertext, sealed.wrapped_key, 'kv-export-v1|e1|k1|other')).toThrow();
    expect(() => openExport(generateKeyPairSync('x25519').privateKey, sealed.ciphertext, sealed.wrapped_key, aad)).toThrow();
    // Made once, PEM PKCS8 without a passphrase
    expect(readFileSync(join(dir, 'keyvault', 'keyvault-recipient.key'), 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(raw(await ensureKey())).toEqual(raw(priv));
  });

  it('takes http only to loopback, private and Tailscale addresses', () => {
    for (const ok of ['http://100.112.133.34:8000', 'http://127.0.0.1:8000', 'http://localhost:8000', 'http://192.168.1.5', 'http://10.0.0.2', 'http://172.20.1.1', 'https://vault.example.com']) {
      expect(() => checkServer(ok)).not.toThrow();
    }
    for (const bad of ['http://vault.example.com', 'http://8.8.8.8', 'http://100.128.0.1', 'http://172.32.0.1', 'ftp://10.0.0.1', 'vault']) expect(() => checkServer(bad)).toThrow();
    expect(checkServer('http://100.112.133.34:8000/')).toBe('http://100.112.133.34:8000');
    process.env.KV_SERVER = 'http://vault.example.com';
    return expect(post('refresh').then((r) => r.json())).resolves.toMatchObject({ success: false });
  });

  it('says it is not connected before anything about the private key', async () => {
    await expect(fetchKey('k', '123456')).rejects.toThrow(/Chưa kết nối KeyVault/);
    expect(existsSync(join(dir, 'keyvault', 'keyvault-recipient.key'))).toBe(false);
    expect((await (await post('use', { otp: '123456', key_id: 'k' })).json()).message).toMatch(/Chưa kết nối/);
  });

  it('registers step by step: request, approval, claim with the secret shown, activation that forgets it', async () => {
    const vault = fakeVault({ 'claude-primary': 'sk-ant-good-aaaa' }, calls);
    setVaultFetch(vault.fetch);
    expect((await vaultView()).stage).toBe('none');
    const requested = await (await post('request', { name: 'gw', contact: 'me', reason: 'tokens' })).json();
    expect(requested).toMatchObject({ success: true, stage: 'pending', requestId: 'req1', hasPrivateKey: true });
    expect((await (await post('request', { name: 'gw', contact: 'me', reason: 'tokens' })).json()).message).toMatch(/Đã gửi yêu cầu/);
    expect((await (await post('refresh')).json()).stage).toBe('pending');
    vault.approve();
    expect(await (await post('refresh')).json()).toMatchObject({ stage: 'approved', reviewNote: 'ok' });
    expect(await (await post('claim')).json()).toMatchObject({ stage: 'claimed', totpSecret: 'JBSWY3DPEHPK3PXP' });
    expect((await (await post('activate', { otp: '000000' })).json()).message).toMatch(/OTP không hợp lệ.*NTP/);
    const active = await (await post('activate', { otp: '123456' })).json();
    expect(active).toMatchObject({ stage: 'active', totpSecret: null, plans: [{ name: 'claude-primary', fetched: false, granted: true }] });
    expect((await loadState()).totp_secret).toBeUndefined();
    // The page's view reads the files: no network
    const before = calls.length;
    await getView();
    expect(calls.length).toBe(before);
    // Starting over: the old registration backed up, the server kept, a new request with a new pair
    await saveState({ ...(await loadState()), server: 'http://10.0.0.9:8000' });
    const oldPub = (await (await post('pubkey')).json()).publicKey;
    const again = await (await post('reconnect')).json();
    expect(again).toMatchObject({ success: true, stage: 'none', requestId: null, hasPrivateKey: false });
    expect(readdirSync(again.backup).sort()).toEqual(['keyvault-recipient.key', 'keyvault.json']);
    expect((await loadState()).server).toBe('http://10.0.0.9:8000');
    expect(await (await post('request', { name: 'gw', contact: 'me', reason: 'again' })).json()).toMatchObject({ stage: 'pending', requestId: 'req1' });
    expect((await (await post('pubkey')).json()).publicKey).not.toBe(oldPub);
  });

  it('takes an API key an admin made for the gateway, checked at once', async () => {
    setVaultFetch(fakeVault({ k: 'v' }, calls).fetch);
    const pub = await (await post('pubkey')).json();
    expect(Buffer.from(pub.publicKey, 'base64')).toHaveLength(32);
    expect((await (await post('import', { api_key: 'kv_wrong' })).json()).message).toMatch(/API key không hợp lệ/);
    expect((await vaultView()).stage).toBe('none');
    expect(await (await post('import', { api_key: 'kv_test' })).json()).toMatchObject({ stage: 'active', keys: [{ name: 'k' }], plans: [{ name: 'k', fetched: false }] });
  });

  it('makes each Claude key a plan: tried before it is kept, in the KeyVault’s order, gone once taken back', async () => {
    const keys: Record<string, string> = { cla_a: 'sk-ant-good-aaaa\n', cla_bad: 'sk-ant-bad-bbbb', 'payment-hmac': 'xyz', cla_c: 'sk-ant-good-cccc' };
    setVaultFetch(fakeVault(keys, calls).fetch);
    await saveState({ stage: 'active', api_key: 'kv_test' });
    await ensureKey();
    fakeAnthropic(calls);
    await refreshPlans();
    expect((await planList()).map((p) => [p.name, p.fetched])).toEqual([
      ['cla_a', false],
      ['cla_bad', false],
      ['payment-hmac', false],
      ['cla_c', false],
    ]);
    expect(claudePlans()).toEqual([]);
    expect(availablePlans()).toEqual([{ plan: 'auto', label: 'Tự động', configured: false }]);

    // A bad token: refused, nothing kept; a key that is no Claude token: hidden from the plans
    await expect(useVaultKey('id-cla_bad', '123456')).rejects.toThrow(/không dùng được, giữ nguyên như cũ/);
    await expect(useVaultKey('id-payment-hmac', '123456')).rejects.toThrow(/không phải token Claude.*Đã ẩn/);
    expect(claudePlans()).toEqual([]);
    expect((await planList()).map((p) => p.name)).toEqual(['cla_a', 'cla_bad', 'cla_c']);

    // Good ones: kept, used at once, in the KeyVault's order whatever order they come in
    const used = await (await post('use', { key_id: 'id-cla_c', otp: '123456' })).json();
    expect(used).toMatchObject({ success: true, used: { keyName: 'cla_c', last4: '••••cccc' } });
    expect(JSON.stringify(used)).not.toContain('sk-ant-good');
    expect(calls).toContain('probe cccc');
    await useVaultKey('id-cla_a', '123456');
    expect(claudePlans().map((p) => [p.name, p.token])).toEqual([
      ['cla_a', 'sk-ant-good-aaaa'],
      ['cla_c', 'sk-ant-good-cccc'],
    ]);
    expect(availablePlans().map((p) => p.plan)).toEqual(['auto', 'id-cla_a', 'id-cla_c']);

    // Trying a key keeps nothing, and tells when a plan has it already
    expect(await testVaultKey('id-cla_a', '123456')).toMatchObject({ usable: true, fiveHour: 0.25, sevenDay: 0.5, sameAs: 'cla_a', last4: '••••aaaa' });
    expect(await testVaultKey('id-cla_bad', '123456')).toMatchObject({ usable: false, sameAs: null });

    // Taken back on the KeyVault: its plan goes the next time the list is read; a new key shows as a plan
    delete keys.cla_a;
    keys.cla_new = 'sk-ant-good-nnnn';
    const after = await (await post('keys')).json();
    expect(after.plans.map((p: { name: string; fetched: boolean }) => [p.name, p.fetched])).toEqual([
      ['cla_bad', false],
      ['cla_c', true],
      ['cla_new', false],
    ]);
    expect(claudePlans().map((p) => p.name)).toEqual(['cla_c']);
    expect(JSON.stringify(await getView())).not.toContain('sk-ant-good');
  });

  it('turns the server’s errors into plain words', async () => {
    setVaultFetch(fakeVault({}, calls).fetch);
    await saveState({ stage: 'active', api_key: 'kv_test' });
    await ensureKey();
    await expect(fetchKey('id-missing', '123456')).rejects.toThrow(/Key không tồn tại/);
    await expect(fetchKey('id-x', '12345')).rejects.toThrow(/6 chữ số/);
    // FastAPI's 422: a list of field errors
    setVaultFetch((async () => Response.json({ detail: [{ loc: ['body', 'contact'], msg: 'Field required' }] }, { status: 422 })) as typeof fetch);
    await saveState({ stage: 'none' });
    await expect(requestAccess({ name: 'a', contact: 'b', reason: 'c' })).rejects.toThrow(/contact: Field required/);
  });
});
