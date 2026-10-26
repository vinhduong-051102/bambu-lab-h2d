/**
 * "Thiết kế mô hình bằng AI", two kinds of models in one list (GET /api/cad/jobs):
 * - technical (POST /api/cad/jobs): Claude writes and checks build123d code in the CAD container; models built
 *   from Antigravity (MCP bambu-cad) show up too. Downloads STL, STEP and code; "revise" asks Claude to change it.
 * - figures (POST /api/cad/meshes): Hunyuan3D-2 on the GPU turns an uploaded picture, or one drawn from the
 *   description, into a mesh sized for printing. Downloads STL; "make again" tries another seed; "Claude review"
 *   (POST /api/cad/jobs/:id/fix) has Claude check it against its picture and fix it with mesh code, as a new job.
 * Every finished model has a preview and "send to Studio".
 *
 * These are the page's labels and pure helpers; the page itself is src/ui/cad/CadCard.tsx.
 */

export const STATE_LABELS = {
  queued: 'Đang chờ',
  running: 'Đang thiết kế',
  done: 'Xong',
  failed: 'Lỗi',
  cancelled: 'Đã hủy',
};

export const STEP_LABELS = {
  starting: 'Khởi động Claude',
  reading: 'Đọc yêu cầu và hướng dẫn',
  writing: 'Viết code',
  building: 'Dựng mô hình',
  reviewing: 'Xem ảnh để kiểm tra',
  finishing: 'Xuất file',
  // Figures (mesh3d/worker.py)
  queued: 'Chờ GPU',
  loading: 'Nạp model dựng hình vào GPU',
  prompting: 'Claude viết prompt ảnh',
  loading_image: 'Nạp model vẽ ảnh',
  imaging: 'Vẽ ảnh từ mô tả',
  background: 'Tách nền ảnh',
  shaping: 'Dựng hình 3D từ ảnh',
  repairing: 'Sửa lưới, chỉnh kích thước',
  loading_paint: 'Nạp model tô màu',
  painting: 'Tô texture theo ảnh',
  colouring: 'Gom màu theo filament',
  checking: 'Kiểm tra lưới, vẽ ảnh xem trước',
};

/**
 * A figure's steps in order, for the steps still ahead: from an uploaded picture or from its prompt. Loading the
 * models only happens when they are not in memory, so it is never shown as ahead.
 */
const FIGURE_STEPS = {
  image: ['queued', 'loading', 'background', 'shaping', 'repairing', 'checking'],
  prompt: ['queued', 'loading', 'prompting', 'loading_image', 'imaging', 'background', 'shaping', 'repairing', 'checking'],
};
// A coloured figure is painted after the repair
const PAINT_STEPS = ['loading_paint', 'painting', 'colouring'];
const MAYBE_STEPS = new Set(['loading', 'loading_image', 'loading_paint']);

/** The steps a figure goes through, in order; none known ahead for Claude's review, which decides as it goes */
export function figurePlan(job) {
  if (job.input === 'fix') return [];
  const plan = [...FIGURE_STEPS[job.input ?? 'image']];
  if (job.colour) plan.splice(plan.indexOf('checking'), 0, ...PAINT_STEPS);
  return plan;
}
// Claude can take dozens of steps: the timeline shows the latest
const MAX_STEPS_SHOWN = 12;

/** 8000 → "8 giây", 125000 → "2 phút 5 giây" */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} giây`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} phút ${rest} giây` : `${minutes} phút`;
}

const time = (iso) => (iso ? Date.parse(iso) : NaN);

/** "12/25 bước · 48%", "3.200/14.500 MB · 22%" */
export function formatProgress(progress) {
  if (!progress?.total) return progress?.done ? `${progress.done.toLocaleString('vi-VN')} ${progress.unit ?? ''}`.trim() : '';
  const percent = Math.min(100, Math.round((progress.done / progress.total) * 100));
  return `${progress.done.toLocaleString('vi-VN')}/${progress.total.toLocaleString('vi-VN')} ${progress.unit ?? ''} · ${percent}%`;
}

/**
 * The timeline of a job's steps: done (with their time), the current one (with its progress), and those ahead.
 * Each item is { kind: done | retry | current | failed | ahead | more, label, detail, progress, took }.
 */
