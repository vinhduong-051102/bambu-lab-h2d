'use client';

import { BarChartOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Flex, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { formatPlanUse, formatShare, formatTokens, formatUsd, USAGE_PERIODS } from '../aiUsage';
import { AiUsageCharts } from './AiUsageCharts';

/**
 * What each AI task cost (GET /api/ai/usage): tokens, the price Claude Code puts on them at API list prices, its
 * share of the period, and the rise in the Claude plan's 5-hour and 7-day use while it ran; totals per feature.
 */

type Tokens = { input: number; output: number; cache_read: number; cache_write: number; thinking: number };
type PlanUse = { from: number; to: number; used: number; resets_at: string | null };
type Task = {
  id: string;
  feature: string;
  title: string;
  at: string;
  models: string[];
  tokens: Tokens;
  total_tokens: number;
  cost_usd: number | null;
  cost_share: number | null;
  token_share: number;
  turns: number | null;
  duration_ms: number | null;
  ok: boolean;
  plan: { five_hour?: PlanUse; seven_day?: PlanUse } | null;
};
type Feature = { feature: string; label: string; runs: number; total_tokens: number; cost_usd: number; cost_share: number | null; token_share: number };
type Summary = {
  totals: { runs: number; tokens: Tokens; total_tokens: number; cost_usd: number; plan_five_hour: number; plan_seven_day: number };
  features: Feature[];
  tasks: Task[];
};

const TokenDetail = ({ t }: { t: Tokens }) => (
  <div>
    Vào: {formatTokens(t.input)} · Ra: {formatTokens(t.output)} (suy nghĩ {formatTokens(t.thinking)})
    <br />
    Đọc cache: {formatTokens(t.cache_read)} · Ghi cache: {formatTokens(t.cache_write)}
  </div>
);

const modelName = (m: string) => m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');

export function AiUsageCard() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Summary | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ai/usage?days=${days}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok || !body?.success) throw new Error(body?.message || `HTTP ${res.status}`);
      setData(body);
      setLabels(Object.fromEntries((body.features as Feature[]).map((f) => [f.feature, f.label])));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = data?.totals;
  return (
    <Card
      title={
        <Space>
          <BarChartOutlined /> Chi phí AI theo task
        </Space>
      }
      extra={
        <Space wrap>
          <Segmented size="small" value={days} options={USAGE_PERIODS} onChange={(v) => setDays(Number(v))} />
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load} />
        </Space>
      }
    >
      {error && <Alert type="error" showIcon title={`Không đọc được thống kê: ${error}`} />}
      {totals && (
        <Flex vertical gap={12}>
          <Typography.Text>
            <b>{totals.runs}</b> task · <Tooltip title={<TokenDetail t={totals.tokens} />}><b>{formatTokens(totals.total_tokens)}</b> token</Tooltip> ·{' '}
            <b>{formatUsd(totals.cost_usd)}</b> theo giá API · hạn mức gói dùng cộng dồn: <b>{Math.round(totals.plan_five_hour * 100)} %</b> (5 giờ),{' '}
            <b>{Math.round(totals.plan_seven_day * 100)} %</b> (7 ngày)
          </Typography.Text>
          <AiUsageCharts tasks={data.tasks} tokens={totals.tokens} days={days} labels={labels} />
          <Table
            size="small"
            pagination={false}
            rowKey="feature"
            dataSource={data.features}
            columns={[
              { title: 'Tính năng', dataIndex: 'label' },
              { title: 'Số lần', dataIndex: 'runs', align: 'right' },
              { title: 'Token', dataIndex: 'total_tokens', align: 'right', render: formatTokens },
              { title: '% token', dataIndex: 'token_share', align: 'right', render: (v) => formatShare(v) },
              { title: 'Chi phí', dataIndex: 'cost_usd', align: 'right', render: formatUsd },
              { title: '% chi phí', dataIndex: 'cost_share', align: 'right', render: (v) => formatShare(v) },
            ]}
          />
          <Table
            size="small"
            rowKey="id"
            dataSource={data.tasks}
            pagination={{ pageSize: 15, hideOnSinglePage: true, size: 'small' }}
            scroll={{ x: 900 }}
            columns={[
              {
                title: 'Lúc',
                dataIndex: 'at',
                width: 110,
                render: (v: string) => new Date(v).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
              },
              {
                title: 'Task',
                dataIndex: 'title',
                render: (v: string, t: Task) => (
                  <Flex vertical gap={0}>
                    <Typography.Text ellipsis={{ tooltip: v }} style={{ maxWidth: 320 }}>
                      {v}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {labels[t.feature] ?? t.feature}
                      {t.models.length ? ` · ${t.models.map(modelName).join(', ')}` : ''}
                      {t.turns ? ` · ${t.turns} lượt` : ''}
                      {t.duration_ms ? ` · ${Math.round(t.duration_ms / 60000) || '<1'} phút` : ''}
                    </Typography.Text>
                  </Flex>
                ),
              },
              {
                title: 'Token',
                dataIndex: 'total_tokens',
                align: 'right',
                width: 90,
                render: (v: number, t: Task) => <Tooltip title={<TokenDetail t={t.tokens} />}>{formatTokens(v)}</Tooltip>,
              },
              { title: '% token', dataIndex: 'token_share', align: 'right', width: 80, render: (v) => formatShare(v) },
              { title: 'Chi phí', dataIndex: 'cost_usd', align: 'right', width: 80, render: formatUsd },
              { title: '% chi phí', dataIndex: 'cost_share', align: 'right', width: 85, render: (v) => formatShare(v) },
              {
                title: <Tooltip title="Hạn mức gói Claude đã dùng tăng bao nhiêu trong lúc task chạy">Hạn mức 5 giờ</Tooltip>,
                align: 'right',
                width: 100,
                render: (_: unknown, t: Task) => formatPlanUse(t.plan?.five_hour),
              },
              { title: '7 ngày', align: 'right', width: 70, render: (_: unknown, t: Task) => formatPlanUse(t.plan?.seven_day) },
              { title: '', dataIndex: 'ok', width: 70, render: (ok: boolean) => (ok ? null : <Tag color="red">lỗi</Tag>) },
            ]}
          />
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
            Chi phí là con số Claude Code tính theo giá API niêm yết: dự án chạy trên gói Claude nên không trả tiền theo
            từng task, cái hết dần là hạn mức của gói. % hạn mức là mức gói đã dùng tăng lên trong lúc task chạy (gói báo
            theo bậc 1 %, nên task nhỏ hiện “&lt;1 %”), có tính cả việc khác dùng chung gói lúc đó. Token gồm cả phần đọc
            từ cache (rẻ hơn nhiều so với token vào thường). Đánh giá timelapse, nhận diện chi tiết và AI tối ưu Studio được
            ghi từ khi có thống kê này.
          </Typography.Paragraph>
        </Flex>
      )}
    </Card>
  );
}
