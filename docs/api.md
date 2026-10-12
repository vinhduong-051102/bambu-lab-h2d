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

## 5. LAN Printing (3MF → FTPS → `print.project_file`)

Flow: **prepare** (upload + inspect) → **start** (FTPS upload to printer + MQTT command) → follow the job
via `GET /api/print/jobs/:id` or the `print.job` WebSocket event. Status only reaches `PRINTING` when the
printer itself reports `gcode_state: RUNNING`.

Requirements on the printer: LAN mode, and **Developer Mode** on firmware that requires signed MQTT
commands (detected from `print.fun` bit `0x20000000`; the gateway refuses with `412 DEVELOPER_MODE_REQUIRED`).
Commands also require `BAMBU_REAL_PRINTER=true`.

### `POST /api/print/prepare`
`multipart/form-data` with field `file`: a **sliced** `.3mf` (Bambu Studio → *Export plate sliced file*, `.gcode.3mf`).
Returns `201 { staged }` with plates (`Metadata/plate_N.gcode`), the filaments each plate uses (0-based project
index, type, colour, slicer extruder from `filament_maps`: 1 = left, 2 = right), live AMS trays and a suggested mapping.
Errors: `415 UNSUPPORTED_FILE_TYPE`, `422 NOT_SLICED` / `INVALID_3MF`.

### `POST /api/print/prepare-remote`
Body: `{ "path": "/part.gcode.3mf" }`. Downloads a 3MF already on the printer (FTPS) and inspects it; printing it skips the upload.

### `GET /api/print/staged/:id` · `DELETE /api/print/staged/:id`
Re-read or discard a prepared file (prepared files expire after 2 hours).

### `POST /api/print/start`
```json
{
  "stagedId": "…",
  "plateIndex": 1,
  "amsMapping": { "0": 0, "2": 6 },
  "options": { "bedLeveling": true, "flowCalibration": true, "vibrationCalibration": true, "layerInspect": true, "timelapse": false }
}
```
`amsMapping` maps each used project filament index to an absolute tray: `ams_id * 4 + slot` for 4-slot AMS,
128–135 for AMS HT, `254` for the external spool. Returns `202 { job }`.
Errors: `400 INVALID_AMS_MAPPING` (unmapped filament, missing or empty tray; `details.errors`),
`403 TEST_MODE_RESTRICTED`, `409 PRINTER_BUSY` (not IDLE/FINISH/FAILED), `409 PRINT_JOB_IN_PROGRESS`,
`412 DEVELOPER_MODE_REQUIRED`, `503 PRINTER_OFFLINE`.

MQTT payload sent (H2-series form):
```json
{ "print": { "command": "project_file", "param": "Metadata/plate_1.gcode", "url": "ftp:///part.gcode.3mf",
  "md5": "<plate gcode md5>", "bed_type": "auto", "use_ams": true,
  "ams_mapping": [0, -1, 6, -1],
  "ams_mapping2": [{"ams_id":0,"slot_id":0},{"ams_id":255,"slot_id":255},{"ams_id":1,"slot_id":2},{"ams_id":255,"slot_id":255}],
  "bed_leveling": true, "flow_cali": true, "vibration_cali": true, "layer_inspect": true, "timelapse": false, "…": "…" } }
```
`ams_mapping` has one entry per project filament (`-1` = unused).

### `GET /api/print/jobs` · `GET /api/print/jobs/:id`
Job statuses: `UPLOADING → UPLOADED → SENT → ACCEPTED → PREPARING → PRINTING`, or `FAILED` (FTPS error,
`result: fail` from the printer, `gcode_state: FAILED`/`print_error`, with new HMS codes) or `TIMEOUT`
(no answer within 90 s / no start within 10 min). The list also returns the printer snapshot
(`gcodeState`, `fun`, `developerModeRequired`).

### `GET /api/files`
Files in the printer's FTPS root and `/cache` (`printable: true` for `.3mf`).

### `DELETE /api/files/:id`
`id` = URL-encoded absolute path, e.g. `%2Fpart.gcode.3mf`.

---

## 6. Command Audit Log

### `GET /api/commands`
List in-memory command audit history.

### `GET /api/commands/:id`
Get specific command audit record by ID.

---

## 7. Camera Stream APIs

### `GET /api/camera/snapshot`
Returns raw JPEG image snapshot frame.

### `GET /api/camera/mjpeg`
Serves continuous MJPEG stream (`multipart/x-mixed-replace`).

### `GET /api/camera/info`
Returns RTSPS URL (`rtsps://bblp:ACCESS_CODE@HOST:322/streaming/live/1`) and status.

---

## 8. Real-Time WebSockets (`/ws`)

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
- `print.job` (print job snapshot on every status/progress change)
