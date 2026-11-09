'use client';

import { ReloadOutlined, RobotOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Flex, Progress, Row, Segmented, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useActions } from '../DashboardContext';
import { activePlan, barColor, formatReset, percent, PLANS_CHANGED, planOptions, planState } from '../aiLimits';

/**
 * The Claude subscriptions the project runs on (one per Claude token on the KeyVault, named after its key): how
 * much of each one's 5-hour and 7-day allowance is used and when it starts over. The gateway checks them with a tiny
 * model call and keeps the answer 5 minutes; "Kiểm tra lại" asks again. Which one tasks run on is picked here
 * (GET/PUT /api/ai/plan): both in turn, or only one, to keep the other's allowance.
 */

type PlanChoice = { plan: string; label: string; configured: boolean };

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
  const { showToast } = useActions();
  const [chosen, setChosen] = useState<PlanChoice['plan']>('auto');
  const [choices, setChoices] = useState<PlanChoice[]>([]);
  const [saving, setSaving] = useState(false);

  const loadChoices = useCallback(() => {
    fetch('/api/ai/plan', { cache: 'no-store' })
      .then((res) => res.json())
      .then((body) => {
        if (body?.success) {
          setChosen(body.plan);
          setChoices(body.plans);
        }
      })
      .catch(() => {});
  }, []);

  const choose = async (plan: PlanChoice['plan']) => {
    setSaving(true);
    try {
      const res = await fetch('/api/ai/plan', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) throw new Error(body?.message || `HTTP ${res.status}`);
      setChosen(body.plan);
      showToast(`Các task từ giờ chạy bằng: ${choices.find((c) => c.plan === plan)?.label ?? plan}`, 'success');
    } catch (err) {
      showToast(`Không đổi được gói: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

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
    loadChoices();
    // Plans fetched or taken back on the KeyVault card: the choices and the limits follow
    const changed = () => {
      loadChoices();
      void load(false);
    };
    window.addEventListener(PLANS_CHANGED, changed);
    void load(false);
    // The countdowns move on by themselves; the numbers only when asked (each check uses a sliver of the plan)
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => {
      clearInterval(timer);
      window.removeEventListener(PLANS_CHANGED, changed);
    };
  }, [load, loadChoices]);

  const active = activePlan(plans, chosen);

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
      {choices.length > 0 && (
        <Flex vertical gap={6} style={{ marginBottom: 12 }}>
          <Typography.Text strong>Chạy task bằng</Typography.Text>
          {choices.length <= 3 ? (
            <Segmented block value={chosen} disabled={saving} options={planOptions(choices, true)} onChange={(v) => choose(v as PlanChoice['plan'])} />
          ) : (
            <Select value={chosen} disabled={saving} options={planOptions(choices)} onChange={(v) => choose(v)} />
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {chosen === 'auto'
              ? 'Tự động: dùng các gói lần lượt theo thứ tự trên KeyVault, gói nào hết lượt thì chuyển sang gói kế.'
              : `Chỉ dùng ${choices.find((c) => c.plan === chosen)?.label.replace(/^Chỉ /, '') ?? 'gói đã chọn'}: hết lượt thì task báo lỗi, các gói còn lại để dành.`}{' '}
            Áp cho Thiết kế AI, mô hình từ ảnh, nhận xét timelapse, nhận diện chi tiết và phân tích lỗi; mẫu AI chọn riêng được khi tạo.
          </Typography.Text>
        </Flex>
      )}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        Mỗi gói có hai giới hạn: lượng dùng trong 5 giờ và trong 7 ngày.
        {cachedAt ? ` Số liệu lúc ${new Date(cachedAt).toLocaleTimeString('vi-VN')}.` : ''}
      </Typography.Paragraph>
      {error && <Alert type="error" showIcon title={`Không đọc được hạn mức: ${error}`} />}
      {plans?.length === 0 && (
        <Alert type="info" showIcon title="Chưa có gói Claude nào: mỗi key token Claude trên KeyVault là một gói; lấy token ở thẻ KeyVault bên dưới bằng mã OTP." />
      )}
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
                  {plan.error ? (
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
