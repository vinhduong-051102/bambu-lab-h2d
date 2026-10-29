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
  { method: 'GET', path: '/api/filaments/custom', category: 'AMS Control', description: '"Filament của tôi": filament hãng khác/màu tự nhập đã lưu để tô màu mô hình', exampleUrl: '/api/filaments/custom' },
  { method: 'POST', path: '/api/filaments/custom', category: 'AMS Control', description: 'Lưu một filament tự nhập', body: '{"name": "Cam đất", "brand": "eSun", "material": "PLA", "hex": "#C8783C"}' },
  { method: 'DELETE', path: '/api/filaments/custom/:id', category: 'AMS Control', description: 'Xóa một filament tự nhập' },
  { method: 'GET', path: '/api/filaments/colors', category: 'AMS Control', description: 'Bảng màu nhựa chính hãng Bambu Lab (từ Bambu Studio): mã cuộn, mã loại nhựa, tên và mã màu; ?material= để lọc một loại', exampleUrl: '/api/filaments/colors?material=PLA%20Basic' },

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

  // 9. Bambu Studio (embedded)
  { method: 'GET', path: '/api/studio', category: 'Bambu Studio', description: 'Cấu hình Bambu Studio nhúng trong dashboard (STUDIO_URL, STUDIO_IMPORT_DIR)', exampleUrl: '/api/studio' },
  { method: 'POST', path: '/api/studio/import', category: 'Bambu Studio', description: 'Gửi model từ máy tính vào thư mục /imports của Bambu Studio', body: 'multipart/form-data: file=@part.stl' },
  { method: 'POST', path: '/api/studio/ai-optimize', category: 'Bambu Studio', description: 'Nút "AI tối ưu" trong Studio: Claude đề xuất setting quá trình in cho plate đang mở', body: '{"version": 1, "printer_preset": "...", "settings": {...}, "objects": [...]}' },
  { method: 'POST', path: '/api/studio/ai-optimize/prompt', category: 'Bambu Studio', description: 'Prompt và JSON schema cho plate, để `claude -p` trong container Studio tự gọi Claude (đăng nhập bằng gói Claude, không cần ANTHROPIC_API_KEY)', body: '{"version": 1, "printer_preset": "...", "settings": {...}, "objects": [...]}' },
  { method: 'POST', path: '/api/studio/ai-optimize/check', category: 'Bambu Studio', description: 'Kiểm tra đề xuất từ `claude -p` như ai-optimize: chỉ giữ key được phép, giá trị hợp lệ và thực sự thay đổi', body: '{"request": {...}, "proposal": {"summary": "...", "changes": [{"key", "value", "reason"}]}}' },
  { method: 'GET', path: '/api/studio/ai-sessions', category: 'Bambu Studio', description: 'Các lần AI tối ưu gần đây (mới nhất trước), kèm lựa chọn kết quả và lỗi cho báo cáo in', exampleUrl: '/api/studio/ai-sessions?limit=30' },
  { method: 'GET', path: '/api/studio/ai-sessions/:id', category: 'Bambu Studio', description: 'Chi tiết một lần AI tối ưu: đề xuất, thay đổi đã áp dụng, báo cáo kết quả in' },
  { method: 'POST', path: '/api/studio/ai-sessions/:id/applied', category: 'Bambu Studio', description: 'Studio ghi lại các thay đổi người dùng đã áp dụng từ đề xuất AI', body: '{"changes": [{"key": "enable_support", "value": "1"}]}' },
  { method: 'POST', path: '/api/studio/ai-sessions/:id/feedback', category: 'Bambu Studio', description: 'Báo cáo kết quả in với setting AI đề xuất', body: '{"outcome": "usable", "issues": ["support_removal"], "note": "..."}' },
  { method: 'GET', path: '/api/cad', category: 'Thiết kế AI', description: 'Thiết kế mô hình bằng AI có bật không (CAD_WORKER_URL), container CAD có chạy không, các model Claude dùng được', exampleUrl: '/api/cad' },
  { method: 'GET', path: '/api/cad/guide', category: 'Thiết kế AI', description: 'Quy tắc thiết kế cho H2D và tóm tắt build123d (Markdown), cho Claude và Antigravity', exampleUrl: '/api/cad/guide' },
  { method: 'GET', path: '/api/cad/jobs', category: 'Thiết kế AI', description: 'Các mô hình đã thiết kế, mới nhất trước', exampleUrl: '/api/cad/jobs?limit=30' },
  { method: 'POST', path: '/api/cad/jobs', category: 'Thiết kế AI', description: 'Claude thiết kế mô hình từ mô tả (chạy nền bằng `claude -p` trong container CAD, tính vào gói Claude); parent_id để sửa một mô hình có sẵn; images: ảnh dán kèm (data: URL, tối đa 4) cho Claude xem', body: '{"prompt": "Giá đỡ điện thoại nghiêng 60°, dày 3 mm", "model": "claude-opus-5-5", "parent_id": null}' },
  { method: 'POST', path: '/api/cad/meshes', category: 'Thiết kế AI', description: 'Mô hình nhân vật/trang trí từ ảnh hoặc mô tả bằng Hunyuan3D-2 trên GPU (container mesh3d): chỉnh kích thước, đặt sát bàn in, sửa lưới, thêm đế; colour=true tô màu (3MF theo số màu hoặc màu AMS)', body: 'multipart/form-data: image=@nhan-vat.png, prompt=..., height_mm=80, base=true (hoặc JSON {"prompt": "..."})' },
  { method: 'POST', path: '/api/cad/builds', category: 'Thiết kế AI', description: 'Dựng code build123d có sẵn (Antigravity, script): xuất STL/STEP, ảnh xem trước và báo cáo kiểm tra', body: '{"code": "from build123d import *\\nresult = Box(20, 20, 10)", "title": "Khối thử"}' },
  { method: 'GET', path: '/api/cad/jobs/:id', category: 'Thiết kế AI', description: 'Một mô hình: tiến độ, tóm tắt của Claude, báo cáo dựng và các file có sẵn', exampleUrl: '/api/cad/jobs/<id>' },
  { method: 'DELETE', path: '/api/cad/jobs/:id', category: 'Thiết kế AI', description: 'Xóa một mô hình; ?family=1 xóa cả các bản sửa, sửa lại và tạo lại từ nó (không xóa khi có bản đang dựng)' },
  { method: 'POST', path: '/api/cad/jobs/:id/cancel', category: 'Thiết kế AI', description: 'Dừng Claude đang thiết kế mô hình', body: '{}' },
  { method: 'POST', path: '/api/cad/jobs/:id/fix', category: 'Thiết kế AI', description: 'Claude review mô hình nhân vật đã dựng (so với ảnh gốc, xem 6 phía) rồi sửa: đắp chân cụt, bỏ mảnh rời, làm mịn bề mặt sần, vá lỗ, giữ màu filament; prompt rỗng thì Claude tự tìm lỗi; images: ảnh dán kèm (data: URL, tối đa 4). Tạo job mới, bản cũ giữ nguyên', body: '{"prompt": "Chân bị cụt, đứng không vững", "model": "claude-opus-5-5"}' },
  { method: 'POST', path: '/api/cad/jobs/:id/studio', category: 'Thiết kế AI', description: 'Gửi mô hình vào thư mục /imports của Bambu Studio (STL được tự sửa lưới)', body: '{"format": "stl"}' },
  { method: 'GET', path: '/api/cad/jobs/:id/files/:name', category: 'Thiết kế AI', description: 'File của mô hình: model.py, model.stl, model.step, model.3mf, preview.png, concept.png, report.json, fix.py, views.png, assembly.png; mô hình nhiều chi tiết: guide.json (các bước lắp) và assembly.mp4 (video lắp, hỗ trợ Range) (?download=1 để tải về)', exampleUrl: '/api/cad/jobs/<id>/files/preview.png' },
  { method: 'GET', path: '/api/cad/jobs/:id/plates/:n', category: 'Thiết kế AI', description: 'File 3MF riêng của bàn in n khi mô hình nhiều chi tiết được chia ra nhiều bàn (Studio bỏ qua chia bàn trong 3MF không do nó tạo, nên mỗi bàn gửi một file)', exampleUrl: '/api/cad/jobs/<id>/plates/1' },
  { method: 'GET', path: '/api/cad/jobs/:id/guide/:picture', category: 'Thiết kế AI', description: 'Ảnh một bước trong hướng dẫn lắp (step-01.png…) hoặc mô hình đã lắp xong (done.png)', exampleUrl: '/api/cad/jobs/<id>/guide/step-01.png' },
  { method: 'POST', path: '/api/cad/jobs/:id/guide', category: 'Thiết kế AI', description: 'Vẽ lại hướng dẫn lắp (ảnh từng bước + video) cho mô hình khai báo components; tự chạy sau mỗi lần dựng, ~1 phút cho 20 chi tiết' },

  // Mechanism simulation (docs/mechanical-simulation.md): Project Chrono + Blender in the mesh3d container
  { method: 'GET', path: '/api/sim/guide', category: 'Mô phỏng cơ cấu', description: 'Định dạng cơ cấu (schema_version 1), đơn vị, hệ trục và quy tắc cho agent (Markdown)', exampleUrl: '/api/sim/guide' },
  { method: 'GET', path: '/api/sim/mechanisms', category: 'Mô phỏng cơ cấu', description: 'Các cơ cấu đã lưu (mới nhất trước)', exampleUrl: '/api/sim/mechanisms' },
  { method: 'POST', path: '/api/sim/mechanisms', category: 'Mô phỏng cơ cấu', description: 'Lưu cơ cấu (JSON schema_version 1: bodies, joints, actuators, forces, simulation), kể cả chưa đủ; mechanism_id để thay bản cũ. Trả mã và kết quả kiểm tra', body: '{"mechanism": {"schema_version": 1, "units": {"length": "mm"}, "bodies": [...]}}' },
  { method: 'GET', path: '/api/sim/mechanisms/:id', category: 'Mô phỏng cơ cấu', description: 'Một cơ cấu và kết quả kiểm tra của nó', exampleUrl: '/api/sim/mechanisms/<id>' },
  { method: 'POST', path: '/api/sim/mechanisms/:id/:part', category: 'Mô phỏng cơ cấu', description: 'Thêm một khớp (joints {"joint"}), động cơ (actuators {"actuator"}) hoặc lực/lò xo (forces {"force"}); từ chối khi chính phần đó sai (body không có, trục 0…)', body: '{"joint": {"id": "j1", "type": "revolute", "body_a": "base", "body_b": "shaft", "position": [0, 0, 10], "axis": [0, 0, 1]}}' },
  { method: 'POST', path: '/api/sim/validate', category: 'Mô phỏng cơ cấu', description: 'Kiểm tra cơ cấu: lỗi (đường dẫn trường + lý do), cảnh báo, giả định, bậc tự do ước tính', body: '{"mechanism_id": "m-..."}' },
  { method: 'GET', path: '/api/sim/runs', category: 'Mô phỏng cơ cấu', description: 'Các lần mô phỏng (mới nhất trước)', exampleUrl: '/api/sim/runs' },
  { method: 'POST', path: '/api/sim/runs', category: 'Mô phỏng cơ cấu', description: 'Chạy mô phỏng bằng Project Chrono (nền, lần lượt từng lần); simulation ghi đè thời gian/bước cho lần này. Trả sim_id', body: '{"mechanism_id": "m-...", "simulation": {"duration": 2}}' },
  { method: 'GET', path: '/api/sim/runs/:id', category: 'Mô phỏng cơ cấu', description: 'Trạng thái, tiến độ, cảnh báo, lỗi của một lần mô phỏng và lần phát lại Blender', exampleUrl: '/api/sim/runs/<id>' },
  { method: 'GET', path: '/api/sim/runs/:id/results', category: 'Mô phỏng cơ cấu', description: 'Tóm tắt (summary.json: hành trình, vận tốc, phản lực, kiểm tra so với lý thuyết), metadata.json và danh sách file', exampleUrl: '/api/sim/runs/<id>/results' },
  { method: 'POST', path: '/api/sim/runs/:id/cancel', category: 'Mô phỏng cơ cấu', description: 'Dừng mô phỏng đang chạy hoặc đang chờ (hoặc lần phát lại Blender)', body: '{}' },
  { method: 'POST', path: '/api/sim/runs/:id/play', category: 'Mô phỏng cơ cấu', description: 'Phát lại kết quả trong Blender: animation từ body_transforms.csv, tự kiểm tra vị trí/chiều quay, lưu .blend, render MP4 (render=false chỉ dựng .blend)', body: '{"render": true, "fps": 30, "speed": 1}' },
  { method: 'GET', path: '/api/sim/runs/:id/files/:name', category: 'Mô phỏng cơ cấu', description: 'File kết quả: body_transforms.csv, joint_results.csv, summary.json, metadata.json, model.json, mechanism.json, simulation.log', exampleUrl: '/api/sim/runs/<id>/files/summary.json' },
  { method: 'GET', path: '/api/sim/runs/:id/files/blender/:name', category: 'Mô phỏng cơ cấu', description: 'File của lần phát lại: playback.mp4, playback.blend, preview.png, check.json, blender.log', exampleUrl: '/api/sim/runs/<id>/files/blender/playback.mp4' },
  { method: 'GET', path: '/api/sim/live', category: 'Mô phỏng tương tác', description: 'Các phiên mô phỏng tương tác đang chạy (container sim-live)', exampleUrl: '/api/sim/live' },
  { method: 'POST', path: '/api/sim/live', category: 'Mô phỏng tương tác', description: 'Mở phiên tương tác: Chrono chạy liên tục theo thời gian thực, kéo/đẩy vật, đổi motor, trọng lực khi đang chạy. Nhận mechanism, mechanism_id hoặc sim_id (mô hình của một lần chạy); paused để mở ở trạng thái dừng', body: '{"mechanism_id": "m-20261028-120000-ab12", "paused": false}' },
  { method: 'GET', path: '/api/sim/live/:id', category: 'Mô phỏng tương tác', description: 'Cảnh của phiên (body, hình học, khớp, motor, lò xo) và trạng thái mới nhất', exampleUrl: '/api/sim/live/<id>' },
  { method: 'GET', path: '/api/sim/live/:id/state', category: 'Mô phỏng tương tác', description: 'Trạng thái mới nhất (thời gian, vị trí các body, motor, lực kéo, hệ số thời gian thực)', exampleUrl: '/api/sim/live/<id>/state' },
  { method: 'GET', path: '/api/sim/live/:id/stream', category: 'Mô phỏng tương tác', description: 'Trạng thái dạng Server-Sent Events, tối đa hz lần/giây (mặc định 30), cho viewer', exampleUrl: '/api/sim/live/<id>/stream?hz=30' },
  { method: 'POST', path: '/api/sim/live/:id/actions', category: 'Mô phỏng tương tác', description: 'Tác động lên phiên: pause, resume, step, reset (overrides), speed, drag/release, push, twist, motor, gravity, spring, teleport, select. Đơn vị SI', body: '{"action": "push", "body": "box", "force": [0, 0, 5], "duration": 0.1}' },
  { method: 'POST', path: '/api/sim/live/:id/stop', category: 'Mô phỏng tương tác', description: 'Dừng phiên tương tác', body: '{}' },
  { method: 'GET', path: '/api/sim/live/:id/mesh/:body', category: 'Mô phỏng tương tác', description: 'File mesh của một body, cho viewer' },

  // Claude subscriptions
  { method: 'GET', path: '/api/ai/limits', category: 'Hệ thống', description: 'Hạn mức còn lại của các gói Claude (CLAUDE_CODE_OAUTH_TOKEN và _FALLBACK): % đã dùng 5 giờ và 7 ngày, lúc reset, có gọi được không. Lưu 5 phút; ?refresh=1 để kiểm tra lại', exampleUrl: '/api/ai/limits' },
  { method: 'GET', path: '/api/ai/usage', category: 'Hệ thống', description: 'Thống kê dùng AI theo task (thiết kế AI, nhân vật, đánh giá timelapse, nhận diện chi tiết, AI tối ưu Studio): token, chi phí theo giá API, % trong kỳ, % hạn mức 5 giờ / 7 ngày đã dùng; tổng theo tính năng. ?days=30 (0 = tất cả)', exampleUrl: '/api/ai/usage?days=30' },

  // Mechanical model (docs/mechanical-model.md): parts, assembly, DOF, Chrono through /api/sim
  { method: 'POST', path: '/api/mech/:action', category: 'Mô hình cơ khí', description: 'designs {model} (tạo thiết kế mech/1, kiểm tra), import {model_id, fixed, materials, accept} (từ mô hình có sẵn), designs/<id> {changes} (bản sửa mới), designs/<id>/validate · simulate {wait_s} · repairs · apply {proposal_ids, approved} · live {revision, paused} (mở trong khung 3D trực tiếp), models/setup {job_id | model_id} (mô phỏng chính mô hình 3D)', body: '{"model": {"schema": "mech/1", "parts": [...], "joints": [...]}}' },
  { method: 'GET', path: '/api/mech/:resource', category: 'Mô hình cơ khí', description: 'designs, designs/<id>[?revision=] (input, kiểm tra, các lần chạy), designs/<id>/runs/<sim id> (kết quả từng chi tiết, khớp, bánh răng, động cơ; so với động học), designs/<id>/viewer (cơ cấu đã dịch + dữ liệu từng chi tiết), models/<model id> (trạng thái mô phỏng của mô hình 3D: NOT_CONFIGURED … COMPLETED, phiên trực tiếp), capabilities', exampleUrl: '/api/mech/capabilities' },

  // Engineering analysis of printed parts (docs/engineering-analysis.md): mesh3d container, one POST per MCP tool
  { method: 'POST', path: '/api/eng/:tool', category: 'Phân tích kỹ thuật', description: 'inspect (nhập STL/3MF/OBJ/PLY/.blend, đo hình học), validate (lỗi lưới, giao nhau), assembly (đồng trục, khớp đề xuất/xác nhận), clearance (lắp ghép, khe hở, thành, răng, va chạm khi chuyển động), motion/configure + motion/run (Chrono), fea/configure + fea/run (gmsh + CalculiX), printability, report (Markdown + HTML), visualize (Blender)', body: '{"sources": [{"file": "jobs/<job id>/out/model.stl"}], "units": "mm"}' },
  { method: 'GET', path: '/api/eng/:resource', category: 'Phân tích kỹ thuật', description: 'models, models/<id>, analyses (?model_id=&kind=), analyses/<id> (AnalysisResult), analyses/<id>/files/<file> (report.html, result.png, result.blend, job.inp…)', exampleUrl: '/api/eng/analyses' },

  // Timelapse
  { method: 'GET', path: '/api/timelapse', category: 'Lịch sử in', description: 'Video timelapse trên máy in (mới nhất trước), kèm bản in tương ứng trong lịch sử', exampleUrl: '/api/timelapse' },
  { method: 'GET', path: '/api/timelapse/:name', category: 'Lịch sử in', description: 'Phát/tải video timelapse (lấy từ máy in lần đầu xem, hỗ trợ tua)' },
  { method: 'GET', path: '/api/timelapse/:name/thumbnail', category: 'Lịch sử in', description: 'Ảnh thumbnail của video timelapse' },
  { method: 'GET', path: '/api/timelapse/:name/review', category: 'Lịch sử in', description: 'Nhận xét của Claude về video: none / running / failed / done' },
  { method: 'POST', path: '/api/timelapse/:name/review', category: 'Lịch sử in', description: 'Nhờ Claude xem video và nhận xét {print_id?}; chỉ là nhận xét, chưa dùng cho lần in sau' },
  { method: 'POST', path: '/api/timelapse/:name/review/use', category: 'Lịch sử in', description: 'Dùng nhận xét cho lần in sau {print_id?}: lưu vào bản in và đề xuất AI tối ưu của nó' },
  { method: 'DELETE', path: '/api/timelapse/:name/review/use', category: 'Lịch sử in', description: 'Bỏ dùng nhận xét cho lần in sau (nhận xét vẫn giữ)' },

  // Print history
  { method: 'GET', path: '/api/prints', category: 'Lịch sử in', description: 'Các bản in đã ghi lại (mới nhất trước): ảnh, kết quả, lựa chọn báo cáo', exampleUrl: '/api/prints?limit=50' },
  { method: 'GET', path: '/api/prints/:id', category: 'Lịch sử in', description: 'Chi tiết một bản in: setting Studio đã dùng, ảnh, báo cáo' },
  { method: 'POST', path: '/api/prints/setup', category: 'Lịch sử in', description: 'Studio gửi preset và setting khi gửi lệnh in; gateway gắn vào bản in cùng tên job', body: '{"version": 1, "job_name": "...", "settings": {...}, "objects": [...], "ai_session_id": null}' },
  { method: 'POST', path: '/api/prints/:id/feedback', category: 'Lịch sử in', description: 'Báo cáo kết quả bản in (chép sang lần AI đề xuất nếu có)', body: '{"outcome": "success", "issues": [], "note": "..."}' },
  { method: 'GET', path: '/api/prints/:id/parts', category: 'Lịch sử in', description: 'Thành phần đo được của các mẫu trên bản in (thành mỏng, phần nhô, cầu, lỗ, trụ...) và tên Claude đặt' },
  { method: 'POST', path: '/api/prints/:id/parts', category: 'Lịch sử in', description: 'Đo thành phần các mẫu của bản in (container mesh3d) rồi nhờ Claude đặt tên, mất tới 1-2 phút' },
  { method: 'GET', path: '/api/studio/parts/backfill', category: 'Bambu Studio', description: 'Tiến độ đo thành phần các bản in cũ' },
  { method: 'POST', path: '/api/studio/parts/backfill', category: 'Bambu Studio', description: 'Đo thành phần mọi bản in gửi từ Studio, lần lượt, để "AI tối ưu" so thành phần' },
  { method: 'GET', path: '/api/studio/parts/:key/:image', category: 'Bambu Studio', description: 'Ảnh render 6 phía của một lần đo (views.png, parts.png tô màu thành phần)' },
  { method: 'POST', path: '/api/prints/:id/photos', category: 'Lịch sử in', description: 'Tải thêm ảnh bản in (JPEG, PNG, WebP, tối đa 20 MB)', body: 'multipart/form-data: file=@photo.jpg' },
  { method: 'GET', path: '/api/prints/:id/photos/:name', category: 'Lịch sử in', description: 'Ảnh của bản in' },
  { method: 'DELETE', path: '/api/prints/:id/photos/:name', category: 'Lịch sử in', description: 'Xóa một ảnh của bản in' },

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
