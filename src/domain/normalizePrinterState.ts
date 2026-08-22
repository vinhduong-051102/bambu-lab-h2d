import { PrinterState } from './PrinterState.js';
import { BambuRawReportPayload } from '../bambu/types.js';
import { BambuMessageParser } from '../bambu/BambuMessageParser.js';

export function normalizePrinterState(
  currentState: PrinterState,
  rawPayload: BambuRawReportPayload
): PrinterState {
  const parsed = BambuMessageParser.parseReport(rawPayload);
  const now = new Date().toISOString();

  return {
    ...currentState,
    online: true,
    state: parsed.state ?? currentState.state,
    progress: parsed.progress !== undefined ? parsed.progress : currentState.progress,
    temperatures: {
      nozzle: {
        current: parsed.temperatures?.nozzle.current ?? currentState.temperatures.nozzle.current,
        target: parsed.temperatures?.nozzle.target ?? currentState.temperatures.nozzle.target,
      },
      bed: {
        current: parsed.temperatures?.bed.current ?? currentState.temperatures.bed.current,
        target: parsed.temperatures?.bed.target ?? currentState.temperatures.bed.target,
      },
      chamber: parsed.temperatures?.chamber ?? currentState.temperatures.chamber,
    },
    job: {
      name: parsed.job?.name ?? currentState.job.name,
      currentLayer: parsed.job?.currentLayer ?? currentState.job.currentLayer,
      totalLayers: parsed.job?.totalLayers ?? currentState.job.totalLayers,
      remainingTimeMinutes: parsed.job?.remainingTimeMinutes ?? currentState.job.remainingTimeMinutes,
    },
    fan: {
      part: parsed.fan?.part ?? currentState.fan.part,
      aux: parsed.fan?.aux ?? currentState.fan.aux,
      chamber: parsed.fan?.chamber ?? currentState.fan.chamber,
    },
    ams: parsed.ams && parsed.ams.length > 0 ? parsed.ams : currentState.ams,
    lastMessageAt: now,
    updatedAt: now,
  };
}
