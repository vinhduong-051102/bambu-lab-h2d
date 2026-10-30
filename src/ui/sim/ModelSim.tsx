'use client';

import { CaretRightOutlined, ExperimentOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Checkbox, Collapse, Descriptions, Empty, Flex, InputNumber, Select, Space, Table, Tag, Tooltip, Typography, Upload } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CAN_SIMULATE, MODEL_SIM_STATES, partMotion } from '../modelSim';
import { formatNumber, isSimBusy } from '../sim';
import { MECH_STATUS, RunResults, mech } from './MechCard';
import { SimLive, type LivePick } from './SimLive';

/**
 * Simulating a 3D model as it is (docs/model-simulation.md): the components of a design job or an imported model,
 * their physical setup (what is fixed, materials, joints, motors) as a versioned design, the checks, and the model
 * itself running in the live Chrono viewer, each component picked to see its data and how it moves. The state shown
 * is the one the worker reads from what is stored (and the live session the gateway sees), never a guess of the page.
 */

type Vec = [number, number, number];
type Diagnostic = { severity: 'error' | 'warning' | 'info'; code: string; message: string; parts?: string[]; joints?: string[] };
type Validation = {
  status: string;
  diagnostics: Diagnostic[];
  missing: { path: string; message: string }[];
  assumptions: { path: string; message: string }[];
  dof: { mobility: number; driven?: number; redundant_equations?: number };
};
type Hypothesis = {
  id: string;
  kind: 'joint' | 'contact';
  confidence: string;
  reason: string;
  joint?: InputJoint;
  parts?: string[];
};
const POLL_MS = 3000;

type Status = {
  model_id: string;
  model_version: number | null;
  design_id: string | null;
  revision: number | null;
  design_version?: number;
  state: keyof typeof MODEL_SIM_STATES;
  reason?: string;
  components: { id: string; name: string }[];
  validation?: Validation | null;
  hypotheses?: Hypothesis[];
  runs?: { sim_id: string; revision: number; state: string; current: boolean }[];
  live?: { session_id: string; t: number; running: boolean } | null;
  /** "Chuẩn bị mô phỏng" running in the gateway (it goes on when the page closes), or how the last one ended */
  setup_task?: { running: boolean; error: string | null } | null;
  live_available?: boolean;
};
type InputPart = {
  id: string;
  name?: string;
  role?: string;
  fixed?: boolean;
  material?: string | null;
  mass?: number | null;
  collision?: boolean;
  friction?: number | null;
  [key: string]: unknown;
};
type InputJoint = { id: string; type: string; part_a: string; part_b: string; position?: Vec; axis?: Vec; source?: string; confidence?: string };
type InputMotor = { id: string; joint: string; speed_rpm?: number; ramp_s?: number; mode?: string; law?: unknown };
type DesignInput = {
  parts: InputPart[];
  joints: InputJoint[];
  motors: InputMotor[];
  simulation?: { duration?: number; time_step?: number; gravity?: Vec };
};
type ViewerPart = {
  id: string;
  name?: string;
  role?: string;
  body: string;
  fixed: boolean;
  material: string | null;
  point_mm: Vec;
  joints: string[];
  geometry: { type: string } | null;
  mass: { value: number; source: string; unit?: string } | null;
  inertia: { value: number[][]; source: string } | null;
  expected: { omega_rpm: number; speed_mm_s: number; moved: boolean } | null;
};
type ViewerJoint = { id: string; type: string; part_a: string; part_b: string; dof: number | null; diagnostics: string[] };
type Viewer = { design_id: string; revision: number; parts: Record<string, ViewerPart>; joints: ViewerJoint[]; validation: Validation };

