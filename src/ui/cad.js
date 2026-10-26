/**
 * "Thiết kế mô hình bằng AI", two kinds of models in one list (GET /api/cad/jobs):
 * - technical (POST /api/cad/jobs): Claude writes and checks build123d code in the CAD container; models built
 *   from Antigravity (MCP bambu-cad) show up too. Downloads STL, STEP and code; "revise" asks Claude to change it.
 * - figures (POST /api/cad/meshes): Hunyuan3D-2 on the GPU turns an uploaded picture, or one drawn from the
 *   description, into a mesh sized for printing. Downloads STL; "make again" tries another seed; "Claude review"
 *   (POST /api/cad/jobs/:id/fix) has Claude check it against its picture and fix it with mesh code, as a new job.
 * Every finished model has a preview and "send to Studio".
 */
import { escapeHtml, formatPrintTime } from './prints';
import { deltaLabel } from '../domain/filaments/colourMixing';

const BUSY_REFRESH_MS = 3000;
const IDLE_REFRESH_MS = 30_000;
const LIST_LIMIT = 30;

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
function formatProgress(progress) {
  if (!progress?.total) return progress?.done ? `${progress.done.toLocaleString('vi-VN')} ${progress.unit ?? ''}`.trim() : '';
  const percent = Math.min(100, Math.round((progress.done / progress.total) * 100));
  return `${progress.done.toLocaleString('vi-VN')}/${progress.total.toLocaleString('vi-VN')} ${progress.unit ?? ''} · ${percent}%`;
}

/** The timeline of a job's steps: done (with their time), the current one (with its progress), and those ahead */
export function renderSteps(job, now = Date.now()) {
  const steps = job.steps ?? [];
  if (steps.length === 0) return '';
  const busy = isBusy(job);
  const stopped = job.state === 'failed' || job.state === 'cancelled';
  const shown = steps.slice(-MAX_STEPS_SHOWN);
  const items = shown.map((step, index) => {
    const last = index === shown.length - 1;
    const current = busy && last && !step.finished_at;
    const broken = stopped && last;
    const retry = !current && String(step.detail ?? '').includes('✗');
    const kind = current ? 'current' : broken ? 'failed' : retry ? 'retry' : 'done';
    const icon = { current: '⏳', failed: job.state === 'cancelled' ? '⏹' : '✗', retry: '↻', done: '✓' }[kind];
    const end = step.finished_at ? time(step.finished_at) : current || broken ? now : NaN;
    const took = Number.isFinite(end - time(step.started_at)) ? formatDuration(end - time(step.started_at)) : '';
    const progress = current && job.progress ? job.progress : null;
    const bar = progress?.total
      ? `<div class="cad-step-bar"><span style="width:${Math.min(100, (progress.done / progress.total) * 100).toFixed(1)}%"></span></div>`
      : '';
    return `<li class="cad-step is-${kind}">
        <span class="cad-step-icon">${icon}</span>
        <span class="cad-step-main">
          <span class="cad-step-label">${escapeHtml(STEP_LABELS[step.id] ?? step.id)}</span>
          ${step.detail ? `<span class="cad-step-detail">${escapeHtml(step.detail)}</span>` : ''}
          ${progress ? `<span class="cad-step-detail">${escapeHtml(formatProgress(progress))}</span>` : ''}
          ${bar}
        </span>
        <span class="cad-step-time">${escapeHtml(took)}</span>
      </li>`;
  });

  // A figure's steps still ahead
  if (busy && job.source === 'mesh') {
    const plan = figurePlan(job);
    const at = plan.indexOf(job.step);
    for (const id of at >= 0 ? plan.slice(at + 1).filter((id) => !MAYBE_STEPS.has(id)) : []) {
      items.push(`<li class="cad-step is-ahead"><span class="cad-step-icon">○</span><span class="cad-step-main"><span class="cad-step-label">${escapeHtml(STEP_LABELS[id])}</span></span><span class="cad-step-time"></span></li>`);
    }
  }
  const hidden = steps.length - shown.length;
  return `<ol class="cad-steps">${hidden ? `<li class="cad-step is-more">… ${hidden} bước trước</li>` : ''}${items.join('')}</ol>`;
}

