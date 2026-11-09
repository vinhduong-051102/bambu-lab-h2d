import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { z } from 'zod';
import type { PrinterState } from '../PrinterState';

/**
 * "AI tối ưu" in Bambu Studio: Studio describes the open plate (presets, the process and filament
 * settings with how Studio defines each one, object geometry), Claude proposes setting changes, and
 * only checked ones come back. Studio shows them to the user and applies the accepted ones to the
 * edited process preset and to one filament preset, to single objects (their own settings, as the
 * Objects tab of the process settings sets them), and moves objects to new plates.
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
  // Studio also keeps it on an object (PrintObjectConfig/PrintRegionConfig): it can then be set for one plate
  object: z.boolean().optional(),
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
  // What the user typed in Studio's "AI tối ưu" window before starting
  user_request: z.string().trim().max(2000).optional(),
  // "plate": settings for current_plate only (Studio sets them on its objects); "project": the process preset
  // (missing: the whole project, as from Studio before the start window)
  scope: z.enum(['project', 'plate']).optional(),
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
        // 1-based plate the object's first instance is on; missing from Studio before plate moves
        plate: z.number().int().optional(),
        // Its first instance seen from above: the outline's corners in mm from its plate's corner (missing from Studio before)
        footprint: z.array(z.tuple([z.number(), z.number()])).max(2000).optional(),
        // Its true outline from above (Studio's view of the plate): outer contours and holes, drawn even-odd
        outline: z
          .array(z.array(z.tuple([z.number(), z.number()])).max(8000))
          .max(500)
          .refine((rings) => rings.reduce((n, r) => n + r.length, 0) <= 12000, 'Outline has too many corners')
          .optional(),
        // What the object already has set apart from the process preset, as Studio saves it: it wins over the preset
        // when slicing (missing from Studio before, and for objects without settings of their own)
        settings: z.record(z.string(), z.string()).optional(),
        // Its parts and modifiers with settings of their own, and its height ranges: these win over the object's
        parts: z.array(z.object({ name: z.string(), type: z.string(), settings: z.record(z.string(), z.string()) })).max(200).optional(),
        height_ranges: z
          .array(z.object({ from_mm: z.number(), to_mm: z.number(), settings: z.record(z.string(), z.string()) }))
          .max(200)
          .optional(),
      })
    )
    .max(200),
  // 1-based plate open in Studio
  current_plate: z.number().int().optional(),
  // The plate's width and depth in mm, for drawing the footprints
  bed_mm: z.tuple([z.number(), z.number()]).optional(),
  // "Hỏi lại AI" in Studio's result dialog: the session being answered and what the user said about it
  follow_up: z.object({ session_id: z.string(), comment: z.string().trim().min(1).max(2000) }).optional(),
});
export type StudioRequest = z.infer<typeof studioRequestSchema>;

/** The proposal a re-ask answers, and the user's comment on it */
export interface FollowUp {
  previous: { summary: string; changes: AiChange[]; object_changes?: AiObjectChange[]; plates?: AiPlateMove[] } | null;
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
  /** Settings given to single objects, and the objects moved together to each new plate (by name) */
  object_changes?: { object: string; key: string; after: string }[];
  plates?: string[][];
  outcome: string;
  issues: string[];
  /** The defects the user pinned to an object and a part of it (aiSessions.describeDefect) */
  defects?: string[];
  note: string;
  /** What Claude saw in the print's timelapse; only through the printer's camera, so weighed below the user's report */
  video_review?: string;
  /** That review's advice, in full: the user chose it for later prints, so the prompt asks for each to be followed */
  review_suggestions?: string[];
  /** When a session that followed that advice was applied: the current settings hold it already, and it is only history */
  review_followed_at?: string;
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
  /** For a setting of one object, or a plate move (key "new_plate"): the 1-based object */
  object?: number;
  key: string;
  value: string;
  reason: string;
}

/** One setting across sessions and print reports: "layer_height", or "filament#2:nozzle_temperature" */
export function settingRef(change: { key: string; target?: string; filament?: number }): string {
  return change.target === 'filament' ? `filament#${change.filament}:${change.key}` : change.key;
}

/** A setting of one object only (1-based, as Studio lists them in the request), on top of the process preset */
export interface AiObjectChange {
  object: number;
  name: string;
  key: string;
  label: string;
  value: string;
  reason: string;
}

