import { Card, Checkbox, Flex, Space, Tag, Tooltip, Typography } from 'antd';
import { formatPrintTime, photoUrl } from '../prints';
import { formatSize, thumbnailUrl } from '../timelapse';
import { OutcomeTag, StatusTag, type Label } from './badges';
import type { Video } from './TimelapseReview';

export interface PrintSummary {
  id: string;
  job_name: string;
  started_at: string | null;
  ended_at: string | null;
  status: string;
  process_preset?: string | null;
  filaments?: unknown[];
  ai_session_id?: string | null;
  photos?: { name: string; source: string; taken_at: string }[];
  feedback_outcome?: string | null;
}

function Thumb({ src, empty }: { src: string | null; empty: string }) {
  return (
    <div className="print-thumb">
      {src ? <img src={src} alt="" loading="lazy" /> : <span aria-hidden="true">{empty}</span>}
    </div>
  );
}

/**
 * One print of the history: thumbnail (its first photo, else its video's), name, time, badges and preset, with
 * the checkbox that picks it for comparing
 */
export function PrintRow(props: {
  print: PrintSummary;
  outcomes?: Label[];
  selected?: boolean;
  selectDisabled?: boolean;
  video?: Video | null;
  onSelect?: (checked: boolean) => void;
  onOpen?: () => void;
}) {
  const { print, outcomes = [], selected = false, selectDisabled = false, video = null, onSelect, onOpen } = props;
  const photo = print.photos?.[0];
  const thumb = photo ? photoUrl(print.id, photo.name) : video?.has_thumbnail ? thumbnailUrl(video.name) : null;
  return (
    <Card size="small" hoverable className={`print-row${selected ? ' is-selected' : ''}`} styles={{ body: { padding: 10 } }}>
      <Flex gap={10} align="center">
        <Tooltip title="Chọn để so sánh">
          <Checkbox checked={selected} disabled={selectDisabled && !selected} onChange={(e) => onSelect?.(e.target.checked)} />
        </Tooltip>
        <Flex gap={10} align="center" flex={1} onClick={onOpen} style={{ cursor: 'pointer', minWidth: 0 }}>
          <Thumb src={thumb} empty="🖨️" />
          <Flex vertical gap={2} style={{ minWidth: 0 }}>
            <Typography.Text strong ellipsis>
              {print.job_name}
            </Typography.Text>
            <Space size={[4, 4]} wrap>
              <Typography.Text type="secondary" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                {formatPrintTime(print.started_at ?? print.ended_at)}
              </Typography.Text>
              <StatusTag status={print.status} />
              <OutcomeTag outcome={print.feedback_outcome} outcomes={outcomes} />
              {print.ai_session_id && (
                <Tooltip title="Có dùng đề xuất AI">
                  <Tag color="magenta">AI</Tag>
                </Tooltip>
              )}
              {video && (
                <Tooltip title="Có timelapse: mở bản in để xem">
                  <Tag color="blue">🎬 Video</Tag>
                </Tooltip>
              )}
            </Space>
            {print.process_preset && (
              <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                {print.process_preset}
              </Typography.Text>
            )}
          </Flex>
        </Flex>
      </Flex>
    </Card>
  );
}

/** A row of the history for a video whose print is older than the list */
export function VideoRow({ video, onOpen }: { video: Video; onOpen?: () => void }) {
  return (
    <Card size="small" hoverable className="print-row" styles={{ body: { padding: 10 } }} onClick={onOpen}>
      <Flex gap={10} align="center" style={{ minWidth: 0 }}>
        <Thumb src={video.has_thumbnail ? thumbnailUrl(video.name) : null} empty="🎬" />
        <Flex vertical gap={2} style={{ minWidth: 0 }}>
          <Typography.Text strong>🎬 Timelapse</Typography.Text>
          <Space size={8} wrap>
            <Typography.Text type="secondary" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {formatPrintTime(video.ended_at)}
            </Typography.Text>
            <Typography.Text type="secondary">{formatSize(video.size)}</Typography.Text>
          </Space>
          {video.print && (
            <Typography.Text type="secondary" ellipsis title="Bản in trong lịch sử" style={{ fontSize: 12 }}>
              🖨️ {video.print.job_name}
            </Typography.Text>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}
