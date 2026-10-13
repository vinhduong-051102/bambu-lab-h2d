/**
 * LAN print panel: stage a sliced 3MF (local upload or a file already on the printer), map each
 * filament to a live AMS tray, send POST /api/print/start and follow the job through the
 * `print.job` WebSocket events, which reflect what the printer itself reported.
 */

const EXTERNAL_SPOOL_TRAY = 254;
const STATUS_LABELS = {
  UPLOADING: 'ĐANG UPLOAD',
  UPLOADED: 'ĐÃ UPLOAD',
  SENT: 'ĐÃ GỬI LỆNH',
  ACCEPTED: 'MÁY IN ĐÃ NHẬN',
  PREPARING: 'ĐANG CHUẨN BỊ',
  PRINTING: 'ĐANG IN',
  FAILED: 'THẤT BẠI',
  TIMEOUT: 'HẾT THỜI GIAN CHỜ',
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') Object.assign(node.style, value);
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

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function extruderLabel(extruder) {
  // filament_maps: 1 = left nozzle, 2 = right nozzle on H2D
  if (extruder === 1) return 'Trái (1)';
  if (extruder === 2) return 'Phải (2)';
  return '—';
}

export function initPrintJob({ showToast, addLog }) {
  const $ = (id) => document.getElementById(id);
  const fileInput = $('printFileInput');
  const fileLabel = $('printFileLabel');
  const dropzone = fileInput?.closest('.print-dropzone');
  const prepareProgress = $('printPrepareProgress');
  const prepareBar = $('printPrepareBar');
  const prepareText = $('printPrepareText');
  const btnListFiles = $('btnPrintListFiles');
  const remoteList = $('printRemoteList');
  const configEmpty = $('printConfigEmpty');
  const config = $('printConfig');
  const fileSummary = $('printFileSummary');
  const plateSelect = $('printPlateSelect');
  const plateThumb = $('printPlateThumb');
  const plateInfo = $('printPlateInfo');
  const mappingBody = $('printMappingBody');
  const warningsList = $('printWarnings');
  const btnStart = $('btnPrintStart');
  const btnDiscard = $('btnPrintDiscard');
  const jobEmpty = $('printJobEmpty');
  const jobBox = $('printJob');
  const jobBadge = $('printJobBadge');
  const jobFile = $('printJobFile');
  const jobMessage = $('printJobMessage');
  const jobUpload = $('printJobUpload');
  const jobUploadBar = $('printJobUploadBar');
  const jobUploadText = $('printJobUploadText');
  const jobCodes = $('printJobCodes');
  const jobHistory = $('printJobHistory');

  if (!fileInput || !btnStart) return () => {};

  let staged = null;
  let currentJobId = null;
  let xhr = null;

  // ---------- Step 1: stage a file ----------

  function setPrepareProgress(percent) {
    prepareProgress.hidden = percent === null;
    if (percent !== null) {
      prepareBar.style.width = `${percent}%`;
      // An unsliced project is sliced by the gateway during this step, which can take a few minutes
      prepareText.textContent = percent >= 100 ? 'Đang phân tích / slice (file chưa slice có thể mất vài phút)…' : `${percent}%`;
    }
  }

  function uploadToGateway(file) {
    if (!/\.3mf$/i.test(file.name)) {
      showToast('Chỉ hỗ trợ file .3mf (project hoặc đã slice .gcode.3mf).', 'error');
      return;
    }
    fileLabel.textContent = file.name;
    setPrepareProgress(0);

    const form = new FormData();
    form.append('file', file);
    xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/print/prepare');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setPrepareProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setPrepareProgress(null);
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* handled below */
      }
      if (xhr.status === 201 && data?.staged) {
        showStaged(data.staged);
        const sliced = data.staged.slicedByGateway;
        addLog(
          sliced
            ? `Gateway đã slice ${file.name} cho ${sliced.printer} trong ${Math.round(sliced.durationMs / 1000)}s: ${data.staged.plates.length} plate.`
            : `Đã phân tích file ${file.name}: ${data.staged.plates.length} plate.`,
          'success'
        );
      } else {
        const message = data?.message || `Lỗi HTTP ${xhr.status}`;
        showToast(message, 'error');
        addLog(`Không phân tích được file: ${message}`, 'error');
      }
      xhr = null;
    };
    xhr.onerror = () => {
      setPrepareProgress(null);
      showToast('Mất kết nối khi tải file lên gateway.', 'error');
      xhr = null;
    };
    xhr.send(form);
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) uploadToGateway(file);
    fileInput.value = '';
  });

  dropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadToGateway(file);
  });

  async function listRemoteFiles() {
    btnListFiles.disabled = true;
    remoteList.replaceChildren(el('li', { className: 'print-muted', text: 'Đang đọc bộ nhớ máy in…' }));
    try {
      const res = await fetch('/api/files');
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);

      const printable = data.files.filter((f) => f.printable);
      if (printable.length === 0) {
        remoteList.replaceChildren(el('li', { className: 'print-muted', text: 'Không có file .3mf nào trên máy in.' }));
        return;
      }
      remoteList.replaceChildren(
        ...printable.map((f) => {
          const btn = el('button', { type: 'button', className: 'btn-ams-action', text: 'Chọn' });
          btn.addEventListener('click', () => prepareRemote(f.path, btn));
          return el('li', { className: 'print-remote-item', title: f.path }, [
            el('div', { style: { minWidth: '0' } }, [
              el('div', { className: 'name', text: f.name }),
              el('div', { className: 'meta', text: `${f.path} · ${formatBytes(f.size)}` }),
            ]),
            btn,
          ]);
        })
      );
    } catch (err) {
      remoteList.replaceChildren(el('li', { className: 'print-muted', text: `Lỗi: ${err.message}` }));
    } finally {
      btnListFiles.disabled = false;
    }
  }

  async function prepareRemote(remotePath, btn) {
    btn.disabled = true;
    btn.textContent = '⏳';
    try {
      const res = await fetch('/api/print/prepare-remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: remotePath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      showStaged(data.staged);
      addLog(`Đã đọc file ${remotePath} từ máy in.`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Chọn';
    }
  }

  btnListFiles.addEventListener('click', listRemoteFiles);

  // ---------- Step 2: plate + mapping ----------

  function showStaged(data) {
    staged = data;
    configEmpty.hidden = true;
    config.hidden = false;

    const details = [
      `📄 ${data.fileName} (${formatBytes(data.size)})`,
      data.source === 'printer' ? `Nguồn: bộ nhớ máy in ${data.remoteName}` : `Sẽ upload lên máy in: ${data.remoteName}`,
      [data.printerModel, data.nozzleDiameters && `Nozzle ${data.nozzleDiameters}`, data.slicerVersion && `Slicer ${data.slicerVersion}`]
        .filter(Boolean)
        .join(' · '),
      data.slicedByGateway && slicedSummary(data.slicedByGateway),
    ].filter(Boolean);
    fileSummary.replaceChildren(...details.map((line) => el('div', { text: line })));

    plateSelect.replaceChildren(
      ...data.plates.map((p) => el('option', { value: String(p.index), text: `Plate ${p.index}${p.name ? ` – ${p.name}` : ''}` }))
    );
    renderPlate();
  }

  function slicedSummary(sliced) {
    const seconds = Math.round(sliced.durationMs / 1000);
    if (!sliced.profiles) {
      return `🔧 Gateway đã slice từ ${sliced.sourceFileName} (${seconds}s) bằng cấu hình có sẵn trong project.`;
    }
    return `🔧 Gateway đã slice từ ${sliced.sourceFileName} (${seconds}s): ${sliced.profiles.process} · ${sliced.profiles.filaments.join(', ')}`;
  }

  function currentPlate() {
    return staged?.plates.find((p) => String(p.index) === plateSelect.value) ?? staged?.plates[0];
  }

  function renderPlate() {
    const plate = currentPlate();
    if (!plate) return;

    plateThumb.hidden = !plate.thumbnail;
    if (plate.thumbnail) plateThumb.src = plate.thumbnail;
    const info = [
      formatDuration(plate.predictionSeconds) && `⏱ ${formatDuration(plate.predictionSeconds)}`,
      plate.weightGrams !== null && `⚖ ${plate.weightGrams} g`,
      `${plate.filaments.length} filament`,
    ].filter(Boolean);
    plateInfo.textContent = info.join(' · ');

    mappingBody.replaceChildren(
      ...plate.filaments.map((f) => {
        const select = el('select', { className: 'print-select', 'data-filament': String(f.index) });
        select.append(el('option', { value: '', text: '— Chọn khay —' }));
        for (const tray of staged.trays) {
          const text = `${tray.label}: ${tray.isEmpty ? 'trống' : `${tray.type ?? '?'} ${tray.color ?? ''}`}`;
          const option = el('option', { value: String(tray.trayIndex), text });
          if (tray.isEmpty) option.disabled = true;
          select.append(option);
        }
        select.append(el('option', { value: String(EXTERNAL_SPOOL_TRAY), text: 'Cuộn ngoài (External spool)' }));
        const suggested = plate.suggestedMapping[f.index];
        if (suggested !== null && suggested !== undefined) select.value = String(suggested);
        select.addEventListener('change', renderWarnings);

        return el('tr', {}, [
          el('td', {}, [
            el('span', { className: 'print-swatch', style: { background: f.color || 'transparent' } }),
            `#${f.index + 1} ${f.type ?? '?'}`,
            f.usedGrams !== null ? el('span', { className: 'print-muted', text: ` · ${f.usedGrams} g` }) : null,
          ]),
          el('td', { text: extruderLabel(f.extruder) }),
          el('td', {}, [select]),
        ]);
      })
    );
    renderWarnings();
  }

  function collectMapping() {
    const mapping = {};
    for (const select of mappingBody.querySelectorAll('select[data-filament]')) {
      mapping[select.dataset.filament] = select.value === '' ? null : Number(select.value);
    }
    return mapping;
  }

  function renderWarnings() {
    const plate = currentPlate();
    if (!plate) return;
    const mapping = collectMapping();
    const warnings = [...plate.warnings];
    const sliced = staged.slicedByGateway;
    if (sliced?.profiles) {
      warnings.push(
        `Project được làm cho ${sliced.sourcePrinter ?? 'máy khác'}: gateway đã thay bằng profile mặc định của ${sliced.printer} (${sliced.profiles.machine}). Tùy chỉnh riêng của project (support, infill...) không được giữ — nếu cần, hãy slice trong Bambu Studio.`
      );
    }

    for (const f of plate.filaments) {
      const target = mapping[f.index];
      if (target === null) {
        warnings.push(`Filament #${f.index + 1}: chưa chọn khay.`);
        continue;
      }
      if (target === EXTERNAL_SPOOL_TRAY) continue;
      const tray = staged.trays.find((t) => t.trayIndex === target);
      if (tray && tray.type && f.type && tray.type.toUpperCase() !== f.type.toUpperCase()) {
        warnings.push(`Filament #${f.index + 1} slice ${f.type} nhưng ${tray.label} đang chứa ${tray.type}.`);
      }
    }
    if (plate.filaments.some((f) => f.extruder !== null)) {
      warnings.push('H2D: AMS phải được gắn với đúng đầu phun (trái/phải) mà slicer đã chọn cho filament, nếu không máy in sẽ báo lỗi nạp nhựa.');
    }

    warningsList.hidden = warnings.length === 0;
    warningsList.replaceChildren(...warnings.map((w) => el('li', { text: `⚠️ ${w}` })));
    btnStart.disabled = plate.filaments.some((f) => mapping[f.index] === null);
  }

  plateSelect.addEventListener('change', renderPlate);

  btnDiscard.addEventListener('click', async () => {
    if (!staged) return;
    await fetch(`/api/print/staged/${staged.id}`, { method: 'DELETE' }).catch(() => {});
    staged = null;
    config.hidden = true;
    configEmpty.hidden = false;
    fileLabel.textContent = 'Chọn file .gcode.3mf từ máy tính';
  });

  btnStart.addEventListener('click', async () => {
    const plate = currentPlate();
    if (!staged || !plate) return;
    const confirmed = window.confirm(
      `Bắt đầu in "${staged.fileName}" – Plate ${plate.index}?\n\nĐảm bảo bàn in trống và đúng loại tấm in. Máy in sẽ bắt đầu gia nhiệt và di chuyển.`
    );
    if (!confirmed) return;

    btnStart.disabled = true;
    try {
      const res = await fetch('/api/print/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stagedId: staged.id,
          plateIndex: plate.index,
          amsMapping: collectMapping(),
          options: {
            bedLeveling: $('printOptBedLeveling').checked,
            flowCalibration: $('printOptFlowCali').checked,
            vibrationCalibration: $('printOptVibrationCali').checked,
            layerInspect: $('printOptLayerInspect').checked,
            timelapse: $('printOptTimelapse').checked,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const details = data.details?.errors?.join(' ') ?? '';
        throw new Error(`${data.message || `HTTP ${res.status}`} ${details}`.trim());
      }
      currentJobId = data.job.id;
      renderJob(data.job);
      addLog(`Đã tạo lệnh in ${data.job.id} (${staged.fileName}).`, 'info');
    } catch (err) {
      showToast(err.message, 'error');
      addLog(`Không bắt đầu được lệnh in: ${err.message}`, 'error');
    } finally {
      renderWarnings();
    }
  });

  // ---------- Step 3: job status ----------

  function renderJob(job) {
    jobEmpty.hidden = true;
    jobBox.hidden = false;
    jobBox.dataset.createdAt = job.createdAt;
    jobBadge.textContent = STATUS_LABELS[job.status] ?? job.status;
    jobBadge.className = `print-job-badge${job.status === 'PRINTING' ? ' ok' : ''}${['FAILED', 'TIMEOUT'].includes(job.status) ? ' bad' : ''}`;
    jobFile.textContent = `${job.fileName} · Plate ${job.plateIndex}`;
    jobFile.title = job.remotePath;
    jobMessage.textContent = job.message;

    const uploading = job.status === 'UPLOADING' && job.upload;
    jobUpload.hidden = !uploading;
    if (uploading) {
      jobUploadBar.style.width = `${job.upload.percent}%`;
      jobUploadText.textContent = `${job.upload.percent}% · ${formatBytes(job.upload.bytes)} / ${formatBytes(job.upload.total)}`;
    }

    const codes = [
      job.printerResponse?.reason && `Máy in: ${job.printerResponse.result} – ${job.printerResponse.reason}`,
      job.printError && `print_error: ${job.printError}`,
      ...job.hmsErrors.map((c) => `HMS ${c}`),
      ...job.warnings.map((w) => `⚠️ ${w}`),
    ].filter(Boolean);
    jobCodes.hidden = codes.length === 0;
    jobCodes.replaceChildren(...codes.map((c) => el('li', { text: c })));

    jobHistory.replaceChildren(
      ...job.history.map((h) => el('li', { text: `${new Date(h.at).toLocaleTimeString()} ${h.status} – ${h.message}` }))
    );
  }

  const onJobEvent = (event) => {
    const job = event.detail;
    // Only follow the newest job; late updates of older jobs are ignored
    if (!job || job.createdAt < (jobBox.dataset.createdAt ?? '')) return;
    currentJobId = job.id;
    renderJob(job);
    if (['PRINTING', 'FAILED', 'TIMEOUT'].includes(job.status)) {
      const type = job.status === 'PRINTING' ? 'success' : 'error';
      if (jobBox.dataset.notified !== `${job.id}:${job.status}`) {
        jobBox.dataset.notified = `${job.id}:${job.status}`;
        showToast(job.message, type);
        addLog(`Lệnh in ${job.id}: ${job.status} – ${job.message}`, type);
      }
    }
  };
  window.addEventListener('gateway:print-job', onJobEvent);

  // Restore the latest job after a page reload
  fetch('/api/print/jobs')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const latest = data?.jobs?.[0];
      if (latest && !currentJobId) {
        currentJobId = latest.id;
        renderJob(latest);
      }
    })
    .catch(() => {});

  return () => {
    window.removeEventListener('gateway:print-job', onJobEvent);
    xhr?.abort();
  };
}
