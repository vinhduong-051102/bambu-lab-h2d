'use client';

import { FormEvent, useEffect, useState } from 'react';
import { DashboardMarkup } from './DashboardMarkup';
import { initDashboard } from './dashboardController';

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

  useEffect(() => {
    if (auth === 'ready') return initDashboard();
  }, [auth]);

  return (
    <>
      <DashboardMarkup />
      {auth === 'required' && <LoginModal onSuccess={() => setAuth('ready')} />}
    </>
  );
}

function LoginModal({ onSuccess }: { onSuccess: () => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
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
    <div className="modal-backdrop open">
      <form className="modal-content" style={{ maxWidth: 420 }} onSubmit={submit}>
        <div className="modal-header">
          <h3>
            <span className="modal-icon">🔒</span>
            {' Đăng nhập Gateway'}
          </h3>
        </div>
        <p className="modal-desc">Gateway đang bật GATEWAY_API_KEY. Nhập key để mở dashboard.</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="GATEWAY_API_KEY"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="temp-input"
        />
        {error && <p style={{ color: '#ef4444', margin: 0 }}>{error}</p>}
        <button type="submit" className="btn-cap-modal" disabled={submitting || !key}>
          {submitting ? '⏳ Đang kiểm tra...' : 'Đăng nhập'}
        </button>
      </form>
    </div>
  );
}
