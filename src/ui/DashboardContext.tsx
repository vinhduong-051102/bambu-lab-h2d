'use client';

import { App } from 'antd';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PrinterState } from '../domain/PrinterState';

export type LogType = 'info' | 'success' | 'warn' | 'error';
export interface LogLine {
  id: number;
  time: string;
  message: string;
  type: LogType;
}
export type WsStatus = 'connecting' | 'online' | 'offline';
export type Printer = PrinterState & { realPrinterMode?: boolean };

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface LiveState {
  /** The printer's state from GET /api/printer, then every printer.state frame of the WebSocket */
  printer: Printer | null;
  wsStatus: WsStatus;
  /** Counts WebSocket reconnects: one usually means the gateway restarted, which also ended the camera stream */
  reconnects: number;
}

/** What components do; stable, so using it doesn't re-render a component on every printer update */
interface Actions {
  addLog: (message: string, type?: LogType) => void;
  showToast: (message: string, type?: LogType) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /**
   * POSTs a printer command and reports it (toast and console). AMS commands resolve once the printer
   * confirms them (or fails, or 200s pass). Resolves true when the command went through.
   */
  sendCommand: (url: string, body?: unknown) => Promise<boolean>;
  /** "Giao diện đơn giản": hides the logs' and guides' clutter */
  compact: boolean;
  setCompact: (compact: boolean) => void;
}

const ActionsContext = createContext<Actions | null>(null);
const LiveContext = createContext<LiveState>({ printer: null, wsStatus: 'connecting', reconnects: 0 });
const LogsContext = createContext<LogLine[]>([]);

export function useActions(): Actions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error('useActions outside DashboardProvider');
  return actions;
}

export const useLive = () => useContext(LiveContext);
export const useLogs = () => useContext(LogsContext);

/**
 * Runs `action` once at a time: `busy` is true while it runs, and a second press meanwhile only warns.
 * Buttons show `busy` as their loading state.
 */
export function useBusy() {
  const { showToast } = useActions();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      if (running.current) {
        showToast('⚠️ Lệnh đang được xử lý, vui lòng chờ...', 'warn');
        return undefined;
      }
      running.current = true;
      setBusy(true);
      try {
        return await action();
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [showToast]
  );
  return [busy, run] as const;
}

/**
 * Sends printer commands one at a time from a group of buttons: `pending` is the key of the button whose
 * command is running (shown as its loading state), and the group's other buttons wait.
 */
export function useCommand() {
  const { sendCommand, showToast } = useActions();
  const [pending, setPending] = useState<string | null>(null);
  const running = useRef(false);
  const send = useCallback(
    async (key: string, url: string, body?: unknown) => {
      if (running.current) {
        showToast('⚠️ Lệnh đang được xử lý, vui lòng chờ...', 'warn');
        return false;
      }
      running.current = true;
      setPending(key);
      try {
        return await sendCommand(url, body);
      } finally {
        running.current = false;
        setPending(null);
      }
    },
    [sendCommand, showToast]
  );
  return [pending, send] as const;
}

