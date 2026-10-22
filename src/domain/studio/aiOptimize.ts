import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { z } from 'zod';
import type { PrinterState } from '../PrinterState';

/**
 * "AI tối ưu" in Bambu Studio: Studio describes the open plate (presets, current process settings,
 * object geometry), Claude proposes process-setting changes, and only the keys below come back.
 * Studio shows them to the user and applies the accepted ones to the edited process preset.
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

// Process (print preset) settings the AI may change, with the values Studio v02.08.04.57 accepts
// (src/libslic3r/PrintConfig.cpp). Studio sends the whole process preset, so adding a key here is enough.
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

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** What Studio writes when the button is clicked (studio/bambustudio/ai-button.patch) */
export const studioRequestSchema = z.object({
  version: z.literal(1),
  goal: z.enum(['balanced', 'quality', 'speed', 'strength', 'material']).default('balanced'),
  printer_preset: z.string(),
  process_preset: z.string(),
  nozzle_diameters: z.array(z.number()),
  filaments: z.array(z.object({ preset: z.string(), type: z.string().optional() })),
  settings: z.record(z.string()),
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
  previous: { summary: string; changes: { key: string; label: string; value: string; reason: string }[] } | null;
  comment: string;
}

/** An earlier plate like this one, printed with the changes the user applied, and how it came out */
export interface PastPrint {
  created_at: string;
  goal: StudioRequest['goal'];
  process_preset: string;
  filaments: string[];
  objects: string[];
  /** Applied changes, with the value each replaced (null when it was not kept) */
  changes: { key: string; before: string | null; after: string }[];
  outcome: string;
  issues: string[];
  note: string;
}

export interface AiChange {
  key: AiSettingKey;
  label: string;
  /** Studio's serialized form, e.g. "0.16", "15%", "1", "gyroid" */
  value: string;
  reason: string;
}

export interface AiRejected {
  key: string;
  value: string;
  reason: string;
}

export interface AiOptimizeResult {
  summary: string;
  changes: AiChange[];
  rejected: AiRejected[];
}

/** One proposal as the model writes it: the value is free text, checked against AI_SETTINGS afterwards */
export const PROPOSAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: AI_SETTING_KEYS },
          value: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['key', 'value', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'changes'],
  additionalProperties: false,
} as const;

// Sent as written: the API enforces the key enum, which the SDK's transform would demote to a description
const proposalFormat = jsonSchemaOutputFormat(PROPOSAL_JSON_SCHEMA, { transform: false });

export interface AiProposal {
  summary: string;
  changes: { key: string; value: string; reason: string }[];
}

