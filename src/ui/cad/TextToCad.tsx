'use client';

import { CheckCircleFilled, CloseCircleFilled, DownloadOutlined, DownOutlined, InfoCircleFilled, ReloadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Dropdown, Empty, Flex, Modal, Space, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { fileUrl } from '../cad';
import type { CadJob } from './CadJob';

/**
 * What text-to-cad (docs/text-to-cad.md) adds to a technical model's card: its CAD Viewer, an engineering drawing,
 * a DfAM check and the files Claude made with text-to-cad's other skills.
 */

const POLL_MS = 3000;

type TaskField = 'drawing_task' | 'dfam_task';

/**
 * POST `action` on the job, which runs in the gateway and goes on when the page closes; while its task (`field`)
 * runs, the job is read again until it is done. Returns [running, start, the job as last read]
 */
function useJobTask(given: CadJob, action: 'drawing' | 'dfam', field: TaskField) {
  const { message } = App.useApp();
  const [asked, setAsked] = useState(false);
  // The card's own copy is read again only while the model is being made: the answers here are newer
  const [read, setRead] = useState<CadJob | null>(null);
  const job = read && read.id === given.id && (read.finished_at ?? '') >= (given.finished_at ?? '') ? read : given;
  const onJob = setRead;
  const running = asked || Boolean(job[field]?.running);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/cad/jobs/${encodeURIComponent(job.id)}`, { cache: 'no-store' }).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      const task = data?.job?.[field] as CadJob[TaskField];
      if (!task || task.running) return;
      setAsked(false);
      if (task.error) message.error(task.error);
      onJob?.(data.job);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, job.id, field, message]);

  const start = async () => {
    setAsked(true);
    let goesOn = false;
    try {
      const res = await fetch(`/api/cad/jobs/${encodeURIComponent(job.id)}/${action}`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (data?.job) onJob?.(data.job);
      if (!res.ok || !data?.success) {
        message.error(data?.message ?? data?.drawing?.error ?? `Không chạy được (HTTP ${res.status}).`);
        return;
      }
      goesOn = res.status === 202;
    } finally {
      if (!goesOn) setAsked(false);
    }
  };
  return [running, start, job] as const;
}

/** "📐 Bản vẽ": the engineering drawing (cadgen.eng_drawing), made on the first click and opened after */
export function DrawingButton(props: { job: CadJob }) {
  const [running, start, job] = useJobTask(props.job, 'drawing', 'drawing_task');
  if (!job.files?.drawing || running) {
    return (
      <Button size="small" loading={running} onClick={start} title="Bản vẽ kỹ thuật PDF khổ A3: 3 hình chiếu, isometric, nét khuất, kích thước bao (text-to-cad)">
        📐 Vẽ bản vẽ
      </Button>
    );
  }
  return (
    <Space.Compact>
      <Button size="small" href={`${fileUrl(job, 'drawing.pdf')}&d=${encodeURIComponent(job.drawing_task?.finished_at ?? '')}`} target="_blank" rel="noopener noreferrer">
        📐 Bản vẽ
      </Button>
      <Button size="small" icon={<ReloadOutlined />} onClick={start} title="Vẽ lại từ mô hình hiện tại" />
    </Space.Compact>
  );
}

const STATUS_ICONS = {
  pass: <CheckCircleFilled style={{ color: '#52c41a' }} />,
  fail: <CloseCircleFilled style={{ color: '#ff4d4f' }} />,
  info: <InfoCircleFilled style={{ color: '#1677ff' }} />,
};

/** "🧪 DfAM": text-to-cad's printability check of what is printed, against FDM limits */
export function DfamButton(props: { job: CadJob }) {
  const [open, setOpen] = useState(false);
  const [running, start, job] = useJobTask(props.job, 'dfam', 'dfam_task');
  const dfam = job.dfam;
  const fails = dfam?.findings?.filter((f) => f.status === 'fail').length ?? 0;
  return (
    <>
      <Button
        size="small"
        loading={running && !open}
        onClick={() => {
          setOpen(true);
          if (!dfam && !running) void start();
        }}
        title="Kiểm tra in 3D (DfAM, text-to-cad): lưới kín, thành mỏng, phần nhô cần support, hướng đặt ít support hơn"
      >
        🧪 DfAM{dfam?.ok ? (fails ? ` · ${fails} lỗi` : ' · đạt') : ''}
      </Button>
      <Modal open={open} onCancel={() => setOpen(false)} footer={null} width={640} title={`Kiểm tra DfAM · ${job.title || job.id}`}>
        {running ? (
          <Flex vertical align="center" gap={8} style={{ padding: 32 }}>
            <Spin />
            <Typography.Text type="secondary">Đang đo độ dày thành và phần nhô (vài chục giây với lưới lớn)…</Typography.Text>
          </Flex>
        ) : !dfam ? (
          <Empty description="Chưa kiểm tra">
            <Button onClick={start}>Kiểm tra</Button>
          </Empty>
        ) : !dfam.ok ? (
          <Alert type="error" showIcon title={dfam.error ?? 'Không kiểm tra được.'} action={<Button size="small" onClick={start}>Thử lại</Button>} />
        ) : (
          <Flex vertical gap={10}>
            {dfam.partial && <Alert type="warning" showIcon title="Có phần chưa đo được: các mục đó không được tính là đạt." />}
            {dfam.findings?.map((f, i) => (
              <Flex key={i} gap={8} align="start">
                {STATUS_ICONS[f.status]}
                <div>
                  <Typography.Text strong>{f.title}</Typography.Text>
                  <div>
                    <Typography.Text type="secondary">{f.detail}</Typography.Text>
                  </div>
                </div>
              </Flex>
            ))}
            <Flex justify="space-between" align="center">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {dfam.process} · {dfam.source}
              </Typography.Text>
              <Space>
                <Button size="small" href={fileUrl(job, 'dfam.json')} target="_blank" rel="noopener noreferrer">
                  Số đo
                </Button>
                <Button size="small" icon={<ReloadOutlined />} onClick={start}>
                  Kiểm tra lại
                </Button>
              </Space>
            </Flex>
          </Flex>
        )}
      </Modal>
    </>
  );
}

/**
 * "🧭 CAD Viewer": text-to-cad's own viewer, on the gateway's viewer port (CAD_VIEWER_PORT) of the host the dashboard
 * was opened from: the exact model (pick faces and edges, measure, section, explode), following every rebuild. The
 * tab is opened at the click, before the link comes back, so the browser does not take it for a pop-up
 */
/** What the CAD Viewer opens of a model with a circuit (POST /api/cad/jobs/:id/viewer {view}, cad/build.py split_views) */
export const VIEWER_VIEWS = [
  { key: 'all', label: 'Toàn bộ', title: 'Cả mô hình: vỏ trong suốt, module và dây bên trong' },
  { key: 'electronics', label: 'Chỉ mạch điện', title: 'Chỉ module, dây và mạch mua sẵn, đúng chỗ của chúng trong vỏ' },
  { key: 'case', label: 'Chỉ vỏ', title: 'Chỉ các chi tiết in, không có linh kiện điện tử' },
] as const;
export type ViewerView = (typeof VIEWER_VIEWS)[number]['key'];

/** Whether a job has its electronics and its case on their own (a model with a circuit, built since split_views) */
export const hasSplitViews = (job: CadJob) => Boolean(job.files?.electronics || job.files?.case);

/**
 * "🧭 CAD Viewer": text-to-cad's CAD Viewer page of the model (`view`: all of it, or with a circuit its electronics or
 * its case alone). On a model with a circuit and no `view` given, a menu beside it opens either half on its own.
 */
export function CadViewerButton({ job, view, label }: { job: CadJob; view?: ViewerView; label?: string }) {
  const { message } = App.useApp();
  const [opening, setOpening] = useState<ViewerView | null>(null);
  const open = async (which: ViewerView) => {
    const tab = window.open('', '_blank');
    setOpening(which);
    try {
      const res = await fetch(`/api/cad/jobs/${encodeURIComponent(job.id)}/viewer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ view: which }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        tab?.close();
        message.error(data?.message ?? `Không mở được CAD Viewer (HTTP ${res.status}).`);
        return;
      }
      const url = `${data.secure ? 'https' : 'http'}://${window.location.hostname}:${data.port}${data.path}`;
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } finally {
      setOpening(null);
    }
  };
  const title = 'Mở trong CAD Viewer của text-to-cad: chọn mặt/cạnh, đo, cắt, tách rời; tự cập nhật khi mô hình dựng lại';
  if (view || !hasSplitViews(job)) {
    const which = view ?? 'all';
    return (
      <Button size="small" loading={opening === which} onClick={() => open(which)} title={view ? VIEWER_VIEWS.find((v) => v.key === view)?.title : title}>
        {label ?? '🧭 CAD Viewer'}
      </Button>
    );
  }
  return (
    <Space.Compact size="small">
      <Button size="small" loading={opening === 'all'} onClick={() => open('all')} title={title}>
        🧭 CAD Viewer
      </Button>
      <Dropdown
        trigger={['click']}
        menu={{
          items: VIEWER_VIEWS.map((v) => ({ key: v.key, label: v.label, title: v.title, disabled: v.key !== 'all' && !job.files?.[v.key] })),
          onClick: ({ key }) => open(key as ViewerView),
        }}
      >
        <Button size="small" icon={<DownOutlined />} loading={opening !== null && opening !== 'all'} title="Xem toàn bộ, chỉ mạch điện hoặc chỉ vỏ" />
      </Dropdown>
    </Space.Compact>
  );
}

/** The files Claude made with text-to-cad's other skills (out/exports/), each a download */
export function ExportLinks({ job }: { job: CadJob }) {
  if (!job.exports?.length) return null;
  return (
    <>
      {job.exports.map((name) => (
        <Button
          key={name}
          size="small"
          icon={<DownloadOutlined />}
          href={`/api/cad/jobs/${encodeURIComponent(job.id)}/exports/${encodeURIComponent(name)}?download=1`}
          title="File Claude làm thêm bằng skill text-to-cad"
        >
          {name}
        </Button>
      ))}
    </>
  );
}
