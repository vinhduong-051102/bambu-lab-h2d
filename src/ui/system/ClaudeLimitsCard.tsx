'use client';

import { ReloadOutlined, RobotOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Flex, Progress, Row, Space, Tag, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { activePlan, barColor, formatReset, percent, planState } from '../aiLimits';

/**
 * The Claude subscriptions the project runs on (CLAUDE_CODE_OAUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN_FALLBACK): how
 * much of each one's 5-hour and 7-day allowance is used and when it starts over. The gateway checks them with a tiny
 * model call and keeps the answer 5 minutes; "Kiểm tra lại" asks again.
 */

type Window = { utilization: number | null; resetsAt: string | null; status: string | null };
type Plan = {
  key: string;
  label: string;
  configured: boolean;
  organization: string | null;
  status: string | null;
  fiveHour: Window;
  sevenDay: Window;
  limitedBy: string | null;
  overage: string | null;
  checkedAt: string;
  error: string | null;
};

function Usage({ title, window, now }: { title: string; window: Window; now: number }) {
  const used = percent(window.utilization);
  return (
    <Flex vertical gap={2}>
      <Flex justify="space-between">
        <Typography.Text>{title}</Typography.Text>
        <Typography.Text type="secondary">{used === null ? 'chưa rõ' : `đã dùng ${used} %`}</Typography.Text>
      </Flex>
      <Progress percent={used ?? 0} showInfo={false} strokeColor={barColor(window.utilization ?? 0)} size="small" />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Làm mới {formatReset(window.resetsAt, now)}
      </Typography.Text>
    </Flex>
  );
}

export function ClaudeLimitsCard() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ai/limits${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok || !body?.success) throw new Error(body?.message || `HTTP ${res.status}`);
      setPlans(body.plans);
      setCachedAt(body.cachedAt);
      setNow(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    // The countdowns move on by themselves; the numbers only when asked (each check uses a sliver of the plan)
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, [load]);

  const active = activePlan(plans);

  return (
    <Card
      title={
        <Space>
          <RobotOutlined /> Gói Claude của dự án
        </Space>
      }
      extra={
        <Tooltip title="Mỗi lần kiểm tra là một lời gọi Claude rất nhỏ, tốn chút xíu hạn mức">
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => load(true)}>
            Kiểm tra lại
          </Button>
        </Tooltip>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        Thiết kế AI, nhận xét timelapse và “AI tối ưu” trong Studio chạy bằng gói 1; khi gói 1 hết lượt, chúng tự chuyển
        sang gói 2. Mỗi gói có hai giới hạn: lượng dùng trong 5 giờ và trong 7 ngày.
        {cachedAt ? ` Số liệu lúc ${new Date(cachedAt).toLocaleTimeString('vi-VN')}.` : ''}
      </Typography.Paragraph>
      {error && <Alert type="error" showIcon title={`Không đọc được hạn mức: ${error}`} />}
      <Row gutter={[16, 16]}>
        {(plans ?? []).map((plan) => {
          const state = planState(plan);
          return (
            <Col key={plan.key} xs={24} md={12}>
              <Card size="small" className={plan.key === active ? 'limits-active' : undefined}>
                <Flex vertical gap={10}>
                  <Flex justify="space-between" align="center" wrap gap={6}>
                    <Space>
                      <Typography.Text strong>{plan.label}</Typography.Text>
                      {plan.key === active && <Tag color="blue">đang dùng</Tag>}
                    </Space>
                    <Tag color={state.color}>{state.text}</Tag>
                  </Flex>
                  {!plan.configured ? (
                    <Typography.Text type="secondary">
                      Chưa cài: đặt {plan.key === 'primary' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'CLAUDE_CODE_OAUTH_TOKEN_FALLBACK'} trong .env (tạo bằng
                      claude setup-token) rồi khởi động lại gateway.
                    </Typography.Text>
                  ) : plan.error ? (
                    <Alert type="error" showIcon title={plan.error} />
                  ) : (
                    <>
                      <Usage title="Trong 5 giờ" window={plan.fiveHour} now={now} />
                      <Usage title="Trong 7 ngày" window={plan.sevenDay} now={now} />
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {plan.organization ? `Tổ chức ${plan.organization}` : ''}
                        {plan.limitedBy ? ` · mức gần chạm nhất: ${plan.limitedBy === 'seven_day' ? '7 ngày' : '5 giờ'}` : ''}
                        {plan.overage === 'rejected' ? ' · không dùng vượt hạn mức' : plan.overage === 'allowed' ? ' · cho dùng vượt (tính thêm phí)' : ''}
                      </Typography.Text>
                    </>
                  )}
                </Flex>
              </Card>
            </Col>
          );
        })}
      </Row>
    </Card>
  );
}
