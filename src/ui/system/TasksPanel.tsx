'use client';

import { CheckCircleFilled, CloseCircleFilled, ExportOutlined, LoadingOutlined, ReloadOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { Alert, Badge, Button, Card, Collapse, Drawer, Empty, Flex, Progress, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useActions } from '../DashboardContext';
import { dismissKey, elapsed, endedSince, kindLabel, visibleTasks } from '../tasks';

/** GET /api/tasks (src/api/routes/tasks.ts) */
export interface PanelTask {
  key: string;
  kind: string;
  label: string;
  page: string | null;
  state: 'running' | 'failed' | 'done';
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  details: string[];
  progress: { done: number; total: number | null; unit?: string | null } | null;
  retry_url: string | null;
  retry_hint?: string;
}

const STORAGE_KEY = 'dismissed-tasks';
// Read often while something runs or the panel is open; otherwise now and then, to notice tasks started elsewhere
const BUSY_MS = 4000;
const IDLE_MS = 20_000;

function loadDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function saveDismissed(keys: Set<string>) {
  try {
    // Only the latest few hundred: older runs are gone from the list anyway
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys].slice(-300)));
  } catch {
    // Private window: dismissed until the page reloads
  }
}

const time = (at: string | null) => (at ? new Date(at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '—');

function TaskItem({ task, onRetry, onOpen, onDismiss }: { task: PanelTask; onRetry: (t: PanelTask) => Promise<void>; onOpen?: (page: string) => void; onDismiss: (t: PanelTask) => void }) {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry(task);
    } finally {
      setRetrying(false);
    }
  };
  const icon =
    task.state === 'running' ? <LoadingOutlined style={{ color: '#3b82f6' }} /> : task.state === 'failed' ? <CloseCircleFilled style={{ color: '#ef4444' }} /> : <CheckCircleFilled style={{ color: '#10b981' }} />;
  const p = task.progress;
  return (
    <Card size="small">
      <Flex vertical gap={6}>
        <Flex gap={8} align="start" justify="space-between">
          <Space align="start" size={8}>
            {icon}
            <Flex vertical gap={2}>
              <Typography.Text strong>{task.label}</Typography.Text>
              <Space size={4} wrap>
                <Tag>{kindLabel(task.kind)}</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {task.state === 'running'
                    ? `Đang chạy ${task.started_at ? elapsed(task.started_at) : ''} · từ ${time(task.started_at)}`
                    : `${task.state === 'failed' ? 'Lỗi' : 'Xong'} lúc ${time(task.finished_at ?? task.started_at)}${task.started_at && task.finished_at ? ` · chạy ${elapsed(task.started_at, task.finished_at)}` : ''}`}
                </Typography.Text>
              </Space>
            </Flex>
          </Space>
          <Space size={4}>
            {task.page && onOpen && (
              <Button size="small" type="text" icon={<ExportOutlined />} title="Mở trang có kết quả" onClick={() => onOpen(task.page!)} />
            )}
            {task.state !== 'running' && (
              <Button size="small" type="text" onClick={() => onDismiss(task)} title="Bỏ khỏi danh sách">
                Ẩn
              </Button>
            )}
          </Space>
        </Flex>
        {task.state === 'running' && p && p.total ? (
          <Progress percent={Math.round((p.done / p.total) * 100)} size="small" format={() => (p.unit === '%' ? `${p.done}%` : `${p.done}/${p.total}${p.unit ? ` ${p.unit}` : ''}`)} />
        ) : null}
        {task.state === 'failed' && (
          <Alert
            type="error"
            showIcon
            title={task.error ?? 'Lỗi không rõ'}
            description={
              <Flex vertical gap={6}>
                {task.details.length > 0 && (
                  <Collapse
                    size="small"
                    ghost
                    items={[
                      {
                        key: 'details',
                        label: `Chi tiết lỗi (${task.details.length} dòng)`,
                        children: <pre className="task-details">{task.details.join('\n')}</pre>,
                      },
                    ]}
                  />
                )}
                {task.retry_hint && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {task.retry_hint}
                  </Typography.Text>
                )}
                {task.retry_url && (
                  <div>
                    <Button size="small" type="primary" icon={<ReloadOutlined />} loading={retrying} onClick={retry}>
                      Thử lại
                    </Button>
                  </div>
                )}
              </Flex>
            }
          />
        )}
        {task.state === 'done' && task.details.length > 0 && (
          <Collapse size="small" ghost items={[{ key: 'details', label: 'Ghi chú', children: <pre className="task-details">{task.details.join('\n')}</pre> }]} />
        )}
      </Flex>
    </Card>
  );
}

