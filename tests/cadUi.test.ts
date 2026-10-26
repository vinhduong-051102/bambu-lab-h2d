import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatDuration, formatSize, jobSteps } from '../src/ui/cad.js';
import { CadJobCard } from '../src/ui/cad/CadJob';

const renderJob = (job: any) => renderToStaticMarkup(createElement(CadJobCard, { job, now: Date.parse('2026-10-23T09:16:00Z') }));
const button = (label: string) => `<span>${label}</span></button>`;

const baseJob = {
  id: '20261023-091502-a1b2',
  prompt: 'Hộp vuông cạnh 10 mm',
  source: 'claude',
  model: 'claude-opus-5-5',
  parent_id: null,
  title: null,
  created_at: '2026-10-23T09:15:02.000Z',
  sent: [],
  state: 'running',
  step: 'building',
  notes: ['• Đang dựng hộp'],
  builds: 2,
  started_at: null,
  finished_at: null,
  error: null,
  result: null,
  report: null,
  files: { code: true, stl: false, step: false, preview: false },
};

describe('AI modelling UI helpers', () => {
  it('formats a size in millimetres', () => {
    expect(formatSize([60, 40.25, 20])).toBe('60 × 40,3 × 20 mm');
    expect(formatSize(undefined)).toBeNull();
  });

  it('shows a running job with its step, notes and a cancel button only', () => {
    const html = renderJob(baseJob);
    expect(html).toContain('Dựng mô hình · đã dựng 2 lần');
    expect(html).toContain('• Đang dựng hộp');
    expect(html).toContain(button('Hủy'));
    expect(html).not.toContain('Gửi sang Studio');
    expect(html).not.toContain(button('Sửa'));
  });

  it('offers Studio, downloads and revising for a finished job', () => {
    const html = renderJob({
      ...baseJob,
      state: 'done',
      title: 'Hộp vuông',
      finished_at: '2026-10-23T09:20:00Z',
      report: { ok: true, size_mm: [10, 10, 10], volume_cm3: 1, mesh: { watertight: true }, warnings: ['Nhô ra 50°'] },
      files: { code: true, stl: true, step: true, preview: true },
    });
    expect(html).toContain('Gửi sang Studio');
    expect(html).toContain('files/model.stl?v=2026-10-23T09%3A20%3A00Z&amp;download=1');
    expect(html).toContain('10 × 10 × 10 mm · 1 cm³ · lưới kín');
    expect(html).toContain('⚠️ Nhô ra 50°');
    expect(html).toContain(button('Sửa'));
    expect(html).not.toContain(button('Hủy'));
  });

  it('shows a figure with its picture, "make again" and Claude\'s review instead of code', () => {
    const html = renderJob({
      ...baseJob,
      source: 'mesh',
      model: 'hunyuan3d-2mini-turbo',
      state: 'done',
      step: null,
      notes: [],
      result: { title: 'Mèo', summary: 'Dựng từ ảnh', assumptions: [], parameters: [{ name: 'height_mm', value: 80, description: 'Cao' }], warnings: [] },
      report: { ok: true, size_mm: [40, 35, 80], mesh: { watertight: true }, warnings: [] },
      files: { code: false, stl: true, step: false, preview: true, concept: true },
    });
    expect(html).toContain('Hunyuan3D');
    expect(html).toContain('files/concept.png');
    expect(html).toContain('🎲 Tạo lại');
    expect(html).toContain('>Chi tiết<');
    // "Revise" on a figure is Claude's review, which may go without words
    expect(html).toContain('Claude review &amp; sửa');
    expect(html).not.toContain('files/model.py');
    expect(html).not.toContain('model.step');
  });

  it('shows Claude\'s fix of a figure with what it found, its six views and code, and no "make again"', () => {
    const html = renderJob({
      ...baseJob,
      source: 'mesh',
      model: 'claude-sonnet-5-5',
      parent_id: '20261023-090136-0359',
      input: 'fix',
      state: 'done',
      step: null,
      notes: [],
      result: {
        title: 'Goku',
        summary: 'Đã đắp lại hai bàn chân',
        assumptions: [],
        parameters: [],
        warnings: [],
        issues: [
          { problem: 'Chân cụt ở mắt cá', fixed: true, how: 'Đắp hai chiếc giày <ellipsoid>' },
          { problem: 'Mặt bị phẳng', fixed: false, how: 'Nên tạo lại từ ảnh khác' },
        ],
      },
      report: { ok: true, size_mm: [60, 60, 83], mesh: { watertight: true }, warnings: [] },
      files: { code: false, stl: true, step: false, preview: true, concept: true, fix: true, views: true },
    });
    expect(html).toContain('Claude sửa · sonnet 5.5');
    expect(html).toContain('bản sửa');
    expect(html).toContain('Claude đã xem (1/2 lỗi đã sửa)');
    expect(html).toContain('class="cad-issue is-fixed">✓ <b>Chân cụt ở mắt cá</b>: Đắp hai chiếc giày &lt;ellipsoid&gt;');
    expect(html).toContain('class="cad-issue is-open">✗ <b>Mặt bị phẳng</b>');
    expect(html).toContain('files/views.png');
    expect(html).toContain('files/fix.py');
    expect(html).toContain('Claude review &amp; sửa');
    expect(html).not.toContain('🎲 Tạo lại');
  });

  it('shows a running review as Claude\'s steps, with no figure steps ahead', () => {
    const job = {
      ...baseJob,
      source: 'mesh',
      input: 'fix',
      step: 'building',
      steps: [{ id: 'building', started_at: '2026-10-23T09:15:02.000Z', finished_at: null, detail: 'Lần chạy 1' }],
    };
    const steps = jobSteps(job, Date.parse('2026-10-23T09:15:12.000Z'));
    expect(steps.map((s: any) => [s.kind, s.detail, s.took])).toEqual([['current', 'Lần chạy 1', '10 giây']]);
    expect(renderJob(job)).toContain(button('Hủy'));
  });

  it('lets a queued figure be cancelled and names its step', () => {
    const html = renderJob({ ...baseJob, source: 'mesh', step: 'loading', builds: 0, notes: [] });
    expect(html).toContain('Nạp model dựng hình vào GPU');
    expect(html).toContain(button('Hủy'));
  });

  it('formats durations in Vietnamese', () => {
    expect(formatDuration(8000)).toBe('8 giây');
    expect(formatDuration(125000)).toBe('2 phút 5 giây');
    expect(formatDuration(120000)).toBe('2 phút');
  });

  it('draws a running figure as done steps with their time, the current one with progress, and those ahead', () => {
    const now = Date.parse('2026-10-23T06:00:30Z');
    const steps = jobSteps(
      {
        ...baseJob,
        source: 'mesh',
        input: 'prompt',
        step: 'imaging',
        progress: { done: 12, total: 25, unit: 'bước' },
        steps: [
          { id: 'queued', started_at: '2026-10-23T06:00:00Z', finished_at: '2026-10-23T06:00:01Z', detail: null },
          { id: 'prompting', started_at: '2026-10-23T06:00:01Z', finished_at: '2026-10-23T06:00:09Z', detail: 'Haiku viết prompt' },
          { id: 'imaging', started_at: '2026-10-23T06:00:10Z', finished_at: null, detail: 'HunyuanDiT vẽ ảnh 1024 × 1024' },
        ],
      },
      now
    );
    expect(steps.map((s: any) => [s.kind, s.label, s.took])).toEqual([
      ['done', 'Chờ GPU', '1 giây'],
      ['done', 'Claude viết prompt ảnh', '8 giây'],
      ['current', 'Vẽ ảnh từ mô tả', '20 giây'],
      // Ahead, without the model loading steps that only happen when a model is not in memory
      ['ahead', 'Tách nền ảnh', ''],
      ['ahead', 'Dựng hình 3D từ ảnh', ''],
      ['ahead', 'Sửa lưới, chỉnh kích thước', ''],
      ['ahead', 'Kiểm tra lưới, vẽ ảnh xem trước', ''],
    ]);
    expect(steps[2].progress).toEqual({ done: 12, total: 25, unit: 'bước' });
  });

  it('marks failed builds that Claude fixed, and the step a failed job stopped at', () => {
    const steps = [
      { id: 'building', started_at: '2026-10-23T06:00:00Z', finished_at: '2026-10-23T06:00:03Z', detail: 'Lần dựng 1: ✗ NameError' },
      { id: 'building', started_at: '2026-10-23T06:00:10Z', finished_at: '2026-10-23T06:00:13Z', detail: 'Lần dựng 2: ✓ 60 × 40 × 20 mm' },
      { id: 'finishing', started_at: '2026-10-23T06:00:20Z', finished_at: null, detail: null },
    ];
    const items = jobSteps({ ...baseJob, state: 'failed', steps }, Date.parse('2026-10-23T06:00:25Z'));
    expect(items.map((s: any) => [s.kind, s.label, s.took])).toEqual([
      ['retry', 'Dựng mô hình', '3 giây'],
      ['done', 'Dựng mô hình', '3 giây'],
      ['failed', 'Xuất file', '5 giây'],
    ]);
  });

  it('folds the timeline of a finished job into a summary with its total time', () => {
    const html = renderJob({
      ...baseJob,
      state: 'done',
      finished_at: '2026-10-23T06:01:00Z',
      steps: [{ id: 'starting', started_at: '2026-10-23T06:00:00Z', finished_at: '2026-10-23T06:00:05Z', detail: null }],
    });
    expect(html).toContain('Các bước (1, 1 phút)');
  });

  it('escapes text typed by users and agents', () => {
    const html = renderJob({ ...baseJob, prompt: '<img src=x onerror=alert(1)>', notes: ['• <b>x</b>'] });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('• &lt;b&gt;x&lt;/b&gt;');
  });
});
