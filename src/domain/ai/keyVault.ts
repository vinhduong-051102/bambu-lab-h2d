/**
 * The Claude subscription tokens (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN_FALLBACK) taken from the KeyVault
 * (src/domain/keyvault/keyVaultClient.ts) instead of .env, with a code from Google Authenticator.
 *
 * A fetched token is tried for real first (one tiny model call, as the limits card does): only one that works is
 * kept, else the plan keeps the token it had. Kept in CLAUDE_TOKENS_FILE (data/secrets/claude/tokens.json, mode 600,
 * {env name: token}), which the gateway lays over its environment at start and every 30 s, and which the CAD, mesh3d
 * and Studio containers mount and read before each Claude run: in use at once, no restart, and still there after a
 * reboot. An empty value there drops the plan's .env token ("Bỏ các mục không từ KeyVault"). A token's value never
 * leaves the gateway: the page sees its last 4 characters.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { fetchKey, KVError, loadState, rememberTarget, writeSecret, type VaultKey } from '../keyvault/keyVaultClient';
import { clearLimitsCache, LIMIT_TOKENS, probeToken } from './claudeLimits';

export type VaultPlan = (typeof LIMIT_TOKENS)[number]['key'];
export const isVaultPlan = (value: unknown): value is VaultPlan => LIMIT_TOKENS.some((t) => t.key === value);

const tokensFile = () => path.resolve(process.env.CLAUDE_TOKENS_FILE || './data/secrets/claude/tokens.json');
const envOf = (plan: VaultPlan) => LIMIT_TOKENS.find((t) => t.key === plan)!.env;
export const last4 = (token: string) => (token ? `••••${token.slice(-4)}` : '');

async function readTokens(): Promise<Record<string, string>> {
  try {
    const data = JSON.parse(await fs.readFile(tokensFile(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

async function writeTokens(tokens: Record<string, string>): Promise<void> {
  await writeSecret(tokensFile(), JSON.stringify(tokens, null, 2));
}

/** Lays the fetched tokens over the environment (they win over .env; an empty one drops the .env token) */
export async function applyVaultTokens(): Promise<void> {
  const tokens = await readTokens();
  for (const { env } of LIMIT_TOKENS) if (typeof tokens[env] === 'string') process.env[env] = tokens[env].trim();
}

export interface PlanSource {
  key: VaultPlan;
  label: string;
  env: string;
  /** vault: fetched from the KeyVault; env: .env; dropped: .env's dropped for the KeyVault; none: unset */
  source: 'vault' | 'env' | 'dropped' | 'none';
  last4: string;
  /** The KeyVault key it takes next time */
  vaultKey: { id: string; name: string } | null;
  fetchedAt: string | null;
}

export async function planSources(): Promise<PlanSource[]> {
  const [tokens, state] = [await readTokens(), await loadState()];
  return LIMIT_TOKENS.map(({ key, env, label }) => {
    const fromVault = typeof tokens[env] === 'string';
    const value = (process.env[env] ?? '').trim();
    const target = state.targets?.[key];
    return {
      key,
      label,
      env,
      source: fromVault ? (tokens[env].trim() ? 'vault' : 'dropped') : value ? 'env' : 'none',
      last4: last4(value),
      vaultKey: target ? { id: target.key_id, name: target.key_name } : null,
      fetchedAt: fromVault ? (tokens[`${env}_FETCHED_AT`] ?? null) : null,
    };
  });
}

/** A key's value as a Claude token, tried with one tiny call */
async function tryToken(keyId: string, otp: string) {
  const { key, value } = await fetchKey(keyId, otp);
  const token = value.toString('utf8').trim();
  if (!token.startsWith('sk-ant-')) return { key, token, usable: false, limits: null, error: `Key "${key.name}" không phải token Claude (sk-ant-...).` };
  const limits = await probeToken(token);
  return { key, token, usable: !limits.error, limits, error: limits.error };
}

