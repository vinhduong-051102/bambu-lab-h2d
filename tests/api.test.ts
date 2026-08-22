import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { PrinterStateStore } from '../src/domain/PrinterStateStore.js';
import { normalizePrinterState } from '../src/domain/normalizePrinterState.js';
import { createServer } from '../src/server/server.js';

describe('Fastify REST API & WebSocket Routes', () => {
  let app: FastifyInstance;
  let stateStore: PrinterStateStore;

  beforeEach(async () => {
    stateStore = new PrinterStateStore('TEST_SERIAL_123');
    app = await createServer(stateStore);
    await app.ready();
  });

  afterEach(async () => {
    stateStore.destroy();
    await app.close();
  });

  it('GET /api/health should return { status: "ok" }', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /api/printer should return normalized initial printer state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/printer',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.serial).toBe('TEST_SERIAL_123');
    expect(body.online).toBe(false);
    expect(body.state).toBe('UNKNOWN');
    expect(body.temperatures).toBeDefined();
    expect(body.job).toBeDefined();
  });

  it('GET /api/printer should return updated printer state when store is updated', async () => {
    const rawPayload = {
      print: {
        gcode_state: 'RUNNING',
        mc_percent: 82,
        nozzle_temper: 220,
        bed_temper: 60,
      },
    };

    const nextState = normalizePrinterState(stateStore.getState(), rawPayload);
    stateStore.updateState(nextState);

    const res = await app.inject({
      method: 'GET',
      url: '/api/printer',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.online).toBe(true);
    expect(body.state).toBe('RUNNING');
    expect(body.progress).toBe(82);
    expect(body.temperatures.nozzle.current).toBe(220);
  });

  it('GET /api/printer/raw should return raw payload when available and raw API enabled', async () => {
    const rawData = { print: { mc_percent: 50, test_key: 'custom_val' } };
    stateStore.setRawPayload(rawData);

    const res = await app.inject({
      method: 'GET',
      url: '/api/printer/raw',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(rawData);
  });
});
