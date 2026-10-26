'use client';

import { CheckOutlined, RobotOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Select, Space, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useActions } from '../DashboardContext';
import { formatPrintTime } from '../prints';
import { labelOf, OutcomeTag, type Label } from './badges';

/**
 * "AI nhận xét" on a timelapse: Claude, run by the gateway (`claude -p`), looks at frames of the video
 * (POST /api/timelapse/:name/review) and says what went wrong and what to change next time. The review is only
 * shown until the user presses "Dùng cho lần in sau" (POST .../review/use): then it is saved on the print, where
 * "AI tối ưu" in Studio reads it with the past prints.
 */

const POLL_MS = 3000;

export interface Review {
  outcome_guess: string;
  issues: string[];
  summary: string;
  final_check?: string;
  observations?: { frame: number; problem: string }[];
  suggestions: string[];
  frames_at?: number[];
  model: string;
  at: string;
  video?: string;
  print_id?: string | null;
  used?: { print_id: string; at: string } | null;
}

export interface Video {
  name: string;
  size: number;
  ended_at: string | null;
  has_thumbnail: boolean;
  print: { id: string; job_name: string } | null;
}

interface ReviewState {
  status: 'none' | 'running' | 'failed' | 'done';
  review?: Review;
  error?: string;
  model?: string;
  outcomes?: Label[];
  issues?: Label[];
}

const ListOf = ({ items }: { items: React.ReactNode[] }) => (
  <ul style={{ margin: '4px 0 8px', paddingLeft: 20 }}>
    {items.map((item, i) => (
      <li key={i}>{item}</li>
    ))}
  </ul>
);

/** The review itself; `outcomes` and `issues` are the [{id, label}] lists the API sends */
export function ReviewResult({ review, outcomes = [], issues = [] }: { review: Review; outcomes?: Label[]; issues?: Label[] }) {
  return (
    <div>
      <Space wrap size={4}>
        <OutcomeTag outcome={review.outcome_guess} outcomes={outcomes} prefix="AI đoán: " />
        <Typography.Text type="secondary">
          {review.model} · {formatPrintTime(review.at)}
        </Typography.Text>
      </Space>
      <Typography.Paragraph style={{ margin: '8px 0' }}>{review.summary}</Typography.Paragraph>
      {review.issues.length > 0 && <ListOf items={review.issues.map((i) => labelOf(issues, i))} />}
      {/* Missing in reviews made before the model was asked to look at the finished print first */}
      {review.final_check && (
        <>
          <Typography.Text strong>Bản in lúc xong</Typography.Text>
          <Typography.Paragraph>{review.final_check}</Typography.Paragraph>
        </>
      )}
      {!!review.observations?.length && (
        <>
          <Typography.Text strong>Thấy trong video</Typography.Text>
          <ListOf
            items={review.observations.map((o) => (
              <>
                <Typography.Text type="secondary">{review.frames_at?.[o.frame - 1] ?? '?'}%</Typography.Text> {o.problem}
              </>
            ))}
          />
        </>
      )}
      {review.suggestions.length > 0 && (
        <>
          <Typography.Text strong>Lần in sau</Typography.Text>
          <ListOf items={review.suggestions} />
        </>
      )}
    </div>
  );
}

/**
 * The review of `video`, the button that asks for one and the one that uses it for later prints. `printId` is
 * the print the video shows when the caller knows it; otherwise the gateway's pairing is used, or the user picks.
 */