/** The key a plan takes: the one given, else the one it took before */
async function keyFor(plan: VaultPlan, keyId?: string): Promise<string> {
  if (keyId?.trim()) return keyId.trim();
  const remembered = (await loadState()).targets?.[plan]?.key_id;
  if (!remembered) throw new KVError('Chọn key trên KeyVault cho gói này.');
  return remembered;
}

/** Fetches `plan`'s token, tries it, and only when it works keeps it and puts it to use */
export async function useVaultKey(plan: VaultPlan, otp: string, keyId?: string): Promise<{ keyName: string; last4: string; fetchedAt: string }> {
  const tried = await tryToken(await keyFor(plan, keyId), otp);
  if (!tried.usable) throw new KVError(`Token từ KeyVault (${tried.key.name}) không dùng được, giữ nguyên token cũ: ${tried.error}`, 422);
  const env = envOf(plan);
  const fetchedAt = new Date().toISOString();
  await writeTokens({ ...(await readTokens()), [env]: tried.token, [`${env}_FETCHED_AT`]: fetchedAt });
  process.env[env] = tried.token;
  await rememberTarget(plan, tried.key);
  // The limits read so far were the old token's
  clearLimitsCache();
  return { keyName: tried.key.name, last4: last4(tried.token), fetchedAt };
}

export interface KeyTest {
  keyName: string;
  last4: string;
  usable: boolean;
  error: string | null;
  status: string | null;
  fiveHour: number | null;
  sevenDay: number | null;
  organization: string | null;
  /** The plan already running on this very token */
  sameAs: string | null;
}

/** Fetches a key and tries it without keeping it: works or not, what is left of it, and whether a plan has it already */
export async function testVaultKey(keyId: string, otp: string): Promise<KeyTest> {
  const tried = await tryToken(keyId, otp);
  const same = LIMIT_TOKENS.find(({ env }) => (process.env[env] ?? '').trim() === tried.token);
  return {
    keyName: tried.key.name,
    last4: last4(tried.token),
    usable: tried.usable,
    error: tried.error,
    status: tried.limits?.status ?? null,
    fiveHour: tried.limits?.fiveHour.utilization ?? null,
    sevenDay: tried.limits?.sevenDay.utilization ?? null,
    organization: tried.limits?.organization ?? null,
    sameAs: same ? same.label : null,
  };
}

const plain = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// What a key's name may say for each plan, without accents or separators; the fallback's first, since its env name
// holds the primary's
const HINTS: [VaultPlan, string[]][] = [
  ['fallback', ['claudecodeoauthtokenfallback', 'fallback', 'duphong', 'backup', 'goi2', 'plan2', 'secondary']],
  ['primary', ['claudecodeoauthtoken', 'primary', 'chinh', 'main', 'goi1', 'plan1']],
];

/** The plan a KeyVault key is most likely for, from its name and description */
export function guessPlan(key: Pick<VaultKey, 'name' | 'description'>): VaultPlan | null {
  for (const text of [key.name, key.description ?? '']) {
    const p = plain(text);
    for (const [plan, hints] of HINTS) if (hints.some((h) => p.includes(h))) return plan;
  }
  return null;
}

/**
 * Stops using the .env tokens once at least one plan's comes from the KeyVault: each goes to .backup-<time>/ next to
 * the tokens file (not deleted), and an empty value in the file drops it from the gateway and the workers
 */
export async function dropNonVault(): Promise<{ dropped: string[]; backup: string | null }> {
  const sources = await planSources();
  if (!sources.some((s) => s.source === 'vault')) throw new KVError('Chưa có gói nào lấy từ KeyVault: lấy ít nhất một gói trước.', 409);
  const drop = sources.filter((s) => s.source === 'env');
  if (!drop.length) return { dropped: [], backup: null };
  const backup = path.join(path.dirname(tokensFile()), `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  for (const s of drop) await writeSecret(path.join(backup, s.env), process.env[s.env] ?? '');
  const tokens = await readTokens();
  for (const s of drop) {
    tokens[s.env] = '';
    process.env[s.env] = '';
  }
  await writeTokens(tokens);
  clearLimitsCache();
  return { dropped: drop.map((s) => s.label), backup };
}
