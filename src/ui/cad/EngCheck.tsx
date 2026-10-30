'use client';

import { DownloadOutlined, ExperimentOutlined, FileTextOutlined, PrinterOutlined } from '@ant-design/icons';
import { Alert, App, AutoComplete, Button, Checkbox, Col, Collapse, Divider, Empty, Flex, Form, Image, Input, List, Modal, Row, Select, Space, Spin, Tag, Typography } from 'antd';
import type { FormInstance } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CALIBRATION_BUILD,
  checkedSettings,
  ENG_STATUS,
  engFileUrl,
  fixKind,
  fixRequest,
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

type Check = {
  id: string;
  status: keyof typeof ENG_STATUS;
  title: string;
  detail?: string;
  kind: string;
  value?: unknown;
  limit?: unknown;
  where?: Record<string, unknown>;
};
type Result = {
  analysis_id: string;
  status: string;
  checks: Check[];
  missing?: string[];
  files?: Record<string, string>;
  inputs?: { print?: Record<string, unknown> | null };
};
/** The check running in the gateway (it goes on when the page closes), or how the last one ended */
type CheckTask = { running: boolean; started_at: string; finished_at: string | null; error: string | null };
type CheckResponse = {
  task?: CheckTask | null;
  report: { analysis_id: string; status: string; finished_at?: string; data?: { sections?: { title: string; status: string; checks: number }[] } } | null;
  results: Record<string, Result>;
};

const STORAGE_KEY = 'eng-print-setup';
const POLL_MS = 3000;

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

/** What the dialog can do about a result: have Claude change the model, build the calibration print, check again
 * with each body as its own part */
type Actions = {
  onFix?: (checks: Check[]) => void;
  onCalibrate: () => void;
  onSplit: () => void;
  busy?: 'calibrate' | 'split' | null;
};

const FIX_LABELS: Record<string, { text: string; title: string }> = {
  claude: { text: 'Nhờ Claude sửa', title: 'Claude sửa mô hình chỗ này và tạo phiên bản mới; bản này giữ nguyên' },
  clearance: { text: 'Nới khe hở', title: 'Claude mở rộng lỗ đúng lượng còn thiếu để lắp quay được' },
  calibrate: { text: 'In mẫu hiệu chuẩn', title: 'Cần biết máy in lỗ nhỏ đi, trục to ra bao nhiêu: tạo mẫu in thử để đo' },
  split: { text: 'Tách thành chi tiết', title: 'Kiểm tra lại, coi mỗi khối rời là một chi tiết riêng (kiểm tra cả lắp ghép giữa chúng)' },
};

function CheckList({ checks, actions, selected, onSelect }: { checks: Check[]; actions?: Actions; selected?: Set<string>; onSelect?: (id: string, on: boolean) => void }) {
  return (
    <List
      size="small"
      dataSource={checks}
      renderItem={(c) => {
        const kind = actions ? fixKind(c) : null;
        const toClaude = kind === 'claude' || kind === 'clearance';
        const usable = kind && (!toClaude || actions?.onFix);
        const label = kind ? FIX_LABELS[kind] : null;
        const run = () => {
          if (kind === 'calibrate') actions?.onCalibrate();
          else if (kind === 'split') actions?.onSplit();
          else actions?.onFix?.([c]);
        };
        return (
          <List.Item
            actions={
              usable && label
                ? [
                    <Button
                      key="fix"
                      size="small"
                      type={toClaude ? 'primary' : 'default'}
                      ghost={toClaude}
                      title={label.title}
                      loading={(kind === 'calibrate' && actions?.busy === 'calibrate') || (kind === 'split' && actions?.busy === 'split')}
                      onClick={run}
                    >
                      {label.text}
                    </Button>,
                  ]
                : undefined
            }
          >
            <Space align="start">
              {toClaude && usable && onSelect ? (
                <Checkbox checked={selected?.has(c.id)} onChange={(e) => onSelect(c.id, e.target.checked)} aria-label={`Chọn ${c.title}`} />
              ) : null}
              <StatusTag status={c.status} />
              <span>
                <Typography.Text strong>{c.title}</Typography.Text>
                {c.detail ? <Typography.Text type="secondary"> · {c.detail}</Typography.Text> : null}
              </span>
            </Space>
          </List.Item>
        );
      }}
    />
  );
}

