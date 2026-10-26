'use client';

import { FireOutlined } from '@ant-design/icons';
import { Button, Card, Divider, Flex, InputNumber, Progress, Space, Typography } from 'antd';
import { useState } from 'react';
import { useCommand, useLive } from '../DashboardContext';

interface Preset {
  label: string;
  value: number;
}

const NOZZLE_PRESETS: Preset[] = [
  { label: 'PLA 200', value: 200 },
  { label: 'PETG 240', value: 240 },
  { label: 'ABS 250', value: 250 },
];
const BED_PRESETS: Preset[] = [
  { label: 'PLA 60', value: 60 },
  { label: 'PETG 80', value: 80 },
  { label: 'ABS 100', value: 100 },
];

const shown = (value: number | null | undefined) => (value === null || value === undefined ? '--' : value);

function TemperatureControl(props: {
  title: string;
  current: number | null | undefined;
  target: number | null | undefined;
  max: number;
  url: string;
  presets: Preset[];
  placeholder: number;
  color: { '0%': string; '100%': string };
}) {
  const { title, current, target, max, url, presets, placeholder, color } = props;
  const [value, setValue] = useState<number | null>(null);
  const [pending, send] = useCommand();
  const set = (key: string, target: number) => send(key, url, { target });

  return (
    <div>
      <Flex justify="space-between" align="baseline">
        <Typography.Text strong>{title}</Typography.Text>
        <span>
          <Typography.Text strong style={{ fontSize: 20 }}>
            {shown(current)}
          </Typography.Text>
          <Typography.Text type="secondary"> °C / {shown(target)}°C</Typography.Text>
        </span>
      </Flex>
      <Progress percent={Math.min(100, Math.max(0, ((Number(current) || 0) / max) * 100))} showInfo={false} strokeColor={color} />
      <Flex gap={8} wrap>
        <Space.Compact>
          <InputNumber min={0} max={max} placeholder={String(placeholder)} value={value} onChange={setValue} style={{ width: 90 }} />
          <Button loading={pending === 'set'} disabled={value === null} onClick={() => value !== null && set('set', value)}>
            Đặt Nhiệt
          </Button>
        </Space.Compact>
        {presets.map((p) => (
          <Button key={p.label} size="small" loading={pending === p.label} onClick={() => set(p.label, p.value)}>
            {p.label}
          </Button>
        ))}
        <Button size="small" danger loading={pending === 'off'} onClick={() => set('off', 0)}>
          Tắt
        </Button>
      </Flex>
    </div>
  );
}

const HOTEND = { '0%': '#f59e0b', '100%': '#ef4444' };
const BED = { '0%': '#3b82f6', '100%': '#8b5cf6' };

/** Nozzles (H2D has two), bed and chamber: readings, targets and setting them */
export function TemperatureCard() {
  const { printer } = useLive();
  const temps = printer?.temperatures;
  const n1 = temps?.nozzles?.[0] ?? temps?.nozzle;
  const n2 = temps?.nozzles?.[1];
  const chamber = temps?.chamber;

  return (
    <Card
      title={
        <>
          <FireOutlined /> Điều Chỉnh Nhiệt Độ
        </>
      }
      style={{ height: '100%' }}
    >
      <Flex vertical gap={4}>
        <TemperatureControl
          title="🔥 Đầu Phun #1 (Hotend 1 - T0)"
          current={n1?.current}
          target={n1?.target}
          max={300}
          url="/api/printer/temperature/nozzle"
          presets={NOZZLE_PRESETS}
          placeholder={220}
          color={HOTEND}
        />
        <Divider style={{ margin: '12px 0' }} />
        <TemperatureControl
          title="🔥 Đầu Phun #2 (Hotend 2 - T1)"
          current={n2?.current}
          target={n2?.target}
          max={300}
          url="/api/printer/temperature/nozzle2"
          presets={NOZZLE_PRESETS}
          placeholder={220}
          color={HOTEND}
        />
        <Divider style={{ margin: '12px 0' }} />
        <TemperatureControl
          title="♨️ Bàn In (Heatbed)"
          current={temps?.bed?.current}
          target={temps?.bed?.target}
          max={120}
          url="/api/printer/temperature/bed"
          presets={BED_PRESETS}
          placeholder={60}
          color={BED}
        />
        <Divider style={{ margin: '12px 0' }} />
        <Flex justify="space-between" align="baseline">
          <Typography.Text strong>🌡️ Buồng In (Chamber)</Typography.Text>
          <span>
            <Typography.Text strong style={{ fontSize: 20 }}>
              {shown(chamber?.current)}
            </Typography.Text>
            <Typography.Text type="secondary"> °C</Typography.Text>
          </span>
        </Flex>
      </Flex>
    </Card>
  );
}
