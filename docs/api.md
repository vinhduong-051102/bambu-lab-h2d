# Gateway REST API & WebSocket Reference

## 1. Authentication

If `GATEWAY_API_KEY` is specified in `.env`, all API requests must include:
```http
Authorization: Bearer <GATEWAY_API_KEY>
```

If `GATEWAY_API_KEY` is omitted, running in local development mode (no auth header required).

The dashboard authenticates with a session cookie instead, since browsers can't send headers for `<img>` streams or WebSockets. These routes are public:

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/api/auth/session` | – | `{ "authRequired": bool, "authenticated": bool }` |
| POST | `/api/auth/login` | `{ "key": "<GATEWAY_API_KEY>" }` | Sets the HttpOnly `gateway_session` cookie; 401 for a wrong key |
| POST | `/api/auth/logout` | – | Clears the cookie |

A valid `gateway_session` cookie is accepted anywhere the Bearer header is (all `/api/*` routes and `/ws`). Rotating `GATEWAY_API_KEY` invalidates existing sessions.

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
Returns normalized AMS units and tray information. `loadedTrays` lists the trays fed into a toolhead
(`{ trayIndex, amsId, slotId, extruderId }`, H2D extruder 0 = right, 1 = left); `activeTrayId` is the one on the
active extruder. Tray indexes are absolute: `ams_id * 4 + slot`, AMS HT = `ams_id`.

### `POST /api/ams/load`
Body `{ "amsId": 0, "slotId": 2, "temp"?: 245 }` (`trayId` is accepted as an alias of `slotId`). Sends
`ams_change_filament` with `target` (absolute index), `ams_id`, `slot_id`; `tar_temp` defaults to the middle of
the tray's nozzle range, `curr_temp` to that of the filament being replaced.
Errors: `400 INVALID_PARAMETER | TRAY_NOT_FOUND | TRAY_EMPTY | TRAY_ALREADY_LOADED | INVALID_TEMPERATURE`,
`409 PRINTER_BUSY | AMS_COMMAND_IN_PROGRESS`, `503 MQTT_DISCONNECTED`.

### `POST /api/ams/unload`
Sends `ams_change_filament` with `target`, `ams_id`, `slot_id` = `255`.

### `POST /api/ams/setting`
Body `{ "amsId": 0, "slotId": 1, "type": "PETG", "color": "#FF5733", "minTemp": 230, "maxTemp": 260, "trayInfoIdx"?: "GFG99" }`.
`tray_info_idx` defaults to the Bambu generic profile of `type` (PLA `GFL99`, PETG `GFG99`, ABS `GFB99`, …).

### `GET /api/ams/command/:commandId`
Command lifecycle: `WAITING_FOR_PRINTER` → `VERIFYING` (printer replied `result: success` to the same
`sequence_id`) → `COMPLETED` once telemetry confirms (load: target slot in `extruder.info[].snow` and `ams_status` idle; unload: no AMS
tray loaded and AMS idle). `FAILED` when the printer replies with a failure (`error` carries its `reason`) or raises a new AMS
HMS error (module `07xx` / `12xx` / `18xx`). `TIMEOUT` after 180 s for load/unload, 30 s otherwise
(`AMS_COMMAND_TIMEOUT_MS` overrides both).

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

## 5. Printer Files & Bambu Studio

Prints are sliced and started from the embedded Bambu Studio (see [studio.md](studio.md)); the gateway no longer uploads or starts print jobs.

### `GET /api/studio`
`{ enabled, url, importsEnabled }`: settings for the dashboard's Bambu Studio card.

### `POST /api/studio/import`
`multipart/form-data` with field `file` (`.3mf`, `.stl`, `.obj`, `.step`, `.stp`). Saves it to `STUDIO_IMPORT_DIR`, seen as `/imports` inside Studio; an existing name gets a ` (2)` suffix. Returns `{ success, name, studioPath }`.

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
