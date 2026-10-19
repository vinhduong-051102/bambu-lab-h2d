/**
 * Bambu Studio panel: embeds the real app streamed from its container (STUDIO_URL) and lists the
 * files it exported to STUDIO_EXPORT_DIR. "In" stages one through POST /api/studio/prepare and hands
 * it to the print panel (gateway:staged event), which takes over at the plate/AMS mapping step.
 */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const EXPORT_POLL_MS = 10_000;

export function initStudio({ showToast, addLog }) {
  const $ = (id) => document.getElementById(id);
  const card = $('studioCard');
  const btnToggle = $('btnStudioToggle');
  const btnFullscreen = $('btnStudioFullscreen');
  const newTab = $('studioNewTab');
  const frameWrap = $('studioFrameWrap');
  const frame = $('studioFrame');
  const idle = $('studioIdle');
  const exportsBox = $('studioExports');
  const exportList = $('studioExportList');
  const btnRefresh = $('btnStudioRefresh');

  if (!card || !frame) return () => {};

  let studioUrl = null;
  let pollTimer = null;
  let disposed = false;

  // The iframe is only loaded on demand: the stream costs CPU on the container and bandwidth here
  function setOpen(open) {
    frameWrap.hidden = !open;
    idle.hidden = open;
    btnFullscreen.hidden = !open;
    btnToggle.textContent = open ? '■ Đóng Studio' : '▶ Mở Studio';
    if (open && frame.getAttribute('src') !== studioUrl) frame.src = studioUrl;
    if (!open) frame.removeAttribute('src');
  }

  btnToggle.addEventListener('click', () => setOpen(frameWrap.hidden));
  btnFullscreen.addEventListener('click', () => {
    frameWrap.requestFullscreen?.().catch((err) => showToast(`Không bật được toàn màn hình: ${err.message}`, 'error'));
  });

  async function prepare(name, btn) {
    btn.disabled = true;
    btn.textContent = '⏳';
    try {
      const res = await fetch('/api/studio/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      window.dispatchEvent(new CustomEvent('gateway:staged', { detail: data.staged }));
      addLog(`Đã chuẩn bị file ${name} từ Bambu Studio: ${data.staged.plates.length} plate.`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
      addLog(`Không chuẩn bị được ${name}: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'In';
    }
  }

  function renderExports(data) {
    if (data.exportError) {
      exportList.replaceChildren(el('li', { className: 'print-muted', text: data.exportError }));
      return;
    }
    if (data.files.length === 0) {
      exportList.replaceChildren(
        el('li', { className: 'print-muted', text: 'Chưa có file nào. Trong Studio, xuất file vào thư mục /exports.' })
      );
      return;
    }
    exportList.replaceChildren(
      ...data.files.map((f) => {
        const btn = el('button', { type: 'button', className: 'btn-ams-action', text: 'In' });
        btn.addEventListener('click', () => prepare(f.name, btn));
        const sliced = /\.gcode\.3mf$/i.test(f.name);
        return el('li', { className: 'print-remote-item', title: f.name }, [
          el('div', { style: 'min-width:0' }, [
            el('div', { className: 'name', text: f.name }),
            el('div', {
              className: 'meta',
              text: `${new Date(f.modifiedAt).toLocaleString('vi-VN')} · ${formatBytes(f.size)}${sliced ? '' : ' · gateway sẽ slice'}`,
            }),
          ]),
          btn,
        ]);
      })
    );
  }

  async function load() {
    try {
      const res = await fetch('/api/studio');
      if (!res.ok) return;
      const data = await res.json();
      if (disposed) return;

      card.hidden = !data.enabled && !data.exportsEnabled;
      if (data.enabled && data.url !== studioUrl) {
        studioUrl = data.url;
        newTab.href = studioUrl;
      }
      btnToggle.hidden = !data.enabled;
      newTab.hidden = !data.enabled;
      exportsBox.hidden = !data.exportsEnabled;
      if (data.exportsEnabled) renderExports(data);
    } catch {
      /* gateway restarting: keep the last state, the next poll retries */
    }
  }

  btnRefresh.addEventListener('click', load);
  load();
  // New exports show up without a manual refresh while the dashboard is open
  pollTimer = setInterval(() => {
    if (!document.hidden) load();
  }, EXPORT_POLL_MS);

  return () => {
    disposed = true;
    clearInterval(pollTimer);
    frame.removeAttribute('src');
  };
}
