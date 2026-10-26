'use client';

import { CameraOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Divider,
  Flex,
  Form,
  Image,
  Input,
  Modal,
  Radio,
  Row,
  Space,
  Spin,
  Switch,
  Table,
  Typography,
  Upload,
} from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useActions } from '../DashboardContext';
import { diffSettings, formatPrintTime, listSettings, photoUrl, printSettings } from '../prints';
import { formatSize, videoUrl } from '../timelapse';
import { labelOf, OutcomeTag, StatusTag, type Label } from './badges';
import { ReviewResult, TimelapseReview, type Review, type Video } from './TimelapseReview';

const NO_SETUP_TEXT = 'Không có setting (bản in không gửi từ Studio)';

export interface Labels {
  outcomes: Label[];
  issues: Label[];
  settingLabels: Record<string, string>;
}

interface Photo {
  name: string;
  source: string;
  taken_at: string;
}

interface Feedback {
  outcome: string;
  issues?: string[];
  note?: string;
  at: string;
}

interface Setup {
  printer_preset: string;
  process_preset: string;
  filaments?: { preset: string; type?: string; settings?: Record<string, unknown> }[];
  nozzle_diameters?: number[];
  objects?: { name: string; size_mm?: number[] }[];
  ai_session_id?: string | null;
  settings?: Record<string, unknown>;
}

export interface PrintDetail {
  id: string;
  job_name: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  photos?: Photo[];
  feedback?: Feedback | null;
  setup?: Setup | null;
  video_review?: Review | null;
}

/** GET/POST/DELETE an /api/prints URL; throws the API's message */
export async function printsApi<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.message || `Lỗi HTTP ${res.status}`);
  return data;
}

const timeRange = (print: PrintDetail) =>
  print.ended_at ? `${formatPrintTime(print.started_at)} → ${formatPrintTime(print.ended_at)}` : formatPrintTime(print.started_at);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function Section({ title, extra, children }: { title: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="print-section">
      <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 8 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {extra}
      </Flex>
      {children}
    </section>
  );
}

function Photos({ print, onDelete }: { print: PrintDetail; onDelete?: (name: string) => void }) {
  if (!print.photos?.length) return <Typography.Text type="secondary">Chưa có ảnh.</Typography.Text>;
  return (
    <Image.PreviewGroup>
      <Flex wrap gap={10}>
        {print.photos.map((photo) => (
          <figure key={photo.name} className="print-photo">
            <Image src={photoUrl(print.id, photo.name)} alt={photo.name} width={160} height={120} style={{ objectFit: 'cover' }} />
            <figcaption>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {photo.source === 'camera' ? '📹 Camera' : '📷 Tải lên'} · {formatPrintTime(photo.taken_at)}
              </Typography.Text>
              {onDelete && <Button size="small" type="text" danger icon={<DeleteOutlined />} title="Xóa ảnh" onClick={() => onDelete(photo.name)} />}
            </figcaption>
          </figure>
        ))}
      </Flex>
    </Image.PreviewGroup>
  );
}

function Report({ feedback, labels }: { feedback: Feedback | null | undefined; labels: Labels }) {
  if (!feedback) return <Typography.Text type="secondary">Chưa có báo cáo.</Typography.Text>;
  return (
    <div>
      <Space size={4}>
        <OutcomeTag outcome={feedback.outcome} outcomes={labels.outcomes} />
        <Typography.Text type="secondary">{formatPrintTime(feedback.at)}</Typography.Text>
      </Space>
      {!!feedback.issues?.length && (
        <ul style={{ margin: '6px 0', paddingLeft: 20 }}>
          {feedback.issues.map((i) => (
            <li key={i}>{labelOf(labels.issues, i)}</li>
          ))}
        </ul>
      )}
      {feedback.note && <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{feedback.note}</Typography.Paragraph>}
    </div>
  );
}

