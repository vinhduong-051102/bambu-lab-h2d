/**
 * The Claude plans the project runs on: one per Claude token on the KeyVault (src/domain/keyvault/keyVaultClient.ts),
 * named after its key, as many as the KeyVault grants. There are no fixed plans and no tokens in .env any more.
 *
 * A key granted shows as a plan at once; its token comes with a code from Google Authenticator, and is tried for real
 * first (one tiny model call, as the limits card does): only one that works is kept, else the plan keeps what it had.
 * A key the KeyVault no longer grants loses its plan the next time the list is read (Kiểm tra, or every 10 minutes).
 *
 * Kept by claudePlans.ts, read on each use by the gateway and the workers: in use at once, no restart, still there
 * after a reboot. A token's value never leaves the gateway: the page sees its last 4 characters.
 */
import { fetchKey, KVError, listKeys, loadState, type VaultKey } from '../keyvault/keyVaultClient';
import { claudePlans, last4, readTokens, writeTokens as saveTokens, type StoredPlan, type TokensFile } from './claudePlans';
import { clearLimitsCache, probeToken } from './claudeLimits';

async function writeTokens(data: TokensFile): Promise<void> {
  await saveTokens(data);
  // The limits read so far were for other tokens
  clearLimitsCache();
}

export interface PlanView {
  id: string;
  name: string;
  description: string;
  /** Its token is here */
  fetched: boolean;
  last4: string;
  fetchedAt: string | null;
  /** Still granted by the KeyVault (as of the last list) */
  granted: boolean;
}

/** Every plan for the page: the keys granted (fetched or not) and any fetched one the list has not caught up with */
export async function planList(): Promise<PlanView[]> {
  const [{ plans, not_claude }, state] = [readTokens(), await loadState()];
  const keys = (state.keys ?? []).filter((k) => !not_claude.includes(k.id));
  const views: PlanView[] = keys.map((k) => {
    const stored = plans.find((p) => p.id === k.id);
    return { id: k.id, name: k.name, description: k.description ?? '', fetched: !!stored, last4: last4(stored?.token ?? ''), fetchedAt: stored?.fetched_at ?? null, granted: true };
  });
  for (const p of plans) {
    if (!keys.some((k) => k.id === p.id)) views.push({ id: p.id, name: p.name, description: '', fetched: true, last4: last4(p.token), fetchedAt: p.fetched_at, granted: false });
  }
  return views;
}

/** Follows the KeyVault's list: a key no longer granted loses its plan; the rest take the list's order and names */
export async function syncPlans(keys: VaultKey[]): Promise<void> {
  const { plans, not_claude } = readTokens();
  const next = keys.flatMap((k) => {
    const p = plans.find((s) => s.id === k.id);
    return p ? [{ ...p, name: k.name }] : [];
  });
  const notClaude = not_claude.filter((id) => keys.some((k) => k.id === id));
  if (JSON.stringify(next) !== JSON.stringify(plans) || notClaude.length !== not_claude.length) await writeTokens({ plans: next, not_claude: notClaude });
}

/** Reads the KeyVault's list again and follows it */
export async function refreshPlans(): Promise<void> {
  await syncPlans((await listKeys()).keys ?? []);
}

/** A key's value as a Claude token, tried with one tiny call */
async function tryToken(keyId: string, otp: string) {
  const { key, value } = await fetchKey(keyId, otp);
  const token = value.toString('utf8').trim();
  if (!token.startsWith('sk-ant-')) return { key, token, claude: false, usable: false, limits: null, error: `Key "${key.name}" không phải token Claude (sk-ant-...).` };
  const limits = await probeToken(token);
  return { key, token, claude: true, usable: !limits.error, limits, error: limits.error };
}

/** Fetches a key's token, tries it, and only when it works keeps it as that key's plan */
export async function useVaultKey(keyId: string, otp: string): Promise<{ keyName: string; last4: string; fetchedAt: string }> {
  const tried = await tryToken(keyId, otp);
  const data = readTokens();
  if (!tried.claude) {
    await writeTokens({ ...data, not_claude: [...new Set([...data.not_claude, tried.key.id])] });
    throw new KVError(`${tried.error} Đã ẩn khỏi danh sách gói.`, 422);
  }
  if (!tried.usable) throw new KVError(`Token từ KeyVault (${tried.key.name}) không dùng được, giữ nguyên như cũ: ${tried.error}`, 422);
  const fetchedAt = new Date().toISOString();
  const plan: StoredPlan = { id: tried.key.id, name: tried.key.name, token: tried.token, fetched_at: fetchedAt };
  // In the KeyVault's order, whatever order they are fetched in
  const order = ((await loadState()).keys ?? []).map((k) => k.id);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const plans = [...data.plans.filter((p) => p.id !== plan.id), plan].sort((a, b) => rank(a.id) - rank(b.id));
  await writeTokens({ plans, not_claude: data.not_claude.filter((id) => id !== plan.id) });
  return { keyName: plan.name, last4: last4(plan.token), fetchedAt };
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
  const same = claudePlans().find((p) => p.token.trim() === tried.token);
  return {
    keyName: tried.key.name,
    last4: last4(tried.token),
    usable: tried.usable,
    error: tried.error,
    status: tried.limits?.status ?? null,
    fiveHour: tried.limits?.fiveHour.utilization ?? null,
    sevenDay: tried.limits?.sevenDay.utilization ?? null,
    organization: tried.limits?.organization ?? null,
    sameAs: same ? same.name : null,
  };
}
