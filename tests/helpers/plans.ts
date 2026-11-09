import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The Claude plans as if fetched from the KeyVault ([id, name, token]), in the tests' own CLAUDE_TOKENS_FILE */
export function setPlans(plans: [string, string, string][]): void {
  const file = process.env.CLAUDE_TOKENS_FILE!;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ plans: plans.map(([id, name, token]) => ({ id, name, token, fetched_at: '2026-11-09T00:00:00.000Z' })), not_claude: [] }));
}

/** Two plans, as most tests want */
export const DEFAULT_PLANS: [string, string, string][] = [
  ['k1', 'cla_one', 'sk-ant-test-one'],
  ['k2', 'cla_two', 'sk-ant-test-two'],
];
