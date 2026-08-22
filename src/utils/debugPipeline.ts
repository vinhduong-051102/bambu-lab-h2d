import { BambuMessageParser } from '../bambu/BambuMessageParser.js';
import { normalizePrinterState } from '../domain/normalizePrinterState.js';
import { PrinterStateStore } from '../domain/PrinterStateStore.js';
import { BambuRawReportPayload } from '../bambu/types.js';
import { logger } from '../logger/logger.js';

export interface PipelineDebugSnapshot {
  raw: BambuRawReportPayload;
  parsed: ReturnType<typeof BambuMessageParser.parseReport>;
  normalized: ReturnType<typeof normalizePrinterState>;
  store: ReturnType<InstanceType<typeof PrinterStateStore>['getState']>;
  apiResponse: Record<string, unknown>;
}

export function debugPrinterPipeline(
  rawPayload: BambuRawReportPayload,
  store: PrinterStateStore
): PipelineDebugSnapshot {
  const parsed = BambuMessageParser.parseReport(rawPayload);
  const normalized = normalizePrinterState(store.getState(), rawPayload);

  // Apply to store for full simulation
  store.updateState(normalized);
  store.setRawPayload(rawPayload as Record<string, unknown>);

  const storeState = store.getState();

  const apiResponse = {
    ...storeState,
    realPrinterMode: false,
  };

  const snapshot: PipelineDebugSnapshot = {
    raw: rawPayload,
    parsed,
    normalized,
    store: storeState,
    apiResponse,
  };

  if (process.env.DEBUG_BAMBU_PIPELINE === 'true' || process.env.BAMBU_DEBUG_PROTOCOL === 'true') {
    logger.info(
      {
        rawKeys: rawPayload.print ? Object.keys(rawPayload.print) : [],
        parsedNozzlesCount: parsed.temperatures?.nozzles?.length ?? 0,
        parsedExtrudersCount: parsed.extruders?.length ?? 0,
        rawExtensionsKeys: parsed.rawExtensions ? Object.keys(parsed.rawExtensions) : [],
      },
      '[DEBUG_PIPELINE_SNAPSHOT]'
    );
  }

  return snapshot;
}
