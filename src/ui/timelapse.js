/**
 * Timelapse videos the printer recorded (GET /api/timelapse), shown in the print history ("Lịch sử in"):
 * a video paired with a print marks its row, a video with no print in the list gets a row of its own. A
 * video plays in a modal; the gateway copies it from the printer the first time, so the first play of a
 * video takes a few seconds.
 */
import { escapeHtml, formatPrintTime } from './prints';
import { mountReview } from './timelapseReview';

// ---------- Pure helpers (unit-tested in tests/timelapseUi.test.ts) ----------

export const videoUrl = (name) => `/api/timelapse/${encodeURIComponent(name)}`;
export const thumbnailUrl = (name) => `${videoUrl(name)}/thumbnail`;

/** "2,7 MB" */
export function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`;
}

/** A row of the print history for a video whose print isn't in the list (none paired, or an older one) */
export function renderVideoRow(video) {
  const thumb = video.has_thumbnail
    ? `<img src="${escapeHtml(thumbnailUrl(video.name))}" alt="" loading="lazy" />`
    : '<span class="print-thumb-empty" aria-hidden="true">🎬</span>';
  const print = video.print
    ? `<span class="print-row-preset" title="Bản in trong lịch sử">🖨️ ${escapeHtml(video.print.job_name)}</span>`
    : '<span class="print-row-preset">Chưa ghép với bản in nào</span>';
  return `
    <div class="print-row is-video" data-name="${escapeHtml(video.name)}">
      <span class="print-select" aria-hidden="true"><span class="print-select-spacer"></span></span>
      <button type="button" class="print-row-open video-row-open" data-name="${escapeHtml(video.name)}">
        <span class="print-thumb">${thumb}</span>
        <span class="print-row-info">
          <span class="print-row-title">🎬 Timelapse</span>
          <span class="print-row-meta">
            <span class="print-row-time">${escapeHtml(formatPrintTime(video.ended_at))}</span>
            <span class="prints-muted">${escapeHtml(formatSize(video.size))}</span>
          </span>
          ${print}
        </span>
      </button>
    </div>`;
}

// ---------- Player ----------

/** Plays a video in a modal, with its "AI nhận xét" below; returns the function that closes it */
export function openTimelapsePlayer(video, { showToast, addLog }) {
  const previousFocus = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop prints-backdrop';
  backdrop.innerHTML = `
    <div class="modal-content prints-modal is-wide" role="dialog" aria-modal="true" aria-labelledby="timelapseModalTitle">
      <div class="modal-header">
        <h3 id="timelapseModalTitle" class="prints-modal-title"></h3>
        <button type="button" class="btn-close-modal" aria-label="Đóng">&times;</button>
      </div>
      <div class="prints-modal-body">
        <div class="prints-muted timelapse-loading">⏳ Lần đầu xem, gateway đang lấy video từ máy in...</div>
        <video class="timelapse-video" controls autoplay playsinline preload="auto"></video>
        <div class="timelapse-actions">
          <span class="prints-muted">${escapeHtml(formatPrintTime(video.ended_at))} · ${escapeHtml(formatSize(video.size))}${
            video.print ? ` · 🖨️ ${escapeHtml(video.print.job_name)}` : ''
          }</span>
          <a class="btn-ams-action" href="${escapeHtml(videoUrl(video.name))}" download="${escapeHtml(video.name)}">⬇ Tải về</a>
        </div>
        <section class="print-section"></section>
      </div>
    </div>`;
  backdrop.querySelector('.prints-modal-title').textContent = video.print?.job_name ?? video.name;
  const player = backdrop.querySelector('video');
  const loading = backdrop.querySelector('.timelapse-loading');
  player.addEventListener('loadeddata', () => (loading.hidden = true));
  player.addEventListener('error', () => {
    loading.textContent = '❌ Không phát được video (máy in không trả lời, hoặc trình duyệt không hỗ trợ định dạng này). Thử Tải về.';
  });
  player.src = videoUrl(video.name);
  const stopReview = mountReview(backdrop.querySelector('.print-section'), video, { showToast, addLog });

  let open = true;
  const onKey = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) close();
  };
  function close() {
    if (!open) return;
    open = false;
    stopReview();
    player.pause();
    player.removeAttribute('src');
    player.load();
    document.removeEventListener('keydown', onKey);
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 200);
    previousFocus?.focus?.({ preventScroll: true });
  }
  backdrop.querySelector('.btn-close-modal').addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('open'));
  addLog(`Xem timelapse ${video.name}.`, 'info');
  return close;
}