/** Objects (1-based) that go together to a new plate of their own */
export interface AiPlateMove {
  objects: number[];
  names: string[];
  reason: string;
}

export interface AiOptimizeResult {
  summary: string;
  changes: AiChange[];
  /** Missing in sessions saved before objects could be set one by one, as is `plates` */
  object_changes?: AiObjectChange[];
  plates?: AiPlateMove[];
  rejected: AiRejected[];
  /** For one plate only: the process changes go on every one of its objects (1-based), the other plates keep the preset */
  scope?: { plate: number; objects: number[] };
}

// The settings Studio also keeps per object (src/libslic3r/PrintConfig.hpp's PrintObjectConfig and
// PrintRegionConfig, v02.08.04.57): what the AI may give one object instead of the whole plate. Kept to
// adhesion, support and strength; Studio refuses keys that are not an object's anyway.
export const OBJECT_SETTING_KEYS = [
  'brim_type', 'brim_width', 'brim_object_gap', 'raft_layers', 'elefant_foot_compensation',
  'enable_support', 'support_type', 'support_style', 'support_threshold_angle', 'support_on_build_plate_only',
  'support_top_z_distance', 'support_object_xy_distance', 'tree_support_wall_count',
  'wall_loops', 'top_shell_layers', 'bottom_shell_layers', 'sparse_infill_density', 'sparse_infill_pattern',
  'seam_position', 'ironing_type', 'detect_overhang_wall', 'only_one_wall_first_layer',
] as const;
const OBJECT_SETTINGS = new Set<string>(OBJECT_SETTING_KEYS);

/** The plate the AI works on alone, or null for the whole project */
export function targetPlate(request: Pick<StudioRequest, 'scope' | 'current_plate'>): number | null {
  return request.scope === 'plate' && request.current_plate ? request.current_plate : null;
}

/** The objects (1-based) the AI works on: those of the target plate, or all of them */
export function workingObjects(request: Pick<StudioRequest, 'scope' | 'current_plate' | 'objects'>): number[] {
  const all = request.objects.map((_, i) => i + 1);
  const plate = targetPlate(request);
  // Studio before plate numbers: every object counts as on the plate
  if (plate === null || !request.objects.some((o) => o.plate)) return all;
  return all.filter((n) => request.objects[n - 1].plate === plate);
}

/** A process setting that can be set for one plate: Studio keeps it on objects too */
function plateSetting(request: StudioRequest, key: string): boolean {
  return OBJECT_SETTINGS.has(key) || request.options?.[key]?.object === true;
}
type StudioObject = StudioRequest['objects'][number];

/** The object's own value of a setting, else the process preset's */
function objectValue(request: StudioRequest, n: number, key: string): string | undefined {
  return request.objects[n - 1]?.settings?.[key] ?? request.settings[key];
}

/** Where an object's parts (modifiers) and height ranges set `key` themselves, as "#2 Gear › Modifier: 10%" */
function innerOverrides(n: number, object: StudioObject, key: string): string[] {
  return [
    ...(object.parts ?? []).filter((p) => key in p.settings).map((p) => `#${n} ${object.name} › ${p.name}: ${p.settings[key]}`),
    ...(object.height_ranges ?? [])
      .filter((r) => key in r.settings)
      .map((r) => `#${n} ${object.name} › ${r.from_mm}–${r.to_mm} mm: ${r.settings[key]}`),
  ];
}

/**
 * Where a change of `key` will not show when slicing, for the end of its reason: the objects' own settings (`own`:
 * a change of the process preset, which they win over), their parts' and their height ranges'
 */
function shadowNote(request: StudioRequest, objects: number[], key: string, own: boolean): string {
  const kept = objects.flatMap((n) => {
    const object = request.objects[n - 1];
    if (!object) return [];
    const value = object.settings?.[key];
    return [...(own && value !== undefined ? [`#${n} ${object.name}: ${value}`] : []), ...innerOverrides(n, object, key)];
  });
  return kept.length ? ` [Lưu ý: đặt riêng nên vẫn giữ giá trị cũ ở ${kept.join('; ')}]` : '';
}

