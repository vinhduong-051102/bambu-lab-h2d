'use client';

import { ExperimentOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Flex, Image, Progress, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useActions } from '../DashboardContext';
import { printsApi } from './PrintModals';

/**
 * "Thành phần của mẫu" (docs/studio.md): the parts measured on each object of a print (GET/POST
 * /api/prints/:id/parts), their coloured render and the names Claude gave them; and measuring the earlier prints
 * all at once (/api/studio/parts/backfill), so "AI tối ưu" can compare a new plate's parts with them.
 */

interface Feature {
  id: string;
  kind: string;
  count: number;
  colour: string;
  text: string;
}

interface Component {
  name: string;
  role: string;
  features: string[];
  risk: string;
}

interface Analysis {
  key: string;
  file: string;
  matched: boolean;
  reason?: string;
  features: Feature[];
  description?: string;
  purpose?: string;
  components?: Component[];
  named_by?: string;
  naming_error?: string;
}

export interface ObjectParts {
  name: string;
  status: 'missing' | 'pending' | 'done';
  analysis: Analysis | null;
}

const imageUrl = (key: string, image: string) => `/api/studio/parts/${key}/${image}`;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const Swatch = ({ colour }: { colour: string }) => (
  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: colour, border: '1px solid rgba(0,0,0,.25)', marginRight: 6 }} />
);

function FeatureLine({ feature }: { feature: Feature }) {
  return (
    <div style={{ fontSize: 13 }}>
      <Swatch colour={feature.colour} />
      <Typography.Text type="secondary">{feature.id}</Typography.Text> {feature.text}
    </div>
  );
}

/** One object: its renders, Claude's names with the measured parts under each, and the parts left unnamed */
export function ObjectCard({ object }: { object: ObjectParts }) {
  const a = object.analysis;
  const body = () => {
    if (object.status === 'missing') return <Typography.Text type="secondary">Không thấy file lưới của vật thể này trong thư mục import của Studio.</Typography.Text>;
    if (!a) return <Typography.Text type="secondary">Chưa đo.</Typography.Text>;
    if (!a.matched) return <Alert type="warning" showIcon title={`Không khớp được hướng đặt với số liệu Studio gửi${a.reason ? `: ${a.reason}` : ''}.`} />;
    if (!a.features.length) return <Typography.Text type="secondary">Không có thành phần nào đáng chú ý.</Typography.Text>;
    const byId = new Map(a.features.map((f) => [f.id, f]));
    const named = new Set((a.components ?? []).flatMap((c) => c.features));
    const others = a.features.filter((f) => !named.has(f.id));
    return (
      <Flex gap={12} wrap align="start">
        <Image.PreviewGroup>
          <Flex vertical gap={6}>
            <Image src={imageUrl(a.key, 'parts.png')} alt="Thành phần tô màu" width={280} />
            <Image src={imageUrl(a.key, 'views.png')} alt="Sáu phía" width={280} />
          </Flex>
        </Image.PreviewGroup>
        <Flex vertical gap={8} style={{ flex: '1 1 320px', minWidth: 0 }}>
          {a.description && <Typography.Text strong>{a.description}</Typography.Text>}
          {a.purpose && <Typography.Text type="secondary">{a.purpose}</Typography.Text>}
          {a.naming_error ? (
            <Alert type="warning" showIcon title={`Claude chưa đặt tên được: ${a.naming_error}`} />
          ) : (
            !a.components && <Typography.Text type="secondary">⏳ Claude chưa đặt tên các bộ phận.</Typography.Text>
          )}
          {(a.components ?? []).map((c) => (
            <div key={c.name}>
              <Typography.Text strong>{c.name}</Typography.Text> <Typography.Text type="secondary">— {c.role}</Typography.Text>
              {c.features.map((id) => byId.get(id)).map((f) => f && <FeatureLine key={f.id} feature={f} />)}
              {c.risk && (
                <Typography.Text type="warning" style={{ fontSize: 13 }}>
                  ⚠ {c.risk}
                </Typography.Text>
              )}
            </div>
          ))}
          {others.length > 0 && (
            <div>
              {a.components && <Typography.Text type="secondary">Thành phần khác</Typography.Text>}
              {others.map((f) => (
                <FeatureLine key={f.id} feature={f} />
              ))}
            </div>
          )}
        </Flex>
      </Flex>
    );
  };
  return (
    <Card size="small" title={object.name} extra={a?.named_by && <Tag>{a.named_by}</Tag>}>
      {body()}
    </Card>
  );
}

const POLL_MS = 3000;

