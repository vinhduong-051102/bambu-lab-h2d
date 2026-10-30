'use client';

import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  CloseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SearchOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Alert, App, Button, Card, Collapse, Flex, Image, Input, Modal, Popconfirm, Progress, Space, Tag, Timeline, Tooltip, Typography } from 'antd';
import { useEffect, useMemo, useState, type ClipboardEvent, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { deltaLabel } from '../../domain/filaments/colourMixing';
import { fileUrl, formatDuration, formatProgress, formatSize, isBusy, jobSteps, modelName, ORIGINS, REVISE_PLACEHOLDERS, STATE_LABELS, STEP_LABELS, versionLabel } from '../cad';
import { checkedSettings, settingsSummary, sortedChecks, statusCounts } from '../eng';
import { formatPrintTime } from '../prints';
import { ModelSim } from '../sim/ModelSim';
import { AssemblyGuideButton } from './AssemblyGuide';
import { EngCheckButton } from './EngCheck';

/** As many pictures as the gateway takes with one revision */
const MAX_PASTED_IMAGES = 4;

export interface CadJob {
  id: string;
  prompt: string;
  title?: string | null;
  source: string;
  model?: string | null;
  input?: string;
  maker?: string | null;
  colour?: boolean;
  views?: 'uploaded' | 'drawn' | null;
  parent_id?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  state: string;
  step?: string | null;
  steps?: { id: string; started_at: string; finished_at: string | null; detail: string | null }[];
  progress?: { done: number; total?: number; unit?: string } | null;
  builds?: number;
  notes?: string[];
  error?: string | null;
  sent?: { name: string }[];
  result?: {
    summary: string;
    issues?: { problem: string; fixed: boolean; how?: string }[];
    assumptions?: string[];
    parameters?: { name: string; value: unknown; description: string }[];
    warnings?: string[];
  } | null;
  report?: {
    ok?: boolean;
    size_mm?: number[];
    volume_cm3?: number | null;
    mesh?: { watertight?: boolean };
    warnings?: string[];
    palette?: PaletteEntry[];
    colour_request?: Record<string, unknown>;
    /** An assembly laid out for printing by build.py (cad/print_layout.py): its plates, and what is bought instead */
    print_layout?: PrintLayout;
  } | null;
  files?: Record<string, boolean>;
  guide?: { ok: boolean; steps?: number; video?: string | null; error?: string | null } | null;
}

export interface PrintLayout {
  plates: { n: number; parts: string[] }[];
  parts: Record<string, { plate: number; footprint_mm: number[]; height_mm: number; overhang_mm2: number; contact_mm2: number }>;
  not_printed: Record<string, string>;
}

/** "In 2 bàn: bàn 1 · 12 chi tiết…; không in (mua sẵn): trục (steel)" */
function PrintPlates({ layout }: { layout: PrintLayout }) {
  const bought = Object.entries(layout.not_printed);
  const supports = Object.entries(layout.parts).filter(([, p]) => p.overhang_mm2 > 100);
  return (
    <Collapse
      size="small"
      items={[
        {
          key: 'plates',
          label: `🖨 Tự chia để in: ${layout.plates.length} bàn in · ${Object.keys(layout.parts).length} chi tiết${bought.length ? ` · ${bought.length} không in` : ''}`,
          children: (
            <Flex vertical gap={4}>
              {layout.plates.map((plate) => (
                <div key={plate.n}>
                  <Typography.Text strong>Bàn {plate.n}:</Typography.Text>{' '}
                  {plate.parts.map((name) => `${name} (cao ${layout.parts[name]?.height_mm ?? '?'} mm)`).join(', ')}
                </div>
              ))}
              {bought.length > 0 && (
                <Typography.Text type="secondary">
                  Không in, dùng đồ mua sẵn: {bought.map(([name, why]) => (why === 'not_printed' ? name : `${name} (${why})`)).join(', ')}
                </Typography.Text>
              )}
              {supports.length > 0 && (
                <Typography.Text type="secondary">
                  Có thể cần support: {supports.map(([name, p]) => `${name} (${Math.round(p.overhang_mm2)} mm² nhô ra)`).join(', ')}
                </Typography.Text>
              )}
              <Typography.Text type="secondary">
                Mỗi chi tiết được đặt nằm trên mặt in tốt nhất (ít phần nhô cần support nhất), xếp trong vùng cả hai đầu phun H2D in
                tới. {layout.plates.length > 1 ? 'Mỗi bàn in là một file 3MF riêng: mở từng file trong Studio.' : 'File 3MF mở trong Studio đã xếp sẵn trên bàn.'}
              </Typography.Text>
            </Flex>
          ),
        },
      ]}
    />
  );
}

export interface PaletteEntry {
  slot: number;
  hex: string;
  label?: string | null;
  share: number;
  source_hex?: string;
  delta_e?: number;
  origin?: string;
  mix?: { components: { key: string; hex: string; percent: number; name?: string | null }[]; hex: string; delta_e: number } | null;
}

export type CadAction = 'cancel' | 'again' | 'studio-stl' | 'studio-3mf' | 'delete';

const STATE_COLORS: Record<string, string> = { queued: 'default', running: 'processing', done: 'success', failed: 'error', cancelled: 'warning' };

const Swatch = ({ hex }: { hex: string }) => <i className="cad-swatch-dot" style={{ background: hex }} />;

/**
 * One filament of a coloured figure: slot, colour, share and name; how far it is from the model's own colour there
 * (Lab ΔE); and when far, the Bambu Studio mixing recipe that comes closest
 */
export function PaletteRow({ entry: p }: { entry: PaletteEntry }) {
  const off = typeof p.delta_e === 'number' && p.delta_e > 2.5;
  const level = off ? deltaLabel(p.delta_e as number) : null;
  const origin = p.origin ? (ORIGINS as Record<string, string>)[p.origin] : null;
  return (
    <div className="cad-swatch-row">
      <span className="cad-swatch">
        <Swatch hex={p.hex} />
        {`${p.slot}. ${p.hex} ${Math.round(p.share * 100)}%${p.label ? ` · ${p.label}` : ''}`}
      </span>
      {origin && <Tag color={p.origin === 'bambu' ? 'orange' : 'green'}>{origin}</Tag>}
      {off && (
        <Tooltip title={`Màu gốc của mô hình ${p.source_hex}, ΔE ${p.delta_e}`}>
          <Tag className={`cad-delta cad-delta-${level === 'lệch rõ' ? 'far' : level === 'hơi lệch' ? 'off' : 'near'}`} color={level === 'lệch rõ' ? 'red' : 'gold'}>
            <Swatch hex={p.source_hex ?? '#000'} />
            {`gốc ${p.source_hex} · ${level}`}
          </Tag>
        </Tooltip>
      )}
      {p.mix && (
        <div className="cad-mix">
          ↳ Trộn trong Studio:{' '}
          {p.mix.components.map((c, i) => (
            <span key={i}>
              {i > 0 && ' + '}
              <Swatch hex={c.hex} />
              {`${c.name ?? c.key} ${c.percent}%`}
            </span>
          ))}{' '}
          → <Swatch hex={p.mix.hex} />
          {`${p.mix.hex} (${deltaLabel(p.mix.delta_e)}, ΔE ${p.mix.delta_e})`}
        </div>
      )}
    </div>
  );
}

const STEP_ICONS: Record<string, ReactNode> = {
  done: <CheckCircleFilled style={{ color: '#10b981' }} />,
  retry: <ReloadOutlined style={{ color: '#f59e0b' }} />,
  current: <LoadingOutlined style={{ color: '#3b82f6' }} />,
  failed: <CloseCircleFilled style={{ color: '#ef4444' }} />,
  cancelled: <StopOutlined style={{ color: '#9ca3af' }} />,
  ahead: <ClockCircleOutlined style={{ color: '#6b7280' }} />,
};

/** The user's description as Markdown (lists, bold, tables, code): a few lines until "Xem thêm", links open in a new tab */
function PromptText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160 || text.split('\n').length > 2;
  return (
    <div>
      <div className={`cad-prompt${long && !open ? ' clamped' : ''}`}>
        <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>
          {text}
        </Markdown>
      </div>
      {long && (
        <Typography.Link style={{ fontSize: 12 }} onClick={() => setOpen(!open)}>
          {open ? 'Thu gọn' : 'Xem thêm'}
        </Typography.Link>
      )}
    </div>
  );
}