const HINTS = {
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

const REVISE_PLACEHOLDERS = {
  technical: 'Cần sửa gì? Ví dụ: dày thêm 1 mm, bo tròn các góc',
  figure: 'Cần sửa gì? Để trống: Claude tự tìm lỗi (chân cụt, mảnh rời, bề mặt sần, lỗ hở…). Ví dụ: chân bị cụt, tóc quá mảnh',
};

const PLACEHOLDERS = {
  technical: 'Mô tả mô hình cần in, càng rõ kích thước càng tốt. Ví dụ: giá đỡ điện thoại nghiêng 60°, rộng 80 mm, dày 3 mm, có rãnh luồn cáp sạc.',
  figure: 'Mô tả nhân vật hoặc đồ trang trí (không bắt buộc khi có ảnh). Ví dụ: chú mèo béo ngồi đội mũ phù thủy, phong cách chibi.',
};

const isBusy = (job) => job.state === 'running' || job.state === 'queued';

/** "60 × 40 × 20 mm", or null without a size */
export function formatSize(sizeMm) {
  if (!Array.isArray(sizeMm) || sizeMm.length !== 3) return null;
  return `${sizeMm.map((v) => Number(v).toLocaleString('vi-VN', { maximumFractionDigits: 1 })).join(' × ')} mm`;
}

const fileUrl = (job, name, download = false) =>
  `/api/cad/jobs/${encodeURIComponent(job.id)}/files/${name}?v=${encodeURIComponent(job.finished_at ?? job.state)}${download ? '&download=1' : ''}`;

const list = (items) => (items?.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '');

/**
 * One filament of a coloured figure: slot, colour, share and name; how far it is from the model's own colour
 * there (Lab ΔE); and when far, the Bambu Studio mixing recipe that comes closest
 */
export function renderPaletteEntry(p) {
  const swatch = (hex) => `<i style="background:${escapeHtml(hex)}"></i>`;
  const off = typeof p.delta_e === 'number' && p.delta_e > 2.5;
  const level = off ? deltaLabel(p.delta_e) : null;
  const deviation = off
    ? `<span class="cad-delta cad-delta-${level === 'lệch rõ' ? 'far' : level === 'hơi lệch' ? 'off' : 'near'}" title="Màu gốc của mô hình ${escapeHtml(p.source_hex)}, ΔE ${p.delta_e}">${swatch(p.source_hex)}${escapeHtml(`gốc ${p.source_hex} · ${level}`)}</span>`
    : '';
  const mix = p.mix
    ? `<div class="cad-mix">↳ Trộn trong Studio: ${p.mix.components
        .map((c) => `${swatch(c.hex)}${escapeHtml(`${c.name ?? c.key} ${c.percent}%`)}`)
        .join(' + ')} → ${swatch(p.mix.hex)}${escapeHtml(`${p.mix.hex} (${deltaLabel(p.mix.delta_e)}, ΔE ${p.mix.delta_e})`)}</div>`
    : '';
  const origin = ORIGINS[p.origin];
  const badge = origin ? `<span class="cad-origin cad-origin-${escapeHtml(p.origin)}">${escapeHtml(origin)}</span>` : '';
  return `<div class="cad-swatch-row"><span class="cad-swatch">${swatch(p.hex)}${escapeHtml(
    `${p.slot}. ${p.hex} ${Math.round(p.share * 100)}%${p.label ? ` · ${p.label}` : ''}`
  )}</span>${badge}${deviation}${mix}</div>`;
}

/** Where a filament on a figure's palette comes from */
const ORIGINS = { ams: '✓ có trong AMS', custom: '✓ trong kho của bạn', bambu: '🛒 cần mua / nạp' };

/** "claude-opus-5-5" → "opus 5.5" */
const modelName = (model) => (model ?? 'Claude').replace('claude-', '').replace(/-(\d)-(\d)$/, ' $1.$2');

/** Claude's review of a figure: each problem, fixed or not, and how */
function renderIssues(issues) {
  if (!issues?.length) return '';
  const items = issues.map(
    (i) => `<li class="cad-issue ${i.fixed ? 'is-fixed' : 'is-open'}">${i.fixed ? '✓' : '✗'} <b>${escapeHtml(i.problem)}</b>${i.how ? `: ${escapeHtml(i.how)}` : ''}</li>`
  );
  return `<b>Claude đã xem (${issues.filter((i) => i.fixed).length}/${issues.length} lỗi đã sửa)</b><ul class="cad-issues">${items.join('')}</ul>`;
}

/** One model as HTML (every value from the API escaped); `now` times the running step */
export function renderJob(job, now = Date.now()) {
  const busy = isBusy(job);
  const size = formatSize(job.report?.size_mm);
  const figure = job.source === 'mesh';
  // Claude reviewing and fixing a figure
  const fix = figure && job.input === 'fix';
  const source = fix
    ? `Claude sửa · ${modelName(job.model)}`
    : figure
      ? 'Hunyuan3D'
      : job.source === 'code'
        ? 'Antigravity / code'
        : modelName(job.model);
  const preview = job.files?.preview
    ? `<a href="${escapeHtml(fileUrl(job, 'preview.png'))}" target="_blank" rel="noopener"><img src="${escapeHtml(fileUrl(job, 'preview.png'))}" alt="Ảnh xem trước" loading="lazy" /></a>`
    : `<div class="cad-preview-empty">${busy ? '⏳' : '—'}</div>`;

  const started = time(job.steps?.[0]?.started_at ?? job.started_at ?? job.created_at);
  const ended = job.finished_at ? time(job.finished_at) : busy ? now : NaN;
  const total = Number.isFinite(ended - started) ? formatDuration(ended - started) : '';
  const progress = busy
    ? `<div class="cad-progress">⏳ ${escapeHtml(STEP_LABELS[job.step] ?? 'Đang chờ container')}${job.builds ? ` · đã dựng ${job.builds} lần` : ''}${total ? ` · ${escapeHtml(total)}` : ''}</div>`
    : '';
  const timeline = job.steps?.length
    ? busy
      ? renderSteps(job, now)
      : `<details class="cad-details cad-timeline"><summary>Các bước (${job.steps.length}${total ? `, ${escapeHtml(total)}` : ''})</summary>${renderSteps(job, now)}</details>`
    : '';
  const notes = job.notes?.length ? `<div class="cad-notes">${job.notes.slice(busy ? -5 : -3).map((n) => `<div>${escapeHtml(n)}</div>`).join('')}</div>` : '';
  const error = job.error && job.state !== 'cancelled' ? `<div class="cad-error">❌ ${escapeHtml(job.error)}</div>` : '';
  const warnings = [...(job.report?.warnings ?? []), ...(job.result?.warnings ?? [])];
  const report = job.report?.ok
    ? `<div class="cad-facts">${[size, job.report.volume_cm3 != null ? `${job.report.volume_cm3} cm³` : null, job.report.mesh?.watertight ? 'lưới kín' : 'lưới hở']
        .filter(Boolean)
        .map(escapeHtml)
        .join(' · ')}</div>`
    : '';
  const details = job.result
    ? `<details class="cad-details"${fix ? ' open' : ''}><summary>${figure && !fix ? 'Chi tiết' : 'Chi tiết từ Claude'}</summary>
        <p>${escapeHtml(job.result.summary)}</p>
        ${renderIssues(job.result.issues)}
        ${job.result.assumptions?.length ? `<b>Giả định</b>${list(job.result.assumptions)}` : ''}
        ${job.result.parameters?.length ? `<b>${figure ? 'Thông số' : 'Tham số trong code'}</b>${list(job.result.parameters.map((p) => `${p.name} = ${p.value}: ${p.description}`))}` : ''}
      </details>`
    : '';
  const palette = job.report?.palette?.length
    ? `<div class="cad-palette">${job.report.palette
        .filter((p) => p.share > 0)
        .map((p) => renderPaletteEntry(p))
        .join('')}</div>`
    : '';
  const sent = job.sent?.length ? `<div class="studio-note">📤 Đã gửi: ${escapeHtml(job.sent.map((s) => `/imports/${s.name}`).join(', '))}</div>` : '';

  const done = job.state === 'done';
  const actions = [
    busy && job.source !== 'code' ? `<button type="button" class="btn-ams-action" data-action="cancel">⏹ Hủy</button>` : '',
    done
      ? job.files?.threemf
        ? `<button type="button" class="btn-ams-action btn-ams-primary" data-action="studio" data-format="3mf" title="3MF đã tô sẵn màu: filament n trong Studio là màu số n">📤 Gửi sang Studio (có màu)</button>`
        : `<button type="button" class="btn-ams-action btn-ams-primary" data-action="studio" data-format="stl">📤 Gửi sang Studio</button>`
      : '',
    done && job.files?.threemf ? `<a class="btn-ams-action" href="${escapeHtml(fileUrl(job, 'model.3mf', true))}">⬇ 3MF màu</a>` : '',
    done ? `<a class="btn-ams-action" href="${escapeHtml(fileUrl(job, 'model.stl', true))}">⬇ STL</a>` : '',
    done && job.files?.step ? `<a class="btn-ams-action" href="${escapeHtml(fileUrl(job, 'model.step', true))}">⬇ STEP</a>` : '',
    job.files?.code ? `<a class="btn-ams-action" href="${escapeHtml(fileUrl(job, 'model.py'))}" target="_blank" rel="noopener">📄 Code</a>` : '',
    !busy && job.files?.code ? `<button type="button" class="btn-ams-action" data-action="revise">✏️ Sửa</button>` : '',
    job.files?.concept ? `<a class="btn-ams-action" href="${escapeHtml(fileUrl(job, 'concept.png'))}" target="_blank" rel="noopener">🖼 Ảnh gốc</a>` : '',
    job.files?.views ? `<a class="btn-ams-action" href="${escapeHtml(fileUrl(job, 'views.png'))}" target="_blank" rel="noopener" title="Mô hình nhìn từ 6 phía, như Claude đã xem">👁 6 phía</a>` : '',
    job.files?.fix ? `<a class="btn-ams-action" href="${escapeHtml(fileUrl(job, 'fix.py'))}" target="_blank" rel="noopener">📄 fix.py</a>` : '',
    figure && done
      ? `<button type="button" class="btn-ams-action" data-action="revise" title="Claude so mô hình với ảnh gốc, xem từ 6 phía, rồi sửa: chân cụt, mảnh rời, bề mặt sần, lỗ hở… Bản sửa là mô hình mới, bản này giữ nguyên">🔍 Claude review &amp; sửa</button>`
      : '',
    figure && !fix && !busy ? `<button type="button" class="btn-ams-action" data-action="again" title="Dựng lại từ cùng ảnh/mô tả với số ngẫu nhiên khác">🎲 Tạo lại</button>` : '',
  ].join('');

  return `
    <div class="cad-preview">${preview}</div>
    <div class="cad-body">
      <div class="cad-title-row">
        <span class="cad-title">${escapeHtml(job.title || job.prompt)}</span>
        <span class="print-badge cad-state-${escapeHtml(job.state)}">${escapeHtml(STATE_LABELS[job.state] ?? job.state)}</span>
      </div>
      <div class="cad-meta">${escapeHtml(formatPrintTime(job.created_at))} · ${escapeHtml(source)}${job.parent_id ? ' · bản sửa' : ''}</div>
      ${job.title && job.title !== job.prompt ? `<div class="cad-prompt-text" title="Bấm để xem hết / thu gọn">${escapeHtml(job.prompt)}</div>` : ''}
      ${progress}${timeline}${notes}${error}${report}
      ${warnings.length ? `<div class="cad-warnings">⚠️ ${warnings.map(escapeHtml).join('<br />⚠️ ')}</div>` : ''}
      ${palette}${details}${sent}
      <div class="cad-actions">${actions}</div>
      <form class="cad-revise" data-kind="${figure ? 'fix' : 'revise'}" hidden>
        <input type="text" class="cad-revise-input" maxlength="4000" placeholder="${escapeHtml(REVISE_PLACEHOLDERS[figure ? 'figure' : 'technical'])}" />
        <button type="submit" class="btn-ams-action btn-ams-primary">${figure ? 'Gửi Claude review' : 'Gửi Claude sửa'}</button>
      </form>
    </div>`;
}

export function initCad({ showToast, addLog }) {
  const $ = (id) => document.getElementById(id);
  const card = $('cadCard');
  const listEl = $('cadList');
  const form = $('cadForm');
  const promptEl = $('cadPrompt');
  const modelEl = $('cadModel');
  const createBtn = $('btnCadCreate');
  const statusEl = $('cadWorkerStatus');
  const kindEl = $('cadKind');
  const figureFields = $('cadFigureFields');
  const imageInput = $('cadImage');
  const imageName = $('cadImageName');
  const imageClear = $('btnCadImageClear');
  const heightEl = $('cadHeight');
  const baseEl = $('cadBase');
  const colourEl = $('cadColour');
  const colourFields = $('cadColourFields');
  const paletteEl = $('cadPalette');
  const coloursEl = $('cadColours');
  const coloursLabel = $('cadColoursLabel');
  const materialEl = $('cadMaterial');
  const paletteBambu = $('cadPaletteBambu');
  const customPick = $('cadCustomPick');
  const filamentsEl = $('cadFilaments');
  const filamentsSummary = $('cadFilamentsSummary');
  const filamentList = $('cadFilamentList');
  const filamentForm = $('cadFilamentForm');
  const filamentColour = $('cadFilamentColour');
  const filamentHex = $('cadFilamentHex');
  let customFilaments = [];
  // Filaments left unticked for painting; new ones start ticked
  const unticked = new Set();
  const hintEl = $('cadHint');
  // On the "Thiết kế AI" tab: shows while a model is being designed, seen from the other pages
  const tabDot = $('cadTabDot');
  if (!card || !listEl) return () => {};

  let disposed = false;
  let timer = null;
  let jobs = [];
  let config = null;
  let kind = 'technical';
  // Rendered HTML per job: a row is only replaced when it changed, so an open form or details stays open
  const rendered = new Map();

  async function api(method, url, body) {
    const form = body instanceof FormData;
    const res = await fetch(url, {
      method,
      headers: body === undefined || form ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined || form ? body : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error(data?.message || `Lỗi HTTP ${res.status}`);
    return data;
  }

  function render() {
    if (tabDot) tabDot.hidden = !jobs.some(isBusy);
    if (jobs.length === 0) {
      listEl.innerHTML = '<div class="prints-empty">Chưa có mô hình nào. Mô tả mô hình ở trên rồi bấm ✨ Tạo mô hình.</div>';
      rendered.clear();
      return;
    }
    listEl.querySelector('.prints-empty')?.remove();
    const rows = new Map([...listEl.querySelectorAll('.cad-row')].map((row) => [row.dataset.id, row]));
    jobs.forEach((job, index) => {
      const html = renderJob(job);
      let row = rows.get(job.id);
      if (!row) {
        row = document.createElement('div');
        row.className = 'cad-row';
        row.dataset.id = job.id;
      }
      if (rendered.get(job.id) !== html) {
        row.innerHTML = html;
        rendered.set(job.id, html);
      }
      if (listEl.children[index] !== row) listEl.insertBefore(row, listEl.children[index] ?? null);
      rows.delete(job.id);
    });
    for (const [id, row] of rows) {
      row.remove();
      rendered.delete(id);
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (!disposed) timer = setTimeout(refresh, jobs.some(isBusy) ? BUSY_REFRESH_MS : IDLE_REFRESH_MS);
  }

  async function refresh() {
    try {
      const before = new Map(jobs.map((job) => [job.id, job.state]));
      jobs = (await api('GET', `/api/cad/jobs?limit=${LIST_LIMIT}`)).jobs;
      for (const job of jobs) {
        if (before.get(job.id) === 'running' && job.state === 'done') {
          showToast(`Đã thiết kế xong: ${job.title || job.prompt}`, 'success');
          addLog(`AI đã thiết kế xong mô hình "${job.title || job.prompt}".`, 'success');
        } else if (before.get(job.id) === 'running' && job.state === 'failed') {
          showToast(`Thiết kế lỗi: ${job.error}`, 'error');
        }
      }
      render();
    } catch (err) {
      if (jobs.length === 0) listEl.innerHTML = `<div class="prints-empty">❌ ${escapeHtml(err.message)}</div>`;
    }
    schedule();
  }

  function added(job) {
    jobs = [job, ...jobs.filter((j) => j.id !== job.id)];
    render();
    schedule();
  }

  async function create(prompt, parentId) {
    const { job } = await api('POST', '/api/cad/jobs', { prompt, model: modelEl.value || undefined, ...(parentId && { parent_id: parentId }) });
    added(job);
    addLog(`Đã gửi Claude ${parentId ? 'sửa' : 'thiết kế'} mô hình: ${prompt}`, 'info');
  }

  /** A figure from the form: the picture if one is chosen, the description, the height and the plinth */
  async function createFigure(prompt) {
    const body = new FormData();
    body.append('prompt', prompt);
    body.append('height_mm', heightEl.value || '80');
    body.append('base', baseEl.checked ? 'true' : 'false');
    if (colourEl.checked) {
      body.append('colour', 'true');
      body.append('palette', paletteEl.value);
      body.append('colours', coloursEl.value || '4');
      if (paletteEl.value === 'bambu' || paletteEl.value === 'prefer') body.append('material', materialEl.value);
      if (paletteEl.value === 'custom' || paletteEl.value === 'prefer') {
        body.append('filaments', customFilaments.filter((f) => !unticked.has(f.id)).map((f) => f.id).join(','));
      }
    }
    const file = imageInput.files?.[0];
    if (file) body.append('image', file);
    const { job } = await api('POST', '/api/cad/meshes', body);
    added(job);
    addLog(`Đã gửi dựng mô hình nhân vật${file ? ` từ ảnh ${file.name}` : ''}: ${prompt || job.prompt}`, 'info');
  }

  /** Claude reviews a finished figure and fixes it (what `comment` says, or what it finds) */
  async function fixFigure(comment, parentId) {
    const { job } = await api('POST', `/api/cad/jobs/${encodeURIComponent(parentId)}/fix`, {
      prompt: comment,
      model: modelEl.value || undefined,
    });
    added(job);
    addLog(`Đã gửi Claude review và sửa mô hình nhân vật${comment ? `: ${comment}` : ''}`, 'info');
  }

  /** "Make again": same picture or description, same size and plinth, another seed */
  async function again(job) {
    const params = Object.fromEntries((job.result?.parameters ?? []).map((p) => [p.name, p.value]));
    // Coloured the same way: the report keeps how the colours were asked for
    const asked = job.report?.colour_request;
    const { job: next } = await api('POST', '/api/cad/meshes', {
      parent_id: job.id,
      ...(params.height_mm && { height_mm: params.height_mm }),
      base: Boolean(params.base),
      ...(params.colours > 0 && { colour: true, colours: params.colours, ...(asked ?? {}) }),
    });
    added(next);
  }

  function showImageName() {
    const file = imageInput.files?.[0];
    imageName.textContent = file ? file.name : 'Chưa chọn ảnh: AI sẽ vẽ ảnh từ mô tả';
    imageClear.hidden = !file;
  }

  imageInput?.addEventListener('change', showImageName);

  function showColourFields() {
    colourFields.hidden = !colourEl.checked;
    // The AMS decides how many colours; Bambu's colours come from one material or family; custom ones are ticked
    const mode = paletteEl.value;
    coloursLabel.hidden = mode === 'ams';
    materialEl.hidden = mode !== 'bambu' && mode !== 'prefer';
    // "Theo nhựa trong AMS" only means something when preferring what is loaded
    materialEl.querySelector('option[value=""]')?.toggleAttribute('hidden', mode !== 'prefer');
    if (mode === 'bambu' && !materialEl.value) materialEl.value = 'PLA Basic';
    if (mode === 'prefer' && !materialEl.dataset.touched) materialEl.value = '';
    customPick.hidden = !colourEl.checked || (mode !== 'custom' && mode !== 'prefer');
    if (!customPick.hidden && customFilaments.length < 2) filamentsEl.open = true;
  }
  colourEl?.addEventListener('change', showColourFields);
  paletteEl?.addEventListener('change', showColourFields);
  materialEl?.addEventListener('change', () => {
    materialEl.dataset.touched = '1';
  });

  // ---------- "Filament của tôi" ----------

  function renderFilaments() {
    filamentsSummary.textContent = `🎨 Filament của tôi (${customFilaments.length})`;
    const swatch = (hex) => `<i style="background:${escapeHtml(hex)}"></i>`;
    filamentList.innerHTML = customFilaments.length
      ? customFilaments
          .map(
            (f) => `<div class="cad-filament" data-id="${escapeHtml(f.id)}"><span class="cad-swatch">${swatch(f.hex)}${escapeHtml(
              [f.brand, f.material, f.name].filter(Boolean).join(' ')
            )} · ${escapeHtml(f.hex)}</span><button type="button" class="btn-ams-action" data-action="delete-filament" title="Xóa">✕</button></div>`
          )
          .join('')
      : '<div class="studio-note">Chưa có. Thêm filament hãng khác hoặc màu Bambu không có, để lần sau tô màu mô hình bằng chúng.</div>';
    customPick.innerHTML = customFilaments.length
      ? '<span class="studio-note">Tô bằng:</span>' +
        customFilaments
          .map(
            (f) => `<label class="cad-inline cad-pick"><input type="checkbox" value="${escapeHtml(f.id)}"${unticked.has(f.id) ? '' : ' checked'} />${swatch(f.hex)}${escapeHtml(f.name)}</label>`
          )
          .join('')
      : '<span class="studio-note">Chưa có filament nào: thêm ở mục 🎨 Filament của tôi bên dưới.</span>';
  }

  async function loadFilaments() {
    try {
      customFilaments = (await api('GET', '/api/filaments/custom')).filaments;
      renderFilaments();
    } catch {
      /* the list stays as it was */
    }
  }

  customPick?.addEventListener('change', (event) => {
    if (event.target.type !== 'checkbox') return;
    if (event.target.checked) unticked.delete(event.target.value);
    else unticked.add(event.target.value);
  });

  // The colour picker and the hex box follow each other
  filamentColour?.addEventListener('input', () => {
    filamentHex.value = filamentColour.value.toUpperCase();
  });
  filamentHex?.addEventListener('input', () => {
    const value = filamentHex.value.trim().replace(/^#?/, '#');
    if (/^#[0-9a-fA-F]{6}$/.test(value)) filamentColour.value = value;
  });

  filamentForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      name: $('cadFilamentName').value,
      brand: $('cadFilamentBrand').value,
      material: $('cadFilamentMaterial').value,
      hex: filamentHex.value,
    };
    try {
      const { filament } = await api('POST', '/api/filaments/custom', payload);
      customFilaments = [...customFilaments, filament];
      renderFilaments();
      $('cadFilamentName').value = '';
      showToast(`Đã lưu filament ${filament.name}.`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  filamentList?.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action="delete-filament"]');
    const row = event.target.closest('.cad-filament');
    if (!button || !row) return;
    try {
      await api('DELETE', `/api/filaments/custom/${encodeURIComponent(row.dataset.id)}`);
      customFilaments = customFilaments.filter((f) => f.id !== row.dataset.id);
      renderFilaments();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
  imageClear?.addEventListener('click', () => {
    imageInput.value = '';
    showImageName();
  });

  /** Shows the fields of one kind of model, and whether its container can take it */
  function setKind(next) {
    kind = next;
    const figure = kind === 'figure';
    figureFields.hidden = !figure;
    modelEl.hidden = figure;
    promptEl.placeholder = PLACEHOLDERS[kind];
    hintEl.textContent = HINTS[kind];
    const worker = figure ? config?.mesh : config?.worker;
    const name = figure ? 'mesh3d' : 'CAD';
    statusEl.textContent = !worker?.online
      ? `🔴 Container ${name} chưa chạy`
      : !worker.claude
        ? '🟡 Thiếu CLAUDE_CODE_OAUTH_TOKEN'
        : figure && !worker.loaded
          ? '🟢 Sẵn sàng (model chưa nạp vào GPU)'
          : '🟢 Sẵn sàng';
    statusEl.title = worker?.error ?? '';
    // A figure from an uploaded picture needs no Claude
    createBtn.disabled = !worker?.online || (!figure && !worker.claude);
  }

  kindEl?.addEventListener('change', (event) => {
    if (event.target.name === 'cadKind') setKind(event.target.value);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const prompt = promptEl.value.trim();
    const figure = kind === 'figure';
    if (figure ? prompt.length < 3 && !imageInput.files?.length : prompt.length < 3) {
      showToast(figure ? 'Chọn ảnh hoặc mô tả mô hình trước đã.' : 'Mô tả mô hình cần in trước đã.', 'error');
      return;
    }
    createBtn.disabled = true;
    try {
      if (figure) {
        await createFigure(prompt);
        imageInput.value = '';
        showImageName();
      } else {
        await create(prompt);
      }
      promptEl.value = '';
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      createBtn.disabled = false;
    }
  });

  listEl.addEventListener('click', async (event) => {
    event.target.closest('.cad-prompt-text')?.classList.toggle('expanded');
    const button = event.target.closest('button[data-action]');
    const row = event.target.closest('.cad-row');
    if (!button || !row) return;
    const job = jobs.find((j) => j.id === row.dataset.id);
    if (!job) return;

    if (button.dataset.action === 'revise') {
      const revise = row.querySelector('.cad-revise');
      revise.hidden = !revise.hidden;
      if (!revise.hidden) revise.querySelector('input').focus();
      return;
    }
    button.disabled = true;
    try {
      if (button.dataset.action === 'cancel') {
        await api('POST', `/api/cad/jobs/${encodeURIComponent(job.id)}/cancel`, {});
        showToast('Đã hủy.', 'info');
      } else if (button.dataset.action === 'again') {
        await again(job);
        showToast('Đang dựng lại với số ngẫu nhiên khác.', 'info');
      } else if (button.dataset.action === 'studio') {
        const sent = await api('POST', `/api/cad/jobs/${encodeURIComponent(job.id)}/studio`, { format: button.dataset.format });
        showToast(`Đã gửi ${sent.studioPath}. Trong Studio: File → Import.`, 'success');
        addLog(`Đã gửi mô hình AI vào Bambu Studio: ${sent.studioPath}`, 'success');
      }
      await refresh();
    } catch (err) {
      showToast(err.message, 'error');
      button.disabled = false;
    }
  });

  listEl.addEventListener('submit', async (event) => {
    const reviseForm = event.target.closest('.cad-revise');
    if (!reviseForm) return;
    event.preventDefault();
    const row = reviseForm.closest('.cad-row');
    const input = reviseForm.querySelector('input');
    const comment = input.value.trim();
    // A figure can go without words: Claude then looks for problems itself
    const figure = reviseForm.dataset.kind === 'fix';
    if (figure ? comment.length > 0 && comment.length < 3 : comment.length < 3) {
      showToast('Ghi cần sửa gì trước đã.', 'error');
      return;
    }
    reviseForm.querySelector('button').disabled = true;
    try {
      if (figure) await fixFigure(comment, row.dataset.id);
      else await create(comment, row.dataset.id);
      reviseForm.hidden = true;
      input.value = '';
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      reviseForm.querySelector('button').disabled = false;
    }
  });

  $('btnCadRefresh')?.addEventListener('click', refresh);

  fetch('/api/cad')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || disposed || !data.enabled) return;
      card.hidden = false;
      config = data;
      modelEl.innerHTML = data.models
        .map((m) => `<option value="${escapeHtml(m.id)}"${m.id === data.default_model ? ' selected' : ''}>${escapeHtml(m.label)}</option>`)
        .join('');
      // Both kinds set up: the user picks; otherwise the one there is
      kindEl.hidden = !(data.worker && data.mesh);
      const start = data.worker ? 'technical' : 'figure';
      kindEl.querySelector(`input[value="${start}"]`).checked = true;
      showImageName();
      // Bambu's own colours: whole families first (more colours to choose from), then each material
      if (data.bambu_materials?.length) {
        const families = (data.bambu_families ?? []).map(
          (f) => `<option value="family:${escapeHtml(f.family)}">${escapeHtml(`Mọi dòng ${f.family} (${f.colours} màu, ${f.materials} loại)`)}</option>`
        );
        const materials = data.bambu_materials.map(
          (m) => `<option value="${escapeHtml(m.material)}">${escapeHtml(`${m.material} (${m.colours} màu)`)}</option>`
        );
        materialEl.innerHTML =
          '<option value="">Màu cần mua: theo nhựa trong AMS</option>' +
          (families.length ? `<optgroup label="Cả dòng nhựa">${families.join('')}</optgroup>` : '') +
          `<optgroup label="Một loại nhựa">${materials.join('')}</optgroup>`;
        materialEl.value = '';
        paletteBambu.hidden = false;
      }
      loadFilaments();
      setKind(start);
      refresh();
    })
    .catch(() => {});

  return () => {
    disposed = true;
    clearTimeout(timer);
  };
}
