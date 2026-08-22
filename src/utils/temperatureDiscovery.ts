export interface DiscoveredTempField {
  path: string;
  value: unknown;
}

/**
 * Recursively inspects raw MQTT payload to discover any keys matching temperature-related patterns.
 * Matches: 'temp', 'temperature', 'temper', 'htar', 'hnow', 'hpre'
 */
export function discoverTemperatureFields(obj: unknown, prefix = 'print'): DiscoveredTempField[] {
  const results: DiscoveredTempField[] = [];
  if (!obj || typeof obj !== 'object') return results;

  const tempRegex = /(temp|temperature|temper|htar|hnow|hpre)/i;

  const walk = (curr: any, path: string) => {
    if (curr === null || curr === undefined) return;
    if (typeof curr === 'object') {
      if (Array.isArray(curr)) {
        curr.forEach((item, idx) => walk(item, `${path}[${idx}]`));
      } else {
        for (const [k, v] of Object.entries(curr)) {
          const newPath = path ? `${path}.${k}` : k;
          if (tempRegex.test(k)) {
            results.push({ path: newPath, value: v });
          }
          if (typeof v === 'object' && v !== null) {
            walk(v, newPath);
          }
        }
      }
    }
  };

  walk(obj, prefix);
  return results;
}
