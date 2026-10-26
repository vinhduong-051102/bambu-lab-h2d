/**
 * Timelapse videos the printer recorded (GET /api/timelapse): their URLs and sizes. The gateway copies a video
 * from the printer the first time it is played, so the first play takes a few seconds.
 */

export const videoUrl = (name) => `/api/timelapse/${encodeURIComponent(name)}`;
export const thumbnailUrl = (name) => `${videoUrl(name)}/thumbnail`;

/** "2,7 MB" */
export function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`;
}
