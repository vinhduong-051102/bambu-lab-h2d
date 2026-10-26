/**
 * Print history ("Lịch sử in"): the prints the gateway recorded (GET /api/prints), each with the settings
 * Studio sliced it with, its photos and the user's report, and the printer's timelapse videos
 * (GET /api/timelapse) in the same list. A print opens in a detail modal (photos, timelapse, setup, report
 * form, settings); two ticked prints open side by side with only the settings that differ; a video with no
 * print in the list plays on its own.
 */
import { confirmDialog } from './confirmDialog';
import { openTimelapsePlayer, renderVideoRow, thumbnailUrl } from './timelapse';
import { mountReview, renderReview } from './timelapseReview';

const REFRESH_MS = 60_000;
// The printer's video listing is read over FTPS: reloaded less often than the history, and on "Làm mới"
const VIDEOS_REFRESH_MS = 5 * 60_000;
const LIST_LIMIT = 50;
const NO_SETUP_TEXT = 'Không có setting (bản in không gửi từ Studio)';

export const STATUS_LABELS = { printing: 'Đang in', finished: 'Hoàn thành', failed: 'Lỗi' };

// ---------- Pure helpers (unit-tested in tests/printsUi.test.ts) ----------

/** Escapes text from the API (job names, notes and preset names are typed by users) for innerHTML */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "dd/mm HH:MM" in local time, "—" when missing or unparseable */
export function formatPrintTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Labelled keys first (in the labels' order), then the rest alphabetically */
export function orderSettingKeys(keys, labels = {}) {
  const set = new Set(keys);
  const labelled = Object.keys(labels).filter((k) => set.has(k));
  const labelledSet = new Set(labelled);
  const rest = [...set].filter((k) => !labelledSet.has(k)).sort((a, b) => a.localeCompare(b));
  return [...labelled, ...rest];
}

// Settings are Bambu Studio's serialized strings; per-extruder vectors ("200,500") are compared as-is
const settingText = (value) => (value === undefined || value === null ? null : String(value));

/**
 * A print's settings as one list: the process settings, then each filament's as "filament#2:key" (the
 * same names the AI sessions use). null when Studio sent no settings.
 */
export function printSettings(setup) {
  if (!setup?.settings) return null;
  const settings = { ...setup.settings };
  (setup.filaments ?? []).forEach((filament, i) => {
    for (const [key, value] of Object.entries(filament.settings ?? {})) settings[`filament#${i + 1}:${key}`] = value;
  });
  return settings;
}

/**
 * The settings whose values differ between two prints: [{ key, label, a, b }], a/b null when the key
 * is missing on that side. Returns null when either print has no settings to compare.
 */
export function diffSettings(settingsA, settingsB, labels = {}) {
  if (!settingsA || !settingsB) return null;
  const keys = new Set([...Object.keys(settingsA), ...Object.keys(settingsB)]);
  const differing = [...keys].filter((k) => settingText(settingsA[k]) !== settingText(settingsB[k]));
  return orderSettingKeys(differing, labels).map((key) => ({
    key,
    label: labels[key] ?? null,
    a: settingText(settingsA[key]),
    b: settingText(settingsB[key]),
  }));
}

/**
 * Rows of one print's settings: only the labelled ones by default, every key with `all`, narrowed by
 * `filter` (matches key, label or value, case-insensitive).
 */
export function listSettings(settings, labels = {}, { all = false, filter = '' } = {}) {
  if (!settings) return [];
  const keys = all ? Object.keys(settings) : Object.keys(labels).filter((k) => k in settings);
  const q = filter.trim().toLowerCase();
  return orderSettingKeys(keys, labels)
    .map((key) => ({ key, label: labels[key] ?? null, value: settingText(settings[key]) ?? '' }))
    .filter((row) => !q || [row.key, row.label ?? '', row.value].some((t) => t.toLowerCase().includes(q)));
}

export function photoUrl(printId, name) {
  return `/api/prints/${encodeURIComponent(printId)}/photos/${encodeURIComponent(name)}`;
}

const labelOf = (list, id) => list.find((o) => o.id === id)?.label ?? id;

function statusBadge(status) {
  return `<span class="print-badge status-${escapeHtml(status)}">${escapeHtml(STATUS_LABELS[status] ?? status)}</span>`;
}

function outcomeBadge(outcome, outcomes) {
  if (!outcome) return '';
  return `<span class="print-badge outcome-${escapeHtml(outcome)}">${escapeHtml(labelOf(outcomes, outcome))}</span>`;
}

/**
 * The history's rows, newest first: each print with its video (or null), and the videos whose print isn't
 * in the list, placed by when they ended. A print still printing counts as now.
 */
export function historyItems(prints, videos = [], now = Date.now()) {
  const ids = new Set(prints.map((p) => p.id));
  const byPrint = new Map(videos.filter((v) => v.print && ids.has(v.print.id)).map((v) => [v.print.id, v]));
  const time = (iso) => Date.parse(iso ?? '') || 0;
  const printTime = (p) => (p.ended_at ? time(p.ended_at) : p.status === 'printing' ? now : time(p.started_at));
  const items = [
    ...prints.map((print) => ({ print, video: byPrint.get(print.id) ?? null, at: printTime(print) })),
    ...videos.filter((v) => !v.print || !ids.has(v.print.id)).map((video) => ({ print: null, video, at: time(video.ended_at) })),
  ];
  return items.sort((a, b) => b.at - a.at).map(({ print, video }) => ({ print, video }));
}

/**
 * One row of the list: options { outcomes, selected, selectDisabled, video } (selected and selectDisabled
 * drive the compare checkbox, video is the print's timelapse)
 */
export function renderPrintRow(print, options = {}) {
  const { outcomes = [], selected = false, selectDisabled = false, video = null } = options;
  const photo = print.photos?.[0];
  const thumb = photo
    ? `<img src="${escapeHtml(photoUrl(print.id, photo.name))}" alt="" loading="lazy" />`
    : video?.has_thumbnail
      ? `<img src="${escapeHtml(thumbnailUrl(video.name))}" alt="" loading="lazy" />`
      : '<span class="print-thumb-empty" aria-hidden="true">🖨️</span>';
  const meta = [
    statusBadge(print.status),
    outcomeBadge(print.feedback_outcome, outcomes),
    print.ai_session_id ? '<span class="print-badge ai" title="Có dùng đề xuất AI">AI</span>' : '',
    video ? '<span class="print-badge video" title="Có timelapse: mở bản in để xem">🎬 Video</span>' : '',
  ].join('');
  const preset = print.process_preset ? `<span class="print-row-preset">${escapeHtml(print.process_preset)}</span>` : '';
  return `
    <div class="print-row${selected ? ' is-selected' : ''}" data-id="${escapeHtml(print.id)}">
      <label class="print-select" title="Chọn để so sánh">
        <input type="checkbox" class="print-select-input" data-id="${escapeHtml(print.id)}"${selected ? ' checked' : ''}${selectDisabled && !selected ? ' disabled' : ''} />
      </label>
      <button type="button" class="print-row-open" data-id="${escapeHtml(print.id)}">
        <span class="print-thumb">${thumb}</span>
        <span class="print-row-info">
          <span class="print-row-title">${escapeHtml(print.job_name)}</span>
          <span class="print-row-meta">
            <span class="print-row-time">${escapeHtml(formatPrintTime(print.started_at ?? print.ended_at))}</span>
            ${meta}
          </span>
          ${preset}
        </span>
      </button>
    </div>`;
}

// ---------- Panel ----------

export function initPrintHistory({ showToast, addLog }) {
  const $ = (id) => document.getElementById(id);
  const card = $('printsCard');
  const list = $('printsList');
  const btnRefresh = $('btnPrintsRefresh');
  const btnCompare = $('btnPrintsCompare');
  const selectionNote = $('printsSelectionNote');

  if (!card || !list) return () => {};

  let disposed = false;
  let prints = [];
  /** The printer's timelapse videos, when they were last read (0 = never) and why the last read failed */
  let videos = [];
  let videosAt = 0;
  let videosError = null;
  let outcomes = [];
  let issues = [];
  let settingLabels = {};
  let lastLoad = 0;
  let loading = false;
  /** Ticked prints for comparing, in tick order (at most 2) */
  let selected = [];
  /** The open modal's close function, if any */
  let closeModal = null;
  const controller = new AbortController();

  async function fetchJson(url, init = {}) {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* handled below */
    }
    if (!res.ok || !data?.success) throw new Error(data?.message || `Lỗi HTTP ${res.status}`);
    return data;
  }

  const isAbort = (err) => err?.name === 'AbortError';

  // ---------- List ----------

  function renderList() {
    const note = videosError
      ? `<div class="prints-muted prints-list-note">Không đọc được timelapse trên máy in: ${escapeHtml(videosError)}</div>`
      : '';
    if (prints.length === 0 && videos.length === 0) {
      list.innerHTML = `${note}
        <div class="prints-empty">
          Chưa có bản in nào. Mỗi lần Bambu Studio gửi lệnh in, bản in được ghi lại tự động kèm preset và setting;
          khi in xong, gateway chụp một ảnh từ camera. Bạn có thể thêm ảnh và báo cáo kết quả cho từng bản in.
          Bật <b>Timelapse</b> trong hộp gửi lệnh in của Studio để máy in quay video bản in.
        </div>`;
    } else {
      const full = selected.length >= 2;
      list.innerHTML =
        note +
        historyItems(prints, videos)
          .map(({ print, video }) =>
            print
              ? renderPrintRow(print, { outcomes, selected: selected.includes(print.id), selectDisabled: full, video })
              : renderVideoRow(video)
          )
          .join('');
    }
    updateCompareButton();
  }

  function updateCompareButton() {
    btnCompare.disabled = selected.length !== 2;
    selectionNote.textContent =
      selected.length === 0 ? 'Tích 2 bản in để so sánh.' : `Đã chọn ${selected.length}/2 bản in để so sánh.`;
  }

  /** `manual` reports errors as a toast; the periodic refresh only shows them in the list */
  async function loadList(manual = false) {
    if (loading || disposed) return;
    loading = true;
    btnRefresh.classList.add('is-loading');
    try {
      const readVideos = manual || Date.now() - videosAt >= VIDEOS_REFRESH_MS;
      const [data] = await Promise.all([
        fetchJson(`/api/prints?limit=${LIST_LIMIT}`),
        readVideos &&
          fetchJson(`/api/timelapse${manual ? '?refresh=1' : ''}`).then(
            (d) => {
              videos = d.videos ?? [];
              videosAt = Date.now();
              videosError = null;
            },
            (err) => {
              if (isAbort(err)) throw err;
              // The history still shows without the printer; read again on the next refresh
              videosError = err.message;
            }
          ),
      ]);
      if (disposed) return;
      prints = data.prints ?? [];
      outcomes = data.outcomes ?? [];
      issues = data.issues ?? [];
      settingLabels = data.setting_labels ?? {};
      lastLoad = Date.now();
      selected = selected.filter((id) => prints.some((p) => p.id === id));
      renderList();
    } catch (err) {
      if (isAbort(err) || disposed) return;
      if (manual) showToast(err.message, 'error');
      if (prints.length === 0) {
        list.innerHTML = `<div class="prints-empty">❌ Không tải được lịch sử in: ${escapeHtml(err.message)}</div>`;
      }
    } finally {
      loading = false;
      btnRefresh.classList.remove('is-loading');
    }
  }

  list.addEventListener('change', (e) => {
    const input = e.target.closest?.('.print-select-input');
    if (!input) return;
    const id = input.dataset.id;
    selected = input.checked ? [...selected.filter((s) => s !== id), id].slice(-2) : selected.filter((s) => s !== id);
    renderList();
  });

  list.addEventListener('click', (e) => {
    const open = e.target.closest?.('.print-row-open');
    if (!open) return;
    if (!open.dataset.name) return void openDetail(open.dataset.id);
    const video = videos.find((v) => v.name === open.dataset.name);
    if (!video) return;
    closeModal?.();
    closeModal = openTimelapsePlayer(video, { showToast, addLog });
  });

  btnRefresh.addEventListener('click', () => loadList(true));
  btnCompare.addEventListener('click', () => {
    if (selected.length === 2) openCompare(selected[0], selected[1]);
  });

  // Refresh every minute while the tab is visible; catch up as soon as it's shown again
  const refreshTimer = setInterval(() => {
    if (!document.hidden) loadList();
  }, REFRESH_MS);
  const onVisibility = () => {
    if (!document.hidden && Date.now() - lastLoad >= REFRESH_MS) loadList();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // ---------- Modal (detail / compare) ----------

  function openModal(title, wide = false) {
    closeModal?.();
    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop prints-backdrop';
    backdrop.innerHTML = `
      <div class="modal-content prints-modal${wide ? ' is-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="printsModalTitle">
        <div class="modal-header">
          <h3 id="printsModalTitle" class="prints-modal-title"></h3>
          <button type="button" class="btn-close-modal" aria-label="Đóng">&times;</button>
        </div>
        <div class="prints-modal-body"><div class="prints-empty">⏳ Đang tải...</div></div>
      </div>`;
    backdrop.querySelector('.prints-modal-title').textContent = title;
    const body = backdrop.querySelector('.prints-modal-body');
    const closeBtn = backdrop.querySelector('.btn-close-modal');

    const onKey = (e) => {
      // confirmDialog handles its own Esc first (and marks it handled)
      if (e.key === 'Escape' && !e.defaultPrevented) close();
    };
    function close() {
      if (closeModal !== close) return;
      closeModal = null;
      document.removeEventListener('keydown', onKey);
      backdrop.classList.remove('open');
      setTimeout(() => backdrop.remove(), 200);
      previousFocus?.focus?.({ preventScroll: true });
    }
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('open'));
    closeBtn.focus({ preventScroll: true });
    closeModal = close;
    return {
      body,
      setTitle: (t) => (backdrop.querySelector('.prints-modal-title').textContent = t),
      isOpen: () => closeModal === close,
    };
  }

  function photosHtml(print, { deletable = false } = {}) {
    if (!print.photos?.length) return '<div class="prints-muted">Chưa có ảnh.</div>';
    return `<div class="print-photos">${print.photos
      .map((photo) => {
        const url = escapeHtml(photoUrl(print.id, photo.name));
        const source = photo.source === 'camera' ? '📹 Camera' : '📷 Tải lên';
        return `
          <figure class="print-photo">
            <a href="${url}" target="_blank" rel="noopener noreferrer" title="Mở ảnh gốc">
              <img src="${url}" alt="${escapeHtml(photo.name)}" loading="lazy" />
            </a>
            <figcaption>
              <span>${source} · ${escapeHtml(formatPrintTime(photo.taken_at))}</span>
              ${deletable ? `<button type="button" class="print-photo-delete" data-name="${escapeHtml(photo.name)}" title="Xóa ảnh">🗑</button>` : ''}
            </figcaption>
          </figure>`;
      })
      .join('')}</div>`;
  }

  function timeRange(print) {
    const start = formatPrintTime(print.started_at);
    return print.ended_at ? `${start} → ${formatPrintTime(print.ended_at)}` : start;
  }

  function reportHtml(feedback) {
    if (!feedback) return '<div class="prints-muted">Chưa có báo cáo.</div>';
    const issueList = feedback.issues?.length
      ? `<ul class="print-issues">${feedback.issues.map((i) => `<li>${escapeHtml(labelOf(issues, i))}</li>`).join('')}</ul>`
      : '';
    const note = feedback.note ? `<div class="print-note">${escapeHtml(feedback.note)}</div>` : '';
    return `
      <div class="print-report">
        <div>${outcomeBadge(feedback.outcome, outcomes)} <span class="prints-muted">${escapeHtml(formatPrintTime(feedback.at))}</span></div>
        ${issueList}${note}
      </div>`;
  }

  function setupHtml(setup) {
    if (!setup) return `<div class="prints-muted">${NO_SETUP_TEXT}</div>`;
    const filaments = (setup.filaments ?? [])
      .map((f) => escapeHtml(f.type ? `${f.preset} (${f.type})` : f.preset))
      .join('<br />');
    const objects = (setup.objects ?? [])
      .map((o) => {
        const size = Array.isArray(o.size_mm) ? ` — ${o.size_mm.map((n) => Math.round(Number(n) * 10) / 10).join(' × ')} mm` : '';
        return escapeHtml(`${o.name}${size}`);
      })
      .join('<br />');
    const rows = [
      ['Máy in', escapeHtml(setup.printer_preset)],
      ['Process', escapeHtml(setup.process_preset)],
      ['Nhựa', filaments || '—'],
      ['Đầu phun', setup.nozzle_diameters?.length ? escapeHtml(`${setup.nozzle_diameters.join(' / ')} mm`) : '—'],
      ['Vật thể', objects || '—'],
      ['Đề xuất AI', setup.ai_session_id ? `<code>${escapeHtml(setup.ai_session_id)}</code>` : 'Không'],
    ];
    return `<dl class="print-setup">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  }

  function feedbackFormHtml(feedback) {
    const outcome = feedback?.outcome ?? '';
    const ticked = new Set(feedback?.issues ?? []);
    return `
      <form class="print-feedback-form" hidden>
        <fieldset>
          <legend>Kết quả</legend>
          ${outcomes
            .map(
              (o) => `<label class="print-choice"><input type="radio" name="outcome" value="${escapeHtml(o.id)}"${o.id === outcome ? ' checked' : ''} /> ${escapeHtml(o.label)}</label>`
            )
            .join('')}
        </fieldset>
        <fieldset>
          <legend>Vấn đề gặp phải</legend>
          <div class="print-issue-grid">
            ${issues
              .map(
                (i) => `<label class="print-choice"><input type="checkbox" name="issues" value="${escapeHtml(i.id)}"${ticked.has(i.id) ? ' checked' : ''} /> ${escapeHtml(i.label)}</label>`
              )
              .join('')}
          </div>
        </fieldset>
        <textarea name="note" rows="3" maxlength="4000" placeholder="Ghi chú thêm (không bắt buộc)">${escapeHtml(feedback?.note ?? '')}</textarea>
        <div class="print-form-actions">
          <button type="button" class="btn-ams-action print-feedback-cancel">Hủy</button>
          <button type="submit" class="btn-ams-action btn-ams-primary">💾 Lưu báo cáo</button>
        </div>
      </form>`;
  }

  function settingsTableHtml(rows) {
    if (rows.length === 0) return '<div class="prints-muted">Không có setting nào khớp.</div>';
    return `
      <div class="print-table-wrap">
        <table class="print-settings-table">
          <tbody>
            ${rows
              .map(
                (r) => `<tr><th>${r.label ? `${escapeHtml(r.label)}<code>${escapeHtml(r.key)}</code>` : `<code>${escapeHtml(r.key)}</code>`}</th><td>${escapeHtml(r.value)}</td></tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`;
  }

  async function openDetail(id) {
    const summary = prints.find((p) => p.id === id);
    const modal = openModal(summary?.job_name ?? 'Bản in', true);
    let showAll = false;
    let filter = '';

    async function load() {
      try {
        const { print } = await fetchJson(`/api/prints/${encodeURIComponent(id)}`);
        if (!modal.isOpen()) return;
        render(print);
      } catch (err) {
        if (isAbort(err) || !modal.isOpen()) return;
        modal.body.innerHTML = `<div class="prints-empty">❌ ${escapeHtml(err.message)}</div>`;
      }
    }

    function render(print) {
      modal.setTitle(print.job_name);
      const settings = printSettings(print.setup);
      modal.body.innerHTML = `
        <div class="print-detail-head">
          ${statusBadge(print.status)}
          <span class="prints-muted">${escapeHtml(timeRange(print))}</span>
        </div>

        <section class="print-section">
          <div class="print-section-head">
            <h4>Ảnh</h4>
            <label class="btn-ams-action print-upload-btn">
              <input type="file" class="print-upload-input" accept="image/jpeg,image/png,image/webp" multiple hidden />
              📷 Thêm ảnh
            </label>
          </div>
          <div class="prints-muted print-upload-status" hidden></div>
          ${photosHtml(print, { deletable: true })}
        </section>

        <section class="print-section print-timelapse" hidden></section>
        <section class="print-section print-video-review"${print.video_review ? '' : ' hidden'}>
          ${print.video_review ? `<h4>🤖 AI nhận xét timelapse</h4>${renderReview(print.video_review, { outcomes, issues })}` : ''}
        </section>

        <section class="print-section">
          <h4>Thiết lập khi in</h4>
          ${setupHtml(print.setup)}
        </section>

        <section class="print-section">
          <div class="print-section-head">
            <h4>Báo cáo kết quả</h4>
            <button type="button" class="btn-ams-action print-feedback-edit">${print.feedback ? '✏️ Sửa báo cáo' : '➕ Thêm báo cáo'}</button>
          </div>
          <div class="print-report-view">${reportHtml(print.feedback)}</div>
          ${feedbackFormHtml(print.feedback)}
        </section>

        <section class="print-section">
          <div class="print-section-head">
            <h4>Setting</h4>
            ${settings ? `<label class="print-choice"><input type="checkbox" class="print-settings-all"${showAll ? ' checked' : ''} /> Hiện tất cả setting</label>` : ''}
          </div>
          ${settings ? `<input type="search" class="print-settings-filter" placeholder="Lọc theo tên, khóa hoặc giá trị..." value="${escapeHtml(filter)}"${showAll ? '' : ' hidden'} />` : ''}
          <div class="print-settings">${settings ? '' : `<div class="prints-muted">${NO_SETUP_TEXT}</div>`}</div>
        </section>`;

      const body = modal.body;
      const settingsBox = body.querySelector('.print-settings');
      const renderSettings = () => {
        if (settings) settingsBox.innerHTML = settingsTableHtml(listSettings(settings, settingLabels, { all: showAll, filter }));
      };
      renderSettings();

      body.querySelector('.print-settings-all')?.addEventListener('change', (e) => {
        showAll = e.target.checked;
        const filterInput = body.querySelector('.print-settings-filter');
        filterInput.hidden = !showAll;
        if (!showAll) filter = filterInput.value = '';
        renderSettings();
      });
      body.querySelector('.print-settings-filter')?.addEventListener('input', (e) => {
        filter = e.target.value;
        renderSettings();
      });

      // Timelapse: the printer's video of this print, when there is one (GET /api/timelapse pairs them)
      const timelapseBox = body.querySelector('.print-timelapse');
      (videosAt ? Promise.resolve({ videos }) : fetchJson('/api/timelapse'))
        .then(({ videos }) => {
          const video = videos.find((v) => v.print?.id === print.id);
          if (!video || !modal.isOpen() || !timelapseBox.isConnected) return;
          const src = `/api/timelapse/${encodeURIComponent(video.name)}`;
          timelapseBox.innerHTML = `
            <div class="print-section-head">
              <h4>Timelapse</h4>
              <a class="btn-ams-action" href="${escapeHtml(src)}" download="${escapeHtml(video.name)}">⬇ Tải về</a>
            </div>
            <video class="timelapse-video" controls playsinline preload="metadata" src="${escapeHtml(src)}"></video>`;
          timelapseBox.hidden = false;
          // The review then shows with its button beside the video, instead of on its own
          const reviewBox = body.querySelector('.print-video-review');
          reviewBox.hidden = false;
          mountReview(reviewBox, video, { showToast, addLog, printId: print.id });
        })
        .catch(() => {
          // No timelapse section when the printer can't be read: the rest of the print still shows
        });

      // Photos: upload one by one, then reload the print and the list
      const uploadLabel = body.querySelector('.print-upload-btn');
      const uploadInput = body.querySelector('.print-upload-input');
      const uploadStatus = body.querySelector('.print-upload-status');
      uploadInput.addEventListener('change', async () => {
        const files = [...(uploadInput.files ?? [])];
        uploadInput.value = '';
        if (files.length === 0) return;
        uploadLabel.classList.add('disabled');
        uploadStatus.hidden = false;
        let sent = 0;
        try {
          for (const [i, file] of files.entries()) {
            uploadStatus.textContent = `⏳ ${files.length > 1 ? `(${i + 1}/${files.length}) ` : ''}Đang tải ${file.name}...`;
            const form = new FormData();
            form.append('file', file);
            await fetchJson(`/api/prints/${encodeURIComponent(print.id)}/photos`, { method: 'POST', body: form });
            sent++;
          }
          addLog(`Đã thêm ${sent} ảnh cho bản in "${print.job_name}".`, 'success');
        } catch (err) {
          if (isAbort(err)) return;
          showToast(err.message, 'error');
        } finally {
          uploadLabel.classList.remove('disabled');
        }
        if (sent > 0 && modal.isOpen()) {
          await load();
          loadList();
        } else {
          uploadStatus.hidden = true;
        }
      });

      body.querySelectorAll('.print-photo-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          const ok = await confirmDialog({
            title: 'Xóa ảnh?',
            message: `Xóa ảnh ${name} khỏi bản in "${print.job_name}"? Không thể hoàn tác.`,
            confirmText: 'Xóa ảnh',
            danger: true,
          });
          if (!ok || !modal.isOpen()) return;
          btn.classList.add('is-loading');
          try {
            await fetchJson(photoUrl(print.id, name), { method: 'DELETE' });
            addLog(`Đã xóa ảnh ${name} của bản in "${print.job_name}".`, 'info');
            await load();
            loadList();
          } catch (err) {
            if (isAbort(err)) return;
            btn.classList.remove('is-loading');
            showToast(err.message, 'error');
          }
        });
      });

      // Report: inline form, a new report replaces the old one
      const form = body.querySelector('.print-feedback-form');
      const editBtn = body.querySelector('.print-feedback-edit');
      const reportView = body.querySelector('.print-report-view');
      const setEditing = (editing) => {
        form.hidden = !editing;
        editBtn.hidden = editing;
        reportView.hidden = editing && !print.feedback;
      };
      editBtn.addEventListener('click', () => setEditing(true));
      form.querySelector('.print-feedback-cancel').addEventListener('click', () => setEditing(false));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const outcome = form.querySelector('input[name="outcome"]:checked')?.value;
        if (!outcome) {
          showToast('Hãy chọn kết quả của bản in.', 'error');
          return;
        }
        const payload = {
          outcome,
          issues: [...form.querySelectorAll('input[name="issues"]:checked')].map((i) => i.value),
          note: form.querySelector('textarea[name="note"]').value.trim(),
        };
        const submit = form.querySelector('button[type="submit"]');
        submit.classList.add('is-loading');
        try {
          await fetchJson(`/api/prints/${encodeURIComponent(print.id)}/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          showToast('Đã lưu báo cáo.', 'success');
          addLog(`Đã lưu báo cáo cho bản in "${print.job_name}": ${labelOf(outcomes, outcome)}.`, 'success');
          await load();
          loadList();
        } catch (err) {
          if (isAbort(err)) return;
          submit.classList.remove('is-loading');
          showToast(err.message, 'error');
        }
      });
    }

    await load();
  }

  // ---------- Compare ----------

  function compareColumnHtml(print, tag) {
    const fb = print.feedback;
    return `
      <div class="print-compare-col">
        <div class="print-compare-tag">${tag}</div>
        <div class="print-row-title">${escapeHtml(print.job_name)}</div>
        <div class="print-detail-head">${statusBadge(print.status)} <span class="prints-muted">${escapeHtml(timeRange(print))}</span></div>
        <div class="prints-muted">${print.setup ? escapeHtml(print.setup.process_preset) : NO_SETUP_TEXT}</div>
        ${photosHtml(print)}
        ${reportHtml(fb)}
      </div>`;
  }

  async function openCompare(idA, idB) {
    const modal = openModal('So sánh 2 bản in', true);
    try {
      const [{ print: p1 }, { print: p2 }] = await Promise.all([
        fetchJson(`/api/prints/${encodeURIComponent(idA)}`),
        fetchJson(`/api/prints/${encodeURIComponent(idB)}`),
      ]);
      if (!modal.isOpen()) return;
      // Older print on the left (A), newer on the right (B)
      const time = (p) => Date.parse(p.started_at ?? p.ended_at ?? '') || 0;
      const [a, b] = time(p1) <= time(p2) ? [p1, p2] : [p2, p1];
      const diff = diffSettings(printSettings(a.setup), printSettings(b.setup), settingLabels);

      let settingsHtml;
      if (!diff) {
        const missing = [a, b].filter((p) => !p.setup).map((p) => `"${escapeHtml(p.job_name)}"`).join(' và ');
        settingsHtml = `<div class="prints-muted">${NO_SETUP_TEXT}: ${missing}.</div>`;
      } else if (diff.length === 0) {
        settingsHtml = '<div class="prints-muted">Hai bản in dùng cùng một bộ setting.</div>';
      } else {
        const cell = (v) => (v === null ? '<span class="prints-muted">(không có)</span>' : escapeHtml(v));
        settingsHtml = `
          <div class="print-table-wrap">
            <table class="print-settings-table print-diff-table">
              <thead><tr><th>Setting</th><th>A</th><th>B</th></tr></thead>
              <tbody>
                ${diff
                  .map(
                    (r) => `<tr><th>${r.label ? `${escapeHtml(r.label)}<code>${escapeHtml(r.key)}</code>` : `<code>${escapeHtml(r.key)}</code>`}</th><td class="is-diff">${cell(r.a)}</td><td class="is-diff">${cell(r.b)}</td></tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>`;
      }

      modal.body.innerHTML = `
        <div class="print-compare">
          ${compareColumnHtml(a, 'A')}
          ${compareColumnHtml(b, 'B')}
        </div>
        <section class="print-section">
          <h4>Setting khác nhau${diff?.length ? ` (${diff.length})` : ''}</h4>
          ${settingsHtml}
        </section>`;
    } catch (err) {
      if (isAbort(err) || !modal.isOpen()) return;
      modal.body.innerHTML = `<div class="prints-empty">❌ ${escapeHtml(err.message)}</div>`;
    }
  }

  // Started here rather than in the markup so it loads after the dashboard login (session cookie).
  loadList();

  return () => {
    disposed = true;
    controller.abort();
    clearInterval(refreshTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    closeModal?.();
  };
}
