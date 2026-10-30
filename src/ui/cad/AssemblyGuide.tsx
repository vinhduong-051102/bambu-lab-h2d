'use client';

import { Alert, App, Button, Empty, Flex, Image, Modal, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { fileUrl } from '../cad';
import type { CadJob } from './CadJob';

/** out/guide/guide.json (cad/assembly_guide.py): the steps, each with its picture, and the video */
interface Guide {
  order: 'model' | 'mechanism';
  steps: { n: number; parts: string[]; text: string; given: boolean; onto: string | null; image: string; joints: { id?: string; type?: string; part: string }[] }[];
  video: string | null;
  video_error: string | null;
  video_seconds: number;
}

const JOINT_LABELS: Record<string, string> = {
  revolute: 'khớp quay',
  cylindrical: 'khớp trụ',
  prismatic: 'khớp trượt',
  spherical: 'khớp cầu',
  fixed: 'cố định',
};

const POLL_MS = 3000;

const pictureUrl = (job: CadJob, name: string) =>
  `/api/cad/jobs/${encodeURIComponent(job.id)}/guide/${name}?v=${encodeURIComponent(job.finished_at ?? job.state)}`;

/** The guide itself: the video, then every step with its picture; "Vẽ lại" draws it again (older models have none) */
function GuideView({ job, onJob }: { job: CadJob; onJob?: (job: CadJob) => void }) {
  const { message } = App.useApp();
  const [guide, setGuide] = useState<Guide | null>(null);
  const [loading, setLoading] = useState(true);
  // Drawing it again runs in the gateway and goes on when the page closes: the job's guide_task (read again here
  // while it runs, also when the page was opened again in the middle) says when it is done
  const [task, setTask] = useState(job.guide_task ?? null);
  const [asked, setAsked] = useState(false);
  const drawing = asked || Boolean(task?.running);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!drawing) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/cad/jobs/${encodeURIComponent(job.id)}`, { cache: 'no-store' }).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      const now = data?.job?.guide_task as CadJob['guide_task'];
      if (!now || now.running) return;
      setTask(now);
      setAsked(false);
      if (now.error) message.error(now.error);
      onJob?.(data.job);
      setVersion((v) => v + 1);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [drawing, job.id, message, onJob]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${fileUrl(job, 'guide.json')}&r=${version}`, { cache: 'no-store' });
      setGuide(res.ok ? ((await res.json()) as Guide) : null);
    } finally {
      setLoading(false);
    }
  }, [job, version]);
  useEffect(() => {
    void load();
  }, [load]);

  const draw = async () => {
    setAsked(true);
    let goesOn = false;
    try {
      const res = await fetch(`/api/cad/jobs/${encodeURIComponent(job.id)}/guide`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        message.error(data?.message ?? data?.guide?.error ?? `Không vẽ được hướng dẫn lắp (HTTP ${res.status}).`);
        return;
      }
      if (data.job) onJob?.(data.job);
      // Still drawing: read until it is done
      goesOn = res.status === 202;
      if (!goesOn) setVersion((v) => v + 1);
    } finally {
      if (!goesOn) setAsked(false);
    }
  };

  const redraw = (
    <Button size="small" loading={drawing} onClick={draw} title="Vẽ lại các bước và video từ mô hình đã dựng (khoảng 1 phút cho 20 chi tiết)">
      {guide ? 'Vẽ lại' : 'Vẽ hướng dẫn lắp'}
    </Button>
  );
  if (loading) return <Spin style={{ display: 'block', margin: 40 }} />;
  if (!guide) {
    return (
      <Empty description={drawing ? 'Đang vẽ từng bước và video…' : job.guide?.error ?? 'Mô hình này dựng trước khi có hướng dẫn lắp.'}>
        {redraw}
      </Empty>
    );
  }
  const v = `&r=${version}`;
  return (
    <Flex vertical gap={12}>
      <Flex justify="space-between" align="center" gap={8} wrap>
        <Typography.Text type="secondary">
          {guide.steps.length} bước ·{' '}
          {guide.order === 'model'
            ? 'thứ tự do mô hình khai báo'
            : 'thứ tự gợi ý, tự suy từ các khớp: chi tiết cố định trước, rồi từng chi tiết sau chi tiết nó nối vào. Chưa kiểm tra đường đưa vào có bị vướng không.'}
        </Typography.Text>
        <Flex gap={8}>
          {guide.video && (
            <Button size="small" href={fileUrl(job, 'assembly.mp4', true)}>
              Tải video
            </Button>
          )}
          {redraw}
        </Flex>
      </Flex>
      {guide.video ? (
        <video key={version} src={`${fileUrl(job, 'assembly.mp4')}${v}`} controls autoPlay muted loop playsInline style={{ width: '100%', maxHeight: '62vh', background: '#fff', borderRadius: 8 }} />
      ) : (
        <Alert type="warning" showIcon message={`Không có video: ${guide.video_error ?? 'không rõ lý do'}`} />
      )}
      <Image.PreviewGroup>
        <Flex vertical gap={10}>
          {guide.steps.map((step) => (
            <Flex key={step.n} gap={12} align="start" wrap style={{ borderTop: '1px solid rgba(128,128,128,0.2)', paddingTop: 10 }}>
              <Image src={`${pictureUrl(job, step.image)}${v}`} alt={`Bước ${step.n}`} width={240} style={{ borderRadius: 6, border: '1px solid rgba(128,128,128,0.25)' }} />
              <Flex vertical gap={4} flex={1} style={{ minWidth: 220 }}>
                <Typography.Text strong>
                  Bước {step.n}/{guide.steps.length}
                </Typography.Text>
                <Typography.Text>{step.text}</Typography.Text>
                <Flex gap={4} wrap>
                  {step.parts.map((part) => (
                    <Tag key={part} color="orange">
                      {part}
                    </Tag>
                  ))}
                  {step.onto && <Tag>vào {step.onto}</Tag>}
                  {step.joints.map((joint) => (
                    <Tag key={`${joint.part}-${joint.id}`} color="blue">
                      {JOINT_LABELS[joint.type ?? ''] ?? joint.type}
                    </Tag>
                  ))}
                </Flex>
              </Flex>
            </Flex>
          ))}
        </Flex>
      </Image.PreviewGroup>
    </Flex>
  );
}

/** "🔧 Hướng dẫn lắp": for a model built as separate components in their assembled places */
export function AssemblyGuideButton({ job, onJob }: { job: CadJob; onJob?: (job: CadJob) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)} title="Lắp các chi tiết theo từng bước, có ảnh và video">
        🔧 Hướng dẫn lắp{job.guide?.steps ? ` (${job.guide.steps} bước)` : ''}
      </Button>
      <Modal open={open} onCancel={() => setOpen(false)} footer={null} width="min(1100px, 96vw)" destroyOnHidden title={`Hướng dẫn lắp · ${job.title || job.id}`}>
        {open && <GuideView job={job} onJob={onJob} />}
      </Modal>
    </>
  );
}
