document.addEventListener('DOMContentLoaded', () => {
  // UI Element References
  const serialBadge = document.getElementById('serialBadge');
  const realPrinterBadge = document.getElementById('realPrinterBadge');
  const printerDot = document.getElementById('printerDot');
  const printerStatusText = document.getElementById('printerStatusText');
  const wsDot = document.getElementById('wsDot');
  const wsStatusText = document.getElementById('wsStatusText');

  // Control Buttons
  const btnPause = document.getElementById('btnPause');
  const btnResume = document.getElementById('btnResume');
  const btnStop = document.getElementById('btnStop');

  // Job Hero
  const jobStateBadge = document.getElementById('jobStateBadge');
  const progressVal = document.getElementById('progressVal');
  const progressRing = document.getElementById('progressRing');
  const jobNameText = document.getElementById('jobNameText');
  const layersText = document.getElementById('layersText');
  const remainingTimeText = document.getElementById('remainingTimeText');

  // Thermal Controls (Dual Extruder support)
  const nozzleCurText = document.getElementById('nozzleCurr');
  const nozzleTarText = document.getElementById('nozzleTarget');
  const nozzleBar = document.getElementById('nozzleBar');
  const nozzleInput = document.getElementById('nozzleInput');
  const btnSetNozzle = document.getElementById('btnSetNozzle');

  const nozzle2CurText = document.getElementById('nozzle2Curr');
  const nozzle2TarText = document.getElementById('nozzle2Target');
  const nozzle2Bar = document.getElementById('nozzle2Bar');
  const nozzle2Input = document.getElementById('nozzle2Input');
  const btnSetNozzle2 = document.getElementById('btnSetNozzle2');

  const bedCurText = document.getElementById('bedCurr');
  const bedTarText = document.getElementById('bedTarget');
  const bedBar = document.getElementById('bedBar');
  const bedInput = document.getElementById('bedInput');
  const btnSetBed = document.getElementById('btnSetBed');

  const chamberCurText = document.getElementById('chamberCurr');

  // Camera
  const cameraImg = document.getElementById('cameraStreamImg');
  const camRtspUrl = document.getElementById('camRtspUrl');

  // Fans
  const partFanPct = document.getElementById('partFanPct');
  const partFanBar = document.getElementById('partFanBar');
  const sliderPartFan = document.getElementById('sliderPartFan');

  const auxFanPct = document.getElementById('auxFanPct');
  const auxFanBar = document.getElementById('auxFanBar');
  const sliderAuxFan = document.getElementById('sliderAuxFan');

  const chamberFanPct = document.getElementById('chamberFanPct');
  const chamberFanBar = document.getElementById('chamberFanBar');
  const sliderChamberFan = document.getElementById('sliderChamberFan');

  // AMS & Logs
  const amsContainer = document.getElementById('amsContainer');
  const consoleLogs = document.getElementById('consoleLogs');
  const lastUpdateText = document.getElementById('lastUpdateText');

  // Modal & Toast
  const openCapModalBtn = document.getElementById('openCapModalBtn');
  const closeCapModalBtn = document.getElementById('closeCapModalBtn');
  const capModal = document.getElementById('capModal');
  const capListContainer = document.getElementById('capListContainer');
  const toastContainer = document.getElementById('toastContainer');

  let ws = null;
  let wsReconnectTimer = null;

  // Toast System
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 4000);
  }

  // Console Log Helper
  function addLog(message, type = 'info') {
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    const time = new Date().toLocaleTimeString();
    line.textContent = `[${time}] ${message}`;
    consoleLogs.appendChild(line);
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
  }

  // Progress Ring Updater
  function updateProgressRing(percentage) {
    const radius = 76;
    const circumference = 2 * Math.PI * radius;
    const progress = Math.max(0, Math.min(100, percentage || 0));
    const offset = circumference - (progress / 100) * circumference;

    progressRing.style.strokeDashoffset = offset;
    progressVal.textContent = `${Math.round(progress)}%`;
  }

  // Format Minutes to HH:MM
  function formatMinutes(mins) {
    if (mins === null || mins === undefined || isNaN(mins)) return '--:--';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h > 0 ? h + 'h ' : ''}${m}m`;
  }

  // Dashboard UI Updater
  function updateDashboardUI(state) {
    if (!state) return;

    if (state.serial) {
      serialBadge.textContent = `Serial: ${state.serial}`;
    }

    if (state.realPrinterMode !== undefined) {
      if (state.realPrinterMode) {
        realPrinterBadge.textContent = 'Live Printer Mode';
        realPrinterBadge.className = 'mode-badge live-mode';
      } else {
        realPrinterBadge.textContent = 'Safety Mode (Read-Only)';
        realPrinterBadge.className = 'mode-badge safety-mode';
      }
    }

    printerDot.className = state.online ? 'status-dot online' : 'status-dot offline';
    printerStatusText.textContent = state.online ? 'Máy in Online' : 'Máy in Offline';

    if (state.state) {
      const stateStr = String(state.state).toUpperCase();
      jobStateBadge.textContent = stateStr;
      jobStateBadge.className = `badge state-badge ${stateStr.toLowerCase()}`;
    }

    updateProgressRing(state.progress ?? 0);

    if (state.job) {
      jobNameText.textContent = state.job.name || 'Không có tên tác vụ';
      layersText.textContent = `${state.job.currentLayer ?? 0} / ${state.job.totalLayers ?? 0}`;
      remainingTimeText.textContent = formatMinutes(state.job.remainingTimeMinutes);
    }

    if (state.temperatures) {
      const { nozzle, nozzle2, bed, chamber } = state.temperatures;

      if (nozzle) {
        if (nozzleCurText) nozzleCurText.textContent = nozzle.current !== null ? nozzle.current : '0';
        if (nozzleTarText) nozzleTarText.textContent = `/ ${nozzle.target !== null ? nozzle.target : 0}°C`;
        const nozzlePct = Math.min(100, Math.max(0, ((nozzle.current || 0) / 300) * 100));
        if (nozzleBar) nozzleBar.style.width = `${nozzlePct}%`;
      }

      if (nozzle2) {
        if (nozzle2CurText) nozzle2CurText.textContent = nozzle2.current !== null ? nozzle2.current : '0';
        if (nozzle2TarText) nozzle2TarText.textContent = `/ ${nozzle2.target !== null ? nozzle2.target : 0}°C`;
        const nozzle2Pct = Math.min(100, Math.max(0, ((nozzle2.current || 0) / 300) * 100));
        if (nozzle2Bar) nozzle2Bar.style.width = `${nozzle2Pct}%`;
      }

      if (bed) {
        bedCurText.textContent = bed.current !== null ? bed.current : '0';
        bedTarText.textContent = `/ ${bed.target !== null ? bed.target : 0}°C`;
        const bedPct = Math.min(100, Math.max(0, ((bed.current || 0) / 120) * 100));
        bedBar.style.width = `${bedPct}%`;
      }

      if (chamber !== undefined) {
        chamberCurText.textContent = chamber !== null ? chamber : '--';
      }
    }

    if (state.fan) {
      const part = state.fan.part ?? 0;
      const aux = state.fan.aux ?? 0;
      const chamber = state.fan.chamber ?? 0;

      partFanPct.textContent = `${part}%`;
      partFanBar.style.width = `${part}%`;

      auxFanPct.textContent = `${aux}%`;
      auxFanBar.style.width = `${aux}%`;

      chamberFanPct.textContent = `${chamber}%`;
      chamberFanBar.style.width = `${chamber}%`;
    }

    if (state.ams) {
      renderAMS(state.ams);
    }

    if (state.updatedAt) {
      const timeStr = new Date(state.updatedAt).toLocaleTimeString();
      lastUpdateText.textContent = `Cập nhật lần cuối: ${timeStr}`;
    }
  }

  // Helper Format Hex Color cho AMS Tray
  function formatHexColor(color) {
    if (!color) return '#374151';
    let c = String(color).trim();
    if (!c.startsWith('#')) {
      c = '#' + c;
    }
    return c;
  }

  // AMS Renderer
  function renderAMS(amsUnits) {
    if (!amsUnits || amsUnits.length === 0) {
      amsContainer.innerHTML = '<div class="empty-ams">Chưa có dữ liệu khay nhựa AMS</div>';
      return;
    }

    amsContainer.innerHTML = amsUnits.map((unit) => {
      const filamentsHtml = (unit.filaments || []).map((fil) => {
        const hexColor = formatHexColor(fil.color);
        return `
          <div class="tray-item">
            <div class="color-dot" style="background-color: ${hexColor};" title="Màu: ${hexColor}"></div>
            <span class="tray-type">${fil.type || 'N/A'}</span>
            <span class="tray-rem">${fil.remainingPercentage !== null ? fil.remainingPercentage + '%' : '--'}</span>
          </div>
        `;
      }).join('');

      return `
        <div class="ams-unit">
          <div class="ams-unit-title">AMS Unit #${unit.id}</div>
          <div class="tray-grid">${filamentsHtml}</div>
        </div>
      `;
    }).join('');
  }

  // Send Command API Helper
  async function sendCommand(url, method = 'POST', body = null) {
    try {
      const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      };

      const res = await fetch(url, options);
      const data = await res.json();

      if (res.ok && data.success) {
        showToast(data.message || 'Lệnh đã được gửi thành công!', 'success');
        addLog(`✅ ${data.message || 'Lệnh thành công'}`, 'success');
      } else {
        if (res.status === 403 && data.error === 'TEST_MODE_RESTRICTED') {
          showToast('Chế độ Read-Only: Đặt BAMBU_REAL_PRINTER=true để bật máy thật.', 'warn');
          addLog(`⚠️ Lệnh bị chặn (Safety Mode): ${data.message}`, 'warn');
        } else {
          showToast(`Lỗi (${res.status}): ${data.message || data.error}`, 'error');
          addLog(`❌ Lỗi lệnh (${res.status}): ${data.message}`, 'warn');
        }
      }
    } catch (err) {
      showToast(`Không thể kết nối API: ${err.message}`, 'error');
      addLog(`❌ Lỗi mạng API: ${err.message}`, 'warn');
    }
  }

  // Event Listeners for Quick Controls
  btnPause?.addEventListener('click', () => sendCommand('/api/printer/actions/pause'));
  btnResume?.addEventListener('click', () => sendCommand('/api/printer/actions/resume'));
  btnStop?.addEventListener('click', () => {
    if (confirm('Bạn có chắc chắn muốn HỦY tác vụ in hiện tại?')) {
      sendCommand('/api/printer/actions/stop');
    }
  });

  // Temperature Controls
  btnSetNozzle?.addEventListener('click', () => {
    const val = Number(nozzleInput.value);
    if (!isNaN(val)) sendCommand('/api/printer/temperature/nozzle', 'POST', { target: val });
  });

  btnSetNozzle2?.addEventListener('click', () => {
    const val = Number(nozzle2Input.value);
    if (!isNaN(val)) sendCommand('/api/printer/temperature/nozzle2', 'POST', { target: val });
  });

  btnSetBed?.addEventListener('click', () => {
    const val = Number(bedInput.value);
    if (!isNaN(val)) sendCommand('/api/printer/temperature/bed', 'POST', { target: val });
  });

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-type');
      const val = Number(btn.getAttribute('data-val'));
      if (type === 'nozzle') sendCommand('/api/printer/temperature/nozzle', 'POST', { target: val });
      if (type === 'nozzle2') sendCommand('/api/printer/temperature/nozzle2', 'POST', { target: val });
      if (type === 'bed') sendCommand('/api/printer/temperature/bed', 'POST', { target: val });
    });
  });

  // Fan Controls
  document.querySelectorAll('.btn-fan-set').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fanType = btn.getAttribute('data-fan');
      let slider = null;
      if (fanType === 'part') slider = sliderPartFan;
      if (fanType === 'aux') slider = sliderAuxFan;
      if (fanType === 'chamber') slider = sliderChamberFan;

      if (slider) {
        sendCommand(`/api/printer/fans/${fanType}`, 'POST', { speed: Number(slider.value) });
      }
    });
  });

  // Camera Info
  async function initCameraInfo() {
    try {
      const res = await fetch('/api/camera/info');
      if (res.ok) {
        const data = await res.json();
        if (data.rtspUrl) {
          camRtspUrl.textContent = `RTSPS: ${data.rtspUrl}`;
        }
      }
    } catch (err) {
      console.warn('Failed to fetch camera info:', err);
    }
  }

  // Capability Registry Explorer Modal
  openCapModalBtn?.addEventListener('click', async () => {
    capModal.classList.add('open');
    capListContainer.innerHTML = '<div class="loading-spinner">Đang tải danh sách capabilities...</div>';

    try {
      const res = await fetch('/api/capabilities');
      if (res.ok) {
        const data = await res.json();
        capListContainer.innerHTML = (data.capabilities || []).map((cap) => `
          <div class="cap-item">
            <div>
              <strong>${cap.name}</strong> (${cap.id})
              <div style="font-size: 0.78rem; color: #9ca3af;">${cap.description || ''}</div>
            </div>
            <span class="cap-status-pill ${cap.status.toLowerCase()}">${cap.status}</span>
          </div>
        `).join('');
      }
    } catch (err) {
      capListContainer.innerHTML = `<div class="error">Lỗi khi tải capabilities: ${err.message}</div>`;
    }
  });

  closeCapModalBtn?.addEventListener('click', () => {
    capModal.classList.remove('open');
  });

  // WebSocket Setup
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    wsDot.className = 'status-dot connecting';
    wsStatusText.textContent = 'WS Connecting...';

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      wsDot.className = 'status-dot online';
      wsStatusText.textContent = 'WS Live Data';
      addLog('Đã kết nối WebSocket thành công (Real-time mode).', 'success');

      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        switch (message.type) {
          case 'printer.state': {
            if (message.data) {
              updateDashboardUI(message.data);
              addLog(`Đã nhận dữ liệu telemetry (Trạng thái: ${message.data.state || 'UNKNOWN'})`, 'info');
            }
            break;
          }
          case 'printer.connection': {
            if (message.data && typeof message.data.online === 'boolean') {
              printerDot.className = message.data.online ? 'status-dot online' : 'status-dot offline';
              printerStatusText.textContent = message.data.online ? 'Máy in Online' : 'Máy in Offline';
              addLog(`Trạng thái kết nối máy in: ${message.data.online ? 'Online' : 'Offline'}`, message.data.online ? 'success' : 'warn');
            }
            break;
          }
          case 'printer.temperature': {
            if (message.data) {
              if (message.data.nozzle && message.data.nozzle.current !== null) {
                nozzleCurText.textContent = `${message.data.nozzle.current}`;
              }
              if (message.data.bed && message.data.bed.current !== null) {
                bedCurText.textContent = `${message.data.bed.current}`;
              }
            }
            break;
          }
          case 'printer.progress': {
            if (message.data && typeof message.data.progress === 'number') {
              updateProgressRing(message.data.progress);
            }
            break;
          }
          case 'printer.error': {
            if (message.data && message.data.hmsErrors) {
              addLog(`Phát hiện cảnh báo HMS error: ${JSON.stringify(message.data.hmsErrors)}`, 'warn');
            }
            break;
          }
          case 'command.started': {
            addLog(`🚀 Đang thực thi lệnh: ${message.data?.command || 'Unknown'}`, 'info');
            break;
          }
          case 'command.completed': {
            addLog(`✅ Lệnh ${message.data?.command || ''} hoàn tất thành công!`, 'success');
            break;
          }
          case 'command.failed': {
            addLog(`❌ Lệnh ${message.data?.command || ''} thất bại: ${message.data?.error || ''}`, 'warn');
            break;
          }
          default: {
            if (message.state !== undefined) {
              updateDashboardUI(message);
            }
          }
        }
      } catch (err) {
        console.error('Error parsing WS frame:', err);
      }
    };

    ws.onclose = () => {
      wsDot.className = 'status-dot offline';
      wsStatusText.textContent = 'WS Disconnected';
      addLog('WebSocket mất kết nối. Đang thử lại sau 3s...', 'warn');

      if (!wsReconnectTimer) {
        wsReconnectTimer = setTimeout(connectWebSocket, 3000);
      }
    };
  }

  // REST API Status Fetch
  async function fetchPrinterStatus() {
    try {
      const res = await fetch('/api/printer');
      if (res.ok) {
        const data = await res.json();
        updateDashboardUI(data);
      }
    } catch (err) {
      console.warn('REST API poll failed:', err);
    }
  }

  // Init
  addLog('Khởi tạo giao diện Gateway Dashboard & Camera...', 'info');
  connectWebSocket();
  fetchPrinterStatus();
  initCameraInfo();

  // Refresh camera snapshot (2s)
  setInterval(() => {
    if (cameraImg) {
      cameraImg.src = `/api/camera/snapshot?t=${Date.now()}`;
    }
  }, 2000);
});
