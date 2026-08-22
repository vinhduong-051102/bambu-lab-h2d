import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { PrinterStateStore } from '../src/domain/PrinterStateStore.js';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry.js';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService.js';
import { PrinterService } from '../src/domain/PrinterService.js';
import { createServer } from '../src/server/server.js';
import { debugPrinterPipeline } from '../src/utils/debugPipeline.js';
import h2dFixture from './fixtures/h2d_raw_payload.json';

describe('End-to-End Pipeline Data Flow Debug Test', () => {
  let app: FastifyInstance;
  let stateStore: PrinterStateStore;
  let capabilityRegistry: CapabilityRegistry;
  let commandService: PrinterCommandService;
  let printerService: PrinterService;

  beforeEach(async () => {
    stateStore = new PrinterStateStore('TEST_SERIAL_H2D');
    capabilityRegistry = new CapabilityRegistry();
    const mockMqttClient = {
      publishRequest: async () => true,
    } as any;

    commandService = new PrinterCommandService(capabilityRegistry, stateStore, mockMqttClient);
    printerService = new PrinterService({
      serial: 'TEST_SERIAL_H2D',
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

  it('should preserve all mapped fields across the entire pipeline (Raw -> Parser -> Normalizer -> Store -> API)', async () => {
    // 1. Run pipeline debugger helper snapshot
    const snapshot = debugPrinterPipeline(h2dFixture as any, stateStore);

    // Check Stage 1: RAW_PRESENT
    expect(snapshot.raw.print).toBeDefined();
    expect((snapshot.raw.print as any).nozzle_temper).toBe(36);
    expect((snapshot.raw.print as any).nozzle_target_temper).toBe(0);

    // Check Stage 2: BambuMessageParser
    expect(snapshot.parsed.temperatures?.nozzle.current).toBe(36);
    expect(snapshot.parsed.temperatures?.nozzle.target).toBe(0);
    expect(snapshot.parsed.temperatures?.nozzle.activeNozzleId).toBe(0);
    expect(snapshot.parsed.temperatures?.nozzle.confidence).toBe('POSSIBLE');
    expect(snapshot.parsed.temperatures?.nozzles).toHaveLength(2);
    expect(snapshot.parsed.temperatures?.nozzles[0].current).toBe(36);
    expect(snapshot.parsed.temperatures?.nozzles[0].temperatureConfidence).toBe('POSSIBLE');
    expect(snapshot.parsed.temperatures?.nozzles[1].current).toBe(36);
    expect(snapshot.parsed.temperatures?.nozzles[1].temperatureConfidence).toBe('POSSIBLE');
    expect(snapshot.parsed.extruders).toHaveLength(2);
    expect(snapshot.parsed.extruders?.[0].temp).toBe(36);
    expect(snapshot.parsed.extruders?.[1].temp).toBe(36);

    // Check Stage 3: Normalizer
    expect(snapshot.normalized.temperatures.nozzle.current).toBe(36);
    expect(snapshot.normalized.temperatures.nozzle.target).toBe(0);
    expect(snapshot.normalized.temperatures.nozzles).toHaveLength(2);
    expect(snapshot.normalized.extruders).toHaveLength(2);

    // Check Stage 4: Store
    expect(snapshot.store.temperatures.nozzle.current).toBe(36);
    expect(snapshot.store.temperatures.nozzles).toHaveLength(2);
    expect(snapshot.store.extruders).toHaveLength(2);

    // Check Stage 5: REST API (GET /api/printer)
    const res = await app.inject({
      method: 'GET',
      url: '/api/printer',
    });

    expect(res.statusCode).toBe(200);
    const apiBody = res.json();

    // Verify API output field presence
    expect(apiBody.temperatures.nozzle.current).toBe(36);
    expect(apiBody.temperatures.nozzle.target).toBe(0);
    expect(apiBody.temperatures.nozzle.activeNozzleId).toBe(0);
    expect(apiBody.temperatures.nozzles).toHaveLength(2);
    expect(apiBody.temperatures.nozzles[0].current).toBe(36);
    expect(apiBody.temperatures.nozzles[1].current).toBe(36);
    expect(apiBody.extruders).toHaveLength(2);
    expect(apiBody.extruders[0].temp).toBe(36);
    expect(apiBody.extruders[1].temp).toBe(36);

    // Check Diagnostic Endpoint GET /api/printer/diagnostics
    const diagRes = await app.inject({
      method: 'GET',
      url: '/api/printer/diagnostics',
    });
    expect(diagRes.statusCode).toBe(200);
    const diagBody = diagRes.json();

    expect(diagBody.nozzleCount).toBe(2);
    expect(diagBody.extruderCount).toBe(2);
    expect(diagBody.activeNozzleId).toBe(0);
    expect(diagBody.machineNozzleTemperature.current).toBe(36);
    expect(diagBody.nozzles[0].current).toBe(36);
    expect(diagBody.nozzles[1].current).toBe(36);
    expect(diagBody.extruders[0].temp).toBe(36);
    expect(diagBody.extruders[1].temp).toBe(36);
  });
});
