/**
 * "AI nhận xét" on a timelapse: Claude, run by the gateway (`claude -p`), looks at frames of the
 * video (POST /api/timelapse/:name/review) and says what went wrong and what to change next time. The review
 * is only shown until the user presses "Dùng cho lần in sau" (POST .../review/use): then it is saved on the
 * print, where "AI tối ưu" in Studio reads it with the past prints.
 */
import { escapeHtml, formatPrintTime } from './prints';

const POLL_MS = 3000;

// ---------- Pure helpers (unit-tested in tests/timelapseUi.test.ts) ----------

const labelOf = (list, id) => list.find((o) => o.id === id)?.label ?? id;

/**
 * The review as HTML; `outcomes` and `issues` are the [{id, label}] lists the API sends
 * @param {{ outcomes?: { id: string, label: string }[], issues?: { id: string, label: string }[] }} [labels]
 */
export function renderReview(review, labels = {}) {
  const { outcomes = [], issues = [] } = labels;
  const outcome = `<span class="print-badge outcome-${escapeHtml(review.outcome_guess)}">AI đoán: ${escapeHtml(labelOf(outcomes, review.outcome_guess))}</span>`;
  const issueList = review.issues.length
    ? `<ul class="print-issues">${review.issues.map((i) => `<li>${escapeHtml(labelOf(issues, i))}</li>`).join('')}</ul>`
    : '';
  const observations = review.observations?.length
    ? `<h5>Thấy trong video</h5><ul class="review-list">${review.observations
        .map((o) => `<li><span class="prints-muted">${escapeHtml(review.frames_at?.[o.frame - 1] ?? '?')}%</span> ${escapeHtml(o.problem)}</li>`)
        .join('')}</ul>`
    : '';
  // Missing in reviews made before the model was asked to look at the finished print first
  const finalCheck = review.final_check ? `<h5>Bản in lúc xong</h5><div class="review-text">${escapeHtml(review.final_check)}</div>` : '';
  const suggestions = review.suggestions.length
    ? `<h5>Lần in sau</h5><ul class="review-list">${review.suggestions.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
    : '';
  return `
    <div class="timelapse-review-result">
      <div>${outcome} <span class="prints-muted">${escapeHtml(review.model)} · ${escapeHtml(formatPrintTime(review.at))}</span></div>
      <div class="print-note">${escapeHtml(review.summary)}</div>
      ${issueList}${finalCheck}${observations}${suggestions}
    </div>`;
}

// ---------- Section ----------

/**
 * Fills `box` with the review of `video`, the button that asks for one and the one that uses it for later
 * prints. `printId` is the print the video shows when the caller knows it; otherwise the gateway's pairing is
 * used, or the user picks the print. Returns a function that stops polling (which also stops once `box`
 * leaves the page).
 */
export function mountReview(box, video, { showToast, addLog, printId = null }) {
  let disposed = false;
  let timer = null;
  let labels = { outcomes: [], issues: [] };
  /** Recent prints to pick from, loaded when the video has no print */
  let prints = null;

  async function call(path = '', init) {
    const res = await fetch(`/api/timelapse/${encodeURIComponent(video.name)}/review${path}`, init);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new Error(data?.message || `Lỗi HTTP ${res.status}`);
    if (data.outcomes) labels = { outcomes: data.outcomes, issues: data.issues };
    return data;
  }

  const post = (path, body) =>
    call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  async function loadPrints() {
    if (prints || printId || video.print) return;
    try {
      const res = await fetch('/api/prints?limit=30');
      const data = await res.json();
      prints = data?.success ? data.prints : [];
    } catch {
      prints = [];
    }
  }

  const printName = (id) => prints?.find((p) => p.id === id)?.job_name ?? (video.print?.id === id ? video.print.job_name : null);

  function pickerHtml(selected) {
    if (printId || video.print || !prints?.length) return '';
    return `<label class="timelapse-review-print">Bản in của video:
        <select class="timelapse-review-select">
          <option value="">— Chưa chọn —</option>
          ${prints
            .map(
              (p) =>
                `<option value="${escapeHtml(p.id)}"${p.id === selected ? ' selected' : ''}>${escapeHtml(formatPrintTime(p.ended_at ?? p.started_at))} · ${escapeHtml(p.job_name)}</option>`
            )
            .join('')}
        </select>
      </label>`;
  }

  /** "Dùng cho lần in sau" under a finished review, or what it is used for and "Bỏ dùng" */
  function useHtml(review) {
    if (review.used) {
      const name = printName(review.used.print_id);
      return `
        <div class="timelapse-review-use is-used">
          <span>✅ Đang dùng cho lần in sau${name ? ` (bản in ${escapeHtml(name)})` : ''} · ${escapeHtml(formatPrintTime(review.used.at))}</span>
          <button type="button" class="btn-ams-action timelapse-review-unuse">Bỏ dùng</button>
        </div>`;
    }
    return `
      <div class="timelapse-review-use">
        ${pickerHtml(review.print_id)}
        <button type="button" class="btn-ams-action timelapse-review-apply">✅ Dùng cho lần in sau</button>
        <span class="prints-muted">Lưu nhận xét vào bản in để "AI tối ưu" trong Studio tham khảo khi in plate tương tự. Không bấm thì đây chỉ là nhận xét.</span>
      </div>`;
  }

  function render(state) {
    if (disposed) return;
    const running = state.status === 'running';
    const body =
      state.status === 'done'
        ? renderReview(state.review, labels) + useHtml(state.review)
        : state.status === 'failed'
          ? `<div class="prints-empty">❌ ${escapeHtml(state.error)}</div>`
          : running
            ? `<div class="prints-muted">⏳ ${escapeHtml(state.model ?? 'Claude')} đang xem video (thường dưới 1 phút)...</div>`
            : `<div class="prints-muted">Claude (${escapeHtml(state.model ?? 'claude')}) xem các khung hình của timelapse, chỉ ra lỗi và cách chỉnh cho lần in sau.</div>`;
    box.innerHTML = `
      <div class="print-section-head">
        <h4>🤖 AI nhận xét</h4>
        <button type="button" class="btn-ams-action timelapse-review-start"${running ? ' disabled' : ''}>
          ${running ? '⏳ Đang xem...' : state.status === 'done' ? '🔄 Xem lại' : '🤖 Nhờ AI xem video'}
        </button>
      </div>
      ${state.status === 'none' || state.status === 'failed' ? pickerHtml(null) : ''}
      ${body}`;
    box.querySelector('.timelapse-review-start').addEventListener('click', start);
    box.querySelector('.timelapse-review-apply')?.addEventListener('click', use);
    box.querySelector('.timelapse-review-unuse')?.addEventListener('click', unuse);
    clearTimeout(timer);
    if (running) timer = setTimeout(poll, POLL_MS);
  }

  async function poll() {
    // The window was closed or redrawn
    if (!box.isConnected && box.dataset.status) disposed = true;
    if (disposed) return;
    try {
      const state = await call();
      if (state.status === 'done' && box.dataset.status === 'running') addLog(`AI đã nhận xét timelapse ${video.name}.`, 'success');
      box.dataset.status = state.status;
      render(state);
    } catch (err) {
      if (!disposed) render({ status: 'failed', error: err.message });
    }
  }

  const picked = () => box.querySelector('.timelapse-review-select')?.value || null;

  async function start() {
    try {
      const state = await post('', { print_id: printId ?? picked() });
      box.dataset.status = state.status;
      addLog(`Nhờ AI xem timelapse ${video.name}.`, 'info');
      render(state);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function use() {
    try {
      const state = await post('/use', { print_id: printId ?? picked() });
      showToast('Đã lưu nhận xét: "AI tối ưu" sẽ tham khảo nó cho lần in sau.', 'success');
      addLog(`Dùng nhận xét timelapse ${video.name} cho lần in sau.`, 'info');
      render(state);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function unuse() {
    try {
      render(await call('/use', { method: 'DELETE' }));
      addLog(`Bỏ dùng nhận xét timelapse ${video.name}.`, 'info');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  box.classList.add('timelapse-review');
  loadPrints().then(poll);
  return () => {
    disposed = true;
    clearTimeout(timer);
  };
}
