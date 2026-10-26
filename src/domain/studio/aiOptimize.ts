import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { z } from 'zod';
import type { PrinterState } from '../PrinterState';

/**
 * "AI tối ưu" in Bambu Studio: Studio describes the open plate (presets, the process and filament
 * settings with how Studio defines each one, object geometry), Claude proposes setting changes, and
 * only checked ones come back. Studio shows them to the user and applies the accepted ones to the
 * edited process preset and to one filament preset.
 */

type SettingSpec =
  | { kind: 'float'; min: number; max: number; label: string }
  | { kind: 'int'; min: number; max: number; label: string }
  | { kind: 'percent'; min: number; max: number; label: string }
  | { kind: 'bool'; label: string }
  | { kind: 'enum'; values: readonly string[]; label: string }
  // One value per H2D extruder variant ("200,200"); the AI gives one value and it goes to every variant
  | { kind: 'floats'; min: number; max: number; label: string }
  | { kind: 'bools'; label: string };

// The main process (print preset) settings, with Vietnamese labels and ranges tighter than Studio's own
// (src/libslic3r/PrintConfig.cpp, v02.08.04.57). Every other setting Studio describes is open to the AI
// too, within Studio's limits (see allowedOption); these are listed first and checked more strictly.
export const AI_SETTINGS = {
  layer_height: { kind: 'float', min: 0.04, max: 0.6, label: 'Chiều cao lớp' },
  initial_layer_print_height: { kind: 'float', min: 0.08, max: 0.6, label: 'Chiều cao lớp đầu' },
  wall_loops: { kind: 'int', min: 1, max: 10, label: 'Số vòng tường' },
  top_shell_layers: { kind: 'int', min: 0, max: 30, label: 'Số lớp vỏ trên' },
  bottom_shell_layers: { kind: 'int', min: 0, max: 30, label: 'Số lớp vỏ dưới' },
  top_shell_thickness: { kind: 'float', min: 0, max: 5, label: 'Độ dày vỏ trên' },
  bottom_shell_thickness: { kind: 'float', min: 0, max: 5, label: 'Độ dày vỏ dưới' },
  ensure_vertical_shell_thickness: { kind: 'enum', values: ['disabled', 'partial', 'enabled'], label: 'Đảm bảo độ dày vỏ đứng' },
  sparse_infill_density: { kind: 'percent', min: 0, max: 100, label: 'Mật độ infill' },
  sparse_infill_pattern: {
    kind: 'enum',
    values: ['zig-zag', 'grid', 'line', 'cubic', 'triangles', 'tri-hexagon', 'gyroid', 'honeycomb', 'adaptivecubic', '3dhoneycomb', 'supportcubic', 'lightning', 'crosshatch'],
    label: 'Kiểu infill',
  },
  top_surface_pattern: {
    kind: 'enum',
    values: ['concentric', 'zig-zag', 'monotonic', 'monotonicline', 'alignedrectilinear', 'hilbertcurve', 'archimedeanchords', 'octagramspiral'],
    label: 'Kiểu bề mặt trên',
  },
  wall_generator: { kind: 'enum', values: ['classic', 'arachne'], label: 'Bộ tạo tường' },
  wall_sequence: { kind: 'enum', values: ['inner wall/outer wall', 'outer wall/inner wall', 'inner-outer-inner wall'], label: 'Thứ tự in tường' },
  seam_position: { kind: 'enum', values: ['nearest', 'aligned', 'back', 'random'], label: 'Vị trí đường nối' },
  ironing_type: { kind: 'enum', values: ['no ironing', 'top', 'topmost', 'solid'], label: 'Là phẳng (ironing)' },
  detect_overhang_wall: { kind: 'bool', label: 'Nhận diện tường nhô' },
  thick_bridges: { kind: 'bool', label: 'Cầu dày' },
  outer_wall_speed: { kind: 'floats', min: 10, max: 600, label: 'Tốc độ tường ngoài' },
  inner_wall_speed: { kind: 'floats', min: 10, max: 600, label: 'Tốc độ tường trong' },
  sparse_infill_speed: { kind: 'floats', min: 10, max: 600, label: 'Tốc độ infill' },
  enable_overhang_speed: { kind: 'bools', label: 'Giảm tốc ở phần nhô' },
  enable_support: { kind: 'bool', label: 'Bật support' },
  // Manual support types only print where the user painted, so the AI sticks to the automatic ones
  support_type: { kind: 'enum', values: ['normal(auto)', 'tree(auto)'], label: 'Loại support' },
  support_style: { kind: 'enum', values: ['default', 'grid', 'snug', 'tree_slim', 'tree_strong', 'tree_hybrid', 'tree_organic'], label: 'Kiểu support' },
  support_threshold_angle: { kind: 'int', min: 0, max: 90, label: 'Góc ngưỡng support' },
  support_on_build_plate_only: { kind: 'bool', label: 'Support chỉ từ bàn in' },
  support_top_z_distance: { kind: 'float', min: 0, max: 0.5, label: 'Khe hở Z trên support' },
  support_bottom_z_distance: { kind: 'float', min: 0, max: 0.5, label: 'Khe hở Z dưới support' },
  support_interface_top_layers: { kind: 'int', min: 0, max: 5, label: 'Số lớp tiếp xúc trên support' },
  support_object_xy_distance: { kind: 'float', min: 0, max: 3, label: 'Khoảng cách XY support–vật' },
  tree_support_branch_angle: { kind: 'float', min: 0, max: 60, label: 'Góc nhánh support cây' },
  raft_layers: { kind: 'int', min: 0, max: 10, label: 'Số lớp raft' },
  brim_type: { kind: 'enum', values: ['auto_brim', 'outer_only', 'inner_only', 'outer_and_inner', 'no_brim'], label: 'Kiểu brim' },
  brim_width: { kind: 'float', min: 0, max: 20, label: 'Độ rộng brim' },
  elefant_foot_compensation: { kind: 'float', min: 0, max: 1, label: 'Bù chân voi' },
  xy_hole_compensation: { kind: 'float', min: -1, max: 1, label: 'Bù kích thước lỗ XY' },
  xy_contour_compensation: { kind: 'float', min: -1, max: 1, label: 'Bù kích thước đường bao XY' },
} as const satisfies Record<string, SettingSpec>;

