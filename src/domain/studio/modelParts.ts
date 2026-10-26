import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { z } from 'zod';
import type { PrintRecord } from '../prints/PrintJournal';
import type { VisionModel } from '../timelapse/TimelapseReviewer';
import type { StudioRequest } from './aiOptimize';
import { PRINT_ISSUE_LABELS, PRINT_OUTCOME_LABELS } from './aiSessions';

/**
 * "Thành phần của mẫu": the parts of a model that matter for printing it (thin walls, overhangs, bridges, holes,
 * pillars, the base…), so "AI tối ưu" can learn from earlier prints part by part: a thin wall like this one printed
 * well with these settings, a bridge like this one sagged with those.
 *
 * Studio only sends numbers about each object (size, volume, base and overhang area, worked out after its turn and
 * scale on the plate). The mesh itself is found by name in Studio's import folder; the mesh worker (mesh3d/analyze.py)
 * turns and scales it until it gives the same numbers, measures its parts, and renders them in colour. Claude then
 * looks at the renders and names the parts ("vành mâm", "ngàm cài"). An analysis is kept per file content and
 * placement, so a model is measured once.
 */

export type PartKind = 'base' | 'thin_wall' | 'thin_plate' | 'overhang' | 'ceiling' | 'hole' | 'pillar' | 'top';
type Metrics = Record<string, number | string | boolean | number[]>;

export interface PartFeature {
  id: string;
  kind: PartKind;
  /** How many alike parts the model repeats (four wheels, six screw holes) */
  count: number;
  metrics: Metrics;
  /** Bounding box in mm, the object's corner at 0,0,0 */
  where: { x: [number, number]; y: [number, number]; z: [number, number] };
  /** Its colour on the coloured render */
  colour: string;
}

export interface PartComponent {
  name: string;
  role: string;
  features: string[];
  risk: string;
}

/** What Studio says about an object: the numbers its placement is matched against */
export interface ObjectNumbers {
  name: string;
  size_mm: number[];
  volume_mm3: number;
  surface_area_mm2: number;
  base_area_mm2: number;
  overhang_area_mm2: number;
}

export interface ModelAnalysis {
  key: string;
  /** The file in Studio's import folder */
  file: string;
  object: ObjectNumbers;
  analyzed_at: string;
  matched: boolean;
  /** Why the parts could not be measured (the object sits some other way than in the file) */
  reason?: string;
  size_mm?: number[];
  features: PartFeature[];
  /** Claude's reading of the renders; missing until it answered, or when it failed (naming_error) */
  description?: string;
  purpose?: string;
  components?: PartComponent[];
  named_by?: string;
  naming_error?: string;
  views?: string[];
}

// ---------- Finding the mesh ----------

const MESH_EXTENSIONS = ['.stl', '.3mf', '.obj'];

/** "Plate03_Den_Can_Op_fixed(1).stl" → "plate03_den_can_op": Studio's own suffixes for repaired or copied objects */
export function baseName(name: string): string {
  return path
    .parse(name.trim())
    .name.replace(/\s*\(\d+\)$/, '')
    .replace(/_fixed$/i, '')
    .replace(/\s*\(\d+\)$/, '')
    .trim()
    .toLowerCase();
}

/** The import file an object came from: its own name first, else the one with the same base name (STL first) */
export async function findImportFile(dir: string, objectName: string): Promise<string | null> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return null;
  }
  const meshes = files.filter((f) => !f.startsWith('.') && MESH_EXTENSIONS.includes(path.extname(f).toLowerCase()));
  if (meshes.includes(objectName)) return objectName;
  const wanted = baseName(objectName);
  const same = meshes.filter((f) => baseName(f) === wanted);
  same.sort((a, b) => MESH_EXTENSIONS.indexOf(path.extname(a).toLowerCase()) - MESH_EXTENSIONS.indexOf(path.extname(b).toLowerCase()) || a.length - b.length);
  return same[0] ?? null;
}

const numbersOf = (o: ObjectNumbers): ObjectNumbers => ({
  name: o.name,
  size_mm: o.size_mm.map((n) => Math.round(n * 10) / 10),
  volume_mm3: Math.round(o.volume_mm3),
  surface_area_mm2: Math.round(o.surface_area_mm2),
  base_area_mm2: Math.round(o.base_area_mm2),
  overhang_area_mm2: Math.round(o.overhang_area_mm2),
});

