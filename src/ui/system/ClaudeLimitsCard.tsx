'use client';

import { KeyOutlined, ReloadOutlined, RobotOutlined, SettingOutlined } from '@ant-design/icons';
import { Alert, AutoComplete, Button, Card, Col, Flex, Input, Progress, Row, Segmented, Space, Tag, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useActions } from '../DashboardContext';
import { activePlan, barColor, formatReset, percent, planOptions, planState } from '../aiLimits';

/**
 * The Claude subscriptions the project runs on (CLAUDE_CODE_OAUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN_FALLBACK): how
 * much of each one's 5-hour and 7-day allowance is used and when it starts over. The gateway checks them with a tiny
 * model call and keeps the answer 5 minutes; "Kiểm tra lại" asks again. Which one tasks run on is picked here
 * (GET/PUT /api/ai/plan): both in turn, or only one, to keep the other's allowance. With a KeyVault (KV_SERVER), each
 * plan's token is fetched here with a one-time code from Google Authenticator (/api/ai/vault); "KeyVault" sets its
 * address and the key each plan takes (/api/ai/vault/config).
 */

type PlanChoice = { plan: 'auto' | 'primary' | 'fallback'; label: string; configured: boolean };

type Vault = {
  server: string | null;
  ready: boolean;
  problem: string | null;
  plans: { key: string; vaultKey: string | null; fetchedAt: string | null }[];
  config: { server: string; primary: string; fallback: string };
  keys: { id: string; name: string; description: string }[] | null;
  keysError: string | null;
};

