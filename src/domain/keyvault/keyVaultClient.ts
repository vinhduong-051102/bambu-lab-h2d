/**
 * A KeyVault recipient (https://github.com/vinhduong-051102/key_store, HUONG_DAN_LAY_KEY.md): registering, and
 * fetching a key with the API key, this machine's X25519 private key and a one-time code from Google Authenticator.
 *
 * Kept in KV_DIR (data/secrets/keyvault, outside git), each file mode 600 and written whole (tmp + rename):
 * - keyvault.json: server, request_id, claim_token, api_key, recipient_id, stage, the keys granted; totp_secret only
 *   until the code it makes has activated the recipient
 * - keyvault-recipient.key: the private key, PEM PKCS8 without a passphrase (the gateway reads it unattended). Made
 *   here (ensureKey), so it never crosses the network.
 *
 * Registering: request → (an admin approves) → claim (API key + the authenticator's secret, once, within 7 days) →
 * activate with a code. Or an admin registers the gateway's public key and hands over the API key: importApiKey.
 * Fetching: export (the key under a one-off data key) → unlock with a code within 5 minutes (the data key wrapped for
 * this recipient) → opened here. Each code works once.
 */
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from 'crypto';
import { isIPv4 } from 'net';
import { promises as fs } from 'fs';
import path from 'path';

export const DEFAULT_SERVER = 'http://100.112.133.34:8000';
const WRAP_INFO = Buffer.from('keyvault-export-wrap-v1');
const TIMEOUT_MS = 30000;

export type Stage = 'none' | 'pending' | 'approved' | 'rejected' | 'claimed' | 'active';

export interface VaultKey {
  id: string;
  name: string;
  size_bytes?: number;
  fingerprint?: string;
  description?: string;
}

export interface VaultState {
  server?: string;
  request_id?: string;
  claim_token?: string;
  api_key?: string;
  recipient_id?: string;
  stage: Stage;
  review_note?: string | null;
  claim_expires_at?: string | null;
  keys?: VaultKey[];
  keys_checked_at?: string;
  /** Until activation: the authenticator's secret and its otpauth:// URI, for the page to show */
  totp_secret?: string;
  otpauth_uri?: string;
}

export class KVError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

const vaultDir = () => path.resolve(process.env.KV_DIR || './data/secrets/keyvault');
const stateFile = () => path.join(vaultDir(), 'keyvault.json');
const keyFile = () => path.join(vaultDir(), 'keyvault-recipient.key');

/** Writes a secret file whole: a reader sees the old one or the new one, never half */
export async function writeSecret(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.part`;
  await fs.writeFile(part, data, { mode: 0o600 });
  await fs.chmod(part, 0o600).catch(() => undefined);
  await fs.rename(part, file);
}

export async function loadState(): Promise<VaultState> {
  try {
    const data = JSON.parse(await fs.readFile(stateFile(), 'utf8'));
    return data && typeof data === 'object' ? { stage: 'none', ...data } : { stage: 'none' };
  } catch {
    return { stage: 'none' };
  }
}

export async function saveState(state: VaultState): Promise<void> {
  await writeSecret(stateFile(), JSON.stringify(state, null, 2));
}

/** Loopback, private (10/8, 172.16/12, 192.168/16) and Tailscale (100.64/10) addresses may be reached over http */
function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  if (!isIPv4(h)) return false;
  const [a, b] = h.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** A server address the gateway may use: https, or http to a private address */
export function checkServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new KVError(`Địa chỉ KeyVault không hợp lệ: "${value}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new KVError('Địa chỉ KeyVault phải là http:// hoặc https://.');
  if (url.protocol === 'http:' && !privateHost(url.hostname)) {
    throw new KVError(`Từ chối http:// tới ${url.hostname}: chỉ cho với loopback, IP nội bộ hoặc Tailscale (100.64.0.0/10); địa chỉ khác phải dùng https://.`);
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** KV_SERVER, else the one the gateway registered with, else DEFAULT_SERVER */
export function serverOf(state: VaultState): string {
  return checkServer(process.env.KV_SERVER?.trim() || state.server || DEFAULT_SERVER);
}

// ---------- the recipient's key ----------

async function readPrivateKey(): Promise<KeyObject | null> {
  let pem: Buffer;
  try {
    pem = await fs.readFile(keyFile());
  } catch {
    return null;
  }
  return parsePrivateKey(pem);
}

function parsePrivateKey(pem: string | Buffer): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new KVError('Private key không đọc được: cần PEM PKCS8 không passphrase.');
  }
  if (key.asymmetricKeyType !== 'x25519') throw new KVError('Private key không phải X25519.');
  return key;
}

