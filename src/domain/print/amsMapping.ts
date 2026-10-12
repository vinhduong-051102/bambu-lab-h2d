import type { PrinterState } from '../PrinterState';
import type { ThreeMfFilament } from '../../bambu/ThreeMfParser';

/**
 * Filament → tray mapping for print.project_file.
 *
 * `ams_mapping` is indexed by project filament (position = 0-based filament index from the
 * slicer) and holds an absolute tray index: 0-15 for 4-slot AMS units (`ams_id * 4 + slot`),
 * 128-135 for single-slot AMS HT units, 254 for the external spool, -1 for unused positions.
 * H2-series firmware also reads `ams_mapping2`, the same table as `{ ams_id, slot_id }` pairs
 * (unused = 255/255). Its length must equal the project's filament count.
 */

export const UNUSED_TRAY = -1;
export const EXTERNAL_SPOOL_TRAY = 254;

export interface AvailableTray {
  trayIndex: number;
  amsId: number;
  slotId: number;
  type: string | null;
  color: string | null;
  isEmpty: boolean;
  label: string;
}

export interface AmsMappingPayload {
  amsMapping: number[];
  amsMapping2: { ams_id: number; slot_id: number }[];
  useAms: boolean;
}

export function listAvailableTrays(state: PrinterState): AvailableTray[] {
  const trays: AvailableTray[] = [];
  for (const unit of state.ams ?? []) {
    const amsId = Number(unit.id);
    if (!Number.isInteger(amsId) || unit.exists === false) continue;
    const isHt = amsId >= 128;

    for (const tray of unit.trays ?? []) {
      const slotId = Number(tray.id);
      if (!Number.isInteger(slotId)) continue;
      const trayIndex = isHt ? amsId : amsId * 4 + slotId;
      trays.push({
        trayIndex,
        amsId,
        slotId,
        type: tray.type || null,
        color: normalizeHex(tray.color),
        isEmpty: tray.isEmpty || !tray.type,
        label: isHt ? `AMS HT ${amsId - 127}` : `AMS ${amsId + 1} – Khay ${slotId + 1}`,
      });
    }
  }
  return trays.sort((a, b) => a.trayIndex - b.trayIndex);
}

/** Picks a loaded tray with the same material and the closest colour for each used filament */
export function suggestMapping(filaments: ThreeMfFilament[], trays: AvailableTray[]): Record<number, number | null> {
  const loaded = trays.filter((t) => !t.isEmpty);
  const taken = new Set<number>();
  const result: Record<number, number | null> = {};

  for (const filament of filaments) {
    const sameType = loaded.filter((t) => sameMaterial(t.type, filament.type));
    const ranked = [...sameType].sort(
      (a, b) => colorDistance(a.color, filament.color) - colorDistance(b.color, filament.color)
    );
    const pick = ranked.find((t) => !taken.has(t.trayIndex)) ?? ranked[0] ?? null;
    result[filament.index] = pick ? pick.trayIndex : null;
    if (pick) taken.add(pick.trayIndex);
  }
  return result;
}

export interface MappingValidation {
  errors: string[];
  warnings: string[];
}

export function validateMapping(
  filaments: ThreeMfFilament[],
  assignment: Record<number, number | null | undefined>,
  trays: AvailableTray[]
): MappingValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byIndex = new Map(trays.map((t) => [t.trayIndex, t]));

  for (const filament of filaments) {
    const label = `Filament ${filament.index + 1} (${filament.type ?? '?'} ${filament.color ?? ''})`.trim();
    const target = assignment[filament.index];

    if (target === undefined || target === null || target === UNUSED_TRAY) {
      errors.push(`${label}: chưa chọn khay nhựa.`);
      continue;
    }
    if (target === EXTERNAL_SPOOL_TRAY) {
      warnings.push(`${label}: dùng cuộn nhựa ngoài (external spool) – kiểm tra cuộn đã được nạp đúng đầu phun.`);
      continue;
    }

    const tray = byIndex.get(target);
    if (!tray) {
      errors.push(`${label}: khay #${target} không tồn tại trên máy in.`);
      continue;
    }
    if (tray.isEmpty) {
      errors.push(`${label}: ${tray.label} đang trống.`);
      continue;
    }
    if (!sameMaterial(tray.type, filament.type)) {
      warnings.push(`${label}: ${tray.label} đang chứa ${tray.type ?? 'không rõ'}, khác loại nhựa đã slice.`);
    }
  }

  const used = filaments.map((f) => assignment[f.index]).filter((t): t is number => typeof t === 'number' && t >= 0 && t !== EXTERNAL_SPOOL_TRAY);
  if (new Set(used).size !== used.length) {
    warnings.push('Nhiều filament dùng chung một khay – chỉ hợp lệ khi chúng thực sự cùng một cuộn nhựa.');
  }

  return { errors, warnings };
}

export function buildAmsMappingPayload(
  projectFilamentCount: number,
  filaments: ThreeMfFilament[],
  assignment: Record<number, number | null | undefined>
): AmsMappingPayload {
  const length = Math.max(projectFilamentCount, ...filaments.map((f) => f.index + 1), 1);
  const amsMapping = Array<number>(length).fill(UNUSED_TRAY);
  for (const filament of filaments) {
    const target = assignment[filament.index];
    if (typeof target === 'number') amsMapping[filament.index] = target;
  }

  const amsMapping2 = amsMapping.map((tray) => {
    if (tray < 0) return { ams_id: 255, slot_id: 255 };
    if (tray === EXTERNAL_SPOOL_TRAY) return { ams_id: 254, slot_id: 254 };
    if (tray >= 128) return { ams_id: tray, slot_id: 0 };
    return { ams_id: Math.floor(tray / 4), slot_id: tray % 4 };
  });

  const useAms = amsMapping.some((tray) => tray >= 0 && tray !== EXTERNAL_SPOOL_TRAY);
  return { amsMapping, amsMapping2, useAms };
}

function sameMaterial(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

function normalizeHex(color: string | null): string | null {
  if (!color) return null;
  const hex = color.replace('#', '');
  return /^[0-9a-fA-F]{6}/.test(hex) ? `#${hex.slice(0, 6).toUpperCase()}` : null;
}

function colorDistance(a: string | null, b: string | null): number {
  if (!a || !b) return Number.MAX_SAFE_INTEGER;
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return pa.reduce((sum, v, i) => sum + (v - pb[i]) ** 2, 0);
}