/** The job's steps as a timeline (see jobSteps in ../cad) */
export function JobSteps({ job, now = Date.now() }: { job: CadJob; now?: number }) {
  const items = jobSteps(job, now);
  if (items.length === 0) return null;
  return (
    <Timeline
      className="cad-steps"
      items={items.map((item: ReturnType<typeof jobSteps>[number], i: number) => ({
        key: i,
        className: `cad-step is-${item.kind}`,
        icon: STEP_ICONS[item.kind],
        content:
          item.kind === 'more' ? (
            <Typography.Text type="secondary">{item.label}</Typography.Text>
          ) : (
            <Flex justify="space-between" gap={8}>
              <div style={{ minWidth: 0 }}>
                <Typography.Text type={item.kind === 'ahead' ? 'secondary' : undefined} strong={item.kind === 'current'}>
                  {item.label}
                </Typography.Text>
                {item.detail && <div className="cad-step-detail">{item.detail}</div>}
                {item.progress && <div className="cad-step-detail">{formatProgress(item.progress)}</div>}
                {item.progress?.total ? (
                  <Progress percent={Math.min(100, Math.round((item.progress.done / item.progress.total) * 1000) / 10)} size="small" showInfo={false} />
                ) : null}
              </div>
              <Typography.Text type="secondary" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                {item.took}
              </Typography.Text>
            </Flex>
          ),
      }))}
    />
  );
}

