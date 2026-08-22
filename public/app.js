(function () {
  // DOM Elements
  const serialBadge = document.getElementById('serialBadge');
  const printerDot = document.getElementById('printerDot');
  const printerStatusText = document.getElementById('printerStatusText');
  const wsDot = document.getElementById('wsDot');
  const wsStatusText = document.getElementById('wsStatusText');

  const jobStateBadge = document.getElementById('jobStateBadge');
  const progressRing = document.getElementById('progressRing');
  const progressVal = document.getElementById('progressVal');
  const jobNameText = document.getElementById('jobNameText');
  const layersText = document.getElementById('layersText');
  const remainingTimeText = document.getElementById('remainingTimeText');

  const nozzleCurr = document.getElementById('nozzleCurr');
  const nozzleTarget = document.getElementById('nozzleTarget');
  const nozzleBar = document.getElementById('nozzleBar');

  const bedCurr = document.getElementById('bedCurr');
  const bedTarget = document.getElementById('bedTarget');
  const bedBar = document.getElementById('bedBar');

  const chamberCurr = document.getElementById('chamberCurr');

  const partFanPct = document.getElementById('partFanPct');
  const partFanBar = document.getElementById('partFanBar');
  const auxFanPct = document.getElementById('auxFanPct');
  const auxFanBar = document.getElementById('auxFanBar');
  const chamberFanPct = document.getElementById('chamberFanPct');
  const chamberFanBar = document.getElementById('chamberFanBar');
  const mainFanIcon = document.getElementById('mainFanIcon');

  const amsContainer = document.getElementById('amsContainer');
  const consoleLogs = document.getElementById('consoleLogs');
  const lastUpdateText = document.getElementById('lastUpdateText');

  const CIRCLE_CIRCUMFERENCE = 477.52; // 2 * Math.PI * 76

  let ws = null;
  let wsReconnectTimer = null;
  let pollTimer = null;

  function addLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('vi-VN');
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = `[${timestamp}] ${message}`;
    consoleLogs.appendChild(line);
    consoleLogs.scrollTop = consoleLogs.scrollHeight;

    // Limit log entries
    while (consoleLogs.children.length > 50) {
      consoleLogs.removeChild(consoleLogs.firstChild);
    }
  }

  function formatTimeMinutes(totalMinutes) {
    if (totalMinutes === null || totalMinutes === undefined || isNaN(totalMinutes)) {
      return '--:--';
    }
    const mins = Math.max(0, Math.floor(totalMinutes));
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    if (hours > 0) {
      return `${hours}h ${remainingMins}m`;
    }
    return `${remainingMins} phút`;
  }

  function updateDashboardUI(state) {
    if (!state) return;

    // 1. Header & Serial
    if (state.serial) {
      serialBadge.textContent = `Serial: ${state.serial}`;
    }

    // Printer Online Status
    if (state.online) {
      printerDot.className = 'status-dot online';
      printerStatusText.textContent = 'Máy in Online';
    } else {
      printerDot.className = 'status-dot offline';
      printerStatusText.textContent = 'Máy in Offline';
    }

    // 2. Job Status & Progress
    const status = state.state || 'UNKNOWN';
    jobStateBadge.textContent = status;
    jobStateBadge.className = `badge state-badge ${status.toLowerCase()}`;

    const progress = state.progress !== null && state.progress !== undefined ? Math.min(100, Math.max(0, state.progress)) : 0;
    progressVal.textContent = `${Math.round(progress)}%`;

    const strokeOffset = CIRCLE_CIRCUMFERENCE - (progress / 100) * CIRCLE_CIRCUMFERENCE;
    progressRing.style.strokeDashoffset = strokeOffset;

    // Job File & Layers
    const filename = state.job?.name ? state.job.name.replace(/\.(gcode|3mf)$/i, '') : 'Chưa có tác vụ';
    jobNameText.textContent = filename;

    const currLayer = state.job?.currentLayer ?? 0;
    const totalLayer = state.job?.totalLayers ?? 0;
    layersText.textContent = totalLayer > 0 ? `${currLayer} / ${totalLayer}` : '--';

    remainingTimeText.textContent = formatTimeMinutes(state.job?.remainingTimeMinutes);

    // 3. Temperature Gauges
    const nozzleC = state.temperatures?.nozzle?.current ?? 0;
    const nozzleT = state.temperatures?.nozzle?.target ?? 0;
    nozzleCurr.textContent = nozzleC !== null ? Math.round(nozzleC) : 0;
    nozzleTarget.textContent = nozzleT !== null ? `/ ${Math.round(nozzleT)}°C` : '/ 0°C';
    nozzleBar.style.width = `${Math.min(100, (nozzleC / 300) * 100)}%`;

    const bedC = state.temperatures?.bed?.current ?? 0;
    const bedT = state.temperatures?.bed?.target ?? 0;
    bedCurr.textContent = bedC !== null ? Math.round(bedC) : 0;
    bedTarget.textContent = bedT !== null ? `/ ${Math.round(bedT)}°C` : '/ 0°C';
    bedBar.style.width = `${Math.min(100, (bedC / 120) * 100)}%`;

    const chamberC = state.temperatures?.chamber;
    chamberCurr.textContent = chamberC !== null && chamberC !== undefined ? Math.round(chamberC) : '--';

    // 4. Fans
    const partF = state.fan?.part ?? 0;
    const auxF = state.fan?.aux ?? 0;
    const chamberF = state.fan?.chamber ?? 0;

    partFanPct.textContent = `${partF}%`;
    partFanBar.style.width = `${partF}%`;

    auxFanPct.textContent = `${auxF}%`;
    auxFanBar.style.width = `${auxF}%`;

    chamberFanPct.textContent = `${chamberF}%`;
    chamberFanBar.style.width = `${chamberF}%`;

    if (partF > 0 || auxF > 0 || chamberF > 0) {
      mainFanIcon.classList.add('spinning');
    } else {
      mainFanIcon.classList.remove('spinning');
    }

    // 5. AMS Units
    if (state.ams && Array.isArray(state.ams) && state.ams.length > 0) {
      amsContainer.innerHTML = '';
      state.ams.forEach((amsUnit) => {
        if (amsUnit.filaments && Array.isArray(amsUnit.filaments)) {
          amsUnit.filaments.forEach((fil, idx) => {
            const card = document.createElement('div');
            card.className = 'ams-slot-card';
            const colorHex = fil.color ? (fil.color.startsWith('#') ? fil.color : `#${fil.color}`) : '#64748b';
            card.innerHTML = `
              <div class="ams-slot-header">
                <span>AMS ${amsUnit.id} - Slot ${idx + 1}</span>
                <span class="color-dot" style="background-color: ${colorHex}"></span>
              </div>
              <div class="ams-slot-type">${fil.type || 'Chưa rõ'}</div>
              <div class="bar-container">
                <div class="bar-fill" style="width: ${fil.remainingPercentage ?? 0}%; background-color: ${colorHex}"></div>
              </div>
            `;
            amsContainer.appendChild(card);
          });
        }
      });
    } else {
      amsContainer.innerHTML = '<div class="empty-ams">Không có thông tin AMS hoặc chưa gắn khay nhựa.</div>';
    }

    // Footer timestamp
    if (state.updatedAt) {
      const updatedDate = new Date(state.updatedAt);
      lastUpdateText.textContent = `Cập nhật lần cuối: ${updatedDate.toLocaleTimeString('vi-VN')}`;
    }
  }

  // REST API Fallback Polling
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
        let printerState = null;

        if (message.type === 'printer.state') {
          printerState = message.data;
        } else if (message.type === 'printer.connection') {
          if (message.data && typeof message.data.online === 'boolean') {
            printerDot.className = message.data.online ? 'status-dot online' : 'status-dot offline';
            printerStatusText.textContent = message.data.online ? 'Máy in Online' : 'Máy in Offline';
          }
          return;
        } else {
          printerState = message;
        }

        if (printerState) {
          updateDashboardUI(printerState);
          addLog(`Đã nhận dữ liệu telemetry từ máy in (Trạng thái: ${printerState.state || 'UNKNOWN'})`, 'info');
        }
      } catch (err) {
        console.error('Error parsing WS frame:', err);
      }
    };

    ws.onerror = (err) => {
      console.error('WS Error:', err);
    };

    ws.onclose = () => {
      wsDot.className = 'status-dot offline';
      wsStatusText.textContent = 'WS Disconnected';
      addLog('WebSocket mất kết nối. Đang thử lại sau 3s...', 'warn');

      // Schedule reconnect
      if (!wsReconnectTimer) {
        wsReconnectTimer = setTimeout(connectWebSocket, 3000);
      }
    };
  }

  // Init
  addLog('Đang khởi tạo kết nối Gateway Web Dashboard...', 'info');
  connectWebSocket();
  fetchPrinterStatus();

  // Fallback Polling every 5 seconds in case WS drops
  pollTimer = setInterval(fetchPrinterStatus, 5000);
})();
