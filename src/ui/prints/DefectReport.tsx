'use client';

import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { AutoComplete, Button, Card, Col, Flex, Form, Input, InputNumber, Radio, Row, Select, Tag, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { labelOf, type Label } from './badges';
import type { ObjectParts } from './ModelParts';
import { PlateMap, worstByObject, type PlateObject } from './PlateMap';

/**
 * The report's defects, pinned down one by one: which object of the plate, which part of it (by the names
 * "Thành phần" gave its parts, or the user's own words), where on that part, what went wrong and how badly.
 * "AI tối ưu" reads them against the parts of later plates (modelParts.defectsOn).
 */

export interface Defect {
  object: string;
  part: string;
  area: string;
  issue: string;
  severity: string;
  height_mm?: number | null;
  detail: string;
}

export interface DefectLabels {
  issues: Label[];
  areas?: Label[];
  severities?: Label[];
}

const SEVERITY_COLORS: Record<string, string> = { minor: 'gold', major: 'orange', critical: 'red' };

/** What a defect's form row holds before it is sent */
export const toDefect = (d: Partial<Defect>): Defect => ({
  object: d.object?.trim() ?? '',
  part: d.part?.trim() ?? '',
  area: d.area ?? 'whole',
  issue: d.issue ?? '',
  severity: d.severity ?? 'major',
  height_mm: typeof d.height_mm === 'number' ? d.height_mm : null,
  detail: d.detail?.trim() ?? '',
});

/** The named parts of each object, as "Thành phần" measured them so far (none when they were not measured) */
function useParts(printId: string, enabled: boolean): Record<string, string[]> {
  const [parts, setParts] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch(`/api/prints/${encodeURIComponent(printId)}/parts`)
      .then((res) => res.json())
      .then((data: { objects?: ObjectParts[] }) => {
        if (!live) return;
        setParts(Object.fromEntries((data.objects ?? []).map((o) => [o.name, (o.analysis?.components ?? []).map((c) => c.name)])));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [printId, enabled]);
  return parts;
}

/** The defect rows of the report form (a Form.List named "defects") */
export function DefectFields({
  printId,
  plate,
  labels,
}: {
  printId: string;
  /** The objects on the plate that printed, with their footprints when Studio sent them */
  plate: { objects: PlateObject[]; bed?: [number, number] };
  labels: DefectLabels;
}) {
  const objects = plate.objects.map((o) => o.name);
  const parts = useParts(printId, objects.length > 0);
  const form = Form.useFormInstance();
  const rows: Partial<Defect>[] = Form.useWatch('defects', form) ?? [];
  const list = useRef<HTMLDivElement>(null);
  // The defect a click on the map fills: the one being edited, else a new one
  const [active, setActive] = useState<number | null>(null);
  const scrollTo = (i: number) =>
    setTimeout(() => list.current?.querySelectorAll('.defect-card')[i]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  const options = (list: Label[] | undefined) => (list ?? []).map((o) => ({ value: o.id, label: o.label }));
  const allParts = [...new Set(Object.values(parts).flat())];

  return (
    <Form.List name="defects">
      {(fields, { add, remove }) => (
        <Flex vertical gap={8} ref={list}>
          {objects.length > 0 && (
            <>
              <Typography.Text type="secondary">Bấm vào chi tiết trên plate để báo lỗi cho nó.</Typography.Text>
              <PlateMap
                objects={plate.objects}
                bed={plate.bed}
                marks={worstByObject(rows)}
                selected={active != null ? rows[active]?.object : null}
                onPick={(name) => {
                  const i = active != null && active < fields.length && !rows[active]?.object ? active : rows.findIndex((r) => !r?.object);
                  if (i >= 0) {
                    form.setFieldValue(['defects', i, 'object'], name);
                    form.setFieldValue(['defects', i, 'part'], '');
                    setActive(i);
                    scrollTo(i);
                  } else {
                    add({ object: name, severity: 'major' });
                    setActive(fields.length);
                    scrollTo(fields.length);
                  }
                }}
              />
            </>
          )}
          {fields.map((field, i) => {
            const object = rows[i]?.object ?? '';
            const named = (object ? parts[object] : allParts) ?? [];
            return (
              <Card
                key={field.key}
                size="small"
                className="defect-card"
                title={`Lỗi ${i + 1}${object ? ` · #${objects.indexOf(object) + 1} ${object}` : ''}`}
                style={active === i ? { borderColor: '#1677ff' } : undefined}
                onFocusCapture={() => setActive(i)}
                onClick={() => setActive(i)}
                extra={
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    title="Bỏ lỗi này"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(field.name);
                      setActive(null);
                    }}
                  />
                }
              >
                <Row gutter={[8, 0]}>
                  <Col xs={24} sm={12}>
                    <Form.Item name={[field.name, 'object']} label="Vật thể">
                      {objects.length ? (
                        <Select
                          allowClear
                          placeholder="Vật thể nào trên plate"
                          options={objects.map((name, n) => ({ value: name, label: `#${n + 1} ${name}` }))}
                          onChange={() => form.setFieldValue(['defects', field.name, 'part'], '')}
                        />
                      ) : (
                        <Input placeholder="Tên vật thể (không bắt buộc)" maxLength={200} />
                      )}
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={12}>
                    <Form.Item
                      name={[field.name, 'part']}
                      label="Bộ phận"
                      tooltip="Tên bộ phận trong mục Thành phần, hoặc tự ghi (vd. ngàm cài, chân đế, chữ nổi)"
                    >
                      <AutoComplete
                        allowClear
                        placeholder={named.length ? 'Chọn hoặc tự ghi' : 'Tự ghi (vd. ngàm cài, chân đế)'}
                        options={named.map((name) => ({ value: name }))}
                        filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
                        maxLength={120}
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={12}>
                    <Form.Item name={[field.name, 'area']} label="Vị trí trên bộ phận" rules={[{ required: true, message: 'Lỗi ở phần nào của bộ phận?' }]}>
                      <Select placeholder="Thành bên, mặt trên, lớp đầu..." options={options(labels.areas)} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={12}>
                    <Form.Item name={[field.name, 'issue']} label="Lỗi gì" rules={[{ required: true, message: 'Hãy chọn loại lỗi.' }]}>
                      <Select showSearch optionFilterProp="label" placeholder="Loại lỗi" options={options(labels.issues)} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={12}>
                    <Form.Item name={[field.name, 'severity']} label="Mức độ">
                      <Radio.Group optionType="button" buttonStyle="solid" size="small" options={options(labels.severities)} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={12}>
                    <Form.Item name={[field.name, 'height_mm']} label="Từ độ cao" tooltip="Lỗi bắt đầu cách bàn in khoảng bao nhiêu mm, nếu biết">
                      <InputNumber min={0} max={1000} step={0.5} suffix="mm" placeholder="không rõ" style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col xs={24}>
                    <Form.Item name={[field.name, 'detail']} label="Mô tả" style={{ marginBottom: 0 }}>
                      <Input maxLength={500} placeholder="vd. góc trái phía trước cong lên ~2 mm, lệch 1 mm theo trục X" />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>
            );
          })}
          <Button
            type="dashed"
            icon={<PlusOutlined />}
            onClick={() => {
              add({ object: objects.length === 1 ? objects[0] : undefined, severity: 'major' });
              setActive(fields.length);
            }}
          >
            Thêm lỗi theo chi tiết
          </Button>
        </Flex>
      )}
    </Form.List>
  );
}

/** The defects of a saved report */
export function DefectList({ defects, labels }: { defects: Defect[] | undefined; labels: DefectLabels }) {
  if (!defects?.length) return null;
  return (
    <Flex vertical gap={6} style={{ margin: '8px 0' }}>
      {defects.map((d, i) => (
        <div key={i} className="defect-line">
          <Flex wrap gap={4} align="center">
            <Typography.Text strong>{[d.object, d.part].filter(Boolean).join(' › ') || 'Không rõ vật thể'}</Typography.Text>
            <Tag>{labelOf(labels.areas ?? [], d.area)}</Tag>
            {d.height_mm != null && <Tag>từ ~{d.height_mm} mm</Tag>}
          </Flex>
          <Flex wrap gap={4} align="center" style={{ marginTop: 2 }}>
            <Tag color={SEVERITY_COLORS[d.severity] ?? 'default'}>{labelOf(labels.severities ?? [], d.severity)}</Tag>
            <Typography.Text>{labelOf(labels.issues, d.issue)}</Typography.Text>
            {d.detail && <Typography.Text type="secondary">— {d.detail}</Typography.Text>}
          </Flex>
        </div>
      ))}
    </Flex>
  );
}
