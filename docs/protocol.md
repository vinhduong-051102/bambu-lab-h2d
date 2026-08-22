# Bambu Lab H2D LAN MQTT Protocol Evidence & Documentation

## 1. Network Connections & Ports

| Service | Port | Protocol | Usage |
|---------|------|----------|-------|
| MQTT Control & Telemetry | `8883` | TLS (Self-signed cert) | Subscribes to `device/{SERIAL}/report`, publishes to `device/{SERIAL}/request` |
| Chamber Camera Liveview | `6000` | TLS Stream | Returns continuous JPEG frame stream |
| RTSPS Camera Liveview | `322` / `554` | RTSPS | Alternative RTSP stream over TLS |
| File Management | `990` | FTPS (TLS) | SD Card Gcode / 3MF file transfers |

## 2. Command Protocol Evidence Matrix

| Capability | Read | Write | Status | Topic | Payload / Protocol Evidence |
|------------|------|-------|--------|-------|-----------------------------|
| `printer.status` | Yes | No | SUPPORTED | `device/{SERIAL}/report` | Parsed from telemetry JSON (`gcode_state`, `mc_percent`, etc.) |
| `print.pause` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "pause"}}` |
| `print.resume` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "resume"}}` |
| `print.stop` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "stop"}}` |
| `temperature.nozzle` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "gcode_line", "param": "M104 S{target}\n"}}` |
| `temperature.bed` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "gcode_line", "param": "M140 S{target}\n"}}` |
| `fan.part` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "gcode_line", "param": "M106 P1 S{255*pct/100}\n"}}` |
| `fan.aux` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "gcode_line", "param": "M106 P2 S{255*pct/100}\n"}}` |
| `fan.chamber` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "gcode_line", "param": "M106 P3 S{255*pct/100}\n"}}` |
| `AMS telemetry` | Yes | No | SUPPORTED | `device/{SERIAL}/report` | Parsed from `ams.ams[]` telemetry array |
| `print.start` | No | Yes | UNKNOWN | `device/{SERIAL}/request` | Requires verified project 3MF file metadata on SD card |
| `file.upload` | No | Yes | UNSUPPORTED | Port 990 FTPS | Not supported over MQTT LAN protocol |
| `file.list` | Yes | No | UNKNOWN | Port 990 FTPS | Requires FTPS session |

## 3. Protocol Debug Mode

Set `BAMBU_DEBUG_PROTOCOL=true` in `.env` to log incoming/outgoing MQTT messages.
**Note**: Protocol logging automatically sanitizes sensitive fields and **never logs `BAMBU_ACCESS_CODE`**.
