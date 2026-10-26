'use client';

import { CaretRightOutlined, DesktopOutlined, ExportOutlined, FullscreenOutlined, StopOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Space, Typography, Upload } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useActions } from '../DashboardContext';

interface StudioConfig {
  enabled: boolean;
  url: string;
  importsEnabled: boolean;
}

/**
 * The gateway repairs STL meshes on import (POST /api/studio/import → repair); the original is kept in
 * /imports/.originals when it changed anything
 */
function repairNote(repair: { skipped?: string; changed?: boolean; summary?: string } | undefined): string {
  if (!repair) return '';
  if (repair.skipped) return ` (chưa sửa lưới: ${repair.skipped})`;
  if (repair.changed) return ` (đã sửa lưới: ${repair.summary}; bản gốc ở /imports/.originals)`;
  return ` (lưới: ${repair.summary})`;
}

type Status = { type: 'info' | 'success' | 'error'; text: string } | null;

/** POSTs one file to Studio's /imports, reporting upload progress */
function uploadOne(file: File, onProgress: (percent: number) => void, xhrRef: { current: XMLHttpRequest | null }) {
  return new Promise<any>((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open('POST', '/api/studio/import');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* handled below */
      }
      if (xhr.status === 201 && data?.success) resolve(data);
      else reject(new Error(data?.message || `Lỗi HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Mất kết nối khi gửi file.'));
    xhr.send(form);
  });
}

/**
 * Bambu Studio panel: embeds the real app streamed from its container (STUDIO_URL) and sends models
 * from this computer into its /imports folder (POST /api/studio/import), since Studio's own file
 * dialogs only see the container. Slicing and printing happen in Studio itself.
 */
export function StudioCard() {
  const { showToast, addLog } = useActions();
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [open, setOpen] = useState(false);
  // A frame is only a secure context when its parent is one too. Over plain HTTP from another machine
  // the embedded stream can't use the browser's video decoder, so Studio opens as a top-level HTTPS tab.
  const [canEmbed, setCanEmbed] = useState(true);
  const [status, setStatus] = useState<Status>(null);
  const [sending, setSending] = useState(false);
  const frameWrap = useRef<HTMLDivElement>(null);
  const xhr = useRef<XMLHttpRequest | null>(null);

  useEffect(() => {
    setCanEmbed(window.isSecureContext);
    let cancelled = false;
    fetch('/api/studio')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => !cancelled && data && setConfig(data))
      .catch(() => {});
    return () => {
      cancelled = true;
      xhr.current?.abort();
    };
  }, []);

  const importFiles = async (files: File[]) => {
    if (files.length === 0 || sending) return;
    setSending(true);
    const sent: string[] = [];
    try {
      for (const [i, file] of files.entries()) {
        const prefix = files.length > 1 ? `(${i + 1}/${files.length}) ` : '';
        const data = await uploadOne(file, (percent) => setStatus({ type: 'info', text: `⏳ ${prefix}Đang gửi ${file.name}: ${percent}%` }), xhr);
        sent.push(data.studioPath + repairNote(data.repair));
        if (data.repair?.changed) addLog(`Đã sửa lưới ${data.name}: ${data.repair.summary}.`, 'success');
      }
      setStatus({ type: 'success', text: `✅ Đã gửi: ${sent.join(', ')}. Trong Studio: File → Import → thư mục /imports.` });
      addLog(`Đã gửi ${sent.length} file vào Bambu Studio (/imports).`, 'success');
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setStatus({ type: 'error', text: `❌ ${text}` });
      showToast(text, 'error');
    } finally {
      xhr.current = null;
      setSending(false);
    }
  };

  const toggle = () => {
    if (!config) return;
    if (!canEmbed) window.open(config.url, '_blank', 'noopener');
    else setOpen(!open);
  };

  const fullscreen = () =>
    frameWrap.current?.requestFullscreen?.().catch((err) => showToast(`Không bật được toàn màn hình: ${err.message}`, 'error'));

  return (
    <Card
      title={
        <>
          <DesktopOutlined /> Bambu Studio
        </>
      }
      extra={
        <Space wrap size={6}>
          {config?.importsEnabled && (
            <Upload
              multiple
              accept=".3mf,.stl,.obj,.step,.stp"
              showUploadList={false}
              disabled={sending}
              // Every picked file arrives here; the whole selection is sent once, in order
              beforeUpload={(file, list) => {
                if (file === list[0]) importFiles(list as File[]);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />} loading={sending}>
                Gửi file vào Studio
              </Button>
            </Upload>
          )}
          <Button type="primary" icon={open ? <StopOutlined /> : <CaretRightOutlined />} onClick={toggle} disabled={!config}>
            {!canEmbed ? 'Mở Studio (tab mới)' : open ? 'Đóng Studio' : 'Mở Studio'}
          </Button>
          {open && (
            <Button icon={<FullscreenOutlined />} onClick={fullscreen}>
              Toàn màn hình
            </Button>
          )}
          <Button icon={<ExportOutlined />} href={config?.url} target="_blank" rel="noopener noreferrer" disabled={!config}>
            Tab mới
          </Button>
        </Space>
      }
    >
      {/* The iframe is only loaded on demand: the stream costs CPU on the container and bandwidth here */}
      {open && config && (
        <div className="studio-frame-wrap" ref={frameWrap}>
          <iframe src={config.url} className="studio-frame" title="Bambu Studio" allow="clipboard-read; clipboard-write; fullscreen" />
        </div>
      )}
      {status && <Alert type={status.type} title={status.text} style={{ marginTop: open ? 12 : 0, marginBottom: open ? 0 : 12 }} />}
      {!open && (
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          {canEmbed ? (
            <>
              Bambu Studio chạy trong container riêng nên không thấy ổ đĩa máy bạn. Bấm <b>Gửi file vào Studio</b>, rồi trong Studio mở{' '}
              <b>File → Import</b> và chọn thư mục <code>/imports</code>. Slice và in trực tiếp từ Studio (<b>Print plate</b>); Studio cần được
              kết nối với máy in.
            </>
          ) : (
            <>
              Dashboard đang mở qua HTTP từ máy khác nên không nhúng được Studio (trình duyệt chặn bộ giải mã video). Studio sẽ mở trong tab mới
              qua HTTPS; lần đầu hãy chấp nhận cảnh báo chứng chỉ tự ký. Dùng &quot;Gửi file vào Studio&quot; để đưa model từ máy này vào thư
              mục /imports.
            </>
          )}
        </Typography.Paragraph>
      )}
    </Card>
  );
}