export type AiSettingKey = keyof typeof AI_SETTINGS;
const AI_SETTING_KEYS = Object.keys(AI_SETTINGS) as AiSettingKey[];

/**
 * How Studio defines a setting (its ConfigOptionDef): the value type, one value per extruder variant or
 * not, the label in Studio's language, and the limits Studio's own editor enforces.
 */
const studioOptionSchema = z.object({
  type: z.enum(['float', 'int', 'percent', 'float_or_percent', 'bool', 'enum']),
  vector: z.boolean().default(false),
  label: z.string().default(''),
  category: z.string().default(''),
  unit: z.string().default(''),
  min: z.number().optional(),
  max: z.number().optional(),
  values: z.array(z.string()).optional(),
  mode: z.enum(['simple', 'advanced', 'develop']).default('simple'),
});
export type StudioOption = z.infer<typeof studioOptionSchema>;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/**
 * What Studio writes when the button is clicked (studio/bambustudio/ai-button.patch). Version 1 (Studio
 * before the filament settings) sends neither the definitions nor the filament settings: the AI then
 * only gets AI_SETTINGS.
 */
export const studioRequestSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  goal: z.enum(['balanced', 'quality', 'speed', 'strength', 'material']).default('balanced'),
  printer_preset: z.string(),
  process_preset: z.string(),
  nozzle_diameters: z.array(z.number()),
  filaments: z.array(
    z.object({
      preset: z.string(),
      type: z.string().optional(),
      // On the current plate; filaments that print nothing only show by name
      used: z.boolean().optional(),
      // Extruder variants, in the order of the per-variant values ("Direct Drive Standard", ...)
      variants: z.array(z.string()).optional(),
      settings: z.record(z.string(), z.string()).optional(),
    })
  ),
  settings: z.record(z.string(), z.string()),
  process_variants: z.array(z.string()).optional(),
  options: z.record(z.string(), studioOptionSchema).optional(),
  objects: z
    .array(
      z.object({
        name: z.string(),
        instances: z.number().int(),
        size_mm: vec3,
        volume_mm3: z.number(),
        surface_area_mm2: z.number(),
        base_area_mm2: z.number(),
        overhang_area_mm2: z.number(),
        triangles: z.number().int(),
      })
    )
    .max(200),
  // "Hỏi lại AI" in Studio's result dialog: the session being answered and what the user said about it
  follow_up: z.object({ session_id: z.string(), comment: z.string().trim().min(1).max(2000) }).optional(),
});
export type StudioRequest = z.infer<typeof studioRequestSchema>;

/** The proposal a re-ask answers, and the user's comment on it */
export interface FollowUp {
  previous: { summary: string; changes: AiChange[] } | null;
  comment: string;
}

/** An earlier plate like this one, printed with the changes the user applied, and how it came out */
export interface PastPrint {
  created_at: string;
  goal: StudioRequest['goal'];
  process_preset: string;
  filaments: string[];
  objects: string[];
  /** Applied changes by settingRef, with the value each replaced (null when it was not kept) */
  changes: { key: string; label?: string; before: string | null; after: string }[];
  outcome: string;
  issues: string[];
  note: string;
  /** What the local AI saw in the print's timelapse; a small model, so weighed below the user's report */
  video_review?: string;
}

/**
 * Which preset a change goes to. Process changes carry neither field, as before filaments could be
 * changed; a filament change names the filament (1-based, as Studio numbers them) and its preset.
 */
export interface FilamentTarget {
  target?: 'filament';
  filament?: number;
  preset?: string;
}

export interface AiChange extends FilamentTarget {
  key: string;
  label: string;
  /** Studio's serialized form, e.g. "0.16", "15%", "1", "gyroid", "220,230" */
  value: string;
  reason: string;
}

export interface AiRejected extends FilamentTarget {
  key: string;
  value: string;
  reason: string;
}

/** One setting across sessions and print reports: "layer_height", or "filament#2:nozzle_temperature" */
export function settingRef(change: { key: string; target?: string; filament?: number }): string {
  return change.target === 'filament' ? `filament#${change.filament}:${change.key}` : change.key;
}

export interface AiOptimizeResult {
  summary: string;
  changes: AiChange[];
  rejected: AiRejected[];
}

/**
 * One proposal as the model writes it. Keys and values are free text, checked against the settings of
 * the plate afterwards: those differ from plate to plate, and a fixed schema stays in the API's cache.
 */
export const PROPOSAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['process', 'filament'] },
          filament: { type: 'integer' },
          key: { type: 'string' },
          value: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['target', 'filament', 'key', 'value', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'changes'],
  additionalProperties: false,
} as const;

// Sent as written: the API enforces the target enum, which the SDK's transform would demote to a description
const proposalFormat = jsonSchemaOutputFormat(PROPOSAL_JSON_SCHEMA, { transform: false });

export interface AiProposal {
  summary: string;
  /** target defaults to "process"; filament is 1-based and only read for target "filament" */
  changes: { target?: 'process' | 'filament'; filament?: number; key: string; value: string; reason: string }[];
}

