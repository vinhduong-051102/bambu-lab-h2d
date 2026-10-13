import type { AMSTray, AmsLoadedTray, PrinterState } from '../PrinterState';

/** `target` of ams_change_filament meaning "unload" */
export const UNLOAD_TARGET = 255;

/**
 * Absolute tray index used by ams_change_filament `target` and ams_mapping:
 * ams_id * 4 + slot for 4-slot units, the ams_id itself for single-slot AMS HT units (128+).
 */
export function trayIndexOf(amsId: number, slotId: number): number {
  return amsId >= 128 ? amsId : amsId * 4 + slotId;
}

/**
 * H2-series `device.extruder.info[].snow / spre / star` pack the slot as (ams_id << 8) | slot_id.
 * ams_id 255 means nothing is loaded; 254 is the external spool. Only AMS trays are returned.
 */
export function decodeExtruderSlot(word: number | null | undefined): { amsId: number; slotId: number } | null {
  if (typeof word !== 'number' || !Number.isInteger(word) || word < 0) return null;
  const amsId = (word >> 8) & 0xff;
  const slotId = word & 0xff;
  if (amsId >= 254) return null;
  return { amsId, slotId };
}

/** Legacy single-extruder printers report the absolute index in print.ams.tray_now / tray_tar / tray_pre */
function decodeLegacyTray(value: unknown): { amsId: number; slotId: number } | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? parseInt(value, 10) : NaN;
  if (!Number.isInteger(n) || n < 0 || n >= 254) return null;
  return n >= 128 ? { amsId: n, slotId: 0 } : { amsId: Math.floor(n / 4), slotId: n % 4 };
}

/**
 * Recomputes which trays are loaded / targeted from the merged state. Runs after every report so
 * partial updates (extruder-only or tray_now-only deltas) still refresh the per-tray flags.
 */
export function deriveAmsActivity(state: PrinterState): PrinterState {
  type Slot = { amsId: number; slotId: number; extruderId: number | null };
  const loaded: Slot[] = [];
  const targets: Slot[] = [];
  const previous: Slot[] = [];

  const h2Extruders = state.extruders.filter((e) => e.snow !== null && e.snow !== undefined);
  if (h2Extruders.length > 0) {
    for (const ext of h2Extruders) {
      const extruderId = Number(ext.id);
      const now = decodeExtruderSlot(ext.snow);
      const tar = decodeExtruderSlot(ext.star);
      const pre = decodeExtruderSlot(ext.spre);
      if (now) loaded.push({ ...now, extruderId });
      if (tar && (!now || trayIndexOf(tar.amsId, tar.slotId) !== trayIndexOf(now.amsId, now.slotId))) {
        targets.push({ ...tar, extruderId });
      }
      if (pre) previous.push({ ...pre, extruderId });
    }
  } else {
    const now = decodeLegacyTray(state.amsTrayNow);
    const tar = decodeLegacyTray(state.amsTrayTar);
    const pre = decodeLegacyTray(state.amsTrayPre);
    if (now) loaded.push({ ...now, extruderId: null });
    if (tar && (!now || tar.amsId !== now.amsId || tar.slotId !== now.slotId)) targets.push({ ...tar, extruderId: null });
    if (pre) previous.push({ ...pre, extruderId: null });
  }

  const index = (s: Slot) => trayIndexOf(s.amsId, s.slotId);
  const activeExtruder = state.temperatures.nozzle.activeNozzleId;
  const active = loaded.find((s) => s.extruderId === activeExtruder) ?? loaded[0] ?? null;

  const amsLoadedTrays: AmsLoadedTray[] = loaded.map((s) => ({
    trayIndex: index(s),
    amsId: s.amsId,
    slotId: s.slotId,
    extruderId: s.extruderId,
  }));

  const ams = (state.ams ?? []).map((unit) => {
    const amsId = Number(unit.id);
    const inUnit = (list: Slot[]) => list.find((s) => s.amsId === amsId)?.slotId ?? null;
    const trays = unit.trays.map((tray): AMSTray => {
      const slotId = Number(tray.id);
      const hit = (list: Slot[]) => list.find((s) => s.amsId === amsId && s.slotId === slotId);
      const loadedIn = hit(loaded);
      return {
        ...tray,
        isActive: !!loadedIn,
        isLoaded: !!loadedIn,
        loadedExtruderId: loadedIn?.extruderId ?? null,
        isTarget: !!hit(targets),
      };
    });
    return {
      ...unit,
      trays,
      activeTrayId: inUnit(loaded),
      targetTrayId: inUnit(targets),
      currentTrayId: inUnit(previous),
    };
  });

  return {
    ...state,
    ams,
    amsLoadedTrays,
    amsActiveTrayId: active ? index(active) : null,
    amsTargetTrayId: targets[0] ? index(targets[0]) : null,
    amsCurrentTrayId: previous[0] ? index(previous[0]) : null,
  };
}

export function findTray(state: PrinterState, amsId: number, slotId: number): AMSTray | null {
  const unit = (state.ams ?? []).find((u) => Number(u.id) === amsId);
  return unit?.trays.find((t) => Number(t.id) === slotId) ?? null;
}

export function findTrayByIndex(state: PrinterState, trayIndex: number): AMSTray | null {
  for (const unit of state.ams ?? []) {
    const amsId = Number(unit.id);
    for (const tray of unit.trays) {
      if (trayIndexOf(amsId, Number(tray.id)) === trayIndex) return tray;
    }
  }
  return null;
}

/** Load temperature for a tray: middle of its recommended nozzle range */
export function trayLoadTemp(tray: AMSTray | null, fallback = 220): number {
  const min = tray?.nozzleTempMin ?? null;
  const max = tray?.nozzleTempMax ?? null;
  if (min !== null && max !== null && min > 0 && max >= min) return Math.round((min + max) / 2);
  return max ?? min ?? fallback;
}