function SetupView({ setup }: { setup: Setup | null | undefined }) {
  if (!setup) return <Typography.Text type="secondary">{NO_SETUP_TEXT}</Typography.Text>;
  const lines = (items: string[]) => (items.length ? items.map((t, i) => <div key={i}>{t}</div>) : '—');
  return (
    <Descriptions
      size="small"
      column={1}
      bordered
      items={[
        { key: 'printer', label: 'Máy in', children: setup.printer_preset },
        { key: 'process', label: 'Process', children: setup.process_preset },
        { key: 'filaments', label: 'Nhựa', children: lines((setup.filaments ?? []).map((f) => (f.type ? `${f.preset} (${f.type})` : f.preset))) },
        { key: 'nozzles', label: 'Đầu phun', children: setup.nozzle_diameters?.length ? `${setup.nozzle_diameters.join(' / ')} mm` : '—' },
        {
          key: 'objects',
          label: 'Vật thể',
          children: lines(
            (setup.objects ?? []).map((o) =>
              Array.isArray(o.size_mm) ? `${o.name} — ${o.size_mm.map((n) => Math.round(Number(n) * 10) / 10).join(' × ')} mm` : o.name
            )
          ),
        },
        { key: 'ai', label: 'Đề xuất AI', children: setup.ai_session_id ? <code>{setup.ai_session_id}</code> : 'Không' },
      ]}
    />
  );
}

const settingName = (row: { key: string; label: string | null }) => (
  <>
    {row.label && <div>{row.label}</div>}
    <Typography.Text code style={{ fontSize: 11 }}>
      {row.key}
    </Typography.Text>
  </>
);

function SettingsView({ settings, labels }: { settings: Record<string, unknown> | null; labels: Labels }) {
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState('');
  if (!settings) return <Typography.Text type="secondary">{NO_SETUP_TEXT}</Typography.Text>;
  const rows: { key: string; label: string | null; value: string }[] = listSettings(settings, labels.settingLabels, { all, filter });
  return (
    <Flex vertical gap={8}>
      <Space>
        <Switch
          size="small"
          checked={all}
          onChange={(on) => {
            setAll(on);
            if (!on) setFilter('');
          }}
        />
        <Typography.Text>Hiện tất cả setting</Typography.Text>
      </Space>
      {all && <Input.Search allowClear placeholder="Lọc theo tên, khóa hoặc giá trị..." value={filter} onChange={(e) => setFilter(e.target.value)} />}
      <Table
        size="small"
        rowKey="key"
        pagination={false}
        scroll={{ y: 420 }}
        dataSource={rows}
        locale={{ emptyText: 'Không có setting nào khớp.' }}
        columns={[
          { title: 'Setting', key: 'name', width: '45%', render: (_, row) => settingName(row) },
          { title: 'Giá trị', dataIndex: 'value', key: 'value', render: (v: string) => <span style={{ wordBreak: 'break-all' }}>{v}</span> },
        ]}
      />
    </Flex>
  );
}

