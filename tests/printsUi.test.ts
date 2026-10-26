import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { diffSettings, formatPrintTime, listSettings, orderSettingKeys, printSettings } from '../src/ui/prints.js';
import { ObjectCard } from '../src/ui/prints/ModelParts';
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
