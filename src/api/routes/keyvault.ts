import { planList, refreshPlans, syncPlans, testVaultKey, useVaultKey } from '../../domain/ai/keyVault';
import {
  activate,
  claim,
  importApiKey,
  KVError,
  loadState,
  publicKey,
  reconnect,
  refreshStatus,
  requestAccess,
  reset,
  vaultView,
} from '../../domain/keyvault/keyVaultClient';
import { handler, json, readJsonBody } from '../http';

/**
 * The KeyVault the Claude plans come from (docs/keyvault.md): registering the gateway step by step, and fetching each
 * key's token, one plan per key, with a code from Google Authenticator. A token's value never reaches the page, only
 * its last 4 characters.
 */

const str = (v: unknown) => (typeof v === 'string' ? v : '');

async function body(request: Request): Promise<Record<string, unknown>> {
  return ((await readJsonBody(request).catch(() => null)) as Record<string, unknown> | null) ?? {};
}

/** The KeyVault's own errors carry their message to the page; anything else is the gateway's */
async function vault(fn: () => Promise<Record<string, unknown>>): Promise<Response> {
  try {
    return json({ success: true, ...(await fn()) });
  } catch (err) {
    if (err instanceof KVError) return json({ success: false, error: 'KEYVAULT', message: err.message }, err.status);
    throw err;
  }
}

/** The registration and the plans, from the files here (no network) */
async function view() {
  return { ...(await vaultView()), plans: await planList() };
}

/** After the KeyVault answered with its key list: plans follow it */
async function synced() {
  await syncPlans((await loadState()).keys ?? []);
  return view();
}

// GET /api/keyvault - The registration's stage (none, pending, approved, rejected, claimed, active) and the Claude
// plans: one per key granted, whether its token is here, its last 4
export const getKeyVault = handler(async () => vault(view));

// POST /api/keyvault/<action> - Registering and fetching; each answers with the view above
export const postKeyVault = handler<{ action: string }>(async ({ request, params }) => {
  const b = await body(request);
  switch (params.action) {
    // {name, contact, organization, reason, requested_keys}: asks for access with a key pair made here
    case 'request':
      return vault(async () => {
        await requestAccess({ name: str(b.name), contact: str(b.contact), organization: str(b.organization), reason: str(b.reason), requested_keys: str(b.requested_keys) }, str(b.server));
        return view();
      });
    // How the request stands on the KeyVault
    case 'refresh':
      return vault(async () => (await refreshStatus(), view()));
    // Once approved: the API key and the authenticator's secret, shown until activation
    case 'claim':
      return vault(async () => (await claim(), view()));
    // {otp}
    case 'activate':
      return vault(async () => (await activate(str(b.otp)), synced()));
    // {api_key, private_key_pem?, server?}: an admin registered the gateway; checked at once with the key list
    case 'import':
      return vault(async () => (await importApiKey(str(b.api_key), str(b.private_key_pem), str(b.server)), synced()));
    // The public key for an admin to register (the pair is made here when there is none)
    case 'pubkey':
      return vault(async () => ({ publicKey: await publicKey() }));
    // The keys granted, asked again: a new one shows as a plan, one no longer granted loses its plan
    case 'keys':
      return vault(async () => (await refreshPlans(), view()));
    // Starts registering again, keeping the server; the old files go to .backup-<time>/, the plans stay
    case 'reconnect':
      return vault(async () => ({ backup: await reconnect(), ...(await view()) }));
    // Disconnects; the files go to .backup-<time>/, the plans stay
    case 'reset':
      return vault(async () => ({ backup: await reset(), ...(await view()) }));
    // {key_id, otp}: fetches the key's token, tries it, keeps it as that key's plan if it works
    case 'use':
      if (!str(b.key_id)) return json({ success: false, error: 'INVALID_PAYLOAD', message: 'Cần key_id.' }, 400);
      return vault(async () => ({ used: await useVaultKey(str(b.key_id), str(b.otp)), ...(await view()) }));
    // {key_id, otp}: fetches and tries a key without keeping it
    case 'test':
      if (!str(b.key_id)) return json({ success: false, error: 'INVALID_PAYLOAD', message: 'Cần key_id.' }, 400);
      return vault(async () => ({ test: await testVaultKey(str(b.key_id), str(b.otp)) }));
    default:
      return json({ success: false, error: 'NOT_FOUND', message: `Không có thao tác KeyVault "${params.action}".` }, 404);
  }
});