// More new plates than this is the AI taking the plate apart, not moving the parts at risk
const MAX_NEW_PLATES = 4;

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
    object_changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          object: { type: 'integer' },
          key: { type: 'string' },
          value: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['object', 'key', 'value', 'reason'],
        additionalProperties: false,
      },
    },
    new_plates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          objects: { type: 'array', items: { type: 'integer' } },
          reason: { type: 'string' },
        },
        required: ['objects', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'changes', 'object_changes', 'new_plates'],
  additionalProperties: false,
} as const;

// Sent as written: the API enforces the target enum, which the SDK's transform would demote to a description
const proposalFormat = jsonSchemaOutputFormat(PROPOSAL_JSON_SCHEMA, { transform: false });

export interface AiProposal {
  summary: string;
  /** target defaults to "process"; filament is 1-based and only read for target "filament" */
  changes: { target?: 'process' | 'filament'; filament?: number; key: string; value: string; reason: string }[];
  /** object is 1-based, as the request lists them */
  object_changes?: { object: number; key: string; value: string; reason: string }[];
  new_plates?: { objects: number[]; reason: string }[];
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
  object_changes: z
    .array(z.object({ object: z.number().int(), key: z.string(), value: z.string(), reason: z.string() }))
    .max(800)
    .default([]),
  new_plates: z
    .array(z.object({ objects: z.array(z.number().int()).max(200), reason: z.string() }))
    .max(50)
    .default([]),
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
  const plate = targetPlate(request);
  const objects = workingObjects(request);
  // Studio holds unsaved edits for one filament preset at a time, so a proposal changes at most one
  let filamentPreset: string | null = null;