function Results({ data, actions }: { data: CheckResponse; actions: Actions }) {
  const checks = sortedChecks(data.results) as Check[];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const picked = checks.filter((c) => selected.has(c.id));
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
      {urgent.length > 0 ? (
        <>
          <Flex justify="space-between" align="center" wrap gap={8}>
            <Typography.Text strong>Cần xử lý</Typography.Text>
            {actions.onFix && (
              <Button
                size="small"
                type="primary"
                disabled={!picked.length}
                onClick={() => actions.onFix?.(picked)}
                title="Gửi các mục đã đánh dấu cho Claude trong một lần sửa"
              >
                Nhờ Claude sửa {picked.length ? `${picked.length} mục đã chọn` : 'các mục đã chọn'}
              </Button>
            )}
          </Flex>
          <CheckList checks={urgent} actions={actions} selected={selected} onSelect={toggle} />
        </>
      ) : (
        <Typography.Text type="secondary">Không có mục không đạt hay cần xem.</Typography.Text>
      )}
      {rest.length > 0 && (
        <Collapse size="small" items={[{ key: 'rest', label: `Chưa đánh giá và đạt (${rest.length})`, children: <CheckList checks={rest} actions={actions} /> }]} />
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
/** Builds the tolerance calibration print as a design job (it then shows in the list, ready for Studio) */
function useCalibrationPrint() {
  const { message } = App.useApp();
  const [building, setBuilding] = useState(false);
  const build = async () => {
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
  return [building, build] as const;
}

function PrintSetup({ form, measured, onMeasured }: { form: FormInstance; measured: boolean; onMeasured: (on: boolean) => void }) {
  const [building, buildCalibration] = useCalibrationPrint();

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

/**
 * `onRevise` sends a request to Claude the way the card's "Sửa" does (a new version of the model); without it the
 * results show no "Nhờ Claude sửa" buttons
 */
export function EngCheckButton({ job, onRevise }: { job: CadJob; onRevise?: (comment: string) => Promise<boolean> }) {
  const { message } = App.useApp();
  const [request, setRequest] = useState<string | null>(null);
  const [sendingFix, setSendingFix] = useState(false);
  // Each separate body checked as its own part (fits between them too); kept until the dialog closes
  const [split, setSplit] = useState(false);
  const [calibrating, buildCalibration] = useCalibrationPrint();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CheckResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  // When the running check started (it may have been started before the page was opened again)
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm<Record<string, string>>();
  const [measured, setMeasured] = useState(false);

  // Set while this page watches a check run, to say when it is done
  const watching = useRef(false);

  // The latest check and the one running (started here, or before the page was opened again)
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/eng/checks/${encodeURIComponent(job.id)}`, { cache: 'no-store' });
      const body = (await res.json()) as (CheckResponse & { success?: boolean }) | null;
      setData(body?.success && body.report ? body : null);
      const task = body?.task;
      setRunning(Boolean(task?.running));
      setStartedAt(task?.running ? task.started_at : null);
      if (task && !task.running) {
        setError(task.error);
        if (watching.current && !task.error) message.success('Đã kiểm tra xong');
        watching.current = false;
      }
    } catch {
      setData(null);
    }
  }, [job.id, message]);

  useEffect(() => {
    if (!open) return;
    const saved = remembered();
    form.setFieldsValue(saved.values);
    setMeasured(saved.measured);
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [open, form, load]);

  // A running check is read again until it ends
  useEffect(() => {
    if (!open || !running) return;
    watching.current = true;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, running, load]);

  const run = async (splitBodies = split) => {
    const values = form.getFieldsValue();
    remember(values, measured);
    setRunning(true);
    setError(null);
    let goesOn = false;
    try {
      const res = await fetch('/api/eng/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: job.id, name: job.title || job.id, print: printConfig(values, measured), split_bodies: splitBodies }),
      });
      const body = await res.json().catch(() => null);
      // Still running: it goes on in the gateway, read until it ends (also after the page is opened again)
      if (res.status === 202 && body?.running) {
        setStartedAt(body.task?.started_at ?? null);
        watching.current = goesOn = true;
        return;
      }
      if (!res.ok || !body?.success) {
        const details = Array.isArray(body?.details) ? body.details.map((d: { path: string; message: string }) => `${d.path}: ${d.message}`).join('; ') : '';
        throw new Error(`${body?.message || `HTTP ${res.status}`}${details ? ` (${details})` : ''}`);
      }
      setData(body);
      message.success('Đã kiểm tra xong');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!goesOn) setRunning(false);
    }
  };

  // The request is written from the checks and the print setup the check used, and shown for the user to edit
  const askFix = (checks: Check[]) => setRequest(fixRequest(checks, checkedSettings(data?.results) ?? printConfig(form.getFieldsValue(), measured)));

  const sendFix = async () => {
    if (!onRevise || !request?.trim()) return;
    setSendingFix(true);
    try {
      if (await onRevise(request.trim())) {
        message.success('Đã gửi cho Claude: bản sửa sẽ hiện thành phiên bản mới của mô hình này. Kiểm tra lại bản mới khi xong.', 8);
        setRequest(null);
        setOpen(false);
      }
    } finally {
      setSendingFix(false);
    }
  };

  const actions: Actions = {
    onFix: onRevise ? askFix : undefined,
    onCalibrate: buildCalibration,
    onSplit: () => {
      setSplit(true);
      void run(true);
    },
    busy: calibrating ? 'calibrate' : running && split ? 'split' : null,
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
          <Space wrap>
            <Button type="primary" icon={<ExperimentOutlined />} loading={running} onClick={() => run()}>
              {running ? 'Đang kiểm tra… (~20 s)' : 'Chạy kiểm tra'}
            </Button>
            <Checkbox checked={split} onChange={(e) => setSplit(e.target.checked)}>
              Coi mỗi khối rời là một chi tiết riêng (kiểm tra cả lắp ghép giữa chúng)
            </Checkbox>
          </Space>
          {running && startedAt && (
            <Alert
              type="info"
              showIcon
              title={`Đang kiểm tra từ ${new Date(startedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`}
              description="Đóng trang hay hộp thoại này thì việc kiểm tra vẫn chạy tiếp; mở lại để xem kết quả."
            />
          )}
          {error && <Alert type="error" showIcon title={error} />}
          <Divider style={{ margin: '4px 0' }} />
          {loading ? <Spin /> : data ? <Results data={data} actions={actions} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa kiểm tra mô hình này" />}
        </Flex>
      </Modal>
      <Modal
        open={request !== null}
        onCancel={() => setRequest(null)}
        title="Nhờ Claude sửa mô hình"
        okText="Gửi cho Claude"
        cancelText="Thôi"
        confirmLoading={sendingFix}
        onOk={sendFix}
        width={720}
      >
        <Typography.Paragraph type="secondary">
          Lời nhắn viết sẵn từ kết quả kiểm tra; sửa thêm nếu muốn. Claude tạo một phiên bản mới, bản này giữ nguyên.
          Claude chỉ sửa hình dạng mô hình; thông số in (số vỏ, infill…) vẫn chọn trong Bambu Studio.
        </Typography.Paragraph>
        <Input.TextArea value={request ?? ''} onChange={(e) => setRequest(e.target.value)} autoSize={{ minRows: 6, maxRows: 16 }} />
      </Modal>
    </>
  );
}
