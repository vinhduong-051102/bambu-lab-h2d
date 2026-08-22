import { config } from 'dotenv';
import { z } from 'zod';

config();

// Provide fallback values in test environment if env vars are missing
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

const envSchema = z.object({
  BAMBU_HOST: z.string({
    required_error: 'BAMBU_HOST environment variable is required (e.g. 192.168.1.100)',
  }).default(isTestEnv ? '127.0.0.1' : undefined as any),

  BAMBU_PORT: z.coerce.number().default(8883),

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
