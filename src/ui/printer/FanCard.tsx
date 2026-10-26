'use client';

import { ApiOutlined } from '@ant-design/icons';
import { Button, Card, Flex, Progress, Slider, Typography } from 'antd';
import { useState } from 'react';
import { useCommand, useLive } from '../DashboardContext';

function FanControl({ name, fan, speed }: { name: string; fan: string; speed: number }) {
  // The slider follows the printer until it is moved
  const [value, setValue] = useState<number | null>(null);
  const [pending, send] = useCommand();
  const shown = value ?? speed;

  return (
    <div>
      <Flex justify="space-between">
        <Typography.Text strong>{name}</Typography.Text>
        <Typography.Text>{speed}%</Typography.Text>
      </Flex>
      <Progress percent={speed} showInfo={false} strokeColor={{ '0%': '#06b6d4', '100%': '#3b82f6' }} />
      <Flex gap={12} align="center">
        <Slider min={0} max={100} value={shown} onChange={setValue} style={{ flex: 1 }} tooltip={{ formatter: (v) => `${v}%` }} />
        <Button
          size="small"
          type="primary"
          ghost
          loading={pending === 'save'}
          onClick={() => send('save', `/api/printer/fans/${fan}`, { speed: shown }).then(() => setValue(null))}
        >
          Lưu
        </Button>
      </Flex>
    </div>
  );
}

/** Part, aux and chamber fans */
export function FanCard() {
  const { printer } = useLive();
  const fan = printer?.fan as (Record<string, number | null> & { part?: number; aux?: number; chamber?: number }) | undefined;

  return (
    <Card
      title={
        <>
          <ApiOutlined /> Điều Chỉnh Quạt (Fans)
        </>
      }
      style={{ height: '100%' }}
    >
      <Flex vertical gap={16}>
        <FanControl name="Quạt Mẫu (Part Fan)" fan="part" speed={fan?.cooling ?? fan?.part ?? 0} />
        <FanControl name="Quạt Phụ (Aux Fan)" fan="aux" speed={fan?.bigFan1 ?? fan?.aux ?? 0} />
        <FanControl name="Quạt Buồng (Chamber Fan)" fan="chamber" speed={fan?.bigFan2 ?? fan?.chamber ?? 0} />
      </Flex>
    </Card>
  );
}
