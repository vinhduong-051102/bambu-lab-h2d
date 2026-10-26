'use client';

import { ApiOutlined, AppstoreOutlined, CaretRightOutlined, EyeOutlined, PauseOutlined, StopOutlined } from '@ant-design/icons';
import { Badge, Button, Card, Col, Flex, Layout, Row, Space, Switch, Tabs, Tag, Typography } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { useActions, useCommand, useLive, type WsStatus } from './DashboardContext';
import { LegacyCadCard, LegacyPrintsCard } from './legacy/LegacyCards';
import { pageFromHash } from './pages';
import { AmsCard } from './printer/AmsCard';
import { CameraCard } from './printer/CameraCard';
import { FanCard } from './printer/FanCard';
import { JobCard } from './printer/JobCard';
import { TemperatureCard } from './printer/TemperatureCard';
import { StudioCard } from './studio/StudioCard';
import { ConsoleCard } from './system/ConsoleCard';
import { DiagnosticsCard } from './system/DiagnosticsCard';
import { ApiModal, CapabilitiesModal } from './system/InfoModals';

const WS_BADGE: Record<WsStatus, { status: 'success' | 'error' | 'processing'; text: string }> = {
  connecting: { status: 'processing', text: 'WS Connecting...' },
  online: { status: 'success', text: 'WS Live Data' },
  offline: { status: 'error', text: 'WS Disconnected' },
};

