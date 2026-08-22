import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrinterStateStore } from '../src/domain/PrinterStateStore.js';
import { normalizePrinterState } from '../src/domain/normalizePrinterState.js';
import h2dFixture from './fixtures/h2d_raw_payload.json';

describe('PrinterStateStore & normalizePrinterState (H2D State Merge)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize with default offline state', () => {
    const store = new PrinterStateStore('01S00A123456789');
    const state = store.getState();

    expect(state.serial).toBe('01S00A123456789');
    expect(state.online).toBe(false);
    expect(state.state).toBe('UNKNOWN');
    expect(state.progress).toBeNull();
  });

  it('should preserve non-updated fields on partial MQTT messages (State Merge Test)', () => {
    const store = new PrinterStateStore('01S00A123456789');

    // 1. Initial message sets bed.current = 44
    const firstPayload = {
      print: {
        bed_temper: 44,
      },
    };
    const state1 = normalizePrinterState(store.getState(), firstPayload as any);
    store.updateState(state1);

    expect(store.getState().temperatures.bed.current).toBe(44);

    // 2. Second partial message only receives mc_percent = 50
    const secondPayload = {
      print: {
        mc_percent: 50,
      },
    };
    const state2 = normalizePrinterState(store.getState(), secondPayload as any);
    store.updateState(state2);

    const finalState = store.getState();
    expect(finalState.temperatures.bed.current).toBe(44);
    expect(finalState.progress).toBe(50);
  });

  it('should merge nozzle arrays by id without creating duplicate entries', () => {
    const store = new PrinterStateStore('01S00A123456789');

    // 1. First message sets nozzle 0 = 45°C, nozzle 1 = 41°C
    const firstPayload = {
      print: {
        nozzle: {
          info: [
            { id: 0, temp: 45 },
            { id: 1, temp: 41 },
          ],
        },
      },
    };
    const state1 = normalizePrinterState(store.getState(), firstPayload as any);
    store.updateState(state1);

    expect(store.getState().temperatures.nozzles.length).toBe(2);

    // 2. Second message only updates nozzle 1 = 42°C
    const secondPayload = {
      print: {
        nozzle: {
          info: [
            { id: 1, temp: 42 },
          ],
        },
      },
    };
    const state2 = normalizePrinterState(store.getState(), secondPayload as any);
    store.updateState(state2);

    const finalNozzles = store.getState().temperatures.nozzles;
    expect(finalNozzles.length).toBe(2);

    const n0 = finalNozzles.find((n) => n.id === 0);
    const n1 = finalNozzles.find((n) => n.id === 1);

    expect(n0?.current).toBe(45);
    expect(n1?.current).toBe(42);
  });

  it('should parse and merge complete H2D fixture successfully', () => {
    const store = new PrinterStateStore('01S00A123456789');
    const state = normalizePrinterState(store.getState(), h2dFixture as any);
    store.updateState(state);

    const current = store.getState();
    expect(current.state).toBe('FINISHED');
    expect(current.progress).toBe(100);
    expect(current.temperatures.nozzles.length).toBe(2);
    expect(current.extruders.length).toBe(2);
    expect(current.hmsErrors?.[0].attr).toBe(83887360);
    expect(current.hmsErrors?.[0].code).toBe(65543);
  });
});
