'use client';

import { ExperimentOutlined, FileTextOutlined, DownloadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Checkbox, Col, Collapse, Divider, Empty, Flex, Form, Image, Input, List, Modal, Row, Space, Spin, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { ENG_STATUS, engFileUrl, missingData, PRINT_FIELDS, printConfig, sortedChecks, statusCounts } from '../eng';
import type { CadJob } from './CadJob';

/**
 * "Kiểm tra kỹ thuật" of a finished design job (docs/engineering-analysis.md): its model.stl checked by the mesh
 * worker for the print setup the user types (remembered in this browser): mesh, walls, printability, a Blender
 * render of the wall thickness, and the report. FEA and motion need loads, supports and joints: through Claude (MCP).
 */

type Check = { id: string; status: keyof typeof ENG_STATUS; title: string; detail?: string; kind: string };
type Result = { analysis_id: string; status: string; checks: Check[]; missing?: string[]; files?: Record<string, string> };
type CheckResponse = {
  report: { analysis_id: string; status: string; finished_at?: string; data?: { sections?: { title: string; status: string; checks: number }[] } } | null;
  results: Record<string, Result>;
};

const STORAGE_KEY = 'eng-print-setup';

function remembered(): { values: Record<string, string>; measured: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && typeof saved === 'object') return { values: saved.values ?? {}, measured: Boolean(saved.measured) };
  } catch {
    // No storage (private window): the form starts empty
  }
  return { values: { printer: 'Bambu Lab H2D' }, measured: false };
}

function remember(values: Record<string, string>, measured: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ values, measured }));
  } catch {
    // Not kept: the next check starts from the defaults
  }
}

const StatusTag = ({ status }: { status: string }) => {
  const s = ENG_STATUS[status as keyof typeof ENG_STATUS] ?? { color: 'default', text: status };
  return <Tag color={s.color}>{s.text}</Tag>;
};

function CheckList({ checks }: { checks: Check[] }) {
  return (
    <List
      size="small"
      dataSource={checks}
      renderItem={(c) => (
        <List.Item>
          <Space align="start">
            <StatusTag status={c.status} />
            <span>
              <Typography.Text strong>{c.title}</Typography.Text>
              {c.detail ? <Typography.Text type="secondary"> · {c.detail}</Typography.Text> : null}
            </span>
          </Space>
        </List.Item>
      )}
    />
  );
}

function Results({ data }: { data: CheckResponse }) {
  const checks = sortedChecks(data.results) as Check[];
  const counts = statusCounts(checks);
  const urgent = checks.filter((c) => c.status === 'FAIL' || c.status === 'WARNING');
  const rest = checks.filter((c) => c.status === 'NOT_EVALUATED' || c.status === 'PASS');
  const render = data.results.visualize;
  const missing = missingData(data.results);
  const report = data.report;

  return (
    <Flex vertical gap={12}>
      <Space wrap>
        {report && <StatusTag status={report.status} />}
        <Typography.Text type="secondary">
          {counts.FAIL} không đạt · {counts.WARNING} cần xem · {counts.NOT_EVALUATED} chưa đánh giá · {counts.PASS} đạt
          {report?.finished_at ? ` · ${new Date(report.finished_at).toLocaleString('vi-VN')}` : ''}
        </Typography.Text>
      </Space>
      <Row gutter={[12, 12]}>
        {render?.files?.['result.png'] && (
          <Col xs={24} md={12}>
            <Image src={engFileUrl(render.analysis_id, 'result.png')} alt="Độ dày thành" />
          </Col>
        )}
        <Col xs={24} md={render?.files?.['result.png'] ? 12 : 24}>
          <List
            size="small"
            header={<Typography.Text strong>Các mục của báo cáo</Typography.Text>}
            dataSource={report?.data?.sections ?? []}
            renderItem={(s) => (
              <List.Item>
                <Space>
                  <StatusTag status={s.status} />
                  {s.title}
                </Space>
              </List.Item>
            )}
          />
          <Space wrap style={{ marginTop: 8 }}>
            {report && (
              <Button size="small" icon={<FileTextOutlined />} href={engFileUrl(report.analysis_id, 'report.html')} target="_blank" rel="noopener noreferrer">
                Báo cáo đầy đủ
              </Button>
            )}
            {render?.files?.['result.blend'] && (
              <Button size="small" icon={<DownloadOutlined />} href={engFileUrl(render.analysis_id, 'result.blend')}>
                Blender
              </Button>
            )}
          </Space>
        </Col>
      </Row>
      {missing.length > 0 && (
        <Alert
          type="info"
          showIcon
          title="Còn thiếu để đánh giá đủ"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          }
        />
      )}
      {urgent.length > 0 ? <CheckList checks={urgent} /> : <Typography.Text type="secondary">Không có mục không đạt hay cần xem.</Typography.Text>}
      {rest.length > 0 && (
        <Collapse size="small" items={[{ key: 'rest', label: `Chưa đánh giá và đạt (${rest.length})`, children: <CheckList checks={rest} /> }]} />
      )}
    </Flex>
  );
}