const ROLES = ['frame', 'housing', 'shaft', 'gear', 'crank', 'rod', 'link', 'slider', 'rocker', 'arm', 'pin', 'other'];
const MATERIALS = ['pla', 'petg', 'abs', 'asa', 'nylon', 'pom', 'tpu', 'polycarbonate', 'steel', 'aluminium', 'brass'];
const JOINT_TYPES = ['revolute', 'prismatic', 'fixed', 'cylindrical', 'spherical'];
const SOURCE_TEXT: Record<string, string> = {
  user: 'bạn nhập',
  imported_cad: 'từ CAD',
  geometry: 'tính từ hình học',
  material_database: 'sổ tay vật liệu',
  assumption: 'giả định',
  design: 'thiết kế khai báo',
  unknown: 'chưa biết',
};
const SEVERITY = { error: 'error', warning: 'warning', info: 'success' } as const;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A small line of the picked component's recent values */
function Sparkline({ values, unit }: { values: number[]; unit: string }) {
  if (values.length < 2) return null;
  const W = 220, H = 36;
  const lo = Math.min(...values), hi = Math.max(...values);
  // Solver noise (a shaft's centre moving 1e-16 mm) is drawn flat, not as motion
  const span = hi - lo > 1e-6 ? hi - lo : Infinity;
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * W).toFixed(1)},${(H - 2 - ((v - lo) / span) * (H - 4)).toFixed(1)}`).join('');
  return (
    <Tooltip title={`${formatNumber(lo)}–${formatNumber(hi)} ${unit}`}>
      <svg width={W} height={H} role="img" aria-label={`Diễn biến (${unit})`} style={{ display: 'block' }}>
        <path d={path} fill="none" stroke="#22c55e" strokeWidth={1.5} />
      </svg>
    </Tooltip>
  );
}

/** mm and mm/s as read: below a nanometre is solver noise around zero */
const shownMm = (v: number) => formatNumber(Math.abs(v) < 1e-6 ? 0 : v);

/** The picked component: its data and provenance, its joints, and how it moves now (from the solver's state) */
function PartInspector({ pick, viewer, runParts }: { pick: LivePick; viewer: Viewer; runParts: Record<string, { steady_rpm?: number; max_speed_mm_s?: number }> | null }) {
  const part = pick.part ? viewer.parts[pick.part] : Object.values(viewer.parts).find((p) => p.body === pick.body);
  const history = useRef<{ key: string; t: number; speed: number[]; disp: number[] }>({ key: '', t: -1, speed: [], disp: [] });
  if (!part) return null;
  const body = pick.scene.bodies.find((b) => b.id === part.body);
  const pose = pick.state.bodies[part.body];
  const sel = pick.state.selected?.body === part.body ? pick.state.selected : null;
  const motion = body?.initial && pose ? partMotion(part.point_mm, body.initial, pose, sel?.velocity ?? null, sel?.angular_velocity ?? null) : null;
  const h = history.current;
  if (h.key !== part.id || pick.state.t < h.t) Object.assign(h, { key: part.id, t: -1, speed: [], disp: [] });
  if (motion && pick.state.t > h.t) {
    h.t = pick.state.t;
    if (motion.speed_mm_s !== null) h.speed = [...h.speed, motion.speed_mm_s].slice(-120);
    h.disp = [...h.disp, motion.displacement_mm].slice(-120);
  }
  const joints = viewer.joints.filter((j) => part.joints.includes(j.id));
  const diag = part.inertia ? part.inertia.value.map((row, i) => row[i]) : null;
  const run = runParts?.[part.id];
  return (
    <Descriptions size="small" column={1} bordered title={`🔩 ${part.name || part.id}`}>
      <Descriptions.Item label="Mã">{part.id}{part.fixed && <Tag style={{ marginLeft: 6 }}>cố định</Tag>}</Descriptions.Item>
      <Descriptions.Item label="Hình học">{part.geometry?.type ?? 'mesh'} · nhóm cứng {part.body}</Descriptions.Item>
      <Descriptions.Item label="Vật liệu">{part.material ?? <Tag color="red">chưa biết</Tag>}</Descriptions.Item>
      <Descriptions.Item label="Khối lượng">
        {part.mass ? `${formatNumber(part.mass.value * 1000)} g (${SOURCE_TEXT[part.mass.source] ?? part.mass.source})` : part.fixed ? '— (cố định)' : <Tag color="red">chưa biết</Tag>}
      </Descriptions.Item>
      {diag && <Descriptions.Item label="Quán tính (kg·mm²)">{diag.map((v) => formatNumber(v)).join(' · ')}</Descriptions.Item>}
      <Descriptions.Item label="Khớp">
        {joints.length ? joints.map((j) => <Tag key={j.id} color={j.diagnostics.length ? 'warning' : 'default'}>{j.id} · {j.type}</Tag>) : '—'}
      </Descriptions.Item>
      {motion && (
        <>
          <Descriptions.Item label="Dịch chuyển tâm">{shownMm(motion.displacement_mm)} mm<Sparkline values={h.disp} unit="mm" /></Descriptions.Item>
          <Descriptions.Item label="Vận tốc tâm">
            {motion.speed_mm_s === null ? 'chọn chi tiết để solver báo vận tốc' : `${shownMm(motion.speed_mm_s)} mm/s`}
            <Sparkline values={h.speed} unit="mm/s" />
          </Descriptions.Item>
          {motion.rpm !== null && (
            <Descriptions.Item label="Tốc độ quay">
              {formatNumber(motion.rpm)} vòng/phút{part.expected?.moved ? ` (động học: ${formatNumber(part.expected.omega_rpm)})` : ''}
            </Descriptions.Item>
          )}
        </>
      )}
      {run && (
        <Descriptions.Item label="Lần chạy ghi kết quả">
          ổn định {formatNumber(run.steady_rpm ?? NaN)} vòng/phút · vận tốc tâm max {formatNumber(run.max_speed_mm_s ?? NaN)} mm/s
        </Descriptions.Item>
      )}
    </Descriptions>
  );
}

/** The physical setup of the current revision: parts, joints (declared, confirmed, suggested), motors, settings */
function SetupEditor({ status, input, onSaved }: { status: Status; input: DesignInput; onSaved: () => void }) {
  const { message } = App.useApp();
  const [parts, setParts] = useState<Record<string, InputPart>>({});
  const [joints, setJoints] = useState<InputJoint[]>(input.joints);
  const [motors, setMotors] = useState<InputMotor[]>(input.motors);
  const [simulation, setSimulation] = useState(input.simulation ?? {});
  const [newJoint, setNewJoint] = useState<Partial<InputJoint>>({ type: 'revolute' });
  const [saving, setSaving] = useState(false);
  const ids = input.parts.map((p) => p.id);
  const part = (id: string) => ({ ...input.parts.find((p) => p.id === id)!, ...parts[id] });
  const edit = (id: string, change: Partial<InputPart>) => setParts((all) => ({ ...all, [id]: { ...all[id], ...change } }));

  const save = async () => {
    setSaving(true);
    try {
      const removed = { joints: input.joints.filter((j) => !joints.some((k) => k.id === j.id)).map((j) => j.id), motors: input.motors.filter((m) => !motors.some((k) => k.id === m.id)).map((m) => m.id) };
      const changes = {
        parts: Object.entries(parts).map(([id, change]) => ({ ...change, id })),
        joints: joints.filter((j) => !input.joints.some((k) => k.id === j.id)),
        motors: motors.filter((m) => JSON.stringify(m) !== JSON.stringify(input.motors.find((k) => k.id === m.id))),
        simulation,
        remove: removed,
      };
      await mech(`designs/${status.design_id}`, { changes, note: 'Sửa cấu hình mô phỏng trên dashboard' });
      message.success('Đã lưu thành bản mới và kiểm tra lại.');
      onSaved();
    } catch (err) {
      message.error(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const addJoint = (joint: InputJoint) => setJoints((all) => [...all.filter((j) => j.id !== joint.id), joint]);
  const rotary = joints.filter((j) => ['revolute', 'cylindrical'].includes(j.type));
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        scroll={{ x: 760 }}
        dataSource={ids.map(part)}
        columns={[
          { title: 'Chi tiết', dataIndex: 'id', render: (id: string, p: InputPart) => p.name || id },
          { title: 'Vai trò', width: 120, render: (_: unknown, p: InputPart) => <Select size="small" style={{ width: 110 }} value={p.role ?? 'other'} options={ROLES.map((r) => ({ value: r, label: r }))} onChange={(role) => edit(p.id, { role })} /> },
          { title: 'Cố định', width: 70, render: (_: unknown, p: InputPart) => <Checkbox checked={Boolean(p.fixed)} onChange={(e) => edit(p.id, { fixed: e.target.checked })} /> },
          {
            title: 'Vật liệu',
            width: 140,
            render: (_: unknown, p: InputPart) => (
              <Select size="small" allowClear style={{ width: 130 }} placeholder="chưa biết" value={typeof p.material === 'string' ? p.material : undefined} options={MATERIALS.map((m) => ({ value: m, label: m }))} onChange={(material) => edit(p.id, { material: material ?? null })} />
            ),
          },
          {
            title: <Tooltip title="Để trống: tính từ thể tích × khối lượng riêng của vật liệu (chi tiết in có độ đặc thấp hơn: nên cân thật)">Khối lượng (kg)</Tooltip>,
            width: 120,
            render: (_: unknown, p: InputPart) => <InputNumber size="small" min={0} step={0.01} style={{ width: 110 }} value={typeof p.mass === 'number' ? p.mass : null} onChange={(mass) => edit(p.id, { mass })} />,
          },
          {
            title: 'Va chạm / ma sát',
            width: 160,
            render: (_: unknown, p: InputPart) => (
              <Space size={4}>
                <Checkbox checked={Boolean(p.collision)} onChange={(e) => edit(p.id, { collision: e.target.checked })} />
                <InputNumber size="small" min={0} max={2} step={0.05} style={{ width: 90 }} placeholder="μ" disabled={!p.collision} value={typeof p.friction === 'number' ? p.friction : null} onChange={(friction) => edit(p.id, { friction })} />
              </Space>
            ),
          },
        ]}
      />
      <Typography.Text strong>Khớp</Typography.Text>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={joints}
        locale={{ emptyText: 'Chưa có khớp nào' }}
        columns={[
          { title: 'Khớp', dataIndex: 'id' },
          { title: 'Loại', dataIndex: 'type', width: 100 },
          { title: 'Nối', render: (_: unknown, j: InputJoint) => `${j.part_a} ↔ ${j.part_b}` },
          { title: 'Nguồn', width: 120, render: (_: unknown, j: InputJoint) => <Tag>{j.source === 'design' ? 'thiết kế khai báo' : j.confidence === 'confirmed' ? 'bạn xác nhận' : SOURCE_TEXT[j.source ?? 'user'] ?? j.source}</Tag> },
          { title: '', width: 60, render: (_: unknown, j: InputJoint) => <Button size="small" type="text" danger onClick={() => { setJoints((all) => all.filter((k) => k.id !== j.id)); setMotors((all) => all.filter((m) => m.joint !== j.id)); }}>Bỏ</Button> },
        ]}
      />
      {(status.hypotheses ?? []).length > 0 && (
        <Alert
          type="info"
          showIcon
          title="Hình học gợi ý (chưa dùng cho đến khi bạn xác nhận)"
          description={
            <Space direction="vertical" size={4}>
              {(status.hypotheses ?? []).map((h) => (
                <Flex key={h.id} gap={8} align="center" wrap>
                  <Tag color={h.confidence === 'probable' ? 'blue' : 'default'}>{h.confidence === 'probable' ? 'có thể' : 'chưa rõ'}</Tag>
                  <span style={{ fontSize: 12 }}>{h.reason}</span>
                  {h.kind === 'joint' && h.joint && !joints.some((j) => j.id === h.joint!.id) && (
                    <Button size="small" onClick={() => addJoint({ ...h.joint!, source: 'user', confidence: 'confirmed' })}>Xác nhận khớp {h.joint.type}</Button>
                  )}
                </Flex>
              ))}
            </Space>
          }
        />
      )}
      <Space.Compact>
        <Select size="small" style={{ width: 110 }} value={newJoint.type} options={JOINT_TYPES.map((t) => ({ value: t, label: t }))} onChange={(type) => setNewJoint({ ...newJoint, type })} />
        <Select size="small" style={{ width: 120 }} placeholder="chi tiết A" value={newJoint.part_a} options={ids.map((id) => ({ value: id, label: id }))} onChange={(part_a) => setNewJoint({ ...newJoint, part_a })} />
        <Select size="small" style={{ width: 120 }} placeholder="chi tiết B" value={newJoint.part_b} options={ids.map((id) => ({ value: id, label: id }))} onChange={(part_b) => setNewJoint({ ...newJoint, part_b })} />
        {(['position', 'axis'] as const).map((key) =>
          [0, 1, 2].map((k) => (
            <InputNumber
              key={`${key}${k}`}
              size="small"
              style={{ width: 64 }}
              placeholder={`${key === 'position' ? 'P' : 'A'}${'xyz'[k]}`}
              value={newJoint[key]?.[k]}
              onChange={(v) => {
                const next = [...(newJoint[key] ?? [null, null, null])] as Vec;
                next[k] = v as number;
                setNewJoint({ ...newJoint, [key]: next });
              }}
            />
          ))
        )}
        <Button
          size="small"
          icon={<PlusOutlined />}
          disabled={!newJoint.part_a || !newJoint.part_b || newJoint.part_a === newJoint.part_b || (newJoint.type !== 'fixed' && (!newJoint.position?.every((v) => typeof v === 'number') || !newJoint.axis?.every((v) => typeof v === 'number')))}
          onClick={() => {
            addJoint({ id: `${newJoint.part_a}_${newJoint.part_b}_${newJoint.type}`, type: newJoint.type!, part_a: newJoint.part_a!, part_b: newJoint.part_b!, ...(newJoint.position && { position: newJoint.position }), ...(newJoint.axis && { axis: newJoint.axis }), source: 'user', confidence: 'confirmed' });
            setNewJoint({ type: newJoint.type });
          }}
        >
          Thêm khớp
        </Button>
      </Space.Compact>
      <Typography.Text strong>Động cơ</Typography.Text>
      {rotary.length === 0 ? (
        <Typography.Text type="secondary">Cần một khớp quay để gắn động cơ.</Typography.Text>
      ) : (
        rotary.map((j) => {
          const m = motors.find((x) => x.joint === j.id);
          return (
            <Space key={j.id} wrap>
              <Checkbox
                checked={Boolean(m)}
                onChange={(e) => setMotors((all) => (e.target.checked ? [...all, { id: `motor_${j.id}`, joint: j.id }] : all.filter((x) => x.joint !== j.id)))}
              >
                Động cơ ở {j.id}
              </Checkbox>
              {m && (
                <>
                  <InputNumber size="small" style={{ width: 130 }} placeholder="vòng/phút" value={m.speed_rpm ?? null} onChange={(speed_rpm) => setMotors((all) => all.map((x) => (x.id === m.id ? { ...x, speed_rpm: speed_rpm ?? undefined } : x)))} suffix="v/ph" />
                  <InputNumber size="small" style={{ width: 120 }} min={0} step={0.05} placeholder="tăng tốc" value={m.ramp_s ?? null} onChange={(ramp_s) => setMotors((all) => all.map((x) => (x.id === m.id ? { ...x, ramp_s: ramp_s ?? undefined } : x)))} suffix="s" />
                </>
              )}
            </Space>
          );
        })
      )}
      <Typography.Text strong>Mô phỏng</Typography.Text>
      <Space wrap>
        <InputNumber size="small" style={{ width: 150 }} min={0.00001} max={0.05} step={0.0005} value={simulation.time_step ?? null} placeholder="bước (s)" onChange={(time_step) => setSimulation({ ...simulation, time_step: time_step ?? undefined })} addonBefore="Bước" />
        <InputNumber size="small" style={{ width: 150 }} min={0.01} max={600} value={simulation.duration ?? null} placeholder="thời gian (s)" onChange={(duration) => setSimulation({ ...simulation, duration: duration ?? undefined })} addonBefore="Dài" />
        <Checkbox checked={!simulation.gravity || simulation.gravity[2] !== 0} onChange={(e) => setSimulation({ ...simulation, gravity: e.target.checked ? [0, 0, -9.81] : [0, 0, 0] })}>Trọng lực −Z</Checkbox>
      </Space>
      <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>Lưu thành bản mới và kiểm tra</Button>
    </Space>
  );
}

/** `name`: what the task panel calls its setup while it runs */
export function ModelSim({ jobId, modelId: givenModelId, name }: { jobId?: string; modelId?: string; name?: string }) {
  const { message } = App.useApp();
  const modelId = givenModelId ?? `job-${jobId}`;
  const [status, setStatus] = useState<Status | null>(null);
  const [input, setInput] = useState<DesignInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [run, setRun] = useState<string | null>(null);
  const [runParts, setRunParts] = useState<Record<string, { steady_rpm?: number; max_speed_mm_s?: number }> | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await mech<Status>(`models/${modelId}`);
      setStatus(s);
      setError(null);
      if (s.design_id) {
        const d = await mech<{ input: DesignInput }>(`designs/${s.design_id}?revision=${s.revision}`);
        setInput({ parts: d.input.parts ?? [], joints: d.input.joints ?? [], motors: d.input.motors ?? [], simulation: d.input.simulation });
      }
      return s;
    } catch (err) {
      setError(errorText(err));
      return null;
    }
  }, [modelId]);
  useEffect(() => {
    load();
  }, [load]);

  // A setup or a recorded run going on (also one started before the page was opened again): read until it ends
  const settingUp = Boolean(status?.setup_task?.running);
  const recording = status?.runs?.some((r) => r.current && isSimBusy(r.state)) ?? false;
  const watchedSetup = useRef(false);
  useEffect(() => {
    if (!settingUp && !recording) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [settingUp, recording, load]);
  useEffect(() => {
    if (settingUp) watchedSetup.current = true;
    else if (watchedSetup.current) {
      watchedSetup.current = false;
      if (status?.setup_task?.error) message.error(status.setup_task.error);
    }
  }, [settingUp, status?.setup_task?.error, message]);

  // Results of the latest finished run of this revision, per part, for the inspector
  const lastRun = useMemo(() => [...(status?.runs ?? [])].reverse().find((r) => r.current && r.state === 'completed') ?? null, [status]);
  useEffect(() => {
    if (!lastRun || !status?.design_id) return setRunParts(null);
    mech<{ parts?: Record<string, { steady_rpm?: number; max_speed_mm_s?: number }> }>(`designs/${status.design_id}/runs/${lastRun.sim_id}`)
      .then((r) => setRunParts(r.parts ?? null))
      .catch(() => setRunParts(null));
  }, [lastRun, status?.design_id]);

  const step = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      message.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const setup = () => step('setup', async () => {
    await mech('models/setup', { ...(jobId ? { job_id: jobId } : { model_id: modelId }), ...(name && { name }) });
    await load();
  });
  const simulate = () => step('live', async () => {
    const data = await mech<Viewer & { session_id: string }>(`designs/${status!.design_id}/live`, { revision: status!.revision });
    setViewer({ design_id: data.design_id, revision: data.revision, parts: data.parts, joints: data.joints, validation: data.validation });
    setSession(data.session_id);
    await load();
  });
  const record = () => step('run', async () => {
    const data = await mech<{ sim_id: string }>(`designs/${status!.design_id}/simulate`, { revision: status!.revision, wait_s: 0 });
    setRun(data.sim_id);
    message.success('Đã xếp lần chạy ghi kết quả (Chrono): kết quả và video Blender ở bên dưới khi xong.');
    await load();
  });
  // A session already open for the current revision: reopened with its part data
  useEffect(() => {
    if (!status?.live || session || !status.design_id) return;
    mech<Viewer>(`designs/${status.design_id}/viewer?revision=${status.revision}`)
      .then((v) => {
        setViewer(v);
        setSession(status.live!.session_id);
      })
      .catch(() => {});
  }, [status, session]);

  if (error) return <Alert type="warning" showIcon title={error} action={<Button size="small" onClick={load}>Thử lại</Button>} />;
  if (!status) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Đang đọc mô hình…" />;
  const shown = MODEL_SIM_STATES[status.state] ?? { color: 'default', text: status.state };
  const v = status.validation;
  const stale = viewer && viewer.revision !== status.revision;
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Flex gap={8} wrap align="center">
        <Tag color={shown.color} style={{ fontSize: 13 }}>{shown.text}</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {status.model_id}
          {status.model_version ? ` · mô hình v${status.model_version}` : ''}
          {status.revision ? ` · cấu hình r${status.revision}` : ''}
          {v?.dof ? ` · ${v.dof.mobility} bậc tự do` : ''}
        </Typography.Text>
        <span style={{ flex: 1 }} />
        <Button size="small" icon={<ReloadOutlined />} onClick={load} title="Đọc lại trạng thái" />
        {(status.state === 'NOT_CONFIGURED' || status.state === 'NEEDS_VALIDATION') && (
          <Button size="small" type="primary" loading={busy === 'setup' || settingUp} onClick={setup}>
            {status.state === 'NOT_CONFIGURED' ? 'Chuẩn bị mô phỏng' : `Cập nhật cấu hình cho v${status.model_version} và kiểm tra`}
          </Button>
        )}
        {status.design_id && (
          <>
            <Button size="small" type="primary" icon={<CaretRightOutlined />} loading={busy === 'live'} disabled={!CAN_SIMULATE.has(status.state)} onClick={simulate}>
              Simulate
            </Button>
            <Button size="small" icon={<ExperimentOutlined />} loading={busy === 'run'} disabled={!CAN_SIMULATE.has(status.state)} onClick={record} title="Chạy hết thời gian đã đặt, ghi kết quả từng chi tiết, kiểm tra với lý thuyết; xem lại bằng Blender">
              Chạy ghi kết quả
            </Button>
          </>
        )}
      </Flex>
      {status.reason && <Alert type={status.state === 'INVALID' ? 'error' : 'warning'} showIcon title={status.reason} />}
      {jobId && status.components.length > 1 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Mô phỏng các chi tiết ở vị trí lắp ráp (ảnh «Lắp ráp» trên thẻ mẫu), không phải cách bày ra để in («Bày in»).
        </Typography.Text>
      )}
      {status.components.length === 1 && (
        <Alert type="info" showIcon title="Mô hình chỉ có một khối" description="Không có chi tiết riêng để chuyển động với nhau: chỉ mô phỏng được nó như một vật rắn (cố định, rơi, va chạm). Muốn cơ cấu chuyển động, yêu cầu Claude dựng lại với các chi tiết tách rời (components)." />
      )}

      {session && viewer && (
        <>
          {stale && <Alert type="warning" showIcon title={`Đang xem cấu hình r${viewer.revision}, cấu hình mới là r${status.revision}: bấm Simulate để chạy bản mới.`} />}
          <SimLive
            key={session}
            sessionId={session}
            title={<>⚙️ {status.model_id} · r{viewer.revision}</>}
            onClose={() => {
              setSession(null);
              load();
            }}
            inspect={(pick) => <PartInspector pick={pick} viewer={viewer} runParts={stale ? null : runParts} />}
          />
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={viewer.joints}
            title={() => 'Khớp của mô hình đang chạy'}
            columns={[
              { title: 'Khớp', dataIndex: 'id' },
              { title: 'Loại', dataIndex: 'type' },
              { title: 'Nối', render: (_: unknown, j: ViewerJoint) => `${j.part_a} ↔ ${j.part_b}` },
              { title: 'Bậc tự do của khớp', dataIndex: 'dof', render: (d: number | null) => d ?? '—' },
              { title: 'Kiểm tra', render: (_: unknown, j: ViewerJoint) => (j.diagnostics.length ? j.diagnostics.map((c) => <Tag key={c} color="warning">{c}</Tag>) : <Tag color="success">ổn</Tag>) },
            ]}
          />
        </>
      )}

      {v && (
        <Collapse
          size="small"
          defaultActiveKey={status.state === 'INVALID' ? ['check', 'setup'] : []}
          items={[
            {
              key: 'check',
              label: <Space>Kiểm tra lắp ráp {MECH_STATUS[v.status] && <Tag color={MECH_STATUS[v.status].color}>{MECH_STATUS[v.status].text}</Tag>}</Space>,
              children: (
                <Space direction="vertical" style={{ width: '100%' }} size={6}>
                  {v.diagnostics.map((d, i) => (
                    <Alert key={`${d.code}-${i}`} type={SEVERITY[d.severity]} showIcon title={<><Typography.Text code>{d.code}</Typography.Text> {d.message}</>} />
                  ))}
                  {v.missing.map((m) => (
                    <Alert key={m.path} type="warning" showIcon title={<>Thiếu <Typography.Text code>{m.path}</Typography.Text>: {m.message}</>} />
                  ))}
                  {v.assumptions.map((a) => (
                    <Alert key={a.path} type="info" title={<>Giả định <Typography.Text code>{a.path}</Typography.Text>: {a.message}</>} />
                  ))}
                </Space>
              ),
            },
            ...(input
              ? [{ key: 'setup', label: `Cấu hình vật lý (r${status.revision})`, children: <SetupEditor key={status.revision} status={status} input={input} onSaved={load} /> }]
              : []),
            ...((status.runs ?? []).length
              ? [
                  {
                    key: 'runs',
                    label: `Các lần chạy ghi kết quả (${status.runs!.length})`,
                    children: (
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <Select
                          size="small"
                          style={{ width: 360 }}
                          value={run ?? lastRun?.sim_id ?? status.runs!.at(-1)!.sim_id}
                          onChange={setRun}
                          options={status.runs!.map((r) => ({ value: r.sim_id, label: `${r.sim_id} · r${r.revision}${r.current ? '' : ' (bản trước)'} · ${r.state}` }))}
                        />
                        <RunResults
                          key={run ?? lastRun?.sim_id ?? status.runs!.at(-1)!.sim_id}
                          designId={status.design_id!}
                          simId={run ?? lastRun?.sim_id ?? status.runs!.at(-1)!.sim_id}
                          onOpenRun={() => message.info('Đồ thị và video Blender của lần chạy ở tab ⚙️ Mô phỏng.')}
                        />
                      </Space>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
    </Space>
  );
}

const IMPORTABLE = '.stl,.3mf,.obj,.ply,.glb,.gltf';

/** Imported 3D models (workflow B): a file read into an engineering model (its components, names and places as the
 * file has them), then simulated as it is, with ModelSim */
export function ImportedModels() {
  const { message } = App.useApp();
  const [models, setModels] = useState<{ model_id: string; version: number; name: string; components: number }[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(() => {
    fetch('/api/eng/models', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => setModels(data?.success ? data.models.filter((m: { model_id: string }) => !m.model_id.startsWith('job-')) : []))
      .catch(() => setModels([]));
  }, []);
  useEffect(load, [load]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const res = await fetch('/api/eng/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: [{ filename: file.name, data_base64: btoa(binary) }], name: file.name.replace(/\.[^.]+$/, '') }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || `HTTP ${res.status}`);
      message.success(`Đã nhập ${file.name}: ${data.model.components.length} chi tiết.`);
      load();
      setPicked(data.model.model_id);
    } catch (err) {
      message.error(`Không nhập được: ${errorText(err)}`);
    } finally {
      setUploading(false);
    }
    return false;
  };

  return (
    <Card
      size="small"
      title="📦 Mô hình 3D đã nhập"
      extra={
        <Space>
          <Upload accept={IMPORTABLE} showUploadList={false} beforeUpload={upload}>
            <Button size="small" icon={<UploadOutlined />} loading={uploading}>Nhập mô hình</Button>
          </Upload>
          <Button size="small" icon={<ReloadOutlined />} onClick={load} title="Tải lại" />
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        STL, 3MF, OBJ, PLY, GLB/glTF: mỗi object/node là một chi tiết, giữ tên và vị trí như trong file. STEP: đổi sang STL qua Claude (MCP) trước. Một khối
        lưới duy nhất không được coi là đã nhận ra các chi tiết.
      </Typography.Paragraph>
      <Select
        style={{ width: '100%', marginBottom: 12 }}
        placeholder={models?.length ? 'Chọn mô hình để mô phỏng' : 'Chưa có mô hình nhập nào'}
        value={picked}
        onChange={setPicked}
        options={(models ?? []).map((m) => ({ value: m.model_id, label: `${m.name} · v${m.version} · ${m.components} chi tiết` }))}
      />
      {picked && <ModelSim key={picked} modelId={picked} />}
    </Card>
  );
}
