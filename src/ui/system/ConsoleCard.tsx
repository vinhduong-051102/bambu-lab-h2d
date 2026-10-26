'use client';

import { CodeOutlined } from '@ant-design/icons';
import { Button, Card, Space } from 'antd';
import { useEffect, useRef } from 'react';
import { useLogs } from '../DashboardContext';

const COLORS = { info: '#cbd5e1', success: '#34d399', warn: '#fbbf24', error: '#f87171' };

/** What the dashboard did and heard: commands sent, their results, connection changes */
export function ConsoleCard() {
  const logs = useLogs();
  const body = useRef<HTMLDivElement>(null);

  // Follow new lines
  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [logs]);

  return (
    <Card
      title={
        <>
          <CodeOutlined /> Console Log &amp; Command Audit
        </>
      }
      extra={
        <Space size={0} wrap>
          <Button size="small" type="link" href="/api/commands" target="_blank">
            GET /api/commands
          </Button>
          <Button size="small" type="link" href="/api/capabilities" target="_blank">
            GET /api/capabilities
          </Button>
        </Space>
      }
    >
      <div className="console-log" ref={body}>
        <div style={{ color: COLORS.info }}>[System] Đã kết nối giao diện Dashboard. Đang chờ dữ liệu...</div>
        {logs.map((line) => (
          <div key={line.id} style={{ color: COLORS[line.type] }}>
            [{line.time}] {line.message}
          </div>
        ))}
      </div>
    </Card>
  );
}