function FeedbackForm({ print, labels, onSaved, onCancel }: { print: PrintDetail; labels: Labels; onSaved: () => void; onCancel: () => void }) {
  const { showToast, addLog } = useActions();
  const [saving, setSaving] = useState(false);
  const save = async (values: { outcome: string; issues?: string[]; note?: string }) => {
    setSaving(true);
    try {
      await printsApi(`/api/prints/${encodeURIComponent(print.id)}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: values.outcome, issues: values.issues ?? [], note: (values.note ?? '').trim() }),
      });
      showToast('Đã lưu báo cáo.', 'success');
      addLog(`Đã lưu báo cáo cho bản in "${print.job_name}": ${labelOf(labels.outcomes, values.outcome)}.`, 'success');
      onSaved();
    } catch (err) {
      showToast(errorText(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form
      layout="vertical"
      onFinish={save}
      initialValues={{ outcome: print.feedback?.outcome, issues: print.feedback?.issues ?? [], note: print.feedback?.note ?? '' }}
    >
      <Form.Item name="outcome" label="Kết quả" rules={[{ required: true, message: 'Hãy chọn kết quả của bản in.' }]}>
        <Radio.Group options={labels.outcomes.map((o) => ({ value: o.id, label: o.label }))} />
      </Form.Item>
      <Form.Item name="issues" label="Vấn đề gặp phải">
        <Checkbox.Group>
          <Row gutter={[8, 4]}>
            {labels.issues.map((i) => (
              <Col key={i.id} xs={24} sm={12}>
                <Checkbox value={i.id}>{i.label}</Checkbox>
              </Col>
            ))}
          </Row>
        </Checkbox.Group>
      </Form.Item>
      <Form.Item name="note">
        <Input.TextArea rows={3} maxLength={4000} placeholder="Ghi chú thêm (không bắt buộc)" />
      </Form.Item>
      <Flex justify="end" gap={8}>
        <Button onClick={onCancel}>Hủy</Button>
        <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
          Lưu báo cáo
        </Button>
      </Flex>
    </Form>
  );
}

/**
 * One print: photos (add and delete), its timelapse with the AI review, the setup Studio sent, the user's report
 * and every setting. `videos` is the history's video listing, or null when it hasn't been read.
 */
export function PrintDetailModal(props: {
  id: string | null;
  name?: string;
  labels: Labels;
  videos: Video[] | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { id, name, labels, videos, onClose, onChanged } = props;
  const { showToast, addLog, confirm } = useActions();
  const [print, setPrint] = useState<PrintDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [video, setVideo] = useState<Video | null>(null);
  const [editing, setEditing] = useState(false);
  const [upload, setUpload] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setPrint((await printsApi<{ print: PrintDetail }>(`/api/prints/${encodeURIComponent(id)}`)).print);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    setPrint(null);
    setError(null);
    setVideo(null);
    setEditing(false);
    setUpload(null);
    load();
  }, [load]);

  // The printer's video of this print, when there is one (GET /api/timelapse pairs them)
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (videos ? Promise.resolve({ videos }) : printsApi<{ videos: Video[] }>('/api/timelapse'))
      .then(({ videos: list }) => !cancelled && setVideo(list.find((v) => v.print?.id === id) ?? null))
      // No timelapse section when the printer can't be read: the rest of the print still shows
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, videos]);

  const changed = async () => {
    await load();
    onChanged();
  };

  // Photos: upload one by one, then reload the print and the list
  const uploadPhotos = async (files: File[]) => {
    if (!print) return;
    let sent = 0;
    try {
      for (const [i, file] of files.entries()) {
        setUpload(`⏳ ${files.length > 1 ? `(${i + 1}/${files.length}) ` : ''}Đang tải ${file.name}...`);
        const form = new FormData();
        form.append('file', file);
        await printsApi(`/api/prints/${encodeURIComponent(print.id)}/photos`, { method: 'POST', body: form });
        sent++;
      }
      addLog(`Đã thêm ${sent} ảnh cho bản in "${print.job_name}".`, 'success');
    } catch (err) {
      showToast(errorText(err), 'error');
    } finally {
      setUpload(null);
    }
    if (sent > 0) await changed();
  };

  const deletePhoto = async (photo: string) => {
    if (!print) return;
    const ok = await confirm({
      title: 'Xóa ảnh?',
      message: `Xóa ảnh ${photo} khỏi bản in "${print.job_name}"? Không thể hoàn tác.`,
      confirmText: 'Xóa ảnh',
      danger: true,
    });
    if (!ok) return;
    try {
      await printsApi(photoUrl(print.id, photo), { method: 'DELETE' });
      addLog(`Đã xóa ảnh ${photo} của bản in "${print.job_name}".`);
      await changed();
    } catch (err) {
      showToast(errorText(err), 'error');
    }
  };

  return (
    <Modal open={!!id} onCancel={onClose} footer={null} width={960} title={print?.job_name ?? name ?? 'Bản in'} destroyOnHidden>
      {error ? (
        <Alert type="error" title={error} />
      ) : !print ? (
        <Spin />
      ) : (
        <Flex vertical gap={4}>
          <Space>
            <StatusTag status={print.status} />
            <Typography.Text type="secondary">{timeRange(print)}</Typography.Text>
          </Space>

          <Divider style={{ margin: '8px 0' }} />
          <Section
            title="Ảnh"
            extra={
              <Upload
                multiple
                accept="image/jpeg,image/png,image/webp"
                showUploadList={false}
                disabled={!!upload}
                beforeUpload={(file, list) => {
                  if (file === list[0]) uploadPhotos(list as File[]);
                  return false;
                }}
              >
                <Button size="small" icon={<CameraOutlined />} loading={!!upload}>
                  Thêm ảnh
                </Button>
              </Upload>
            }
          >
            {upload && <Typography.Text type="secondary">{upload}</Typography.Text>}
            <Photos print={print} onDelete={deletePhoto} />
          </Section>

          {video && (
            <>
              <Divider style={{ margin: '8px 0' }} />
              <Section
                title="Timelapse"
                extra={
                  <Button size="small" icon={<DownloadOutlined />} href={videoUrl(video.name)} download={video.name}>
                    Tải về
                  </Button>
                }
              >
                <video className="timelapse-video" controls playsInline preload="metadata" src={videoUrl(video.name)} />
              </Section>
            </>
          )}
          {/* The review shows with its button beside the video; without the video, the review saved on the print */}
          {(video || print.video_review) && (
            <>
              <Divider style={{ margin: '8px 0' }} />
              {video ? (
                <TimelapseReview video={video} printId={print.id} />
              ) : (
                <Section title="🤖 AI nhận xét timelapse">
                  <ReviewResult review={print.video_review as Review} outcomes={labels.outcomes} issues={labels.issues} />
                </Section>
              )}
            </>
          )}

          <Divider style={{ margin: '8px 0' }} />
          <Section title="Thiết lập khi in">
            <SetupView setup={print.setup} />
          </Section>

          <Divider style={{ margin: '8px 0' }} />
          <Section
            title="Báo cáo kết quả"
            extra={
              !editing && (
                <Button size="small" icon={print.feedback ? <EditOutlined /> : <PlusOutlined />} onClick={() => setEditing(true)}>
                  {print.feedback ? 'Sửa báo cáo' : 'Thêm báo cáo'}
                </Button>
              )
            }
          >
            {editing ? (
              <FeedbackForm
                print={print}
                labels={labels}
                onCancel={() => setEditing(false)}
                onSaved={() => {
                  setEditing(false);
                  changed();
                }}
              />
            ) : (
              <Report feedback={print.feedback} labels={labels} />
            )}
          </Section>

          <Divider style={{ margin: '8px 0' }} />
          <Section title="Setting">
            <SettingsView settings={printSettings(print.setup)} labels={labels} />
          </Section>
        </Flex>
      )}
    </Modal>
  );
}

/** Two prints side by side (older as A), and only the settings that differ */
export function CompareModal({ ids, labels, onClose }: { ids: [string, string] | null; labels: Labels; onClose: () => void }) {
  const [pair, setPair] = useState<[PrintDetail, PrintDetail] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPair(null);
    setError(null);
    if (!ids) return;
    let cancelled = false;
    Promise.all(ids.map((id) => printsApi<{ print: PrintDetail }>(`/api/prints/${encodeURIComponent(id)}`)))
      .then(([{ print: p1 }, { print: p2 }]) => {
        const time = (p: PrintDetail) => Date.parse(p.started_at ?? p.ended_at ?? '') || 0;
        if (!cancelled) setPair(time(p1) <= time(p2) ? [p1, p2] : [p2, p1]);
      })
      .catch((err) => !cancelled && setError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [ids]);

  const diff: { key: string; label: string | null; a: string | null; b: string | null }[] | null = pair
    ? diffSettings(printSettings(pair[0].setup), printSettings(pair[1].setup), labels.settingLabels)
    : null;
  const missing = (value: string | null) => (value === null ? <Typography.Text type="secondary">(không có)</Typography.Text> : value);

  return (
    <Modal open={!!ids} onCancel={onClose} footer={null} width={1000} title="So sánh 2 bản in" destroyOnHidden>
      {error ? (
        <Alert type="error" title={error} />
      ) : !pair ? (
        <Spin />
      ) : (
        <Flex vertical gap={16}>
          <Row gutter={16}>
            {pair.map((print, i) => (
              <Col key={print.id} xs={24} md={12}>
                <Card size="small" title={`${i === 0 ? 'A' : 'B'} · ${print.job_name}`}>
                  <Flex vertical gap={8}>
                    <Space wrap>
                      <StatusTag status={print.status} />
                      <Typography.Text type="secondary">{timeRange(print)}</Typography.Text>
                    </Space>
                    <Typography.Text type="secondary">{print.setup ? print.setup.process_preset : NO_SETUP_TEXT}</Typography.Text>
                    <Photos print={print} />
                    <Report feedback={print.feedback} labels={labels} />
                  </Flex>
                </Card>
              </Col>
            ))}
          </Row>
          <Section title={`Setting khác nhau${diff?.length ? ` (${diff.length})` : ''}`}>
            {!diff ? (
              <Typography.Text type="secondary">
                {NO_SETUP_TEXT}:{' '}
                {pair
                  .filter((p) => !p.setup)
                  .map((p) => `"${p.job_name}"`)
                  .join(' và ')}
                .
              </Typography.Text>
            ) : diff.length === 0 ? (
              <Typography.Text type="secondary">Hai bản in dùng cùng một bộ setting.</Typography.Text>
            ) : (
              <Table
                size="small"
                rowKey="key"
                pagination={false}
                scroll={{ y: 480 }}
                dataSource={diff}
                columns={[
                  { title: 'Setting', key: 'name', width: '40%', render: (_, row) => settingName(row) },
                  { title: 'A', dataIndex: 'a', key: 'a', render: missing },
                  { title: 'B', dataIndex: 'b', key: 'b', render: missing },
                ]}
              />
            )}
          </Section>
        </Flex>
      )}
    </Modal>
  );
}

/** A video whose print is older than the list: played on its own, with its review */
export function TimelapsePlayer({ video, onClose }: { video: Video | null; onClose: () => void }) {
  const { addLog } = useActions();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    if (video) addLog(`Xem timelapse ${video.name}.`);
  }, [video, addLog]);

  return (
    <Modal open={!!video} onCancel={onClose} footer={null} width={960} title={video?.print?.job_name ?? video?.name} destroyOnHidden>
      {video && (
        <Flex vertical gap={12}>
          {failed ? (
            <Alert type="error" title="Không phát được video (máy in không trả lời, hoặc trình duyệt không hỗ trợ định dạng này). Thử Tải về." />
          ) : (
            !loaded && <Typography.Text type="secondary">⏳ Lần đầu xem, gateway đang lấy video từ máy in...</Typography.Text>
          )}
          <video
            className="timelapse-video"
            controls
            autoPlay
            playsInline
            preload="auto"
            src={videoUrl(video.name)}
            onLoadedData={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
          <Flex justify="space-between" align="center" wrap gap={8}>
            <Typography.Text type="secondary">
              {formatPrintTime(video.ended_at)} · {formatSize(video.size)}
              {video.print ? ` · 🖨️ ${video.print.job_name}` : ''}
            </Typography.Text>
            <Button icon={<DownloadOutlined />} href={videoUrl(video.name)} download={video.name}>
              Tải về
            </Button>
          </Flex>
          <Divider style={{ margin: '4px 0' }} />
          <TimelapseReview video={video} />
        </Flex>
      )}
    </Modal>
  );
}