/** Claude's review of a figure: each problem, fixed or not, and how */
function Issues({ issues }: { issues: NonNullable<CadJob['result']>['issues'] }) {
  if (!issues?.length) return null;
  return (
    <>
      <Typography.Text strong>
        Claude đã xem ({issues.filter((i) => i.fixed).length}/{issues.length} lỗi đã sửa)
      </Typography.Text>
      <ul className="cad-issues">
        {issues.map((i, n) => (
          <li key={n} className={`cad-issue ${i.fixed ? 'is-fixed' : 'is-open'}`}>
            {i.fixed ? '✓' : '✗'} <b>{i.problem}</b>
            {i.how ? `: ${i.how}` : ''}
          </li>
        ))}
      </ul>
    </>
  );
}

const Bullets = ({ items }: { items: string[] }) => (
  <ul style={{ margin: '4px 0 8px', paddingLeft: 20 }}>
    {items.map((item, i) => (
      <li key={i}>{item}</li>
    ))}
  </ul>
);

/**
 * One model: preview, state and progress, Claude's notes and details, its palette, downloads and actions. `onAction`
 * runs a button; `onRevise` sends the revise/review comment and the pictures pasted into it (a figure may go without
 * either: Claude then looks for problems itself). `before` is the version this one was made from: its preview is
 * shown next to this one's, before and after.
 */
/** "⚙️ Mô phỏng": the job's own model, its components set up and run in the live Chrono viewer (docs/model-simulation.md) */
function SimulateButton({ job }: { job: CadJob }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)} title="Mô phỏng vật lý chính mô hình này: chi tiết, khớp, động cơ, chạy trong khung 3D">
        ⚙️ Mô phỏng
      </Button>
      <Modal open={open} onCancel={() => setOpen(false)} footer={null} width="min(1500px, 96vw)" destroyOnHidden title={`Mô phỏng · ${job.title || job.id}`}>
        {open && <ModelSim jobId={job.id} />}
      </Modal>
    </>
  );
}

