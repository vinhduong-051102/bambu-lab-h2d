import { config } from 'dotenv';
import { z } from 'zod';

config();

// Provide fallback values in test environment and during `next build` (route modules are
// evaluated while collecting page data, when printer credentials may not be present)
const isTestEnv =
  process.env.NODE_ENV === 'test' ||
  process.env.VITEST === 'true' ||
  process.env.NEXT_PHASE === 'phase-production-build';

/**
 * A setting the gateway can't run without; tests get `testValue`. Zod returns a default without checking it,
 * so outside tests there is no default at all and a missing value fails with `message`.
 */
const required = (message: string, testValue: string) =>
  isTestEnv ? z.string().default(testValue) : z.string({ error: (issue) => (issue.input === undefined ? message : undefined) });

const envSchema = z.object({
  BAMBU_HOST: required('BAMBU_HOST environment variable is required (e.g. 192.168.1.100)', '127.0.0.1'),

  BAMBU_PORT: z.coerce.number().default(8883),
  BAMBU_FTP_PORT: z.coerce.number().default(990),

  BAMBU_SERIAL: required('BAMBU_SERIAL environment variable is required (e.g. 01S00A123456789)', 'TEST_SERIAL_123'),

  BAMBU_ACCESS_CODE: required('BAMBU_ACCESS_CODE environment variable is required', 'TEST_ACCESS_CODE'),

  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().default(3000),
  // HTTPS next to HTTP (unset turns it off): browsers only allow some features on secure pages away from localhost
  HTTPS_PORT: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.coerce.number().optional()),
  // A certificate of your own, or a self-signed one made here on first start for HTTPS_HOSTNAMES
  HTTPS_CERT_FILE: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('./data/certs/gateway.crt')),
  HTTPS_KEY_FILE: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('./data/certs/gateway.key')),
  // Names and IPs the dashboard is opened with (comma-separated): LAN IP, Tailscale IP or name
  HTTPS_HOSTNAMES: z.preprocess(
    (val) => (typeof val === 'string' ? val.split(',').map((s) => s.trim()).filter(Boolean) : []),
    z.array(z.string())
  ),

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
  // Studio's container runs on the gateway's host although the gateway can't see that host's addresses (the
  // gateway in its own container): STUDIO_URL is then pointed at the host the dashboard was opened with
  STUDIO_ON_GATEWAY_HOST: z
    .string()
    .optional()
    .transform((val) => val === 'true' || val === '1'),
  // Host folder mounted at /imports in the Studio container: the dashboard drops models there to open in Studio
  STUDIO_IMPORT_DIR: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().optional()),
  // Claude model behind Studio's "AI tối ưu" button (POST /api/studio/ai-optimize); the key is ANTHROPIC_API_KEY
  STUDIO_AI_MODEL: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('claude-opus-5-5')),
  // Where each "AI tối ưu" answer, the changes applied from it and the user's print report are kept
  // "Thành phần của mẫu": each model's measured parts and renders (mounted at /analyses in the mesh3d container)
  MODEL_ANALYSIS_DIR: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('./data/studio/analyses')),
  // Claude model that names a model's parts from its renders (claude -p on this machine, like the timelapse review)
  PARTS_AI_MODEL: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('claude-opus-5-5')),
  STUDIO_AI_DATA_DIR: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('./data/studio/ai')),
  // Print history: each print's camera photo when it ended, uploaded photos, the settings Studio sent and the report
  PRINT_HISTORY_DIR: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('./data/prints')),
  // Timelapse videos and thumbnails copied from the printer the first time they are watched
  TIMELAPSE_CACHE_DIR: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('./data/timelapse')),
  // The Claude model that reviews timelapses ("AI nhận xét"), through `claude -p` on CLAUDE_CODE_OAUTH_TOKEN
  TIMELAPSE_AI_MODEL: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('claude-opus-5-5')),
  // CAD worker container (docker-compose.cad.yml) behind "Thiết kế mô hình bằng AI"; unset turns the feature off
  CAD_WORKER_URL: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().url().optional()),
  // Host folder mounted at /jobs in the CAD container: one folder per model, with its code, files and status
  CAD_JOBS_DIR: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('./data/cad/jobs')),
  // Mesh worker container (docker-compose.mesh3d.yml): figures shaped by Hunyuan3D-2 from a picture, or made from a
  // description, and finished by Claude in Blender (MCP for Blender)
  MESH_WORKER_URL: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().url().optional()),
  // Bambu Lab's filament colour catalogue (from Bambu Studio's repository), cached here after the first download
  BAMBU_COLOR_CODES_FILE: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('./data/bambu/filaments_color_codes.json')),
  // Bambu Studio's colour mixing recipes, cached here after the first download
  BAMBU_MIX_RECIPES_FILE: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('./data/bambu/standard_color_recipes.json')),
  // "Filament của tôi": filaments the user saved for painting figures
  CUSTOM_FILAMENTS_FILE: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('./data/filaments/custom.json')),
  // Claude model the dashboard offers first for new models (the CAD container's CAD_AI_MODEL is its own default)
  CAD_AI_MODEL: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().default('claude-opus-5-5')),
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
