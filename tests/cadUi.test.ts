import { describe, expect, it } from 'vitest';
import { formatSize, renderJob } from '../src/ui/cad.js';

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
    expect(html).toContain('Đang dựng mô hình · đã dựng 2 lần');
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

  it('escapes text typed by users and agents', () => {
    const html = renderJob({ ...baseJob, prompt: '<img src=x onerror=alert(1)>', notes: ['• <b>x</b>'] });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('• &lt;b&gt;x&lt;/b&gt;');
  });
});
