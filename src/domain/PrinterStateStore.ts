import { PrinterState, createInitialPrinterState } from './PrinterState.js';

export type StateChangeListener = (state: PrinterState) => void;
export type ConnectionChangeListener = (online: boolean) => void;

export class PrinterStateStore {
  private state: PrinterState;
  private rawPayload: Record<string, unknown> | null = null;
  private listeners: Set<StateChangeListener> = new Set();
  private connectionListeners: Set<ConnectionChangeListener> = new Set();
  private offlineTimer: NodeJS.Timeout | null = null;
  private timeoutMs: number;

  constructor(serial: string, timeoutMs: number = 30000) {
    this.state = createInitialPrinterState(serial);
    this.timeoutMs = timeoutMs;
  }

  public getState(): PrinterState {
    return { ...this.state };
  }

  public getRawPayload(): Record<string, unknown> | null {
    return this.rawPayload;
  }

  public setRawPayload(payload: Record<string, unknown>): void {
    this.rawPayload = payload;
  }

  public updateState(updatedState: PrinterState): PrinterState {
    const wasOnline = this.state.online;
    this.state = updatedState;

    this.resetOfflineTimer();

    this.notifyListeners();
    if (!wasOnline && this.state.online) {
      this.notifyConnectionChange(true);
    }
    return this.state;
  }

  public setOnline(online: boolean): void {
    if (this.state.online !== online) {
      this.state = {
        ...this.state,
        online,
        updatedAt: new Date().toISOString(),
      };
      this.notifyConnectionChange(online);
      this.notifyListeners();
    }
  }

  public recordMessageReceived(): void {
    this.resetOfflineTimer();
  }

  public subscribe(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeConnection(listener: ConnectionChangeListener): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const currentState = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(currentState);
      } catch (err) {
        // Prevent listener error from crashing state store
      }
    }
  }

  private notifyConnectionChange(online: boolean): void {
    for (const listener of this.connectionListeners) {
      try {
        listener(online);
      } catch (err) {
        // Ignore listener error
      }
    }
  }

  private resetOfflineTimer(): void {
    if (this.offlineTimer) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }

    if (this.timeoutMs > 0) {
      this.offlineTimer = setTimeout(() => {
        if (this.state.online) {
          this.setOnline(false);
        }
      }, this.timeoutMs);
    }
  }

  public destroy(): void {
    if (this.offlineTimer) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
    this.listeners.clear();
    this.connectionListeners.clear();
  }
}

/**
 * PrinterManager supports multi-printer expansion in domain layer.
 */
export class PrinterManager {
  private stores: Map<string, PrinterStateStore> = new Map();

  public getOrCreateStore(serial: string, timeoutMs: number = 30000): PrinterStateStore {
    let store = this.stores.get(serial);
    if (!store) {
      store = new PrinterStateStore(serial, timeoutMs);
      this.stores.set(serial, store);
    }
    return store;
  }

  public getStore(serial: string): PrinterStateStore | undefined {
    return this.stores.get(serial);
  }

  public getAllStores(): Map<string, PrinterStateStore> {
    return this.stores;
  }
}
