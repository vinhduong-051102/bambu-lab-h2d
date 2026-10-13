import { createHash } from 'crypto';
import { strFromU8, unzipSync } from 'fflate';

/**
 * Reads the parts of a Bambu Studio / OrcaSlicer 3MF project that a LAN print needs:
 * which plates are sliced (Metadata/plate_N.gcode), which project filaments each plate uses,
 * and the slicer's extruder assignment for dual-nozzle printers such as the H2D.
 */

export interface ThreeMfFilament {
  /** 0-based project filament index: the position of this filament in print.ams_mapping */
  index: number;
  type: string | null;
  color: string | null;
  trayInfoIdx: string | null;
  usedGrams: number | null;
  usedMeters: number | null;
  /** Slicer extruder assignment from filament_maps (1-based); null when the project has none */
  extruder: number | null;
}

export interface ThreeMfPlate {
  index: number;
  gcodePath: string;
  gcodeMd5: string;
  name: string | null;
  filaments: ThreeMfFilament[];
  predictionSeconds: number | null;
  weightGrams: number | null;
  /** data: URI of the plate preview image, when the project contains one */
  thumbnail: string | null;
  warnings: string[];
}

export interface ThreeMfInfo {
  plates: ThreeMfPlate[];
  /** Number of filaments defined in the project; the required length of print.ams_mapping */
  projectFilamentCount: number;
  printerModelId: string | null;
  printerModel: string | null;
  nozzleDiameters: string | null;
  slicerVersion: string | null;
}

export class ThreeMfParseError extends Error {
  constructor(message: string, public code: 'INVALID_3MF' | 'NOT_SLICED') {
    super(message);
    this.name = 'ThreeMfParseError';
  }
}

const PLATE_GCODE_RE = /^Metadata\/plate_(\d+)\.gcode$/;
const MAX_THUMBNAIL_BYTES = 512 * 1024;

export function parseThreeMf(data: Uint8Array): ThreeMfInfo {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (file) =>
        file.name.startsWith('Metadata/') &&
        (PLATE_GCODE_RE.test(file.name) ||
          /\.(config|json|md5)$/.test(file.name) ||
          (/^Metadata\/plate_\d+\.png$/.test(file.name) && file.originalSize <= MAX_THUMBNAIL_BYTES)),
    });
  } catch (err) {
    throw new ThreeMfParseError(
      `File is not a valid 3MF archive: ${err instanceof Error ? err.message : String(err)}`,
      'INVALID_3MF'
    );
  }

  const text = (name: string): string | null => (entries[name] ? strFromU8(entries[name]) : null);

  const plateIndexes = Object.keys(entries)
    .map((name) => PLATE_GCODE_RE.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);

  if (plateIndexes.length === 0) {
    throw new ThreeMfParseError(
      'File 3MF chưa được slice (không có Metadata/plate_N.gcode). Hãy slice trong Bambu Studio và xuất bằng "Export plate sliced file" (.gcode.3mf), hoặc bật slice tự động trên gateway (SLICER_DOCKER_IMAGE).',
      'NOT_SLICED'
    );
  }

  const sliceInfo = parseSliceInfo(text('Metadata/slice_info.config'));
  const projectSettings = parseJson(text('Metadata/project_settings.config'));
  const modelSettings = text('Metadata/model_settings.config');

  const plates: ThreeMfPlate[] = plateIndexes.map((index) => {
    const gcodePath = `Metadata/plate_${index}.gcode`;
    const gcode = entries[gcodePath];
    const md5File = text(`${gcodePath}.md5`)?.trim();
    const gcodeMd5 = md5File && /^[0-9a-fA-F]{32}$/.test(md5File)
      ? md5File.toUpperCase()
      : createHash('md5').update(gcode).digest('hex').toUpperCase();

    const slicePlate = sliceInfo.plates.get(index);
    const plateJson = parseJson(text(`Metadata/plate_${index}.json`));
    const filamentMaps = parseNumberList(slicePlate?.metadata.filament_maps ?? null);

    let filaments: ThreeMfFilament[];
    if (slicePlate && slicePlate.filaments.length > 0) {
      filaments = slicePlate.filaments.map((f) => {
        const position = Number(f.id) - 1;
        return {
          index: position,
          type: f.type ?? null,
          color: normalizeColor(f.color),
          trayInfoIdx: f.tray_info_idx ?? null,
          usedGrams: toNumber(f.used_g),
          usedMeters: toNumber(f.used_m),
          extruder: filamentMaps?.[position] ?? null,
        };
      });
    } else {
      // Fallback for projects without slice_info: plate_N.json lists 0-based filament ids
      const ids = Array.isArray(plateJson?.filament_ids) ? (plateJson.filament_ids as unknown[]) : [0];
      const colors = Array.isArray(plateJson?.filament_colors) ? (plateJson.filament_colors as unknown[]) : [];
      filaments = ids.map((id, i) => ({
        index: Number(id),
        type: listItem(projectSettings?.filament_type, Number(id)),
        color: normalizeColor(typeof colors[i] === 'string' ? (colors[i] as string) : listItem(projectSettings?.filament_colour, Number(id))),
        trayInfoIdx: listItem(projectSettings?.filament_ids, Number(id)),
        usedGrams: null,
        usedMeters: null,
        extruder: filamentMaps?.[Number(id)] ?? null,
      }));
    }
    filaments = filaments.filter((f) => Number.isInteger(f.index) && f.index >= 0).sort((a, b) => a.index - b.index);

    const thumb = entries[`Metadata/plate_${index}.png`];

    return {
      index,
      gcodePath,
      gcodeMd5,
      name: plateName(modelSettings, index),
      filaments,
      predictionSeconds: toNumber(slicePlate?.metadata.prediction),
      weightGrams: toNumber(slicePlate?.metadata.weight),
      thumbnail: thumb ? `data:image/png;base64,${Buffer.from(thumb).toString('base64')}` : null,
      warnings: slicePlate?.warnings ?? [],
    };
  });

  const usedMax = Math.max(0, ...plates.flatMap((p) => p.filaments.map((f) => f.index + 1)));
  const settingsCount = Array.isArray(projectSettings?.filament_colour)
    ? (projectSettings.filament_colour as unknown[]).length
    : Array.isArray(projectSettings?.filament_type)
      ? (projectSettings.filament_type as unknown[]).length
      : 0;
  const headerCount = gcodeHeaderFilamentCount(entries[plates[0].gcodePath]);
  const projectFilamentCount = Math.max(usedMax, settingsCount || headerCount || 0, 1);

  const firstPlate = sliceInfo.plates.get(plates[0].index);
  return {
    plates,
    projectFilamentCount,
    printerModelId: firstPlate?.metadata.printer_model_id ?? null,
    printerModel: typeof projectSettings?.printer_model === 'string' ? projectSettings.printer_model : null,
    nozzleDiameters: firstPlate?.metadata.nozzle_diameters ?? null,
    slicerVersion: sliceInfo.clientVersion,
  };
}

