'use client';

import { BuildOutlined, CloseOutlined, DeleteOutlined, PictureOutlined, PlusOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Collapse,
  ColorPicker,
  Empty,
  Flex,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Spin,
  Typography,
  Upload,
} from 'antd';
import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { useActions } from '../DashboardContext';
import { groupVersions, HINTS, isBusy, PLACEHOLDERS } from '../cad';
import { type CadAction, type CadJob } from './CadJob';
import { CadFamily } from './CadFamily';

const BUSY_REFRESH_MS = 3000;
const IDLE_REFRESH_MS = 30_000;
// Enough that a model's versions come with it: they show as one group
const LIST_LIMIT = 100;

type Kind = 'technical' | 'figure';

/** Figures are made in the mesh container; everything else (Claude's build123d, Antigravity's code) is technical */
const kindOf = (job: CadJob): Kind => (job.source === 'mesh' ? 'figure' : 'technical');
type Palette = 'prefer' | 'auto' | 'ams' | 'bambu' | 'custom';

interface Worker {
  online: boolean;
  claude: boolean;
  /** Mesh worker: a Hunyuan3D-2 shape model is in GPU memory */
  loaded?: boolean;
  error?: string;
}

interface CadConfig {
  enabled: boolean;
  models: { id: string; label: string }[];
  default_model: string;
  worker?: Worker | null;
  mesh?: Worker | null;
  bambu_materials?: { material: string; colours: number }[];
  bambu_families?: { family: string; colours: number; materials: number }[];
}

interface Filament {
  id: string;
  name: string;
  brand?: string;
  material?: string;
  hex: string;
}

const MATERIAL_SUGGESTIONS = ['PLA', 'PLA Matte', 'PLA Silk', 'PETG', 'ABS', 'ASA', 'TPU'].map((value) => ({ value }));

async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const form = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body === undefined || form ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined || form ? (body as FormData | undefined) : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error(data?.message || `Lỗi HTTP ${res.status}`);
  return data;
}

/** A pasted picture as a data: URL, as the gateway takes it in JSON */
const dataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Không đọc được ảnh đã dán.'));
    reader.readAsDataURL(file);
  });
/**
 * The first picture on the clipboard (a screenshot, an image copied from a page), or null for a text paste. A
 * screenshot comes as "image.png": it gets a name the log can tell apart.
 */
export function pastedImage(data: Pick<DataTransfer, 'items'>, now = new Date()): File | null {
  const file = [...data.items].find((item) => item.kind === 'file' && /^image\/(png|jpeg|webp)$/.test(item.type))?.getAsFile();
  if (!file) return null;
  if (file.name && file.name !== 'image.png') return file;
  const stamp = now.toTimeString().slice(0, 8).replace(/:/g, '');
  return new File([file], `anh-dan-${stamp}.${file.type.split('/')[1].replace('jpeg', 'jpg')}`, { type: file.type });
}

/** A figure's sides besides its front, as the gateway names its uploads (image_<side>) */
const SIDES = ['left', 'back', 'right'] as const;
type Side = (typeof SIDES)[number];
const SIDE_LABELS: Record<Side, string> = { left: 'Trái', back: 'Sau', right: 'Phải' };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const swatch = (hex: string) => <i className="cad-swatch-dot" style={{ background: hex }} />;

