/**
 * "Thiết kế mô hình bằng AI": models designed in the CAD container (GET/POST /api/cad/jobs). Claude writes and
 * checks build123d code from the user's description; models built from Antigravity (MCP bambu-cad) show up
 * too. Each finished model has a preview, downloads (STL, STEP, code), "send to Studio" and "revise".
 */
import { escapeHtml, formatPrintTime } from './prints';

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
  starting: 'Claude đang đọc yêu cầu',
  writing: 'Đang viết code',
  building: 'Đang dựng mô hình',
  reviewing: 'Đang xem ảnh để kiểm tra',
  finishing: 'Đang xuất file',
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

/** One model as HTML (every value from the API escaped) */
export function renderJob(job) {
  const busy = isBusy(job);
  const size = formatSize(job.report?.size_mm);
  const source = job.source === 'code' ? 'Antigravity / code' : (job.model ?? 'Claude').replace('claude-', '').replace(/-(\d)-(\d)$/, ' $1.$2');
  const preview = job.files?.preview
    ? `<a href="${escapeHtml(fileUrl(job, 'preview.png'))}" target="_blank" rel="noopener"><img src="${escapeHtml(fileUrl(job, 'preview.png'))}" alt="Ảnh xem trước" loading="lazy" /></a>`
    : `<div class="cad-preview-empty">${busy ? '⏳' : '—'}</div>`;

  const progress = busy
    ? `<div class="cad-progress">⏳ ${escapeHtml(STEP_LABELS[job.step] ?? 'Đang chờ container CAD')}${job.builds ? ` · đã dựng ${job.builds} lần` : ''}</div>`
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
    ? `<details class="cad-details"><summary>Chi tiết từ Claude</summary>
        <p>${escapeHtml(job.result.summary)}</p>
        ${job.result.assumptions?.length ? `<b>Giả định</b>${list(job.result.assumptions)}` : ''}
        ${job.result.parameters?.length ? `<b>Tham số trong code</b>${list(job.result.parameters.map((p) => `${p.name} = ${p.value}: ${p.description}`))}` : ''}
      </details>`
    : '';
  const sent = job.sent?.length ? `<div class="studio-note">📤 Đã gửi: ${escapeHtml(job.sent.map((s) => `/imports/${s.name}`).join(', '))}</div>` : '';

  const done = job.state === 'done';
  const actions = [
    busy && job.source === 'claude' ? `<button type="button" class="btn-ams-action" data-action="cancel">⏹ Hủy</button>` : '',
    done ? `<button type="button" class="btn-ams-action btn-ams-primary" data-action="studio" data-format="stl">📤 Gửi sang Studio</button>` : '',
    done ? `<a class="btn-ams-action" href="${escapeHtml(fileUrl(job, 'model.stl', true))}">⬇ STL</a>` : '',
    done && job.files?.step ? `<a class="btn-ams-action" href="${escapeHtml(fileUrl(job, 'model.step', true))}">⬇ STEP</a>` : '',
    job.files?.code ? `<a class="btn-ams-action" href="${escapeHtml(fileUrl(job, 'model.py'))}" target="_blank" rel="noopener">📄 Code</a>` : '',
    !busy && job.files?.code ? `<button type="button" class="btn-ams-action" data-action="revise">✏️ Sửa</button>` : '',
  ].join('');

  return `
    <div class="cad-preview">${preview}</div>
    <div class="cad-body">
      <div class="cad-title-row">
        <span class="cad-title">${escapeHtml(job.title || job.prompt)}</span>
        <span class="print-badge cad-state-${escapeHtml(job.state)}">${escapeHtml(STATE_LABELS[job.state] ?? job.state)}</span>
      </div>
      <div class="cad-meta">${escapeHtml(formatPrintTime(job.created_at))} · ${escapeHtml(source)}${job.parent_id ? ' · bản sửa' : ''}</div>
      ${job.title && job.title !== job.prompt ? `<div class="cad-prompt-text">${escapeHtml(job.prompt)}</div>` : ''}
      ${progress}${notes}${error}${report}
      ${warnings.length ? `<div class="cad-warnings">⚠️ ${warnings.map(escapeHtml).join('<br />⚠️ ')}</div>` : ''}
      ${details}${sent}
      <div class="cad-actions">${actions}</div>
      <form class="cad-revise" hidden>
        <input type="text" class="cad-revise-input" maxlength="4000" placeholder="Cần sửa gì? Ví dụ: dày thêm 1 mm, bo tròn các góc" />
        <button type="submit" class="btn-ams-action btn-ams-primary">Gửi Claude sửa</button>
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
  if (!card || !listEl) return () => {};

  let disposed = false;
  let timer = null;
  let jobs = [];
  // Rendered HTML per job: a row is only replaced when it changed, so an open form or details stays open
  const rendered = new Map();

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error(data?.message || `Lỗi HTTP ${res.status}`);
    return data;
  }

  function render() {
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

  async function create(prompt, parentId) {
    const { job } = await api('POST', '/api/cad/jobs', { prompt, model: modelEl.value || undefined, ...(parentId && { parent_id: parentId }) });
    jobs = [job, ...jobs.filter((j) => j.id !== job.id)];
    render();
    schedule();
    addLog(`Đã gửi Claude ${parentId ? 'sửa' : 'thiết kế'} mô hình: ${prompt}`, 'info');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const prompt = promptEl.value.trim();
    if (prompt.length < 3) {
      showToast('Mô tả mô hình cần in trước đã.', 'error');
      return;
    }
    createBtn.disabled = true;
    try {
      await create(prompt);
      promptEl.value = '';
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      createBtn.disabled = false;
    }
  });

  listEl.addEventListener('click', async (event) => {
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
    if (comment.length < 3) {
      showToast('Ghi cần sửa gì trước đã.', 'error');
      return;
    }
    reviseForm.querySelector('button').disabled = true;
    try {
      await create(comment, row.dataset.id);
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
      modelEl.innerHTML = data.models
        .map((m) => `<option value="${escapeHtml(m.id)}"${m.id === data.default_model ? ' selected' : ''}>${escapeHtml(m.label)}</option>`)
        .join('');
      const { worker } = data;
      statusEl.textContent = !worker.online
        ? '🔴 Container CAD chưa chạy'
        : worker.claude
          ? '🟢 Sẵn sàng'
          : '🟡 Thiếu CLAUDE_CODE_OAUTH_TOKEN';
      statusEl.title = worker.error ?? '';
      createBtn.disabled = !worker.online || !worker.claude;
      refresh();
    })
    .catch(() => {});

  return () => {
    disposed = true;
    clearTimeout(timer);
  };
}