  const check = (change: ProposedChange): { change: AiChange } | { error: string } | null => {
    const { key, value } = change;
    const reason = change.reason.trim();
    if (change.target !== 'filament') {
      if (seen.has(key)) return { error: 'Đề xuất trùng lặp' };
      seen.add(key);
      if (plate !== null && !plateSetting(request, key)) return { error: 'Chỉ đặt được cho cả dự án (preset quá trình in), không riêng một bàn in' };
      const current = request.settings[key];
      // For one plate Studio sets the value on each of its objects, over what they had; for the project it goes to
      // the preset, which objects with their own value win over
      const unchanged = (same: (now: string | undefined) => boolean) =>
        plate !== null ? objects.every((n) => same(objectValue(request, n, key))) : same(current);
      const note = shadowNote(request, objects, key, plate === null);
      if (key in AI_SETTINGS) {
        const settingKey = key as AiSettingKey;
        const normalized = normalizeValue(settingKey, value, request.nozzle_diameters, current);
        if ('error' in normalized) return normalized;
        if (unchanged((now) => sameValue(settingKey, now, normalized.value))) return null;
        return { change: { key, label: AI_SETTINGS[settingKey].label, value: normalized.value, reason: reason + note } };
      }
      const option = allowedOption(request, request.settings, key);
      if (!option) return { error: 'Tham số không nằm trong danh sách AI được phép đổi' };
      const normalized = normalizeOptionValue(option, value, current);
      if ('error' in normalized) return normalized;
      if (unchanged((now) => sameOptionValue(now, normalized.value))) return null;
      return { change: { key, label: optionLabel(key, option), value: normalized.value, reason: reason + note } };
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
  const objectChanges = checkObjectChanges(proposal.object_changes ?? [], request, objects, rejected);
  const plates = checkPlateMoves(proposal.new_plates ?? [], request, objects, rejected);
  return {
    summary: proposal.summary.trim(),
    changes,
    object_changes: objectChanges,
    plates,
    rejected,
    ...(plate !== null ? { scope: { plate, objects } } : {}),
  };
}

/**
 * Settings for single objects: keys of OBJECT_SETTINGS, checked like the process setting of the same key. A value
 * equal to the object's own (or else the process preset's) changes nothing and is dropped.
 */
function checkObjectChanges(
  proposed: NonNullable<AiProposal['object_changes']>,
  request: StudioRequest,
  working: number[],
  rejected: AiRejected[]
): AiObjectChange[] {
  const changes: AiObjectChange[] = [];
  const seen = new Set<string>();
  for (const change of proposed) {
    const { object: n, key, value } = change;
    const reject = (reason: string) => rejected.push({ object: n, key, value, reason });
    const object = request.objects[n - 1];
    if (!object) {
      reject(`Không có vật thể #${n}`);
      continue;
    }
    if (!working.includes(n)) {
      reject(`Vật thể #${n} không nằm trên bàn in ${request.current_plate}`);
      continue;
    }
    if (!OBJECT_SETTINGS.has(key)) {
      reject('Tham số này không đặt riêng cho một vật thể được');
      continue;
    }
    if (seen.has(`${n}:${key}`)) {
      reject('Đề xuất trùng lặp');
      continue;
    }
    seen.add(`${n}:${key}`);
    const current = objectValue(request, n, key);
    let normalized: { value: string } | { error: string };
    let label: string;
    if (key in AI_SETTINGS) {
      normalized = normalizeValue(key as AiSettingKey, value, request.nozzle_diameters, current);
      label = AI_SETTINGS[key as AiSettingKey].label;
    } else {
      const option = allowedOption(request, request.settings, key);
      if (!option) {
        reject('Studio không gửi tham số này');
        continue;
      }
      normalized = normalizeOptionValue(option, value, current);
      label = optionLabel(key, option);
    }
    if ('error' in normalized) {
      reject(normalized.error);
      continue;
    }
    if (sameOptionValue(current, normalized.value)) continue;
    const reason = change.reason.trim() + shadowNote(request, [n], key, false);
    changes.push({ object: n, name: object.name, key, label, value: normalized.value, reason });
  }
  return changes;
}

/** New plates: each object moves at most once, and some stay where they are */
function checkPlateMoves(
  proposed: NonNullable<AiProposal['new_plates']>,
  request: StudioRequest,
  working: number[],
  rejected: AiRejected[]
): AiPlateMove[] {
  const plates: AiPlateMove[] = [];
  const moved = new Set<number>();
  for (const plate of proposed) {
    const objects = [...new Set(plate.objects)];
    if (objects.length === 0) continue;
    const reject = (reason: string) =>
      rejected.push({ object: objects[0], key: 'new_plate', value: objects.map((n) => `#${n}`).join(', '), reason });
    const missing = objects.find((n) => !request.objects[n - 1]);
    const elsewhere = objects.find((n) => !working.includes(n));
    if (missing !== undefined) reject(`Không có vật thể #${missing}`);
    else if (elsewhere !== undefined) reject(`Vật thể #${elsewhere} không nằm trên bàn in ${request.current_plate}`);
    else if (objects.some((n) => moved.has(n))) reject('Vật thể đã được chuyển sang plate mới khác');
    else if (plates.length >= MAX_NEW_PLATES) reject(`Tối đa ${MAX_NEW_PLATES} plate mới mỗi lần`);
    else if (moved.size + objects.length >= working.length) reject('Không chuyển hết mọi vật thể: plate cũ sẽ trống');
    else {
      objects.forEach((n) => moved.add(n));
      plates.push({ objects, names: objects.map((n) => request.objects[n - 1].name), reason: plate.reason.trim() });
    }
  }
  return plates;
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
- Nếu có phần "Thành phần của plate này": mỗi thành phần đi kèm các lần in phần giống nó trên máy này, kết quả và setting lúc in. Với thành phần đã in tốt, giữ hoặc đưa setting liên quan về như lần in tốt; với thành phần từng lỗi, tránh setting của lần lỗi và sửa đúng lỗi đó. Giống càng cao (%) càng đáng tin. Khi một thay đổi dựa vào thành phần, lý do nêu id thành phần và bản in tham chiếu (ví dụ "F3 giống vành mâm của Plate07 in tốt với 3 vòng tường").
- Nhận xét timelapse mà người dùng đã chọn dùng cho lần in sau là yêu cầu của người dùng: áp dụng các đề xuất của nó như yêu cầu rõ ở trên, không coi là một bằng chứng để cân với các bản in thành công. Đề xuất "tăng"/"giảm" là một bước vừa phải so với setting của bản in đó, không phải lần hỏi nào cũng tăng/giảm thêm: nếu giá trị hiện tại đã đổi theo hướng đó so với lúc in thì coi như đã làm.
- object_changes: setting riêng cho một vật thể (object là số # của vật thể trong "Vật thể trên plate"), chồng lên preset quá trình in. Chỉ dùng các key trong phần "Tham số đặt riêng cho từng vật thể". Dùng khi chỉ một vài vật thể cần (brim cho chi tiết nhỏ, cao hoặc dài mảnh dễ bong; support cho vật có phần nhô; thêm vòng tường cho chi tiết chịu lực), thay vì đổi cho cả plate. Không đặt riêng cho vật thể giá trị đã bằng giá trị hiện tại của nó (giá trị đặt riêng nếu có, không thì của preset).
- Setting đặt riêng đang có (phần "Setting riêng đang có"): khi slice, setting riêng của vật thể thắng preset quá trình in, và setting của part/modifier hay khoảng chiều cao thắng cả setting riêng của vật thể. Đổi preset (cả dự án) không đổi vật thể ở key nó đã đặt riêng: nếu vật thể đó cũng cần đổi thì thêm object_changes cho nó; nếu giá trị riêng có vẻ là người dùng cố ý đặt (ví dụ support chỉ cho một vật) thì giữ. Ở phạm vi một bàn in, thay đổi target "process" ghi đè setting riêng của mọi vật thể trên bàn in đó. Setting của part/modifier và khoảng chiều cao thì AI không đổi được: nếu chúng làm một thay đổi mất tác dụng, nói trong summary.
- new_plates: mỗi phần tử là một plate mới, chứa các vật thể (số #) được chuyển sang đó; Studio xếp lại plate mới. Dùng khi in chung dễ hỏng cả bàn: chi tiết nhỏ, cao, mảnh dễ đổ hoặc bị đầu phun đụng bật cạnh các tấm lớn, vật cần setting rất khác nhau, hoặc người dùng (hay nhận xét timelapse họ chọn) yêu cầu tách. Không chuyển hết mọi vật thể; tối đa ${MAX_NEW_PLATES} plate mới. Preset quá trình in vẫn dùng chung cho mọi plate, nên setting chỉ hợp với vật thể đã tách thì đặt bằng object_changes. Không cần thì để danh sách rỗng.
- Mỗi lý do viết bằng tiếng Việt, một câu ngắn, nêu dựa vào đâu. Phần summary bằng tiếng Việt, tối đa ba câu (tối đa năm câu khi phải nói đề xuất nào của nhận xét timelapse đã bỏ qua).`;

function describeSettings(request: StudioRequest, keep: (key: string) => boolean = () => true): string {
  return AI_SETTING_KEYS.filter(keep).map((key) => {
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

/** The OBJECT_SETTINGS Studio sent, as "- key (label): hiện tại X; allowed" */
function describeObjectSettings(request: StudioRequest): string[] {
  return OBJECT_SETTING_KEYS.flatMap((key) => {
    const current = request.settings[key];
    if (current === undefined) return [];
    const option = request.options?.[key];
    if (option) return [describeOption(key, option, current)];
    const spec = (AI_SETTINGS as Record<string, SettingSpec>)[key];
    return spec ? [`- ${key} (${spec.label}): hiện tại ${current}`] : [];
  });
}

/** "key (label) = value" for settings an object, part or height range has of its own */
function describeOwn(request: StudioRequest, settings: Record<string, string>): string {
  return Object.entries(settings)
    .map(([key, value]) => {
      const label = request.options?.[key]?.label ?? (AI_SETTINGS as Record<string, SettingSpec>)[key]?.label;
      return `${key}${label ? ` (${label})` : ''} = ${value}`;
    })
    .join('; ');
}

const VOLUME_TYPES: Record<string, string> = {
  part: 'part',
  modifier: 'modifier',
  negative: 'khối trừ',
  support_blocker: 'chặn support',
  support_enforcer: 'ép support',
};

/** What the plate's objects already have set apart from the process preset, which wins over it when slicing */
function describeOwnSettings(request: StudioRequest, working: number[]): string[] {
  const lines = working.flatMap((n) => {
    const object = request.objects[n - 1];
    const own = object.settings && Object.keys(object.settings).length ? [`   vật thể: ${describeOwn(request, object.settings)}`] : [];
    const parts = (object.parts ?? []).map((p) => `   ${VOLUME_TYPES[p.type] ?? p.type} "${p.name}": ${describeOwn(request, p.settings)}`);
    const ranges = (object.height_ranges ?? []).map((r) => `   khoảng chiều cao ${r.from_mm}–${r.to_mm} mm: ${describeOwn(request, r.settings)}`);
    return own.length || parts.length || ranges.length ? [`- #${n} ${object.name}:`, ...own, ...parts, ...ranges] : [];
  });
  return lines.length
    ? [
        '',
        'Setting riêng đang có (thắng preset quá trình in khi slice; part/modifier và khoảng chiều cao thắng cả setting riêng của vật thể):',
        ...lines,
      ]
    : [];
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
        ...(followUp.previous.object_changes ?? []).map((c) => `- vật thể #${c.object} ${c.name}: ${c.key} (${c.label}) = ${c.value}: ${c.reason}`),
        ...(followUp.previous.plates ?? []).map((p) => `- plate mới cho ${p.objects.map((n, i) => `#${n} ${p.names[i]}`).join(', ')}: ${p.reason}`),
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
      ...(p.object_changes?.length ? [`   Setting riêng của vật thể: ${p.object_changes.map((c) => `${c.object}: ${c.key} = ${c.after}`).join('; ')}`] : []),
      ...(p.plates?.length ? [`   Tách sang plate mới: ${p.plates.map((names) => names.join(', ')).join(' | ')}`] : []),
      `   Kết quả: ${p.outcome}${p.issues.length ? `; lỗi: ${p.issues.join(', ')}` : ''}`,
      ...(p.defects?.length ? ['   Lỗi theo chi tiết (vật thể › bộ phận, vị trí: lỗi):', ...p.defects.map((d) => `   - ${d}`)] : []),
      ...(p.note ? [`   Ghi chú của người dùng: ${JSON.stringify(p.note)}`] : []),
      ...(p.video_review
        ? [`   Claude xem timelapse (chỉ qua camera ở xa, có thể nhầm; người dùng báo khác thì tin người dùng): ${JSON.stringify(p.video_review)}`]
        : []),
      ...(p.review_followed_at
        ? [
            `   Các đề xuất của nhận xét timelapse này đã được áp dụng ngày ${p.review_followed_at.slice(0, 10)}: giá trị hiện tại đã gồm chúng. Không tăng hay giảm thêm theo nhận xét này; chỉ đổi tiếp khi một bản in mới cho thấy còn lỗi.`,
          ]
        : []),
    ]),
    ...describeChosenReviews(pastPrints),
  ];
}

