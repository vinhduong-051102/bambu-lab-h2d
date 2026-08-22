import { FastifyInstance } from 'fastify';
import { BambuCameraService } from '../../bambu/BambuCameraService.js';

export async function cameraRoutes(
  fastify: FastifyInstance,
  options: { cameraService: BambuCameraService }
): Promise<void> {
  const { cameraService } = options;

  // 1. GET /api/camera/status (Requirement 9)
  fastify.get('/api/camera/status', async () => {
    return cameraService.getStatus();
  });

  // Backward compatibility alias for info
  fastify.get('/api/camera/info', async () => {
    return cameraService.getStatus();
  });

  // 2. GET /api/camera/snapshot (Requirement 8)
  fastify.get('/api/camera/snapshot', async (request, reply) => {
    const frame = cameraService.getLatestFrame();
    if (frame) {
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      return reply.send(frame);
    }

    return reply.status(503).send({
      error: 'camera_frame_not_available',
      message: 'No JPEG camera frame decoded yet from RTSP stream',
    });
  });

  // 3. GET /api/camera/mjpeg (Requirement 7)
  fastify.get('/api/camera/mjpeg', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'close',
      'Pragma': 'no-cache',
    });

    const sendFrame = (frameBuf: Buffer) => {
      try {
        reply.raw.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuf.length}\r\n\r\n`);
        reply.raw.write(frameBuf);
        reply.raw.write('\r\n');
      } catch (err) {
        cleanup();
      }
    };

    // Send initial frame if available
    const initialFrame = cameraService.getLatestFrame();
    if (initialFrame) {
      sendFrame(initialFrame);
    }

    const onFrame = (newFrame: Buffer) => {
      sendFrame(newFrame);
    };

    const cleanup = () => {
      cameraService.off('frame', onFrame);
    };

    cameraService.on('frame', onFrame);

    request.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);
  });

  // 4. POST /api/camera/reconnect
  fastify.post('/api/camera/reconnect', async (request, reply) => {
    cameraService.forceReconnect();
    return reply.send({ success: true, message: 'Đã gửi lệnh thử lại kết nối Camera RTSP FFmpeg' });
  });
}
