'use client';

import { DownloadOutlined } from '@ant-design/icons';
import { Alert, Button, Collapse, Descriptions, Flex, Image, Table, Tag, Typography } from 'antd';
import { fileUrl } from '../cad';
import type { CadJob } from './CadJob';
import { CircuitDiagram } from './CircuitDiagram';
import { CadViewerButton, hasSplitViews } from './TextToCad';

/**
 * "⚡ Mạch điện" on a model with electronics (cad/circuit.py, docs/cad.md "Mạch điện tử"): what the check found,
 * the wiring diagram, the modules and wires to buy, each net and the simulation's voltages, and Claude's notes on
 * wiring it. The modules and wires themselves are in the CAD Viewer, with the case, and each on its own (SplitViews).
 */

export type Circuit = NonNullable<CadJob['circuit']>;
export type Electronics = { summary: string; wiring: string[]; extra_parts: string[]; safety: string[] };

const LEVEL = {
  error: { colour: 'red', label: 'Lỗi' },
  warning: { colour: 'orange', label: 'Cảnh báo' },
  info: { colour: 'blue', label: 'Lưu ý' },
} as const;
const KIND = { gnd: 'GND', supply: 'Nguồn pin', power: 'Nguồn', signal: 'Tín hiệu' } as const;

const volts = (v: number | undefined) => (v == null ? '—' : `${v.toFixed(2)} V`);
const amps = (a: number) => (a >= 1 ? `${a.toFixed(2)} A` : `${Math.round(a * 1000)} mA`);

