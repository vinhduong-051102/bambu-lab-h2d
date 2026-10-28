'use client';

import { DownloadOutlined, ExperimentOutlined, FileTextOutlined, PrinterOutlined } from '@ant-design/icons';
import { Alert, App, AutoComplete, Button, Checkbox, Col, Collapse, Divider, Empty, Flex, Form, Image, Input, List, Modal, Row, Select, Space, Spin, Tag, Typography } from 'antd';
import type { FormInstance } from 'antd';
import { useEffect, useState } from 'react';
import {
  CALIBRATION_BUILD,
  ENG_STATUS,
  engFileUrl,
  missingData,
  PRINT_FIELDS,
  PRINT_GROUPS,
  PRINT_PRESETS,
  printConfig,
  sortedChecks,
  statusCounts,
} from '../eng';
import type { CadJob } from './CadJob';
import { PrintIllustration } from './PrintIllustration';

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

type PrintField = (typeof PRINT_FIELDS)[number] & { placeholder?: string; typical?: string; options?: string[]; unit?: string };

/** One setting: its picture, what it means in plain words, the usual value, and a box with values to pick from */
function SettingCard({ field }: { field: PrintField }) {
  return (
    <div className="print-setting">
      <div className="print-setting-pic">
        <PrintIllustration name={field.picture} />
      </div>
      <Flex vertical gap={2} style={{ minWidth: 0, flex: 1 }}>
        <Typography.Text strong>{field.label}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {field.help}
        </Typography.Text>
        {field.typical && (
          <Typography.Text style={{ fontSize: 12, color: '#60a5fa' }}>
            {field.typical}
          </Typography.Text>
        )}
        <Form.Item name={field.key} style={{ margin: '4px 0 0' }}>
          <AutoComplete
            options={(field.options ?? []).map((value) => ({ value }))}
            placeholder={field.placeholder ?? (field.calibration ? 'chưa đo: để trống' : 'chưa biết: để trống')}
            allowClear
            style={{ width: '100%' }}
          >
            <Input suffix={field.unit} inputMode={field.type === 'number' ? 'decimal' : undefined} />
          </AutoComplete>
        </Form.Item>
      </Flex>
    </div>
  );
}

/** The print setup, grouped: machine and material, the slicer settings (with Bambu Studio's standard profiles one
 * click away), and the printer's own accuracy, measured on the calibration print this button builds */
function PrintSetup({ form, measured, onMeasured }: { form: FormInstance; measured: boolean; onMeasured: (on: boolean) => void }) {
  const { message } = App.useApp();
  const [building, setBuilding] = useState(false);

  const buildCalibration = async () => {
    setBuilding(true);
    try {
      const res = await fetch('/api/cad/builds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(CALIBRATION_BUILD),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
      message.success('Đã tạo mẫu in hiệu chuẩn: nó nằm trong danh sách mô hình, bấm “Gửi sang Studio” để in.', 8);
    } catch (err) {
      message.error(`Không tạo được mẫu in: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBuilding(false);
    }
  };

  return (
    <Flex vertical gap={14}>
      {PRINT_GROUPS.map((group) => (
        <section key={group.key} className="print-group">
          <Flex justify="space-between" align="center" wrap gap={8}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              {group.title}
            </Typography.Title>
            {group.key === 'settings' && (
              <Select
                size="small"
                placeholder="Dùng hồ sơ chuẩn…"
                style={{ minWidth: 300 }}
                value={null}
                options={PRINT_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
                onChange={(key) => {
                  const preset = PRINT_PRESETS.find((p) => p.key === key);
                  if (preset) form.setFieldsValue(preset.values);
                }}
              />
            )}
            {group.key === 'calibration' && (
              <Button size="small" icon={<PrinterOutlined />} loading={building} onClick={buildCalibration}>
                Tạo mẫu in hiệu chuẩn
              </Button>
            )}
          </Flex>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 8px' }}>
            {group.help}
          </Typography.Paragraph>
          <div className="print-settings">
            {(PRINT_FIELDS as PrintField[])
              .filter((f) => f.group === group.key)
              .map((f) => (
                <SettingCard key={f.key} field={f} />
              ))}
          </div>
          {group.key === 'calibration' && (
            <Checkbox checked={measured} onChange={(e) => onMeasured(e.target.checked)} style={{ marginTop: 8 }}>
              Các số trên đo từ mẫu in thử, in cùng máy, cùng nhựa và cùng thông số với chi tiết thật
            </Checkbox>
          )}
        </section>
      ))}
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
            Máy sẽ xem mô hình có lỗi không, chỗ nào quá mỏng, chỗ nào cần support, lỗ có vừa không, rồi viết báo cáo.
            Điền những gì bạn biết; <b>ô để trống là “chưa biết”</b>, mục cần nó sẽ ghi “chưa đánh giá” chứ không đoán.
          </Typography.Paragraph>
          <Form form={form} layout="vertical" size="small">
            <PrintSetup form={form} measured={measured} onMeasured={setMeasured} />
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