/**
 * The advice of the timelapse reviews the user chose "Dùng cho lần in sau" for: a request to follow it, not one more
 * piece of history to weigh against the prints that went well
 */
function describeChosenReviews(pastPrints: PastPrint[]): string[] {
  const chosen = pastPrints.map((p, i) => ({ p, n: i + 1 })).filter(({ p }) => p.review_suggestions?.length);
  if (chosen.length === 0) return [];
  return [
    '',
    'Người dùng đã chọn "Dùng cho lần in sau" cho nhận xét timelapse của các bản in sau, nghĩa là họ muốn các đề xuất này được áp dụng:',
    ...chosen.flatMap(({ p, n }) => [
      `Bản in số ${n} ở trên (${p.created_at.slice(0, 10)}, ${p.objects.join('; ')}):`,
      ...p.review_suggestions!.map((s, i) => `   ${n}.${i + 1}. ${s}`),
    ]),
    'Các đề xuất này chưa được áp dụng lần nào. Với từng đề xuất: nếu làm được bằng các key được liệt kê, bằng setting riêng của vật thể (object_changes) hoặc bằng tách vật thể sang plate mới (new_plates) thì làm theo, trừ khi giá trị hiện tại đã đúng như đề xuất. Các bản in khác thành công không phải lý do để bỏ qua. Chỉ bỏ qua đề xuất không làm được bằng setting hay tách plate (sấy nhựa, hiệu chỉnh máy...), đã có sẵn, hoặc trái với yêu cầu của người dùng. Lý do của mỗi thay đổi nêu số đề xuất (ví dụ "theo nhận xét timelapse 4.3"). Summary liệt kê ngắn các đề xuất đã bỏ qua và vì sao.',
  ];
}