/** One analysis per file content and placement */
export function analysisKey(content: Buffer, object: ObjectNumbers): string {
  const { name: _name, ...placement } = numbersOf(object);
  return createHash('sha256').update(content).update(JSON.stringify(placement)).digest('hex').slice(0, 32);
}

// ---------- The mesh worker and Claude ----------

export interface PartsWorker {
  analyze(file: string, key: string, target: ObjectNumbers): Promise<{ orientation: { matched: boolean | null; reason?: string }; size_mm?: number[]; features: PartFeature[]; views?: string[] }>;
}

export class MeshPartsWorker implements PartsWorker {
  constructor(private readonly baseUrl: string) {}

  async analyze(file: string, key: string, target: ObjectNumbers) {
    let res: Response;
    try {
      res = await fetch(new URL('/analyze', this.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, key, target }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new Error(`Container mesh3d không trả lời (${this.baseUrl}).`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.message ?? `Container mesh3d trả lỗi HTTP ${res.status}.`);
    return data;
  }
}

/** What each kind of part is, for Claude and for the prompt */
export const PART_LABELS: Record<PartKind, string> = {
  base: 'Đế (phần đứng trên bàn)',
  thin_wall: 'Thành mỏng',
  thin_plate: 'Tấm mỏng nằm ngang',
  overhang: 'Phần nhô',
  ceiling: 'Mặt dưới phẳng (cầu, trần)',
  hole: 'Lỗ',
  pillar: 'Trụ mảnh',
  top: 'Mặt trên phẳng',
};

const fmt = (n: unknown) => (typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }).replace(/,/g, '') : String(n));

/** One part in words: "Thành mỏng ×4: dày 0.6–2.3 mm, cao 11 mm, 5057 mm²" */
export function describeFeature(f: PartFeature): string {
  const m = f.metrics;
  const where = { plate: 'bàn', part: 'phần bên dưới' }[String(m.over)] ?? 'bàn';
  const detail: Record<PartKind, () => string> = {
    base: () =>
      `tiếp xúc ${fmt(m.contact_mm2)} mm² (${Math.round(Number(m.contact_share) * 100)}% khung đáy ${fmt((m.footprint_mm as number[])[0])}×${fmt((m.footprint_mm as number[])[1])} mm), vật cao ${fmt(m.height_mm)} mm (cao/rộng ${fmt(m.height_per_width)})`,
    thin_wall: () => `dày ${fmt(m.thin_mm)}–${fmt(m.median_mm)} mm, cao ${fmt(m.height_mm)} mm, ${fmt(m.area_mm2)} mm²`,
    thin_plate: () => `dày ${fmt(m.thin_mm)}–${fmt(m.median_mm)} mm, ${fmt(m.area_mm2)} mm²`,
    overhang: () => `${fmt(m.area_mm2)} mm², nghiêng ${fmt(m.angle_from_flat_deg)}° so với phương ngang, ở cao ${fmt(m.height_mm)} mm, cách ${where} ${fmt(m.gap_below_mm)} mm`,
    ceiling: () => `${fmt(m.area_mm2)} mm², nhịp ${fmt(m.span_mm)} mm, ở cao ${fmt(m.height_mm)} mm, cách ${where} ${fmt(m.gap_below_mm)} mm`,
    hole: () => `Ø${fmt(m.diameter_mm)} mm ${m.direction}, sâu ${fmt(m.length_mm)} mm${m.round ? '' : ', không tròn'}`,
    pillar: () => `rộng ${fmt(m.width_mm)} mm, cao ${fmt(m.height_mm)} mm`,
    top: () => `${fmt(m.area_mm2)} mm² ở cao ${fmt(m.height_mm)} mm`,
  };
  return `${PART_LABELS[f.kind]}${f.count > 1 ? ` ×${f.count}` : ''}: ${detail[f.kind]()}`;
}

const NAMING_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'Mẫu là gì, một câu' },
    purpose: { type: 'string', description: 'Dùng để làm gì: lắp ghép, chịu lực, vỏ/hộp, trang trí... và điều quan trọng nhất khi in nó' },
    components: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tên bộ phận bằng tiếng Việt, vài từ (vd. "vành mâm", "ngàm cài", "chân đế")' },
          role: { type: 'string', description: 'Vai trò của nó trong mẫu' },
          features: { type: 'array', items: { type: 'string' }, description: 'Id các thành phần đo được thuộc bộ phận này (F1, F2...)' },
          risk: { type: 'string', description: 'Điều dễ hỏng khi in bộ phận này, một câu' },
        },
        required: ['name', 'role', 'features', 'risk'],
        additionalProperties: false,
      },
    },
  },
  required: ['description', 'purpose', 'components'],
  additionalProperties: false,
};

