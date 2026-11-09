# bambu-h2d-gateway

Local LAN Gateway for Bambu Lab H2D (and Bambu Lab X1 / P1 / A1 series) 3D Printers over MQTT TLS & Live Camera Stream, with a web dashboard, embedded Bambu Studio, AI model design and engineering checks.

---

## 🌟 Overview & Architecture

`bambu-h2d-gateway` acts as an enterprise-grade local bridge between Bambu Lab 3D Printers and web applications / home automation systems.

```
H2D Printer
 │
 │ MQTT TLS (Port 8883), FTPS (Port 990) & Camera TLS (Port 6000)
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
       ├── Next.js Route Handlers (REST API) & Dashboard (custom server: server.ts)
       └── WebSocket Server (/ws real-time event stream)

Optional containers, reached over HTTP by the gateway:
 ├── Bambu Studio (docker-compose.studio.yml)      slicing & printing, embedded in the dashboard
 ├── CAD worker  (docker-compose.cad.yml)          Claude + text-to-cad (cadgen): technical parts, drawings, DfAM, STEP/IGES import
 └── mesh3d      (docker-compose.mesh3d.yml)       Hunyuan3D-2 + Blender: figures; engineering checks (FEA); part analysis
```

### Dashboard features

| Area | What it does | Docs |
|------|--------------|------|
| Printer | Telemetry, temperatures, fans, print controls, HMS errors, live camera | [api.md](docs/api.md) |
| AMS & filaments | Load/unload/settings per tray, RFID, Bambu colour catalogue, mixing recipes, "Filament của tôi" | [bambu-h2d-ams-protocol.md](docs/bambu-h2d-ams-protocol.md) |
| Bambu Studio | Studio in the browser, `/imports` file list, "AI tối ưu" print settings from Claude | [studio.md](docs/studio.md) |
| Print history | Each print's settings, photos, report, model parts; timelapses with "AI nhận xét" | [studio.md](docs/studio.md) |
| Thiết kế mô hình bằng AI | Technical parts (text-to-cad: cadgen + build123d), 3D view, engineering drawings, DfAM check, figures (Hunyuan3D-2 + Blender), revisions, plate layout for the H2D, assembly guide, send to Studio | [cad.md](docs/cad.md), [text-to-cad.md](docs/text-to-cad.md) |
| Kiểm tra kỹ thuật | Mesh, assembly, fits, FEA, printability, reports for a printed part | [engineering-analysis.md](docs/engineering-analysis.md) |
| Hệ thống | Claude plan limits (two subscriptions), AI usage and cost per task | — |

---

## 🔒 Key Principles & Protocol Evidence

1. **Protocol Evidence Driven**: Commands are only implemented with verified protocol evidence (Bambu LAN MQTT JSON specifications). Unsupported/unverified commands are marked `UNKNOWN` or `UNSUPPORTED`.
2. **Safety Mode (`BAMBU_REAL_PRINTER`)**: When unset, `BAMBU_REAL_PRINTER` is `false`. Destructive control commands (`pause`, `resume`, `stop`, `temperature`, `fan`) are blocked with HTTP 403 unless `BAMBU_REAL_PRINTER=true` is explicitly configured.
3. **Command Queue & Audit Log**: Single-thread FIFO command queue prevents race conditions and logs all command executions in RAM (`GET /api/commands`).
4. **Bambu Studio Independence**: Runs completely independently on your LAN without requiring Bambu Studio or Bambu Handy.
5. **No Credential Leakage**: Never exposes the Bambu `ACCESS_CODE` in REST API payloads or WebSocket streams.

---

## 📋 Requirements & Setup

- **Node.js**: `>= 20.0.0` (the Docker image uses Node 22)
- **Package Manager**: `npm`
- **Network**: Local area network (LAN) access to the printer.
- **Optional**: Docker Desktop for the gateway container and the workers; an NVIDIA GPU for `mesh3d` (Hunyuan3D-2); Claude subscription tokens (`claude setup-token`) kept on a KeyVault or API key for the AI features.

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env

# Run type check
npm run typecheck

# Run unit tests
npm test

# Development server (Next.js dev + gateway, restarts on backend changes)
npm run dev

# Build production bundle (next build)
npm run build

# Start production server (custom Next.js server with MQTT, camera & /ws)
npm start
```

### 🐳 Docker

The gateway runs as the `bambu-gateway` container on `http://<host>:3000` and HTTPS on `:3443` (self-signed for `HTTPS_HOSTNAMES`). It restarts by itself after a crash or reboot and keeps its data in `./data`.

