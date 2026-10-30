'use client';

import { CheckCircleFilled, CloseCircleFilled, MinusCircleFilled, PlayCircleOutlined, ReloadOutlined, StopOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Col, Descriptions, Empty, Flex, List, Row, Select, Space, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatPrintTime } from '../prints';
import { SIM_STATES, checksSummary, formatNumber, isSimBusy, jointUnits, parseCsv, seriesBy, simFileUrl, thin } from '../sim';
import { EXAMPLES } from '../simLive';
import { MechCard } from './MechCard';
import { ImportedModels } from './ModelSim';
import { SimLive } from './SimLive';

/**
 * Mechanism simulations (docs/mechanical-simulation.md): the runs an agent started with the sim_* tools, each one's
 * checks against theory, its joints over time from joint_results.csv, and the Blender playback, which can be
 * rendered from here. Runs themselves are started by the agent (MCP), not from this page. A mechanism (an example,
 * a stored one, or a run's) also opens as a live session (docs/interactive-physics.md) to act on while it runs.
 */

type Check = { id: string; kind: string; passed: boolean | null; description?: string; max_error?: number; tolerance?: number; unit?: string };
type RunRow = { sim_id: string; name: string; state: string; progress?: number; created_at: string; checks_failed?: string[] };
type Playback = { state: string; error?: string | null; check?: { passed?: boolean }; files?: Record<string, string> };
type Results = {
  sim_id: string;
  state: string;
  summary?: {
    name: string;
    error: string | null;
    duration_s: number;
    samples: number;
    engine: string;
    result_kind: string;
    checks: Check[];
    assumptions: { path: string; message: string }[];
    warnings: { path: string; message: string }[];
    joints: Record<string, { kind: string }>;
    bodies: Record<string, { travel_m: number; max_speed_m_s: number; max_angular_speed_rad_s: number }>;
  };
  playback?: Playback | null;
  files?: Record<string, string>;
};

const CHECK_ICON = (passed: boolean | null) =>
  passed === true ? (
    <CheckCircleFilled style={{ color: '#10b981' }} />
  ) : passed === false ? (
    <CloseCircleFilled style={{ color: '#ef4444' }} />
  ) : (
    <MinusCircleFilled style={{ color: '#9ca3af' }} />
  );

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.message || `HTTP ${res.status}`);
  return data as T;
}

/** A line chart of one series, in SVG: no chart library for one plot */
function LineChart({ points, unit }: { points: [number, number | null][]; unit: string }) {
  const valid = points.filter((p): p is [number, number] => p[1] !== null && Number.isFinite(p[1]));
  if (valid.length < 2) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có dữ liệu" />;
  const W = 640, H = 220, L = 56, R = 12, T = 12, B = 28;
  const xs = valid.map((p) => p[0]), ys = valid.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 1e-12) { y0 -= 1; y1 += 1; }
  const px = (x: number) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R);
  const py = (y: number) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const path = valid.map(([x, y], i) => `${i ? 'L' : 'M'}${px(x).toFixed(1)},${py(y).toFixed(1)}`).join('');
  const ticks = [y0, (y0 + y1) / 2, y1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sim-chart" role="img" aria-label={`Đồ thị theo thời gian (${unit})`}>
      {ticks.map((y) => (
        <g key={y}>
          <line x1={L} x2={W - R} y1={py(y)} y2={py(y)} className="sim-chart-grid" />
          <text x={L - 6} y={py(y) + 4} textAnchor="end" className="sim-chart-label">
            {formatNumber(y)}
          </text>
        </g>
      ))}
      <text x={L} y={H - 8} className="sim-chart-label">{formatNumber(x0)} s</text>
      <text x={W - R} y={H - 8} textAnchor="end" className="sim-chart-label">{formatNumber(x1)} s</text>
      <text x={L + 4} y={T + 10} className="sim-chart-label">{unit}</text>
      <path d={path} className="sim-chart-line" />
    </svg>
  );
}