/** The parts of one print's objects, with a button that measures them (and asks Claude again when it failed) */
export function PrintParts({ printId, hasSetup }: { printId: string; hasSetup: boolean }) {
  const { showToast, addLog } = useActions();
  const [objects, setObjects] = useState<ObjectParts[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const url = `/api/prints/${encodeURIComponent(printId)}/parts`;
  // Set while this page watches an analysis (it runs in the gateway and goes on when the page closes)
  const watching = useRef(false);

  const finished = useCallback(
    (list: ObjectParts[]) => addLog(`Đã phân tích thành phần của ${list.filter((o) => o.status === 'done').length}/${list.length} vật thể.`, 'success'),
    [addLog]
  );

  // The parts measured so far, and the analysis running now (also one started before the page was opened again)
  const load = useCallback(
    (cancelled: () => boolean = () => false) =>
      printsApi<{ enabled: boolean; objects: ObjectParts[]; task?: { running: boolean; error: string | null } | null }>(url)
        .then((d) => {
          if (cancelled()) return;
          setEnabled(d.enabled);
          setObjects(d.objects);
          setRunning(Boolean(d.task?.running));
          if (d.task && !d.task.running && watching.current) {
            watching.current = false;
            if (d.task.error) showToast(d.task.error, 'error');
            else finished(d.objects);
          }
        })
        .catch((err) => !cancelled() && setError(errorText(err))),
    [url, showToast, finished]
  );

  useEffect(() => {
    if (!hasSetup) return;
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load, hasSetup]);

  useEffect(() => {
    if (!running) return;
    watching.current = true;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const analyze = async () => {
    setRunning(true);
    let goesOn = false;
    try {
      const d = await printsApi<{ objects: ObjectParts[]; running?: boolean }>(url, { method: 'POST' });
      setObjects(d.objects);
      setError(null);
      // Still measuring: read until it is done
      goesOn = Boolean(d.running);
      if (!goesOn) finished(d.objects);
    } catch (err) {
      showToast(errorText(err), 'error');
    } finally {
      if (!goesOn) setRunning(false);
    }
  };

  if (!hasSetup) return <Typography.Text type="secondary">Bản in không gửi từ Studio nên không biết mẫu nào.</Typography.Text>;
  if (error) return <Alert type="error" title={error} />;
  if (!objects) return <Typography.Text type="secondary">Đang tải...</Typography.Text>;
  const unfinished = objects.some(
    (o) => o.status === 'pending' || (o.analysis?.matched && o.analysis.features.length > 0 && (!o.analysis.components || o.analysis.naming_error))
  );
  return (
    <Flex vertical gap={8}>
      {!enabled && <Alert type="info" showIcon title="Chưa bật đo thành phần: cần MESH_WORKER_URL (container mesh3d) và STUDIO_IMPORT_DIR." />}
      {enabled && objects.some((o) => o.status !== 'missing') && (
        <Space>
          <Button size="small" icon={<ExperimentOutlined />} loading={running} onClick={analyze}>
            {unfinished ? 'Phân tích' : 'Phân tích lại'}
          </Button>
          {running && <Typography.Text type="secondary">Đo vài giây mỗi vật thể, Claude đặt tên thêm khoảng một phút...</Typography.Text>}
        </Space>
      )}
      {objects.length === 0 ? (
        <Typography.Text type="secondary">Không có vật thể nào.</Typography.Text>
      ) : (
        objects.map((o, i) => <ObjectCard key={`${o.name}-${i}`} object={o} />)
      )}
    </Flex>
  );
}

interface Backfill {
  enabled: boolean;
  running: boolean;
  total: number;
  done: number;
  failed: string[];
  finished_at: string | null;
}

const BACKFILL_POLL_MS = 3000;

/** Measures every object of the prints sent from Studio, one after another, and shows how far it has got */
export function PartsBackfillButton() {
  const { showToast, addLog } = useActions();
  const [state, setState] = useState<Backfill | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const poll = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      const d = await printsApi<Backfill>('/api/studio/parts/backfill');
      setState(d);
      if (d.running) timer.current = setTimeout(poll, BACKFILL_POLL_MS);
    } catch {
      // Older gateway or none: no button
    }
  }, []);

  useEffect(() => {
    poll();
    return () => clearTimeout(timer.current);
  }, [poll]);

  const start = async () => {
    try {
      const d = await printsApi<Backfill>('/api/studio/parts/backfill', { method: 'POST' });
      setState({ ...d, enabled: true });
      addLog(`Bắt đầu phân tích thành phần của ${d.total} vật thể trong các bản in cũ.`);
      poll();
    } catch (err) {
      showToast(errorText(err), 'error');
    }
  };

  if (!state?.enabled) return null;
  if (state.running)
    return (
      <Space title="Đang phân tích thành phần các bản in cũ">
        <ExperimentOutlined />
        <Progress percent={state.total ? Math.round((state.done / state.total) * 100) : 0} size="small" style={{ width: 120, margin: 0 }} />
        <Typography.Text type="secondary">
          {state.done}/{state.total}
        </Typography.Text>
      </Space>
    );
  const summary = state.finished_at
    ? `Lần trước: ${state.done}/${state.total} vật thể${state.failed.length ? `, ${state.failed.length} lỗi:\n${state.failed.join('\n')}` : ''}`
    : 'Đo và đặt tên thành phần cho mọi vật thể trong các bản in gửi từ Studio';
  return (
    <Button icon={<ExperimentOutlined />} title={summary} onClick={start}>
      Phân tích bản in cũ
    </Button>
  );
}