/** "Filament của tôi": other brands and colours Bambu doesn't make, saved for painting figures */
function MyFilaments({ filaments, onChange }: { filaments: Filament[]; onChange: (next: Filament[]) => void }) {
  const { showToast } = useActions();
  const [hex, setHex] = useState('#C8783C');
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [material, setMaterial] = useState('PLA');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const { filament } = await api<{ filament: Filament }>('POST', '/api/filaments/custom', { name, brand, material, hex });
      onChange([...filaments, filament]);
      setName('');
      showToast(`Đã lưu filament ${filament.name}.`, 'success');
    } catch (err) {
      showToast(errorText(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api('DELETE', `/api/filaments/custom/${encodeURIComponent(id)}`);
      onChange(filaments.filter((f) => f.id !== id));
    } catch (err) {
      showToast(errorText(err), 'error');
    }
  };

  return (
    <Flex vertical gap={10}>
      {filaments.length ? (
        filaments.map((f) => (
          <Flex key={f.id} justify="space-between" align="center">
            <span className="cad-swatch">
              {swatch(f.hex)}
              {[f.brand, f.material, f.name].filter(Boolean).join(' ')} · {f.hex}
            </span>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} title="Xóa" onClick={() => remove(f.id)} />
          </Flex>
        ))
      ) : (
        <Typography.Text type="secondary">Chưa có. Thêm filament hãng khác hoặc màu Bambu không có, để lần sau tô màu mô hình bằng chúng.</Typography.Text>
      )}
      <Flex wrap gap={8}>
        <ColorPicker value={hex} disabledAlpha showText onChange={(c) => setHex(c.toHexString().toUpperCase())} />
        <Input placeholder="Tên màu, ví dụ Cam đất" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} style={{ width: 200 }} />
        <Input placeholder="Hãng (không bắt buộc)" maxLength={40} value={brand} onChange={(e) => setBrand(e.target.value)} style={{ width: 170 }} />
        <AutoComplete options={MATERIAL_SUGGESTIONS} value={material} onChange={setMaterial} placeholder="Loại nhựa" style={{ width: 130 }} />
        <Button type="primary" icon={<PlusOutlined />} loading={saving} onClick={save}>
          Lưu filament
        </Button>
      </Flex>
    </Flex>
  );
}

/**
 * "Thiết kế mô hình bằng AI": technical parts (Claude writes build123d in the CAD container) and figures (Claude
 * models them in Blender in the mesh container) in one list, polled every 3s while one is being made.
 * `onBusyChange` tells the tab whether something is being designed.
 */
