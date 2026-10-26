'use client';

import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  DownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SearchOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Collapse, Flex, Image, Input, Progress, Space, Tag, Timeline, Tooltip, Typography } from 'antd';
import { useState, type ReactNode } from 'react';
import { deltaLabel } from '../../domain/filaments/colourMixing';
import { fileUrl, formatDuration, formatProgress, formatSize, isBusy, jobSteps, modelName, ORIGINS, REVISE_PLACEHOLDERS, STATE_LABELS, STEP_LABELS } from '../cad';
import { formatPrintTime } from '../prints';

export interface CadJob {
  id: string;
  prompt: string;
  title?: string | null;
  source: string;
  model?: string | null;
  input?: string;
  colour?: boolean;
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
  } | null;
  files?: Record<string, boolean>;
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

export type CadAction = 'cancel' | 'again' | 'studio-stl' | 'studio-3mf';

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
 * runs a button; `onRevise` sends the revise/review comment (a figure may go without words: Claude then looks for
 * problems itself).
 */
export function CadJobCard(props: {
  job: CadJob;
  now?: number;
  onAction?: (action: CadAction) => Promise<void>;
  onRevise?: (comment: string) => Promise<boolean>;
}) {
  const { job, now = Date.now(), onAction, onRevise } = props;
  const [acting, setActing] = useState<CadAction | null>(null);
  const [revising, setRevising] = useState(false);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);

  const busy = isBusy(job);
  const done = job.state === 'done';
  const figure = job.source === 'mesh';
  // Claude reviewing and fixing a figure
  const fix = figure && job.input === 'fix';
  const size = formatSize(job.report?.size_mm);
  const source = fix ? `Claude sửa · ${modelName(job.model)}` : figure ? 'Hunyuan3D' : job.source === 'code' ? 'Antigravity / code' : modelName(job.model);
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

  const revise = async () => {
    if (!onRevise) return;
    setSending(true);
    try {
      if (await onRevise(comment.trim())) {
        setRevising(false);
        setComment('');
      }
    } finally {
      setSending(false);
    }
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
        <div className="cad-preview">
          {job.files?.preview ? (
            <Image src={url('preview.png')} alt="Ảnh xem trước" width={160} height={160} style={{ objectFit: 'contain' }} />
          ) : (
            <div className="cad-preview-empty">{busy ? '⏳' : '—'}</div>
          )}
        </div>
        <Flex vertical gap={8} flex={1} style={{ minWidth: 260 }}>
          <Flex justify="space-between" align="start" gap={8}>
            <Typography.Text strong style={{ fontSize: 15 }}>
              {job.title || job.prompt}
            </Typography.Text>
            <Tag color={STATE_COLORS[job.state] ?? 'default'}>{(STATE_LABELS as Record<string, string>)[job.state] ?? job.state}</Tag>
          </Flex>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatPrintTime(job.created_at)} · {source}
            {job.parent_id ? ' · bản sửa' : ''}
          </Typography.Text>
          {job.title && job.title !== job.prompt && (
            <Typography.Paragraph type="secondary" ellipsis={{ rows: 2, expandable: 'collapsible' }} style={{ margin: 0 }}>
              {job.prompt}
            </Typography.Paragraph>
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
                  onClick={() => act('studio-3mf')}
                  title="3MF đã tô sẵn màu: filament n trong Studio là màu số n"
                >
                  Gửi sang Studio (có màu)
                </Button>
              ) : (
                <Button size="small" type="primary" icon={<SendOutlined />} loading={acting === 'studio-stl'} onClick={() => act('studio-stl')}>
                  Gửi sang Studio
                </Button>
              ))}
            {done && job.files?.threemf && link('model.3mf', '3MF màu', { download: true, icon: <DownloadOutlined /> })}
            {done && link('model.stl', 'STL', { download: true, icon: <DownloadOutlined /> })}
            {done && job.files?.step && link('model.step', 'STEP', { download: true, icon: <DownloadOutlined /> })}
            {job.files?.code && link('model.py', 'Code', { icon: <FileTextOutlined /> })}
            {!busy && job.files?.code && (
              <Button size="small" icon={<EditOutlined />} onClick={() => setRevising(!revising)}>
                Sửa
              </Button>
            )}
            {job.files?.concept && link('concept.png', '🖼 Ảnh gốc')}
            {job.files?.views && link('views.png', '👁 6 phía', { title: 'Mô hình nhìn từ 6 phía, như Claude đã xem' })}
            {job.files?.fix && link('fix.py', 'fix.py', { icon: <FileTextOutlined /> })}
            {figure && done && (
              <Button
                size="small"
                icon={<SearchOutlined />}
                onClick={() => setRevising(!revising)}
                title="Claude so mô hình với ảnh gốc, xem từ 6 phía, rồi sửa: chân cụt, mảnh rời, bề mặt sần, lỗ hở… Bản sửa là mô hình mới, bản này giữ nguyên"
              >
                Claude review &amp; sửa
              </Button>
            )}
            {figure && !fix && !busy && (
              <Button size="small" loading={acting === 'again'} onClick={() => act('again')} title="Dựng lại từ cùng ảnh/mô tả với số ngẫu nhiên khác">
                🎲 Tạo lại
              </Button>
            )}
          </Space>
          {revising && (
            <Space.Compact style={{ width: '100%' }}>
              <Input
                autoFocus
                maxLength={4000}
                placeholder={REVISE_PLACEHOLDERS[figure ? 'figure' : 'technical']}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onPressEnter={revise}
              />
              <Button type="primary" loading={sending} onClick={revise}>
                {figure ? 'Gửi Claude review' : 'Gửi Claude sửa'}
              </Button>
            </Space.Compact>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}