interface SliceInfoPlate {
  metadata: Record<string, string>;
  filaments: Record<string, string>[];
  warnings: string[];
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    attrs[m[1]] = decodeXml(m[2]);
  }
  return attrs;
}

function parseSliceInfo(xml: string | null): { plates: Map<number, SliceInfoPlate>; clientVersion: string | null } {
  const plates = new Map<number, SliceInfoPlate>();
  if (!xml) return { plates, clientVersion: null };

  let clientVersion: string | null = null;
  for (const m of xml.matchAll(/<header_item\b[^>]*>/g)) {
    const attrs = parseAttributes(m[0]);
    if (attrs.key === 'X-BBL-Client-Version') clientVersion = attrs.value ?? null;
  }

  for (const block of xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const body = block[1];
    const metadata: Record<string, string> = {};
    for (const m of body.matchAll(/<metadata\b[^>]*>/g)) {
      const attrs = parseAttributes(m[0]);
      if (attrs.key) metadata[attrs.key] = attrs.value ?? '';
    }
    const filaments = [...body.matchAll(/<filament\b[^>]*>/g)].map((m) => parseAttributes(m[0]));
    const warnings = [...body.matchAll(/<warning\b[^>]*>/g)]
      .map((m) => parseAttributes(m[0]).msg)
      .filter((msg): msg is string => Boolean(msg));
    const index = Number(metadata.index);
    if (Number.isInteger(index)) plates.set(index, { metadata, filaments, warnings });
  }

  return { plates, clientVersion };
}

function plateName(modelSettings: string | null, index: number): string | null {
  if (!modelSettings) return null;
  for (const block of modelSettings.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const meta: Record<string, string> = {};
    for (const m of block[1].matchAll(/<metadata\b[^>]*>/g)) {
      const attrs = parseAttributes(m[0]);
      if (attrs.key) meta[attrs.key] = attrs.value ?? '';
    }
    if (Number(meta.plater_id) === index) return meta.plater_name || null;
  }
  return null;
}

/** Counts `; filament_colour = #A;#B` in the gcode config block near the start of the file */
function gcodeHeaderFilamentCount(gcode: Uint8Array | undefined): number {
  if (!gcode) return 0;
  const head = strFromU8(gcode.subarray(0, 64 * 1024));
  const m = /^;\s*filament_colour\s*=\s*(.+)$/m.exec(head);
  return m ? m[1].split(';').filter((c) => c.trim()).length : 0;
}

function parseJson(raw: string | null): Record<string, any> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function parseNumberList(raw: string | null): number[] | null {
  if (!raw) return null;
  const values = raw.trim().split(/[\s,]+/).map(Number);
  return values.length > 0 && values.every(Number.isFinite) ? values : null;
}

function listItem(list: unknown, index: number): string | null {
  return Array.isArray(list) && typeof list[index] === 'string' ? list[index] : null;
}

function toNumber(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeColor(color: string | undefined | null): string | null {
  if (!color) return null;
  const hex = color.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return null;
  return `#${hex.slice(0, 6).toUpperCase()}`;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