export function TimelapseReview({ video, printId = null }: { video: Video; printId?: string | null }) {
  const { showToast, addLog } = useActions();
  const [state, setState] = useState<ReviewState | null>(null);
  const [labels, setLabels] = useState<{ outcomes: Label[]; issues: Label[] }>({ outcomes: [], issues: [] });
  /** Recent prints to pick from, when the video has no print */
  const [prints, setPrints] = useState<{ id: string; job_name: string; started_at: string | null; ended_at: string | null }[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const statusRef = useRef<string | null>(null);
  const needsPick = !printId && !video.print;

  const call = useCallback(
    async (path = '', init?: RequestInit): Promise<ReviewState> => {
      const res = await fetch(`/api/timelapse/${encodeURIComponent(video.name)}/review${path}`, init);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || `Lỗi HTTP ${res.status}`);
      if (data.outcomes) setLabels({ outcomes: data.outcomes, issues: data.issues });
      return data;
    },
    [video.name]
  );

  const show = useCallback(
    (next: ReviewState) => {
      if (next.status === 'done' && statusRef.current === 'running') addLog(`AI đã nhận xét timelapse ${video.name}.`, 'success');
      statusRef.current = next.status;
      setState(next);
    },
    [addLog, video.name]
  );

  useEffect(() => {
    if (!needsPick) return;
    fetch('/api/prints?limit=30')
      .then((res) => res.json())
      .then((data) => setPrints(data?.success ? data.prints : []))
      .catch(() => setPrints([]));
  }, [needsPick]);

  const load = useCallback(
    async (isCancelled: () => boolean) => {
      try {
        const next = await call();
        if (!isCancelled()) show(next);
      } catch (err) {
        if (!isCancelled()) setState({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    },
    [call, show]
  );

  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Poll while Claude is looking: every new state schedules the next read
  useEffect(() => {
    if (state?.status !== 'running') return;
    let cancelled = false;
    const timer = setTimeout(() => load(() => cancelled), POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state, load]);

  const post = (path: string) =>
    call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ print_id: printId ?? picked }) });

  const act = async (action: () => Promise<void>) => {
    setActing(true);
    try {
      await action();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setActing(false);
    }
  };

  const start = () =>
    act(async () => {
      show(await post(''));
      addLog(`Nhờ AI xem timelapse ${video.name}.`);
    });
  const use = () =>
    act(async () => {
      show(await post('/use'));
      showToast('Đã lưu nhận xét: "AI tối ưu" sẽ tham khảo nó cho lần in sau.', 'success');
      addLog(`Dùng nhận xét timelapse ${video.name} cho lần in sau.`);
    });
  const unuse = () =>
    act(async () => {
      show(await call('/use', { method: 'DELETE' }));
      addLog(`Bỏ dùng nhận xét timelapse ${video.name}.`);
    });

  const printName = (id: string) => prints.find((p) => p.id === id)?.job_name ?? (video.print?.id === id ? video.print.job_name : null);
  const picker =
    needsPick && prints.length > 0 ? (
      <Space wrap>
        <Typography.Text>Bản in của video:</Typography.Text>
        <Select
          style={{ minWidth: 260 }}
          placeholder="— Chưa chọn —"
          allowClear
          value={picked ?? undefined}
          onChange={(v) => setPicked(v ?? null)}
          options={prints.map((p) => ({ value: p.id, label: `${formatPrintTime(p.ended_at ?? p.started_at)} · ${p.job_name}` }))}
        />
      </Space>
    ) : null;

  const status = state?.status ?? 'none';
  const running = status === 'running';
  const review = state?.review;

  return (
    <Flex vertical gap={8}>
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          <RobotOutlined /> AI nhận xét
        </Typography.Title>
        <Button size="small" icon={<RobotOutlined />} loading={running || (acting && !review)} onClick={start} disabled={!state}>
          {running ? 'Đang xem...' : status === 'done' ? 'Xem lại' : 'Nhờ AI xem video'}
        </Button>
      </Flex>
      {(status === 'none' || status === 'failed') && picker}
      {status === 'done' && review ? (
        <>
          <ReviewResult review={review} outcomes={labels.outcomes} issues={labels.issues} />
          {review.used ? (
            <Alert
              type="success"
              title={`Đang dùng cho lần in sau${printName(review.used.print_id) ? ` (bản in ${printName(review.used.print_id)})` : ''} · ${formatPrintTime(review.used.at)}`}
              action={
                <Button size="small" onClick={unuse} loading={acting}>
                  Bỏ dùng
                </Button>
              }
            />
          ) : (
            <Flex vertical gap={8}>
              {picker}
              <Space wrap>
                <Button type="primary" icon={<CheckOutlined />} onClick={use} loading={acting}>
                  Dùng cho lần in sau
                </Button>
                <Typography.Text type="secondary">
                  Lưu nhận xét vào bản in để &quot;AI tối ưu&quot; trong Studio tham khảo khi in plate tương tự. Không bấm thì đây chỉ là nhận xét.
                </Typography.Text>
              </Space>
            </Flex>
          )}
        </>
      ) : status === 'failed' ? (
        <Alert type="error" title={state?.error} />
      ) : running ? (
        <Typography.Text type="secondary">⏳ {state?.model ?? 'Claude'} đang xem video (thường dưới 1 phút)...</Typography.Text>
      ) : (
        <Typography.Text type="secondary">
          Claude ({state?.model ?? 'claude'}) xem các khung hình của timelapse, chỉ ra lỗi và cách chỉnh cho lần in sau.
        </Typography.Text>
      )}
    </Flex>
  );
}
