# Gateway REST API & WebSocket Reference

## 1. Authentication

If `GATEWAY_API_KEY` is specified in `.env`, all API requests must include:
```http
Authorization: Bearer <GATEWAY_API_KEY>
```

If `GATEWAY_API_KEY` is omitted, running in local development mode (no auth header required).

---

## 2. Capabilities & Health

### `GET /api/health`
Check Gateway server health.

### `GET /api/capabilities`
Returns supported and unsupported capabilities list.

---

## 3. Printer Telemetry & Status

### `GET /api/printer`
Returns normalized printer state.

### `GET /api/printer/info`
Returns printer model, serial number, firmware version, and online status. **Never exposes Access Code.**

### `GET /api/printer/errors`
Returns active HMS error codes and system error state.

### `GET /api/print/current`
Returns active print job, progress percentage, current layer, total layers, and remaining time.

### `GET /api/ams`
Returns normalized AMS units and tray information.

---

## 4. Printer Actions & Commands

### `POST /api/printer/actions/pause`
Tạm dừng in (Pause).

### `POST /api/printer/actions/resume`
Tiếp tục in (Resume).

### `POST /api/printer/actions/stop`
Hủy tác vụ in (Stop).

### `POST /api/printer/temperature/nozzle`
Set hotend temperature. Body: `{ "target": 220 }` (Validation: 0..300).

### `POST /api/printer/temperature/bed`
Set bed temperature. Body: `{ "target": 60 }` (Validation: 0..120).

### `POST /api/printer/fans/part`
Set part fan speed. Body: `{ "speed": 80 }` (Validation: 0..100).

### `POST /api/printer/fans/aux`
Set aux fan speed. Body: `{ "speed": 50 }` (Validation: 0..100).

### `POST /api/printer/fans/chamber`
Set chamber fan speed. Body: `{ "speed": 30 }` (Validation: 0..100).

---

## 5. Command Audit Log

### `GET /api/commands`
List in-memory command audit history.

### `GET /api/commands/:id`
Get specific command audit record by ID.

---

## 6. Camera Stream APIs

### `GET /api/camera/snapshot`
Returns raw JPEG image snapshot frame.

### `GET /api/camera/mjpeg`
Serves continuous MJPEG stream (`multipart/x-mixed-replace`).

### `GET /api/camera/info`
Returns RTSPS URL (`rtsps://bblp:ACCESS_CODE@HOST:322/streaming/live/1`) and status.

---

## 7. Real-Time WebSockets (`/ws`)

Connect to `ws://HOST:PORT/ws` to receive event stream:
- `printer.state`
- `printer.connection`
- `printer.temperature`
- `printer.progress`
- `printer.ams`
- `printer.error`
- `command.started`
- `command.completed`
- `command.failed`
