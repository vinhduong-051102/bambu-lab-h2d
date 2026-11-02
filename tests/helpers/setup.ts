import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Rules learned from retries are written as tasks succeed: tests keep their own, never the gateway's data/ai
process.env.RETRY_RULES_FILE = join(mkdtempSync(join(tmpdir(), 'retry-rules-')), 'retry-rules.json');