/** A proposal made outside the gateway (`claude -p` in Studio's container), sent back to be checked */
export const aiProposalSchema = z.object({
  summary: z.string(),
  changes: z
    .array(
      z.object({
        target: z.enum(['process', 'filament']).default('process'),
        filament: z.number().int().default(0),
        key: z.string(),
        value: z.string(),
        reason: z.string(),
      })
    )
    // Room for every setting of the process and a filament preset, when the user asks to change them all
    .max(800),
});

const round = (n: number, digits: number) => Number(n.toFixed(digits));

function parseBool(text: string): '1' | '0' | null {
  if (['1', 'true', 'yes', 'on'].includes(text)) return '1';
  if (['0', 'false', 'no', 'off'].includes(text)) return '0';
  return null;
}

/**
 * A per-variant setting ("200,200") set to one value: every variant Studio has a value for gets it, and
 * "nil" (a variant left to the printer preset) stays nil. A list from the model must hold a single value.
 */
function normalizeVector(
  raw: string,
  current: string | undefined,
  parse: (text: string) => string | { error: string }
): { value: string } | { error: string } {
  if (current === undefined) return { error: 'Studio không gửi giá trị hiện tại của tham số này' };
  const values = [...new Set(raw.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean))];
  if (values.length !== 1) return { error: `"${raw}" phải là một giá trị cho mọi đầu phun` };
  const parsed = parse(values[0]);
  if (typeof parsed !== 'string') return parsed;
  return { value: current.split(',').map((v) => (v.trim() === 'nil' ? 'nil' : parsed)).join(',') };
}

