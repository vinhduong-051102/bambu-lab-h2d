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
  | { kind: 'enum'; values: readonly string[]; label: string };

// Process (print preset) settings the AI may change, with the values Studio v02.08.04.57 accepts
// (src/libslic3r/PrintConfig.cpp). Studio reports the current value of each of these keys.
export const AI_SETTINGS = {
  layer_height: { kind: 'float', min: 0.04, max: 0.6, label: 'Chiều cao lớp' },
  initial_layer_print_height: { kind: 'float', min: 0.08, max: 0.6, label: 'Chiều cao lớp đầu' },
  wall_loops: { kind: 'int', min: 1, max: 10, label: 'Số vòng tường' },
  top_shell_layers: { kind: 'int', min: 0, max: 30, label: 'Số lớp vỏ trên' },
  bottom_shell_layers: { kind: 'int', min: 0, max: 30, label: 'Số lớp vỏ dưới' },
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
  enable_support: { kind: 'bool', label: 'Bật support' },
  // Manual support types only print where the user painted, so the AI sticks to the automatic ones
  support_type: { kind: 'enum', values: ['normal(auto)', 'tree(auto)'], label: 'Loại support' },
  support_style: { kind: 'enum', values: ['default', 'grid', 'snug', 'tree_slim', 'tree_strong', 'tree_hybrid', 'tree_organic'], label: 'Kiểu support' },
  support_threshold_angle: { kind: 'int', min: 0, max: 90, label: 'Góc ngưỡng support' },
  support_on_build_plate_only: { kind: 'bool', label: 'Support chỉ từ bàn in' },
  brim_type: { kind: 'enum', values: ['auto_brim', 'outer_only', 'inner_only', 'outer_and_inner', 'no_brim'], label: 'Kiểu brim' },
  brim_width: { kind: 'float', min: 0, max: 20, label: 'Độ rộng brim' },
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
});
export type StudioRequest = z.infer<typeof studioRequestSchema>;

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
const proposalFormat = jsonSchemaOutputFormat({
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
  // Sent as written: the API enforces the key enum, which the SDK's transform would demote to a description
} as const, { transform: false });

export interface AiProposal {
  summary: string;
  changes: { key: string; value: string; reason: string }[];
}

const round = (n: number, digits: number) => Number(n.toFixed(digits));

/**
 * The model's value for `key` in Studio's serialized form, or an error message.
 * Out-of-range numbers are rejected rather than clamped: a clamped value is one nobody reasoned about.
 */
export function normalizeValue(key: AiSettingKey, raw: string, nozzleDiameters: number[]): { value: string } | { error: string } {
  const spec: SettingSpec = AI_SETTINGS[key];
  const text = raw.trim().toLowerCase();
  switch (spec.kind) {
    case 'bool':
      if (['1', 'true', 'yes', 'on'].includes(text)) return { value: '1' };
      if (['0', 'false', 'no', 'off'].includes(text)) return { value: '0' };
      return { error: `"${raw}" không phải giá trị bật/tắt` };
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
  if (kind === 'enum' || kind === 'bool') return a.trim().toLowerCase() === b;
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
    const normalized = normalizeValue(settingKey, value, request.nozzle_diameters);
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
- Cân nhắc: phần nhô lớn thì cần support (tree(auto) cho mẫu hữu cơ/phức tạp); vật cao, đáy nhỏ hoặc vật liệu dễ cong vênh (ABS, ASA, PA, PC) thì cần brim; chi tiết chịu lực thì thêm vòng tường và infill; mẫu trang trí thì giảm infill.
- Thông tin hình học là ước lượng từ lưới tam giác, không phải kết quả slice.
- Mỗi lý do viết bằng tiếng Việt, một câu ngắn, nêu dựa vào đâu. Phần summary bằng tiếng Việt, tối đa ba câu.`;

function describeSettings(request: StudioRequest): string {
  return AI_SETTING_KEYS.map((key) => {
    const spec: SettingSpec = AI_SETTINGS[key];
    const allowed =
      spec.kind === 'enum' ? `một trong: ${spec.values.join(' | ')}` : spec.kind === 'bool' ? '"1" hoặc "0"' : `${spec.kind} ${spec.min}–${spec.max}${spec.kind === 'percent' ? '%' : ''}`;
    return `- ${key} (${spec.label}): hiện tại ${request.settings[key] ?? 'không rõ'}; cho phép ${allowed}`;
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

export function buildUserPrompt(request: StudioRequest, printerState: PrinterState | null): string {
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

export async function optimizeSettings(
  request: StudioRequest,
  printerState: PrinterState | null,
  source: ProposalSource
): Promise<AiOptimizeResult> {
  const proposal = await source(SYSTEM_PROMPT, buildUserPrompt(request, printerState));
  return checkProposal(proposal, request);
}
