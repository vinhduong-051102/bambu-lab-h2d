/**
 * The Claude subscription tokens, taken from a KeyVault instead of .env (KV_SERVER; how to register:
 * docs/keyvault.md). Each key comes out in two steps: an export (the key, encrypted with a one-off data key) and an
 * unlock with a one-time code from the recipient's Google Authenticator (the data key, wrapped for the recipient's
 * X25519 public key). Both are opened here with KV_DIR/recipient.key, so the token never crosses the network in
 * the clear.
 *
 * What comes out is kept in CLAUDE_TOKENS_FILE (data/secrets/claude/tokens.json, {env name: token}), which the
 * gateway lays over its own environment at start and after every fetch, and which the CAD, mesh3d and Studio
 * containers mount and read before each Claude run: a fetched token is in use at once, with no restart.
 */
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, type KeyObject } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { clearLimitsCache, LIMIT_TOKENS } from './claudeLimits';

export type VaultPlan = (typeof LIMIT_TOKENS)[number]['key'];

const WRAP_INFO = Buffer.from('keyvault-export-wrap-v1');
const TIMEOUT_MS = 30000;

const vaultDir = () => path.resolve(process.env.KV_DIR || './data/secrets/keyvault');
const tokensFile = () => path.resolve(process.env.CLAUDE_TOKENS_FILE || './data/secrets/claude/tokens.json');
const server = () => (process.env.KV_SERVER || '').trim().replace(/\/+$/, '');
/** The KeyVault key (its name or id) holding each plan's token */
const keyFor = (plan: VaultPlan) => (process.env[plan === 'primary' ? 'KV_KEY_PRIMARY' : 'KV_KEY_FALLBACK'] || '').trim();

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** Tests answer the KeyVault themselves; null restores fetch */
export function setVaultFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

/** The API key: KV_API_KEY, else the one `kvclient.py claim` saved in KV_DIR/kv-request.json */
async function apiKey(): Promise<string> {
  if (process.env.KV_API_KEY?.trim()) return process.env.KV_API_KEY.trim();
  try {
    return String(JSON.parse(await fs.readFile(path.join(vaultDir(), 'kv-request.json'), 'utf8'))?.api_key ?? '');
  } catch {
    return '';
  }
}

async function privateKey(): Promise<KeyObject | null> {
  try {
    const key = createPrivateKey(await fs.readFile(path.join(vaultDir(), 'recipient.key')));
    return key.asymmetricKeyType === 'x25519' ? key : null;
  } catch {
    return null;
  }
}

const rawPublic = (key: KeyObject) => Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x as string, 'base64url');

function aesGcm(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]);
}

/** The key out of an export and its unlock: X25519 + HKDF-SHA256 unwrap the data key, AES-256-GCM both layers */
export function openExport(priv: KeyObject, ciphertext: string, wrappedKey: string, aad: string): Buffer {
  const wrapped = Buffer.from(wrappedKey, 'base64');
  const ephemeral = wrapped.subarray(0, 32);
  const shared = diffieHellman({
    privateKey: priv,
    publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: ephemeral.toString('base64url') }, format: 'jwk' }),
  });
  const kek = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.concat([WRAP_INFO, ephemeral, rawPublic(priv)]), 32));
  const dek = aesGcm(kek, wrapped.subarray(32), Buffer.from(aad));
  return aesGcm(dek, Buffer.from(ciphertext, 'base64'), Buffer.from(aad));
}