export function CadJobCard(props: {
  job: CadJob;
  now?: number;
  before?: CadJob | null;
  onAction?: (action: CadAction) => Promise<void>;
  onRevise?: (comment: string, images: File[]) => Promise<boolean>;
}) {
  const { job, now = Date.now(), before, onAction, onRevise } = props;
  const { modal } = App.useApp();
  const [acting, setActing] = useState<CadAction | null>(null);
  const [revising, setRevising] = useState(false);
  const [comment, setComment] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  // Thumbnails of the pasted pictures, freed when they change
  const thumbs = useMemo(() => images.map((file) => URL.createObjectURL(file)), [images]);
  useEffect(() => () => thumbs.forEach((url) => URL.revokeObjectURL(url)), [thumbs]);

  const busy = isBusy(job);
  const done = job.state === 'done';
  // An assembly laid out on plates: its 3MF has them, where its STL is every plate side by side
  const plates = job.report?.print_layout?.plates.length ?? 0;
  const figure = job.source === 'mesh';
  // Claude reviewing and fixing a figure
  const fix = figure && job.input === 'fix';
  const size = formatSize(job.report?.size_mm);
  const source = fix
    ? `Claude sửa · ${modelName(job.model)}`
    : figure
      ? job.maker === 'claude'
        ? `Claude dựng · ${modelName(job.model)}`
        : job.maker === 'hunyuan'
          ? `Hunyuan3D${job.views ? ' nhiều góc' : ''} + Claude · ${modelName(job.model)}`
          : job.views
            ? 'Hunyuan3D · nhiều góc'
            : 'Hunyuan3D'
      : job.source === 'code'
        ? 'Antigravity / code'
        : modelName(job.model);
  const time = (iso?: string | null) => (iso ? Date.parse(iso) : NaN);
  const started = time(job.steps?.[0]?.started_at ?? job.started_at ?? job.created_at);
  const ended = job.finished_at ? time(job.finished_at) : busy ? now : NaN;
  const total = Number.isFinite(ended - started) ? formatDuration(ended - started) : '';
  const warnings = [...(job.report?.warnings ?? []), ...(job.result?.warnings ?? [])];
  const url = (name: string, download = false) => fileUrl(job, name, download);

  const act = async (action: CadAction) => {
    if (!onAction) return;
    setActing(action);
    try {
      await onAction(action);
    } finally {
      setActing(null);
    }
  };

  /**
   * Studio gets the model's shape only and prints it with whatever profile is chosen there: when this model was
   * checked, the user is shown the print settings the check assumed (and what still failed) before it goes
   */
  const sendToStudio = async (action: CadAction) => {
    let last: { report: { finished_at?: string } | null; results: Record<string, { checks?: unknown[]; inputs?: unknown }> } | null = null;
    try {
      const res = await fetch(`/api/eng/checks/${encodeURIComponent(job.id)}`, { cache: 'no-store' });
      const body = await res.json();
      if (body?.success && body.report) last = body;
    } catch {
      // No check to remind of: sent as before
    }
    if (!last) return act(action);
    const settings = settingsSummary(checkedSettings(last.results));
    const counts = statusCounts(sortedChecks(last.results));
    modal.confirm({
      title: 'Chọn đúng thông số in trong Bambu Studio',
      width: 560,
      okText: 'Gửi sang Studio',
      cancelText: 'Thôi',
      content: (
        <Flex vertical gap={8}>
          <Typography.Text>
            File gửi sang chỉ có hình dạng mô hình. Studio in theo hồ sơ đang chọn trong Studio, còn kết quả kiểm tra kỹ thuật
            {last.report?.finished_at ? ` (lúc ${new Date(last.report.finished_at).toLocaleString('vi-VN')})` : ''} đúng khi in với:
          </Typography.Text>
          {settings.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {settings.map((s) => (
                <li key={s.key}>
                  {s.label}: <b>{s.value}</b>
                </li>
              ))}
            </ul>
          ) : (
            <Typography.Text type="secondary">Lần kiểm tra đó chưa có thông số in nào.</Typography.Text>
          )}
          {counts.FAIL > 0 && <Alert type="error" showIcon title={`Còn ${counts.FAIL} mục không đạt trong lần kiểm tra đó.`} />}
          {counts.FAIL === 0 && counts.WARNING > 0 && <Alert type="warning" showIcon title={`Còn ${counts.WARNING} mục cần xem.`} />}
        </Flex>
      ),
      onOk: () => act(action),
    });
  };

  const revise = async () => {
    if (!onRevise) return;
    setSending(true);
    try {
      if (await onRevise(comment.trim(), images)) {
        setRevising(false);
        setComment('');
        setImages([]);
      }
    } finally {
      setSending(false);
    }
  };

  /** Pictures pasted into the comment (a screenshot, a copied image) join the ones to send; text pastes as usual */
  const paste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = [...e.clipboardData.items]
      .filter((item) => item.kind === 'file' && /^image\/(png|jpeg|webp)$/.test(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!pasted.length) return;
    e.preventDefault();
    setImages((current) => [...current, ...pasted].slice(0, MAX_PASTED_IMAGES));
  };

  const link = (name: string, label: ReactNode, opts: { download?: boolean; title?: string; icon?: ReactNode } = {}) => (
    <Button
      size="small"
      icon={opts.icon}
      href={url(name, opts.download)}
      target={opts.download ? undefined : '_blank'}
      rel="noopener noreferrer"
      title={opts.title}
    >
      {label}
    </Button>
  );

  // Without a title, the description's first line stands in, its Markdown marks dropped
  const heading = job.title || job.prompt.trim().split('\n')[0].replace(/^[#>\-*+\s]+|[*_`]/g, '').trim();

  const details = job.result && (
    <Collapse
      size="small"
      defaultActiveKey={fix ? ['details'] : []}
      items={[
        {
          key: 'details',
          label: figure && !fix ? 'Chi tiết' : 'Chi tiết từ Claude',
          children: (
            <>
              <Typography.Paragraph>{job.result.summary}</Typography.Paragraph>
              <Issues issues={job.result.issues} />
              {!!job.result.assumptions?.length && (
                <>
                  <Typography.Text strong>Giả định</Typography.Text>
                  <Bullets items={job.result.assumptions} />
                </>
              )}
              {!!job.result.parameters?.length && (
                <>
                  <Typography.Text strong>{figure ? 'Thông số' : 'Tham số trong code'}</Typography.Text>
                  <Bullets items={job.result.parameters.map((p) => `${p.name} = ${p.value}: ${p.description}`)} />
                </>
              )}
            </>
          ),
        },
      ]}
    />
  );

  return (
    <Card size="small" className="cad-job">
      <Flex gap={14} wrap>
        <Image.PreviewGroup>
          <Flex gap={8} className="cad-preview">
            {before?.files?.preview ? (
              <figure className="cad-compare">
                <Image src={fileUrl(before, 'preview.png')} alt="Trước khi sửa" width={160} height={160} style={{ objectFit: 'contain' }} />
                <figcaption>Trước · {versionLabel(before)}</figcaption>
              </figure>
            ) : (
              // A figure from a picture: as Hunyuan3D-2 shaped it, before Claude finished it
              job.files?.shaped && (
                <figure className="cad-compare">
                  <Image src={url('shaped.png')} alt="Hunyuan3D dựng" width={160} height={160} style={{ objectFit: 'contain' }} />
                  <figcaption>Hunyuan3D dựng</figcaption>
                </figure>
              )
            )}
            <figure className="cad-compare">
              {job.files?.preview ? (
                <Image src={url('preview.png')} alt="Ảnh xem trước" width={160} height={160} style={{ objectFit: 'contain' }} />
              ) : (
                <div className="cad-preview-empty">{busy ? '⏳' : '—'}</div>
              )}
              {before?.files?.preview ? (
                <figcaption>Sau · {versionLabel(job)}</figcaption>
              ) : job.files?.shaped ? (
                <figcaption>Claude hoàn thiện</figcaption>
              ) : (
                job.files?.assembly && <figcaption>Bày in</figcaption>
              )}
            </figure>
            {job.files?.assembly && (
              // The parts in their places: what ⚙️ Mô phỏng runs, where the preview is laid out for printing
              <figure className="cad-compare">
                <Image src={url('assembly.png')} alt="Lắp ráp" width={160} height={160} style={{ objectFit: 'contain' }} />
                <figcaption>Lắp ráp · dùng để mô phỏng</figcaption>
              </figure>
            )}
          </Flex>
        </Image.PreviewGroup>
        <Flex vertical gap={8} flex={1} style={{ minWidth: 260 }}>
          <Flex justify="space-between" align="start" gap={8}>
            <Typography.Text strong style={{ fontSize: 15 }}>
              {heading}
            </Typography.Text>
            <Tag color={STATE_COLORS[job.state] ?? 'default'}>{(STATE_LABELS as Record<string, string>)[job.state] ?? job.state}</Tag>
          </Flex>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatPrintTime(job.created_at)} · {source}
            {job.parent_id && !fix ? ` · ${versionLabel(job)}` : ''}
          </Typography.Text>
          {job.prompt.trim() !== heading && (
            <PromptText text={job.prompt} />
          )}
          {busy && (
            <Typography.Text>
              ⏳ {(STEP_LABELS as Record<string, string>)[job.step ?? ''] ?? 'Đang chờ container'}
              {job.builds ? ` · đã dựng ${job.builds} lần` : ''}
              {total ? ` · ${total}` : ''}
            </Typography.Text>
          )}
          {!!job.steps?.length &&
            (busy ? (
              <JobSteps job={job} now={now} />
            ) : (
              <Collapse
                size="small"
                items={[{ key: 'steps', label: `Các bước (${job.steps.length}${total ? `, ${total}` : ''})`, children: <JobSteps job={job} now={now} /> }]}
              />
            ))}
          {!!job.notes?.length && (
            <div className="cad-notes">
              {job.notes.slice(busy ? -5 : -3).map((n, i) => (
                <div key={i}>{n}</div>
              ))}
            </div>
          )}
          {job.error && job.state !== 'cancelled' && <Alert type="error" showIcon title={job.error} />}
          {job.report?.ok && (
            <Typography.Text>
              {[size, job.report.volume_cm3 != null ? `${job.report.volume_cm3} cm³` : null, job.report.mesh?.watertight ? 'lưới kín' : 'lưới hở']
                .filter(Boolean)
                .join(' · ')}
            </Typography.Text>
          )}
          {job.report?.print_layout && <PrintPlates layout={job.report.print_layout} />}
          {warnings.length > 0 && <Alert type="warning" title={warnings.map((w, i) => <div key={i}>⚠️ {w}</div>)} />}
          {!!job.report?.palette?.length && (
            <div className="cad-palette">
              {job.report.palette
                .filter((p) => p.share > 0)
                .map((p) => (
                  <PaletteRow key={p.slot} entry={p} />
                ))}
            </div>
          )}
          {details}
          {!!job.sent?.length && (
            <Typography.Text type="secondary">📤 Đã gửi: {job.sent.map((s) => `/imports/${s.name}`).join(', ')}</Typography.Text>
          )}

          <Space wrap size={6}>
            {busy && job.source !== 'code' && (
              <Button size="small" danger icon={<StopOutlined />} loading={acting === 'cancel'} onClick={() => act('cancel')}>
                Hủy
              </Button>
            )}
            {done &&
              (job.files?.threemf ? (
                <Button
                  size="small"
                  type="primary"
                  icon={<SendOutlined />}
                  loading={acting === 'studio-3mf'}
                  onClick={() => sendToStudio('studio-3mf')}
                  title={
                    plates > 1
                      ? `Gửi ${plates} file 3MF, mỗi file một bàn in đã xếp sẵn: mở từng file trong Studio`
                      : plates
                      ? 'File 3MF có các chi tiết đã xếp sẵn trên bàn in'
                      : '3MF đã tô sẵn màu: filament n trong Studio là màu số n'
                  }
                >
                  {plates ? `Gửi sang Studio (${plates} bàn in)` : 'Gửi sang Studio (có màu)'}
                </Button>
              ) : (
                <Button size="small" type="primary" icon={<SendOutlined />} loading={acting === 'studio-stl'} onClick={() => sendToStudio('studio-stl')}>
                  Gửi sang Studio
                </Button>
              ))}
            {done &&
              plates > 1 &&
              Array.from({ length: plates }, (_, k) => (
                <Button key={k} size="small" icon={<DownloadOutlined />} href={`/api/cad/jobs/${encodeURIComponent(job.id)}/plates/${k + 1}`}>
                  3MF bàn {k + 1}
                </Button>
              ))}
            {done && job.files?.threemf && plates <= 1 && link('model.3mf', plates ? '3MF' : '3MF màu', { download: true, icon: <DownloadOutlined /> })}
            {done && link('model.stl', 'STL', { download: true, icon: <DownloadOutlined /> })}
            {done && job.files?.step && link('model.step', 'STEP', { download: true, icon: <DownloadOutlined /> })}
            {done && <EngCheckButton job={job} onRevise={onRevise ? (comment) => onRevise(comment, []) : undefined} />}
            {done && <SimulateButton job={job} />}
            {done && job.files?.assembly && <AssemblyGuideButton job={job} />}
            {job.files?.code && link('model.py', 'Code', { icon: <FileTextOutlined /> })}
            {!busy && job.files?.code && (
              <Button size="small" icon={<EditOutlined />} onClick={() => setRevising(!revising)}>
                Sửa
              </Button>
            )}
            {job.files?.concept && link('concept.png', '🖼 Ảnh gốc')}
            {job.files?.sides &&
              link('sides.png', '🧭 4 góc', {
                title: job.views === 'drawn' ? 'Các góc Hunyuan3D-2mv dựng từ (trái, sau, phải do AI vẽ)' : 'Các góc Hunyuan3D-2mv dựng từ',
              })}
            {job.files?.views && link('views.png', '👁 6 phía', { title: 'Mô hình nhìn từ 6 phía, như Claude đã xem' })}
            {job.files?.fix && link('fix.py', 'fix.py', { icon: <FileTextOutlined /> })}
            {done && job.files?.blend && link('scene.blend', 'Blender', { download: true, icon: <DownloadOutlined />, title: 'Cảnh Blender Claude để lại' })}
            {figure && done && (
              <Button
                size="small"
                icon={<SearchOutlined />}
                onClick={() => setRevising(!revising)}
                title="Claude so mô hình với ảnh gốc, xem từ 6 phía, rồi sửa: chân cụt, mảnh rời, bề mặt sần, lỗ hở… Bản sửa thành phiên bản mới của mô hình này, bản này giữ nguyên"
              >
                Claude review &amp; sửa
              </Button>
            )}
            {figure && !fix && !busy && (
              <Button size="small" loading={acting === 'again'} onClick={() => act('again')} title="Claude dựng lại từ cùng ảnh/mô tả, cỡ và màu: một phiên bản khác">
                🎲 Tạo lại
              </Button>
            )}
            {!busy && onAction && (
              <Popconfirm title="Xóa bản này?" description="Xóa cả file mô hình của bản này, không lấy lại được." okText="Xóa" cancelText="Thôi" okButtonProps={{ danger: true }} onConfirm={() => act('delete')}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} loading={acting === 'delete'} title="Xóa bản này" />
              </Popconfirm>
            )}
          </Space>
          {revising && (
            <Flex vertical gap={6}>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  autoFocus
                  placeholder={`${REVISE_PLACEHOLDERS[figure ? 'figure' : 'technical']} (Ctrl+V để dán ảnh)`}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onPaste={paste}
                  onPressEnter={revise}
                />
                <Button type="primary" loading={sending} onClick={revise}>
                  {figure ? 'Gửi Claude review' : 'Gửi Claude sửa'}
                </Button>
              </Space.Compact>
              {images.length > 0 && (
                <Flex gap={6} wrap>
                  {thumbs.map((url, i) => (
                    <div key={url} style={{ position: 'relative' }}>
                      <Image src={url} width={64} height={64} style={{ objectFit: 'cover', borderRadius: 4 }} alt={`Ảnh dán ${i + 1}`} />
                      <Button
                        size="small"
                        type="text"
                        icon={<CloseOutlined />}
                        title="Bỏ ảnh này"
                        style={{ position: 'absolute', top: 0, right: 0, background: 'rgba(255,255,255,0.8)' }}
                        onClick={() => setImages((current) => current.filter((_, j) => j !== i))}
                      />
                    </div>
                  ))}
                  <Typography.Text type="secondary" style={{ alignSelf: 'center' }}>
                    {images.length}/{MAX_PASTED_IMAGES} ảnh gửi kèm cho Claude
                  </Typography.Text>
                </Flex>
              )}
            </Flex>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}
