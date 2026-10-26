'use client';

import { HistoryOutlined, ReloadOutlined, SwapOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Empty, Row, Space, Spin, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useActions } from '../DashboardContext';
import { historyItems } from '../prints';
import { CompareModal, PrintDetailModal, printsApi, TimelapsePlayer, type Labels } from './PrintModals';
import { PrintRow, VideoRow, type PrintSummary } from './rows';
import type { Video } from './TimelapseReview';

/**
 * Print history ("Lịch sử in"): the prints the gateway recorded (GET /api/prints) and the printer's timelapse
 * videos (GET /api/timelapse) in one list. A print opens in a detail window; two ticked prints open side by
 * side with only the settings that differ; a video whose print is older than the list plays on its own.
 * Videos paired with no print aren't shown.
 */

const REFRESH_MS = 60_000;
// The printer's video listing is read over FTPS: reloaded less often than the history, and on "Làm mới"
const VIDEOS_REFRESH_MS = 5 * 60_000;
const LIST_LIMIT = 50;

export function PrintHistoryCard() {
  const { showToast } = useActions();
  const [prints, setPrints] = useState<PrintSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [videosError, setVideosError] = useState<string | null>(null);
  const [labels, setLabels] = useState<Labels>({ outcomes: [], issues: [], settingLabels: {} });
  const [loading, setLoading] = useState(false);
  /** Ticked prints for comparing, in tick order (at most 2) */
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [compare, setCompare] = useState<[string, string] | null>(null);
  const [playing, setPlaying] = useState<Video | null>(null);
  const busy = useRef(false);
  const lastLoad = useRef(0);
  const videosAt = useRef(0);

  /** `manual` reports errors as a toast and re-reads the printer's videos */
  const load = useCallback(
    async (manual = false) => {
      if (busy.current) return;
      busy.current = true;
      setLoading(true);
      try {
        const readVideos = manual || Date.now() - videosAt.current >= VIDEOS_REFRESH_MS;
        const [data] = await Promise.all([
          printsApi(`/api/prints?limit=${LIST_LIMIT}`),
          readVideos &&
            printsApi<{ videos: Video[] }>(`/api/timelapse${manual ? '?refresh=1' : ''}`).then(
              (d) => {
                setVideos(d.videos ?? []);
                setVideosError(null);
                videosAt.current = Date.now();
              },
              // The history still shows without the printer; read again on the next refresh
              (err) => setVideosError(err.message)
            ),
        ]);
        const list: PrintSummary[] = data.prints ?? [];
        setPrints(list);
        setListError(null);
        setLabels({ outcomes: data.outcomes ?? [], issues: data.issues ?? [], settingLabels: data.setting_labels ?? {} });
        setSelected((prev) => prev.filter((id) => list.some((p) => p.id === id)));
        lastLoad.current = Date.now();
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (manual) showToast(text, 'error');
        setListError(text);
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [showToast]
  );

  // Refresh every minute while the tab is visible; catch up as soon as it's shown again
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_MS);
    const onVisibility = () => {
      if (!document.hidden && Date.now() - lastLoad.current >= REFRESH_MS) load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  const select = (id: string, checked: boolean) =>
    setSelected((prev) => (checked ? [...prev.filter((s) => s !== id), id].slice(-2) : prev.filter((s) => s !== id)));

  const items: { print: PrintSummary | null; video: Video | null }[] = prints ? historyItems(prints, videos ?? []) : [];
  const full = selected.length >= 2;

  return (
    <Card
      title={
        <>
          <HistoryOutlined /> Lịch sử in
        </>
      }
      extra={
        <Space wrap>
          <Button
            type="primary"
            icon={<SwapOutlined />}
            disabled={selected.length !== 2}
            onClick={() => setCompare([selected[0], selected[1]])}
          >
            So sánh 2 bản in
          </Button>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load(true)}>
            Làm mới
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        {selected.length === 0 ? 'Tích 2 bản in để so sánh.' : `Đã chọn ${selected.length}/2 bản in để so sánh.`}
      </Typography.Paragraph>
      {videosError && <Alert type="warning" showIcon title={`Không đọc được timelapse trên máy in: ${videosError}`} style={{ marginBottom: 12 }} />}
      {!prints ? (
        listError ? (
          <Alert type="error" title={`Không tải được lịch sử in: ${listError}`} />
        ) : (
          <Spin description="Đang tải lịch sử in...">
            <div style={{ height: 80 }} />
          </Spin>
        )
      ) : items.length === 0 ? (
        <Empty
          description={
            <>
              Chưa có bản in nào. Mỗi lần Bambu Studio gửi lệnh in, bản in được ghi lại tự động kèm preset và setting; khi in xong, gateway chụp
              một ảnh từ camera. Bạn có thể thêm ảnh và báo cáo kết quả cho từng bản in. Bật <b>Timelapse</b> trong hộp gửi lệnh in của Studio để
              máy in quay video bản in.
            </>
          }
        />
      ) : (
        <Row gutter={[10, 10]}>
          {items.map(({ print, video }) => (
            <Col key={print?.id ?? video?.name} xs={24} md={12} xl={8} xxl={6}>
              {print ? (
                <PrintRow
                  print={print}
                  outcomes={labels.outcomes}
                  selected={selected.includes(print.id)}
                  selectDisabled={full}
                  video={video}
                  onSelect={(checked) => select(print.id, checked)}
                  onOpen={() => setDetail(print.id)}
                />
              ) : (
                video && <VideoRow video={video} onOpen={() => setPlaying(video)} />
              )}
            </Col>
          ))}
        </Row>
      )}

      <PrintDetailModal
        id={detail}
        name={prints?.find((p) => p.id === detail)?.job_name}
        labels={labels}
        videos={videosAt.current ? videos : null}
        onClose={() => setDetail(null)}
        onChanged={() => load()}
      />
      <CompareModal ids={compare} labels={labels} onClose={() => setCompare(null)} />
      <TimelapsePlayer video={playing} onClose={() => setPlaying(null)} />
    </Card>
  );
}