```bash
# Gateway (build and start; the same command rebuilds after a source update)
DOCKER_BUILDKIT=0 docker compose -f docker-compose.gateway.yml up -d --build

# Optional workers, each on the same Docker network as the gateway
docker compose -f docker-compose.studio.yml up -d            # Bambu Studio
docker compose -f docker-compose.cad.yml up -d --build       # AI design (build123d)
docker compose -f docker-compose.mesh3d.yml up -d --build    # figures, engineering checks, part analysis (GPU)
```

Inside the gateway container the workers are reached by container name (`bambu-cad`, `bambu-mesh3d`); the `*_URL` values in `.env` are for `npm start` on the host.

---

## ⚙️ Environment Variables

The full list, with comments, is in [`.env.example`](.env.example). The main groups:

```ini
# Printer
BAMBU_HOST=192.168.1.100
BAMBU_PORT=8883
BAMBU_FTP_PORT=990
BAMBU_SERIAL=01S00A123456789
BAMBU_ACCESS_CODE=12345678

# HTTP, WebSocket and optional HTTPS (self-signed certificate in data/certs)
HTTP_HOST=0.0.0.0
HTTP_PORT=3000
HTTPS_PORT=
HTTPS_HOSTNAMES=

# Safety, control & debugging
BAMBU_REAL_PRINTER=false
GATEWAY_API_KEY=            # optional Bearer token
COMMAND_TIMEOUT_MS=10000
LOG_LEVEL=info
BAMBU_DEBUG_PROTOCOL=false
PRINTER_OFFLINE_TIMEOUT_MS=30000
ENABLE_RAW_API=true

# Bambu Studio embedded in the dashboard (docs/studio.md)
STUDIO_URL=
STUDIO_ALT_URLS=
STUDIO_IMPORT_DIR=

# Claude: the plans come from the KeyVault, one per Claude token there (Hệ thống → KeyVault, docs/keyvault.md); or an API key
KV_SERVER=http://100.112.133.34:8000
ANTHROPIC_API_KEY=
STUDIO_AI_MODEL=claude-opus-5-5
TIMELAPSE_AI_MODEL=claude-opus-5-5
PARTS_AI_MODEL=claude-opus-5-5
RETRY_AI_MODEL=claude-sonnet-5-5   # analyses an unknown failure before "Thử lại" runs a task again
# RETRY_RULES_FILE=./data/ai/retry-rules.json   # what those analyses mended, kept as rules: the same failure is mended without Claude
# AUTO_RETRY_LIMIT=2   # a failure a rule mends runs again on its own (no Claude), this many times in a row; 0 = only by hand
CAD_AI_MODEL=claude-opus-5-5

# Workers (empty = feature off)
CAD_WORKER_URL=
MESH_WORKER_URL=

# Data folders
STUDIO_AI_DATA_DIR=./data/studio/ai
PRINT_HISTORY_DIR=./data/prints
TIMELAPSE_CACHE_DIR=./data/timelapse
MODEL_ANALYSIS_DIR=./data/studio/analyses
CAD_JOBS_DIR=./data/cad/jobs
MESH_MODELS_DIR=./data/mesh3d/models     # ~25 GB of model weights
BAMBU_COLOR_CODES_FILE=./data/bambu/filaments_color_codes.json
BAMBU_MIX_RECIPES_FILE=./data/bambu/standard_color_recipes.json
CUSTOM_FILAMENTS_FILE=./data/filaments/custom.json
# AI_USAGE_FILE=./data/ai/usage.jsonl
```

---

## 📡 REST API Summary

The dashboard lists every route with examples (`src/api/routeDocs.ts`); the full reference is in [`docs/api.md`](docs/api.md).

### Printer

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Check server status |
| `/api/capabilities` | GET | List printer capabilities & status (`SUPPORTED`/`UNKNOWN`) |
| `/api/printer` | GET | Get normalized telemetry state |
| `/api/printer/info` | GET | Get system info (Model, Serial, Firmware, Online) |
| `/api/printer/errors` | GET | Get HMS error codes & error state |
| `/api/print/current` | GET | Get active print job progress & layers |
| `/api/commands` | GET | List command audit execution history |
| `/api/files` | GET | List files on the printer's storage (FTPS `/` and `/cache`) |
| `/api/printer/actions/pause` | POST | Tạm dừng in (Pause) |
| `/api/printer/actions/resume` | POST | Tiếp tục in (Resume) |
| `/api/printer/actions/stop` | POST | Hủy tác vụ in (Stop) |
| `/api/printer/temperature/nozzle` | POST | Set hotend temp (`{"target": 220}`) |
| `/api/printer/temperature/bed` | POST | Set bed temp (`{"target": 60}`) |
| `/api/printer/fans/part` | POST | Set part fan speed (`{"speed": 80}`) |
| `/api/camera/snapshot` | GET | Get JPEG snapshot frame |
| `/api/camera/mjpeg` | GET | Stream live MJPEG video stream |
| `/api/camera/info` | GET | Get RTSPS camera stream URL |

