import { dropNonVault, guessPlan, isVaultPlan, planSources, testVaultKey, useVaultKey } from '../../domain/ai/keyVault';
import {
  activate,
  claim,
  importApiKey,
  KVError,
  listKeys,
  publicKey,
  reconnect,
  refreshStatus,
  requestAccess,
  reset,
  vaultView,
} from '../../domain/keyvault/keyVaultClient';
import { handler, json, readJsonBody } from '../http';

/**
 * The KeyVault the Claude tokens come from (docs/keyvault.md): registering the gateway step by step, and fetching a
 * plan's token with a code from Google Authenticator. A token's value never reaches the page, only its last 4.
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

/** The registration and each plan's source, from the files here (no network), with the plan each key is guessed for */
async function view() {
  const registration = await vaultView();
  return {
    ...registration,
    keys: registration.keys.map((k) => ({ ...k, guess: guessPlan(k) })),
    plans: await planSources(),
  };
}

// GET /api/keyvault - The registration's stage (none, pending, approved, rejected, claimed, active), the keys granted,
// and where each Claude plan's token comes from
export const getKeyVault = handler(async () => vault(view));

// POST /api/keyvault/<action> - Registering and fetching; each answers with the view above
export const postKeyVault = handler<{ action: string }>(async ({ request, params }) => {
  const b = await body(request);
  switch (params.action) {
    // {name, contact, organization, reason, requested_keys, server?}: asks for access with a key pair made here
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
      return vault(async () => (await activate(str(b.otp)), view()));
    // {api_key, private_key_pem?, server?}: an admin registered the gateway; checked at once with the key list
    case 'import':
      return vault(async () => (await importApiKey(str(b.api_key), str(b.private_key_pem), str(b.server)), view()));
    // The public key for an admin to register (the pair is made here when there is none)
    case 'pubkey':
      return vault(async () => ({ publicKey: await publicKey() }));
    // The keys granted, asked again
    case 'keys':
      return vault(async () => (await listKeys(), view()));
    // Starts registering again, keeping the server and each plan's key; the old files go to .backup-<time>/
    case 'reconnect':
      return vault(async () => ({ backup: await reconnect(), ...(await view()) }));
    // Disconnects; the files go to .backup-<time>/
    case 'reset':
      return vault(async () => ({ backup: await reset(), ...(await view()) }));
    // {plan, otp, key_id?}: fetches the plan's token (key_id, else the one it took before), tries it, keeps it if it works
    case 'use': {
      const plan = b.plan;
      if (!isVaultPlan(plan)) return json({ success: false, error: 'INVALID_PAYLOAD', message: 'plan phải là primary hoặc fallback.' }, 400);
      return vault(async () => ({ used: await useVaultKey(plan, str(b.otp), str(b.key_id) || undefined), ...(await view()) }));
    }
    // {key_id, otp}: fetches and tries a key without keeping it
    case 'test':
      if (!str(b.key_id)) return json({ success: false, error: 'INVALID_PAYLOAD', message: 'Cần key_id.' }, 400);
      return vault(async () => ({ test: await testVaultKey(str(b.key_id), str(b.otp)) }));
    // Stops using the .env tokens of the plans not from the KeyVault (kept in .backup-<time>/)
    case 'drop-others':
      return vault(async () => ({ ...(await dropNonVault()), ...(await view()) }));
    default:
      return json({ success: false, error: 'NOT_FOUND', message: `Không có thao tác KeyVault "${params.action}".` }, 404);
  }
});