/** One joint (or motor, spring, contact gear) over time: its value, rate or effort */
function JointChart({ simId, joints }: { simId: string; joints: Record<string, { kind: string }> }) {
  const ids = Object.keys(joints);
  const [item, setItem] = useState(ids[0]);
  const [field, setField] = useState<'value' | 'rate' | 'effort'>('value');
  const [series, setSeries] = useState<Record<string, Record<string, (number | null)[]>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // RunDetail is keyed by the run, so this loads once per run
  useEffect(() => {
    fetch(simFileUrl(simId, 'joint_results.csv'), { cache: 'no-store' })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((text) => setSeries(seriesBy(parseCsv(text), 'item', ['value', 'rate', 'effort'])))
      .catch((err) => setError(String(err.message || err)));
  }, [simId]);

  if (error) return <Alert type="warning" showIcon title={`Không đọc được joint_results.csv: ${error}`} />;
  if (!series || !item) return null;
  const kind = joints[item]?.kind ?? '';
  // A contact gear's value is its tooth deflection δ (m) and its effort the tooth force (N)
  const units = kind === 'gear'
    ? { value: { label: 'δ dọc đường ăn khớp', unit: 'µm', scale: 1e6 }, rate: { label: 'dδ/dt', unit: 'mm/s', scale: 1000 }, effort: { label: 'Lực răng', unit: 'N', scale: 1 } }
    : jointUnits(kind);
  const s = series[item];
  const spec = units[field];
  const points = s ? thin(s.t as number[], s[field].map((v) => (v === null ? null : v * spec.scale))) : [];

  return (
    <Flex vertical gap={8}>
      <Space wrap>
        <Select size="small" value={item} onChange={setItem} style={{ minWidth: 180 }} options={ids.map((id) => ({ value: id, label: `${id} (${joints[id].kind})` }))} />
        <Select
          size="small"
          value={field}
          onChange={setField}
          style={{ minWidth: 160 }}
          options={(['value', 'rate', 'effort'] as const).map((f) => ({ value: f, label: units[f].label }))}
        />
      </Space>
      <LineChart points={points as [number, number | null][]} unit={spec.unit} />
    </Flex>
  );
}

