# bambu-h2d-gateway

Local LAN Gateway for Bambu Lab H2D (and Bambu Lab X1 / P1 / A1 series) 3D Printers over MQTT TLS & Live Camera Stream.

---

## 🌟 Overview & Architecture

`bambu-h2d-gateway` acts as an enterprise-grade local bridge between Bambu Lab 3D Printers and web applications / home automation systems.

```
H2D Printer
 │
 │ MQTT TLS (Port 8883) & Camera TLS (Port 6000)
 ▼
BambuMqttClient & BambuCameraService
 │
 ▼
BambuProtocol (Report Parser & Command Builder)
 │
 ▼
PrinterService (PrinterManager)
 │
 ├── PrinterStateStore (Telemetry, Temperatures, AMS, HMS Errors)
 ├── PrinterCommandService (CommandQueue, Validation, Safety Checks)
 └── CapabilityRegistry (SUPPORTED / UNKNOWN / UNSUPPORTED capability definitions)
       │
       ├── Fastify REST API & Web Dashboard
       └── WebSocket Server (/ws real-time event stream)
```

---

## 🔒 Key Principles & Protocol Evidence

1. **Protocol Evidence Driven**: Commands are only implemented with verified protocol evidence (Bambu LAN MQTT JSON specifications). Unsupported/unverified commands are marked `UNKNOWN` or `UNSUPPORTED`.
2. **Safety Mode (`BAMBU_REAL_PRINTER`)**: By default, `BAMBU_REAL_PRINTER=false`. Destructive control commands (`pause`, `resume`, `stop`, `temperature`, `fan`) are blocked with HTTP 403 unless `BAMBU_REAL_PRINTER=true` is explicitly configured.
3. **Command Queue & Audit Log**: Single-thread FIFO command queue prevents race conditions and logs all command executions in RAM (`GET /api/commands`).
4. **Bambu Studio Independence**: Runs completely independently on your LAN without requiring Bambu Studio or Bambu Handy.
5. **No Credential Leakage**: Never exposes the Bambu `ACCESS_CODE` in REST API payloads or WebSocket streams.

---

## 📋 Requirements & Setup

- **Node.js**: `>= 20.0.0`
- **Package Manager**: `npm`
- **Network**: Local area network (LAN) access to the printer.

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env

# Run type check
npm run typecheck

# Run unit tests
npm test

# Build production bundle
npm run build

# Start server
npm start
```

---

## ⚙️ Environment Variables

```ini
BAMBU_HOST=192.168.5.100
BAMBU_PORT=8883
BAMBU_SERIAL=0948BB550300838
BAMBU_ACCESS_CODE=12345678

HTTP_HOST=0.0.0.0
HTTP_PORT=3000

LOG_LEVEL=info
PRINTER_OFFLINE_TIMEOUT_MS=30000
ENABLE_RAW_API=true

# Safety Mode & Protocol Debugging
BAMBU_REAL_PRINTER=false
BAMBU_DEBUG_PROTOCOL=false

# Optional Gateway API Key (Bearer Token)
GATEWAY_API_KEY=
```

---

## 📡 REST API Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Check server status |
| `/api/capabilities` | GET | List printer capabilities & status (`SUPPORTED`/`UNKNOWN`) |
| `/api/printer` | GET | Get normalized telemetry state |
| `/api/printer/info` | GET | Get system info (Model, Serial, Firmware, Online) |
| `/api/printer/errors` | GET | Get HMS error codes & error state |
| `/api/print/current` | GET | Get active print job progress & layers |
| `/api/ams` | GET | Get normalized AMS units & tray details |
| `/api/commands` | GET | List command audit execution history |
| `/api/printer/actions/pause` | POST | Tạm dừng in (Pause) |
| `/api/printer/actions/resume` | POST | Tiếp tục in (Resume) |
| `/api/printer/actions/stop` | POST | Hủy tác vụ in (Stop) |
| `/api/printer/temperature/nozzle` | POST | Set hotend temp (`{"target": 220}`) |
| `/api/printer/temperature/bed` | POST | Set bed temp (`{"target": 60}`) |
| `/api/printer/fans/part` | POST | Set part fan speed (`{"speed": 80}`) |
| `/api/camera/snapshot` | GET | Get JPEG snapshot frame |
| `/api/camera/mjpeg` | GET | Stream live MJPEG video stream |
| `/api/camera/info` | GET | Get RTSPS camera stream URL |

---

## 🔌 WebSocket Events (`/ws`)

Connect to `ws://HOST:PORT/ws` to receive real-time event packets:
- `printer.state`: Full telemetry snapshot
- `printer.connection`: Online/offline status
- `printer.temperature`: Hotend, bed & chamber temperatures
- `printer.progress`: Layer & remaining time updates
- `printer.ams`: AMS tray updates
- `printer.error`: HMS error events
- `command.started`, `command.completed`, `command.failed`: Command execution lifecycle events

---

## 📚 Documentation

Detailed documentation is available in `docs/`:
- [`docs/architecture.md`](file:///home/vinhdq/bambu-h2d-gateway/docs/architecture.md) — System Architecture
- [`docs/protocol.md`](file:///home/vinhdq/bambu-h2d-gateway/docs/protocol.md) — Protocol Evidence & LAN MQTT Specification
- [`docs/capabilities.md`](file:///home/vinhdq/bambu-h2d-gateway/docs/capabilities.md) — Capability Registry System
- [`docs/api.md`](file:///home/vinhdq/bambu-h2d-gateway/docs/api.md) — Full REST API & WebSocket Reference
- [`docs/development.md`](file:///home/vinhdq/bambu-h2d-gateway/docs/development.md) — Developer & Testing Guide

---

## 🛡️ License
MIT License
