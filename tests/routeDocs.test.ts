import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATEWAY_ROUTES } from '../src/api/routeDocs';

const APP_DIR = join(__dirname, '..', 'app');

// Resolve a documented path like /api/ams/:amsId/tray/:trayId/rfid to its app/ route.ts.
// `:param` segments, and literal segments with no static directory (e.g. fans/part), fall back
// to the `[dynamic]` directory, as Next.js routing does.
function findRouteFile(path: string): string | null {
  let dir = APP_DIR;
  for (const segment of path.split('/').filter(Boolean)) {
    const literal = join(dir, segment);
    if (!segment.startsWith(':') && existsSync(literal)) {
      dir = literal;
      continue;
    }
    const dynamic = readdirSync(dir).find((name) => name.startsWith('[') && name.endsWith(']'));
    if (!dynamic) return null;
    dir = join(dir, dynamic);
  }
  const file = join(dir, 'route.ts');
  return existsSync(file) ? file : null;
}

describe('GET /api/routes documentation', () => {
  const httpRoutes = GATEWAY_ROUTES.filter((route) => !route.method.includes('WS'));

  it.each(httpRoutes.map((route) => [`${route.method} ${route.path}`, route] as const))(
    '%s exists as a Next.js route handler',
    (_label, route) => {
      const file = findRouteFile(route.path);
      expect(file, `no app/ route.ts for ${route.path}`).not.toBeNull();
      expect(readFileSync(file!, 'utf8')).toMatch(new RegExp(`\\bas ${route.method}\\b`));
    }
  );
});
