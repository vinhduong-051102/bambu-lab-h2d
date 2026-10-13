import type { BambuCameraService } from '../../bambu/BambuCameraService';
import { handler, json, type HandlerArgs } from '../http';

// Camera routes are only available when the gateway was started with a camera service
const cameraHandler = (fn: (cameraService: BambuCameraService, args: HandlerArgs) => Response | Promise<Response>) =>
  handler((args) => {
    const { cameraService } = args.printerService;
    if (!cameraService) {
      return json({ error: 'Not Found', message: 'Camera service is not available' }, 404);
    }
    return fn(cameraService, args);
  });

// 1. GET /api/camera/status (Requirement 9) and backward compatible /api/camera/info
export const getCameraStatus = cameraHandler((cameraService) => json(cameraService.getStatus()));

// 2. GET /api/camera/snapshot (Requirement 8)
export const getCameraSnapshot = cameraHandler((cameraService) => {
  const frame = cameraService.getLatestFrame();
  if (frame) {
    return new Response(new Uint8Array(frame), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  }

  return json(
    {
      error: 'camera_frame_not_available',
      message: 'No JPEG camera frame decoded yet from RTSP stream',
    },
    503
  );
});

// 3. GET /api/camera/mjpeg (Requirement 7)
export const getCameraMjpeg = cameraHandler((cameraService, { request }) => {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sendFrame = (frameBuf: Buffer) => {
        try {
          controller.enqueue(
            encoder.encode(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuf.length}\r\n\r\n`)
          );
          controller.enqueue(new Uint8Array(frameBuf));
          controller.enqueue(encoder.encode('\r\n'));
        } catch {
          cleanup();
        }
      };

      cleanup = () => {
        cameraService.off('frame', sendFrame);
        request.signal.removeEventListener('abort', cleanup);
      };

      // Send initial frame if available
      const initialFrame = cameraService.getLatestFrame();
      if (initialFrame) {
        sendFrame(initialFrame);
      }

      cameraService.on('frame', sendFrame);
      request.signal.addEventListener('abort', cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'close',
      Pragma: 'no-cache',
    },
  });
});

// 4. POST /api/camera/reconnect
// Waits for the first frame of the new stream so the response says whether the camera is really back
export const reconnectCamera = cameraHandler(async (cameraService) => {
  const connected = await cameraService.forceReconnect();
  const status = cameraService.getStatus();
  if (!connected) {
    return json({
      success: false,
      error: 'CAMERA_NO_FRAMES',
      message: `Đã khởi động lại camera nhưng chưa nhận được hình: ${status.lastError ?? 'không rõ lỗi'}`,
      status,
    }, 504);
  }
  return json({ success: true, message: 'Camera đã kết nối lại và đang nhận hình.', status });
});
