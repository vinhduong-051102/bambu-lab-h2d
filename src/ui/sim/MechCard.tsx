'use client';

import { CaretRightOutlined, ReloadOutlined, ToolOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Checkbox, Descriptions, Empty, Flex, List, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { formatNumber } from '../sim';

/**
 * Mechanical designs (docs/mechanical-model.md): the mech/1 models an agent made with the mech_* tools, revision by
 * revision. Shows each part with where its values came from, the assembly's degrees of freedom and diagnostics, the
 * repair proposals (applied only when the user approves them here or tells the agent to), and a run's results per
 * part beside what kinematics predicted. A run opens in the runs list below for its charts and Blender playback.
 */

type Valued<T> = { value: T; source: string; unit?: string; note?: string } | null;
type Diagnostic = { severity: 'error' | 'warning' | 'info'; code: string; message: string; parts?: string[]; joints?: string[] };
type Part = {
  id: string; name?: string; role?: string; fixed: boolean; group: string; material: string | null;
  geometry: { type: string } | null; mass: Valued<number>; density: Valued<number>;
};
type Validation = {
  status: string;
  diagnostics: Diagnostic[];
  missing: { path: string; message: string }[];
  assumptions: { path: string; message: string }[];
  parts: Part[];
  groups: Record<string, string[]>;
  dof: { coordinates: number; equations: number; rank: number; mobility: number; driven?: number; redundant_equations?: number; redundant_by_joint?: Record<string, number> };
  velocities: Record<string, { omega_rpm: number; speed_mm_s: number; moved: boolean }>;
};
type Design = {
  design_id: string; revision: number; revisions: number[]; runs: string[];
  input: { name?: string; request?: string };
  validation: Validation | null;
  revision_info: { note?: string; parent?: number | null; created_at?: string } | null;
};
type Proposal = { id: string; kind: string; summary: string; reason?: string; changes: unknown | null };
type PartResult = { group: string; fixed: boolean; steady_rpm?: number; expected_rpm?: number; displacement_mm?: number; max_speed_mm_s?: number; travel_mm?: number };
type RunResult = {
  sim_id: string; state: string; error?: string | null; status?: string; note?: string;
  parts?: Record<string, PartResult>;
  joints?: Record<string, { type: string; max_reaction_force_N?: number; max_reaction_torque_Nm?: number; stroke_mm_simulated?: number; stroke_mm_kinematic?: number }>;
  gears?: Record<string, { steady_force_N: number | null; max_force_N?: number; note: string }>;
  motors?: Record<string, { steady_effort: number | null; unit: string }>;
  checks?: { id: string; status: string; title: string; detail: string }[];
  mapping?: { assumptions?: { path: string; message: string }[] };
};

export const MECH_STATUS: Record<string, { color: string; text: string }> = {
  passed: { color: 'success', text: 'Đạt' },
  warning: { color: 'warning', text: 'Cảnh báo' },
  failed: { color: 'error', text: 'Lỗi' },
  not_verified: { color: 'default', text: 'Chưa kiểm' },
};
const SOURCE: Record<string, { color: string; text: string }> = {
  user: { color: 'blue', text: 'người dùng' },
  imported_cad: { color: 'geekblue', text: 'CAD' },
  geometry: { color: 'cyan', text: 'hình học' },
  material_database: { color: 'purple', text: 'sổ tay vật liệu' },
  solver: { color: 'green', text: 'bộ giải' },
  assumption: { color: 'orange', text: 'giả định' },
  unknown: { color: 'red', text: 'chưa biết' },
};
const SEVERITY = { error: 'error', warning: 'warning', info: 'success' } as const;

const statusTag = (status?: string | null) => {
  const s = MECH_STATUS[status ?? ''] ?? { color: 'default', text: status ?? '—' };
  return <Tag color={s.color}>{s.text}</Tag>;
};

function Sourced({ v, digits = 4 }: { v: Valued<number>; digits?: number }) {
  if (!v) return <Tag color="red">chưa biết</Tag>;
  const s = SOURCE[v.source] ?? { color: 'default', text: v.source };
  return (
    <Tooltip title={v.note}>
      <Space size={4}>
        <span>{Number(v.value.toPrecision(digits))} {v.unit}</span>
        <Tag color={s.color} style={{ marginInlineEnd: 0 }}>{s.text}</Tag>
      </Space>
    </Tooltip>
  );
}

async function mech<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/mech/${path}`, {
    cache: 'no-store',
    ...(body !== undefined && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.message || `HTTP ${res.status}`);
  return data as T;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function Diagnostics({ v }: { v: Validation }) {
  const items = [...v.diagnostics].sort((a, b) => ['error', 'warning', 'info'].indexOf(a.severity) - ['error', 'warning', 'info'].indexOf(b.severity));
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      <Descriptions size="small" column={{ xs: 2, md: 4 }} bordered>
        <Descriptions.Item label="Bậc tự do">{v.dof.mobility}</Descriptions.Item>
        <Descriptions.Item label="Chưa được dẫn">{v.dof.driven ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Ràng buộc thừa">{v.dof.redundant_equations ?? 0}</Descriptions.Item>
        <Descriptions.Item label="Hạng / phương trình">{v.dof.rank} / {v.dof.equations}</Descriptions.Item>
      </Descriptions>
      {items.map((d, i) => (
        <Alert key={`${d.code}-${i}`} type={SEVERITY[d.severity]} showIcon title={<><Typography.Text code>{d.code}</Typography.Text> {d.message}</>} />
      ))}
      {v.missing.map((m) => (
        <Alert key={m.path} type="warning" showIcon title={<>Thiếu dữ liệu <Typography.Text code>{m.path}</Typography.Text>: {m.message}</>} />
      ))}
      {v.assumptions.map((a) => (
        <Alert key={a.path} type="info" title={<>Giả định <Typography.Text code>{a.path}</Typography.Text>: {a.message}</>} />
      ))}
    </Space>
  );
}

function PartsTable({ v }: { v: Validation }) {
  return (
    <Table
      size="small"
      rowKey="id"
      pagination={false}
      scroll={{ x: 640 }}
      dataSource={v.parts}
      columns={[
        { title: 'Chi tiết', dataIndex: 'id', render: (id: string, p: Part) => <Tooltip title={p.name}>{p.name || id}</Tooltip> },
        { title: 'Vai trò', dataIndex: 'role', width: 90 },
        { title: 'Nhóm cứng', dataIndex: 'group', width: 150, render: (g: string, p: Part) => (p.fixed ? <Tag>nền</Tag> : g) },
        { title: 'Vật liệu', dataIndex: 'material', width: 90, render: (m: string | null) => m ?? '—' },
        { title: 'Khối lượng', dataIndex: 'mass', render: (m: Valued<number>, p: Part) => (p.fixed ? '—' : <Sourced v={m} />) },
        {
          title: 'Dự đoán',
          width: 110,
          render: (_: unknown, p: Part) => {
            const e = v.velocities?.[p.group];
            return e?.moved ? `${formatNumber(e.omega_rpm)} v/ph` : '—';
          },
        },
      ]}
    />
  );
}

function Repairs({ design, onChanged }: { design: Design; onChanged: (revision: number) => void }) {
  const { message, modal } = App.useApp();
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      const data = await mech<{ proposals: Proposal[] }>(`designs/${design.design_id}/repairs`, { revision: design.revision });
      setProposals(data.proposals);
      setPicked([]);
    } catch (err) {
      message.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = () =>
    modal.confirm({
      title: 'Áp dụng các sửa đã chọn?',
      content: 'Tạo một bản sửa mới (bản cũ vẫn giữ) và kiểm tra lại.',
      onOk: async () => {
        try {
          const out = await mech<{ revision: number; before: { status: string }; after: { status: string } }>(`designs/${design.design_id}/apply`, {
            proposal_ids: picked,
            approved: true,
          });
          message.success(`Bản r${out.revision}: ${MECH_STATUS[out.before.status]?.text ?? out.before.status} → ${MECH_STATUS[out.after.status]?.text ?? out.after.status}`);
          setProposals(null);
          onChanged(out.revision);
        } catch (err) {
          message.error(errorText(err));
        }
      },
    });

  if (!proposals) {
    return <Button icon={<ToolOutlined />} loading={busy} onClick={load}>Đề xuất sửa</Button>;
  }
  if (!proposals.length) return <Typography.Text type="secondary">Không có đề xuất sửa nào.</Typography.Text>;
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <List
        size="small"
        bordered
        dataSource={proposals}
        renderItem={(p) => (
          <List.Item>
            <Checkbox
              disabled={p.changes === null}
              checked={picked.includes(p.id)}
              onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((id) => id !== p.id))}
            >
              <Space direction="vertical" size={0}>
                <span>{p.summary}</span>
                {p.reason && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{p.reason}</Typography.Text>}
                {p.changes === null && <Tag color="orange">cần dữ liệu từ bạn</Tag>}
              </Space>
            </Checkbox>
          </List.Item>
        )}
      />
      <Button type="primary" disabled={!picked.length} onClick={apply}>Duyệt và áp dụng ({picked.length})</Button>
    </Space>
  );
}

function RunResults({ designId, simId, onOpenRun }: { designId: string; simId: string; onOpenRun: (simId: string) => void }) {
  const [run, setRun] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      mech<RunResult>(`designs/${designId}/runs/${simId}`)
        .then((data) => {
          setRun(data);
          if (['queued', 'running'].includes(data.state)) timer = setTimeout(load, 3000);
        })
        .catch((err) => setError(errorText(err)));
    load();
    return () => clearTimeout(timer);
  }, [designId, simId]);

  if (error) return <Alert type="warning" showIcon title={error} />;
  if (!run) return null;
  if (run.state !== 'completed') return <Alert type={run.state === 'failed' ? 'error' : 'info'} showIcon title={`Lần chạy ${simId}: ${run.state}`} description={run.error} />;
  const parts = Object.entries(run.parts ?? {}).filter(([, p]) => !p.fixed);
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Space>{statusTag(run.status)}<Typography.Text type="secondary" style={{ fontSize: 12 }}>{run.note}</Typography.Text></Space>
        <Button size="small" icon={<CaretRightOutlined />} onClick={() => onOpenRun(simId)}>Đồ thị và Blender</Button>
      </Flex>
      <Table
        size="small"
        rowKey={([id]) => id}
        pagination={false}
        scroll={{ x: 560 }}
        dataSource={parts}
        columns={[
          { title: 'Chi tiết', render: (_: unknown, [id]: [string, PartResult]) => id },
          { title: 'Mô phỏng (v/ph)', render: (_: unknown, [, p]: [string, PartResult]) => formatNumber(p.steady_rpm ?? NaN) },
          { title: 'Động học (v/ph)', render: (_: unknown, [, p]: [string, PartResult]) => (p.expected_rpm !== undefined ? formatNumber(p.expected_rpm) : '—') },
          { title: 'Vận tốc tâm max (mm/s)', render: (_: unknown, [, p]: [string, PartResult]) => formatNumber(p.max_speed_mm_s ?? NaN) },
          { title: 'Dịch chuyển (mm)', render: (_: unknown, [, p]: [string, PartResult]) => formatNumber(p.displacement_mm ?? NaN) },
        ]}
      />
      <Descriptions size="small" bordered column={1}>
        {Object.entries(run.motors ?? {}).map(([id, m]) => (
          <Descriptions.Item key={id} label={`Động cơ ${id}`}>{m.steady_effort === null ? '—' : `${formatNumber(m.steady_effort)} ${m.unit}`} (ổn định)</Descriptions.Item>
        ))}
        {Object.entries(run.gears ?? {}).map(([id, g]) => (
          <Descriptions.Item key={id} label={<Tooltip title={g.note}>Lực răng {id}</Tooltip>}>
            {g.steady_force_N === null ? '—' : `${formatNumber(g.steady_force_N)} N`} (max {formatNumber(g.max_force_N ?? NaN)} N)
          </Descriptions.Item>
        ))}
        {Object.entries(run.joints ?? {}).map(([id, j]) => (
          <Descriptions.Item key={id} label={`Khớp ${id}`}>
            phản lực max {formatNumber(j.max_reaction_force_N ?? NaN)} N
            {j.stroke_mm_simulated !== undefined && ` · hành trình ${formatNumber(j.stroke_mm_simulated)} mm (động học ${formatNumber(j.stroke_mm_kinematic ?? NaN)})`}
          </Descriptions.Item>
        ))}
      </Descriptions>
      <List
        size="small"
        dataSource={run.checks ?? []}
        renderItem={(c) => (
          <List.Item>
            <Space align="start">{statusTag(c.status)}<span>{c.detail || c.title}</span></Space>
          </List.Item>
        )}
      />
      {run.mapping?.assumptions?.map((a) => <Alert key={a.path} type="info" title={`${a.path}: ${a.message}`} />)}
    </Space>
  );
}

function DesignDetail({ designId, onOpenRun }: { designId: string; onOpenRun: (simId: string) => void }) {
  const { message } = App.useApp();
  const [revision, setRevision] = useState<number | null>(null);
  const [design, setDesign] = useState<Design | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);

  const load = useCallback(() => {
    mech<Design>(`designs/${designId}${revision ? `?revision=${revision}` : ''}`)
      .then((data) => {
        setDesign(data);
        setRun(data.runs.at(-1) ?? null);
        setError(null);
      })
      .catch((err) => setError(errorText(err)));
  }, [designId, revision]);
  useEffect(load, [load]);

  const simulate = async () => {
    if (!design) return;
    setSimulating(true);
    try {
      const out = await mech<{ sim_id: string }>(`designs/${designId}/simulate`, { revision: design.revision, wait_s: 0 });
      setDesign({ ...design, runs: [...design.runs, out.sim_id] });
      setRun(out.sim_id);
    } catch (err) {
      message.error(errorText(err));
    } finally {
      setSimulating(false);
    }
  };

  if (error) return <Alert type="warning" showIcon title={error} />;
  if (!design) return null;
  const v = design.validation;
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Flex gap={8} wrap align="center">
        <Select
          size="small"
          value={design.revision}
          onChange={setRevision}
          style={{ width: 90 }}
          options={design.revisions.map((r) => ({ value: r, label: `r${r}` }))}
        />
        {statusTag(v?.status)}
        <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>{design.revision_info?.note}</Typography.Text>
        <Button size="small" type="primary" loading={simulating} disabled={v?.status === 'failed'} onClick={simulate}>Mô phỏng</Button>
      </Flex>
      {design.input.request && <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>Yêu cầu: {design.input.request}</Typography.Paragraph>}
      {v && (
        <Tabs
          size="small"
          items={[
            { key: 'check', label: 'Kiểm tra lắp ráp', children: <Space direction="vertical" style={{ width: '100%' }}><Diagnostics v={v} /><Repairs design={design} onChanged={setRevision} /></Space> },
            { key: 'parts', label: `Chi tiết (${v.parts.length})`, children: <PartsTable v={v} /> },
            {
              key: 'runs',
              label: `Kết quả (${design.runs.length})`,
              children: design.runs.length ? (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Select size="small" value={run} onChange={setRun} style={{ width: 240 }} options={design.runs.map((r) => ({ value: r, label: r }))} />
                  {run && <RunResults key={run} designId={designId} simId={run} onOpenRun={onOpenRun} />}
                </Space>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa chạy bản này" />
              ),
            },
          ]}
        />
      )}
    </Space>
  );
}

export function MechCard({ onOpenRun }: { onOpenRun: (simId: string) => void }) {
  const [designs, setDesigns] = useState<{ design_id: string; revision: number; name: string | null; status: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const load = useCallback(() => {
    mech<{ designs: NonNullable<typeof designs> }>('designs')
      .then((data) => {
        setDesigns(data.designs);
        setError(null);
      })
      .catch((err) => setError(errorText(err)));
  }, []);
  useEffect(load, [load]);

  const shown = picked ?? designs?.[0]?.design_id ?? null;
  return (
    <Card size="small" title="🧩 Thiết kế cơ khí" extra={<Button size="small" icon={<ReloadOutlined />} onClick={load} title="Tải lại" />}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        Claude dựng thiết kế qua các tool mech_* (chi tiết, khớp, bánh răng, động cơ); ở đây xem bậc tự do, lỗi lắp ráp, duyệt các đề xuất sửa và so kết quả từng chi tiết với lý thuyết.
      </Typography.Paragraph>
      {error ? (
        <Alert type="warning" showIcon title={error} />
      ) : !designs?.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={designs ? 'Chưa có thiết kế nào' : 'Đang tải…'} />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Select
            value={shown}
            onChange={setPicked}
            style={{ width: '100%' }}
            options={designs.map((d) => ({ value: d.design_id, label: `${d.name || d.design_id} · r${d.revision} · ${MECH_STATUS[d.status ?? '']?.text ?? '—'}` }))}
          />
          {shown && <DesignDetail key={shown} designId={shown} onOpenRun={onOpenRun} />}
        </Space>
      )}
    </Card>
  );
}
