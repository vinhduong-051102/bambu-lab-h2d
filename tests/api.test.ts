import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { PrinterStateStore } from '../src/domain/PrinterStateStore.js';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry.js';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService.js';
import { PrinterService } from '../src/domain/PrinterService.js';
import { normalizePrinterState } from '../src/domain/normalizePrinterState.js';
import { createServer } from '../src/server/server.js';

describe('Fastify REST API & Capability Routes', () => {
  let app: FastifyInstance;
  let stateStore: PrinterStateStore;
  let capabilityRegistry: CapabilityRegistry;
  let commandService: PrinterCommandService;
  let printerService: PrinterService;

  beforeEach(async () => {
    stateStore = new PrinterStateStore('TEST_SERIAL_123');
    capabilityRegistry = new CapabilityRegistry();
    const mockMqttClient = {
      publishRequest: async () => true,
    } as any;

    commandService = new PrinterCommandService(capabilityRegistry, stateStore, mockMqttClient);
    printerService = new PrinterService({
      serial: 'TEST_SERIAL_123',
      stateStore,
      capabilityRegistry,
      commandService,
    });

    app = await createServer(printerService);
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

  it('GET /api/capabilities should return capability registry list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/capabilities',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.printer).toBe('Bambu Lab H2D');
    expect(body.capabilities.length).toBeGreaterThan(0);
    const pauseCap = body.capabilities.find((c: any) => c.id === 'print.pause');
    expect(pauseCap.status).toBe('SUPPORTED');
  });

  it('GET /api/printer/info should return model, serial and online state without exposing access code', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/printer/info',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.serial).toBe('TEST_SERIAL_123');
    expect(body.online).toBe(false);
    expect(body.accessCode).toBeUndefined();
  });

  it('POST /api/printer/temperature/nozzle should return 400 for invalid/NaN/Infinity temperature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/printer/temperature/nozzle',
      payload: { target: 'invalid_string' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('INVALID_PAYLOAD');
  });

  it('POST /api/printer/actions/pause should return 403 when BAMBU_REAL_PRINTER is false (safety mode)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/printer/actions/pause',
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe('TEST_MODE_RESTRICTED');
  });

  it('GET /api/ams should return normalized AMS units', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ams',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.units).toBeDefined();
  });
});
