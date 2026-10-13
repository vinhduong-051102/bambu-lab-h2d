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
  { method: 'GET', path: '/api/health', category: 'Health & System', description: 'Kiểm tra trạng thái hoạt động Gateway', exampleUrl: '/api/health' },
  { method: 'GET', path: '/api/capabilities', category: 'Health & System', description: 'Danh sách tính năng & ánh xạ G-code capabilities', exampleUrl: '/api/capabilities' },
  { method: 'GET', path: '/api/routes', category: 'Health & System', description: 'Danh sách đầy đủ tất cả REST API endpoints', exampleUrl: '/api/routes' },
  { method: 'GET', path: '/api/auth/session', category: 'Health & System', description: 'Dashboard có cần đăng nhập (GATEWAY_API_KEY) hay không', exampleUrl: '/api/auth/session' },
  { method: 'POST', path: '/api/auth/login', category: 'Health & System', description: 'Đổi GATEWAY_API_KEY lấy cookie phiên HttpOnly cho dashboard', body: '{"key": "<GATEWAY_API_KEY>"}' },
  { method: 'POST', path: '/api/auth/logout', category: 'Health & System', description: 'Xóa cookie phiên dashboard', body: '{}' },

  // 2. Telemetry & State
  { method: 'GET', path: '/api/printer', category: 'Telemetry & State', description: 'Trạng thái tổng hợp thời gian thực của máy in', exampleUrl: '/api/printer' },
  { method: 'GET', path: '/api/printer/info', category: 'Telemetry & State', description: 'Thông tin phần cứng (Serial, Model, Firmware)', exampleUrl: '/api/printer/info' },
  { method: 'GET', path: '/api/printer/diagnostics', category: 'Telemetry & State', description: 'Chẩn đoán độ tin cậy và nguồn dữ liệu telemetry', exampleUrl: '/api/printer/diagnostics' },
  { method: 'GET', path: '/api/printer/:serial/diagnostics', category: 'Telemetry & State', description: 'Chẩn đoán telemetry theo serial máy in' },
  { method: 'GET', path: '/api/printer/errors', category: 'Telemetry & State', description: 'Danh sách lỗi HMS hiện tại của máy in', exampleUrl: '/api/printer/errors' },
  { method: 'GET', path: '/api/printer/raw', category: 'Telemetry & State', description: 'Dữ liệu telemetry thô (Raw Payload) từ MQTT', exampleUrl: '/api/printer/raw' },
  { method: 'GET', path: '/api/printers', category: 'Telemetry & State', description: 'Danh sách máy in đã đăng ký với Gateway', exampleUrl: '/api/printers' },
  { method: 'GET', path: '/api/printers/:serial', category: 'Telemetry & State', description: 'Trạng thái của một máy in theo serial' },

  // 3. AMS
  { method: 'GET', path: '/api/ams', category: 'AMS Control', description: 'Thông tin bộ AMS, khay nhựa, màu sắc & % còn lại', exampleUrl: '/api/ams' },
  { method: 'POST', path: '/api/ams/load', category: 'AMS Control', description: 'Nạp nhựa từ khay AMS chỉ định (amsId + slotId 0..3, nhiệt độ mặc định theo khay)', body: '{"amsId": 0, "slotId": 1}' },
  { method: 'POST', path: '/api/ams/unload', category: 'AMS Control', description: 'Rút nhựa hiện tại khỏi đầu in về bộ AMS', body: '{}' },
  { method: 'POST', path: '/api/ams/setting', category: 'AMS Control', description: 'Cài đặt loại nhựa, màu sắc hex & giới hạn nhiệt độ cho khay AMS', body: '{"amsId": 0, "slotId": 0, "color": "#FF0000", "type": "PLA", "minTemp": 190, "maxTemp": 230}' },
  { method: 'POST', path: '/api/ams/retry', category: 'AMS Control', description: 'Thử lại lệnh đùn/kéo nhựa AMS sau khi gặp lỗi rối nhựa', body: '{}' },
  { method: 'GET', path: '/api/ams/command/:commandId', category: 'AMS Control', description: 'Trạng thái vòng đời của một lệnh AMS' },
  { method: 'GET', path: '/api/ams/debug', category: 'AMS Control', description: 'Debug protocol AMS thô (Raw Payload -> Parser -> State -> Command status)', exampleUrl: '/api/ams/debug' },
  { method: 'GET', path: '/api/ams/:amsId/tray/:trayId/rfid', category: 'AMS Control', description: 'Đọc thông tin chip RFID từ khay nhựa AMS chỉ định', exampleUrl: '/api/ams/0/tray/0/rfid' },

  // 4. Camera Live Stream & Telemetry
  { method: 'GET', path: '/api/camera/status', category: 'Camera Stream', description: 'Trạng thái luồng RTSP camera, FPS, độ phân giải & frame count', exampleUrl: '/api/camera/status' },
  { method: 'GET', path: '/api/camera/info', category: 'Camera Stream', description: 'Thông tin luồng camera (giống /api/camera/status)', exampleUrl: '/api/camera/info' },
  { method: 'GET', path: '/api/camera/snapshot', category: 'Camera Stream', description: 'Ảnh chụp JPEG mới nhất từ camera (HTTP 503 nếu chưa sẵn sàng)', exampleUrl: '/api/camera/snapshot' },
  { method: 'GET', path: '/api/camera/mjpeg', category: 'Camera Stream', description: 'Luồng video trực tiếp MJPEG (multipart/x-mixed-replace)', exampleUrl: '/api/camera/mjpeg' },
  { method: 'POST', path: '/api/camera/reconnect', category: 'Camera Stream', description: 'Gửi lệnh thử kết nối lại luồng Camera RTSP FFmpeg', body: '{}' },

  // 5. Thermal Controls
  { method: 'POST', path: '/api/printer/temperature/nozzle', category: 'Thermal Controls', description: 'Đặt nhiệt độ mục tiêu Đầu in #1 (T0)', body: '{"target": 220}' },
  { method: 'POST', path: '/api/printer/temperature/nozzle2', category: 'Thermal Controls', description: 'Đặt nhiệt độ mục tiêu Đầu in #2 (T1)', body: '{"target": 220}' },
  { method: 'POST', path: '/api/printer/temperature/bed', category: 'Thermal Controls', description: 'Đặt nhiệt độ mục tiêu Bàn in (Heatbed)', body: '{"target": 60}' },

  // 6. Fan Controls
  { method: 'POST', path: '/api/printer/fans/part', category: 'Cooling & Fans', description: 'Điều chỉnh tốc độ quạt làm mát Part Cooling (0 - 100%)', body: '{"speed": 100}' },
  { method: 'POST', path: '/api/printer/fans/aux', category: 'Cooling & Fans', description: 'Điều chỉnh tốc độ quạt phụ Auxiliary Fan (0 - 100%)', body: '{"speed": 80}' },
  { method: 'POST', path: '/api/printer/fans/chamber', category: 'Cooling & Fans', description: 'Điều chỉnh tốc độ quạt hút buồng in Chamber Fan (0 - 100%)', body: '{"speed": 50}' },

  // 7. Print Controls (/api/print/{pause,resume,stop,cancel} là alias tương đương)
  { method: 'POST', path: '/api/printer/actions/pause', category: 'Print Controls', description: 'Tạm dừng tác vụ in (Pause Job)', body: '{}' },
  { method: 'POST', path: '/api/printer/actions/resume', category: 'Print Controls', description: 'Tiếp tục tác vụ in (Resume Job)', body: '{}' },
  { method: 'POST', path: '/api/printer/actions/stop', category: 'Print Controls', description: 'Dừng / Hủy tác vụ in (Cancel Job)', body: '{}' },
  { method: 'GET', path: '/api/print/current', category: 'Print Controls', description: 'Tiến độ tác vụ in hiện tại (layer, %, thời gian còn lại)', exampleUrl: '/api/print/current' },

  // 8. Command Audit Log & Files
  { method: 'GET', path: '/api/commands', category: 'Audit & Files', description: 'Nhật ký audit log lịch sử các lệnh đã thực thi', exampleUrl: '/api/commands' },
  { method: 'GET', path: '/api/commands/:id', category: 'Audit & Files', description: 'Chi tiết một lệnh trong audit log' },
  { method: 'GET', path: '/api/files', category: 'Audit & Files', description: 'Danh sách file trên bộ nhớ máy in (FTPS / và /cache)', exampleUrl: '/api/files' },
  { method: 'DELETE', path: '/api/files/:path', category: 'Audit & Files', description: 'Xóa file trên máy in (path URL-encoded, vd %2Fpart.gcode.3mf)' },

  // 9. LAN Printing
  { method: 'POST', path: '/api/print/prepare', category: 'LAN Printing', description: 'Tải file .gcode.3mf (multipart, field "file") lên gateway & phân tích plate/filament', body: 'multipart/form-data: file=@part.gcode.3mf' },
  { method: 'POST', path: '/api/print/prepare-remote', category: 'LAN Printing', description: 'Phân tích file 3MF có sẵn trên máy in', body: '{"path": "/part.gcode.3mf"}' },
  { method: 'GET', path: '/api/print/staged/:id', category: 'LAN Printing', description: 'Thông tin file 3MF đã chuẩn bị (plate, filament)' },
  { method: 'GET', path: '/api/print/staged/:id/file', category: 'LAN Printing', description: 'Tải file .gcode.3mf đã chuẩn bị (dùng cho xem 3D đường in)' },
  { method: 'DELETE', path: '/api/print/staged/:id', category: 'LAN Printing', description: 'Hủy file 3MF đã chuẩn bị' },
  { method: 'POST', path: '/api/print/start', category: 'LAN Printing', description: 'Upload FTPS + gửi print.project_file, trả về print job', body: '{"stagedId": "...", "plateIndex": 1, "amsMapping": {"0": 0}}' },
  { method: 'GET', path: '/api/print/jobs', category: 'LAN Printing', description: 'Danh sách lệnh in & trạng thái xác nhận từ máy in', exampleUrl: '/api/print/jobs' },
  { method: 'GET', path: '/api/print/jobs/:id', category: 'LAN Printing', description: 'Chi tiết một lệnh in' },

  // 10. Real-time WebSocket Stream
  { method: 'GET (WS)', path: '/ws', category: 'Real-time WebSocket', description: 'Kết nối WebSocket đẩy dữ liệu telemetry & lệnh thời gian thực', exampleUrl: 'ws://localhost:3000/ws' },
];

// GET /api/routes
export function getRoutes(): Response {
  return Response.json({
    total: GATEWAY_ROUTES.length,
    routes: GATEWAY_ROUTES,
  });
}
