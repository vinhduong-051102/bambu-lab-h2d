'use client';

import { CameraOutlined, CopyOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Descriptions, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { initCameraZoom } from '../cameraZoom';
import { useActions, useBusy, useLive } from '../DashboardContext';

interface CameraStatus {
  connected: boolean;
  source?: string;
  rtspUrl?: string;
  frameWidth?: number;
  frameHeight?: number;
  fps?: number;
  framesReceived?: number;
  lastFrameAt?: string | null;
  lastError?: string | null;
}

const STATUS_MS = 5000;

/**
 * The printer's camera as MJPEG, with digital zoom. The stream only runs while `active` (the printer page
 * is shown), to save bandwidth; on error the last snapshot shows and the stream re-opens with backoff.
 */
export function CameraCard({ active }: { active: boolean }) {
  const { reconnects } = useLive();
  const { showToast, addLog, compact } = useActions();
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const zoomInRef = useRef<HTMLButtonElement>(null);
  const zoomOutRef = useRef<HTMLButtonElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const levelRef = useRef<HTMLSpanElement>(null);
  const restartRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState<CameraStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [reconnecting, reconnect] = useBusy();

  useEffect(
    () =>
      initCameraZoom({
        viewport: viewportRef.current,
        img: imgRef.current,
        zoomInBtn: zoomInRef.current,
        zoomOutBtn: zoomOutRef.current,
        resetBtn: resetRef.current,
        levelLabel: levelRef.current,
      }),
    []
  );

  // A WebSocket reconnect usually means the gateway restarted, which also ended the MJPEG response
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !active) return;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 3000;

    const restart = (resetBackoff = true) => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (resetBackoff) retryDelay = 3000;
      // Cache-busting query forces a fresh connection even when the src was already the MJPEG URL
      img.src = `/api/camera/mjpeg?t=${Date.now()}`;
    };
    img.onerror = () => {
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        restart(false);
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
      if (!img.src.includes('/api/camera/snapshot')) img.src = `/api/camera/snapshot?t=${Date.now()}`;
    };
    img.onload = () => {
      if (img.src.includes('/api/camera/mjpeg')) retryDelay = 3000;
    };
    restart();
    restartRef.current = restart;

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      img.onerror = null;
      img.onload = null;
      img.removeAttribute('src');
      restartRef.current = () => {};
    };
  }, [active, reconnects]);

  const loadStatus = async () => {
    try {
      const res = await fetch('/api/camera/status');
      if (!res.ok) return;
      setStatus(await res.json());
      setStatusFailed(false);
    } catch {
      setStatusFailed(true);
    }
  };

  useEffect(() => {
    if (!active) return;
    loadStatus();
    const timer = setInterval(loadStatus, STATUS_MS);
    return () => clearInterval(timer);
  }, [active]);

  const copyRtsp = () => {
    const url = status?.rtspUrl;
    if (!url) return;
    navigator.clipboard
      .writeText(url)
      .then(() => showToast('Đã copy luồng RTSPS URL vào Clipboard!', 'success'))
      .catch(() => showToast(`RTSPS URL: ${url}`, 'info'));
  };

  const onReconnect = () =>
    reconnect(async () => {
      addLog('[CAMERA] 🔄 Khởi động lại luồng camera...');
      try {
        // The gateway answers once the new stream delivers a frame (or after ~10s without one)
        const res = await fetch('/api/camera/reconnect', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast(data.message || 'Camera đã kết nối lại.', 'success');
          addLog(`[CAMERA] ✅ ${data.message || 'Camera đã kết nối lại.'}`, 'success');
        } else {
          const text = data.message || data.error || `HTTP ${res.status}`;
          showToast(`Camera: ${text}`, 'warn');
          addLog(`[CAMERA] ❌ ${text}`, 'warn');
        }
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        showToast(`Lỗi kết nối: ${text}`, 'error');
        addLog(`[CAMERA] ❌ Lỗi kết nối: ${text}`, 'warn');
      } finally {
        // Re-open the MJPEG stream either way: the browser's old connection may be dead
        restartRef.current();
        loadStatus();
      }
    });

  const live = status?.connected && (status.framesReceived ?? 0) > 0;
  const age = status?.lastFrameAt ? `${Math.max(0, Date.now() - new Date(status.lastFrameAt).getTime())}ms ago` : 'No frames yet';
  const connected = statusFailed ? (
    <Typography.Text type="danger">❌ Disconnected (API Error)</Typography.Text>
  ) : !status ? (
    'Checking...'
  ) : status.connected ? (
    <Typography.Text type="success">● Connected</Typography.Text>
  ) : (
    <Typography.Text type="danger">❌ Disconnected</Typography.Text>
  );

  return (
    <Card
      title={
        <>
          <CameraOutlined /> Camera Live Stream
        </>
      }
      extra={
        <Space wrap size={4}>
          <Button size="small" icon={<CopyOutlined />} onClick={copyRtsp} title="Copy RTSPS URL cho VLC / Home Assistant">
            RTSP
          </Button>
          <Button size="small" icon={<ReloadOutlined />} loading={reconnecting} onClick={onReconnect} title="Khởi động lại luồng camera">
            Reconnect
          </Button>
          <Button size="small" type="link" href="/api/camera/snapshot" target="_blank">
            Snapshot
          </Button>
          <Button size="small" type="link" href="/api/camera/mjpeg" target="_blank">
            MJPEG
          </Button>
        </Space>
      }
      style={{ height: '100%' }}
    >
      <div
        className="camera-viewport"
        ref={viewportRef}
        tabIndex={0}
        title="Cuộn chuột / chụm 2 ngón để zoom, kéo để di chuyển, nhấp đúp để phóng to / thu nhỏ"
      >
        <img ref={imgRef} alt="Bambu Camera Feed" className="camera-feed-img" draggable={false} />
        <div className="camera-zoom-controls" aria-label="Zoom camera">
          <button type="button" ref={zoomOutRef} className="cam-zoom-btn" title="Thu nhỏ (−)" aria-label="Thu nhỏ">
            −
          </button>
          <button type="button" ref={resetRef} className="cam-zoom-btn cam-zoom-level" title="Về 1× (0 / Esc)" aria-label="Đặt lại zoom">
            <span ref={levelRef}>1.0×</span>
          </button>
          <button type="button" ref={zoomInRef} className="cam-zoom-btn" title="Phóng to (+)" aria-label="Phóng to">
            +
          </button>
        </div>
        <div className="camera-overlay">
          <span className="cam-live-indicator" style={{ color: live ? '#10b981' : '#ef4444' }}>
            {live ? `● LIVE (${(status?.source || 'RTSP').toUpperCase()})` : '❌ CAMERA DISCONNECTED'}
          </span>
          <span className="cam-rtsp-url">RTSPS: {status ? status.rtspUrl || 'Unknown' : 'Loading...'}</span>
        </div>
      </div>

      <Descriptions
        size="small"
        column={{ xs: 2, sm: 3, lg: 5 }}
        style={{ marginTop: 12 }}
        items={[
          { key: 'status', label: 'Status', children: connected },
          { key: 'source', label: 'Source', children: (status?.source || 'none').toUpperCase() },
          {
            key: 'res',
            label: 'Resolution',
            children: status?.frameWidth && status.frameHeight ? `${status.frameWidth}x${status.frameHeight}` : '1680x1080 (RTSP)',
          },
          { key: 'fps', label: 'FPS', children: status?.fps || 0 },
          { key: 'age', label: 'Last Frame', children: status ? age : '--' },
        ]}
      />
      {status?.lastError && <Alert type="error" showIcon title={`Error: ${status.lastError}`} style={{ marginTop: 8 }} />}
      {!compact && (
        <Alert
          type="info"
          style={{ marginTop: 12 }}
          title="💡 Hướng Dẫn Xem Camera Trực Tiếp"
          description={
            <ol style={{ paddingLeft: 18, margin: 0 }}>
              <li>
                <b>Kiểm tra IP &amp; Access Code:</b> Đảm bảo <code>BAMBU_HOST</code> (IP máy in) và <code>BAMBU_ACCESS_CODE</code> trong
                file <code>.env</code> khớp với thông tin trên máy in.
              </li>
              <li>
                <b>Bật LAN Liveview trên máy in:</b> Mở màn hình máy in Bambu → Vào <b>Settings</b> → <b>WLAN/Network</b> → Bật{' '}
                <b>LAN Mode Liveview: ON</b>.
              </li>
              <li>
                <b>Xem qua VLC / Home Assistant / OBS:</b> Dùng luồng <code>rtsps://bblp:ACCESS_CODE@IP:322/streaming/live/1</code> (bấm
                nút &quot;RTSP&quot; ở trên).
              </li>
            </ol>
          }
        />
      )}
    </Card>
  );
}