### AMS & filaments

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ams` | GET | Get normalized AMS units & tray details |
| `/api/ams/load`, `/api/ams/unload` | POST | Load / unload a tray's filament |
| `/api/ams/setting` | POST | Set a tray's filament type and colour |
| `/api/ams/:amsId/tray/:trayId/rfid` | GET | Read a tray's RFID data |
| `/api/filaments/colors` | GET | Bambu colour catalogue |
| `/api/filaments/custom` | GET / POST / DELETE | "Filament của tôi" |

### Bambu Studio, print history & timelapses

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/studio` | GET | Embedded Studio configuration (`STUDIO_URL`, `STUDIO_IMPORT_DIR`) |
| `/api/studio/import` | POST | Send a model to Studio |
| `/api/studio/imports` | GET / DELETE | List / remove the files in Studio's `/imports` |
| `/api/studio/ai-optimize` | POST | "AI tối ưu": Claude proposes print settings |
| `/api/studio/ai-sessions` | GET | AI proposals, what was applied, the print reports |
| `/api/prints` | GET | Print history |
| `/api/prints/:id/feedback`, `/photos`, `/parts` | POST | Report, photos and measured parts of a print |
| `/api/timelapse` | GET | Timelapses copied from the printer |
| `/api/timelapse/:name/review` | GET / POST | "AI nhận xét" on a timelapse |

### AI design & engineering checks

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/cad/jobs` | GET / POST | AI design jobs: list, design from a description or pictures |
| `/api/cad/jobs/:id/fix` | POST | Revise a model with a comment and pictures |
| `/api/cad/jobs/:id/studio` | POST | Send the model (one plate per file) to Studio |
| `/api/cad/jobs/:id/guide` | POST | Draw the assembly guide (step pictures and a video) |
| `/api/cad/meshes` | POST | Figure from a picture or description (Hunyuan3D-2 on the GPU, mesh3d) |
| `/api/cad/builds` | POST | Build agent-written build123d code: STL/STEP, preview and checks |
| `/api/cad/guide` | GET | Design rules for the H2D (Markdown, for agents) |
| `/api/eng/:tool` | POST | Engineering checks (mesh, assembly, clearance, FEA, printability, report) |
| `/api/ai/limits`, `/api/ai/usage` | GET | Claude plan limits and AI usage per task |

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

## 🤖 MCP Server for Agents

`cad/mcp/server.mjs` (stdio, no dependencies) gives Claude Code, Antigravity or another agent the gateway's design and engineering tools: `cad_build`, `cad_make_figure`, `cad_send_to_studio`, `inspect_3d_model`, `check_clearance`, `run_fea_analysis`, … It is registered for this repository in [`.mcp.json`](.mcp.json):

```json
{
  "mcpServers": {
    "bambu-cad": { "command": "node", "args": ["cad/mcp/server.mjs"], "env": { "GATEWAY_URL": "http://localhost:3000" } }
  }
}
```

---

## 📚 Documentation

Detailed documentation is available in `docs/`:
- [`docs/architecture.md`](docs/architecture.md) — System Architecture
- [`docs/protocol.md`](docs/protocol.md) — Protocol Evidence & LAN MQTT Specification
- [`docs/bambu-h2d-ams-protocol.md`](docs/bambu-h2d-ams-protocol.md) — H2D AMS protocol (MQTT & G-code) audit
- [`docs/capabilities.md`](docs/capabilities.md) — Capability Registry System
- [`docs/api.md`](docs/api.md) — Full REST API & WebSocket Reference
- [`docs/development.md`](docs/development.md) — Developer & Testing Guide
- [`docs/studio.md`](docs/studio.md) — Bambu Studio embedded in the dashboard (slicing & printing, "AI tối ưu", print history)
- [`docs/cad.md`](docs/cad.md) — AI model design (Claude: technical parts in build123d; figures from Hunyuan3D-2, finished by Claude in Blender through MCP for Blender; Antigravity) for printing
- [`docs/engineering-analysis.md`](docs/engineering-analysis.md) — Engineering checks of printed parts: mesh, assembly, fits, FEA (gmsh + CalculiX), printability, reports, through MCP
- [`docs/keyvault.md`](docs/keyvault.md) — Claude subscription tokens fetched from a KeyVault with a Google Authenticator code

---

## 🛡️ License
MIT License
