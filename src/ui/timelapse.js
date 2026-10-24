/**
 * Timelapse ("Lịch sử in" page): the videos the printer recorded (GET /api/timelapse), each with its
 * thumbnail and the print it shows. A video plays in a modal; the gateway copies it from the printer the
 * first time, so the first play of a video takes a few seconds.
 */
import { escapeHtml, formatPrintTime } from './prints';

// ---------- Pure helpers (unit-tested in tests/timelapseUi.test.ts) ----------

export const videoUrl = (name) => `/api/timelapse/${encodeURIComponent(name)}`;
export const thumbnailUrl = (name) => `${videoUrl(name)}/thumbnail`;

/** "2,7 MB" */
export function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`;
}

export function renderTimelapseTile(video) {
  const thumb = video.has_thumbnail
    ? `<img class="timelapse-thumb" src="${escapeHtml(thumbnailUrl(video.name))}" alt="" loading="lazy" />`
    : '<div class="timelapse-thumb timelapse-thumb-empty">🎬</div>';
  const print = video.print
    ? `<span class="timelapse-print" title="Bản in trong lịch sử">🖨️ ${escapeHtml(video.print.job_name)}</span>`
    : '<span class="prints-muted">Chưa ghép với bản in nào</span>';
  return `
    <button type="button" class="timelapse-tile" data-name="${escapeHtml(video.name)}">
      ${thumb}
      <span class="timelapse-meta">
        <span class="timelapse-time">${escapeHtml(formatPrintTime(video.ended_at))}</span>
        <span class="prints-muted">${escapeHtml(formatSize(video.size))}</span>
      </span>
      ${print}
    </button>`;
}

// ---------- Card ----------

export function initTimelapse({ showToast, addLog }) {
  const $ = (id) => document.getElementById(id);
  const list = $('timelapseList');
  const btnRefresh = $('btnTimelapseRefresh');
  if (!list) return () => {};

  let videos = [];
  let disposed = false;
  let controller = null;
  let closeModal = null;

  async function load(refresh = false) {
    controller?.abort();
    controller = new AbortController();
    btnRefresh.disabled = true;
    try {
      const res = await fetch(`/api/timelapse${refresh ? '?refresh=1' : ''}`, { signal: controller.signal });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || `Lỗi HTTP ${res.status}`);
      if (disposed) return;
      videos = data.videos;
      list.innerHTML = videos.length
        ? videos.map(renderTimelapseTile).join('')
        : `<div class="prints-empty">Máy in chưa có video timelapse nào. Bật <b>Timelapse</b> trong hộp gửi lệnh in của Studio để máy in quay bản in.</div>`;
    } catch (err) {
      if (err.name === 'AbortError' || disposed) return;
      list.innerHTML = `<div class="prints-empty">❌ ${escapeHtml(err.message)}</div>`;
      if (refresh) showToast(err.message, 'error');
    } finally {
      btnRefresh.disabled = false;
    }
  }

  function openPlayer(video) {
    closeModal?.();
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

    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) close();
    };
    function close() {
      if (closeModal !== close) return;
      closeModal = null;
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
    closeModal = close;
    addLog(`Xem timelapse ${video.name}.`, 'info');
  }

  list.addEventListener('click', (e) => {
    const tile = e.target.closest('.timelapse-tile');
    const video = tile && videos.find((v) => v.name === tile.dataset.name);
    if (video) openPlayer(video);
  });
  btnRefresh.addEventListener('click', () => load(true));
  load();

  return () => {
    disposed = true;
    controller?.abort();
    closeModal?.();
  };
}
