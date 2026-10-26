'use client';

import { LockOutlined } from '@ant-design/icons';
import { Alert, App, ConfigProvider, Form, Input, Modal, Spin } from 'antd';
import viVN from 'antd/locale/vi_VN';
import { useEffect, useState } from 'react';
import { DashboardProvider } from './DashboardContext';
import { Shell } from './Shell';
import { dashboardTheme } from './theme';

type AuthState = 'checking' | 'required' | 'ready';

export function Dashboard() {
  const [auth, setAuth] = useState<AuthState>('checking');

  // When GATEWAY_API_KEY is set, the dashboard needs a session cookie before any /api or /ws call.
  useEffect(() => {
    fetch('/api/auth/session')
      .then((res) => res.json())
      .then((data) => setAuth(data.authRequired && !data.authenticated ? 'required' : 'ready'))
      .catch(() => setAuth('ready'));
  }, []);

  return (
    <ConfigProvider theme={dashboardTheme} locale={viVN}>
      <App>
        {auth === 'ready' ? (
          <DashboardProvider>
            <Shell />
          </DashboardProvider>
        ) : auth === 'required' ? (
          <LoginModal onSuccess={() => setAuth('ready')} />
        ) : (
          <Spin fullscreen />
        )}
      </App>
    </ConfigProvider>
  );
}

function LoginModal({ onSuccess }: { onSuccess: () => void }) {
  const [form] = Form.useForm<{ key: string }>();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async ({ key }: { key: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (res.ok) {
        onSuccess();
        return;
      }
      setError('API key không đúng.');
    } catch (err) {
      setError(`Không thể kết nối Gateway: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title={
        <>
          <LockOutlined /> Đăng nhập Gateway
        </>
      }
      closable={false}
      mask={{ closable: false }}
      keyboard={false}
      okText="Đăng nhập"
      cancelButtonProps={{ hidden: true }}
      okButtonProps={{ loading: submitting, htmlType: 'submit', form: 'gatewayLogin' }}
      width={420}
    >
      <p>Gateway đang bật GATEWAY_API_KEY. Nhập key để mở dashboard.</p>
      <Form id="gatewayLogin" form={form} onFinish={submit}>
        <Form.Item name="key" rules={[{ required: true, message: 'Nhập GATEWAY_API_KEY' }]}>
          <Input.Password autoFocus autoComplete="current-password" placeholder="GATEWAY_API_KEY" />
        </Form.Item>
      </Form>
      {error && <Alert type="error" title={error} showIcon />}
    </Modal>
  );
}