const namingSchema = z.object({
  description: z.string().transform((s) => s.slice(0, 400)),
  purpose: z.string().transform((s) => s.slice(0, 400)),
  components: z
    .array(
      z.object({
        name: z.string().transform((s) => s.slice(0, 80)),
        role: z.string().transform((s) => s.slice(0, 200)),
        features: z.array(z.string()),
        risk: z.string().transform((s) => s.slice(0, 300)),
      })
    )
    .max(20),
});

const NAMING_SYSTEM = `Bạn là kỹ sư in 3D FDM. Bạn nhận hai ảnh render một mẫu từ sáu phía (ảnh thứ hai tô màu từng thành phần đo được) và danh sách các thành phần đo trên lưới (id, loại, số đo, vị trí mm tính từ góc trái-trước-dưới, màu trên ảnh).
Nhìn ảnh để hiểu mẫu là gì, rồi gom các thành phần đo được thành các bộ phận có tên (một bộ phận có thể gồm nhiều thành phần, một thành phần chỉ thuộc một bộ phận). Thành phần nào không rõ thuộc đâu thì vẫn đặt tên theo hình dạng của nó. Viết tiếng Việt, ngắn gọn. Chỉ dùng id có trong danh sách.`;

function namingPrompt(analysis: ModelAnalysis, files: string[]): string {
  return [
    `Mẫu: ${analysis.object.name}, ${analysis.size_mm?.join(' × ')} mm.`,
    `Ảnh: ${files[0]} (mẫu), ${files[1]} (các thành phần tô màu, phần xám là phần còn lại).`,
    'Các thành phần đo được:',
    ...analysis.features.map((f) => `- ${f.id} (màu ${f.colour}): ${describeFeature(f)}; vị trí x ${f.where.x.join('–')}, y ${f.where.y.join('–')}, z ${f.where.z.join('–')}`),
  ].join('\n');
}

// ---------- The store and the service ----------

export class ModelPartsStore {
  constructor(readonly dir: string) {}

  private file(key: string) {
    return path.join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<ModelAnalysis | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(key), 'utf8')) as ModelAnalysis;
    } catch {
      return null;
    }
  }

  async save(analysis: ModelAnalysis): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(analysis.key)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(analysis, null, 1));
    await fs.rename(tmp, this.file(analysis.key));
  }

  /** A render of an analysis (views.png, parts.png), or null */
  async image(key: string, name: string): Promise<Buffer | null> {
    if (!/^[a-f0-9]{32}$/.test(key) || !['views.png', 'parts.png'].includes(name)) return null;
    return fs.readFile(path.join(this.dir, key, name)).catch(() => null);
  }
}

export class ModelParts {
  /** Analyses being made, so one object asked for twice is measured once: the parts, then the names */
  private readonly running = new Map<string, { measured: Promise<ModelAnalysis>; named: Promise<ModelAnalysis> }>();

  constructor(
    private readonly importDir: string,
    readonly store: ModelPartsStore,
    private readonly worker: PartsWorker | null,
    private readonly namer: VisionModel | null,
    private readonly now = () => new Date()
  ) {}

  get enabled() {
    return this.worker !== null;
  }

  /** The import file and the key of an object's analysis, or null when its mesh isn't in the import folder */
  async locate(object: ObjectNumbers): Promise<{ file: string; key: string } | null> {
    const file = await findImportFile(this.importDir, object.name);
    if (!file) return null;
    const content = await fs.readFile(path.join(this.importDir, file)).catch(() => null);
    return content ? { file, key: analysisKey(content, object) } : null;
  }

  /** The analysis already made for an object, without measuring anything */
  async cached(object: ObjectNumbers): Promise<ModelAnalysis | null> {
    const found = await this.locate(object);
    return found ? this.store.get(found.key) : null;
  }

