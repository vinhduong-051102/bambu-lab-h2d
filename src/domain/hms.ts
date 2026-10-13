/** HMS code as shown in Bambu's wiki/app, e.g. "0700-2000-0002-0001" */
export function formatHms(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const { attr, code } = entry as { attr?: unknown; code?: unknown };
  if (typeof attr !== 'number' || typeof code !== 'number') return null;
  const a = (attr >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const c = (code >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return `${a.slice(0, 4)}-${a.slice(4)}-${c.slice(0, 4)}-${c.slice(4)}`;
}

// HMS module byte (top byte of attr): 0x07 = AMS / AMS 2 Pro units, 0x12 = AMS lite, 0x18 = AMS HT
const AMS_HMS_MODULES = new Set([0x07, 0x12, 0x18]);

export function isAmsHms(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const { attr } = entry as { attr?: unknown };
  return typeof attr === 'number' && AMS_HMS_MODULES.has((attr >>> 24) & 0xff);
}
