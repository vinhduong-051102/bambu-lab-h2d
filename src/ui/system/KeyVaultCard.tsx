'use client';

import { CheckCircleOutlined, KeyOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Flex, Input, Popconfirm, QRCode, Segmented, Select, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useActions } from '../DashboardContext';

/**
 * The KeyVault the Claude tokens come from (GET/POST /api/keyvault): registering the gateway step by step (send a
 * request, see how it stands, take the authenticator's secret, activate with a code; or an admin registers the
 * gateway's public key and hands over an API key; "Kết nối lại" starts over from any stage), then each key granted put on a plan with a code: tried for real
 * first, kept only when it works. A token's value never reaches this page, only its last 4 characters.
 */

type Plan = 'primary' | 'fallback';
type Key = { id: string; name: string; description?: string; size_bytes?: number; guess: Plan | null };
type PlanSource = {
  key: Plan;
  label: string;
  env: string;
  source: 'vault' | 'env' | 'dropped' | 'none';
  last4: string;
  vaultKey: { id: string; name: string } | null;
  fetchedAt: string | null;
};
type View = {
  stage: 'none' | 'pending' | 'approved' | 'rejected' | 'claimed' | 'active';
  server: string;
  serverFromEnv: boolean;
  hasPrivateKey: boolean;
  requestId: string | null;
  reviewNote: string | null;
  claimExpiresAt: string | null;
  totpSecret: string | null;
  otpauthUri: string | null;
  keys: Key[];
  keysCheckedAt: string | null;
  plans: PlanSource[];
};
type KeyTest = { keyName: string; last4: string; usable: boolean; error: string | null; fiveHour: number | null; sevenDay: number | null; organization: string | null; sameAs: string | null };

const STAGES: Record<View['stage'], { text: string; color: string }> = {
  none: { text: 'chưa đăng ký', color: 'default' },
  pending: { text: 'chờ duyệt', color: 'gold' },
  approved: { text: 'đã duyệt', color: 'blue' },
  rejected: { text: 'bị từ chối', color: 'red' },
  claimed: { text: 'chờ kích hoạt', color: 'gold' },
  active: { text: 'đã kết nối', color: 'green' },
};
const PLAN_OPTIONS = [
  { value: 'primary', label: 'Gói 1 (chính)' },
  { value: 'fallback', label: 'Gói 2 (dự phòng)' },
];
const SOURCES: Record<PlanSource['source'], { text: string; color: string }> = {
  vault: { text: 'từ KeyVault', color: 'green' },
  env: { text: 'từ .env', color: 'default' },
  dropped: { text: 'đã bỏ', color: 'red' },
  none: { text: 'chưa có', color: 'default' },
};
const pct = (v: number | null) => (v === null ? '?' : `${Math.round(v * 100)} %`);

/** A 6-digit code and a button: each code works once */
function OtpAction({ label, disabled, onSubmit }: { label: string; disabled?: boolean; onSubmit: (otp: string) => Promise<void> }) {
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onSubmit(otp);
    } finally {
      setOtp('');
      setBusy(false);
    }
  };
  return (
    <Space.Compact>
      <Input
        style={{ width: 96 }}
        value={otp}
        maxLength={6}
        inputMode="numeric"
        placeholder="OTP"
        disabled={disabled || busy}
        onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
        onPressEnter={() => otp.length === 6 && void run()}
      />
      <Button type="primary" loading={busy} disabled={disabled || otp.length !== 6} onClick={run}>
        {label}
      </Button>
    </Space.Compact>
  );
}