async function call<T>(method: string, route: string, key: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${server()}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new VaultError(`Không kết nối được KeyVault ${server()}: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new VaultError(`KeyVault trả lỗi ${res.status}: ${data?.detail ?? res.statusText}`, res.status === 401 || res.status === 429 ? res.status : 502);
  return data as T;
}

/** The tokens fetched so far: {env name: token, updated_at} */
async function readTokens(): Promise<Record<string, string>> {
  try {
    const data = JSON.parse(await fs.readFile(tokensFile(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** Lays the fetched tokens over the environment (they win over .env); called at start and after each fetch */
export async function applyVaultTokens(): Promise<void> {
  const tokens = await readTokens();
  for (const { env } of LIMIT_TOKENS) if (tokens[env]?.trim()) process.env[env] = tokens[env].trim();
}

export interface VaultStatus {
  server: string | null;
  /** Registered: an API key and the recipient's private key are there */
  ready: boolean;
  problem: string | null;
  plans: { key: VaultPlan; label: string; vaultKey: string | null; fetchedAt: string | null }[];
}

export async function vaultStatus(): Promise<VaultStatus> {
  const tokens = await readTokens();
  const [key, priv] = await Promise.all([apiKey(), privateKey()]);
  const problem = !server()
    ? 'Chưa đặt KV_SERVER trong .env.'
    : !priv
      ? `Chưa có private key X25519 ở ${path.join(vaultDir(), 'recipient.key')} (xem docs/keyvault.md).`
      : !key
        ? 'Chưa có API key: yêu cầu truy cập chưa được duyệt và nhận (kvclient.py claim), hoặc đặt KV_API_KEY.'
        : null;
  return {
    server: server() || null,
    ready: !problem,
    problem,
    plans: LIMIT_TOKENS.map((t) => ({ key: t.key, label: t.label, vaultKey: keyFor(t.key) || null, fetchedAt: tokens[`${t.env}_FETCHED_AT`] ?? null })),
  };
}

type VaultKey = { id: string; name: string };
type Export = { export_id: string; key_id: string; key_name: string; recipient_id: string; aad: string; ciphertext: string };
type Unlock = { aad: string; wrapped_key: string };

/** Fetches `plan`'s token with a one-time code and puts it to use; returns the KeyVault key's name */
export async function fetchFromVault(plan: VaultPlan, otp: string): Promise<{ keyName: string; fetchedAt: string }> {
  const status = await vaultStatus();
  if (!status.ready) throw new VaultError(status.problem!);
  const wanted = keyFor(plan);
  if (!wanted) throw new VaultError(`Chưa đặt ${plan === 'primary' ? 'KV_KEY_PRIMARY' : 'KV_KEY_FALLBACK'} (tên hoặc id của key trên KeyVault) trong .env.`);
  if (!/^\d{6}$/.test(otp.trim())) throw new VaultError('Mã OTP phải là 6 chữ số.');
  const [key, priv] = [await apiKey(), (await privateKey())!];

  const keys = await call<VaultKey[]>('GET', '/api/v1/keys', key);
  const found = keys.find((k) => k.id === wanted || k.name === wanted);
  if (!found) throw new VaultError(`KeyVault không có key "${wanted}" cấp cho gateway (có: ${keys.map((k) => k.name).join(', ') || 'không có key nào'}).`, 404);

  const created = await call<Export>('POST', '/api/v1/exports', key, { key_id: found.id });
  const aad = `kv-export-v1|${created.export_id}|${found.id}|${created.recipient_id}`;
  if (created.aad !== aad || created.key_id !== found.id) throw new VaultError('Phản hồi export của KeyVault không khớp yêu cầu, đã hủy.', 502);
  const unlocked = await call<Unlock>('POST', `/api/v1/exports/${encodeURIComponent(created.export_id)}/unlock`, key, { otp: otp.trim() });
  if (unlocked.aad !== aad) throw new VaultError('AAD của KeyVault không khớp, đã hủy.', 502);

  let token: string;
  try {
    token = openExport(priv, created.ciphertext, unlocked.wrapped_key, aad).toString('utf8').trim();
  } catch {
    throw new VaultError('Không giải mã được key: recipient.key không khớp public key đã đăng ký.', 502);
  }
  if (!token.startsWith('sk-ant-')) throw new VaultError(`Key "${found.name}" không phải token Claude (sk-ant-...).`);

  const env = LIMIT_TOKENS.find((t) => t.key === plan)!.env;
  const fetchedAt = new Date().toISOString();
  const file = tokensFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.part`, JSON.stringify({ ...(await readTokens()), [env]: token, [`${env}_FETCHED_AT`]: fetchedAt }, null, 2), { mode: 0o600 });
  await fs.rename(`${file}.part`, file);
  process.env[env] = token;
  // The plans' limits were read with the old token
  clearLimitsCache();
  return { keyName: found.name, fetchedAt };
}