/** First non-nil value of a per-variant setting: the one the model sees and answers for */
function firstVariant(current: string): number | null {
  const first = current.split(',').find((v) => v.trim() !== 'nil');
  const n = first === undefined ? NaN : Number(first);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A per-variant speed ("200,500,500,200"): the model gives the new value of the first variant, and every
 * variant is scaled by the same ratio, so High Flow variants stay as much faster as their preset made them.
 * It may also give one value per variant. "nil" stays nil.
 */
function scaleVector(raw: string, current: string | undefined, spec: { min: number; max: number }): { value: string } | { error: string } {
  if (current === undefined) return { error: 'Studio không gửi giá trị hiện tại của tham số này' };
  const reference = firstVariant(current);
  if (reference === null) return { error: `Không có giá trị hiện tại để làm mốc (${current})` };
  const speed = (text: string): number | { error: string } => {
    const n = Number(text.replace(/mm\/s$/, '').trim());
    if (!Number.isFinite(n)) return { error: `"${raw}" không phải số` };
    if (n < spec.min || n > spec.max) return { error: `${n} nằm ngoài khoảng ${spec.min}–${spec.max}` };
    return n;
  };
  const parts = raw.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
  const now = current.split(',').map((v) => v.trim());
  // One value per variant, in order: taken as given, nil variants staying nil
  if (parts.length === now.length && new Set(parts).size > 1) {
    const values: string[] = [];
    for (const [i, part] of parts.entries()) {
      if (now[i] === 'nil') {
        values.push('nil');
        continue;
      }
      const n = speed(part);
      if (typeof n !== 'number') return n;
      values.push(String(round(n, 1)));
    }
    return { value: values.join(',') };
  }
  const values = [...new Set(parts)];
  if (values.length !== 1) return { error: `"${raw}" phải là một giá trị cho đầu phun đầu tiên, hoặc ${now.length} giá trị theo thứ tự biến thể` };
  const n = speed(values[0]);
  if (typeof n !== 'number') return n;
  const ratio = n / reference;
  return { value: current.split(',').map((v) => (v.trim() === 'nil' ? 'nil' : String(round(Number(v) * ratio, 1)))).join(',') };
}

/**
 * The model's value for `key` in Studio's serialized form, or an error message.
 * Out-of-range numbers are rejected rather than clamped: a clamped value is one nobody reasoned about.
 * `current` is Studio's value: per-variant settings take their number of values from it.
 */
export function normalizeValue(
  key: AiSettingKey,
  raw: string,
  nozzleDiameters: number[],
  current?: string
): { value: string } | { error: string } {
  const spec: SettingSpec = AI_SETTINGS[key];
  const text = raw.trim().toLowerCase();
  switch (spec.kind) {
    case 'bool': {
      const value = parseBool(text);
      return value ? { value } : { error: `"${raw}" không phải giá trị bật/tắt` };
    }
    case 'bools':
      return normalizeVector(raw, current, (v) => parseBool(v) ?? { error: `"${raw}" không phải giá trị bật/tắt` });
    case 'floats':
      return scaleVector(raw, current, spec);
    case 'enum':
      return spec.values.includes(text) ? { value: text } : { error: `"${raw}" không nằm trong ${spec.values.join(', ')}` };
    default: {
      const n = Number(text.replace(/%$/, '').replace(/mm$/, '').trim());
      if (!Number.isFinite(n)) return { error: `"${raw}" không phải số` };
      if (spec.kind === 'int' && !Number.isInteger(n)) return { error: `"${raw}" phải là số nguyên` };
      if (n < spec.min || n > spec.max) return { error: `${n} nằm ngoài khoảng ${spec.min}–${spec.max}` };
      // Layers thicker than ~75% of the smallest nozzle don't bond
      const nozzle = Math.min(...nozzleDiameters.filter((d) => d > 0));
      if ((key === 'layer_height' || key === 'initial_layer_print_height') && Number.isFinite(nozzle) && n > nozzle * 0.75 + 1e-9) {
        return { error: `${n} mm dày hơn 75% đầu phun ${nozzle} mm` };
      }
      if (spec.kind === 'percent') return { value: `${round(n, 2)}%` };
      return { value: String(spec.kind === 'int' ? n : round(n, 3)) };
    }
  }
}

/** Studio serializes the same value in its own way ("15%" vs "15.00%", "0.2" vs "0.20"): compare normalized */
function sameValue(key: AiSettingKey, a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const kind = AI_SETTINGS[key].kind;
  if (kind === 'enum' || kind === 'bool' || kind === 'bools') return a.trim().toLowerCase() === b;
  if (kind === 'floats') {
    const [x, y] = [a.split(','), b.split(',')];
    return x.length === y.length && x.every((v, i) => (v.trim() === 'nil' ? y[i] === 'nil' : Number(v) === Number(y[i])));
  }
  return Number(a.replace(/%$/, '')) === Number(b.replace(/%$/, ''));
}

// Settings Studio describes that the AI still may not change: what the material is rather than how it
// prints (changing them only makes Studio's weights, costs and checks wrong), the temperature range the
// AI's own temperatures are checked against, and positions set by dragging on the plate
const AI_DENIED = new Set([
  'filament_diameter', 'filament_density', 'filament_cost', 'filament_shrink', 'filament_is_support',
  'filament_soluble', 'filament_printable', 'filament_extruder_compatibility', 'required_nozzle_HRC',
  'temperature_vitrification', 'volumetric_speed_coefficients',
  'nozzle_temperature_range_low', 'nozzle_temperature_range_high',
  'wipe_tower_x', 'wipe_tower_y',
  // Which extruder each variant of the per-variant settings belongs to: Studio's bookkeeping, not a choice
  'print_extruder_id',
]);

/** Studio's definition of `key`, when the AI may change it in a preset holding `settings` */
function allowedOption(request: StudioRequest, settings: Record<string, string> | undefined, key: string): StudioOption | null {
  const option = request.options?.[key];
  if (!option || !settings || !(key in settings)) return null;
  // Developer-mode settings are hidden in Studio's editor, mostly experiments and printer internals
  if (option.mode === 'develop' || AI_DENIED.has(key)) return null;
  return option;
}

const stripNumber = (text: string) => text.trim().toLowerCase().replace(/(mm\/s|mm|°c|s)$/, '').trim();

/** One value of a Studio setting from the model's text, in Studio's serialized form */
function parseOptionValue(option: StudioOption, raw: string): { value: string } | { error: string } {
  const text = raw.trim();
  switch (option.type) {
    case 'bool': {
      const value = parseBool(text.toLowerCase());
      return value ? { value } : { error: `"${raw}" không phải giá trị bật/tắt` };
    }
    case 'enum': {
      const value = option.values?.find((v) => v.toLowerCase() === text.toLowerCase());
      return value !== undefined ? { value } : { error: `"${raw}" không nằm trong ${(option.values ?? []).join(', ')}` };
    }
    default: {
      const percent = text.endsWith('%');
      if (percent && option.type !== 'percent' && option.type !== 'float_or_percent') return { error: `"${raw}" không dùng được %` };
      const n = Number(stripNumber(text.replace(/%$/, '')));
      if (!Number.isFinite(n)) return { error: `"${raw}" không phải số` };
      if (option.type === 'int' && !Number.isInteger(n)) return { error: `"${raw}" phải là số nguyên` };
      // A float_or_percent in % is relative to another setting: Studio's limits are for the absolute value
      if (!(percent && option.type === 'float_or_percent')) {
        if (option.min !== undefined && n < option.min) return { error: `${n} nhỏ hơn mức tối thiểu ${option.min}` };
        if (option.max !== undefined && n > option.max) return { error: `${n} lớn hơn mức tối đa ${option.max}` };
      }
      if (option.type === 'percent' || percent) return { value: `${round(n, 2)}%` };
      return { value: String(option.type === 'int' ? n : round(n, 4)) };
    }
  }
}

const isNil = (v: string) => v.trim() === 'nil';
const numberOf = (v: string) => Number(v.trim().replace(/%$/, ''));

/**
 * The model's value for a Studio setting, or an error. A per-variant setting takes either one value or
 * one per variant. One number for variants that differ (a High Flow variant faster than the standard
 * one) is the first variant's new value, and every variant is scaled by the same ratio. "nil" (a variant
 * left to another preset) stays nil, unless every variant is nil: then the value fills them all.
 */
export function normalizeOptionValue(option: StudioOption, raw: string, current: string | undefined): { value: string } | { error: string } {
  if (!option.vector) return parseOptionValue(option, raw);
  if (current === undefined) return { error: 'Studio không gửi giá trị hiện tại của tham số này' };
  const now = current.split(',').map((v) => v.trim());
  const parts = raw.split(',').map((v) => v.trim()).filter(Boolean);
  const allNil = now.every(isNil);

  if (parts.length === now.length && new Set(parts).size > 1) {
    const values: string[] = [];
    for (const [i, part] of parts.entries()) {
      if (isNil(now[i]) && !allNil) {
        values.push('nil');
        continue;
      }
      const parsed = parseOptionValue(option, part);
      if ('error' in parsed) return parsed;
      values.push(parsed.value);
    }
    return { value: values.join(',') };
  }
  if (new Set(parts).size !== 1) return { error: `"${raw}" phải là một giá trị, hoặc ${now.length} giá trị theo thứ tự biến thể` };

  const parsed = parseOptionValue(option, parts[0]);
  if ('error' in parsed) return parsed;
  const set = now.filter((v) => !isNil(v));
  const numeric = option.type !== 'bool' && option.type !== 'enum' && !(option.type === 'float_or_percent' && parsed.value.endsWith('%'));
  const differ = new Set(set.map(numberOf)).size > 1;
  if (!numeric || !differ || set.some((v) => !Number.isFinite(numberOf(v)) || numberOf(v) <= 0)) {
    return { value: now.map((v) => (isNil(v) && !allNil ? 'nil' : parsed.value)).join(',') };
  }
  const ratio = numberOf(parsed.value) / numberOf(set[0]);
  const values: string[] = [];
  for (const v of now) {
    if (isNil(v)) {
      values.push('nil');
      continue;
    }
    const n = numberOf(v) * ratio;
    const scaled = parseOptionValue(option, `${option.type === 'int' ? Math.round(n) : round(n, 2)}${v.endsWith('%') ? '%' : ''}`);
    if ('error' in scaled) return { error: `Biến thể ${v} đổi theo cùng tỉ lệ thành ${round(n, 2)}: ${scaled.error}` };
    values.push(scaled.value);
  }
  return { value: values.join(',') };
}

/** Same value in Studio's terms ("15%" vs "15.00%", "0.2" vs "0.20", per-variant lists alike) */
function sameOptionValue(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const [x, y] = [a.split(','), b.split(',')];
  return (
    x.length === y.length &&
    x.every((v, i) => {
      const [p, q] = [v.trim(), y[i].trim()];
      if (p.toLowerCase() === q.toLowerCase()) return true;
      return !isNil(p) && !isNil(q) && Number.isFinite(numberOf(p)) && numberOf(p) === numberOf(q) && p.endsWith('%') === q.endsWith('%');
    })
  );
}

/** First value of a filament setting, as a number (nozzle_temperature_range_low and the like) */
function firstNumber(settings: Record<string, string>, key: string): number | null {
  const first = settings[key]?.split(',').find((v) => !isNil(v));
  const n = first === undefined ? NaN : Number(first);
  return Number.isFinite(n) ? n : null;
}

// Nozzle temperatures stay in the filament's own recommended range: outside it the AI is guessing
const NOZZLE_TEMPERATURES = new Set(['nozzle_temperature', 'nozzle_temperature_initial_layer']);

function checkFilamentRules(key: string, value: string, settings: Record<string, string>): string | null {
  if (!NOZZLE_TEMPERATURES.has(key)) return null;
  const [low, high] = [firstNumber(settings, 'nozzle_temperature_range_low'), firstNumber(settings, 'nozzle_temperature_range_high')];
  if (low === null || high === null) return null;
  const outside = value.split(',').filter((v) => !isNil(v)).map(Number).find((t) => t < low || t > high);
  return outside === undefined ? null : `${outside}°C nằm ngoài khoảng nhiệt độ của filament ${low}–${high}°C`;
}

// Studio's labels repeat across settings ("Bed temperature" for each plate type): the key tells them apart
const optionLabel = (key: string, option: StudioOption) => (option.label ? `${option.label} (${key})` : key);

type ProposedChange = AiProposal['changes'][number];

/** Keeps the proposals that are allowed, valid and actually change something; explains the rest */
export function checkProposal(proposal: AiProposal, request: StudioRequest): AiOptimizeResult {
  const changes: AiChange[] = [];
  const rejected: AiRejected[] = [];
  const seen = new Set<string>();
  // Studio holds unsaved edits for one filament preset at a time, so a proposal changes at most one
  let filamentPreset: string | null = null;

  const check = (change: ProposedChange): { change: AiChange } | { error: string } | null => {
    const { key, value } = change;
    const reason = change.reason.trim();
    if (change.target !== 'filament') {
      if (seen.has(key)) return { error: 'Đề xuất trùng lặp' };
      seen.add(key);
      const current = request.settings[key];
      if (key in AI_SETTINGS) {
        const settingKey = key as AiSettingKey;
        const normalized = normalizeValue(settingKey, value, request.nozzle_diameters, current);
        if ('error' in normalized) return normalized;
        if (sameValue(settingKey, current, normalized.value)) return null;
        return { change: { key, label: AI_SETTINGS[settingKey].label, value: normalized.value, reason } };
      }
      const option = allowedOption(request, request.settings, key);
      if (!option) return { error: 'Tham số không nằm trong danh sách AI được phép đổi' };
      const normalized = normalizeOptionValue(option, value, current);
      if ('error' in normalized) return normalized;
      if (sameOptionValue(current, normalized.value)) return null;
      return { change: { key, label: optionLabel(key, option), value: normalized.value, reason } };
    }

    const filament = change.filament ?? 0;
    const slot = request.filaments[filament - 1];
    if (!slot?.settings) return { error: `Không có filament #${filament}, hoặc Studio không gửi setting của nó` };
    if (filamentPreset !== null && slot.preset !== filamentPreset) {
      return { error: `Mỗi lần chỉ đổi được một preset filament: đã đổi ${filamentPreset}` };
    }
    // Filaments sharing a preset share its settings
    if (seen.has(`filament:${slot.preset}:${key}`)) return { error: 'Đề xuất trùng lặp' };
    seen.add(`filament:${slot.preset}:${key}`);
    const option = allowedOption(request, slot.settings, key);
    if (!option) return { error: 'Tham số không nằm trong danh sách AI được phép đổi' };
    const current = slot.settings[key];
    const normalized = normalizeOptionValue(option, value, current);
    if ('error' in normalized) return normalized;
    const broken = checkFilamentRules(key, normalized.value, slot.settings);
    if (broken) return { error: broken };
    if (sameOptionValue(current, normalized.value)) return null;
    filamentPreset = slot.preset;
    return { change: { target: 'filament', filament, preset: slot.preset, key, label: optionLabel(key, option), value: normalized.value, reason } };
  };

  for (const change of proposal.changes) {
    const result = check(change);
    if (result === null) continue;
    if ('change' in result) {
      changes.push(result.change);
      continue;
    }
    const target = change.target === 'filament' ? { target: 'filament' as const, filament: change.filament } : {};
    rejected.push({ ...target, key: change.key, value: change.value, reason: result.error });
  }
  return { summary: proposal.summary.trim(), changes, rejected };
}

const GOALS: Record<StudioRequest['goal'], string> = {
  balanced: 'Cân bằng giữa chất lượng bề mặt, độ bền, thời gian in và lượng nhựa.',
  quality: 'Ưu tiên bề mặt đẹp và chi tiết sắc nét; chấp nhận in lâu hơn.',
  speed: 'Ưu tiên in nhanh; vẫn phải in thành công và đủ dùng.',
  strength: 'Ưu tiên chi tiết chịu lực, bền; chấp nhận tốn nhựa và thời gian hơn.',
  material: 'Ưu tiên tiết kiệm nhựa; vẫn phải in thành công.',
};

const SYSTEM_PROMPT = `Bạn là chuyên gia slicing cho máy in 3D Bambu Lab H2D (hai đầu phun) dùng Bambu Studio.
Bạn nhận mô tả plate đang mở: preset máy, preset quá trình in, filament, giá trị hiện tại của các tham số được phép đổi (của preset quá trình in và của preset filament đang dùng trên plate), và hình học từng vật thể (kích thước mm, thể tích, diện tích đáy tiếp xúc bàn in, diện tích bề mặt nhô quá 45° không nằm trên bàn in).

Đề xuất thay đổi các tham số quá trình in và filament để bản in thành công và phù hợp mục tiêu người dùng.
- Chỉ dùng các key được liệt kê, đúng nhóm của nó. Tham số quá trình in: target "process", filament 0. Tham số filament: target "filament", filament là số thứ tự # của filament. Mỗi lần chỉ đổi được một preset filament: chọn preset in phần lớn vật thể.
- Giá trị viết theo đúng cách Bambu Studio lưu: số thập phân dùng dấu chấm, phần trăm như "15%", bật/tắt là "1"/"0", enum đúng chính tả trong danh sách. Không ghi đơn vị.
- Tham số có nhiều giá trị (một giá trị cho mỗi biến thể đầu phun, như "220,230"): ghi một giá trị cho biến thể đầu tiên, các biến thể khác đổi theo cùng tỉ lệ; hoặc ghi đủ từng giá trị theo thứ tự biến thể. "nil" là biến thể không dùng giá trị này, cứ ghi một số bất kỳ ở vị trí đó.
- Chỉ đề xuất khi có lý do cụ thể từ hình học, vật liệu hoặc mục tiêu. Không đổi tham số đã hợp lý. Nếu mọi thứ đã ổn, trả về danh sách rỗng.
- Phần lớn tham số đã được Bambu tinh chỉnh cho máy và vật liệu này: ưu tiên các tham số chính, chỉ đụng đến tham số khác khi có lý do rõ. Không bật chế độ đặc biệt (spiral vase, fuzzy skin, in tuần tự từng vật...) nếu người dùng không yêu cầu. Nhiệt độ đầu phun giữ trong khoảng khuyến nghị của filament.
- Yêu cầu rõ của người dùng (trong ý kiến của họ) được ưu tiên hơn các nguyên tắc thận trọng ở trên: nếu họ muốn đổi một nhóm tham số hay tất cả tham số (ví dụ để thử xem Studio áp dụng đúng không), đổi đúng phạm vi đó, mỗi tham số một giá trị khác giá trị hiện tại và vẫn trong khoảng cho phép, lý do thật ngắn (vài chữ). "Tất cả" nghĩa là mọi key được liệt kê trong cả ba phần: tham số chính, các tham số khác của preset quá trình in, và tham số filament (của một preset filament), không chỉ tham số chính. Danh sách dài là bình thường. Chỉ giới hạn giá trị là không bỏ qua được.
- Cân nhắc: phần nhô lớn thì cần support (tree(auto) cho mẫu hữu cơ/phức tạp); vật cao, đáy nhỏ hoặc vật liệu dễ cong vênh (ABS, ASA, PA, PC) thì cần brim, chỉ dùng raft khi đáy quá nhỏ hoặc cong vênh nặng; chi tiết chịu lực thì thêm vòng tường và infill; mẫu trang trí thì giảm infill.
- Số lớp vỏ trên/dưới thực tế là giá trị lớn hơn giữa số lớp và độ dày vỏ chia chiều cao lớp: muốn giảm vỏ thì giảm cả hai, muốn tăng thì tăng một trong hai là đủ.
- Tốc độ: giá trị hiện tại và giá trị đề xuất là của đầu phun đầu tiên; các biến thể khác (như High Flow) đổi theo cùng tỉ lệ. Chỉ đổi khi mục tiêu là tốc độ hoặc bề mặt đẹp, và giữ trong mức vật liệu chịu được (TPU, vật liệu mềm phải in chậm).
- Khe hở Z support lớn hơn thì dễ gỡ nhưng mặt dưới xấu hơn. Bù kích thước XY chỉ dùng cho chi tiết lắp ghép, giá trị nhỏ (vài phần trăm mm).
- Thông tin hình học là ước lượng từ lưới tam giác, không phải kết quả slice.
- Nếu có kết quả in thực tế của các plate tương tự trên chính máy này, coi đó là bằng chứng mạnh hơn quy tắc chung: giữ những thay đổi đã cho bản in tốt, không lặp lại thay đổi đi kèm lỗi, và sửa đúng lỗi người dùng đã báo. Một lần in có thể hỏng vì lý do ngoài setting (bàn bẩn, filament ẩm), nên chỉ kết luận chắc khi lỗi lặp lại. Khi một thay đổi dựa vào lịch sử in, nói rõ trong lý do.
- Mỗi lý do viết bằng tiếng Việt, một câu ngắn, nêu dựa vào đâu. Phần summary bằng tiếng Việt, tối đa ba câu.`;

function describeSettings(request: StudioRequest): string {
  return AI_SETTING_KEYS.map((key) => {
    const spec: SettingSpec = AI_SETTINGS[key];
    const allowed =
      spec.kind === 'enum'
        ? `một trong: ${spec.values.join(' | ')}`
        : spec.kind === 'bool'
          ? '"1" hoặc "0"'
          : spec.kind === 'bools'
            ? '"1" hoặc "0", một giá trị cho mọi đầu phun'
            : spec.kind === 'floats'
              ? `một số ${spec.min}–${spec.max} mm/s cho đầu phun đầu tiên (các biến thể khác đổi cùng tỉ lệ), hoặc đủ từng giá trị theo biến thể`
              : `${spec.kind} ${spec.min}–${spec.max}${spec.kind === 'percent' ? '%' : ''}`;
    const value = request.settings[key];
    const reference = spec.kind === 'floats' && value !== undefined ? firstVariant(value) : null;
    const shown = reference !== null ? `${reference} (tất cả biến thể: ${value})` : (value ?? 'không rõ');
    return `- ${key} (${spec.label}): hiện tại ${shown}; cho phép ${allowed}`;
  }).join('\n');
}

const OPTION_TYPES: Record<StudioOption['type'], string> = {
  float: 'số',
  int: 'số nguyên',
  percent: 'phần trăm',
  float_or_percent: 'số hoặc %',
  bool: '"1"/"0"',
  enum: 'enum',
};

/** "- key (label, unit): hiện tại X; số 0–500" for a setting Studio describes */
function describeOption(key: string, option: StudioOption, current: string): string {
  const name = [option.label, option.unit].filter(Boolean).join(', ');
  let allowed = option.type === 'enum' ? (option.values ?? []).join(' | ') : OPTION_TYPES[option.type];
  if (option.min !== undefined && option.max !== undefined) allowed += ` ${option.min}–${option.max}`;
  else if (option.min !== undefined) allowed += ` ≥ ${option.min}`;
  else if (option.max !== undefined) allowed += ` ≤ ${option.max}`;
  return `- ${key}${name ? ` (${name})` : ''}: hiện tại ${current}; ${allowed}`;
}

/** The settings of a preset the AI may change beyond AI_SETTINGS, grouped by Studio's categories */
function describeOptions(request: StudioRequest, settings: Record<string, string>, skip: (key: string) => boolean): string[] {
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(settings).sort()) {
    const option = allowedOption(request, settings, key);
    if (!option || skip(key)) continue;
    const category = option.category || 'Khác';
    groups.set(category, [...(groups.get(category) ?? []), describeOption(key, option, settings[key])]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([category, lines]) => [`[${category}]`, ...lines]);
}

const variantsLine = (variants: string[] | undefined) =>
  variants?.length ? [`Tham số nhiều giá trị theo thứ tự biến thể: ${variants.join(', ')}`] : [];

/** The filament presets on the plate with their settings; filaments sharing a preset are listed together */
function describeFilaments(request: StudioRequest): string[] {
  const presets = new Map<string, number[]>();
  request.filaments.forEach((f, i) => {
    if (f.settings && f.used !== false) presets.set(f.preset, [...(presets.get(f.preset) ?? []), i + 1]);
  });
  return [...presets.entries()].flatMap(([preset, numbers]) => {
    const filament = request.filaments[numbers[0] - 1];
    return [
      '',
      `Tham số filament ${numbers.map((n) => `#${n}`).join(', ')}: ${preset}${filament.type ? ` (${filament.type})` : ''} (target "filament", filament ${numbers[0]}):`,
      ...variantsLine(filament.variants),
      ...describeOptions(request, filament.settings!, () => false),
    ];
  });
}

/** Filament actually in the AMS and the nozzles fitted, as the gateway sees them over MQTT */
function describePrinter(state: PrinterState | null): string {
  if (!state) return 'Không có dữ liệu máy in trực tiếp.';
  const nozzles = (state.temperatures.nozzles ?? [])
    .map((n) => `đầu ${n.id}: ${n.diameter ?? '?'} mm ${n.type ?? ''}`.trim())
    .join('; ');
  const trays = (state.ams ?? [])
    .flatMap((unit) => unit.trays.filter((t) => !t.isEmpty && t.type).map((t) => `AMS ${unit.id} khay ${t.id}: ${t.type}${t.isLoaded ? ' (đang nạp)' : ''}`))
    .join('; ');
  return [`Đầu phun đang lắp: ${nozzles || 'không rõ'}`, `Filament trong AMS: ${trays || 'không rõ'}`].join('\n');
}

/** The re-ask part of the prompt: what was proposed before and what the user said about it */
function describeFollowUp(followUp: FollowUp): string[] {
  const previous = followUp.previous
    ? [
        'Lần trước bạn đã đề xuất (người dùng chưa áp dụng):',
        followUp.previous.summary,
        ...followUp.previous.changes.map((c) => `- ${settingRef(c)} (${c.label}) = ${c.value}: ${c.reason}`),
      ]
    : ['Không còn lưu đề xuất lần trước.'];
  return [
    '',
    ...previous,
    '',
    'Ý kiến của người dùng về đề xuất đó:',
    JSON.stringify(followUp.comment),
    'Đề xuất lại theo ý kiến này, vẫn so với giá trị hiện tại ở trên. Nếu ý kiến làm tăng nguy cơ in hỏng, vẫn làm theo nhưng nói rõ rủi ro trong summary.',
  ];
}

/** Earlier prints of similar plates on this printer, and what the user reported */
function describePastPrints(pastPrints: PastPrint[]): string[] {
  const label = (c: PastPrint['changes'][number]) => c.label ?? (AI_SETTINGS as Record<string, SettingSpec>)[c.key]?.label;
  return [
    '',
    'Kết quả in thực tế của các plate tương tự trên máy này (đã áp dụng đề xuất rồi in), mới nhất trước khi giống nhau như nhau:',
    ...pastPrints.flatMap((p, i) => [
      `${i + 1}. ${p.created_at.slice(0, 10)}, mục tiêu ${p.goal}, preset ${p.process_preset}, filament ${p.filaments.join('; ') || 'không rõ'}`,
      `   Vật thể: ${p.objects.join('; ')}`,
      p.changes.length
        ? `   Đã đổi: ${p.changes.map((c) => `${c.key}${label(c) ? ` (${label(c)})` : ''} ${c.before ?? '?'} → ${c.after}`).join('; ')}`
        : '   Đã đổi: không, in với preset như cũ',
      `   Kết quả: ${p.outcome}${p.issues.length ? `; lỗi: ${p.issues.join(', ')}` : ''}`,
      ...(p.note ? [`   Ghi chú của người dùng: ${JSON.stringify(p.note)}`] : []),
      ...(p.video_review
        ? [`   AI cục bộ xem timelapse (model nhỏ, có thể nhầm; người dùng báo khác thì tin người dùng): ${JSON.stringify(p.video_review)}`]
        : []),
    ]),
  ];
}

export function buildUserPrompt(
  request: StudioRequest,
  printerState: PrinterState | null,
  followUp: FollowUp | null = null,
  pastPrints: PastPrint[] = []
): string {
  return [
    `Mục tiêu: ${GOALS[request.goal]}`,
    '',
    `Preset máy: ${request.printer_preset}`,
    `Preset quá trình in: ${request.process_preset}`,
    `Đường kính đầu phun trong preset: ${request.nozzle_diameters.join(', ')} mm`,
    `Filament: ${request.filaments.map((f, i) => `#${i + 1} ${f.preset}${f.type ? ` (${f.type})` : ''}${f.used === false ? ' (không dùng trên plate này)' : ''}`).join('; ') || 'không rõ'}`,
    '',
    'Máy in thực tế:',
    describePrinter(printerState),
    '',
    'Tham số chính của preset quá trình in (target "process"):',
    describeSettings(request),
    ...(request.options
      ? [
          '',
          'Các tham số khác của preset quá trình in (target "process"):',
          ...variantsLine(request.process_variants),
          ...describeOptions(request, request.settings, (key) => key in AI_SETTINGS),
        ]
      : []),
    ...describeFilaments(request),
    '',
    'Vật thể trên plate:',
    JSON.stringify(request.objects, null, 1),
    ...(pastPrints.length ? describePastPrints(pastPrints) : []),
    ...(followUp ? describeFollowUp(followUp) : []),
  ].join('\n');
}

export class AiOptimizeError extends Error {
  constructor(public code: 'AI_REFUSED' | 'AI_NO_OUTPUT', message: string) {
    super(message);
    this.name = 'AiOptimizeError';
  }
}

export type ProposalSource = (system: string, user: string) => Promise<AiProposal>;

/** Asks Claude for a proposal in the fixed JSON shape */
export function claudeProposalSource(model: string, client = new Anthropic()): ProposalSource {
  return async (system, user) => {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'medium', format: proposalFormat },
    });
    if (response.stop_reason === 'refusal') {
      throw new AiOptimizeError('AI_REFUSED', 'AI từ chối xử lý yêu cầu này.');
    }
    if (!response.parsed_output) {
      throw new AiOptimizeError('AI_NO_OUTPUT', `AI không trả về kết quả hợp lệ (stop_reason: ${response.stop_reason}).`);
    }
    return response.parsed_output;
  };
}

