import { FastifyInstance } from 'fastify';

export interface RouteDoc {
  method: string;
  path: string;
  category: string;
  description: string;
  body?: string;
  exampleUrl?: string;
}

export const GATEWAY_ROUTES: RouteDoc[] = [
  // 1. Health & Meta
  { method: 'GET', path: '/health', category: 'Health & System', description: 'Kiểm tra trạng thái hoạt động Gateway', exampleUrl: '/health' },
  { method: 'GET', path: '/api/capabilities', category: 'Health & System', description: 'Danh sách tính năng & ánh xạ G-code capabilities', exampleUrl: '/api/capabilities' },
  { method: 'GET', path: '/api/routes', category: 'Health & System', description: 'Danh sách đầy đủ tất cả REST API endpoints', exampleUrl: '/api/routes' },

  // 2. Telemetry & State
  { method: 'GET', path: '/api/printer', category: 'Telemetry & State', description: 'Trạng thái tổng hợp thời gian thực của máy in', exampleUrl: '/api/printer' },
  { method: 'GET', path: '/api/printer/info', category: 'Telemetry & State', description: 'Thông tin phần cứng (Serial, Model, Firmware)', exampleUrl: '/api/printer/info' },
  { method: 'GET', path: '/api/printer/diagnostics', category: 'Telemetry & State', description: 'Chẩn đoán độ tin cậy và nguồn dữ liệu telemetry', exampleUrl: '/api/printer/diagnostics' },
  { method: 'GET', path: '/api/printer/raw', category: 'Telemetry & State', description: 'Dữ liệu telemetry thô (Raw Payload) từ MQTT', exampleUrl: '/api/printer/raw' },
  { method: 'GET', path: '/api/ams', category: 'Telemetry & State', description: 'Thông tin bộ AMS, khay nhựa, màu sắc & % còn lại', exampleUrl: '/api/ams' },
  { method: 'POST', path: '/api/ams/load', category: 'AMS Control', description: 'Nạp nhựa từ khay AMS chỉ định (target: 0..3)', body: '{"target": 0, "temp": 220}' },
  { method: 'POST', path: '/api/ams/unload', category: 'AMS Control', description: 'Rút nhựa hiện tại khỏi đầu in về bộ AMS', body: '{}' },
  { method: 'POST', path: '/api/ams/setting', category: 'AMS Control', description: 'Cài đặt loại nhựa, màu sắc hex & giới hạn nhiệt độ cho khay AMS', body: '{"amsId": 0, "trayId": 0, "color": "#FF0000", "type": "PLA"}' },
  { method: 'POST', path: '/api/ams/retry', category: 'AMS Control', description: 'Thử lại lệnh đùn/kéo nhựa AMS sau khi gặp lỗi rối nhựa', body: '{}' },

  // 3. Camera Live Stream & Telemetry
  { method: 'GET', path: '/api/camera/status', category: 'Camera Stream', description: 'Trạng thái luồng RTSP camera, FPS, độ phân giải & frame count', exampleUrl: '/api/camera/status' },
  { method: 'GET', path: '/api/camera/snapshot', category: 'Camera Stream', description: 'Ảnh chụp JPEG mới nhất từ camera (HTTP 503 nếu chưa sẵn sàng)', exampleUrl: '/api/camera/snapshot' },
  { method: 'GET', path: '/api/camera/mjpeg', category: 'Camera Stream', description: 'Luồng video trực tiếp MJPEG (multipart/x-mixed-replace)', exampleUrl: '/api/camera/mjpeg' },
  { method: 'POST', path: '/api/camera/reconnect', category: 'Camera Stream', description: 'Gửi lệnh thử kết nối lại luồng Camera RTSP FFmpeg', body: '{}' },

  // 4. Thermal Controls
  { method: 'POST', path: '/api/printer/temperature/nozzle', category: 'Thermal Controls', description: 'Đặt nhiệt độ mục tiêu Đầu in #1 (T0)', body: '{"temp": 220}' },
  { method: 'POST', path: '/api/printer/temperature/nozzle2', category: 'Thermal Controls', description: 'Đặt nhiệt độ mục tiêu Đầu in #2 (T1)', body: '{"temp": 220}' },
  { method: 'POST', path: '/api/printer/temperature/bed', category: 'Thermal Controls', description: 'Đặt nhiệt độ mục tiêu Bàn in (Heatbed)', body: '{"temp": 60}' },
  { method: 'POST', path: '/api/printer/temperature/off', category: 'Thermal Controls', description: 'Tắt toàn bộ gia nhiệt (Đầu in #1, #2 & Bàn in)', body: '{}' },

  // 5. Fan Controls
  { method: 'POST', path: '/api/printer/fans/cooling', category: 'Cooling & Fans', description: 'Điều chỉnh tốc độ quạt làm mát Part Cooling (0 - 100%)', body: '{"speed": 100}' },
  { method: 'POST', path: '/api/printer/fans/aux', category: 'Cooling & Fans', description: 'Điều chỉnh tốc độ quạt phụ Auxiliary Fan (0 - 100%)', body: '{"speed": 80}' },
  { method: 'POST', path: '/api/printer/fans/chamber', category: 'Cooling & Fans', description: 'Điều chỉnh tốc độ quạt hút buồng in Chamber Fan (0 - 100%)', body: '{"speed": 50}' },
  { method: 'POST', path: '/api/printer/fans/all', category: 'Cooling & Fans', description: 'Điều chỉnh tốc độ tất cả các quạt cùng lúc', body: '{"speed": 100}' },

  // 6. Print Job & Motion Control
  { method: 'POST', path: '/api/printer/control/pause', category: 'Print Controls', description: 'Tạm dừng tác vụ in (Pause Job)', body: '{}' },
  { method: 'POST', path: '/api/printer/control/resume', category: 'Print Controls', description: 'Tiếp tục tác vụ in (Resume Job)', body: '{}' },
  { method: 'POST', path: '/api/printer/control/stop', category: 'Print Controls', description: 'Dừng / Hủy tác vụ in (Cancel Job)', body: '{}' },
  { method: 'POST', path: '/api/printer/speed', category: 'Print Controls', description: 'Đổi chế độ tốc độ in (standard / silent / sport / ludicrous)', body: '{"speedProfile": "sport"}' },
  { method: 'POST', path: '/api/printer/light', category: 'Print Controls', description: 'Bật / Tắt đèn LED buồng in', body: '{"mode": "on"}' },

  // 7. Command Audit Log & Files
  { method: 'GET', path: '/api/commands', category: 'Audit & Files', description: 'Nhật ký audit log lịch sử các lệnh đã thực thi', exampleUrl: '/api/commands' },
  { method: 'GET', path: '/api/files', category: 'Audit & Files', description: 'Danh sách các file G-code / 3MF trên máy in', exampleUrl: '/api/files' },

  // 8. Real-time WebSocket Stream
  { method: 'GET (WS)', path: '/ws', category: 'Real-time WebSocket', description: 'Kết nối WebSocket đẩy dữ liệu telemetry & lệnh thời gian thực', exampleUrl: 'ws://localhost:3000/ws' },
];

export async function docsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/routes', async () => {
    return {
      total: GATEWAY_ROUTES.length,
      routes: GATEWAY_ROUTES,
    };
  });
}