/** Which optional pages the gateway has set up: Studio (STUDIO_URL) and AI modelling (CAD_WORKER_URL / mesh3d) */
function useFeatures() {
  const [features, setFeatures] = useState({ studio: false, cad: false });
  useEffect(() => {
    let cancelled = false;
    const enabled = (url: string) =>
      fetch(url)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => Boolean(data?.enabled))
        .catch(() => false);
    Promise.all([enabled('/api/studio'), enabled('/api/cad')]).then(([studio, cad]) => {
      if (!cancelled) setFeatures({ studio, cad });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return features;
}

/** The page in the URL hash (#studio), so the back button and a bookmark land on it */
function usePage(available: string[]) {
  const [hash, setHash] = useState('');
  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const page = pageFromHash(hash, available);
  const go = (next: string) => {
    window.location.hash = next;
  };
  return [page, go] as const;
}

function Header({ onApi, onCapabilities }: { onApi: () => void; onCapabilities: () => void }) {
  const { printer, wsStatus } = useLive();
  const { compact, setCompact, showToast } = useActions();
  const toggleCompact = (on: boolean) => {
    setCompact(on);
    showToast(on ? 'Đã bật Chế Độ Giao Diện Đơn Giản (Đã ẩn log & hướng dẫn)' : 'Đã chuyển về Chế Độ Giao Diện Đầy Đủ', 'info');
  };

  return (
    <Card styles={{ body: { padding: '14px 20px' } }}>
      <Flex justify="space-between" align="center" wrap gap={16}>
        <Flex align="center" gap={14}>
          <div className="logo-mark">
            <AppstoreOutlined />
          </div>
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              Bambu Lab H2D <span style={{ color: '#3b82f6' }}>Gateway</span>
            </Typography.Title>
            {!compact && (
              <Space size={4} wrap>
                <Tag>Serial: {printer?.serial || 'Offline'}</Tag>
                {printer?.realPrinterMode ? <Tag color="success">Live Printer Mode</Tag> : <Tag color="warning">Safety Mode (Read-Only)</Tag>}
              </Space>
            )}
          </div>
        </Flex>
        <Flex align="center" gap={12} wrap>
          <Space size={6} title="Giao Diện Đơn Giản: ẩn log & hướng dẫn">
            <EyeOutlined />
            <Switch size="small" checked={compact} onChange={toggleCompact} />
            <Typography.Text type="secondary">Đơn giản</Typography.Text>
          </Space>
          {!compact && (
            <>
              <Button icon={<ApiOutlined />} onClick={onApi}>
                API
              </Button>
              <Button onClick={onCapabilities}>Capabilities</Button>
            </>
          )}
          <Badge status={printer?.online ? 'success' : 'error'} text={printer?.online ? 'Máy in Online' : 'Máy in Offline'} />
          {!compact && <Badge status={WS_BADGE[wsStatus].status} text={WS_BADGE[wsStatus].text} />}
        </Flex>
      </Flex>
    </Card>
  );
}

function ControlBar() {
  const { confirm } = useActions();
  const [pending, send] = useCommand();
  const stop = async () => {
    const ok = await confirm({
      title: 'Hủy lệnh in',
      message: 'Bạn có chắc chắn muốn HỦY tác vụ in hiện tại? Không thể tiếp tục bản in sau khi hủy.',
      confirmText: 'Hủy lệnh in',
      cancelText: 'Quay lại',
      danger: true,
    });
    if (ok) send('stop', '/api/printer/actions/stop');
  };

  return (
    <Card size="small">
      <Flex justify="space-between" align="center" wrap gap={12}>
        <Typography.Text strong>
          <CaretRightOutlined /> Điều Khiển Máy In
        </Typography.Text>
        <Space wrap>
          <Button icon={<PauseOutlined />} loading={pending === 'pause'} onClick={() => send('pause', '/api/printer/actions/pause')} title="Tạm dừng in (Pause)">
            Tạm Dừng
          </Button>
          <Button
            type="primary"
            icon={<CaretRightOutlined />}
            loading={pending === 'resume'}
            onClick={() => send('resume', '/api/printer/actions/resume')}
            title="Tiếp tục in (Resume)"
          >
            Tiếp Tục
          </Button>
          <Button danger icon={<StopOutlined />} loading={pending === 'stop'} onClick={stop} title="Hủy tác vụ in (Stop)">
            Hủy In
          </Button>
        </Space>
      </Flex>
    </Card>
  );
}

const grid = (...cards: [ReactNode, object][]) => (
  <Row gutter={[16, 16]}>
    {cards.map(([card, span], i) => (
      <Col key={i} xs={24} {...span}>
        {card}
      </Col>
    ))}
  </Row>
);

export function Shell() {
  const { printer } = useLive();
  const { compact } = useActions();
  const features = useFeatures();
  const available = ['printer', ...(features.studio ? ['studio'] : []), ...(features.cad ? ['cad'] : []), 'prints', 'system'];
  const [page, go] = usePage(available);
  const [apiOpen, setApiOpen] = useState(false);
  const [capOpen, setCapOpen] = useState(false);

  const pages = [
    {
      key: 'printer',
      label: '🖨️ Máy in',
      children: grid(
        [<JobCard key="job" />, { lg: 10 }],
        [<TemperatureCard key="temp" />, { lg: 14 }],
        [<CameraCard key="camera" active={page === 'printer'} />, { xl: 15 }],
        [<FanCard key="fan" />, { xl: 9 }],
        [<AmsCard key="ams" />, {}]
      ),
    },
    features.studio && { key: 'studio', label: '🧩 Bambu Studio', children: <StudioCard /> },
    features.cad && {
      key: 'cad',
      label: (
        <>
          ✨ Thiết kế AI
          <span className="page-tab-dot" id="cadTabDot" hidden />
        </>
      ),
      forceRender: true,
      children: <LegacyCadCard />,
    },
    { key: 'prints', label: '🕘 Lịch sử in', forceRender: true, children: <LegacyPrintsCard /> },
    { key: 'system', label: '🛠️ Hệ thống', children: grid([<ConsoleCard key="console" />, {}], [<DiagnosticsCard key="diag" />, {}]) },
  ].filter((p) => p !== false);

  return (
    <Layout className="dashboard">
      <Flex vertical gap={16}>
        <Header onApi={() => setApiOpen(true)} onCapabilities={() => setCapOpen(true)} />
        <ControlBar />
        <Tabs activeKey={page} onChange={go} items={pages} size="large" />
      </Flex>
      {!compact && (
        <Layout.Footer>
          <Flex justify="space-between" wrap gap={8}>
            <Typography.Text type="secondary">Bambu Lab H2D Gateway • Enterprise Local Bridge</Typography.Text>
            <Typography.Text type="secondary">
              Cập nhật lần cuối: {printer?.updatedAt ? new Date(printer.updatedAt).toLocaleTimeString() : 'Chưa có dữ liệu'}
            </Typography.Text>
          </Flex>
        </Layout.Footer>
      )}
      <ApiModal open={apiOpen} onClose={() => setApiOpen(false)} />
      <CapabilitiesModal open={capOpen} onClose={() => setCapOpen(false)} />
    </Layout>
  );
}