  /**
   * An object's analysis: the kept one, else measured now and named by Claude. With `nameWithinMs`, waits that long
   * for the names before answering with the parts alone (the names are still saved when they come). With `retryNaming`,
   * asks Claude again when it failed last time. Null when the mesh isn't in the import folder.
   */
  async analyze(
    object: ObjectNumbers,
    { nameWithinMs = Infinity, retryNaming = false }: { nameWithinMs?: number; retryNaming?: boolean } = {}
  ): Promise<ModelAnalysis | null> {
    if (!this.worker) return null;
    const found = await this.locate(object);
    if (!found) return null;
    let kept = await this.store.get(found.key);
    if (kept?.naming_error !== undefined && retryNaming) kept = { ...kept, naming_error: undefined };
    if (kept && this.isNamed(kept)) return kept;

    let job = this.running.get(found.key);
    if (!job) {
      const measured = kept ? Promise.resolve(kept) : this.measure(found, object);
      const named = measured.then((analysis) => this.name(analysis));
      job = { measured, named };
      this.running.set(found.key, job);
      named.catch(() => {}).finally(() => this.running.delete(found.key));
    }
    if (nameWithinMs === Infinity) return job.named;
    const measured = await job.measured;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => (timer = setTimeout(resolve, nameWithinMs, null)));
    try {
      return (await Promise.race([job.named, timeout])) ?? measured;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Nothing more to ask Claude: named, failed to be named, or with no parts to name */
  private isNamed(a: ModelAnalysis) {
    return !a.matched || !this.namer || a.features.length === 0 || a.components !== undefined || a.naming_error !== undefined;
  }

  private async measure(found: { file: string; key: string }, object: ObjectNumbers): Promise<ModelAnalysis> {
    const result = await this.worker!.analyze(found.file, found.key, numbersOf(object));
    const analysis: ModelAnalysis = {
      key: found.key,
      file: found.file,
      object: numbersOf(object),
      analyzed_at: this.now().toISOString(),
      matched: result.orientation.matched !== false,
      ...(result.orientation.reason ? { reason: result.orientation.reason } : {}),
      ...(result.size_mm ? { size_mm: result.size_mm } : {}),
      features: result.features ?? [],
      ...(result.views ? { views: result.views } : {}),
    };
    await this.store.save(analysis);
    return analysis;
  }

  private async name(analysis: ModelAnalysis): Promise<ModelAnalysis> {
    if (this.isNamed(analysis)) return analysis;
    let named: ModelAnalysis;
    try {
      const images = await Promise.all(['views.png', 'parts.png'].map((n) => this.store.image(analysis.key, n)));
      if (images.some((i) => !i)) throw new Error('Thiếu ảnh render của mẫu.');
      const raw = await this.namer!.review(NAMING_SYSTEM, (files) => namingPrompt(analysis, files), images as Buffer[], NAMING_SCHEMA, 'png');
      const naming = namingSchema.parse(raw);
      const ids = new Set(analysis.features.map((f) => f.id));
      named = {
        ...analysis,
        description: naming.description,
        purpose: naming.purpose,
        components: naming.components.map((c) => ({ ...c, features: c.features.filter((id) => ids.has(id)) })),
        named_by: this.namer!.name,
      };
    } catch (err) {
      named = { ...analysis, naming_error: err instanceof Error ? err.message : String(err) };
    }
    await this.store.save(named);
    return named;
  }
}

// ---------- Comparing parts across prints ----------

const logRatio = (a: unknown, b: unknown, scale: number) => Math.abs(Math.log((Number(a) + 0.1) / (Number(b) + 0.1))) / scale;
const sameWhere = (a: Metrics, b: Metrics) => (a.over === b.over ? 0 : 0.5);

/** How far apart two parts of one kind are: 0 is the same */
const DISTANCE: Record<PartKind, (a: Metrics, b: Metrics) => number | null> = {
  base: (a, b) => logRatio(a.height_per_width, b.height_per_width, 0.5) + Math.abs(Number(a.contact_share) - Number(b.contact_share)) / 0.3 + logRatio(a.contact_mm2, b.contact_mm2, 1),
  thin_wall: (a, b) => logRatio(a.thin_mm, b.thin_mm, 0.6) + logRatio(a.median_mm, b.median_mm, 0.6) + logRatio(a.height_mm, b.height_mm, 1),
  thin_plate: (a, b) => logRatio(a.thin_mm, b.thin_mm, 0.6) + logRatio(a.median_mm, b.median_mm, 0.6) + logRatio(a.area_mm2, b.area_mm2, 1.2),
  overhang: (a, b) =>
    Math.abs(Number(a.angle_from_flat_deg) - Number(b.angle_from_flat_deg)) / 20 + logRatio(a.area_mm2, b.area_mm2, 1.2) + logRatio(a.gap_below_mm, b.gap_below_mm, 1) + sameWhere(a, b),
  ceiling: (a, b) => logRatio(a.span_mm, b.span_mm, 0.5) + logRatio(a.gap_below_mm, b.gap_below_mm, 1) + logRatio(a.area_mm2, b.area_mm2, 1.5) + sameWhere(a, b),
  hole: (a, b) => (a.direction !== b.direction ? null : logRatio(a.diameter_mm, b.diameter_mm, 0.3) + logRatio(a.length_mm, b.length_mm, 1)),
  pillar: (a, b) => logRatio(a.width_mm, b.width_mm, 0.4) + logRatio(a.height_per_width, b.height_per_width, 0.5),
  top: (a, b) => logRatio(a.area_mm2, b.area_mm2, 1),
};

/** 1 for the same part, falling towards 0 as they differ; null for parts of different kinds */
export function partSimilarity(a: PartFeature, b: PartFeature): number | null {
  if (a.kind !== b.kind) return null;
  const distance = DISTANCE[a.kind](a.metrics, b.metrics);
  return distance === null ? null : Math.round(Math.exp(-distance) * 100) / 100;
}

const MIN_SIMILARITY = 0.45;
const REFERENCES_PER_PART = 3;
const PARTS_IN_PROMPT = 12;

/** The settings that shape each kind of part; "filament:" ones are read from the print's main filament */
export const PART_SETTINGS: Record<PartKind, string[]> = {
  base: ['brim_type', 'brim_width', 'raft_layers', 'elefant_foot_compensation', 'initial_layer_speed', 'initial_layer_print_height', 'filament:hot_plate_temp_initial_layer', 'filament:textured_plate_temp_initial_layer'],
  thin_wall: ['wall_loops', 'outer_wall_speed', 'inner_wall_speed', 'wall_generator', 'outer_wall_line_width', 'filament:nozzle_temperature', 'filament:fan_min_speed', 'filament:fan_max_speed', 'filament:slow_down_layer_time'],
  thin_plate: ['top_shell_layers', 'bottom_shell_layers', 'sparse_infill_density', 'filament:nozzle_temperature', 'filament:fan_max_speed'],
  overhang: ['enable_support', 'support_type', 'support_threshold_angle', 'support_on_build_plate_only', 'support_top_z_distance', 'detect_overhang_wall', 'enable_overhang_speed', 'overhang_4_4_speed', 'filament:overhang_fan_speed'],
  ceiling: ['bridge_speed', 'bridge_flow', 'thick_bridges', 'enable_support', 'support_threshold_angle', 'filament:overhang_fan_speed'],
  hole: ['xy_hole_compensation', 'enable_support', 'support_on_build_plate_only'],
  pillar: ['outer_wall_speed', 'wall_loops', 'brim_type', 'filament:slow_down_layer_time', 'filament:fan_max_speed'],
  top: ['top_shell_layers', 'top_shell_thickness', 'top_surface_speed', 'top_surface_pattern', 'ironing_type'],
};

/** The problems a user reports that belong to each kind of part */
const ISSUE_PARTS: Partial<Record<keyof typeof PRINT_ISSUE_LABELS, PartKind[]>> = {
  warping: ['base', 'pillar', 'thin_plate'],
  adhesion: ['base'],
  support_removal: ['overhang', 'ceiling', 'hole'],
  support_surface: ['overhang', 'ceiling'],
  overhang: ['overhang', 'ceiling'],
  weak: ['thin_wall', 'pillar', 'thin_plate'],
  under_extrusion: ['thin_wall', 'thin_plate'],
  surface: ['top', 'thin_wall'],
  dimension: ['hole'],
};

/** "200,200,200" → "200": per-variant vectors read as one value when they agree */
function settingValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(',');
  return parts.length > 1 && parts.every((p) => p === parts[0]) ? parts[0] : value;
}

