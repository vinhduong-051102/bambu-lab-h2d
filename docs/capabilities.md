# Capability System & Status Definitions

The Gateway implements a dynamic **Capability Registry** (`GET /api/capabilities`).

## Capability Statuses

- **`SUPPORTED`**: Protocol evidence verified. Command/Telemetry is active and functional.
- **`UNKNOWN`**: Protocol evidence incomplete or unsafe to execute without physical verification on H2D.
- **`UNSUPPORTED`**: Feature is not supported over MQTT LAN protocol (e.g., file transfers require FTPS).

## Full Capabilities List

| Capability ID | Name | Category | Read | Write | Status |
|---------------|------|----------|------|-------|--------|
| `printer.status` | Trạng thái máy in | status | Yes | No | `SUPPORTED` |
| `system.info` | Thông tin hệ thống | system | Yes | No | `SUPPORTED` |
| `printer.errors` | Mã lỗi HMS | status | Yes | No | `SUPPORTED` |
| `print.job` | Theo dõi tác vụ in | print | Yes | No | `SUPPORTED` |
| `print.pause` | Tạm dừng in (Pause) | print | Yes | Yes | `SUPPORTED` |
| `print.resume` | Tiếp tục in (Resume) | print | Yes | Yes | `SUPPORTED` |
| `print.stop` | Hủy in (Stop) | print | Yes | Yes | `SUPPORTED` |
| `print.start` | Bắt đầu in mới | print | No | Yes | `UNKNOWN` |
| `temperature.read` | Đọc nhiệt độ | temperature | Yes | No | `SUPPORTED` |
| `temperature.nozzle` | Đặt nhiệt độ Hotend | temperature | Yes | Yes | `SUPPORTED` |
| `temperature.bed` | Đặt nhiệt độ Bàn in | temperature | Yes | Yes | `SUPPORTED` |
| `fan.read` | Đọc quạt | fan | Yes | No | `SUPPORTED` |
| `fan.part` | Quạt mẫu (Part Fan) | fan | Yes | Yes | `SUPPORTED` |
| `fan.aux` | Quạt phụ (Aux Fan) | fan | Yes | Yes | `SUPPORTED` |
| `fan.chamber` | Quạt buồng (Chamber Fan) | fan | Yes | Yes | `SUPPORTED` |
| `ams.read` | Đọc AMS | ams | Yes | No | `SUPPORTED` |
| `ams.control` | Điều khiển AMS | ams | No | Yes | `UNKNOWN` |
| `camera.stream` | Live Stream Camera | camera | Yes | No | `SUPPORTED` |
| `file.list` | Danh sách file SD Card | file | Yes | No | `UNKNOWN` |
| `file.upload` | Upload file | file | No | Yes | `UNSUPPORTED` |

## Safety Mode (`BAMBU_REAL_PRINTER`)

By default, `BAMBU_REAL_PRINTER` is set to `false`. When `false`:
- Telemetry, REST APIs, WebSocket events, and Camera streams are fully operational.
- Destructive control commands (`pause`, `resume`, `stop`, `temperature`, `fan`) return HTTP 403 `TEST_MODE_RESTRICTED`.
- Set `BAMBU_REAL_PRINTER=true` in `.env` to enable live printer execution.
