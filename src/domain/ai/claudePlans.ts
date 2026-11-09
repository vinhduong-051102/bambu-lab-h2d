/**
 * The Claude plans the project runs on, as fetched from the KeyVault (src/domain/ai/keyVault.ts): CLAUDE_TOKENS_FILE
 * (data/secrets/claude/tokens.json, mode 600), {plans: [{id, name, token, fetched_at}], not_claude: [key ids]}, in the
 * KeyVault's order, which "auto" goes through. Read on each use, here and by the CAD, mesh3d and Studio containers
 * (which mount the folder), so a new token is in use at once.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { writeSecret } from '../keyvault/keyVaultClient';

export interface StoredPlan {
  id: string;
  name: string;
  token: string;
  fetched_at: string;
}

export interface TokensFile {
  plans: StoredPlan[];
  /** Keys fetched once that turned out not to be Claude tokens: not offered as plans */
  not_claude: string[];
}

const tokensFile = () => path.resolve(process.env.CLAUDE_TOKENS_FILE || './data/secrets/claude/tokens.json');
export const last4 = (token: string) => (token ? `••••${token.slice(-4)}` : '');

export function readTokens(): TokensFile {
  try {
    const data = JSON.parse(readFileSync(tokensFile(), 'utf8'));
    return {
      plans: Array.isArray(data?.plans) ? data.plans.filter((p: StoredPlan) => p?.id && typeof p.token === 'string' && p.token.trim()) : [],
      not_claude: Array.isArray(data?.not_claude) ? data.not_claude : [],
    };
  } catch {
    return { plans: [], not_claude: [] };
  }
}

export async function writeTokens(data: TokensFile): Promise<void> {
  await writeSecret(tokensFile(), JSON.stringify(data, null, 2));
}

/** The plans with a token, in the KeyVault's order: what the gateway and the workers run on */
export function claudePlans(): StoredPlan[] {
  return readTokens().plans;
}

/** Their tokens, each once, in order */
export function planTokens(): string[] {
  return [...new Set(claudePlans().map((p) => p.token.trim()))];
}
