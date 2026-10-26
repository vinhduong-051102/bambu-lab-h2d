'use client';

import { InboxOutlined, RedoOutlined, SettingOutlined, UploadOutlined } from '@ant-design/icons';
import { Badge, Button, Card, ColorPicker, Empty, Flex, Form, InputNumber, Modal, Select, Space, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { AMSTray, AMSUnit } from '../../domain/PrinterState';
import { BambuColourCatalogue } from '../../domain/filaments/bambuColors';
import { useActions, useCommand, useLive } from '../DashboardContext';

export function amsTrayLabel(amsId: number, slotId: number): string {
  return amsId >= 128 ? `AMS HT ${amsId - 127}` : `AMS ${amsId + 1} • Khay ${slotId + 1}`;
}

const unitLabel = (amsId: number) => (amsId >= 128 ? `AMS HT ${amsId - 127}` : `AMS ${amsId + 1}`);

// H2D: extruder 0 is the right nozzle, 1 the left one
function extruderLabel(extruderId: number | null | undefined): string {
  if (extruderId === 0) return 'Đầu phải';
  if (extruderId === 1) return 'Đầu trái';
  return 'Đầu in';
}

function hexColour(color: string | null | undefined): string {
  if (!color) return '#374151';
  const c = String(color).trim();
  return c.startsWith('#') ? c : `#${c}`;
}

const MATERIALS = [
  { value: 'PLA', label: 'PLA (Bambu PLA Basic)' },
  { value: 'PLA-CF', label: 'PLA-CF (PLA Carbon Fiber)' },
  { value: 'PETG', label: 'PETG (Bambu PETG Basic)' },
  { value: 'ABS', label: 'ABS (Bambu ABS)' },
  { value: 'ASA', label: 'ASA (Bambu ASA)' },
  { value: 'TPU', label: 'TPU (Bambu TPU 95A)' },
  { value: 'PC', label: 'PC (Polycarbonate)' },
  { value: 'PVA', label: 'PVA (Support for PLA)' },
];

function Tray(props: { amsId: number; tray: AMSTray; index: number; catalogue: BambuColourCatalogue | null; loading: boolean; onClick: () => void }) {
  const { amsId, tray, index, catalogue, loading, onClick } = props;
  const slotId = Number(tray.id ?? index);
  const colour = hexColour(tray.color || tray.rawColor);
  const remain = tray.remain ?? (tray as { remainingPercentage?: number }).remainingPercentage;
  const official = tray.isEmpty ? null : catalogue?.identify(tray.infoIdx, colour);
  const status = tray.isEmpty ? 'Trống' : tray.isActive ? `Đã nạp • ${extruderLabel(tray.loadedExtruderId)}` : 'Sẵn sàng';

  const body = (
    <Card
      size="small"
      hoverable={!tray.isEmpty}
      onClick={onClick}
      title={null}
      style={{
        opacity: tray.isEmpty ? 0.55 : 1,
        cursor: tray.isEmpty ? 'not-allowed' : 'pointer',
        borderColor: tray.isActive ? '#10b981' : undefined,
        textAlign: 'center',
        height: '100%',
      }}
      styles={{ body: { padding: 10 } }}
    >
      <Spin spinning={loading}>
        <Typography.Text strong style={{ color: '#3b82f6', fontSize: 12 }}>
          {amsTrayLabel(amsId, slotId)}
        </Typography.Text>
        <div
          title={`Màu: ${colour}`}
          style={{
            width: 34,
            height: 34,
            borderRadius: '50%',
            margin: '6px auto',
            background: tray.isEmpty ? '#374151' : colour,
            border: '2px solid rgba(255,255,255,0.15)',
          }}
        />
        <div>
          <Typography.Text strong>{tray.isEmpty ? 'Trống' : tray.type || 'N/A'}</Typography.Text>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {tray.isEmpty ? ' ' : tray.subBrand || tray.subBrands || 'Generic'}
        </Typography.Text>
        {official && (
          <div title={`Màu Bambu chính hãng, mã cuộn ${official.code}`} style={{ fontSize: 12 }}>
            {official.name} · {official.code}
          </div>
        )}
        <div style={{ fontSize: 12, color: '#34d399' }}>Remain: {remain !== null && remain !== undefined && Number(remain) >= 0 ? `${remain}%` : '--'}</div>
        <Typography.Text strong style={{ fontSize: 11, color: tray.isActive ? '#34d399' : '#94a3b8' }}>
          {status}
        </Typography.Text>
      </Spin>
    </Card>
  );
  // The ribbon only marks a load in progress; a finished load shows in the status line instead
  return tray.isTarget && !tray.isActive ? (
    <Badge.Ribbon text="ĐANG NẠP…" color="orange">
      {body}
    </Badge.Ribbon>
  ) : (
    body
  );
}

interface SettingValues {
  tray: string;
  type: string;
  color: string;
  minTemp: number;
  maxTemp: number;
}

function AmsSettingModal({ open, units, onClose }: { open: boolean; units: AMSUnit[]; onClose: () => void }) {
  const { sendCommand } = useActions();
  const [form] = Form.useForm<SettingValues>();
  // Every tray the printer reports (value "amsId:slotId"), not just the first unit
  const trays = units.length
    ? units.flatMap((unit) =>
        (unit.trays ?? []).map((tray) => ({
          value: `${Number(unit.id)}:${Number(tray.id)}`,
          label: `${amsTrayLabel(Number(unit.id), Number(tray.id))} (${tray.isEmpty ? 'Trống' : tray.type || '?'})`,
        }))
      )
    : [0, 1, 2, 3].map((slot) => ({ value: `0:${slot}`, label: amsTrayLabel(0, slot) }));

  const save = ({ tray, type, color, minTemp, maxTemp }: SettingValues) => {
    const [amsId, slotId] = tray.split(':').map(Number);
    sendCommand('/api/ams/setting', { amsId, slotId, color, type, minTemp, maxTemp });
    onClose();
  };

  return (
    <Modal
      open={open}
      title="⚙️ Cài Đặt Khay Nhựa AMS & Loại Nhựa"
      okText="Lưu Cài Đặt Khay"
      onOk={() => form.submit()}
      onCancel={onClose}
      width={500}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={save}
        initialValues={{ tray: '0:0', type: 'PLA', color: '#3B82F6', minTemp: 190, maxTemp: 240 }}
      >
        <Form.Item name="tray" label="Chọn Khay AMS">
          <Select options={trays} />
        </Form.Item>
        <Form.Item name="type" label="Loại Nhựa (Filament Material)">
          <Select options={MATERIALS} />
        </Form.Item>
        <Form.Item name="color" label="Màu Sắc Nhựa" getValueFromEvent={(colour) => colour.toHexString().toUpperCase()}>
          <ColorPicker showText disabledAlpha format="hex" />
        </Form.Item>
        <Space size="large">
          <Form.Item name="minTemp" label="Nhiệt độ tối thiểu (°C)">
            <InputNumber min={0} max={350} />
          </Form.Item>
          <Form.Item name="maxTemp" label="Nhiệt độ tối đa (°C)">
            <InputNumber min={0} max={350} />
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}

/** The AMS units and their trays: click a tray to load it; unload, retry and the tray setting */
export function AmsCard() {
  const { printer } = useLive();
  const { confirm, showToast, addLog } = useActions();
  const [pending, send] = useCommand();
  const [catalogue, setCatalogue] = useState<BambuColourCatalogue | null>(null);
  const [settingOpen, setSettingOpen] = useState(false);
  const units = printer?.ams ?? [];

  // Bambu's colour catalogue names a tray's colour when it is one of Bambu's own
  useEffect(() => {
    let cancelled = false;
    fetch('/api/filaments/colors')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.colours) setCatalogue(new BambuColourCatalogue(data.colours));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const load = async (amsId: number, slotId: number, tray: AMSTray) => {
    const label = amsTrayLabel(amsId, slotId);
    if (tray.isEmpty) return showToast(`${label} đang trống, không thể nạp nhựa.`, 'warn');
    if (tray.isActive) return showToast(`${label} đã được nạp vào đầu in.`, 'info');
    if (pending) return showToast('⚠️ Đang thực thi lệnh nạp nhựa, vui lòng chờ...', 'warn');
    if (!(await confirm({ title: '🧵 Nạp nhựa', message: `Nạp nhựa từ ${label} vào đầu in?`, confirmText: 'Nạp nhựa' }))) return;
    addLog(`[LỆNH NẠP NHỰA] ⏩ Gửi yêu cầu nạp nhựa từ ${label} (amsId: ${amsId}, slotId: ${slotId})...`);
    showToast(`Đang gửi lệnh nạp ${label}...`);
    // Temperature is picked by the gateway from the tray's recommended range
    send(`tray:${amsId}:${slotId}`, '/api/ams/load', { amsId, slotId });
  };

  const unload = async () => {
    if (await confirm({ title: '⏏️ Rút nhựa', message: 'Rút nhựa hiện tại khỏi đầu in về bộ AMS?', confirmText: 'Rút nhựa' })) {
      send('unload', '/api/ams/unload', {});
    }
  };

  return (
    <Card
      title={
        <>
          <InboxOutlined /> Hệ Thống Khay Nhựa AMS
        </>
      }
      extra={
        <Space wrap size={4}>
          <Button size="small" icon={<UploadOutlined />} loading={pending === 'unload'} onClick={unload} title="Rút nhựa hiện tại về AMS">
            Rút Nhựa
          </Button>
          <Button
            size="small"
            icon={<RedoOutlined />}
            loading={pending === 'retry'}
            onClick={() => send('retry', '/api/ams/retry', {})}
            title="Thử lại thao tác đùn/kéo nhựa"
          >
            Retry
          </Button>
          <Button size="small" type="primary" icon={<SettingOutlined />} onClick={() => setSettingOpen(true)} title="Đổi màu & loại nhựa khay AMS">
            Đổi Màu/Loại Nhựa
          </Button>
        </Space>
      }
    >
      {units.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có dữ liệu khay nhựa AMS" />
      ) : (
        <Flex vertical gap={12}>
          {units.map((unit) => {
            const amsId = Number(unit.id);
            const humidity = unit.humidityRaw ?? unit.humidity;
            return (
              <Card
                key={unit.id}
                type="inner"
                size="small"
                title={<span style={{ color: '#38bdf8' }}>{unitLabel(amsId)}</span>}
                extra={
                  <Typography.Text type="secondary" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    Temp: <b style={{ color: '#4ade80' }}>{unit.temperature !== null && unit.temperature !== undefined ? `${unit.temperature}°C` : '--'}</b> |
                    Humidity: <b style={{ color: '#60a5fa' }}>{humidity !== null && humidity !== undefined ? `${humidity}%` : '--'}</b>
                  </Typography.Text>
                }
              >
                <div className="ams-tray-grid">
                  {(unit.trays ?? []).map((tray, index) => {
                    const slotId = Number(tray.id ?? index);
                    return (
                      <Tray
                        key={tray.id ?? index}
                        amsId={amsId}
                        tray={tray}
                        index={index}
                        catalogue={catalogue}
                        loading={pending === `tray:${amsId}:${slotId}`}
                        onClick={() => load(amsId, slotId, tray)}
                      />
                    );
                  })}
                </div>
              </Card>
            );
          })}
        </Flex>
      )}
      <AmsSettingModal open={settingOpen} units={units} onClose={() => setSettingOpen(false)} />
    </Card>
  );
}