/**
 * For `claude -p` in Studio's container, which streams Claude's text before the answer: Studio's progress
 * window shows these lines while Claude works (its thinking itself never reaches `claude -p`'s output).
 */
export const PROGRESS_NOTES_PROMPT = `

Trước khi trả lời theo schema, viết phần phân tích ngắn để người dùng theo dõi trong lúc chờ: tiếng Việt, mỗi ý một dòng bắt đầu bằng "• ", mỗi dòng dưới 15 chữ, tối đa 12 dòng, theo thứ tự: hình dạng và phần nhô của vật thể, vật liệu và đầu phun, kết quả in trước (nếu có), rồi từng nhóm setting sẽ đổi và vì sao. Không viết gì khác ngoài các dòng đó.`;

/** The system and user prompts for a plate, for callers that ask Claude themselves */
export function buildPrompts(
  request: StudioRequest,
  printerState: PrinterState | null,
  followUp: FollowUp | null = null,
  pastPrints: PastPrint[] = []
): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: buildUserPrompt(request, printerState, followUp, pastPrints) };
}

export async function optimizeSettings(
  request: StudioRequest,
  printerState: PrinterState | null,
  source: ProposalSource,
  followUp: FollowUp | null = null,
  pastPrints: PastPrint[] = []
): Promise<AiOptimizeResult> {
  const { system, user } = buildPrompts(request, printerState, followUp, pastPrints);
  const proposal = await source(system, user);
  return checkProposal(proposal, request);
}
