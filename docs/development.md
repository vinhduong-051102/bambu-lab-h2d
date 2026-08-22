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

# Build production TypeScript bundle
npm run build

# Start production server
npm start

# Development watch mode
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
