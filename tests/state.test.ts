import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrinterStateStore } from '../src/domain/PrinterStateStore.js';
import { normalizePrinterState } from '../src/domain/normalizePrinterState.js';
import h2dFixture from './fixtures/h2d_raw_payload.json';

describe('PrinterStateStore & normalizePrinterState with H2D Fixture', () => {
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

  it('should update state and notify subscribers when normalized H2D state is set', () => {
    const store = new PrinterStateStore('01S00A123456789');
    const listener = vi.fn();

    store.subscribe(listener);

    const initial = store.getState();
    const nextState = normalizePrinterState(initial, h2dFixture as any);
    store.updateState(nextState);

    const updated = store.getState();
    expect(updated.online).toBe(true);
    expect(updated.state).toBe('FINISHED');
    expect(updated.progress).toBe(100);
    expect(updated.temperatures.nozzles.length).toBe(2);
    expect(updated.temperatures.nozzles[0].current).toBe(45);
    expect(updated.temperatures.nozzles[1].current).toBe(41);
    expect(updated.extruders.length).toBe(2);
    expect(updated.hmsErrors?.length).toBe(1);
    expect(updated.hmsErrors![0].code).toBe(65543);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(updated);
  });

  it('should toggle online state correctly', () => {
    const store = new PrinterStateStore('01S00A123456789');
    const connListener = vi.fn();

    store.subscribeConnection(connListener);

    store.setOnline(true);
    expect(store.getState().online).toBe(true);
    expect(connListener).toHaveBeenCalledWith(true);

    store.setOnline(false);
    expect(store.getState().online).toBe(false);
    expect(connListener).toHaveBeenCalledWith(false);
  });

  it('should mark printer as offline after timeout', () => {
    const timeoutMs = 5000;
    const store = new PrinterStateStore('01S00A123456789', timeoutMs);

    const initial = store.getState();
    const nextState = normalizePrinterState(initial, { print: { gcode_state: 'RUNNING' } } as any);
    store.updateState(nextState);

    expect(store.getState().online).toBe(true);

    // Fast-forward time past timeout
    vi.advanceTimersByTime(timeoutMs + 100);

    expect(store.getState().online).toBe(false);
    store.destroy();
  });
});
