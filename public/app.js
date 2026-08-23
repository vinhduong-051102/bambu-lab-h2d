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

  // Diagnostics Elements
  const diagActiveTool = document.getElementById('diagActiveTool');
  const diagNozzles = document.getElementById('diagNozzles');
  const diagExtruders = document.getElementById('diagExtruders');
  const diagRawJson = document.getElementById('diagRawJson');
  const btnRefreshDiag = document.getElementById('btnRefreshDiag');

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

  // Diagnostics Explorer Fetcher
  async function fetchDiagnostics() {
    try {
      const res = await fetch('/api/printer/diagnostics');
      if (!res.ok) return;
      const data = await res.json();

      // Render Raw Data Json
      if (diagRawJson) {
        diagRawJson.textContent = JSON.stringify({
          rawPayload: data.rawPayload,
          discoveredCandidates: data.temperatureCandidates,
        }, null, 2);
      }
    } catch (err) {
      console.warn('Diagnostics fetch failed:', err);
    }
  }

  btnRefreshDiag?.addEventListener('click', fetchDiagnostics);

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
      const { nozzles, nozzle, nozzle2, bed, chamber } = state.temperatures;

      const n1 = (nozzles && nozzles.length > 0) ? nozzles[0] : nozzle;
      const n2 = (nozzles && nozzles.length > 1) ? nozzles[1] : nozzle2;

      if (n1) {
        if (nozzleCurText) nozzleCurText.textContent = n1.current !== null && n1.current !== undefined ? n1.current : '--';
        if (nozzleTarText) nozzleTarText.textContent = `/ ${n1.target !== null && n1.target !== undefined ? n1.target : 0}°C`;
        const nozzlePct = Math.min(100, Math.max(0, ((Number(n1.current) || 0) / 300) * 100));
        if (nozzleBar) nozzleBar.style.width = `${nozzlePct}%`;
      }

      if (n2) {
        if (nozzle2CurText) nozzle2CurText.textContent = n2.current !== null && n2.current !== undefined ? n2.current : '--';
        if (nozzle2TarText) nozzle2TarText.textContent = n2.target !== null && n2.target !== undefined ? `/ ${n2.target}°C` : '/ --°C';
        const nozzle2Pct = Math.min(100, Math.max(0, ((Number(n2.current) || 0) / 300) * 100));
        if (nozzle2Bar) nozzle2Bar.style.width = `${nozzle2Pct}%`;
      }

      if (bed) {
        bedCurText.textContent = bed.current !== null ? bed.current : '0';
        bedTarText.textContent = `/ ${bed.target !== null ? bed.target : 0}°C`;
        const bedPct = Math.min(100, Math.max(0, ((bed.current || 0) / 120) * 100));
        bedBar.style.width = `${bedPct}%`;
      }

      if (chamber !== undefined && chamber !== null) {
        const chamberVal = typeof chamber === 'object' ? chamber.current : chamber;
        if (chamberCurText) chamberCurText.textContent = chamberVal !== null && chamberVal !== undefined ? chamberVal : '--';
      }
    }

    if (state.fan) {
      const part = state.fan.cooling ?? state.fan.part ?? 0;
      const aux = state.fan.bigFan1 ?? state.fan.aux ?? 0;
      const chamber = state.fan.bigFan2 ?? state.fan.chamber ?? 0;

      partFanPct.textContent = `${part}%`;
      partFanBar.style.width = `${part}%`;

      auxFanPct.textContent = `${aux}%`;
      auxFanBar.style.width = `${aux}%`;

      chamberFanPct.textContent = `${chamber}%`;
      chamberFanBar.style.width = `${chamber}%`;
    }

    if (state.ams) {
      renderAMS(state.ams, state.amsActiveTrayId);
    }

    if (state.updatedAt) {
      const timeStr = new Date(state.updatedAt).toLocaleTimeString();
      lastUpdateText.textContent = `Cập nhật lần cuối: ${timeStr}`;
    }

    fetchDiagnostics();
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
  function renderAMS(amsUnits, activeTrayId = null) {
    if (!amsUnits || amsUnits.length === 0) {
      amsContainer.innerHTML = '<div class="empty-ams">Chưa có dữ liệu khay nhựa AMS</div>';
      return;
    }

    amsContainer.innerHTML = amsUnits.map((unit) => {
      const traysList = unit.trays || unit.filaments || [];
      const filamentsHtml = traysList.map((fil, idx) => {
        const hexColor = formatHexColor(fil.color || fil.rawColor);
        const rawRem = fil.remain !== undefined && fil.remain !== null ? fil.remain : fil.remainingPercentage;
        let remText = '--';
        if (rawRem !== null && rawRem !== undefined) {
          const numRem = Number(rawRem);
          remText = !isNaN(numRem) ? `${Math.max(0, numRem)}%` : `${rawRem}%`;
        }

        const isActive = activeTrayId === idx;
        const activeClass = isActive ? 'active-tray' : '';
        const activeBadge = isActive ? '<span class="active-tray-badge">ACTIVE</span>' : '';

        return `
          <div class="tray-item ${activeClass}" data-tray-id="${idx}" title="Bấm để NẠP khay nhựa này (Slot #${idx + 1})">
            ${activeBadge}
            <div class="color-dot" style="background-color: ${hexColor};" title="Màu: ${hexColor}"></div>
            <span class="tray-type">${fil.type || 'N/A'}</span>
            <span class="tray-rem">${remText}</span>
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

    // Attach click handlers to trays for fast loading
    document.querySelectorAll('.tray-item').forEach((el) => {
      el.addEventListener('click', () => {
        const trayId = Number(el.getAttribute('data-tray-id'));
        if (!isNaN(trayId)) {
          if (confirm(`Bạn có muốn NẠP NHỰA từ AMS Khay #${trayId + 1} vào đầu in không?`)) {
            sendCommand('/api/ams/load', 'POST', { target: trayId, temp: 220 });
          }
        }
      });
    });
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

  // Camera Info & Controls
  const btnCopyRtsp = document.getElementById('btnCopyRtsp');
  const btnReconnectCam = document.getElementById('btnReconnectCam');
  const camLiveIndicator = document.getElementById('camLiveIndicator');
  let currentRtspUrl = '';

  // Camera Telemetry & Status Elements
  const camStatConnected = document.getElementById('camStatConnected');
  const camStatSource = document.getElementById('camStatSource');
  const camStatRes = document.getElementById('camStatRes');
  const camStatFps = document.getElementById('camStatFps');
  const camStatAge = document.getElementById('camStatAge');
  const camErrorBanner = document.getElementById('camErrorBanner');

  async function fetchCameraStatus() {
    try {
      const res = await fetch('/api/camera/status');
      if (res.ok) {
        const data = await res.json();
        currentRtspUrl = data.rtspUrl || '';

        if (camRtspUrl) {
          camRtspUrl.textContent = `RTSPS: ${data.rtspUrl || 'Unknown'}`;
        }

        if (camStatConnected) {
          if (data.connected) {
            camStatConnected.textContent = '● Connected';
            camStatConnected.style.color = '#10b981';
          } else {
            camStatConnected.textContent = '❌ Disconnected';
            camStatConnected.style.color = '#ef4444';
          }
        }

        if (camLiveIndicator) {
          if (data.connected && data.framesReceived > 0) {
            camLiveIndicator.textContent = `● LIVE (${(data.source || 'RTSP').toUpperCase()})`;
            camLiveIndicator.style.color = '#10b981';
          } else {
            camLiveIndicator.textContent = '❌ CAMERA DISCONNECTED';
            camLiveIndicator.style.color = '#ef4444';
          }
        }

        if (camStatSource) camStatSource.textContent = (data.source || 'none').toUpperCase();
        if (camStatRes) {
          camStatRes.textContent = data.frameWidth && data.frameHeight ? `${data.frameWidth}x${data.frameHeight}` : '1680x1080 (RTSP)';
        }
        if (camStatFps) camStatFps.textContent = `${data.fps || 0}`;

        if (camStatAge) {
          if (data.lastFrameAt) {
            const ageMs = Math.max(0, Date.now() - new Date(data.lastFrameAt).getTime());
            camStatAge.textContent = `${ageMs}ms ago`;
          } else {
            camStatAge.textContent = 'No frames yet';
          }
        }

        if (camErrorBanner) {
          if (data.lastError) {
            camErrorBanner.style.display = 'block';
            camErrorBanner.textContent = `❌ Error: ${data.lastError}`;
          } else {
            camErrorBanner.style.display = 'none';
          }
        }
      }
    } catch (err) {
      if (camStatConnected) {
        camStatConnected.textContent = '❌ Disconnected (API Error)';
        camStatConnected.style.color = '#ef4444';
      }
    }
  }

  btnCopyRtsp?.addEventListener('click', () => {
    if (!currentRtspUrl) return;
    navigator.clipboard.writeText(currentRtspUrl).then(() => {
      showToast('Đã copy luồng RTSPS URL vào Clipboard!', 'success');
    }).catch(() => {
      showToast(`RTSPS URL: ${currentRtspUrl}`, 'info');
    });
  });

  btnReconnectCam?.addEventListener('click', async () => {
    showToast('Đang gửi lệnh Reconnect Camera TLS 6000...', 'info');
    try {
      const res = await fetch('/api/camera/reconnect', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(data.message || 'Đã thử kết nối lại camera!', 'success');
        addLog('🔄 Đã gửi lệnh reconnect Camera TLS 6000.', 'info');
        setTimeout(fetchCameraStatus, 2000);
      }
    } catch (err) {
      showToast(`Lỗi kết nối API: ${err.message}`, 'error');
    }
  });

  // Compact View Toggle (Ẩn/Hiện Log & Hướng Dẫn)
  const btnToggleCompactView = document.getElementById('btnToggleCompactView');
  const compactIcon = document.getElementById('compactIcon');
  const compactText = document.getElementById('compactText');

  function setCompactMode(enable) {
    if (enable) {
      document.body.classList.add('compact-mode');
      if (compactIcon) compactIcon.textContent = '✨';
      if (compactText) compactText.textContent = 'Giao Diện: Đơn Giản';
      if (btnToggleCompactView) {
        btnToggleCompactView.style.background = 'rgba(16, 185, 129, 0.2)';
        btnToggleCompactView.style.borderColor = '#10b981';
        btnToggleCompactView.style.color = '#6ee7b7';
      }
      localStorage.setItem('bambu_compact_mode', 'true');
    } else {
      document.body.classList.remove('compact-mode');
      if (compactIcon) compactIcon.textContent = '👁️';
      if (compactText) compactText.textContent = 'Giao Diện: Đầy Đủ';
      if (btnToggleCompactView) {
        btnToggleCompactView.style.background = 'rgba(139, 92, 246, 0.15)';
        btnToggleCompactView.style.borderColor = 'rgba(139, 92, 246, 0.4)';
        btnToggleCompactView.style.color = '#c084fc';
      }
      localStorage.setItem('bambu_compact_mode', 'false');
    }
  }

  // Restore saved compact mode setting
  const savedCompact = localStorage.getItem('bambu_compact_mode') === 'true';
  setCompactMode(savedCompact);

  btnToggleCompactView?.addEventListener('click', () => {
    const isCompact = document.body.classList.contains('compact-mode');
    setCompactMode(!isCompact);
    showToast(!isCompact ? 'Đã bật Chế Độ Giao Diện Đơn Giản (Đã ẩn log & hướng dẫn)' : 'Đã chuyển về Chế Độ Giao Diện Đầy Đủ', 'info');
  });

  // API Documentation Explorer Modal
  const openApiModalBtn = document.getElementById('openApiModalBtn');
  const closeApiModalBtn = document.getElementById('closeApiModalBtn');
  const apiModal = document.getElementById('apiModal');
  const apiListContainer = document.getElementById('apiListContainer');

  openApiModalBtn?.addEventListener('click', async () => {
    apiModal.classList.add('open');
    apiListContainer.innerHTML = '<div class="loading-spinner">Đang tải danh sách API...</div>';

    try {
      const res = await fetch('/api/routes');
      if (res.ok) {
        const data = await res.json();
        const routes = data.routes || [];

        const categories = {};
        routes.forEach((r) => {
          const cat = r.category || 'Khác';
          if (!categories[cat]) categories[cat] = [];
          categories[cat].push(r);
        });

        let html = '';
        for (const [catName, catRoutes] of Object.entries(categories)) {
          html += `
            <div class="api-category-group" style="margin-bottom: 16px;">
              <h4 style="color: #38bdf8; font-size: 0.9rem; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">📂 ${catName} (${catRoutes.length})</h4>
              <div style="display: flex; flex-direction: column; gap: 8px;">
                ${catRoutes.map((r) => {
                  const isPost = r.method.includes('POST');
                  const methodColor = isPost ? '#10b981' : '#3b82f6';
                  const methodBg = isPost ? 'rgba(16, 185, 129, 0.15)' : 'rgba(59, 130, 246, 0.15)';
                  return `
                    <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid var(--card-border); padding: 10px 12px; border-radius: var(--radius-sm); font-size: 0.8rem; overflow-x: hidden;">
                      <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px;">
                        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-family: var(--font-mono); word-break: break-all; max-width: 100%;">
                          <span style="background: ${methodBg}; color: ${methodColor}; padding: 2px 6px; border-radius: 4px; font-size: 0.72rem; font-weight: bold; flex-shrink: 0;">${r.method}</span>
                          <a href="${r.exampleUrl || '#'}" target="_blank" style="color: #f8fafc; font-weight: 600; text-decoration: none; word-break: break-all;">${r.path}</a>
                        </div>
                        ${r.body ? `<span style="font-family: var(--font-mono); font-size: 0.72rem; color: #94a3b8; background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px; word-break: break-all;">Body: ${r.body}</span>` : ''}
                      </div>
                      <div style="margin-top: 4px; color: #94a3b8; font-size: 0.76rem; word-break: break-word;">${r.description}</div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          `;
        }
        apiListContainer.innerHTML = html;
      }
    } catch (err) {
      apiListContainer.innerHTML = `<div style="color: #ef4444;">Không thể tải danh sách API: ${err.message}</div>`;
    }
  });

  closeApiModalBtn?.addEventListener('click', () => {
    apiModal?.classList.remove('open');
  });

  apiModal?.addEventListener('click', (e) => {
    if (e.target === apiModal) {
      apiModal.classList.remove('open');
    }
  });

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

  // Full Raw Data Modal Logic
  const btnOpenRawModal = document.getElementById('btnOpenRawModal');
  const closeRawModalBtn = document.getElementById('closeRawModalBtn');
  const rawModal = document.getElementById('rawModal');
  const rawSizeBadge = document.getElementById('rawSizeBadge');
  const rawTimeBadge = document.getElementById('rawTimeBadge');
  const rawSearchInput = document.getElementById('rawSearchInput');
  const btnCopyRawJson = document.getElementById('btnCopyRawJson');
  const btnDownloadRawJson = document.getElementById('btnDownloadRawJson');
  const btnRefreshRawModal = document.getElementById('btnRefreshRawModal');
  const fullRawJsonViewer = document.getElementById('fullRawJsonViewer');
  const rawTabBtns = document.querySelectorAll('.raw-tab-btn');

  let currentRawData = null;
  let activeTab = 'all';

  async function loadFullRawData() {
    if (fullRawJsonViewer) fullRawJsonViewer.textContent = 'Đang tải full raw telemetry...';
    try {
      const res = await fetch('/api/printer/diagnostics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      currentRawData = data;

      const payloadStr = JSON.stringify(data.rawPayload || {});
      const kbSize = (new Blob([payloadStr]).size / 1024).toFixed(2);
      if (rawSizeBadge) rawSizeBadge.textContent = `Payload Size: ${kbSize} KB`;
      if (rawTimeBadge) rawTimeBadge.textContent = `Last Updated: ${new Date().toLocaleTimeString()}`;

      renderRawTabContent();
    } catch (err) {
      if (fullRawJsonViewer) fullRawJsonViewer.textContent = `Lỗi khi tải raw telemetry: ${err.message}`;
    }
  }

  function renderRawTabContent() {
    if (!currentRawData || !fullRawJsonViewer) return;

    let targetObj = currentRawData;
    if (activeTab === 'all') targetObj = currentRawData.rawPayload || currentRawData;
    else if (activeTab === 'print') targetObj = currentRawData.rawPayload?.print || {};
    else if (activeTab === 'candidates') targetObj = currentRawData.temperatureCandidates || [];
    else if (activeTab === 'history') targetObj = currentRawData.historyDiffs || [];

    const jsonStr = JSON.stringify(targetObj, null, 2);
    const filter = rawSearchInput?.value.trim().toLowerCase();

    if (!filter) {
      fullRawJsonViewer.textContent = jsonStr;
    } else {
      const escapedFilter = filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escapedFilter})`, 'gi');
      const safeHtml = jsonStr
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(regex, '<mark>$1</mark>');
      fullRawJsonViewer.innerHTML = safeHtml;
    }
  }

  btnOpenRawModal?.addEventListener('click', () => {
    rawModal.classList.add('open');
    loadFullRawData();
  });

  closeRawModalBtn?.addEventListener('click', () => {
    rawModal.classList.remove('open');
  });

  rawModal?.addEventListener('click', (e) => {
    if (e.target === rawModal) rawModal.classList.remove('open');
  });

  rawTabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      rawTabBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.getAttribute('data-tab') || 'all';
      renderRawTabContent();
    });
  });

  rawSearchInput?.addEventListener('input', () => {
    renderRawTabContent();
  });

  btnRefreshRawModal?.addEventListener('click', () => {
    loadFullRawData();
  });

  btnCopyRawJson?.addEventListener('click', () => {
    if (!currentRawData) return;
    let targetObj = currentRawData.rawPayload || currentRawData;
    if (activeTab === 'print') targetObj = currentRawData.rawPayload?.print || {};
    if (activeTab === 'candidates') targetObj = currentRawData.temperatureCandidates || [];
    if (activeTab === 'history') targetObj = currentRawData.historyDiffs || [];

    navigator.clipboard.writeText(JSON.stringify(targetObj, null, 2)).then(() => {
      showToast('Đã copy dữ liệu Raw JSON vào Clipboard!', 'success');
    }).catch((err) => {
      showToast(`Lỗi khi copy: ${err.message}`, 'error');
    });
  });

  btnDownloadRawJson?.addEventListener('click', () => {
    if (!currentRawData) return;
    let targetObj = currentRawData.rawPayload || currentRawData;
    if (activeTab === 'print') targetObj = currentRawData.rawPayload?.print || {};
    if (activeTab === 'candidates') targetObj = currentRawData.temperatureCandidates || [];
    if (activeTab === 'history') targetObj = currentRawData.historyDiffs || [];

    const blob = new Blob([JSON.stringify(targetObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bambu-raw-${activeTab}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Đã tải xuống file JSON raw telemetry!', 'success');
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
              const { nozzles, bed, chamber } = message.data;
              if (Array.isArray(nozzles) && nozzles.length > 0) {
                if (nozzles[0] && nozzles[0].current !== null && nozzleCurText) {
                  nozzleCurText.textContent = `${nozzles[0].current}`;
                }
                if (nozzles[1] && nozzles[1].current !== null && nozzle2CurText) {
                  nozzle2CurText.textContent = `${nozzles[1].current}`;
                }
              }
              if (bed && bed.current !== null && bedCurText) {
                bedCurText.textContent = `${bed.current}`;
              }
              if (chamber && chamberCurText) {
                const cVal = typeof chamber === 'object' ? chamber.current : chamber;
                if (cVal !== null && cVal !== undefined) chamberCurText.textContent = `${cVal}`;
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
  fetchDiagnostics();
  fetchCameraStatus();

  // AMS Control Buttons & Modal Handlers
  const btnAmsUnload = document.getElementById('btnAmsUnload');
  const btnAmsRetry = document.getElementById('btnAmsRetry');
  const btnOpenAmsModal = document.getElementById('btnOpenAmsModal');
  const closeAmsModalBtn = document.getElementById('closeAmsModalBtn');
  const amsSettingModal = document.getElementById('amsSettingModal');
  const btnSaveAmsSetting = document.getElementById('btnSaveAmsSetting');

  const amsSelectTray = document.getElementById('amsSelectTray');
  const amsSelectType = document.getElementById('amsSelectType');
  const amsColorPicker = document.getElementById('amsColorPicker');
  const amsColorHex = document.getElementById('amsColorHex');
  const amsMinTemp = document.getElementById('amsMinTemp');
  const amsMaxTemp = document.getElementById('amsMaxTemp');

  btnAmsUnload?.addEventListener('click', () => {
    if (confirm('Bạn có chắc chắn muốn RÚT NHỰA hiện tại khỏi đầu in về bộ AMS?')) {
      sendCommand('/api/ams/unload', 'POST');
    }
  });

  btnAmsRetry?.addEventListener('click', () => {
    sendCommand('/api/ams/retry', 'POST');
  });

  btnOpenAmsModal?.addEventListener('click', () => {
    amsSettingModal?.classList.add('open');
  });

  closeAmsModalBtn?.addEventListener('click', () => {
    amsSettingModal?.classList.remove('open');
  });

  amsSettingModal?.addEventListener('click', (e) => {
    if (e.target === amsSettingModal) amsSettingModal.classList.remove('open');
  });

  amsColorPicker?.addEventListener('input', (e) => {
    if (amsColorHex) amsColorHex.value = e.target.value.toUpperCase();
  });

  amsColorHex?.addEventListener('input', (e) => {
    if (amsColorPicker && e.target.value.startsWith('#') && e.target.value.length === 7) {
      amsColorPicker.value = e.target.value;
    }
  });

  btnSaveAmsSetting?.addEventListener('click', async () => {
    const trayId = Number(amsSelectTray?.value || 0);
    const type = amsSelectType?.value || 'PLA';
    const color = amsColorHex?.value || '#3B82F6';
    const minTemp = Number(amsMinTemp?.value || 190);
    const maxTemp = Number(amsMaxTemp?.value || 240);

    await sendCommand('/api/ams/setting', 'POST', {
      amsId: 0,
      trayId,
      color,
      type,
      minTemp,
      maxTemp,
    });

    amsSettingModal?.classList.remove('open');
  });

  // Handle Camera Stream Fallback
  if (cameraImg) {
    cameraImg.onerror = () => {
      setTimeout(() => {
        if (cameraImg) cameraImg.src = `/api/camera/snapshot?t=${Date.now()}`;
      }, 3000);
    };
  }
});