const MAX_LOGS = 500;
// Load/unload heat, cut, feed and purge: the server times them out after 180s
const AMS_WAIT_MS = 200_000;
const COMPACT_KEY = 'bambu_compact_mode';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function DashboardProvider({ children }: { children: ReactNode }) {
  const { message, modal } = App.useApp();
  const [printer, setPrinter] = useState<Printer | null>(null);
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [reconnects, setReconnects] = useState(0);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [compact, setCompactState] = useState(false);
  const logId = useRef(0);

  const addLog = useCallback((text: string, type: LogType = 'info') => {
    const line = { id: ++logId.current, time: new Date().toLocaleTimeString(), message: text, type };
    setLogs((prev) => (prev.length >= MAX_LOGS ? [...prev.slice(1 - MAX_LOGS), line] : [...prev, line]));
  }, []);

  const showToast = useCallback(
    (text: string, type: LogType = 'info') => {
      const show = { info: message.info, success: message.success, warn: message.warning, error: message.error }[type];
      show(text, 4);
    },
    [message]
  );

  const confirm = useCallback(
    ({ title, message: content, confirmText = 'Xác nhận', cancelText = 'Hủy', danger = false }: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        modal.confirm({
          title,
          content,
          okText: confirmText,
          cancelText,
          okButtonProps: { danger },
          // Dangerous actions focus Cancel so a stray Enter doesn't fire them
          autoFocusButton: danger ? 'cancel' : 'ok',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      }),
    [modal]
  );

  /** Follows an AMS command (GET /api/ams/command/:id) until the printer's telemetry confirms or fails it */
  const trackAmsCommand = useCallback(
    async (commandId: string) => {
      addLog(`[COMMAND AUDIT] ⏳ Bắt đầu theo dõi kết quả lệnh ${commandId} từ MQTT telemetry...`);
      const start = Date.now();
      let ackLogged = false;
      await sleep(1000);
      while (Date.now() - start < AMS_WAIT_MS) {
        try {
          const res = await fetch(`/api/ams/command/${commandId}`);
          if (res.ok) {
            const { record } = await res.json();
            const status = record?.status;
            if (status === 'VERIFYING' && !ackLogged) {
              ackLogged = true;
              addLog(`[KẾT QUẢ MÁY IN] 📨 Máy in đã nhận lệnh ${commandId}, đang chờ telemetry xác nhận...`);
            }
            if (status === 'COMPLETED') {
              const text = `[KẾT QUẢ MÁY IN] ✅ Lệnh ${commandId} (${String(record.type).toUpperCase()}) HOÀN TẤT THÀNH CÔNG! (Xác nhận từ MQTT Telemetry real-time)`;
              showToast(text, 'success');
              addLog(text, 'success');
              return true;
            }
            if (status === 'FAILED' || status === 'TIMEOUT') {
              const text = `[KẾT QUẢ MÁY IN] ❌ Lệnh ${commandId} ${status === 'TIMEOUT' ? 'HẾT GIỜ (TIMEOUT)' : 'THẤT BẠI'}: ${record?.error || 'Máy in không phản hồi'}`;
              showToast(text, 'warn');
              addLog(text, 'warn');
              return false;
            }
          }
        } catch (err) {
          console.warn('Command poll error:', err);
        }
        await sleep(1500);
      }
      addLog(`[KẾT QUẢ MÁY IN] ⚠️ Dừng theo dõi lệnh ${commandId} sau ${Math.round(AMS_WAIT_MS / 1000)} giây.`, 'warn');
      return false;
    },
    [addLog, showToast]
  );

  const sendCommand = useCallback(
    async (url: string, body?: unknown) => {
      const payload = JSON.stringify(body ?? {});
      addLog(`[OUTGOING LỆNH API] POST ${url} - Body: ${payload}`);
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast(data.message || 'Lệnh đã được gửi thành công!', 'success');
          addLog(
            `[HTTP ${res.status}] ✅ Gateway nhận lệnh thành công: ${data.message || 'SUCCESS'} ${data.commandId ? `(Command ID: ${data.commandId})` : ''}`,
            'success'
          );
          // Only AMS commands have a lifecycle endpoint; other commands complete on send
          if (data.commandId && url.startsWith('/api/ams/')) return trackAmsCommand(data.commandId);
          return true;
        }
        if (res.status === 403 && data.error === 'TEST_MODE_RESTRICTED') {
          showToast('Chế độ Read-Only: Đặt BAMBU_REAL_PRINTER=true để bật máy thật.', 'warn');
          addLog(`⚠️ Lệnh bị chặn (Safety Mode): ${data.message}`, 'warn');
        } else if (res.status === 409) {
          showToast(`⚠️ Lệnh bị hoãn (409 Conflict): ${data.message}`, 'warn');
          addLog(`[HTTP 409 CONFLICT] ⚠️ Thao tác AMS đang bận: ${data.message}`, 'warn');
        } else {
          showToast(`Lỗi (${res.status}): ${data.message || data.error}`, 'error');
          addLog(`[HTTP ${res.status}] ❌ Lỗi phản hồi API: ${data.message || data.error}`, 'warn');
        }
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        showToast(`Không thể kết nối API: ${text}`, 'error');
        addLog(`[ERROR] ❌ Lỗi mạng API: ${text}`, 'warn');
      }
      return false;
    },
    [addLog, showToast, trackAmsCommand]
  );

  const setCompact = useCallback((next: boolean) => {
    setCompactState(next);
    try {
      localStorage.setItem(COMPACT_KEY, String(next));
    } catch {
      /* the mode just isn't remembered */
    }
  }, []);

  useEffect(() => {
    try {
      setCompactState(localStorage.getItem(COMPACT_KEY) === 'true');
    } catch {
      /* full mode */
    }
  }, []);

  // Live state: REST once, then the WebSocket (reconnecting every 3s)
  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let connectedBefore = false;
    let lastHms = '';

    addLog('Khởi tạo giao diện Gateway Dashboard & Camera...');
    fetch('/api/printer')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !disposed) setPrinter((prev) => ({ ...prev, ...data }));
      })
      .catch((err) => console.warn('REST API poll failed:', err));

    function connect() {
      if (disposed) return;
      setWsStatus('connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      ws.onopen = () => {
        setWsStatus('online');
        addLog('Đã kết nối WebSocket thành công (Real-time mode).', 'success');
        if (connectedBefore) setReconnects((n) => n + 1);
        connectedBefore = true;
      };
      ws.onmessage = (event) => {
        let frame: { type?: string; data?: any };
        try {
          frame = JSON.parse(event.data);
        } catch (err) {
          console.error('Error parsing WS frame:', err);
          return;
        }
        const { type, data } = frame;
        if (type === 'printer.state' && data) {
          // realPrinterMode only comes from REST
          setPrinter((prev) => ({ ...data, realPrinterMode: prev?.realPrinterMode }));
        } else if (type === 'printer.connection' && typeof data?.online === 'boolean') {
          setPrinter((prev) => (prev ? { ...prev, online: data.online } : prev));
          addLog(`Trạng thái kết nối máy in: ${data.online ? 'Online' : 'Offline'}`, data.online ? 'success' : 'warn');
        } else if (type === 'printer.error' && data?.hmsErrors) {
          // Sent with every state update while the errors last: logged when they change
          const hms = JSON.stringify(data.hmsErrors.map(({ attr, code }: { attr: unknown; code: unknown }) => ({ attr, code })));
          if (hms !== lastHms) addLog(`Phát hiện cảnh báo HMS error: ${hms}`, 'warn');
          lastHms = hms;
        } else if (type === 'command.started') {
          addLog(`🚀 Đang thực thi lệnh: ${data?.command || 'Unknown'}`);
        } else if (type === 'command.completed') {
          addLog(`✅ Lệnh ${data?.command || ''} hoàn tất thành công!`, 'success');
        } else if (type === 'command.failed') {
          addLog(`❌ Lệnh ${data?.command || ''} thất bại: ${data?.error || ''}`, 'warn');
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        setWsStatus('offline');
        addLog('WebSocket mất kết nối. Đang thử lại sau 3s...', 'warn');
        retry ??= setTimeout(() => {
          retry = null;
          connect();
        }, 3000);
      };
    }
    connect();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [addLog]);

  const actions = useMemo<Actions>(
    () => ({ addLog, showToast, confirm, sendCommand, compact, setCompact }),
    [addLog, showToast, confirm, sendCommand, compact, setCompact]
  );
  const live = useMemo<LiveState>(() => ({ printer, wsStatus, reconnects }), [printer, wsStatus, reconnects]);
  return (
    <ActionsContext.Provider value={actions}>
      <LiveContext.Provider value={live}>
        <LogsContext.Provider value={logs}>{children}</LogsContext.Provider>
      </LiveContext.Provider>
    </ActionsContext.Provider>
  );
}