/** The recipient's private key, made here on first use */
export async function ensureKey(): Promise<KeyObject> {
  const existing = await readPrivateKey();
  if (existing) return existing;
  const { privateKey } = generateKeyPairSync('x25519');
  await writeSecret(keyFile(), privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  return privateKey;
}

const rawPublic = (key: KeyObject) => Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x as string, 'base64url');

/** The public key, base64 of its 32 bytes: what an admin registers for this recipient */
export async function publicKey(): Promise<string> {
  return rawPublic(await ensureKey()).toString('base64');
}

// ---------- crypto ----------

function aesGcm(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
}

/** The key out of an export and its unlock: X25519 + HKDF-SHA256 unwrap the data key, AES-256-GCM both layers */
export function openExport(priv: KeyObject, ciphertext: string, wrappedKey: string, aad: string): Buffer {
  const w = Buffer.from(wrappedKey, 'base64');
  const eph = w.subarray(0, 32);
  const shared = diffieHellman({ privateKey: priv, publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: eph.toString('base64url') }, format: 'jwk' }) });
  const kek = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.concat([WRAP_INFO, eph, rawPublic(priv)]), 32));
  const ad = Buffer.from(aad);
  const dek = aesGcm(kek, w.subarray(32, 44), w.subarray(44), ad);
  const ct = Buffer.from(ciphertext, 'base64');
  return aesGcm(dek, ct.subarray(0, 12), ct.subarray(12), ad);
}

// ---------- HTTP ----------

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** Tests answer the KeyVault themselves; null restores fetch */
export function setVaultFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
}

/** The server's {"detail": ...} in plain words; FastAPI's 422 carries a list of field errors */
function explain(status: number, detail: unknown): string {
  const text = Array.isArray(detail)
    ? detail.map((d) => `${Array.isArray(d?.loc) ? d.loc[d.loc.length - 1] : 'dữ liệu'}: ${d?.msg ?? JSON.stringify(d)}`).join('; ')
    : typeof detail === 'string'
      ? detail
      : `HTTP ${status}`;
  if (status === 422) return `KeyVault không nhận dữ liệu gửi lên (${text}).`;
  if (/OTP không hợp lệ/i.test(text)) return `${text}: mã sai, đã dùng rồi, chọn nhầm mục trong Google Authenticator, hoặc giờ máy/điện thoại lệch (bật NTP).`;
  if (status === 401 && /API key/i.test(text)) return `${text}: API key sai hoặc đã được cấp lại; kết nối lại KeyVault.`;
  if (status === 410) return `${text}: quá 5 phút kể từ lúc xin export, thử lại.`;
  if (status === 429) return `${text}: chờ 15 phút hoặc nhờ quản trị viên gỡ khóa.`;
  return text;
}

