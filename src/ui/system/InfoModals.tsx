'use client';

import { Alert, Card, Collapse, Flex, List, Modal, Spin, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';

interface RouteDoc {
  method: string;
  path: string;
  category?: string;
  description?: string;
  body?: string;
  exampleUrl?: string;
}

interface Capability {
  id: string;
  name: string;
  description?: string;
  status: string;
}

/** GETs `url` while `open` and hands back its JSON, or the error */
function useLoad<T>(open: boolean, url: string): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => !cancelled && setData(json))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [open, url]);
  return { data, error };
}

const methodColor = (method: string) => (method.includes('POST') ? 'green' : method.includes('DELETE') ? 'red' : 'blue');

/** Every REST endpoint and the WebSocket, by category (GET /api/routes) */
export function ApiModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, error } = useLoad<{ routes: RouteDoc[] }>(open, '/api/routes');
  const categories = new Map<string, RouteDoc[]>();
  for (const route of data?.routes ?? []) {
    const name = route.category || 'Khác';
    categories.set(name, [...(categories.get(name) ?? []), route]);
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={900} title="⚡ Danh Sách Gateway REST API & WebSocket Endpoints">
      <Typography.Paragraph type="secondary">
        Danh sách đầy đủ tất cả REST API endpoints &amp; luồng WebSocket hỗ trợ điều khiển máy in Bambu Lab H2D, xem camera, kiểm tra
        telemetry và gửi lệnh G-code/MQTT:
      </Typography.Paragraph>
      {error ? (
        <Alert type="error" title={`Không thể tải danh sách API: ${error}`} />
      ) : !data ? (
        <Spin />
      ) : (
        <Collapse
          defaultActiveKey={[...categories.keys()].slice(0, 1)}
          items={[...categories].map(([name, routes]) => ({
            key: name,
            label: `📂 ${name} (${routes.length})`,
            children: (
              <Flex vertical gap={8}>
                {routes.map((r) => (
                  <Card key={`${r.method} ${r.path}`} size="small">
                    <Flex wrap gap={8} justify="space-between" align="center">
                      <Flex wrap gap={8} align="center" style={{ fontFamily: 'var(--font-mono)' }}>
                        <Tag color={methodColor(r.method)}>{r.method}</Tag>
                        {r.exampleUrl && !r.exampleUrl.startsWith('ws') ? (
                          <a href={r.exampleUrl} target="_blank" rel="noopener noreferrer">
                            {r.path}
                          </a>
                        ) : (
                          <Typography.Text strong>{r.path}</Typography.Text>
                        )}
                      </Flex>
                      {r.body && <Tag style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'normal' }}>Body: {r.body}</Tag>}
                    </Flex>
                    {r.description && (
                      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 13 }}>
                        {r.description}
                      </Typography.Text>
                    )}
                  </Card>
                ))}
              </Flex>
            ),
          }))}
        />
      )}
    </Modal>
  );
}

const STATUS_COLORS: Record<string, string> = { supported: 'green', unknown: 'orange', unsupported: 'red' };

/** What the printer supports and how sure the gateway is (GET /api/capabilities) */
export function CapabilitiesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, error } = useLoad<{ capabilities: Capability[] }>(open, '/api/capabilities');
  return (
    <Modal open={open} onCancel={onClose} footer={null} width={640} title="⚙️ Capability Registry Explorer">
      <Typography.Paragraph type="secondary">Danh sách tất cả các tính năng và trạng thái hỗ trợ thực tế của máy in Bambu Lab H2D:</Typography.Paragraph>
      {error ? (
        <Alert type="error" title={`Lỗi khi tải capabilities: ${error}`} />
      ) : (
        <List
          loading={!data}
          dataSource={data?.capabilities ?? []}
          renderItem={(cap) => (
            <List.Item extra={<Tag color={STATUS_COLORS[cap.status.toLowerCase()] ?? 'default'}>{cap.status}</Tag>}>
              <List.Item.Meta
                title={
                  <>
                    {cap.name} <Typography.Text type="secondary">({cap.id})</Typography.Text>
                  </>
                }
                description={cap.description}
              />
            </List.Item>
          )}
        />
      )}
    </Modal>
  );
}
