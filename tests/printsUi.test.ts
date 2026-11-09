import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { diffSettings, formatPrintTime, listSettings, orderSettingKeys, printSettings } from '../src/ui/prints.js';
import { DefectList } from '../src/ui/prints/DefectReport';
import { ObjectCard } from '../src/ui/prints/ModelParts';
import { layoutPlate, PlateMap, printedObjects, worstByObject } from '../src/ui/prints/PlateMap';
import { PrintRow } from '../src/ui/prints/rows';

const labels = { layer_height: 'Chiều cao lớp', sparse_infill_density: 'Mật độ infill' };

describe('print history UI helpers', () => {
  it('formats times as dd/mm HH:MM in local time', () => {
    const d = new Date(2026, 9, 5, 7, 3);
    expect(formatPrintTime(d.toISOString())).toBe('05/10 07:03');
    expect(formatPrintTime(null)).toBe('—');
    expect(formatPrintTime('not a date')).toBe('—');
  });

  it('lists the filament settings after the process settings', () => {
    const setup = {
      settings: { layer_height: '0.2' },
      filaments: [{ preset: 'PLA', settings: { nozzle_temperature: '220,230' } }, { preset: 'PETG' }],
    };
    expect(printSettings(setup)).toEqual({ layer_height: '0.2', 'filament#1:nozzle_temperature': '220,230' });
    expect(printSettings(null)).toBeNull();
  });

  it('orders labelled keys first, then the rest alphabetically', () => {
    expect(orderSettingKeys(['z_key', 'sparse_infill_density', 'a_key', 'layer_height'], labels)).toEqual([
      'layer_height',
      'sparse_infill_density',
      'a_key',
      'z_key',
    ]);
  });

  it('diffs only the settings that differ, per-extruder vectors as strings', () => {
    const a = { layer_height: '0.2', sparse_infill_density: '15%', wall_loops: '2', nozzle_temperature: '220,220', only_a: '1' };
    const b = { layer_height: '0.2', sparse_infill_density: '20%', wall_loops: '2', nozzle_temperature: '220,230' };
    expect(diffSettings(a, b, labels)).toEqual([
      { key: 'sparse_infill_density', label: 'Mật độ infill', a: '15%', b: '20%' },
      { key: 'nozzle_temperature', label: null, a: '220,220', b: '220,230' },
      { key: 'only_a', label: null, a: '1', b: null },
    ]);
    expect(diffSettings(a, null, labels)).toBeNull();
    expect(diffSettings(a, { ...a }, labels)).toEqual([]);
  });

  it('lists labelled settings by default and filters the full list', () => {
    const settings = { layer_height: '0.2', wall_loops: '2', sparse_infill_pattern: 'gyroid' };
    expect(listSettings(settings, labels).map((r: { key: string }) => r.key)).toEqual(['layer_height']);
    expect(listSettings(settings, labels, { all: true }).map((r: { key: string }) => r.key)).toEqual([
      'layer_height',
      'sparse_infill_pattern',
      'wall_loops',
    ]);
    expect(listSettings(settings, labels, { all: true, filter: 'GYRO' }).map((r: { key: string }) => r.key)).toEqual([
      'sparse_infill_pattern',
    ]);
    expect(listSettings(null, labels)).toEqual([]);
  });

  it('renders a list row with escaped text and badges', () => {
    const html = renderToStaticMarkup(
      createElement(PrintRow, {
        print: {
        id: 'p1',
        job_name: '<b>Hộp</b>',
        started_at: null,
        ended_at: null,
        status: 'finished',
        process_preset: '0.20mm "Standard"',
        filaments: [],
        ai_session_id: 'abc',
        photos: [{ name: 'end.jpg', source: 'camera', taken_at: '2026-10-01T00:00:00Z' }],
        feedback_outcome: 'usable',
        },
        outcomes: [{ id: 'usable', label: 'Có lỗi nhưng dùng được' }],
      })
    );
    expect(html).toContain('&lt;b&gt;Hộp&lt;/b&gt;');
    expect(html).not.toContain('<b>Hộp');
    expect(html).toContain('0.20mm &quot;Standard&quot;');
    expect(html).toContain('/api/prints/p1/photos/end.jpg');
    expect(html).toContain('Hoàn thành');
    expect(html).toContain('Có lỗi nhưng dùng được');
    expect(html).toContain('>AI<');
  });
});

describe('defects of a report', () => {
  it('shows each defect as object › part, where on it, how bad and what', () => {
    const labels = {
      issues: [{ id: 'layer_shift', label: 'Lệch lớp' }],
      areas: [{ id: 'side', label: 'Thành bên' }],
      severities: [{ id: 'critical', label: 'Hỏng' }],
    };
    const defects = [{ object: 'Bracket.stl', part: 'ngàm cài', area: 'side', issue: 'layer_shift', severity: 'critical', height_mm: 12, detail: 'lệch 1 mm' }];
    const out = renderToStaticMarkup(createElement(DefectList, { defects, labels }));
    for (const text of ['Bracket.stl › ngàm cài', 'Thành bên', 'từ ~12 mm', 'Hỏng', 'Lệch lớp', 'lệch 1 mm']) expect(out).toContain(text);
    expect(renderToStaticMarkup(createElement(DefectList, { defects: [], labels }))).toBe('');
  });
});

