'use client';

import { DeleteOutlined } from '@ant-design/icons';
import { Button, Card, Collapse, Empty, Flex, Popconfirm, Switch, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useActions } from '../DashboardContext';
import { describeActions, kindLabel } from '../tasks';

/** GET /api/tasks/rules (src/domain/retryRules.ts) */
interface LearnedRule {
  id: string;
  kind: string;
  pattern: string;
  cause: string;
  actions: Record<string, { set: number | boolean } | { scale: number }>;
  hint: string | null;
  example: string;
  learned_from: string;
  created_at: string;
  hits: number;
  misses: number;
  enabled: boolean;
}

const day = (at: string) => new Date(at).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

function RuleItem({ rule, onChange }: { rule: LearnedRule; onChange: () => void }) {
  const { showToast } = useActions();
  const [busy, setBusy] = useState(false);
  const send = async (method: 'PATCH' | 'DELETE', body?: object) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/rules?id=${encodeURIComponent(rule.id)}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body && { body: JSON.stringify(body) }),
      });
      const data = (await res.json().catch(() => null)) as { success?: boolean; message?: string } | null;
      if (!res.ok || !data?.success) throw new Error(data?.message || `HTTP ${res.status}`);
      onChange();
    } catch (err) {
      showToast(`Không sửa được quy tắc: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card size="small" style={rule.enabled ? undefined : { opacity: 0.6 }}>
      <Flex vertical gap={4}>
        <Flex justify="space-between" align="start" gap={8}>
          <Flex gap={6} wrap align="center">
            <Tag>{kindLabel(rule.kind)}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Sửa được {rule.hits} lần{rule.misses ? ` · hỏng ${rule.misses} lần` : ''} · học {day(rule.created_at)}
            </Typography.Text>
          </Flex>
          <Flex gap={4} align="center">
            <Switch size="small" checked={rule.enabled} loading={busy} onChange={(on) => send('PATCH', { enabled: on })} title={rule.enabled ? 'Đang dùng' : 'Đã tắt'} />
            <Popconfirm title="Xóa quy tắc này?" description="Lỗi này lần sau sẽ lại do Claude phân tích." onConfirm={() => send('DELETE')} okText="Xóa" cancelText="Không">
              <Button size="small" type="text" danger icon={<DeleteOutlined />} disabled={busy} title="Xóa quy tắc" />
            </Popconfirm>
          </Flex>
        </Flex>
        <Typography.Text style={{ fontSize: 13 }}>{rule.cause}</Typography.Text>
        <Typography.Text style={{ fontSize: 12 }}>→ {describeActions(rule.actions)}</Typography.Text>
        {rule.hint && <Typography.Text style={{ fontSize: 12 }}>→ Dặn Claude: {rule.hint}</Typography.Text>}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Khớp lỗi: <code className="rule-pattern">{rule.pattern}</code>
        </Typography.Text>
        {!rule.enabled && rule.misses > rule.hits && (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            Tự tắt vì không còn sửa được: lỗi này lại do Claude phân tích.
          </Typography.Text>
        )}
      </Flex>
    </Card>
  );
}

/**
 * What retries have learned (src/domain/retryRules.ts): a failure Claude analysed that the run after it then mended,
 * kept as a rule, so the same failure is mended next time without Claude. Listed to read, switch off or delete.
 */
export function RetryRules({ open }: { open: boolean }) {
  const [rules, setRules] = useState<LearnedRule[] | null>(null);
  const load = useCallback(async () => {
    const res = await fetch('/api/tasks/rules', { cache: 'no-store' }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { rules?: LearnedRule[] } | null;
    if (data?.rules) setRules(data.rules);
  }, []);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const active = rules?.filter((r) => r.enabled).length ?? 0;
  return (
    <Collapse
      size="small"
      items={[
        {
          key: 'rules',
          label: `Lỗi đã học (${active}${rules && rules.length > active ? `/${rules.length}` : ''})`,
          children: (
            <Flex vertical gap={8}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Khi Claude phân tích một lỗi chưa có quy tắc và lần chạy lại thành công, cách sửa được lưu thành quy tắc (mẫu lỗi + núm cần chỉnh). Lần sau gặp lỗi khớp mẫu sẽ
                sửa luôn, không cần AI; quy tắc hỏng nhiều hơn sửa được thì tự tắt.
              </Typography.Text>
              {rules?.length ? rules.map((r) => <RuleItem key={r.id} rule={r} onChange={load} />) : <Empty description="Chưa học được lỗi nào" />}
            </Flex>
          ),
        },
      ]}
    />
  );
}