/** `parts` is the section on the plate's parts and alike parts printed before (modelParts.describeParts) */
export function buildUserPrompt(
  request: StudioRequest,
  printerState: PrinterState | null,
  followUp: FollowUp | null = null,
  pastPrints: PastPrint[] = [],
  parts: string[] = []
): string {
  const plate = targetPlate(request);
  const working = workingObjects(request);
  // For one plate, only what Studio can set on its objects
  const keep = (key: string) => plate === null || plateSetting(request, key);
  return [
    `Mục tiêu: ${GOALS[request.goal]}`,
    ...(request.user_request
      ? [
          '',
          'Yêu cầu của người dùng (làm theo; nếu yêu cầu làm tăng nguy cơ in hỏng thì vẫn làm nhưng nói rõ rủi ro trong summary; nếu không làm được bằng setting thì nói trong summary):',
          JSON.stringify(request.user_request),
        ]
      : []),
    ...(plate !== null
      ? [
          '',
          `Phạm vi: chỉ bàn in ${plate} (${working.length} vật thể). Studio đặt các thay đổi target "process" riêng cho từng vật thể trên bàn in này, các bàn in khác giữ nguyên preset. Chỉ dùng các key target "process" được liệt kê dưới đây (key khác chỉ đặt được cho cả dự án và sẽ bị từ chối). Preset filament dùng chung cho mọi bàn in dùng filament đó: chỉ đổi filament khi thật cần, và nói rõ điều đó trong lý do. object_changes và new_plates chỉ cho vật thể của bàn in này.`,
        ]
      : []),
    '',
    `Preset máy: ${request.printer_preset}`,
    `Preset quá trình in: ${request.process_preset}`,
    `Đường kính đầu phun trong preset: ${request.nozzle_diameters.join(', ')} mm`,
    `Filament: ${request.filaments.map((f, i) => `#${i + 1} ${f.preset}${f.type ? ` (${f.type})` : ''}${f.used === false ? ' (không dùng trên plate này)' : ''}`).join('; ') || 'không rõ'}`,
    '',
    'Máy in thực tế:',
    describePrinter(printerState),
    '',
    plate !== null ? `Tham số chính đặt được cho bàn in ${plate} (target "process"), giá trị hiện tại là của preset:` : 'Tham số chính của preset quá trình in (target "process"):',
    describeSettings(request, keep),
    ...(request.options
      ? [
          '',
          plate !== null ? `Các tham số khác đặt được cho bàn in ${plate} (target "process"):` : 'Các tham số khác của preset quá trình in (target "process"):',
          ...variantsLine(request.process_variants),
          ...describeOptions(request, request.settings, (key) => key in AI_SETTINGS || !keep(key)),
        ]
      : []),
    ...describeFilaments(request),
    '',
    plate !== null
      ? `Vật thể trên bàn in ${plate} (số # dùng cho object_changes và new_plates):`
      : `Vật thể trên plate (số # dùng cho object_changes và new_plates${request.current_plate ? `; plate đang mở là plate ${request.current_plate}` : ''}):`,
    // The footprints and outlines are for drawing the plate: hundreds of corners that say nothing about how to print
    JSON.stringify(
      working.map((n) => {
        const { footprint: _footprint, outline: _outline, settings: _settings, parts: _parts, height_ranges: _ranges, ...o } = request.objects[n - 1];
        return { '#': n, ...o };
      }),
      null,
      1
    ),
    '',
    'Tham số đặt riêng cho từng vật thể (object_changes), giá trị hiện tại là của preset quá trình in:',
    ...describeObjectSettings(request),
    ...describeOwnSettings(request, working),
    ...parts,
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

Trước khi trả lời theo schema, viết phần phân tích ngắn để người dùng theo dõi trong lúc chờ: tiếng Việt, mỗi ý một dòng bắt đầu bằng "• ", mỗi dòng dưới 15 chữ, tối đa 12 dòng, theo thứ tự: hình dạng và các thành phần của vật thể (và thành phần giống đã in trước, nếu có), vật liệu và đầu phun, kết quả in trước (nếu có), rồi từng nhóm setting sẽ đổi và vì sao. Không viết gì khác ngoài các dòng đó.`;

/** The system and user prompts for a plate, for callers that ask Claude themselves */
export function buildPrompts(
  request: StudioRequest,
  printerState: PrinterState | null,
  followUp: FollowUp | null = null,
  pastPrints: PastPrint[] = [],
  parts: string[] = []
): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: buildUserPrompt(request, printerState, followUp, pastPrints, parts) };
}

export async function optimizeSettings(
  request: StudioRequest,
  printerState: PrinterState | null,
  source: ProposalSource,
  followUp: FollowUp | null = null,
  pastPrints: PastPrint[] = [],
  parts: string[] = []
): Promise<AiOptimizeResult> {
  const { system, user } = buildPrompts(request, printerState, followUp, pastPrints, parts);
  const proposal = await source(system, user);
  return checkProposal(proposal, request);
}
