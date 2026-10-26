# Development & Testing Guide

## 1. Prerequisites
- Node.js >= 20
- npm >= 10

## 2. Setup

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Run type check
npm run typecheck

# Run vitest unit tests
npm test

# Build the Next.js production bundle
npm run build

# Start production server (custom server: server.ts)
npm start

# Development mode (Next.js dev server + gateway; tsx restarts it on backend changes)
npm run dev
```

## 3. Environment Flags

| Flag | Description | Default |
|------|-------------|---------|
| `BAMBU_REAL_PRINTER` | Set `true` to enable real printer execution | `false` |
| `BAMBU_DEBUG_PROTOCOL` | Set `true` to log raw sanitized MQTT traffic | `false` |
| `GATEWAY_API_KEY` | Optional API Key for REST endpoints | (none) |
| `COMMAND_TIMEOUT_MS` | Timeout in ms for command queue | `10000` |

## 4. Testing

```bash
# Run all unit tests
npm test
```
Tests mock MQTT connection automatically and verify state normalization, capability registry, command validation, safety mode, and REST endpoints.

## 5. Project Layout (Next.js)

| Path | Purpose |
|------|---------|
| `server.ts` | Custom Next.js server: boots the gateway, API key check, `/ws` WebSocket upgrades |
| `app/page.tsx`, `app/layout.tsx`, `app/globals.css` | Dashboard page |
| `app/api/**/route.ts` | Route Handlers; thin re-exports of `src/api/routes/*` |
| `src/api/routes/*` | REST endpoint logic (framework-agnostic `Request` → `Response`) |
| `src/runtime/` | Gateway bootstrap and the shared runtime registry |
| `src/ui/` | Dashboard: React + antd components (one folder per page), the live-data context and pure helpers |

Adding an endpoint: write the handler in `src/api/routes/<area>.ts` using `handler()` from `src/api/http.ts`,
then add `app/api/<path>/route.ts` exporting it as `GET`/`POST`/... with `export const dynamic = 'force-dynamic'`.
Tests call the real route files through `tests/helpers/testApp.ts`.