/** "⚡ Mạch điện: 1 lỗi · 2 cảnh báo · pin ~11 giờ" */
export function circuitHeadline(circuit: Circuit): string {
  const count = (level: 'error' | 'warning') => circuit.erc.filter((e) => e.level === level).length;
  const errors = count('error');
  const warnings = count('warning') + circuit.fit.length;
  const hours = Object.values(circuit.simulation.battery).map((b) => b.hours);
  return [
    `⚡ Mạch điện: ${Object.keys(circuit.parts).length} module`,
    errors ? `${errors} lỗi` : null,
    warnings ? `${warnings} cảnh báo` : null,
    !errors && !warnings ? 'không thấy lỗi' : null,
    hours.length ? `pin ~${Math.min(...hours)} giờ` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The two halves of the model (cad/build.py split_views): its electronics and its printed case, each drawn, to
 * download (GLB, STEP) and to open alone in the CAD Viewer */
function SplitViews({ job }: { job: CadJob }) {
  const halves = [
    { key: 'electronics', title: 'Chỉ mạch điện', note: 'module, dây, mạch mua sẵn' },
    { key: 'case', title: 'Chỉ vỏ', note: 'các chi tiết in' },
  ] as const;
  return (
    <Flex gap={12} wrap>
      {halves
        .filter((h) => job.files?.[h.key])
        .map((h) => (
          <Flex key={h.key} vertical gap={6} style={{ flex: '1 1 260px', minWidth: 0 }}>
            <Typography.Text strong>
              {h.title} <Typography.Text type="secondary">({h.note})</Typography.Text>
            </Typography.Text>
            <Image src={fileUrl(job, `${h.key}.png`)} alt={h.title} style={{ maxHeight: 260, objectFit: 'contain', background: '#fff' }} />
            <Flex gap={6} wrap>
              <Button size="small" icon={<DownloadOutlined />} href={fileUrl(job, `${h.key}.glb`, true)}>
                GLB
              </Button>
              <Button size="small" icon={<DownloadOutlined />} href={fileUrl(job, `${h.key}.step`, true)}>
                STEP
              </Button>
              <CadViewerButton job={job} view={h.key} label="🧭 Xem riêng" />
            </Flex>
          </Flex>
        ))}
    </Flex>
  );
}

export function CircuitPanel({ job, circuit, electronics }: { job: CadJob; circuit: Circuit; electronics?: Electronics | null }) {
  const sim = circuit.simulation;
  const avg = sim.cases?.avg;
  const peak = sim.cases?.peak;
  const findings = [...circuit.erc, ...circuit.fit.map((text) => ({ level: 'warning' as const, text }))];
  const nets = Object.entries(circuit.nets).map(([net, n]) => {
    const power = n.kind !== 'signal' ? n.pins.find((p) => avg?.pins[p] != null && n.kind !== 'gnd') : undefined;
    return {
      key: net,
      net,
      kind: n.kind,
      colour: n.colour,
      pins: n.pins.join(', '),
      length: n.length_mm,
      avg: power ? avg?.pins[power] : undefined,
      peak: power ? peak?.pins[power] : undefined,
    };
  });

  return (
    <Collapse
      size="small"
      defaultActiveKey={findings.some((f) => f.level === 'error') ? ['circuit'] : []}
      items={[
        {
          key: 'circuit',
          label: circuitHeadline(circuit),
          children: (
            <Flex vertical gap={10}>
              {electronics?.summary && <Typography.Paragraph style={{ margin: 0 }}>{electronics.summary}</Typography.Paragraph>}
              {findings.length > 0 && (
                <Flex vertical gap={2}>
                  {findings.map((f, i) => (
                    <div key={i}>
                      <Tag color={LEVEL[f.level].colour}>{LEVEL[f.level].label}</Tag>
                      {f.text}
                    </div>
                  ))}
                </Flex>
              )}
              {!sim.ok && sim.error && <Alert type="warning" showIcon title={`Không mô phỏng được: ${sim.error}`} />}
              {Object.keys(circuit.parts).length > 0 && <CircuitDiagram job={job} circuit={circuit} />}
              {hasSplitViews(job) && <SplitViews job={job} />}
              {Object.entries(sim.battery).map(([part, b]) => (
                <Descriptions
                  key={part}
                  size="small"
                  column={{ xs: 1, sm: 2, md: 4 }}
                  items={[
                    { key: 'pack', label: 'Pin', children: `${part}: ${b.cells} × ${b.mah} mAh` },
                    { key: 'avg', label: 'Dòng trung bình', children: amps(b.current_a) },
                    { key: 'peak', label: 'Dòng đỉnh', children: peak?.batteries[part] ? amps(peak.batteries[part].current_a) : '—' },
                    { key: 'hours', label: 'Thời gian chạy', children: `~${b.hours} giờ (dùng 80 % dung lượng)` },
                  ]}
                />
              ))}
              {avg && Object.keys(avg.regulators).length > 0 && (
                <Table
                  size="small"
                  pagination={false}
                  // Narrow screens scroll the table instead of pushing it out of the card
                  scroll={{ x: 'max-content' }}
                  rowKey="part"
                  dataSource={Object.entries(avg.regulators).map(([part, r]) => ({ part, ...r, peak: peak?.regulators[part] }))}
                  columns={[
                    { title: 'Bộ ổn áp', dataIndex: 'part' },
                    { title: 'Vào', render: (_, r) => volts(r.vin) },
                    { title: 'Ra', render: (_, r) => volts(r.vout) },
                    { title: 'Dòng ra TB / đỉnh', render: (_, r) => `${amps(r.iout)} / ${r.peak ? amps(r.peak.iout) : '—'}` },
                    { title: 'Tỏa nhiệt', render: (_, r) => `${r.loss_w} W` },
                  ]}
                />
              )}
              <Table
                size="small"
                pagination={false}
                scroll={{ x: 'max-content' }}
                dataSource={nets}
                columns={[
                  {
                    title: 'Net',
                    render: (_, n) => (
                      <span>
                        <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: n.colour, marginRight: 6 }} />
                        {n.net}
                      </span>
                    ),
                  },
                  { title: 'Loại', render: (_, n) => KIND[n.kind] },
                  { title: 'Chân', dataIndex: 'pins' },
                  { title: 'Điện áp TB / đỉnh', render: (_, n) => (n.avg != null ? `${volts(n.avg)} / ${volts(n.peak)}` : '') },
                  { title: 'Dây', render: (_, n) => (n.length ? `${Math.round(n.length)} mm` : '') },
                ]}
              />
              <Table
                size="small"
                pagination={false}
                scroll={{ x: 'max-content' }}
                rowKey="key"
                dataSource={circuit.bom}
                columns={[
                  { title: 'Cần mua', dataIndex: 'name' },
                  { title: 'Số lượng', render: (_, b) => (b.length_mm != null ? `${(b.length_mm / 1000).toFixed(2)} m` : b.count) },
                  { title: '', render: (_, b) => b.parts?.join(', ') ?? b.note },
                ]}
              />
              {electronics && (electronics.wiring.length > 0 || electronics.extra_parts.length > 0 || electronics.safety.length > 0) && (
                <Flex vertical gap={4}>
                  {electronics.wiring.length > 0 && (
                    <div>
                      <Typography.Text strong>Cách đấu dây</Typography.Text>
                      <ol style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                        {electronics.wiring.map((step, i) => (
                          <li key={i}>{step}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {electronics.extra_parts.length > 0 && (
                    <Typography.Text>
                      <b>Linh kiện thêm (không có trong mô phỏng):</b> {electronics.extra_parts.join('; ')}
                    </Typography.Text>
                  )}
                  {electronics.safety.map((s, i) => (
                    <Typography.Text key={i} type="warning">
                      ⚠️ {s}
                    </Typography.Text>
                  ))}
                </Flex>
              )}
              <Typography.Text type="secondary">
                Kích thước module là loại phổ biến trên thị trường: đo module thật trước khi in vỏ khít. Mở 🧭 CAD Viewer để xem module và dây trong vỏ (tách rời, cắt, đo), hoặc chọn ▾ Chỉ mạch điện / Chỉ vỏ để xem riêng từng phần.
              </Typography.Text>
            </Flex>
          ),
        },
      ]}
    />
  );
}
