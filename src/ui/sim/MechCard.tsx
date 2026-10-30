'use client';

import { CaretRightOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Flex, List, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { formatNumber } from '../sim';

/**
 * Shared by the model simulation panel (ModelSim): the mech API helper, a design's status tags, and a recorded run's
 * results per part beside what kinematics predicted (docs/mechanical-model.md). The run's charts and Blender playback
 * are in the runs list on the ⚙️ Mô phỏng tab.
 */

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

const statusTag = (status?: string | null) => {
  const s = MECH_STATUS[status ?? ''] ?? { color: 'default', text: status ?? '—' };
  return <Tag color={s.color}>{s.text}</Tag>;
};

export async function mech<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/mech/${path}`, {
    cache: 'no-store',
    ...(body !== undefined && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.message || `HTTP ${res.status}`);
  return data as T;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function RunResults({ designId, simId, onOpenRun }: { designId: string; simId: string; onOpenRun: (simId: string) => void }) {
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
