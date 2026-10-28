'use client';

import { CheckCircleFilled, CloseCircleFilled, DeleteOutlined, LoadingOutlined, StopOutlined } from '@ant-design/icons';
import { Button, Flex, Popconfirm, Tooltip, Typography } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { fileUrl, isBusy, versionLabel } from '../cad';
import { formatPrintTime } from '../prints';
import { CadJobCard, type CadAction, type CadJob } from './CadJob';

const STATE_ICONS: Record<string, ReactNode> = {
  done: <CheckCircleFilled style={{ color: '#10b981' }} />,
  failed: <CloseCircleFilled style={{ color: '#ef4444' }} />,
  cancelled: <StopOutlined style={{ color: '#9ca3af' }} />,
  running: <LoadingOutlined style={{ color: '#3b82f6' }} />,
  queued: <LoadingOutlined style={{ color: '#6b7280' }} />,
};

/**
 * One model with its versions (groupVersions in ../cad): the original, Claude's fixes, revisions and remakes, oldest
 * first in a strip of thumbnails. The newest is shown until another is picked, and again whenever a new one comes;
 * a version made from another shows that one's preview beside its own. `onDeleteAll` deletes the whole group.
 */
export function CadFamily(props: {
  versions: CadJob[];
  now?: number;
  onAction: (job: CadJob, action: CadAction) => Promise<void>;
  onRevise: (job: CadJob, comment: string, images: File[]) => Promise<boolean>;
  onDeleteAll?: () => Promise<void>;
}) {
  const { versions, now, onAction, onRevise, onDeleteAll } = props;
  const newest = versions[versions.length - 1];
  const [picked, setPicked] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // A new version (a fix just sent) is shown at once
  useEffect(() => setPicked(null), [newest.id]);
  const shown = versions.find((job) => job.id === picked) ?? newest;
  const before = shown.parent_id ? versions.find((job) => job.id === shown.parent_id) ?? null : null;
  const anyBusy = versions.some(isBusy);

  return (
    <Flex vertical gap={6} className="cad-family">
      {versions.length > 1 && (
        <Flex wrap gap={6} align="center" className="cad-versions">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {versions.length} phiên bản:
          </Typography.Text>
          {versions.map((job, i) => (
            <Tooltip key={job.id} title={`${formatPrintTime(job.created_at)} · ${job.title || job.prompt}`}>
              <button
                type="button"
                className={`cad-version${job.id === shown.id ? ' is-shown' : ''}`}
                aria-pressed={job.id === shown.id}
                onClick={() => setPicked(job.id)}
              >
                {job.files?.preview ? <img src={fileUrl(job, 'preview.png')} alt="" /> : <span className="cad-version-empty" />}
                <span>
                  v{i + 1} · {versionLabel(job)} {STATE_ICONS[job.state]}
                </span>
              </button>
            </Tooltip>
          ))}
          {onDeleteAll && (
            <Popconfirm
              title={`Xóa cả ${versions.length} phiên bản?`}
              description="Xóa mô hình gốc và mọi bản sửa, tạo lại từ nó. Không lấy lại được."
              okText="Xóa hết"
              cancelText="Thôi"
              okButtonProps={{ danger: true }}
              disabled={anyBusy}
              onConfirm={async () => {
                setDeleting(true);
                try {
                  await onDeleteAll();
                } finally {
                  setDeleting(false);
                }
              }}
            >
              <Button size="small" type="text" danger icon={<DeleteOutlined />} loading={deleting} disabled={anyBusy} title={anyBusy ? 'Có bản đang dựng' : 'Xóa cả nhóm'}>
                Xóa cả nhóm
              </Button>
            </Popconfirm>
          )}
        </Flex>
      )}
      <CadJobCard
        key={shown.id}
        job={shown}
        now={now}
        before={before}
        onAction={(act) => onAction(shown, act)}
        onRevise={(comment, images) => onRevise(shown, comment, images)}
      />
    </Flex>
  );
}