/**
 * The header's "Tác vụ" button: everything running in the background (it goes on when the page closes), what
 * failed with why and a "Thử lại", and what finished lately. Opening the page again shows them as they are now.
 */
export function TasksButton({ onOpen }: { onOpen?: (page: string) => void }) {
  const { showToast, addLog } = useActions();
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<PanelTask[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const last = useRef<PanelTask[] | null>(null);

  useEffect(() => setDismissed(loadDismissed()), []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks', { cache: 'no-store' });
      const data = (await res.json().catch(() => null)) as { success?: boolean; tasks?: PanelTask[]; message?: string } | null;
      if (!res.ok || !data?.success || !data.tasks) throw new Error(data?.message || `HTTP ${res.status}`);
      // Said once when one ends while the page is open (not for what had ended before it was opened)
      if (last.current) {
        for (const t of endedSince(last.current, data.tasks) as PanelTask[]) {
          if (t.state === 'failed') showToast(`${kindLabel(t.kind)} lỗi: ${t.label}${t.error ? ` (${t.error})` : ''}`, 'error');
          else addLog(`${kindLabel(t.kind)} xong: ${t.label}`, 'success');
        }
      }
      last.current = data.tasks;
      setTasks(data.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [showToast, addLog]);

  const shown = visibleTasks(tasks, dismissed) as PanelTask[];
  const running = shown.filter((t) => t.state === 'running').length;
  const failed = shown.filter((t) => t.state === 'failed').length;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      await load();
      if (!stopped) timer = setTimeout(tick, open || (last.current ?? []).some((t) => t.state === 'running') ? BUSY_MS : IDLE_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load, open]);

  const dismiss = (task: PanelTask) => {
    const next = new Set(dismissed).add(dismissKey(task));
    setDismissed(next);
    saveDismissed(next);
  };
  const dismissFinished = () => {
    const next = new Set(dismissed);
    for (const t of shown) if (t.state !== 'running') next.add(dismissKey(t));
    setDismissed(next);
    saveDismissed(next);
  };

  const retry = async (task: PanelTask) => {
    if (!task.retry_url) return;
    try {
      const res = await fetch(task.retry_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = (await res.json().catch(() => null)) as { success?: boolean; message?: string } | null;
      if (!res.ok || !data?.success) throw new Error(data?.message || `HTTP ${res.status}`);
      showToast(`Đang chạy lại: ${task.label}`, 'info');
      addLog(`Chạy lại ${kindLabel(task.kind).toLowerCase()}: ${task.label}`);
      await load();
    } catch (err) {
      showToast(`Không chạy lại được: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  return (
    <>
      <Badge count={running || (failed ? '!' : 0)} color={running ? '#3b82f6' : '#ef4444'} size="small" offset={[-4, 4]}>
        <Button icon={running ? <LoadingOutlined /> : <UnorderedListOutlined />} onClick={() => setOpen(true)} danger={!running && failed > 0} title="Các tác vụ chạy nền">
          Tác vụ
        </Button>
      </Badge>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Tác vụ chạy nền"
        size="large"
        extra={
          <Space>
            <Button size="small" icon={<ReloadOutlined />} onClick={load} title="Tải lại" />
            <Button size="small" onClick={dismissFinished} disabled={!shown.some((t) => t.state !== 'running')}>
              Ẩn mục đã xong
            </Button>
          </Space>
        }
      >
        <Flex vertical gap={10}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Các việc này chạy trên máy chủ: đóng trang thì vẫn chạy tiếp, mở lại sẽ thấy đúng tiến độ. Việc lỗi có chi tiết và nút Thử lại.
          </Typography.Paragraph>
          {error && <Alert type="warning" showIcon title={`Không đọc được danh sách tác vụ: ${error}`} />}
          {shown.length === 0 ? (
            <Empty description="Không có tác vụ nào đang chạy hay vừa lỗi" />
          ) : (
            shown.map((t) => (
              <TaskItem
                key={dismissKey(t)}
                task={t}
                onRetry={retry}
                onDismiss={dismiss}
                onOpen={
                  onOpen &&
                  ((page) => {
                    onOpen(page);
                    setOpen(false);
                  })
                }
              />
            ))
          )}
        </Flex>
      </Drawer>
    </>
  );
}