export function jobSteps(job, now = Date.now()) {
  const steps = job.steps ?? [];
  if (steps.length === 0) return [];
  const busy = isBusy(job);
  const stopped = job.state === 'failed' || job.state === 'cancelled';
  const shown = steps.slice(-MAX_STEPS_SHOWN);
  const items = shown.map((step, index) => {
    const last = index === shown.length - 1;
    const current = busy && last && !step.finished_at;
    const broken = stopped && last;
    const retry = !current && String(step.detail ?? '').includes('✗');
    const end = step.finished_at ? time(step.finished_at) : current || broken ? now : NaN;
    const took = Number.isFinite(end - time(step.started_at)) ? formatDuration(end - time(step.started_at)) : '';
    return {
      kind: current ? 'current' : broken ? (job.state === 'cancelled' ? 'cancelled' : 'failed') : retry ? 'retry' : 'done',
      label: STEP_LABELS[step.id] ?? step.id,
      detail: step.detail ?? null,
      progress: current && job.progress ? job.progress : null,
      took,
    };
  });

  // A figure's steps still ahead
  if (busy && job.source === 'mesh') {
    const plan = figurePlan(job);
    const at = plan.indexOf(job.step);
    for (const id of at >= 0 ? plan.slice(at + 1).filter((id) => !MAYBE_STEPS.has(id)) : []) {
      items.push({ kind: 'ahead', label: STEP_LABELS[id], detail: null, progress: null, took: '' });
    }
  }
  const hidden = steps.length - shown.length;
  return hidden ? [{ kind: 'more', label: `… ${hidden} bước trước`, detail: null, progress: null, took: '' }, ...items] : items;
}

export const HINTS = {
  technical:
    'Claude viết code build123d, tự dựng, xem ảnh và sửa trong container CAD (tính vào giới hạn gói Claude, thường vài phút). ' +
    'Hợp với chi tiết cần đúng kích thước: hộp, giá đỡ, ngàm, vỏ. Mô hình làm từ Antigravity qua MCP bambu-cad cũng hiện ở đây.',
  figure:
    'Hunyuan3D-2 dựng hình 3D từ ảnh trên GPU của máy này (khoảng 1 phút; lần đầu sau khi bật thêm 2 phút nạp model). ' +
    'Tải ảnh lên cho kết quả sát nhất: một nhân vật, nhìn chéo phía trước, nền trơn. Không có ảnh thì Claude viết prompt và AI vẽ ảnh từ mô tả. ' +
    'Kích thước chỉ đúng theo chiều cao; hình dáng chi tiết do AI tự đoán. ' +
    'Tô màu: Hunyuan3D-Paint tô theo ảnh rồi gom về số màu bạn chọn, đúng các màu trong AMS, màu Bambu chính hãng (một loại nhựa hoặc cả dòng, ghi rõ tên và mã cuộn) hoặc Filament của tôi; ' +
    'màu nào lệch so với mô hình sẽ được ghi rõ, kèm gợi ý trộn màu trong Studio. Xuất 3MF đã tô sẵn, thêm khoảng 1–2 phút.',
};

export const REVISE_PLACEHOLDERS = {
  technical: 'Cần sửa gì? Ví dụ: dày thêm 1 mm, bo tròn các góc',
  figure: 'Cần sửa gì? Để trống: Claude tự tìm lỗi (chân cụt, mảnh rời, bề mặt sần, lỗ hở…). Ví dụ: chân bị cụt, tóc quá mảnh',
};

export const PLACEHOLDERS = {
  technical: 'Mô tả mô hình cần in, càng rõ kích thước càng tốt. Ví dụ: giá đỡ điện thoại nghiêng 60°, rộng 80 mm, dày 3 mm, có rãnh luồn cáp sạc.',
  figure: 'Mô tả nhân vật hoặc đồ trang trí (không bắt buộc khi có ảnh). Ví dụ: chú mèo béo ngồi đội mũ phù thủy, phong cách chibi.',
};

export const isBusy = (job) => job.state === 'running' || job.state === 'queued';

/** "60 × 40 × 20 mm", or null without a size */
export function formatSize(sizeMm) {
  if (!Array.isArray(sizeMm) || sizeMm.length !== 3) return null;
  return `${sizeMm.map((v) => Number(v).toLocaleString('vi-VN', { maximumFractionDigits: 1 })).join(' × ')} mm`;
}

export const fileUrl = (job, name, download = false) =>
  `/api/cad/jobs/${encodeURIComponent(job.id)}/files/${name}?v=${encodeURIComponent(job.finished_at ?? job.state)}${download ? '&download=1' : ''}`;

/** Where a filament on a figure's palette comes from */
export const ORIGINS = { ams: '✓ có trong AMS', custom: '✓ trong kho của bạn', bambu: '🛒 cần mua / nạp' };

/** "claude-opus-5-5" → "opus 5.5" */
export const modelName = (model) => (model ?? 'Claude').replace('claude-', '').replace(/-(\d)-(\d)$/, ' $1.$2');
