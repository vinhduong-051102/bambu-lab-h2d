# Bambu Lab H2D Gateway Architecture

## 1. System Overview

The **Bambu Lab H2D Gateway** is a local, production-grade Node.js/TypeScript backend service designed to interface directly with Bambu Lab 3D printers over local network (LAN mode) protocols.

```
H2D Printer
 │
 │ MQTT TLS (Port 8883) & TLS Stream (Port 6000)
 ▼
BambuMqttClient & BambuCameraService
 │
 ▼
BambuProtocol
 │
 ├── Report Parser (JSON Normalizer)
 └── Command Builder (Bambu LAN MQTT Payloads)
       │
       ▼
PrinterService (PrinterManager)
 │
 ├── PrinterStateStore (In-memory normalized state & connection tracker)
 ├── PrinterCommandService (CommandQueue, Validation, Safety Checks)
 └── CapabilityRegistry (SUPPORTED / UNKNOWN / UNSUPPORTED capability definitions)
       │
       ├── Next.js Route Handlers (app/api/**/route.ts → src/api/routes/*)
       ├── Next.js Dashboard page (app/page.tsx → src/ui/*)
       └── WebSocket Server (/ws real-time events, src/server/websocket.ts)
```

### 1.1 Next.js Custom Server (`server.ts`)

The gateway keeps long-lived connections (MQTT, camera FFmpeg pipeline, WebSocket clients), so it runs
Next.js through a custom Node.js HTTP server instead of `next start`:

1. `startGateway()` (`src/runtime/bootstrap.ts`) creates the printer services, connects MQTT and starts the camera.
2. The services are registered as the shared runtime (`src/runtime/runtime.ts`), which Route Handlers read via `getRuntime()`.
3. Requests to `/api/*` and `/ws` pass the `GATEWAY_API_KEY` check, then go to Next.js or the WebSocket hub.
   Other upgrade requests (Next.js HMR in development) go to Next.js.

Next.js bundles Route Handlers separately from the custom server, so process-wide singletons
(the runtime, `AmsCommandTracker`, the MQTT `sequence_id` counter) are stored on `globalThis`.

## 2. Core Modules

### 2.1 CapabilityRegistry (`src/domain/capabilities/`)
Defines and tracks printer features by category (`status`, `print`, `temperature`, `fan`, `ams`, `camera`, `system`, `motion`, `file`). Each capability has a status of `SUPPORTED`, `UNSUPPORTED`, or `UNKNOWN`. Commands will be rejected with HTTP 501 if the capability is not marked `SUPPORTED`.

### 2.2 PrinterCommandService & CommandQueue (`src/domain/commands/`)
- Enforces FIFO execution of printer commands to prevent race conditions (e.g. sending pause and resume at the exact same millisecond).
- Checks `BAMBU_REAL_PRINTER` flag. If `BAMBU_REAL_PRINTER=false` (default safety mode), destructive commands are blocked with HTTP 403.
- Logs all command execution attempts in `CommandAuditLog`.

### 2.3 PrinterStateStore & Normalizer (`src/domain/`)
- Maintains single source of truth for telemetry, temperatures, job progress, AMS filament status, and HMS error codes.
- Handles printer offline detection (`PRINTER_OFFLINE_TIMEOUT_MS`).

### 2.4 Multi-Printer Architecture (`src/domain/PrinterManager.ts`)
- Allows indexing multiple Bambu printers by serial number, paving the way for multi-printer farm management.

### 2.5 Security & Authentication (`src/server/auth.ts`)
- Supports `GATEWAY_API_KEY` authentication via `Authorization: Bearer <GATEWAY_API_KEY>`.
- In local development mode (when `GATEWAY_API_KEY` is empty), open local access is permitted.
- **Never exposes Bambu Access Code over REST API or WebSockets.**
