import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatSize, thumbnailUrl, videoUrl } from '../src/ui/timelapse.js';
import { historyItems } from '../src/ui/prints.js';
import { PrintRow, VideoRow } from '../src/ui/prints/rows';

const renderVideoRow = (v: any) => renderToStaticMarkup(createElement(VideoRow, { video: v }));
const renderPrintRow = (p: any, options: any = {}) => renderToStaticMarkup(createElement(PrintRow, { print: p, ...options }));

const video = (name: string, ended_at: string | null, print: { id: string; job_name: string } | null = null) => ({
  name,
  size: 2754523,
  ended_at,
  has_thumbnail: true,
  print: print && { ...print, status: 'finished' },
});
const print = (id: string, times: { started_at?: string | null; ended_at?: string | null }, status = 'finished') => ({
  id,
  job_name: id,
  started_at: times.started_at ?? null,
  ended_at: times.ended_at ?? null,
  status,
  photos: [],
});

describe('timelapse helpers', () => {
  it('builds the video and thumbnail URLs', () => {
    expect(videoUrl('video_2026-10-12_00-32-49.mp4')).toBe('/api/timelapse/video_2026-10-12_00-32-49.mp4');
    expect(thumbnailUrl('a b.mp4')).toBe('/api/timelapse/a%20b.mp4/thumbnail');
  });

  it('shows sizes in megabytes', () => {
    expect(formatSize(2754523)).toBe('2,6 MB');
  });

  it('renders a video row with its print, escaping the job name', () => {
    const html = renderVideoRow(video('video_2026-10-13_02-33-28.mp4', '2026-10-12T20:21:00.000Z', { id: 'x', job_name: '<b>Plate</b>' }));
    expect(html).toContain('/api/timelapse/video_2026-10-13_02-33-28.mp4/thumbnail');
    expect(html).toContain('&lt;b&gt;Plate&lt;/b&gt;');
    expect(html).not.toContain('<b>Plate</b>');
  });

  it('shows a placeholder when the video has no thumbnail', () => {
    const html = renderVideoRow({ ...video('v.mp4', null, { id: 'x', job_name: 'x' }), has_thumbnail: false });
    expect(html).not.toContain('<img');
    expect(html).toContain('<span aria-hidden="true">🎬</span>');
  });
});

describe('print history with the videos', () => {
  it('puts each video on its print, the ones of older prints by when they ended, and hides the unpaired', () => {
    const prints = [
      print('now', { started_at: '2026-10-20T10:00:00Z' }, 'printing'),
      print('b', { started_at: '2026-10-15T06:00:00Z', ended_at: '2026-10-15T08:40:00Z' }),
      print('a', { started_at: '2026-10-10T06:00:00Z', ended_at: '2026-10-10T08:00:00Z' }),
    ];
    const videos = [
      video('v-b.mp4', '2026-10-15T08:42:00Z', { id: 'b', job_name: 'b' }),
      video('v-lone.mp4', '2026-10-12T20:21:00Z'),
      // Its print is older than the list
      video('v-old.mp4', '2026-09-01T00:00:00Z', { id: 'gone', job_name: 'gone' }),
    ];
    const rows = historyItems(prints, videos, Date.parse('2026-10-20T11:00:00Z'));
    expect(rows.map((r) => r.print?.id ?? r.video?.name)).toEqual(['now', 'b', 'a', 'v-old.mp4']);
    expect(rows[1].video?.name).toBe('v-b.mp4');
    expect(rows[0].video).toBeNull();
  });

  it('marks a print that has a video, using its thumbnail when there is no photo', () => {
    const html = renderPrintRow(print('b', {}), { video: video('v b.mp4', null, { id: 'b', job_name: 'b' }) });
    expect(html).toContain('🎬 Video');
    expect(html).toContain('/api/timelapse/v%20b.mp4/thumbnail');
    expect(renderPrintRow(print('b', {}))).not.toContain('🎬');
  });
});
