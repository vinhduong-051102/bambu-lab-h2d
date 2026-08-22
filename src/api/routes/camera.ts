import { FastifyInstance } from 'fastify';
import { BambuCameraService } from '../../bambu/BambuCameraService.js';

function createFallbackSvg(info: ReturnType<BambuCameraService['getCameraInfo']>): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
    <rect width="640" height="360" fill="#0f172a"/>
    <rect x="20" y="20" width="600" height="320" rx="12" fill="#1e293b" stroke="#334155" stroke-width="2"/>
    <circle cx="320" cy="140" r="40" fill="none" stroke="#38bdf8" stroke-width="3" opacity="0.6"/>
    <path d="M305 140 A15 15 0 0 1 335 140" fill="none" stroke="#38bdf8" stroke-width="3"/>
    <text x="320" y="210" font-family="sans-serif" font-size="18" font-weight="bold" fill="#f8fafc" text-anchor="middle">Bambu Lab Camera Stream</text>
    <text x="320" y="235" font-family="sans-serif" font-size="13" fill="#94a3b8" text-anchor="middle">RTSPS URL: ${info.rtspsUrl322}</text>
    <text x="320" y="260" font-family="sans-serif" font-size="12" fill="#64748b" text-anchor="middle">(Bật LAN Mode Liveview trên màn hình máy in để phát Camera)</text>
  </svg>`;
}

export async function cameraRoutes(
  fastify: FastifyInstance,
  options: { cameraService: BambuCameraService }
): Promise<void> {
  const { cameraService } = options;

  // 1. Camera Info Endpoint
  fastify.get('/api/camera/info', async () => {
    return cameraService.getCameraInfo();
  });

  // 2. Camera Snapshot Endpoint
  fastify.get('/api/camera/snapshot', async (request, reply) => {
    const frame = cameraService.getLatestFrame();
    if (frame) {
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      return reply.send(frame);
    }

    // Fallback SVG if frame is not available yet
    const info = cameraService.getCameraInfo();
    reply.header('Content-Type', 'image/svg+xml');
    reply.header('Cache-Control', 'no-cache');
    return reply.send(createFallbackSvg(info));
  });

  // 3. Camera MJPEG Stream Endpoint
  fastify.get('/api/camera/mjpeg', (request, reply) => {
    const frame = cameraService.getLatestFrame();

    reply.raw.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'close',
      'Pragma': 'no-cache',
    });

    if (frame) {
      reply.raw.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      reply.raw.write(frame);
      reply.raw.write('\r\n');
    }

    const onFrame = (newFrame: Buffer) => {
      try {
        reply.raw.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${newFrame.length}\r\n\r\n`);
        reply.raw.write(newFrame);
        reply.raw.write('\r\n');
      } catch (err) {
        cameraService.off('frame', onFrame);
      }
    };

    cameraService.on('frame', onFrame);

    request.raw.on('close', () => {
      cameraService.off('frame', onFrame);
    });
  });
}