function RunDetail({ simId, onChanged, onInteract }: { simId: string; onChanged: () => void; onInteract: (request: Record<string, unknown>) => void }) {
  const { message } = App.useApp();
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  const load = useCallback(() => {
    getJson<Results>(`/api/sim/runs/${simId}/results`)
      .then((data) => {
        setResults(data);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [simId]);

  useEffect(() => {
    setResults(null);
    load();
  }, [load]);

  // Follow a playback while Blender works
  const playing = results?.playback && isSimBusy(results.playback.state);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [playing, load]);

  const render = async () => {
    setRendering(true);
    try {
      await getJson(`/api/sim/runs/${simId}/play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ render: true }),
      });
      message.info('Blender đang dựng lại chuyển động…');
      load();
      onChanged();
    } catch (err) {
      message.error(`Không dựng được: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRendering(false);
    }
  };

  if (error) return <Alert type="warning" showIcon title={error} />;
  if (!results) return <Card loading />;
  const summary = results.summary;
  if (!summary) {
    return <Alert type="info" showIcon title={`Mô phỏng đang ở trạng thái ${SIM_STATES[results.state as keyof typeof SIM_STATES]?.text ?? results.state}.`} />;
  }
  const checks = checksSummary(summary.checks);
  const video = results.playback?.files?.['blender/playback.mp4'];

  return (
    <Flex vertical gap={16}>
      <Descriptions size="small" bordered column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label="Cơ cấu">{summary.name}</Descriptions.Item>
        <Descriptions.Item label="Kiểm tra">
          <Tag color={checks.failed.length ? 'error' : 'success'}>
            {checks.passed}/{checks.total} đạt
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Thời gian mô phỏng">
          {summary.duration_s} s · {summary.samples} mẫu
        </Descriptions.Item>
        <Descriptions.Item label="Engine">{summary.engine}</Descriptions.Item>
        <Descriptions.Item label="Tương tác" span={2}>
          <Button size="small" icon={<ThunderboltOutlined />} onClick={() => onInteract({ sim_id: simId })} title="Mở mô hình của lần chạy này trong phiên tương tác: kéo, đẩy, đổi motor khi đang chạy">
            🎮 Mở tương tác
          </Button>
        </Descriptions.Item>
        <Descriptions.Item label="Loại kết quả" span={2}>
          <Typography.Text type="secondary">{summary.result_kind}</Typography.Text>
        </Descriptions.Item>
      </Descriptions>
      {summary.error && <Alert type="error" showIcon title={summary.error} />}

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card size="small" title="Kiểm tra theo lý thuyết">
            <List
              size="small"
              dataSource={summary.checks}
              renderItem={(c) => (
                <List.Item>
                  <Space align="start">
                    {CHECK_ICON(c.passed)}
                    <span>
                      {c.description || c.id}
                      {c.max_error !== undefined && c.tolerance !== undefined && (
                        <Typography.Text type="secondary">
                          {' '}
                          (sai số {formatNumber(c.max_error)} / ngưỡng {formatNumber(c.tolerance)} {c.unit ?? ''})
                        </Typography.Text>
                      )}
                    </span>
                  </Space>
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            size="small"
            title="Blender"
            extra={
              <Button size="small" icon={<PlayCircleOutlined />} loading={rendering || Boolean(playing)} onClick={render} disabled={results.state !== 'completed'}>
                {video ? 'Dựng lại' : 'Dựng video'}
              </Button>
            }
          >
            {results.playback?.error && <Alert type="error" showIcon title={results.playback.error} style={{ marginBottom: 8 }} />}
            {video ? (
              <video key={video} className="sim-video" src={simFileUrl(simId, 'blender/playback.mp4')} controls loop muted playsInline />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={playing ? 'Blender đang dựng…' : 'Chưa có video'} />
            )}
          </Card>
        </Col>
      </Row>

      <Card size="small" title="Khớp, động cơ, lò xo theo thời gian">
        <JointChart simId={simId} joints={summary.joints} />
      </Card>

      <Card size="small" title="Vật thể">
        <Table
          size="small"
          pagination={false}
          rowKey="id"
          dataSource={Object.entries(summary.bodies).map(([id, b]) => ({ id, ...b }))}
          columns={[
            { title: 'Body', dataIndex: 'id' },
            { title: 'Dịch chuyển lớn nhất (mm)', dataIndex: 'travel_m', render: (v: number) => formatNumber(v * 1000) },
            { title: 'Tốc độ lớn nhất (mm/s)', dataIndex: 'max_speed_m_s', render: (v: number) => formatNumber(v * 1000) },
            { title: 'Tốc độ góc lớn nhất (°/s)', dataIndex: 'max_angular_speed_rad_s', render: (v: number) => formatNumber((v * 180) / Math.PI) },
          ]}
        />
      </Card>

      {(summary.assumptions.length > 0 || summary.warnings.length > 0) && (
        <Card size="small" title="Giả định và cảnh báo">
          <List
            size="small"
            dataSource={[...summary.warnings.map((w) => ({ ...w, warn: true })), ...summary.assumptions.map((a) => ({ ...a, warn: false }))]}
            renderItem={(a) => (
              <List.Item>
                <Space align="start">
                  <Tag color={a.warn ? 'warning' : 'default'}>{a.path}</Tag>
                  <span>{a.message}</span>
                </Space>
              </List.Item>
            )}
          />
        </Card>
      )}

      <Space wrap>
        {Object.keys(results.files ?? {}).map((name) => (
          <Button key={name} size="small" type="link" href={simFileUrl(simId, name)} target="_blank">
            {name}
          </Button>
        ))}
      </Space>
    </Flex>
  );
}

type LiveList = { sessions: { session_id: string; name: string; t: number; running: boolean }[]; examples: string[] };

/** Opens a live session: an example, a stored mechanism, or one already running */
function LiveStarter({ onOpen }: { onOpen: (sessionId: string) => void }) {
  const { message } = App.useApp();
  const [list, setList] = useState<LiveList | null>(null);
  const [mechanisms, setMechanisms] = useState<{ mechanism_id: string; name: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState('example:drop_box');
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    getJson<LiveList>('/api/sim/live')
      .then((data) => {
        setList(data);
        setError(null);
      })
      .catch((err) => setError(err.message));
    getJson<{ mechanisms: { mechanism_id: string; name: string | null }[] }>('/api/sim/mechanisms')
      .then((data) => setMechanisms(data.mechanisms))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  const start = async () => {
    const [kind, id] = [choice.slice(0, choice.indexOf(':')), choice.slice(choice.indexOf(':') + 1)];
    if (kind === 'session') return onOpen(id);
    setStarting(true);
    try {
      const data = await getJson<{ session_id: string }>('/api/sim/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'example' ? { example: id } : { mechanism_id: id }),
      });
      onOpen(data.session_id);
    } catch (err) {
      message.error(`Không mở được phiên: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStarting(false);
    }
  };

  const examples = EXAMPLES.filter((e) => !list || list.examples.includes(e.value));
  return (
    <Card size="small" title="🎮 Mô phỏng tương tác" extra={<Button size="small" icon={<ReloadOutlined />} onClick={load} title="Tải lại" />}>
      {error ? (
        <Alert type="info" showIcon title={error} description="Bật container: docker compose -f docker-compose.sim-live.yml up -d (docs/interactive-physics.md)." />
      ) : (
        <Flex gap={8} wrap align="center">
          <Select
            value={choice}
            onChange={setChoice}
            style={{ minWidth: 300, flex: '1 1 300px' }}
            options={[
              ...(list?.sessions.length ? [{ label: 'Phiên đang chạy', options: list.sessions.map((s) => ({ value: `session:${s.session_id}`, label: `${s.name} (t = ${s.t.toFixed(1)} s)` })) }] : []),
              { label: 'Ví dụ', options: examples.map((e) => ({ value: `example:${e.value}`, label: e.label })) },
              ...(mechanisms.length ? [{ label: 'Cơ cấu đã lưu', options: mechanisms.map((m) => ({ value: `mechanism:${m.mechanism_id}`, label: m.name || m.mechanism_id })) }] : []),
            ]}
          />
          <Button type="primary" icon={<ThunderboltOutlined />} loading={starting} onClick={start}>
            {choice.startsWith('session:') ? 'Mở lại' : 'Bắt đầu'}
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Chrono chạy liên tục theo thời gian thực: kéo vật bằng chuột, đẩy, đổi motor và trọng lực khi đang chạy.
          </Typography.Text>
        </Flex>
      )}
    </Card>
  );
}

export function SimCard() {
  const { message } = App.useApp();
  const [live, setLive] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const load = useCallback(() => {
    getJson<{ runs: RunRow[] }>('/api/sim/runs')
      .then((data) => {
        setRuns(data.runs);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(load, [load]);
  const busy = useMemo(() => (runs ?? []).some((r) => isSimBusy(r.state)), [runs]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [busy, load]);

  const shown = picked ?? runs?.[0]?.sim_id ?? null;

  const cancel = async (simId: string) => {
    try {
      await getJson(`/api/sim/runs/${simId}/cancel`, { method: 'POST' });
      load();
    } catch (err) {
      message.error(`Không hủy được: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const interact = async (request: Record<string, unknown>) => {
    try {
      const data = await getJson<{ session_id: string }>('/api/sim/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      setLive(data.session_id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      message.error(`Không mở được phiên: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <Row gutter={[16, 16]}>
      <Col span={24}>{live ? <SimLive key={live} sessionId={live} onClose={() => setLive(null)} /> : <LiveStarter onOpen={setLive} />}</Col>
      <Col span={24}>
        <ImportedModels />
      </Col>
      <Col span={24}>
        <MechCard onOpenRun={setPicked} />
      </Col>
      <Col xs={24} xl={9}>
        <Card
          title="⚙️ Mô phỏng cơ cấu"
          extra={<Button size="small" icon={<ReloadOutlined />} onClick={load} title="Tải lại" />}
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            Claude tạo và chạy mô phỏng qua các tool sim_* (Project Chrono trên máy này); ở đây xem kết quả và dựng video Blender.
          </Typography.Paragraph>
          {error && <Alert type="warning" showIcon title={error} />}
          <Table
            size="small"
            loading={runs === null && !error}
            rowKey="sim_id"
            dataSource={runs ?? []}
            pagination={{ pageSize: 12, hideOnSinglePage: true }}
            onRow={(r) => ({ onClick: () => setPicked(r.sim_id), className: r.sim_id === shown ? 'sim-row-picked' : 'sim-row' })}
            columns={[
              { title: 'Cơ cấu', dataIndex: 'name', ellipsis: true },
              {
                title: 'Trạng thái',
                dataIndex: 'state',
                width: 120,
                render: (state: string, r: RunRow) => {
                  const s = SIM_STATES[state as keyof typeof SIM_STATES] ?? { color: 'default', text: state };
                  return (
                    <Space size={4}>
                      <Tag color={r.checks_failed?.length ? 'error' : s.color}>
                        {s.text}
                        {state === 'running' && r.progress !== undefined ? ` ${Math.round(r.progress * 100)}%` : ''}
                      </Tag>
                      {isSimBusy(state) && (
                        <Button size="small" type="text" danger icon={<StopOutlined />} title="Hủy" onClick={(e) => { e.stopPropagation(); cancel(r.sim_id); }} />
                      )}
                    </Space>
                  );
                },
              },
              { title: 'Lúc', dataIndex: 'created_at', width: 96, render: (v: string) => formatPrintTime(v) },
            ]}
          />
        </Card>
      </Col>
      <Col xs={24} xl={15}>
        {shown ? <RunDetail key={shown} simId={shown} onChanged={load} onInteract={interact} /> : <Card><Empty description="Chưa có mô phỏng nào" /></Card>}
      </Col>
    </Row>
  );
}