describe('plate map', () => {
  const square = (x: number, y: number, s: number): [number, number][] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];

  it('draws the footprints Studio sent where they were, y towards the back', () => {
    const objects = [
      { name: 'Gear.stl', footprint: square(10, 10, 20) },
      { name: 'Arm.stl', footprint: square(200, 250, 40) },
    ];
    const plate = layoutPlate(objects, [350, 320]);
    expect(plate.real).toBe(true);
    expect(plate.shapes.map((s) => s.centre)).toEqual([[20, 20], [220, 270]]);
    const out = renderToStaticMarkup(createElement(PlateMap, { objects, bed: [350, 320], marks: { 'Arm.stl': 'critical' } }));
    // The gear at the front is low in the picture
    expect(out).toContain('points="10.0,310.0 30.0,310.0 30.0,290.0 10.0,290.0"');
    expect(out).toContain('#f5222d');
    expect(out).not.toContain('Vị trí minh hoạ');
    expect(out).toContain('#2 Arm.stl');
  });

  it('draws the true outline with its holes when Studio sent one', () => {
    const outer: [number, number][] = [[0, 0], [40, 0], [40, 40], [0, 40]];
    const hole: [number, number][] = [[15, 15], [15, 25], [25, 25], [25, 15]];
    const objects = [{ name: 'Gear.stl', footprint: outer, outline: [outer, hole] }];
    expect(layoutPlate(objects).shapes[0].rings).toHaveLength(2);
    const out = renderToStaticMarkup(createElement(PlateMap, { objects, bed: [350, 320] }));
    expect(out).toContain('fill-rule="evenodd"');
    expect(out).toContain('d="M0.0,320.0L40.0,320.0L40.0,280.0L0.0,280.0ZM15.0,305.0L15.0,295.0L25.0,295.0L25.0,305.0Z"');
  });

  it('lays out objects without footprints in rows by size, every one on the bed, and says so', () => {
    const objects = Array.from({ length: 12 }, (_, i) => ({ name: `P${i}.stl`, size_mm: [100, 90, 10] }));
    const plate = layoutPlate(objects, [350, 320]);
    expect(plate.real).toBe(false);
    const ys = plate.shapes.flatMap((s) => s.points.map((p) => p[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(plate.bed[1]);
    expect(plate.bed[1]).toBeGreaterThan(320);
    expect(renderToStaticMarkup(createElement(PlateMap, { objects }))).toContain('Vị trí minh hoạ');
  });

  it('keeps the objects of the plate that printed, and the worst defect of each', () => {
    const objects = [{ name: 'A', plate: 1 }, { name: 'B', plate: 2 }];
    expect(printedObjects(objects, 2).map((o) => o.name)).toEqual(['B']);
    expect(printedObjects([{ name: 'A' }], 2).map((o) => o.name)).toEqual(['A']);
    expect(worstByObject([{ object: 'A', severity: 'minor' }, { object: 'A', severity: 'critical' }, { object: 'B' }, { severity: 'minor' }])).toEqual({ A: 'critical', B: 'major' });
  });
});

describe("parts of a print's objects", () => {
  const feature = (id: string, text: string) => ({ id, kind: 'thin_wall', count: 1, colour: '#e6194b', text });
  const html = (object: Parameters<typeof ObjectCard>[0]['object']) => renderToStaticMarkup(createElement(ObjectCard, { object }));

  it('shows the renders, the named parts with their measures, and the parts left unnamed', () => {
    const out = html({
      name: 'Plate07.stl',
      status: 'done',
      analysis: {
        key: 'a'.repeat(32),
        file: 'Plate07.stl',
        matched: true,
        features: [feature('F1', 'Thành mỏng: dày 0.6 mm'), feature('F2', 'Lỗ: Ø3 mm đứng')],
        description: 'Bốn mâm bánh xe.',
        components: [{ name: 'vành mâm', role: 'vành ngoài', features: ['F1'], risk: 'dễ tách lớp' }],
        named_by: 'claude-opus-5-5',
      },
    });
    expect(out).toContain(`/api/studio/parts/${'a'.repeat(32)}/parts.png`);
    expect(out).toContain('vành mâm');
    expect(out).toContain('Thành mỏng: dày 0.6 mm');
    expect(out).toContain('dễ tách lớp');
    expect(out).toContain('Thành phần khác');
    expect(out).toContain('Lỗ: Ø3 mm đứng');
  });

  it('says why there are no parts', () => {
    expect(html({ name: 'X.stl', status: 'missing', analysis: null })).toContain('Không thấy file lưới');
    expect(html({ name: 'X.stl', status: 'pending', analysis: null })).toContain('Chưa đo');
    expect(html({ name: 'X.stl', status: 'done', analysis: { key: 'b', file: 'X.stl', matched: false, reason: 'lệch', features: [] } })).toContain('Không khớp được hướng đặt');
  });
});
