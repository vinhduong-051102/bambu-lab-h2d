import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PLANS, setPlans } from './plans';

// Rules learned from retries are written as tasks succeed: tests keep their own, never the gateway's data/ai
process.env.RETRY_RULES_FILE = join(mkdtempSync(join(tmpdir(), 'retry-rules-')), 'retry-rules.json');

// Nothing runs again on its own unless a test turns it on (env.AUTO_RETRY_LIMIT)
process.env.AUTO_RETRY_LIMIT = '0';

// The subscription picked for tasks (Hệ thống → Gói Claude) stays the gateway's: tests start from "auto"
process.env.AI_PLAN_FILE = join(mkdtempSync(join(tmpdir(), 'ai-plan-')), 'plan.json');

// The Claude plans are the tests' own (the KeyVault's are the gateway's): two of them unless a test sets others
process.env.CLAUDE_TOKENS_FILE = join(mkdtempSync(join(tmpdir(), 'claude-plans-')), 'tokens.json');
setPlans(DEFAULT_PLANS);