/** A proposal made outside the gateway (`claude -p` in Studio's container), sent back to be checked */
export const aiProposalSchema = z.object({
  summary: z.string(),
  changes: z.array(z.object({ key: z.string(), value: z.string(), reason: z.string() })).max(100),
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
 * "nil" stays nil.
 */
function scaleVector(raw: string, current: string | undefined, spec: { min: number; max: number }): { value: string } | { error: string } {
  if (current === undefined) return { error: 'Studio không gửi giá trị hiện tại của tham số này' };
  const reference = firstVariant(current);
  if (reference === null) return { error: `Không có giá trị hiện tại để làm mốc (${current})` };
  const values = [...new Set(raw.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean))];
  if (values.length !== 1) return { error: `"${raw}" phải là một giá trị cho đầu phun đầu tiên` };
  const n = Number(values[0].replace(/mm\/s$/, '').trim());
  if (!Number.isFinite(n)) return { error: `"${raw}" không phải số` };
  if (n < spec.min || n > spec.max) return { error: `${n} nằm ngoài khoảng ${spec.min}–${spec.max}` };
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

/** Keeps the proposals that are allowed, valid and actually change something; explains the rest */
export function checkProposal(proposal: AiProposal, request: StudioRequest): AiOptimizeResult {
  const changes: AiChange[] = [];
  const rejected: AiRejected[] = [];
  const seen = new Set<string>();
  for (const { key, value, reason } of proposal.changes) {
    if (!(key in AI_SETTINGS)) {
      rejected.push({ key, value, reason: 'Tham số không nằm trong danh sách AI được phép đổi' });
      continue;
    }
    const settingKey = key as AiSettingKey;
    if (seen.has(settingKey)) {
      rejected.push({ key, value, reason: 'Đề xuất trùng lặp' });
      continue;
    }
    seen.add(settingKey);
    const normalized = normalizeValue(settingKey, value, request.nozzle_diameters, request.settings[settingKey]);
    if ('error' in normalized) {
      rejected.push({ key, value, reason: normalized.error });
      continue;
    }
    if (sameValue(settingKey, request.settings[settingKey], normalized.value)) continue;
    changes.push({ key: settingKey, label: AI_SETTINGS[settingKey].label, value: normalized.value, reason: reason.trim() });
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
Bạn nhận mô tả plate đang mở: preset máy, preset quá trình in, filament, giá trị hiện tại của các tham số được phép đổi, và hình học từng vật thể (kích thước mm, thể tích, diện tích đáy tiếp xúc bàn in, diện tích bề mặt nhô quá 45° không nằm trên bàn in).

Đề xuất thay đổi các tham số quá trình in để bản in thành công và phù hợp mục tiêu người dùng.
- Chỉ dùng các key được liệt kê. Giá trị viết theo đúng cách Bambu Studio lưu: số thập phân dùng dấu chấm, phần trăm như "15%", bật/tắt là "1"/"0", enum đúng chính tả trong danh sách.
- Chỉ đề xuất khi có lý do cụ thể từ hình học, vật liệu hoặc mục tiêu. Không đổi tham số đã hợp lý. Nếu mọi thứ đã ổn, trả về danh sách rỗng.
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
              ? `một số ${spec.min}–${spec.max} mm/s cho đầu phun đầu tiên, các biến thể khác đổi cùng tỉ lệ`
              : `${spec.kind} ${spec.min}–${spec.max}${spec.kind === 'percent' ? '%' : ''}`;
    const value = request.settings[key];
    const reference = spec.kind === 'floats' && value !== undefined ? firstVariant(value) : null;
    const shown = reference !== null ? `${reference} (tất cả biến thể: ${value})` : (value ?? 'không rõ');
    return `- ${key} (${spec.label}): hiện tại ${shown}; cho phép ${allowed}`;
  }).join('\n');
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
        ...followUp.previous.changes.map((c) => `- ${c.key} (${c.label}) = ${c.value}: ${c.reason}`),
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
  const label = (key: string) => (AI_SETTINGS as Record<string, SettingSpec>)[key]?.label;
  return [
    '',
    'Kết quả in thực tế của các plate tương tự trên máy này (đã áp dụng đề xuất rồi in), mới nhất trước khi giống nhau như nhau:',
    ...pastPrints.flatMap((p, i) => [
      `${i + 1}. ${p.created_at.slice(0, 10)}, mục tiêu ${p.goal}, preset ${p.process_preset}, filament ${p.filaments.join('; ') || 'không rõ'}`,
      `   Vật thể: ${p.objects.join('; ')}`,
      p.changes.length
        ? `   Đã đổi: ${p.changes.map((c) => `${c.key}${label(c.key) ? ` (${label(c.key)})` : ''} ${c.before ?? '?'} → ${c.after}`).join('; ')}`
        : '   Đã đổi: không, in với preset như cũ',
      `   Kết quả: ${p.outcome}${p.issues.length ? `; lỗi: ${p.issues.join(', ')}` : ''}`,
      ...(p.note ? [`   Ghi chú của người dùng: ${JSON.stringify(p.note)}`] : []),
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
    `Filament: ${request.filaments.map((f, i) => `#${i + 1} ${f.preset}${f.type ? ` (${f.type})` : ''}`).join('; ') || 'không rõ'}`,
    '',
    'Máy in thực tế:',
    describePrinter(printerState),
    '',
    'Tham số được phép đổi:',
    describeSettings(request),
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