/** Where the tokens are fetched from: the KeyVault's address and the key holding each plan's token */
function VaultConfig({ vault, onSaved }: { vault: Vault; onSaved: (vault: Vault) => void }) {
  const [form, setForm] = useState(vault.config);
  const [saving, setSaving] = useState(false);
  const { showToast } = useActions();
  useEffect(() => setForm(vault.config), [vault.config]);
  const options = (vault.keys ?? []).map((k) => ({ value: k.name, label: k.description ? `${k.name} · ${k.description}` : k.name }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/ai/vault/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) throw new Error(body?.message || `HTTP ${res.status}`);
      showToast('Đã lưu cấu hình KeyVault', 'success');
      onSaved(body);
    } catch (err) {
      showToast(`Không lưu được cấu hình KeyVault: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card size="small" title="Cấu hình KeyVault" style={{ marginTop: 16 }}>
      <Flex vertical gap={10}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Token của hai gói lấy từ KeyVault bằng mã OTP Google Authenticator được dùng ngay, thay cho token trong .env. Ô để trống thì dùng giá trị
          trong .env (KV_SERVER, KV_KEY_PRIMARY, KV_KEY_FALLBACK).
        </Typography.Text>
        {vault.problem && <Alert type="warning" showIcon title={vault.problem} />}
        {vault.keysError && <Alert type="warning" showIcon title={`KeyVault chưa cho liệt kê key: ${vault.keysError}`} />}
        <Flex vertical gap={2}>
          <Typography.Text>Địa chỉ KeyVault</Typography.Text>
          <Input value={form.server} placeholder="http://100.112.133.34:8000" onChange={(e) => setForm({ ...form, server: e.target.value })} />
        </Flex>
        <Row gutter={[12, 8]}>
          {(['primary', 'fallback'] as const).map((plan) => (
            <Col key={plan} xs={24} md={12}>
              <Flex vertical gap={2}>
                <Typography.Text>Key của {plan === 'primary' ? 'Gói 1 (chính)' : 'Gói 2 (dự phòng)'}</Typography.Text>
                <AutoComplete
                  value={form[plan]}
                  options={options}
                  placeholder={vault.keys ? 'Chọn key' : 'Tên hoặc id của key'}
                  onChange={(v) => setForm({ ...form, [plan]: v })}
                />
              </Flex>
            </Col>
          ))}
        </Row>
        <Flex justify="flex-end">
          <Button type="primary" size="small" loading={saving} onClick={save}>
            Lưu cấu hình
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}

/** Fetches one plan's token from the KeyVault: the code is asked for here, each one works once */
function VaultFetch({ plan, vault, onFetched }: { plan: string; vault: Vault; onFetched: () => void }) {
  const [open, setOpen] = useState(false);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useActions();
  const info = vault.plans.find((p) => p.key === plan);

  const submit = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/vault/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan, otp: code }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) throw new Error(body?.message || `HTTP ${res.status}`);
      showToast(`Đã lấy token từ KeyVault (${body.keyName}) và dùng ngay`, 'success');
      setOpen(false);
      onFetched();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOtp('');
      setBusy(false);
    }
  };

  return (
    <Flex vertical gap={6}>
      {!open ? (
        <Flex justify="space-between" align="center" wrap gap={6}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {info?.fetchedAt ? `Lấy từ KeyVault lúc ${new Date(info.fetchedAt).toLocaleString('vi-VN')}` : 'Token đang lấy từ .env'}
          </Typography.Text>
          <Tooltip title={!vault.ready ? vault.problem : !info?.vaultKey ? `Chưa đặt ${plan === 'primary' ? 'KV_KEY_PRIMARY' : 'KV_KEY_FALLBACK'} trong .env` : `Key "${info.vaultKey}"`}>
            <Button size="small" icon={<KeyOutlined />} disabled={!vault.ready || !info?.vaultKey} onClick={() => setOpen(true)}>
              Lấy từ KeyVault
            </Button>
          </Tooltip>
        </Flex>
      ) : (
        <Flex vertical gap={6}>
          <Typography.Text style={{ fontSize: 12 }}>Mã OTP trong Google Authenticator (mục KeyVault của gateway):</Typography.Text>
          <Flex gap={6} align="center" wrap>
            <Input.OTP length={6} value={otp} disabled={busy} onChange={(v) => (setOtp(v), v.length === 6 && void submit(v))} />
            <Button size="small" disabled={busy} onClick={() => setOpen(false)}>
              Hủy
            </Button>
          </Flex>
        </Flex>
      )}
      {error && <Alert type="error" showIcon title={error} />}
    </Flex>
  );
}

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
  const [vault, setVault] = useState<Vault | null>(null);
  const [showVault, setShowVault] = useState(false);

  const loadVault = useCallback(() => {
    fetch('/api/ai/vault', { cache: 'no-store' })
      .then((res) => res.json())
      .then((body) => body?.success && setVault(body))
      .catch(() => {});
  }, []);
  useEffect(loadVault, [loadVault]);

  useEffect(() => {
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
    void load(false);
    // The countdowns move on by themselves; the numbers only when asked (each check uses a sliver of the plan)
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, [load]);

  const active = activePlan(plans, chosen);

  return (
    <Card
      title={
        <Space>
          <RobotOutlined /> Gói Claude của dự án
        </Space>
      }
      extra={
        <Space>
          <Button size="small" icon={<SettingOutlined />} type={showVault ? 'primary' : 'default'} onClick={() => setShowVault(!showVault)}>
            KeyVault
          </Button>
          <Tooltip title="Mỗi lần kiểm tra là một lời gọi Claude rất nhỏ, tốn chút xíu hạn mức">
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => load(true)}>
              Kiểm tra lại
            </Button>
          </Tooltip>
        </Space>
      }
    >
      {choices.length > 0 && (
        <Flex vertical gap={6} style={{ marginBottom: 12 }}>
          <Typography.Text strong>Chạy task bằng</Typography.Text>
          <Segmented block value={chosen} disabled={saving} options={planOptions(choices, true)} onChange={(v) => choose(v as PlanChoice['plan'])} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {chosen === 'auto'
              ? 'Tự động: dùng gói 1, khi gói 1 hết lượt thì chuyển sang gói 2.'
              : `Chỉ dùng ${chosen === 'primary' ? 'gói 1' : 'gói 2'}: hết lượt thì task báo lỗi, gói còn lại để dành.`}{' '}
            Áp cho Thiết kế AI, mô hình từ ảnh, nhận xét timelapse, nhận diện chi tiết và phân tích lỗi; mẫu AI chọn riêng được khi tạo.
          </Typography.Text>
        </Flex>
      )}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        Mỗi gói có hai giới hạn: lượng dùng trong 5 giờ và trong 7 ngày.
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
                      claude setup-token) rồi khởi động lại gateway{vault?.server ? ', hoặc lấy từ KeyVault' : ''}.
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
                  {vault?.server && (
                    <VaultFetch
                      plan={plan.key}
                      vault={vault}
                      onFetched={() => {
                        loadVault();
                        void load(true);
                      }}
                    />
                  )}
                </Flex>
              </Card>
            </Col>
          );
        })}
      </Row>
      {showVault && vault && <VaultConfig vault={vault} onSaved={setVault} />}
    </Card>
  );
}
