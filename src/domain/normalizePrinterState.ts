import { PrinterState } from './PrinterState.js';
import { BambuRawReportPayload } from '../bambu/types.js';
import { BambuMessageParser } from '../bambu/BambuMessageParser.js';

export function normalizePrinterState(
  currentState: PrinterState,
  rawPayload: BambuRawReportPayload
): PrinterState {
  const parsed = BambuMessageParser.parseReport(rawPayload);
  const now = new Date().toISOString();

  // Merge nozzles array
  const nozzles = (parsed.temperatures?.nozzles && parsed.temperatures.nozzles.length > 0)
    ? parsed.temperatures.nozzles
    : currentState.temperatures.nozzles;

  // Merge extruders array
  const extruders = (parsed.extruders && parsed.extruders.length > 0)
    ? parsed.extruders
    : currentState.extruders;

  return {
    ...currentState,
    online: true,
    state: parsed.state ?? currentState.state,
    progress: parsed.progress !== undefined ? parsed.progress : currentState.progress,
    temperatures: {
      nozzles,
      bed: {
        current: parsed.temperatures?.bed.current ?? currentState.temperatures.bed.current,
        target: parsed.temperatures?.bed.target ?? currentState.temperatures.bed.target,
      },
      chamber: parsed.temperatures?.chamber ?? currentState.temperatures.chamber,
    },
    extruders,
    job: {
      name: parsed.job?.name ?? currentState.job.name,
      currentLayer: parsed.job?.currentLayer ?? currentState.job.currentLayer,
      totalLayers: parsed.job?.totalLayers ?? currentState.job.totalLayers,
      remainingTimeMinutes: parsed.job?.remainingTimeMinutes ?? currentState.job.remainingTimeMinutes,
    },
    fan: {
      cooling: parsed.fan?.cooling ?? currentState.fan.cooling,
      bigFan1: parsed.fan?.bigFan1 ?? currentState.fan.bigFan1,
      bigFan2: parsed.fan?.bigFan2 ?? currentState.fan.bigFan2,
      fan: parsed.fan?.fan ?? currentState.fan.fan,
      fanGear: parsed.fan?.fanGear ?? currentState.fan.fanGear,
    },
    hmsErrors: (parsed.hmsErrors && parsed.hmsErrors.length > 0) ? parsed.hmsErrors : currentState.hmsErrors,
    ams: (parsed.ams && parsed.ams.length > 0) ? parsed.ams : currentState.ams,
    rawExtensions: parsed.rawExtensions
      ? { ...currentState.rawExtensions, ...parsed.rawExtensions }
      : currentState.rawExtensions,
    lastMessageAt: now,
    updatedAt: now,
  };
}
