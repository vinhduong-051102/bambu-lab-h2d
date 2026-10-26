import { describe, expect, it } from 'vitest';
import { formatDuration, formatSize, renderJob, renderSteps } from '../src/ui/cad.js';

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
    expect(html).toContain('data-action="cancel"');
    expect(html).not.toContain('data-action="studio"');
    expect(html).not.toContain('data-action="revise"');
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
    expect(html).toContain('data-action="studio"');
    expect(html).toContain('files/model.stl?v=2026-10-23T09%3A20%3A00Z&amp;download=1');
    expect(html).toContain('10 × 10 × 10 mm · 1 cm³ · lưới kín');
    expect(html).toContain('⚠️ Nhô ra 50°');
    expect(html).toContain('data-action="revise"');
    expect(html).not.toContain('data-action="cancel"');
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
    expect(html).toContain('data-action="again"');
    expect(html).toContain('<summary>Chi tiết</summary>');
    // "Revise" on a figure is Claude's review, which may go without words
    expect(html).toContain('🔍 Claude review &amp; sửa');
    expect(html).toContain('data-kind="fix"');
    expect(html).toContain('Gửi Claude review');
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
    expect(html).toContain('data-action="revise"');
    expect(html).not.toContain('data-action="again"');
  });

  it('shows a running review as Claude\'s steps, with no figure steps ahead', () => {
    const job = {
      ...baseJob,
      source: 'mesh',
      input: 'fix',
      step: 'building',
      steps: [{ id: 'building', started_at: '2026-10-23T09:15:02.000Z', finished_at: null, detail: 'Lần chạy 1' }],
    };
    const html = renderSteps(job, Date.parse('2026-10-23T09:15:12.000Z'));
    expect(html).toContain('Lần chạy 1');
    expect(html).not.toContain('is-ahead');
    expect(renderJob(job)).toContain('data-action="cancel"');
  });

  it('lets a queued figure be cancelled and names its step', () => {
    const html = renderJob({ ...baseJob, source: 'mesh', step: 'loading', builds: 0, notes: [] });
    expect(html).toContain('Nạp model dựng hình vào GPU');
    expect(html).toContain('data-action="cancel"');
  });

  it('formats durations in Vietnamese', () => {
    expect(formatDuration(8000)).toBe('8 giây');
    expect(formatDuration(125000)).toBe('2 phút 5 giây');
    expect(formatDuration(120000)).toBe('2 phút');
  });

  it('draws a running figure as done steps with their time, the current one with progress, and those ahead', () => {
    const now = Date.parse('2026-10-23T06:00:30Z');
    const html = renderSteps(
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
    expect(html).toMatch(/is-done[\s\S]*Claude viết prompt ảnh[\s\S]*8 giây/);
    expect(html).toMatch(/is-current[\s\S]*Vẽ ảnh từ mô tả[\s\S]*12\/25 bước · 48%[\s\S]*width:48\.0%[\s\S]*20 giây/);
    // Ahead, without the model loading steps that only happen when a model is not in memory
    expect(html).toMatch(/is-ahead[\s\S]*Tách nền ảnh[\s\S]*Dựng hình 3D từ ảnh[\s\S]*Sửa lưới[\s\S]*Kiểm tra lưới/);
    expect(html).not.toContain('Nạp model vẽ ảnh');
  });

  it('marks failed builds that Claude fixed, and the step a failed job stopped at', () => {
    const steps = [
      { id: 'building', started_at: '2026-10-23T06:00:00Z', finished_at: '2026-10-23T06:00:03Z', detail: 'Lần dựng 1: ✗ NameError' },
      { id: 'building', started_at: '2026-10-23T06:00:10Z', finished_at: '2026-10-23T06:00:13Z', detail: 'Lần dựng 2: ✓ 60 × 40 × 20 mm' },
      { id: 'finishing', started_at: '2026-10-23T06:00:20Z', finished_at: null, detail: null },
    ];
    const html = renderSteps({ ...baseJob, state: 'failed', steps }, Date.parse('2026-10-23T06:00:25Z'));
    expect(html).toMatch(/is-retry[\s\S]*Lần dựng 1: ✗ NameError/);
    expect(html).toMatch(/is-done[\s\S]*Lần dựng 2/);
    expect(html).toMatch(/is-failed[\s\S]*Xuất file[\s\S]*5 giây/);
  });

  it('folds the timeline of a finished job into a summary with its total time', () => {
    const html = renderJob({
      ...baseJob,
      state: 'done',
      finished_at: '2026-10-23T06:01:00Z',
      steps: [{ id: 'starting', started_at: '2026-10-23T06:00:00Z', finished_at: '2026-10-23T06:00:05Z', detail: null }],
    });
    expect(html).toContain('<summary>Các bước (1, 1 phút)</summary>');
  });

  it('escapes text typed by users and agents', () => {
    const html = renderJob({ ...baseJob, prompt: '<img src=x onerror=alert(1)>', notes: ['• <b>x</b>'] });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('• &lt;b&gt;x&lt;/b&gt;');
  });
});
