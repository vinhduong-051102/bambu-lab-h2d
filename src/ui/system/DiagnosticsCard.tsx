'use client';

import { CopyOutlined, DownloadOutlined, InfoCircleOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Card, Flex, Input, Modal, Segmented, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useActions, useBusy } from '../DashboardContext';

interface Diagnostics {
  rawPayload?: Record<string, any>;
  temperatureCandidates?: unknown[];
  historyDiffs?: unknown[];
}

type RawTab = 'all' | 'print' | 'candidates' | 'history';

const TABS: { value: RawTab; label: string }[] = [
  { value: 'all', label: 'Tất Cả (rawPayload)' },
  { value: 'print', label: 'Khối print (Status)' },
  { value: 'candidates', label: 'Discovered Sensors' },
  { value: 'history', label: 'History Diffs' },
];

function pick(data: Diagnostics, tab: RawTab): unknown {
  if (tab === 'print') return data.rawPayload?.print ?? {};
  if (tab === 'candidates') return data.temperatureCandidates ?? [];
  if (tab === 'history') return data.historyDiffs ?? [];
  return data.rawPayload ?? data;
}

async function fetchDiagnostics(): Promise<Diagnostics> {
  const res = await fetch('/api/printer/diagnostics');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** `text` with every case-insensitive match of `query` marked */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, at)) {
    parts.push(text.slice(at, i), <mark key={i}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  parts.push(text.slice(at));
  return parts;
}

function RawDataModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { showToast } = useActions();
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [tab, setTab] = useState<RawTab>('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await fetchDiagnostics());
      setLoadedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const json = data ? JSON.stringify(pick(data, tab), null, 2) : '';
  const size = data ? (new Blob([JSON.stringify(data.rawPayload ?? {})]).size / 1024).toFixed(2) : '0';

  const copy = () =>
    navigator.clipboard
      .writeText(json)
      .then(() => showToast('Đã copy dữ liệu Raw JSON vào Clipboard!', 'success'))
      .catch((err) => showToast(`Lỗi khi copy: ${err.message}`, 'error'));

  const download = () => {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `bambu-raw-${tab}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Đã tải xuống file JSON raw telemetry!', 'success');
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width="95vw"
      style={{ top: 20, maxWidth: 1400 }}
      title={
        <Space wrap>
          🌐 Full Telemetry Raw Data Viewer
          <Tag>Payload Size: {size} KB</Tag>
          <Tag>Last Updated: {loadedAt ? loadedAt.toLocaleTimeString() : '--:--:--'}</Tag>
        </Space>
      }
    >
      <Flex vertical gap={12}>
        <Flex gap={8} wrap justify="space-between">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="Tìm kiếm key, value, hnow, temp..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ maxWidth: 360 }}
          />
          <Space wrap>
            <Button icon={<CopyOutlined />} disabled={!data} onClick={copy}>
              Copy JSON
            </Button>
            <Button icon={<DownloadOutlined />} disabled={!data} onClick={download}>
              Tải File JSON
            </Button>
            <Button type="primary" icon={<ReloadOutlined />} onClick={load}>
              Làm mới
            </Button>
          </Space>
        </Flex>
        <Segmented<RawTab> options={TABS} value={tab} onChange={setTab} block />
        <pre className="raw-json raw-json-full">
          {error ? `Lỗi khi tải raw telemetry: ${error}` : data ? highlight(json, query) : 'Đang tải full raw telemetry...'}
        </pre>
      </Flex>
    </Modal>
  );
}

/** The printer's raw MQTT payload and the sensors the parser found but doesn't map */
export function DiagnosticsCard() {
  const [text, setText] = useState('Đang tải raw telemetry...');
  const [rawOpen, setRawOpen] = useState(false);
  const [refreshing, refresh] = useBusy();

  const load = useCallback(async () => {
    try {
      const data = await fetchDiagnostics();
      setText(JSON.stringify({ rawPayload: data.rawPayload, discoveredCandidates: data.temperatureCandidates }, null, 2));
    } catch (err) {
      console.warn('Diagnostics fetch failed:', err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card
      title={
        <>
          <InfoCircleOutlined /> Protocol Diagnostics &amp; Raw Data Explorer
        </>
      }
      extra={
        <Space size={0} wrap>
          <Button size="small" type="link" href="/api/printer/diagnostics" target="_blank">
            GET /api/printer/diagnostics
          </Button>
          <Button size="small" type="link" href="/api/printer/raw" target="_blank">
            GET /api/printer/raw
          </Button>
        </Space>
      }
    >
      <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 12 }}>
        <Typography.Text strong>🌐 Raw Data Explorer (Unmapped Raw Payload &amp; Extensions)</Typography.Text>
        <Space wrap>
          <Button type="primary" ghost icon={<SearchOutlined />} onClick={() => setRawOpen(true)}>
            Xem Full Raw Data (Toàn Màn Hình)
          </Button>
          <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => refresh(load)}>
            Làm mới
          </Button>
        </Space>
      </Flex>
      <pre className="raw-json">{text}</pre>
      <RawDataModal open={rawOpen} onClose={() => setRawOpen(false)} />
    </Card>
  );
}