export function CadCard({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const { showToast, addLog } = useActions();
  const [config, setConfig] = useState<CadConfig | null>(null);
  const [jobs, setJobs] = useState<CadJob[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [kind, setKind] = useState<Kind>('technical');
  const [model, setModel] = useState<string>();
  const [prompt, setPrompt] = useState('');
  const [image, setImage] = useState<File | null>(null);
  // "Dựng nhiều góc": the figure's other sides, uploaded or else drawn by MV-Adapter
  const [multiview, setMultiview] = useState(false);
  const [sides, setSides] = useState<Partial<Record<Side, File>>>({});
  const [height, setHeight] = useState<number | null>(80);
  const [base, setBase] = useState(true);
  const [colour, setColour] = useState(false);
  const [palette, setPalette] = useState<Palette>('prefer');
  // '' = "theo nhựa trong AMS", only offered when preferring what is loaded
  const [material, setMaterial] = useState('');
  const [materialTouched, setMaterialTouched] = useState(false);
  const [colours, setColours] = useState<number | null>(4);
  const [filaments, setFilaments] = useState<Filament[]>([]);
  // Filaments left unticked for painting; new ones start ticked
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [filamentsOpen, setFilamentsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const jobsRef = useRef<CadJob[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    let list = jobsRef.current;
    try {
      const before = new Map(list.map((job) => [job.id, job.state]));
      list = (await api<{ jobs: CadJob[] }>('GET', `/api/cad/jobs?limit=${LIST_LIMIT}`)).jobs;
      for (const job of list) {
        if (before.get(job.id) === 'running' && job.state === 'done') {
          showToast(`Đã thiết kế xong: ${job.title || job.prompt}`, 'success');
          addLog(`AI đã thiết kế xong mô hình "${job.title || job.prompt}".`, 'success');
        } else if (before.get(job.id) === 'running' && job.state === 'failed') {
          showToast(`Thiết kế lỗi: ${job.error}`, 'error');
        }
      }
      jobsRef.current = list;
      setJobs(list);
      setListError(null);
    } catch (err) {
      setListError(errorText(err));
    }
    setNow(Date.now());
    timer.current = setTimeout(refresh, list.some(isBusy) ? BUSY_REFRESH_MS : IDLE_REFRESH_MS);
  }, [showToast, addLog]);

  useEffect(() => {
    let cancelled = false;
    api<CadConfig>('GET', '/api/cad')
      .then((data) => {
        if (cancelled || !data.enabled) return;
        setConfig(data);
        setModel(data.default_model);
        // Both kinds set up: the user picks; otherwise the one there is
        setKind(data.worker ? 'technical' : 'figure');
        refresh();
        api<{ filaments: Filament[] }>('GET', '/api/filaments/custom')
          .then(({ filaments: list }) => !cancelled && setFilaments(list))
          .catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh]);

  const busy = jobs?.some(isBusy) ?? false;
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  const added = (job: CadJob) => {
    jobsRef.current = [job, ...jobsRef.current.filter((j) => j.id !== job.id)];
    setJobs(jobsRef.current);
    refresh();
  };

  // ---------- Creating ----------

  const figure = kind === 'figure';
  const worker = figure ? config?.mesh : config?.worker;
  const workerStatus = !worker?.online
    ? `🔴 Container ${figure ? 'mesh3d' : 'CAD'} chưa chạy`
    : !worker.claude
      ? '🟡 Thiếu CLAUDE_CODE_OAUTH_TOKEN'
      : figure && !worker.loaded
        ? '🟢 Sẵn sàng (Hunyuan3D chưa nạp vào GPU)'
        : '🟢 Sẵn sàng';
  const canCreate = !!worker?.online && worker.claude;
  const bambuPalette = !!config?.bambu_materials?.length;
  const customPick = colour && (palette === 'custom' || palette === 'prefer');

  const choosePalette = (next: Palette) => {
    setPalette(next);
    if (next === 'bambu' && !material) setMaterial('PLA Basic');
    if (next === 'prefer' && !materialTouched) setMaterial('');
    if ((next === 'custom' || next === 'prefer') && filaments.length < 2) setFilamentsOpen(true);
  };

  // A thumbnail of the front picture, chosen or pasted
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!image) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  /** A picture pasted into a figure's description becomes its front picture (the other sides chosen go with the old one) */
  const pasteImage = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = pastedImage(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    setImage(file);
    setSides({});
    addLog(`Đã dán ảnh ${file.name} làm ảnh mặt trước.`);
  };

  /** A figure from the form: the picture if one is chosen, the description, the height, the plinth and the colours */
  const createFigure = async (text: string) => {
    const body = new FormData();
    body.append('prompt', text);
    if (model) body.append('model', model);
    body.append('height_mm', String(height || 80));
    body.append('base', base ? 'true' : 'false');
    if (colour) {
      body.append('colour', 'true');
      body.append('palette', palette);
      body.append('colours', String(colours || 4));
      if (palette === 'bambu' || palette === 'prefer') body.append('material', material);
      if (palette === 'custom' || palette === 'prefer') {
        body.append('filaments', filaments.filter((f) => !unticked.has(f.id)).map((f) => f.id).join(','));
      }
    }
    if (image) body.append('image', image);
    const uploaded = multiview && image ? SIDES.filter((side) => sides[side]) : [];
    if (multiview && image) {
      body.append('multiview', 'true');
      for (const side of uploaded) body.append(`image_${side}`, sides[side]!);
    }
    const { job } = await api<{ job: CadJob }>('POST', '/api/cad/meshes', body);
    added(job);
    const how = !(multiview && image) ? '' : uploaded.length ? `, kèm ${uploaded.length} ảnh góc khác` : ', AI vẽ thêm các góc';
    addLog(
      image
        ? `Đã gửi dựng mô hình từ ảnh ${image.name}${how} (Hunyuan3D-2, rồi Claude hoàn thiện): ${text || job.prompt}`
        : `Đã gửi Claude dựng mô hình nhân vật: ${text || job.prompt}`
    );
  };

  const create = async (text: string, parentId?: string, images: string[] = []) => {
    const { job } = await api<{ job: CadJob }>('POST', '/api/cad/jobs', { prompt: text, model, images, ...(parentId && { parent_id: parentId }) });
    added(job);
    addLog(`Đã gửi Claude ${parentId ? 'sửa' : 'thiết kế'} mô hình: ${text}${images.length ? ` (kèm ${images.length} ảnh)` : ''}`);
  };

  const submit = async () => {
    const text = prompt.trim();
    if (figure ? text.length < 3 && !image : text.length < 3) {
      showToast(figure ? 'Chọn ảnh hoặc mô tả mô hình trước đã.' : 'Mô tả mô hình cần in trước đã.', 'error');
      return;
    }
    setCreating(true);
    try {
      if (figure) {
        await createFigure(text);
        setImage(null);
        setSides({});
      } else {
        await create(text);
      }
      setPrompt('');
    } catch (err) {
      showToast(errorText(err), 'error');
    } finally {
      setCreating(false);
    }
  };

  // ---------- A model's buttons ----------

  const action = async (job: CadJob, act: CadAction) => {
    try {
      if (act === 'delete') {
        await api('DELETE', `/api/cad/jobs/${encodeURIComponent(job.id)}`);
        showToast('Đã xóa bản này.', 'info');
      } else if (act === 'cancel') {
        await api('POST', `/api/cad/jobs/${encodeURIComponent(job.id)}/cancel`, {});
        showToast('Đã hủy.', 'info');
      } else if (act === 'again') {
        // Same picture (with another seed) or description, same size, plinth and colours: made afresh
        const params = Object.fromEntries((job.result?.parameters ?? []).map((p) => [p.name, p.value])) as Record<string, any>;
        const asked = job.report?.colour_request;
        const { job: next } = await api<{ job: CadJob }>('POST', '/api/cad/meshes', {
          parent_id: job.id,
          model,
          ...(params.height_mm && { height_mm: params.height_mm }),
          base: Boolean(params.base),
          ...(params.colours > 0 && { colour: true, colours: params.colours, ...(asked ?? {}) }),
          ...(params.multiview > 0 && { multiview: true }),
        });
        added(next);
        showToast('Đang dựng lại mô hình.', 'info');
      } else {
        const sent = await api('POST', `/api/cad/jobs/${encodeURIComponent(job.id)}/studio`, { format: act === 'studio-3mf' ? '3mf' : 'stl' });
        const paths: string[] = sent.studioPaths ?? [sent.studioPath];
        showToast(
          paths.length > 1
            ? `Đã gửi ${paths.length} file, mỗi file một bàn in: ${paths.join(', ')}. Trong Studio mở từng file (File → Open project).`
            : `Đã gửi ${sent.studioPath}. Trong Studio: File → Import.`,
          'success'
        );
        addLog(`Đã gửi mô hình AI vào Bambu Studio: ${paths.join(', ')}`, 'success');
      }
      await refresh();
    } catch (err) {
      showToast(errorText(err), 'error');
    }
  };

  /** Revise a technical model, or have Claude review and fix a figure (words optional), with the pictures pasted in */
  const revise = async (job: CadJob, comment: string, pictures: File[]) => {
    const fix = job.source === 'mesh';
    if (fix ? comment.length > 0 && comment.length < 3 : comment.length < 3) {
      showToast(pictures.length && !fix ? 'Ghi thêm vài chữ cần sửa gì cùng với ảnh.' : 'Ghi cần sửa gì trước đã.', 'error');
      return false;
    }
    try {
      const images = await Promise.all(pictures.map(dataUrl));
      const withImages = pictures.length ? ` (kèm ${pictures.length} ảnh)` : '';
      if (fix) {
        const { job: next } = await api<{ job: CadJob }>('POST', `/api/cad/jobs/${encodeURIComponent(job.id)}/fix`, { prompt: comment, model, images });
        added(next);
        addLog(`Đã gửi Claude review và sửa mô hình nhân vật${comment ? `: ${comment}` : ''}${withImages}`);
      } else {
        await create(comment, job.id, images);
      }
      return true;
    } catch (err) {
      showToast(errorText(err), 'error');
      return false;
    }
  };

  /** Deletes a model with every version made from it */
  const deleteGroup = async (root: CadJob, count: number) => {
    try {
      await api('DELETE', `/api/cad/jobs/${encodeURIComponent(root.id)}?family=1`);
      showToast(`Đã xóa ${count} phiên bản.`, 'info');
      addLog(`Đã xóa mô hình AI "${root.title || root.prompt}" cùng các phiên bản của nó.`);
      await refresh();
    } catch (err) {
      showToast(errorText(err), 'error');
    }
  };

  // Bambu's own colours: whole families first (more colours to choose from), then each material
  const materialOptions = [
    ...(palette === 'prefer' ? [{ value: '', label: 'Màu cần mua: theo nhựa trong AMS' }] : []),
    ...(config?.bambu_families?.length
      ? [
          {
            label: 'Cả dòng nhựa',
            options: config.bambu_families.map((f) => ({ value: `family:${f.family}`, label: `Mọi dòng ${f.family} (${f.colours} màu, ${f.materials} loại)` })),
          },
        ]
      : []),
    { label: 'Một loại nhựa', options: (config?.bambu_materials ?? []).map((m) => ({ value: m.material, label: `${m.material} (${m.colours} màu)` })) },
  ];

  if (!config) return null;

  // With both kinds set up, each tab lists its own models (a model and its versions are always of one kind)
  const split = !!(config.worker && config.mesh);
  const families: { root: string; versions: CadJob[] }[] = jobs ? groupVersions(jobs) : [];
  const ofKind = (k: Kind) => families.filter(({ versions }) => kindOf(versions[0]) === k);
  const shown = split ? ofKind(kind) : families;
  const tabLabel = (k: Kind, label: string) => {
    const mine = ofKind(k);
    const making = mine.some(({ versions }) => versions.some(isBusy));
    return `${label}${mine.length ? ` (${mine.length})` : ''}${making ? ' ⏳' : ''}`;
  };

  return (
    <Card
      title={
        <>
          <BuildOutlined /> Thiết kế mô hình bằng AI
        </>
      }
      extra={
        <Space>
          <Typography.Text type="secondary" title={worker?.error ?? ''}>
            {workerStatus}
          </Typography.Text>
          <Button icon={<ReloadOutlined />} onClick={refresh}>
            Làm mới
          </Button>
        </Space>
      }
    >
      <Flex vertical gap={12}>
        {config.worker && config.mesh && (
          <Radio.Group
            optionType="button"
            buttonStyle="solid"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            options={[
              { value: 'technical', label: tabLabel('technical', '🔧 Kỹ thuật') },
              { value: 'figure', label: tabLabel('figure', '🧸 Nhân vật / trang trí') },
            ]}
          />
        )}
        <Input.TextArea
          rows={3}
          maxLength={4000}
          placeholder={PLACEHOLDERS[kind]}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={figure ? pasteImage : undefined}
        />
        {/* The picture the figure is made from, on its own line */}
        {figure && (
          <Flex wrap gap={12} align="center">
            <Upload
              accept="image/png,image/jpeg,image/webp"
              showUploadList={false}
              beforeUpload={(file) => {
                setImage(file);
                return false;
              }}
            >
              <Button icon={<PictureOutlined />}>Chọn ảnh</Button>
            </Upload>
            {preview && <img src={preview} alt="Ảnh mẫu" style={{ height: 40, maxWidth: 80, objectFit: 'contain', borderRadius: 4 }} />}
            <Typography.Text type="secondary">
              {image ? image.name : 'Chưa chọn ảnh (hoặc dán ảnh vào ô mô tả): Claude dựng theo mô tả'}
            </Typography.Text>
            {image && (
              <Button
                size="small"
                type="text"
                icon={<CloseOutlined />}
                title="Bỏ ảnh"
                onClick={() => {
                  setImage(null);
                  setSides({});
                }}
              />
            )}
            <Checkbox
              checked={multiview}
              disabled={!image}
              onChange={(e) => setMultiview(e.target.checked)}
              title="Hunyuan3D-2mv dựng từ 4 góc thay vì đoán mặt sau từ 1 ảnh: dùng ảnh các góc bạn tải lên, không có thì AI vẽ thêm (chậm hơn 1–4 phút, cần gần hết VRAM). Cần ảnh mặt trước."
            >
              Dựng nhiều góc
            </Checkbox>
          </Flex>
        )}
        {/* The other sides for "Dựng nhiều góc": with the front picture only */}
        {figure && multiview && image && (
          <Flex wrap gap={10} align="center">
            <Typography.Text type="secondary">Ảnh các góc khác (không bắt buộc):</Typography.Text>
            {SIDES.map((side) => (
              <Space.Compact key={side}>
                <Upload
                  accept="image/png,image/jpeg,image/webp"
                  showUploadList={false}
                  beforeUpload={(file) => {
                    setSides((prev) => ({ ...prev, [side]: file }));
                    return false;
                  }}
                >
                  <Button size="small" icon={<PictureOutlined />} title={sides[side]?.name ?? `Ảnh nhìn từ ${SIDE_LABELS[side].toLowerCase()}`}>
                    {SIDE_LABELS[side]}
                    {sides[side] ? ' ✓' : ''}
                  </Button>
                </Upload>
                {sides[side] && (
                  <Button
                    size="small"
                    icon={<CloseOutlined />}
                    title={`Bỏ ảnh ${SIDE_LABELS[side].toLowerCase()}`}
                    onClick={() => setSides(({ [side]: _dropped, ...rest }) => rest)}
                  />
                )}
              </Space.Compact>
            ))}
            <Typography.Text type="secondary">
              {SIDES.some((side) => sides[side]) ? 'Dựng từ ảnh trước và các góc đã chọn' : 'Không chọn góc nào: AI vẽ thêm trái, sau, phải từ ảnh trước'}
            </Typography.Text>
          </Flex>
        )}
        {/* Size, plinth and colours */}
        {figure && (
          <Flex wrap gap={12} align="center">
            <Space>
              Cao
              <InputNumber min={10} max={300} step={1} value={height} onChange={setHeight} suffix="mm" style={{ width: 110 }} />
            </Space>
            <Checkbox checked={base} onChange={(e) => setBase(e.target.checked)}>
              Thêm đế
            </Checkbox>
            <Checkbox
              checked={colour}
              onChange={(e) => {
                setColour(e.target.checked);
                if (e.target.checked && (palette === 'custom' || palette === 'prefer') && filaments.length < 2) setFilamentsOpen(true);
              }}
            >
              Tô màu
            </Checkbox>
            {colour && (
              <>
                <Select<Palette>
                  value={palette}
                  onChange={choosePalette}
                  style={{ minWidth: 280 }}
                  aria-label="Chọn màu"
                  options={[
                    { value: 'prefer', label: 'Ưu tiên màu có sẵn (AMS → của tôi → Bambu)' },
                    { value: 'auto', label: 'Tự chọn màu theo ảnh' },
                    { value: 'ams', label: 'Màu đang nạp trong AMS' },
                    ...(bambuPalette ? [{ value: 'bambu' as const, label: 'Màu Bambu chính hãng' }] : []),
                    { value: 'custom', label: 'Filament của tôi' },
                  ]}
                />
                {bambuPalette && (palette === 'bambu' || palette === 'prefer') && (
                  <Select
                    value={material}
                    onChange={(v) => {
                      setMaterial(v);
                      setMaterialTouched(true);
                    }}
                    style={{ minWidth: 240 }}
                    aria-label="Loại nhựa Bambu"
                    options={materialOptions}
                  />
                )}
                {/* The AMS decides how many colours */}
                {palette !== 'ams' && (
                  <Space>
                    Số màu
                    <InputNumber min={2} max={8} step={1} value={colours} onChange={setColours} style={{ width: 70 }} />
                  </Space>
                )}
              </>
            )}
          </Flex>
        )}
        {/* "Filament của tôi" to paint with: ticked ones only */}
        {figure && customPick && (
          <Flex wrap gap={10} align="center">
            {filaments.length ? (
              <>
                <Typography.Text type="secondary">Tô bằng:</Typography.Text>
                {filaments.map((f) => (
                  <Checkbox
                    key={f.id}
                    checked={!unticked.has(f.id)}
                    onChange={(e) =>
                      setUnticked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.delete(f.id);
                        else next.add(f.id);
                        return next;
                      })
                    }
                  >
                    {swatch(f.hex)}
                    {f.name}
                  </Checkbox>
                ))}
              </>
            ) : (
              <Typography.Text type="secondary">Chưa có filament nào: thêm ở mục 🎨 Filament của tôi bên dưới.</Typography.Text>
            )}
          </Flex>
        )}
        <Flex gap={8} wrap>
          <Select value={model} onChange={setModel} style={{ minWidth: 200 }} aria-label="Model Claude" options={config.models.map((m) => ({ value: m.id, label: m.label }))} />
          <Button type="primary" icon={<ThunderboltOutlined />} loading={creating} disabled={!canCreate} onClick={submit}>
            Tạo mô hình
          </Button>
        </Flex>
        <Typography.Text type="secondary">{HINTS[kind]}</Typography.Text>
        <Collapse
          activeKey={filamentsOpen ? ['filaments'] : []}
          onChange={(keys) => setFilamentsOpen(keys.includes('filaments'))}
          items={[
            {
              key: 'filaments',
              label: `🎨 Filament của tôi (${filaments.length})`,
              children: <MyFilaments filaments={filaments} onChange={setFilaments} />,
            },
          ]}
        />
        {!jobs ? (
          listError ? (
            <Empty description={`❌ ${listError}`} />
          ) : (
            <Spin />
          )
        ) : shown.length === 0 ? (
          <Empty
            description={`Chưa có mô hình ${!split ? '' : figure ? 'nhân vật / trang trí ' : 'kỹ thuật '}nào. Mô tả mô hình ở trên rồi bấm ✨ Tạo mô hình.`}
          />
        ) : (
          <Flex vertical gap={14}>
            {shown.map(({ root, versions }) => (
              <CadFamily
                key={root}
                versions={versions}
                now={now}
                onAction={action}
                onRevise={revise}
                onDeleteAll={() => deleteGroup(versions[0], versions.length)}
              />
            ))}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
