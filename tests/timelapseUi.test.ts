import { describe, it, expect } from 'vitest';
import { formatSize, renderTimelapseTile, thumbnailUrl, videoUrl } from '../src/ui/timelapse.js';

describe('timelapse card helpers', () => {
  it('builds the video and thumbnail URLs', () => {
    expect(videoUrl('video_2026-10-12_00-32-49.mp4')).toBe('/api/timelapse/video_2026-10-12_00-32-49.mp4');
    expect(thumbnailUrl('a b.mp4')).toBe('/api/timelapse/a%20b.mp4/thumbnail');
  });

  it('shows sizes in megabytes', () => {
    expect(formatSize(2754523)).toBe('2,6 MB');
  });

  it('renders a tile with its print, escaping the job name', () => {
    const html = renderTimelapseTile({
      name: 'video_2026-10-13_02-33-28.mp4',
      size: 2754523,
      ended_at: '2026-10-12T20:21:00.000Z',
      has_thumbnail: true,
      print: { id: 'x', job_name: '<b>Plate</b>', status: 'finished' },
    });
    expect(html).toContain('/api/timelapse/video_2026-10-13_02-33-28.mp4/thumbnail');
    expect(html).toContain('&lt;b&gt;Plate&lt;/b&gt;');
    expect(html).not.toContain('<b>Plate</b>');
  });

  it('says when a video has no print yet', () => {
    const html = renderTimelapseTile({ name: 'v.mp4', size: 1, ended_at: null, has_thumbnail: false, print: null });
    expect(html).toContain('Chưa ghép với bản in nào');
    expect(html).toContain('timelapse-thumb-empty');
  });
});
