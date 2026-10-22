import { config } from 'dotenv';
import { z } from 'zod';

config();

// Provide fallback values in test environment and during `next build` (route modules are
// evaluated while collecting page data, when printer credentials may not be present)
const isTestEnv =
  process.env.NODE_ENV === 'test' ||
  process.env.VITEST === 'true' ||
  process.env.NEXT_PHASE === 'phase-production-build';

const envSchema = z.object({
  BAMBU_HOST: z.string({
    required_error: 'BAMBU_HOST environment variable is required (e.g. 192.168.1.100)',
  }).default(isTestEnv ? '127.0.0.1' : undefined as any),

  BAMBU_PORT: z.coerce.number().default(8883),
  BAMBU_FTP_PORT: z.coerce.number().default(990),

  BAMBU_SERIAL: z.string({
    required_error: 'BAMBU_SERIAL environment variable is required (e.g. 01S00A123456789)',
  }).default(isTestEnv ? 'TEST_SERIAL_123' : undefined as any),

  BAMBU_ACCESS_CODE: z.string({
    required_error: 'BAMBU_ACCESS_CODE environment variable is required',
  }).default(isTestEnv ? 'TEST_ACCESS_CODE' : undefined as any),

  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().default(3000),

  LOG_LEVEL: z.string().default('info'),
  PRINTER_OFFLINE_TIMEOUT_MS: z.coerce.number().default(30000),
  ENABLE_RAW_API: z
    .string()
    .optional()
    .transform((val) => val === undefined || val === '' || val.toLowerCase() === 'true'),
  GATEWAY_API_KEY: z.string().optional(),
  BAMBU_REAL_PRINTER: z
    .string()
    .optional()
    .transform((val) => val === 'true' || val === '1'),
  BAMBU_DEBUG_PROTOCOL: z
    .string()
    .optional()
    .transform((val) => val === 'true' || val === '1'),
  COMMAND_TIMEOUT_MS: z.coerce.number().default(10000),
  // Bambu Studio streamed to the browser (docker-compose.studio.yml), embedded in the dashboard
  STUDIO_URL: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().url().optional()),
  // Other addresses Studio is published at (comma-separated, e.g. a `tailscale serve` HTTPS port): the one on
  // the host the dashboard was opened from wins over STUDIO_URL
  STUDIO_ALT_URLS: z.preprocess(
    (val) => (typeof val === 'string' ? val.split(',').map((s) => s.trim()).filter(Boolean) : []),
    z.array(z.string().url())
  ),
  // Host folder mounted at /imports in the Studio container: the dashboard drops models there to open in Studio
  STUDIO_IMPORT_DIR: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().optional()),
  // Claude model behind Studio's "AI tối ưu" button (POST /api/studio/ai-optimize); the key is ANTHROPIC_API_KEY
  STUDIO_AI_MODEL: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('claude-opus-5-5')),
  // Where each "AI tối ưu" answer, the changes applied from it and the user's print report are kept
  STUDIO_AI_DATA_DIR: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('./data/studio/ai')),
  // Print history: each print's camera photo when it ended, uploaded photos, the settings Studio sent and the report
  PRINT_HISTORY_DIR: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('./data/prints')),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables configuration:');
  for (const issue of _env.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = _env.data;
export type Env = z.infer<typeof envSchema>;