/** The settings a print used for one kind of part, "key=value; ..." */
export function partSettings(setup: NonNullable<PrintRecord['setup']>, kind: PartKind): string {
  const filament = setup.filaments.find((f) => f.used !== false && f.settings) ?? setup.filaments.find((f) => f.settings);
  return PART_SETTINGS[kind]
    .map((key) => {
      const own = key.startsWith('filament:');
      const name = own ? key.slice('filament:'.length) : key;
      const value = settingValue(own ? filament?.settings?.[name] : setup.settings[name]);
      return value === undefined ? null : `${name}=${value}`;
    })
    .filter(Boolean)
    .join('; ');
}

/** An earlier print with its parts measured */
export interface PrintWithParts {
  print: PrintRecord;
  analyses: ModelAnalysis[];
}

export interface PartReference {
  print: PrintRecord;
  analysis: ModelAnalysis;
  feature: PartFeature;
  similarity: number;
}

const componentOf = (analysis: ModelAnalysis, id: string) => analysis.components?.find((c) => c.features.includes(id))?.name;

/** For each part of this plate, the most alike parts of earlier prints (one per print), most alike first */
export function matchParts(current: ModelAnalysis[], past: PrintWithParts[]): { analysis: ModelAnalysis; feature: PartFeature; references: PartReference[] }[] {
  return current.flatMap((analysis) =>
    analysis.features.map((feature) => {
      const references = past
        .map(({ print, analyses }) => {
          let best: PartReference | null = null;
          for (const other of analyses) {
            for (const candidate of other.features) {
              const similarity = partSimilarity(feature, candidate);
              if (similarity !== null && similarity >= MIN_SIMILARITY && (!best || similarity > best.similarity)) {
                best = { print, analysis: other, feature: candidate, similarity };
              }
            }
          }
          return best;
        })
        .filter((r): r is PartReference => r !== null)
        .sort((a, b) => b.similarity - a.similarity || (b.print.started_at ?? '').localeCompare(a.print.started_at ?? ''))
        .slice(0, REFERENCES_PER_PART);
      return { analysis, feature, references };
    })
  );
}

