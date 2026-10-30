/**
 * The task panel's logic (src/ui/system/TasksPanel.tsx), kept apart to be tested: what each kind of task is called,
 * which ones the user dismissed, and which ended since the last read.
 */

export const KIND_LABELS = {
  'cad-model': 'Thiết kế AI',
  'cad-figure': 'Mô hình từ ảnh',
  'eng-check': 'Kiểm tra kỹ thuật',
  'cad-guide': 'Hướng dẫn lắp',
  'print-parts': 'Phân tích thành phần',
  'parts-backfill': 'Phân tích bản in cũ',
  'mech-setup': 'Chuẩn bị mô phỏng',
  'sim-run': 'Lần chạy mô phỏng',
  'timelapse-review': 'AI xem timelapse',
};

export const kindLabel = (kind) => KIND_LABELS[kind] ?? kind;

/** A finished task is dismissed for that run only: running it again shows it again */
export const dismissKey = (task) => `${task.key}@${task.finished_at ?? task.started_at ?? ''}`;

export const visibleTasks = (tasks, dismissed) => tasks.filter((t) => t.state === 'running' || !dismissed.has(dismissKey(t)));

/** The tasks that were running at the last read and have ended now */
export function endedSince(before, now) {
  const running = new Set(before.filter((t) => t.state === 'running').map((t) => t.key));
  return now.filter((t) => t.state !== 'running' && running.has(t.key));
}

/**
 * "3 phút", "1 giờ 5 phút": how long a task has run (or ran)
 * @param {string | number} from
 * @param {string | number} [to]
 */
export function elapsed(from, to = Date.now()) {
  const s = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút`;
  return `${Math.floor(m / 60)} giờ${m % 60 ? ` ${m % 60} phút` : ''}`;
}
