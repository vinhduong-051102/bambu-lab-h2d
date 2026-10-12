import type { PrinterService } from '../domain/PrinterService';
import type { PrinterManager } from '../domain/PrinterManager';

export interface GatewayRuntime {
  printerService: PrinterService;
  printerManager?: PrinterManager;
}

// The custom server (server.ts) and the Next.js route bundles load separate copies of this
// module, so the live runtime is shared through globalThis rather than a module variable.
const globalForRuntime = globalThis as unknown as { __bambuGatewayRuntime?: GatewayRuntime };

export function setRuntime(runtime: GatewayRuntime | undefined): void {
  globalForRuntime.__bambuGatewayRuntime = runtime;
}

export function getRuntime(): GatewayRuntime | undefined {
  return globalForRuntime.__bambuGatewayRuntime;
}
