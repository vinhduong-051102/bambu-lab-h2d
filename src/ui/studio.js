/**
 * Bambu Studio panel: embeds the real app streamed from its container (STUDIO_URL) and sends models
 * from this computer into its /imports folder (POST /api/studio/import), since Studio's own file
 * dialogs only see the container. Slicing and printing happen in Studio itself.
 */

export function initStudio({ showToast, addLog }) {
  const $ = (id) => document.getElementById(id);
  const card = $('studioCard');
  const btnToggle = $('btnStudioToggle');
  const btnFullscreen = $('btnStudioFullscreen');
  const newTab = $('studioNewTab');
  const frameWrap = $('studioFrameWrap');
  const frame = $('studioFrame');
  const idle = $('studioIdle');
  const importLabel = $('studioImportLabel');
  const importInput = $('studioImportInput');
  const importStatus = $('studioImportStatus');

  if (!card || !frame) return () => {};

  let studioUrl = null;
  let disposed = false;
  let importXhr = null;

  // A frame is only a secure context when its parent is one too. Over plain HTTP from another machine
  // the embedded stream can't use the browser's video decoder, so Studio opens as a top-level HTTPS tab.
  const canEmbed = () => window.isSecureContext;

  // The iframe is only loaded on demand: the stream costs CPU on the container and bandwidth here
  function setOpen(open) {
    frameWrap.hidden = !open;
    idle.hidden = open;
    btnFullscreen.hidden = !open;
    btnToggle.textContent = open ? '■ Đóng Studio' : '▶ Mở Studio';
    if (open && frame.getAttribute('src') !== studioUrl) frame.src = studioUrl;
    if (!open) frame.removeAttribute('src');
  }

  btnToggle.addEventListener('click', () => {
    if (!canEmbed()) {
      window.open(studioUrl, '_blank', 'noopener');
      return;
    }
    setOpen(frameWrap.hidden);
  });
  btnFullscreen.addEventListener('click', () => {
    frameWrap.requestFullscreen?.().catch((err) => showToast(`Không bật được toàn màn hình: ${err.message}`, 'error'));
  });

  // ---------- Send files from this computer to Studio's /imports ----------

  function uploadOne(file, index, total) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', file);
      importXhr = new XMLHttpRequest();
      importXhr.open('POST', '/api/studio/import');
      const prefix = total > 1 ? `(${index + 1}/${total}) ` : '';
      importXhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          importStatus.textContent = `⏳ ${prefix}Đang gửi ${file.name}: ${Math.round((e.loaded / e.total) * 100)}%`;
        }
      };
      importXhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(importXhr.responseText);
        } catch {
          /* handled below */
        }
        if (importXhr.status === 201 && data?.success) resolve(data);
        else reject(new Error(data?.message || `Lỗi HTTP ${importXhr.status}`));
      };
      importXhr.onerror = () => reject(new Error('Mất kết nối khi gửi file.'));
      importXhr.send(form);
    });
  }

  async function importFiles(files) {
    if (files.length === 0) return;
    importLabel.classList.add('disabled');
    importStatus.hidden = false;
    const sent = [];
    try {
      for (const [i, file] of files.entries()) {
        const data = await uploadOne(file, i, files.length);
        sent.push(data.studioPath);
      }
      importStatus.textContent = `✅ Đã gửi: ${sent.join(', ')}. Trong Studio: File → Import → thư mục /imports.`;
      addLog(`Đã gửi ${sent.length} file vào Bambu Studio (/imports).`, 'success');
    } catch (err) {
      importStatus.textContent = `❌ ${err.message}`;
      showToast(err.message, 'error');
    } finally {
      importXhr = null;
      importLabel.classList.remove('disabled');
    }
  }

  importInput?.addEventListener('change', () => {
    const files = [...(importInput.files ?? [])];
    importInput.value = '';
    importFiles(files);
  });

  // ---------- Configuration ----------

  fetch('/api/studio')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || disposed) return;
      card.hidden = !data.enabled;
      importLabel.hidden = !data.importsEnabled;
      if (!data.enabled) return;

      studioUrl = data.url;
      newTab.href = studioUrl;
      if (!canEmbed()) {
        btnToggle.textContent = '↗ Mở Studio (tab mới)';
        idle.replaceChildren(
          'Dashboard đang mở qua HTTP từ máy khác nên không nhúng được Studio (trình duyệt chặn bộ giải mã video). ',
          'Studio sẽ mở trong tab mới qua HTTPS; lần đầu hãy chấp nhận cảnh báo chứng chỉ tự ký. ',
          'Dùng "📤 Gửi file vào Studio" để đưa model từ máy này vào thư mục /imports.'
        );
      }
    })
    .catch(() => {});

  return () => {
    disposed = true;
    importXhr?.abort();
    frame.removeAttribute('src');
  };
}
