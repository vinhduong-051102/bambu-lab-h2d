'use client';

import { DeleteOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Collapse, Flex, Popconfirm, Table, Tag, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useActions } from '../DashboardContext';

/**
 * The models in Studio's /imports (GET /api/studio/imports): download one, or take one or all of them out
 * (DELETE …: moved to <imports>-removed/<day> beside the folder, so a mistake can be undone by hand)
 */

type ImportFile = { name: string; size: number; modified_at: string; original: boolean };

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const fileUrl = (name: string) => `/api/studio/imports/${encodeURIComponent(name)}`;

/** `version` changes when a file was sent, so the list follows */
export function StudioImports({ version }: { version: number }) {
  const { showToast, addLog } = useActions();
  const [files, setFiles] = useState<ImportFile[] | null>(null);
  const [removedTo, setRemovedTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/studio/imports', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok || !body?.success) throw new Error(body?.message || `HTTP ${res.status}`);
      setFiles(body.files);
      setRemovedTo(body.removedTo);
    } catch (err) {
      showToast(`Không đọc được /imports: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const remove = async (name: string | null) => {
    setBusy(name ?? '*');
    try {
      const res = await fetch(name ? fileUrl(name) : '/api/studio/imports', { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok || !body?.success) throw new Error(body?.message || `HTTP ${res.status}`);
      const text = name ? `Đã xóa ${name} khỏi /imports.` : `Đã xóa ${body.removed.length} file khỏi /imports.`;
      showToast(text, 'success');
      addLog(`${text} Bản sao ở ${body.removedTo}.`, 'info');
      await load();
    } catch (err) {
      showToast(`Không xóa được: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const total = (files ?? []).reduce((s, f) => s + f.size, 0);
  return (
    <Collapse
      size="small"
      // Open: the list is where files are taken out of Studio's folder
      defaultActiveKey={['imports']}
      style={{ marginBottom: 12 }}
      items={[
        {
          key: 'imports',
          label: `📁 File trong /imports${files ? ` (${files.length} file · ${formatSize(total)})` : ''}`,
          extra: (
            <Flex gap={6} onClick={(e) => e.stopPropagation()}>
              <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load} />
              <Popconfirm
                title={`Xóa cả ${files?.length ?? 0} file khỏi /imports?`}
                description="Các file được chuyển sang thư mục sao lưu bên cạnh, không mất hẳn."
                okText="Xóa hết"
                cancelText="Thôi"
                okButtonProps={{ danger: true }}
                onConfirm={() => remove(null)}
                disabled={!files?.length}
              >
                <Button size="small" danger icon={<DeleteOutlined />} disabled={!files?.length} loading={busy === '*'}>
                  Xóa hết
                </Button>
              </Popconfirm>
            </Flex>
          ),
          children: (
            <Flex vertical gap={8}>
              <Table
                size="small"
                rowKey="name"
                dataSource={files ?? []}
                loading={loading && !files}
                pagination={{ pageSize: 10, hideOnSinglePage: true, size: 'small' }}
                locale={{ emptyText: '/imports đang trống' }}
                columns={[
                  {
                    title: 'Tên file',
                    dataIndex: 'name',
                    render: (name: string, f: ImportFile) => (
                      <Flex gap={6} align="center" wrap>
                        <Typography.Text>{name}</Typography.Text>
                        {f.original && (
                          <Tooltip title="Lưới đã được tự sửa khi gửi; bản gốc nằm trong /imports/.originals">
                            <Tag>đã sửa lưới</Tag>
                          </Tooltip>
                        )}
                      </Flex>
                    ),
                  },
                  { title: 'Dung lượng', dataIndex: 'size', align: 'right', width: 110, render: formatSize },
                  {
                    title: 'Lúc gửi',
                    dataIndex: 'modified_at',
                    width: 130,
                    render: (v: string) => new Date(v).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
                  },
                  {
                    title: '',
                    width: 90,
                    render: (_: unknown, f: ImportFile) => (
                      <Flex gap={4}>
                        <Tooltip title="Tải về máy">
                          <Button size="small" type="text" icon={<DownloadOutlined />} href={fileUrl(f.name)} />
                        </Tooltip>
                        <Popconfirm title={`Xóa ${f.name} khỏi /imports?`} okText="Xóa" cancelText="Thôi" okButtonProps={{ danger: true }} onConfirm={() => remove(f.name)}>
                          <Button size="small" type="text" danger icon={<DeleteOutlined />} loading={busy === f.name} aria-label={`Xóa ${f.name}`} />
                        </Popconfirm>
                      </Flex>
                    ),
                  },
                ]}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                File đã xóa được chuyển sang <code>{removedTo || '<imports>-removed'}</code> (mỗi ngày một thư mục) để lấy lại khi cần; xóa
                hẳn thư mục đó trong File Explorer khi chắc không dùng nữa. File đang mở trong Studio vẫn mở tiếp được cho đến khi đóng.
              </Typography.Text>
            </Flex>
          ),
        },
      ]}
    />
  );
}