/** How the print went, as far as this kind of part is concerned */
function outcomeFor(print: PrintRecord, kind: PartKind): string {
  const feedback = print.feedback;
  const outcome = feedback ? PRINT_OUTCOME_LABELS[feedback.outcome] : 'người dùng chưa báo';
  const issues = (feedback?.issues ?? []).filter((i) => ISSUE_PARTS[i]?.includes(kind)).map((i) => PRINT_ISSUE_LABELS[i]);
  const reviewIssues = (print.video_review?.issues ?? []).filter((i) => ISSUE_PARTS[i]?.includes(kind)).map((i) => PRINT_ISSUE_LABELS[i]);
  return [
    outcome,
    issues.length ? `lỗi ở loại phần này: ${issues.join(', ')}` : '',
    reviewIssues.length ? `timelapse thấy: ${[...new Set(reviewIssues)].join(', ')}` : '',
    feedback?.note ? `ghi chú: ${JSON.stringify(feedback.note.slice(0, 160))}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

/**
 * The prompt's section on this plate's parts and how alike parts printed before: the parts with their names and
 * numbers, and under each, earlier prints of a part like it with how they came out and the settings that shape it.
 * Empty when nothing was measured.
 */
export function describeParts(current: ModelAnalysis[], past: PrintWithParts[]): string[] {
  const measured = current.filter((a) => a.matched && a.features.length);
  if (measured.length === 0) return [];
  const matches = matchParts(measured, past)
    // Parts with something to learn from first, then the rest, at most PARTS_IN_PROMPT
    .sort((a, b) => Number(b.references.length > 0) - Number(a.references.length > 0))
    .slice(0, PARTS_IN_PROMPT);
  const lines = ['', 'Thành phần của plate này (đo trên lưới) và các lần in thành phần giống nó trên máy này:'];
  for (const analysis of measured) {
    if (analysis.description) lines.push(`${analysis.object.name}: ${analysis.description} ${analysis.purpose ?? ''}`.trim());
  }
  for (const { analysis, feature, references } of matches) {
    const name = componentOf(analysis, feature.id);
    lines.push(`- ${feature.id}${measured.length > 1 ? ` (${analysis.object.name})` : ''}${name ? ` "${name}"` : ''}: ${describeFeature(feature)}`);
    if (references.length === 0) {
      lines.push('   Chưa in phần nào giống.');
      continue;
    }
    for (const ref of references) {
      const other = componentOf(ref.analysis, ref.feature.id);
      const date = (ref.print.started_at ?? ref.print.ended_at ?? '').slice(0, 10);
      lines.push(
        `   Giống ${Math.round(ref.similarity * 100)}%: ${other ? `"${other}" của ` : ''}bản in ${ref.print.job_name} (${date}): ${describeFeature(ref.feature)}. Kết quả: ${outcomeFor(ref.print, feature.kind)}. Setting khi in: ${partSettings(ref.print.setup!, feature.kind) || 'không rõ'}`
      );
    }
  }
  return lines;
}

/** The objects of a request or a print's setup, with the numbers their placement is matched against */
export const objectsOf = (request: Pick<StudioRequest, 'objects'>): ObjectNumbers[] => request.objects.slice(0, 6);
