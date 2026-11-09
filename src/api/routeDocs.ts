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
  { method: 'GET', path: '/api/studio/imports', category: 'Bambu Studio', description: 'Các file trong thư mục /imports của Studio (mới nhất trước): tên, dung lượng, thời gian', exampleUrl: '/api/studio/imports' },
  { method: 'GET', path: '/api/studio/imports/:name', category: 'Bambu Studio', description: 'Tải một file trong /imports về máy' },
  { method: 'DELETE', path: '/api/studio/imports/:name', category: 'Bambu Studio', description: 'Xóa một file khỏi /imports (chuyển sang thư mục <imports>-removed/<ngày>, lấy lại được)' },
  { method: 'DELETE', path: '/api/studio/imports', category: 'Bambu Studio', description: 'Xóa mọi file khỏi /imports (chuyển sang <imports>-removed/<ngày>)' },
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
  { method: 'POST', path: '/api/cad/jobs/:id/retry', category: 'Thiết kế AI', description: 'Chạy lại tại chỗ một mẫu lỗi hoặc đã hủy, đúng như đã yêu cầu (Claude từ request.md, code dựng lại, mẫu từ ảnh với cùng thông số)', body: '{}' },
  { method: 'POST', path: '/api/cad/jobs/:id/fix', category: 'Thiết kế AI', description: 'Claude review mô hình nhân vật đã dựng (so với ảnh gốc, xem 6 phía) rồi sửa: đắp chân cụt, bỏ mảnh rời, làm mịn bề mặt sần, vá lỗ, giữ màu filament; prompt rỗng thì Claude tự tìm lỗi; images: ảnh dán kèm (data: URL, tối đa 4). Tạo job mới, bản cũ giữ nguyên', body: '{"prompt": "Chân bị cụt, đứng không vững", "model": "claude-opus-5-5"}' },
  { method: 'POST', path: '/api/cad/jobs/:id/studio', category: 'Thiết kế AI', description: 'Gửi mô hình vào thư mục /imports của Bambu Studio (STL được tự sửa lưới)', body: '{"format": "stl"}' },
  { method: 'GET', path: '/api/cad/jobs/:id/files/:name', category: 'Thiết kế AI', description: 'File của mô hình: model.py, model.stl, model.step, model.glb (xem 3D), model.3mf, drawing.pdf, dfam.json, preview.png, concept.png, report.json, fix.py, views.png, assembly.png; mô hình nhiều chi tiết: guide.json (các bước lắp) và assembly.mp4 (video lắp, hỗ trợ Range); mô hình có mạch điện tử: circuit.json (kiểm tra + mô phỏng), schematic.svg, schematic.png (sơ đồ nối dây), electronics.glb/.step/.png (chỉ mạch điện) và case.glb/.step/.png (chỉ vỏ) (?download=1 để tải về)', exampleUrl: '/api/cad/jobs/<id>/files/preview.png' },
  { method: 'GET', path: '/api/cad/jobs/:id/plates/:n', category: 'Thiết kế AI', description: 'File 3MF riêng của bàn in n khi mô hình nhiều chi tiết được chia ra nhiều bàn (Studio bỏ qua chia bàn trong 3MF không do nó tạo, nên mỗi bàn gửi một file)', exampleUrl: '/api/cad/jobs/<id>/plates/1' },
  { method: 'GET', path: '/api/cad/jobs/:id/guide/:picture', category: 'Thiết kế AI', description: 'Ảnh một bước trong hướng dẫn lắp (step-01.png…) hoặc mô hình đã lắp xong (done.png)', exampleUrl: '/api/cad/jobs/<id>/guide/step-01.png' },
  { method: 'POST', path: '/api/cad/jobs/:id/guide', category: 'Thiết kế AI', description: 'Vẽ lại hướng dẫn lắp (ảnh từng bước + video) cho mô hình khai báo components; tự chạy sau mỗi lần dựng, ~1 phút cho 20 chi tiết; chạy nền (202), guide_task của mô hình cho biết khi xong' },
  { method: 'POST', path: '/api/cad/jobs/:id/drawing', category: 'Thiết kế AI', description: 'Bản vẽ kỹ thuật PDF của mô hình đã dựng (text-to-cad engineering-drawing): khổ A3, chiếu góc thứ ba, 3 hình chiếu + isometric với kích thước bao, mỗi chi tiết in một tờ; chạy nền (202), drawing_task cho biết khi xong, file drawing.pdf' },
  { method: 'POST', path: '/api/cad/jobs/:id/viewer', category: 'Thiết kế AI', description: 'Link CAD Viewer của text-to-cad cho mô hình kỹ thuật đã dựng: {port, secure, path}; {view} (hoặc ?view=): all (mặc định), mô hình có mạch điện thêm electronics (chỉ mạch điện) hoặc case (chỉ vỏ), view khác là 400; mở <http|https>://<host của dashboard>:<port><path> (link có token, hiệu lực 1 ngày, sau đó là cookie 30 ngày)' },
  { method: 'POST', path: '/api/cad/jobs/:id/dfam', category: 'Thiết kế AI', description: 'Kiểm tra DfAM (text-to-cad dfam-check) của model.stl theo giới hạn FDM: lưới kín, độ dày thành, phần nhô và support, hướng đặt tốt hơn; chạy nền (202), kết quả trong dfam của mô hình' },
  { method: 'GET', path: '/api/cad/jobs/:id/exports/:name', category: 'Thiết kế AI', description: 'File Claude làm thêm bằng các skill text-to-cad (out/exports/: bản vẽ, DXF, URDF…), tên trong exports của mô hình (?download=1 để tải về)', exampleUrl: '/api/cad/jobs/<id>/exports/drawing.pdf' },

  // Claude subscriptions
  { method: 'GET', path: '/api/ai/plan', category: 'Hệ thống', description: 'Gói Claude mặc định cho các task (auto: Gói 1, hết lượt thì Gói 2; primary/fallback: chỉ một gói) và các gói chọn được', exampleUrl: '/api/ai/plan' },
  { method: 'PUT', path: '/api/ai/plan', category: 'Hệ thống', description: 'Chọn gói Claude cho mọi task từ giờ ({plan}); mẫu AI có thể chọn riêng khi tạo (plan trong body)', body: '{"plan": "auto"}' },
  { method: 'GET', path: '/api/keyvault', category: 'Hệ thống', description: 'KeyVault của token gói Claude: bước đăng ký (none, pending, approved, rejected, claimed, active), các key được cấp (kèm gói đoán theo tên) và nguồn token của từng gói (chỉ 4 ký tự cuối). Đọc file trên máy, không gọi mạng', exampleUrl: '/api/keyvault' },
  { method: 'POST', path: '/api/keyvault/:action', category: 'Hệ thống', description: 'request {name, contact, organization, reason, requested_keys}, refresh, claim, activate {otp}, import {api_key, private_key_pem?}, pubkey, keys, reconnect (gửi lại yêu cầu từ đầu, giữ server và key của từng gói), reset; use {plan, otp, key_id?}: lấy token, thử gọi thật rồi mới dùng; test {key_id, otp}: thử không lưu; drop-others: bỏ token .env của gói không từ KeyVault (lưu .backup-<giờ>/)', body: '{"plan": "primary", "otp": "123456"}' },
  { method: 'GET', path: '/api/ai/limits', category: 'Hệ thống', description: 'Hạn mức còn lại của các gói Claude (CLAUDE_CODE_OAUTH_TOKEN và _FALLBACK): % đã dùng 5 giờ và 7 ngày, lúc reset, có gọi được không. Lưu 5 phút; ?refresh=1 để kiểm tra lại', exampleUrl: '/api/ai/limits' },
  { method: 'GET', path: '/api/ai/usage', category: 'Hệ thống', description: 'Thống kê dùng AI theo task (thiết kế AI, nhân vật, đánh giá timelapse, nhận diện chi tiết, AI tối ưu Studio): token, chi phí theo giá API, % trong kỳ, % hạn mức 5 giờ / 7 ngày đã dùng; tổng theo tính năng. ?days=30 (0 = tất cả)', exampleUrl: '/api/ai/usage?days=30' },

  // Engineering analysis of printed parts (docs/engineering-analysis.md): mesh3d container, one POST per MCP tool
  { method: 'POST', path: '/api/eng/:tool', category: 'Phân tích kỹ thuật', description: 'inspect (nhập STL/3MF/OBJ/PLY/.blend, đo hình học), validate (lỗi lưới, giao nhau), assembly (đồng trục, khớp đề xuất/xác nhận), clearance (lắp ghép, khe hở, thành, răng), fea/configure + fea/run (gmsh + CalculiX), printability, report (Markdown + HTML), visualize (Blender), check {job_id, print} (kiểm tra kỹ thuật một mẫu; chạy nền (202), task trong GET checks/<job id>)', body: '{"sources": [{"file": "jobs/<job id>/out/model.stl"}], "units": "mm"}' },
  { method: 'GET', path: '/api/eng/:resource', category: 'Phân tích kỹ thuật', description: 'models, models/<id>, analyses (?model_id=&kind=), analyses/<id> (AnalysisResult), analyses/<id>/files/<file> (report.html, result.png, result.blend, job.inp…), checks/<job id> (lần kiểm tra mới nhất và task đang chạy)', exampleUrl: '/api/eng/analyses' },

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
  { method: 'GET', path: '/api/prints/:id/parts', category: 'Lịch sử in', description: 'Thành phần đo được của các mẫu trên bản in (thành mỏng, phần nhô, cầu, lỗ, trụ...), tên Claude đặt, và lần phân tích đang chạy (task)' },
  { method: 'POST', path: '/api/prints/:id/parts', category: 'Lịch sử in', description: 'Đo thành phần các mẫu của bản in (container mesh3d) rồi nhờ Claude đặt tên, mất tới 1-2 phút; chạy nền (202), task trong GET cho biết khi xong' },
  { method: 'GET', path: '/api/studio/parts/backfill', category: 'Bambu Studio', description: 'Tiến độ đo thành phần các bản in cũ' },
  { method: 'POST', path: '/api/studio/parts/backfill', category: 'Bambu Studio', description: 'Đo thành phần mọi bản in gửi từ Studio, lần lượt, để "AI tối ưu" so thành phần' },
  { method: 'GET', path: '/api/studio/parts/:key/:image', category: 'Bambu Studio', description: 'Ảnh render 6 phía của một lần đo (views.png, parts.png tô màu thành phần)' },
  { method: 'POST', path: '/api/prints/:id/photos', category: 'Lịch sử in', description: 'Tải thêm ảnh bản in (JPEG, PNG, WebP, tối đa 20 MB)', body: 'multipart/form-data: file=@photo.jpg' },
  { method: 'GET', path: '/api/prints/:id/photos/:name', category: 'Lịch sử in', description: 'Ảnh của bản in' },
  { method: 'DELETE', path: '/api/prints/:id/photos/:name', category: 'Lịch sử in', description: 'Xóa một ảnh của bản in' },

  // 10. Real-time WebSocket Stream
  { method: 'GET (WS)', path: '/ws', category: 'Real-time WebSocket', description: 'Kết nối WebSocket đẩy dữ liệu telemetry & lệnh thời gian thực', exampleUrl: 'ws://localhost:3000/ws' },
  { method: 'GET', path: '/api/tasks', category: 'Tác vụ nền', description: 'Các tác vụ chạy nền (đang chạy, lỗi, vừa xong): mẫu AI, kiểm tra kỹ thuật, hướng dẫn lắp, phân tích thành phần, AI xem timelapse; lỗi kèm chi tiết và retry_url', exampleUrl: '/api/tasks' },
  { method: 'POST', path: '/api/tasks/retry', category: 'Tác vụ nền', description: 'Chạy lại một tác vụ nền của gateway sau khi phân tích lỗi (quy tắc viết sẵn, quy tắc đã học, rồi Claude) (?key= hoặc {key})', body: '{}' },
  { method: 'GET', path: '/api/tasks/rules', category: 'Tác vụ nền', description: 'Các quy tắc đã học khi thử lại: lỗi Claude phân tích và lần chạy lại đã thành công, lưu thành mẫu lỗi + cách chỉnh để lần sau sửa không cần AI', exampleUrl: '/api/tasks/rules' },
  { method: 'PATCH', path: '/api/tasks/rules', category: 'Tác vụ nền', description: 'Bật/tắt hoặc sửa một quy tắc đã học (?id=, {enabled?, cause?, pattern?})', body: '{"enabled": false}' },
  { method: 'DELETE', path: '/api/tasks/rules', category: 'Tác vụ nền', description: 'Xóa một quy tắc đã học (?id=): lỗi đó lại do Claude phân tích' },
];

// GET /api/routes
export function getRoutes(): Response {
  return Response.json({
    total: GATEWAY_ROUTES.length,
    routes: GATEWAY_ROUTES,
  });
}
