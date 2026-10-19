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
  // Docker image built from slicer/ (headless Bambu Studio). When set, unsliced .3mf projects are sliced for the H2D.
  SLICER_DOCKER_IMAGE: z.string().optional(),
  SLICER_TIMEOUT_MS: z.coerce.number().default(10 * 60_000),
  // Bambu Studio streamed to the browser (docker-compose.studio.yml): URL embedded in the dashboard,
  // and the host folder Studio exports to, which the gateway lists and stages for printing.
  STUDIO_URL: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().url().optional()),
  STUDIO_EXPORT_DIR: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().optional()),
  // Build plate on the printer. Unset: the project's plate, or Textured PEI for a project made for another printer.
  SLICER_BED_TYPE: z
    .preprocess(
      (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
      z.enum(['Textured PEI Plate', 'Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Supertack Plate']).optional()
    ),
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
