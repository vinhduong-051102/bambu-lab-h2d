'use client';

import { BlockOutlined } from '@ant-design/icons';
import { Card, Col, Flex, Progress, Row, Statistic, Tag, Typography } from 'antd';
import { useLive } from '../DashboardContext';
import { STATE_COLORS } from '../theme';

/** 95 → "1h 35m", missing → "--:--" */
export function formatMinutes(mins: number | null | undefined): string {
  if (mins === null || mins === undefined || Number.isNaN(mins)) return '--:--';
  const h = Math.floor(mins / 60);
  return `${h > 0 ? `${h}h ` : ''}${mins % 60}m`;
}

/** The job being printed: state, progress, layers and time left */
export function JobCard() {
  const { printer } = useLive();
  const state = String(printer?.state ?? 'UNKNOWN').toUpperCase();
  const progress = Math.max(0, Math.min(100, printer?.progress ?? 0));
  const job = printer?.job;

  return (
    <Card
      title={
        <>
          <BlockOutlined /> Trạng Thái In Real-Time
        </>
      }
      extra={<Tag color={STATE_COLORS[state] ?? 'default'}>{state}</Tag>}
      style={{ height: '100%' }}
    >
      <Flex gap={28} wrap align="center">
        <Progress
          type="circle"
          percent={Math.round(progress)}
          size={160}
          strokeColor={{ '0%': '#3b82f6', '100%': '#10b981' }}
          format={(percent) => (
            <Flex vertical align="center">
              <span>{percent}%</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Tiến Độ
              </Typography.Text>
            </Flex>
          )}
        />
        <Flex vertical gap={16} flex={1} style={{ minWidth: 200 }}>
          <div>
            <Typography.Text type="secondary">File Đang In</Typography.Text>
            <Typography.Title level={5} style={{ margin: 0 }} ellipsis={{ tooltip: true }}>
              {job ? job.name || 'Không có tên tác vụ' : 'Chưa có tác vụ'}
            </Typography.Title>
          </div>
          <Row gutter={12}>
            <Col span={12}>
              <Statistic title="Lớp in (Layer)" value={`${job?.currentLayer ?? 0} / ${job?.totalLayers ?? 0}`} />
            </Col>
            <Col span={12}>
              <Statistic title="Thời gian còn lại" value={formatMinutes(job?.remainingTimeMinutes)} />
            </Col>
          </Row>
        </Flex>
      </Flex>
    </Card>
  );
}