async function call<T>(state: VaultState, method: string, route: string, { body, apiKey, claim }: { body?: unknown; apiKey?: boolean; claim?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    if (!state.api_key) throw new KVError('Chưa kết nối KeyVault: chưa có API key.');
    headers['X-API-Key'] = state.api_key;
  }
  if (claim) {
    if (!state.claim_token) throw new KVError('Chưa gửi yêu cầu truy cập KeyVault.');
    headers['X-Claim-Token'] = state.claim_token;
  }
  const server = serverOf(state);
  let res: Response;
  try {
    res = await fetchImpl(`${server}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new KVError(`Không kết nối được KeyVault ${server}: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new KVError(explain(res.status, data?.detail), [401, 403, 404, 409, 410, 422, 429].includes(res.status) ? res.status : 502);
  return data as T;
}

// ---------- registering ----------

export interface AccessRequest {
  name: string;
  contact: string;
  organization?: string;
  reason: string;
  requested_keys?: string;
}

/** Asks for access with this machine's own public key (made now if there is none) */
export async function requestAccess(req: AccessRequest, server?: string): Promise<VaultState> {
  const state = await loadState();
  if (state.request_id && state.stage !== 'rejected') throw new KVError('Đã gửi yêu cầu rồi: kiểm tra trạng thái, hoặc gỡ kết nối để gửi lại.', 409);
  if (!req.name?.trim() || !req.contact?.trim() || !req.reason?.trim()) throw new KVError('Cần tên, liên hệ và lý do.');
  const next: VaultState = { stage: 'none', server: server?.trim() ? checkServer(server) : state.server };
  const body = { name: req.name.trim(), contact: req.contact.trim(), organization: req.organization?.trim() ?? '', reason: req.reason.trim(), requested_keys: req.requested_keys?.trim() ?? '', public_key: await publicKey() };
  const res = await call<{ request_id: string; claim_token: string }>(next, 'POST', '/api/v1/access-requests', { body });
  const saved: VaultState = { ...next, server: serverOf(next), request_id: res.request_id, claim_token: res.claim_token, stage: 'pending' };
  await saveState(saved);
  return saved;
}

/** Asks the server how the request stands */
export async function refreshStatus(): Promise<VaultState> {
  const state = await loadState();
  if (!state.request_id) throw new KVError('Chưa gửi yêu cầu truy cập KeyVault.');
  if (state.stage === 'claimed' || state.stage === 'active') return state;
  const res = await call<{ status: Stage; review_note?: string; claim_expires_at?: string }>(state, 'GET', `/api/v1/access-requests/${encodeURIComponent(state.request_id)}`, { claim: true });
  const stage: Stage = ['pending', 'approved', 'rejected', 'claimed'].includes(res.status) ? res.status : state.stage;
  const next = { ...state, stage, review_note: res.review_note ?? null, claim_expires_at: res.claim_expires_at ?? null };
  await saveState(next);
  return next;
}

/** Takes the API key and the authenticator's secret: once only, so both are saved before anything else */
export async function claim(): Promise<VaultState> {
  const state = await loadState();
  if (!state.request_id) throw new KVError('Chưa gửi yêu cầu truy cập KeyVault.');
  const priv = await readPrivateKey();
  if (!priv) throw new KVError('Không còn private key đã gửi kèm yêu cầu: gỡ kết nối và gửi lại.');
  const res = await call<{ api_key: string; recipient_id: string; totp_secret: string; otpauth_uri: string; granted_keys?: VaultKey[]; public_key?: string; private_key_pem?: string }>(
    state,
    'POST',
    `/api/v1/access-requests/${encodeURIComponent(state.request_id)}/claim`,
    { body: {}, claim: true }
  );
  const next: VaultState = { ...state, stage: 'claimed', api_key: res.api_key, recipient_id: res.recipient_id, totp_secret: res.totp_secret, otpauth_uri: res.otpauth_uri, keys: res.granted_keys ?? state.keys };
  await saveState(next);
  if (res.public_key && res.public_key !== rawPublic(priv).toString('base64')) throw new KVError('Public key trên KeyVault không khớp private key của máy này.', 502);
  return next;
}

/** Activates the recipient with a code from the authenticator; the secret is then forgotten */
export async function activate(otp: string): Promise<VaultState> {
  const state = await loadState();
  if (!state.request_id || !state.api_key) throw new KVError('Chưa nhận thông tin (claim) từ KeyVault.');
  await call(state, 'POST', `/api/v1/access-requests/${encodeURIComponent(state.request_id)}/activate`, { body: { otp: checkOtp(otp) }, claim: true });
  const { totp_secret: _secret, otpauth_uri: _uri, ...rest } = state;
  const next: VaultState = { ...rest, stage: 'active' };
  await saveState(next);
  return listKeys().catch(() => next);
}

/** An admin registered the gateway (its public key, or a key pair of theirs): their API key, checked at once */
export async function importApiKey(apiKey: string, privateKeyPem?: string, server?: string): Promise<VaultState> {
  if (!/^kv_\S+$/.test(apiKey.trim())) throw new KVError('API key phải có dạng kv_...');
  const priv = privateKeyPem?.trim() ? parsePrivateKey(privateKeyPem.trim()) : await ensureKey();
  const state = await loadState();
  const next: VaultState = { stage: 'active', server: server?.trim() ? checkServer(server) : state.server, api_key: apiKey.trim() };
  const keys = await call<VaultKey[]>(next, 'GET', '/api/v1/keys', { apiKey: true });
  if (privateKeyPem?.trim()) await writeSecret(keyFile(), priv.export({ type: 'pkcs8', format: 'pem' }) as string);
  const saved = { ...next, server: serverOf(next), keys, keys_checked_at: new Date().toISOString() };
  await saveState(saved);
  return saved;
}

/** The keys granted to the gateway, from the server, kept for the page */
export async function listKeys(): Promise<VaultState> {
  const state = await loadState();
  const keys = await call<VaultKey[]>(state, 'GET', '/api/v1/keys', { apiKey: true });
  const next: VaultState = { ...state, stage: 'active', keys, keys_checked_at: new Date().toISOString() };
  await saveState(next);
  return next;
}

/**
 * Starts registering again (a lost authenticator secret, a claim gone stale, a new admin): the state and the private
 * key go to .backup-<time>/ as on reset, keeping the server; a new request makes a new key pair
 */
export async function reconnect(): Promise<string | null> {
  const state = await loadState();
  const backup = await reset();
  await saveState({ stage: 'none', server: state.server });
  return backup;
}

/** Disconnects: the state and the private key go to .backup-<time>/, not away */
export async function reset(): Promise<string | null> {
  const files = [stateFile(), keyFile()];
  const present = (await Promise.all(files.map((f) => fs.access(f).then(() => f, () => null)))).filter((f): f is string => !!f);
  if (!present.length) return null;
  const backup = path.join(vaultDir(), `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.mkdir(backup, { recursive: true });
  for (const file of present) await fs.rename(file, path.join(backup, path.basename(file)));
  return backup;
}

// ---------- fetching ----------

function checkOtp(otp: string): string {
  const code = String(otp ?? '').trim();
  if (!/^\d{6}$/.test(code)) throw new KVError('Mã OTP phải là 6 chữ số.');
  return code;
}

/** Fetches one key with a code: its value stays in memory, for the caller to use and keep */
export async function fetchKey(keyId: string, otp: string): Promise<{ key: VaultKey; value: Buffer }> {
  const state = await loadState();
  // Not connected says so before anything about the private key
  if (!state.api_key) throw new KVError('Chưa kết nối KeyVault: chưa có API key.');
  const code = checkOtp(otp);
  const priv = await readPrivateKey();
  if (!priv) throw new KVError(`Chưa có private key ${keyFile()}.`);
  const known = state.keys?.find((k) => k.id === keyId || k.name === keyId);
  const id = known?.id ?? keyId;

  type Export = { export_id: string; key_id: string; key_name: string; recipient_id: string; aad: string; ciphertext: string };
  const created = await call<Export>(state, 'POST', '/api/v1/exports', { body: { key_id: id }, apiKey: true });
  const aad = `kv-export-v1|${created.export_id}|${id}|${created.recipient_id}`;
  if (created.aad !== aad || created.key_id !== id) throw new KVError('Phản hồi export của KeyVault không khớp yêu cầu, đã hủy.', 502);
  const unlocked = await call<{ aad: string; wrapped_key: string }>(state, 'POST', `/api/v1/exports/${encodeURIComponent(created.export_id)}/unlock`, { body: { otp: code }, apiKey: true });
  if (unlocked.aad !== aad) throw new KVError('AAD của KeyVault không khớp, đã hủy.', 502);
  try {
    return { key: known ?? { id, name: created.key_name }, value: openExport(priv, created.ciphertext, unlocked.wrapped_key, aad) };
  } catch {
    throw new KVError('Không giải mã được key: private key không khớp public key đã đăng ký.', 502);
  }
}

// ---------- for the page ----------

export interface VaultView {
  stage: Stage;
  server: string;
  serverFromEnv: boolean;
  hasPrivateKey: boolean;
  requestId: string | null;
  reviewNote: string | null;
  claimExpiresAt: string | null;
  /** Only until activation */
  totpSecret: string | null;
  otpauthUri: string | null;
  keys: VaultKey[];
  keysCheckedAt: string | null;
}

/** What the page shows, from the files here: no network */
export async function vaultView(): Promise<VaultView> {
  const state = await loadState();
  let server: string;
  try {
    server = serverOf(state);
  } catch (err) {
    server = `${process.env.KV_SERVER || state.server} (${err instanceof Error ? err.message : String(err)})`;
  }
  return {
    stage: state.stage,
    server,
    serverFromEnv: !!process.env.KV_SERVER?.trim(),
    hasPrivateKey: !!(await readPrivateKey().catch(() => null)),
    requestId: state.request_id ?? null,
    reviewNote: state.review_note ?? null,
    claimExpiresAt: state.claim_expires_at ?? null,
    totpSecret: state.stage === 'claimed' ? (state.totp_secret ?? null) : null,
    otpauthUri: state.stage === 'claimed' ? (state.otpauth_uri ?? null) : null,
    keys: state.keys ?? [],
    keysCheckedAt: state.keys_checked_at ?? null,
  };
}