export function EngCheckButton({ job }: { job: CadJob }) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CheckResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm<Record<string, string>>();
  const [measured, setMeasured] = useState(false);

  useEffect(() => {
    if (!open) return;
    const saved = remembered();
    form.setFieldsValue(saved.values);
    setMeasured(saved.measured);
    setLoading(true);
    fetch(`/api/eng/checks/${encodeURIComponent(job.id)}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((body) => setData(body?.success && body.report ? body : null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [open, job.id, form]);

  const run = async () => {
    const values = form.getFieldsValue();
    remember(values, measured);
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/eng/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: job.id, name: job.title || job.id, print: printConfig(values, measured) }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        const details = Array.isArray(body?.details) ? body.details.map((d: { path: string; message: string }) => `${d.path}: ${d.message}`).join('; ') : '';
        throw new Error(`${body?.message || `HTTP ${res.status}`}${details ? ` (${details})` : ''}`);
      }
      setData(body);
      message.success('Đã kiểm tra xong');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <Button size="small" icon={<ExperimentOutlined />} onClick={() => setOpen(true)} title="Kiểm tra lưới, độ dày thành và khả năng in theo thông số in của bạn, kèm báo cáo">
        Kiểm tra kỹ thuật
      </Button>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        title={`Kiểm tra kỹ thuật · ${job.title || job.id}`}
        width={980}
        footer={null}
        destroyOnHidden
        // The rows' gutters reach a few pixels past the body: no horizontal scrollbar for them
        styles={{ body: { overflowX: 'hidden' } }}
      >
        <Flex vertical gap={12}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Kiểm tra lưới, độ dày thành và khả năng in của model.stl theo thông số in dưới đây. Ô để trống là chưa biết:
            mục cần nó sẽ là “chưa đánh giá”, không đoán. Sai số lấy từ mẫu in hiệu chuẩn (docs/cad.md). Độ bền (FEA) và
            chuyển động cần tải, chỗ ngàm và khớp: nhờ Claude qua MCP.
          </Typography.Paragraph>
          <Form form={form} layout="vertical" size="small">
            <Row gutter={12}>
              {PRINT_FIELDS.map((f) => (
                <Col key={f.key} xs={12} md={6}>
                  <Form.Item name={f.key} label={f.label} style={{ marginBottom: 8 }}>
                    <Input placeholder={f.placeholder ?? (f.calibration ? 'đo bằng mẫu in' : '')} suffix={f.unit} inputMode={f.type === 'number' ? 'decimal' : undefined} />
                  </Form.Item>
                </Col>
              ))}
            </Row>
            <Checkbox checked={measured} onChange={(e) => setMeasured(e.target.checked)}>
              Sai số đã đo bằng mẫu in hiệu chuẩn trên máy, vật liệu và thông số này
            </Checkbox>
          </Form>
          <Space>
            <Button type="primary" icon={<ExperimentOutlined />} loading={running} onClick={run}>
              {running ? 'Đang kiểm tra… (~20 s)' : 'Chạy kiểm tra'}
            </Button>
          </Space>
          {error && <Alert type="error" showIcon title={error} />}
          <Divider style={{ margin: '4px 0' }} />
          {loading ? <Spin /> : data ? <Results data={data} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa kiểm tra mô hình này" />}
        </Flex>
      </Modal>
    </>
  );
}