export function KeyVaultCard() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<'request' | 'import'>('request');
  const [form, setForm] = useState({ name: 'bambu-lab-h2d-gateway', contact: '', organization: 'bambu-lab-h2d', reason: 'Gateway máy in lấy token gói Claude', requested_keys: '' });
  const [imported, setImported] = useState({ api_key: '', private_key_pem: '' });
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [planOf, setPlanOf] = useState<Record<string, Plan | undefined>>({});
  const [keyOf, setKeyOf] = useState<Record<string, string | undefined>>({});
  const [tests, setTests] = useState<Record<string, KeyTest>>({});
  const { showToast } = useActions();

  useEffect(() => {
    fetch('/api/keyvault', { cache: 'no-store' })
      .then((res) => res.json())
      .then((body) => (body?.success ? setView(body) : setError(body?.message ?? 'Không đọc được trạng thái KeyVault')))
      .catch((err) => setError(String(err)));
  }, []);

  /** Runs an action; its answer carries the new view. Returns the answer, or null when it failed (shown here). */
  const act = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/keyvault/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) throw new Error(body?.message || `HTTP ${res.status}`);
      if (body.stage) setView(body);
      return body;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const stage = view ? STAGES[view.stage] : null;

  /** Starts registering again from any stage: the request form comes back */
  const reconnectButton = (label = 'Kết nối lại') => (
    <Popconfirm
      title="Kết nối lại KeyVault từ đầu?"
      description="Đăng ký hiện tại (API key, private key) chuyển vào .backup-<giờ>/; gửi yêu cầu mới với cặp khóa mới. Token đã lấy vẫn dùng tiếp."
      onConfirm={async () => {
        const body = await act('reconnect');
        if (body) {
          setMode('request');
          showToast('Đã bỏ đăng ký cũ: gửi yêu cầu mới bên dưới', 'success');
        }
      }}
    >
      <Button size="small" loading={busy === 'reconnect'}>
        {label}
      </Button>
    </Popconfirm>
  );
  const fromVault = view?.plans.some((p) => p.source === 'vault') ?? false;
  const toDrop = view?.plans.filter((p) => p.source === 'env') ?? [];

  const use = async (plan: Plan, otp: string, keyId?: string) => {
    const body = await act('use', { plan, otp, key_id: keyId });
    if (body) showToast(`${PLAN_OPTIONS.find((o) => o.value === plan)?.label}: đã dùng token ${body.used.last4} từ KeyVault (${body.used.keyName})`, 'success');
  };

  return (
    <Card
      title={
        <Space>
          <KeyOutlined /> KeyVault cho token gói Claude
        </Space>
      }
      extra={stage && <Tag color={stage.color}>{stage.text}</Tag>}
    >
      <Flex vertical gap={12}>
        {error && <Alert type="error" showIcon closable title={error} onClose={() => setError(null)} />}
        {!view ? null : (
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Máy chủ {view.server}
              {view.serverFromEnv ? ' (KV_SERVER trong .env)' : ''}
            </Typography.Text>

            {(view.stage === 'none' || view.stage === 'rejected') && (
              <Flex vertical gap={10}>
                {view.stage === 'rejected' && <Alert type="error" showIcon title={`Yêu cầu bị từ chối${view.reviewNote ? `: ${view.reviewNote}` : ''}. Gửi lại bên dưới.`} />}
                <Segmented
                  block
                  value={mode}
                  onChange={(v) => setMode(v as typeof mode)}
                  options={[
                    { value: 'request', label: 'Tự gửi yêu cầu' },
                    { value: 'import', label: 'Quản trị viên đăng ký giúp' },
                  ]}
                />
                {mode === 'request' ? (
                  <Flex vertical gap={6}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Cặp khóa được tạo trên máy này, private key không đi qua mạng. Quản trị viên duyệt xong thì bấm Kiểm tra lại.
                    </Typography.Text>
                    {(
                      [
                        ['name', 'Tên bên nhận'],
                        ['contact', 'Liên hệ (email / số điện thoại)'],
                        ['organization', 'Tổ chức'],
                        ['reason', 'Lý do'],
                        ['requested_keys', 'Key muốn truy cập'],
                      ] as const
                    ).map(([field, label]) => (
                      <Input key={field} addonBefore={label} value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value })} />
                    ))}
                    <Flex justify="flex-end">
                      <Button type="primary" loading={busy === 'request'} disabled={!form.name || !form.contact || !form.reason} onClick={() => act('request', form)}>
                        Gửi yêu cầu
                      </Button>
                    </Flex>
                  </Flex>
                ) : (
                  <Flex vertical gap={6}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Gửi public key cho quản trị viên; họ đăng ký và gửi lại API key cùng mã QR (quét bằng Google Authenticator).
                    </Typography.Text>
                    <Flex gap={8} align="center" wrap>
                      <Button loading={busy === 'pubkey'} onClick={async () => setPubkey((await act('pubkey'))?.publicKey ?? null)}>
                        Hiện public key
                      </Button>
                      {pubkey && <Typography.Text code copyable>{pubkey}</Typography.Text>}
                    </Flex>
                    <Input addonBefore="API key" placeholder="kv_..." value={imported.api_key} onChange={(e) => setImported({ ...imported, api_key: e.target.value })} />
                    <Input.TextArea
                      rows={3}
                      placeholder="Private key PEM có sẵn (tùy chọn; bỏ trống thì dùng cặp khóa của máy này)"
                      value={imported.private_key_pem}
                      onChange={(e) => setImported({ ...imported, private_key_pem: e.target.value })}
                    />
                    <Flex justify="flex-end">
                      <Button type="primary" loading={busy === 'import'} disabled={!imported.api_key} onClick={() => act('import', imported)}>
                        Lưu và kiểm tra
                      </Button>
                    </Flex>
                  </Flex>
                )}
              </Flex>
            )}

            {view.stage === 'pending' && (
              <Flex justify="space-between" align="center" wrap gap={8}>
                <Typography.Text>
                  Đã gửi yêu cầu <Typography.Text code>{view.requestId}</Typography.Text>, chờ quản trị viên duyệt.
                </Typography.Text>
                <Space>
                  <Button icon={<ReloadOutlined />} loading={busy === 'refresh'} onClick={() => act('refresh')}>
                    Kiểm tra lại
                  </Button>
                  {reconnectButton()}
                </Space>
              </Flex>
            )}

            {view.stage === 'approved' && (
              <Flex vertical gap={8}>
                <Alert
                  type="success"
                  showIcon
                  title={`Đã duyệt${view.reviewNote ? ` (${view.reviewNote})` : ''}. Nhận thông tin${view.claimExpiresAt ? ` trước ${new Date(`${view.claimExpiresAt}Z`).toLocaleString('vi-VN')}` : ''}: chỉ nhận được một lần.`}
                />
                <Flex justify="flex-end" gap={8}>
                  {reconnectButton()}
                  <Button type="primary" loading={busy === 'claim'} onClick={() => act('claim')}>
                    Nhận thông tin
                  </Button>
                </Flex>
              </Flex>
            )}

            {view.stage === 'claimed' && (
              <Flex vertical gap={10}>
                {view.totpSecret ? (
                  <Flex gap={16} wrap align="center">
                    {view.otpauthUri && <QRCode value={view.otpauthUri} size={144} />}
                    <Flex vertical gap={4} style={{ flex: 1, minWidth: 220 }}>
                      <Typography.Text>Google Authenticator: + → Quét mã QR, hoặc + → Nhập khóa thiết lập với secret:</Typography.Text>
                      <Typography.Text code copyable>
                        {view.totpSecret}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Secret chỉ giữ tới khi kích hoạt xong.
                      </Typography.Text>
                    </Flex>
                  </Flex>
                ) : (
                  <Alert
                    type="warning"
                    showIcon
                    title="Không còn secret của Google Authenticator: nhờ quản trị viên cấp lại mã QR cho bên nhận này, quét nó rồi nhập mã bên dưới; hoặc gửi yêu cầu mới."
                    action={reconnectButton('Gửi yêu cầu mới')}
                  />
                )}
                <Flex gap={8} align="center" wrap>
                  <Typography.Text>Mã đang hiện trong Google Authenticator:</Typography.Text>
                  <OtpAction label="Kích hoạt" onSubmit={async (otp) => void (await act('activate', { otp }))} />
                  {view.totpSecret && reconnectButton()}
                </Flex>
              </Flex>
            )}

            {view.stage === 'active' && (
              <Flex vertical gap={12}>
                <Flex justify="space-between" align="center" wrap gap={8}>
                  <Typography.Text strong>Key được cấp ({view.keys.length})</Typography.Text>
                  <Space>
                    <Button size="small" icon={<ReloadOutlined />} loading={busy === 'keys'} onClick={() => act('keys')}>
                      Kiểm tra
                    </Button>
                    {reconnectButton()}
                    <Popconfirm title="Gỡ kết nối KeyVault?" description="API key và private key chuyển vào .backup-<giờ>/; token đã lấy vẫn dùng tiếp." onConfirm={() => act('reset')}>
                      <Button size="small" danger loading={busy === 'reset'}>
                        Gỡ kết nối
                      </Button>
                    </Popconfirm>
                  </Space>
                </Flex>
                {view.keys.length === 0 && <Typography.Text type="secondary">Chưa có key nào được cấp cho gateway.</Typography.Text>}
                {view.keys.map((k) => {
                  const test = tests[k.id];
                  return (
                    <Card key={k.id} size="small">
                      <Flex vertical gap={6}>
                        <Flex justify="space-between" wrap gap={6}>
                          <Typography.Text strong>{k.name}</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {k.description}
                          </Typography.Text>
                        </Flex>
                        <Flex gap={8} wrap align="center">
                          <Select
                            size="small"
                            style={{ width: 160 }}
                            placeholder="Dùng cho gói"
                            value={planOf[k.id] ?? k.guess ?? undefined}
                            options={PLAN_OPTIONS}
                            onChange={(v) => setPlanOf({ ...planOf, [k.id]: v })}
                          />
                          <OtpAction
                            label="Lấy & dùng"
                            disabled={!(planOf[k.id] ?? k.guess)}
                            onSubmit={(otp) => use((planOf[k.id] ?? k.guess)!, otp, k.id)}
                          />
                          <OtpAction
                            label="Kiểm tra"
                            onSubmit={async (otp) => {
                              const body = await act('test', { key_id: k.id, otp });
                              if (body) setTests({ ...tests, [k.id]: body.test });
                            }}
                          />
                        </Flex>
                        {test && (
                          <Alert
                            type={test.usable ? 'success' : 'error'}
                            showIcon
                            title={
                              test.usable
                                ? `Dùng được (${test.last4}${test.organization ? `, tổ chức ${test.organization}` : ''}): đã dùng ${pct(test.fiveHour)} trong 5 giờ, ${pct(test.sevenDay)} trong 7 ngày${test.sameAs ? `. Trùng token ${test.sameAs} đang dùng.` : '. Khác các token đang dùng.'}`
                                : `Không dùng được: ${test.error}`
                            }
                          />
                        )}
                      </Flex>
                    </Card>
                  );
                })}
              </Flex>
            )}

            <Flex vertical gap={8}>
              <Typography.Text strong>Token của các gói</Typography.Text>
              {view.plans.map((p) => (
                <Flex key={p.key} justify="space-between" align="center" wrap gap={8}>
                  <Space wrap>
                    <Typography.Text>{p.label}</Typography.Text>
                    <Tag color={SOURCES[p.source].color}>{SOURCES[p.source].text}</Tag>
                    {p.last4 && <Typography.Text code>{p.last4}</Typography.Text>}
                    {p.source === 'vault' && p.vaultKey && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        <CheckCircleOutlined /> {p.vaultKey.name}
                        {p.fetchedAt ? `, ${new Date(p.fetchedAt).toLocaleString('vi-VN')}` : ''}
                      </Typography.Text>
                    )}
                  </Space>
                  {view.stage === 'active' && (
                    <Space.Compact>
                      <Select
                        size="middle"
                        style={{ width: 170 }}
                        placeholder="Chọn key"
                        value={keyOf[p.key] ?? p.vaultKey?.id ?? view.keys.find((k) => k.guess === p.key)?.id}
                        options={view.keys.map((k) => ({ value: k.id, label: k.name }))}
                        onChange={(v) => setKeyOf({ ...keyOf, [p.key]: v })}
                      />
                      <OtpAction
                        label="Lấy từ KeyVault"
                        disabled={!(keyOf[p.key] ?? p.vaultKey?.id ?? view.keys.find((k) => k.guess === p.key)?.id)}
                        onSubmit={(otp) => use(p.key, otp, keyOf[p.key] ?? p.vaultKey?.id ?? view.keys.find((k) => k.guess === p.key)?.id)}
                      />
                    </Space.Compact>
                  )}
                </Flex>
              ))}
              <Flex justify="flex-end">
                <Popconfirm
                  title="Bỏ token .env của các gói không lấy từ KeyVault?"
                  description={`${toDrop.map((p) => p.label).join(', ')}: giá trị cũ chuyển vào .backup-<giờ>/, không xóa hẳn.`}
                  disabled={!fromVault || !toDrop.length}
                  onConfirm={async () => {
                    const body = await act('drop-others');
                    if (body) showToast(`Đã bỏ: ${body.dropped.join(', ') || 'không có'}`, 'success');
                  }}
                >
                  <Button size="small" disabled={!fromVault || !toDrop.length} loading={busy === 'drop-others'}>
                    Bỏ các mục không từ KeyVault
                  </Button>
                </Popconfirm>
              </Flex>
            </Flex>

            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              Mỗi mã OTP chỉ dùng được một lần: lấy key kế tiếp phải chờ mã mới (khoảng 30 giây). Giờ của máy và điện thoại phải chuẩn (bật NTP). Token lấy về được thử gọi
              Claude trước, chỉ giữ khi dùng được, và lưu trên đĩa nên khởi động lại máy không phải nhập lại; chỉ lấy lại khi key hết hạn hoặc bị đổi.
            </Typography.Paragraph>
          </>
        )}
      </Flex>
    </Card>
  );
}
