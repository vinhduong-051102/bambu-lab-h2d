import { PrinterState, NozzleState, ExtruderState, AMSUnit, AMSTray } from './PrinterState.js';
import { BambuRawReportPayload } from '../bambu/types.js';
import { BambuMessageParser } from '../bambu/BambuMessageParser.js';

export function normalizePrinterState(
  currentState: PrinterState,
  rawPayload: BambuRawReportPayload
): PrinterState {
  const parsed = BambuMessageParser.parseReport(rawPayload);
  const now = new Date().toISOString();

  // 1. Array Merge for Nozzles by ID
  let mergedNozzles = [...currentState.temperatures.nozzles];
  if (parsed.temperatures?.nozzles && parsed.temperatures.nozzles.length > 0) {
    const nozzleMap = new Map<string | number, NozzleState>();
    mergedNozzles.forEach((noz) => nozzleMap.set(noz.id, { ...noz }));

    parsed.temperatures.nozzles.forEach((incoming) => {
      const existing = nozzleMap.get(incoming.id);
      if (existing) {
        nozzleMap.set(incoming.id, {
          ...existing,
          current: incoming.current !== null ? incoming.current : existing.current,
          target: incoming.target !== null ? incoming.target : existing.target,
          diameter: incoming.diameter !== null ? incoming.diameter : existing.diameter,
          type: incoming.type !== null ? incoming.type : existing.type,
          serial: incoming.serial !== null ? incoming.serial : existing.serial,
          filamentId: incoming.filamentId !== null ? incoming.filamentId : existing.filamentId,
          state: incoming.state !== null ? incoming.state : existing.state,
          wear: incoming.wear !== null ? incoming.wear : existing.wear,
          tm: incoming.tm !== null && incoming.tm !== undefined ? incoming.tm : existing.tm,
          temperatureSource: incoming.temperatureSource || existing.temperatureSource,
          temperatureConfidence: incoming.temperatureConfidence || existing.temperatureConfidence,
          metadata: incoming.metadata || existing.metadata,
        });
      } else {
        nozzleMap.set(incoming.id, { ...incoming });
      }
    });
    mergedNozzles = Array.from(nozzleMap.values());
  }

  // 2. Array Merge for Extruders by ID
  let mergedExtruders = [...currentState.extruders];
  if (parsed.extruders && parsed.extruders.length > 0) {
    const extMap = new Map<string | number, ExtruderState>();
    mergedExtruders.forEach((ext) => extMap.set(ext.id, { ...ext }));

    parsed.extruders.forEach((incoming) => {
      const existing = extMap.get(incoming.id);
      if (existing) {
        extMap.set(incoming.id, {
          ...existing,
          temp: incoming.temp !== null ? incoming.temp : existing.temp,
          hnow: incoming.hnow !== null ? incoming.hnow : existing.hnow,
          hpre: incoming.hpre !== null ? incoming.hpre : existing.hpre,
          htar: incoming.htar !== null ? incoming.htar : existing.htar,
          state: incoming.state !== null ? incoming.state : existing.state,
          metadata: incoming.metadata || existing.metadata,
        });
      } else {
        extMap.set(incoming.id, { ...incoming });
      }
    });
    mergedExtruders = Array.from(extMap.values());
  }

  // 3. Array Merge for AMS Units & Trays by ID
  let mergedAms = currentState.ams ? [...currentState.ams] : [];
  if (parsed.ams && parsed.ams.length > 0) {
    const amsMap = new Map<string, AMSUnit>();
    mergedAms.forEach((u) => amsMap.set(u.id, { ...u, trays: [...u.trays] }));

    parsed.ams.forEach((incomingUnit) => {
      const existingUnit = amsMap.get(incomingUnit.id);
      if (existingUnit) {
        const trayMap = new Map<string, AMSTray>();
        existingUnit.trays.forEach((t) => trayMap.set(t.id, { ...t }));
        incomingUnit.trays.forEach((incomingTray) => {
          const existingTray = trayMap.get(incomingTray.id);
          if (existingTray) {
            trayMap.set(incomingTray.id, {
              ...existingTray,
              type: incomingTray.type !== null ? incomingTray.type : existingTray.type,
              subBrands: incomingTray.subBrands !== null ? incomingTray.subBrands : existingTray.subBrands,
              color: incomingTray.color !== null ? incomingTray.color : existingTray.color,
              rawColor: incomingTray.rawColor !== null ? incomingTray.rawColor : existingTray.rawColor,
              remain: incomingTray.remain !== null ? incomingTray.remain : existingTray.remain,
              diameter: incomingTray.diameter !== null ? incomingTray.diameter : existingTray.diameter,
              weight: incomingTray.weight !== null ? incomingTray.weight : existingTray.weight,
              uuid: incomingTray.uuid !== null ? incomingTray.uuid : existingTray.uuid,
              tagUid: incomingTray.tagUid !== null ? incomingTray.tagUid : existingTray.tagUid,
              infoIdx: incomingTray.infoIdx !== null ? incomingTray.infoIdx : existingTray.infoIdx,
              metadata: incomingTray.metadata || existingTray.metadata,
            });
          } else {
            trayMap.set(incomingTray.id, { ...incomingTray });
          }
        });

        amsMap.set(incomingUnit.id, {
          ...existingUnit,
          humidity: incomingUnit.humidity !== null ? incomingUnit.humidity : existingUnit.humidity,
          humidityRaw: incomingUnit.humidityRaw !== null ? incomingUnit.humidityRaw : existingUnit.humidityRaw,
          temperature: incomingUnit.temperature !== null ? incomingUnit.temperature : existingUnit.temperature,
          trays: Array.from(trayMap.values()),
          metadata: incomingUnit.metadata || existingUnit.metadata,
        });
      } else {
        amsMap.set(incomingUnit.id, { ...incomingUnit });
      }
    });
    mergedAms = Array.from(amsMap.values());
  }

  // 4. Merge Primary Nozzle Temp, Bed & Chamber
  const primaryNozzle = {
    current: parsed.temperatures?.nozzle.current !== null && parsed.temperatures?.nozzle.current !== undefined
      ? parsed.temperatures.nozzle.current
      : currentState.temperatures.nozzle.current,
    target: parsed.temperatures?.nozzle.target !== null && parsed.temperatures?.nozzle.target !== undefined
      ? parsed.temperatures.nozzle.target
      : currentState.temperatures.nozzle.target,
    activeNozzleId: parsed.temperatures?.nozzle.activeNozzleId !== undefined && parsed.temperatures?.nozzle.activeNozzleId !== null
      ? parsed.temperatures.nozzle.activeNozzleId
      : currentState.temperatures.nozzle.activeNozzleId,
    source: parsed.temperatures?.nozzle.source || currentState.temperatures.nozzle.source,
    confidence: 'POSSIBLE' as const,
    metadata: parsed.temperatures?.nozzle.metadata || currentState.temperatures.nozzle.metadata,
  };

  const bed = {
    current: parsed.temperatures?.bed.current !== null && parsed.temperatures?.bed.current !== undefined
      ? parsed.temperatures.bed.current
      : currentState.temperatures.bed.current,
    target: parsed.temperatures?.bed.target !== null && parsed.temperatures?.bed.target !== undefined
      ? parsed.temperatures.bed.target
      : currentState.temperatures.bed.target,
    metadata: parsed.temperatures?.bed.metadata || currentState.temperatures.bed.metadata,
  };

  const chamber = {
    current: parsed.temperatures?.chamber.current !== null && parsed.temperatures?.chamber.current !== undefined
      ? parsed.temperatures.chamber.current
      : currentState.temperatures.chamber.current,
    source: parsed.temperatures?.chamber.source || currentState.temperatures.chamber.source,
    confidence: 'POSSIBLE' as const,
    metadata: parsed.temperatures?.chamber.metadata || currentState.temperatures.chamber.metadata,
  };

  // 5. Merge Fans
  const fan = {
    cooling: parsed.fan?.cooling !== null && parsed.fan?.cooling !== undefined ? parsed.fan.cooling : currentState.fan.cooling,
    bigFan1: parsed.fan?.bigFan1 !== null && parsed.fan?.bigFan1 !== undefined ? parsed.fan.bigFan1 : currentState.fan.bigFan1,
    bigFan2: parsed.fan?.bigFan2 !== null && parsed.fan?.bigFan2 !== undefined ? parsed.fan.bigFan2 : currentState.fan.bigFan2,
    fan: parsed.fan?.fan !== null && parsed.fan?.fan !== undefined ? parsed.fan.fan : currentState.fan.fan,
    fanGear: parsed.fan?.fanGear !== null && parsed.fan?.fanGear !== undefined ? parsed.fan.fanGear : currentState.fan.fanGear,
    metadata: parsed.fan?.metadata || currentState.fan.metadata,
  };

  return {
    ...currentState,
    online: true,
    state: parsed.state ?? currentState.state,
    stateMetadata: parsed.stateMetadata ?? currentState.stateMetadata,
    progress: parsed.progress !== undefined && parsed.progress !== null ? parsed.progress : currentState.progress,
    temperatures: {
      nozzle: primaryNozzle,
      nozzles: mergedNozzles,
      bed,
      chamber,
    },
    extruders: mergedExtruders,
    job: {
      name: parsed.job?.name !== undefined && parsed.job?.name !== null ? parsed.job.name : currentState.job.name,
      currentLayer: parsed.job?.currentLayer !== undefined && parsed.job?.currentLayer !== null ? parsed.job.currentLayer : currentState.job.currentLayer,
      totalLayers: parsed.job?.totalLayers !== undefined && parsed.job?.totalLayers !== null ? parsed.job.totalLayers : currentState.job.totalLayers,
      remainingTimeMinutes: parsed.job?.remainingTimeMinutes !== undefined && parsed.job?.remainingTimeMinutes !== null ? parsed.job.remainingTimeMinutes : currentState.job.remainingTimeMinutes,
    },
    fan,
    hmsErrors: (parsed.hmsErrors && parsed.hmsErrors.length > 0) ? parsed.hmsErrors : currentState.hmsErrors,
    ams: mergedAms,
    rawExtensions: parsed.rawExtensions
      ? { ...currentState.rawExtensions, ...parsed.rawExtensions }
      : currentState.rawExtensions,
    lastMessageAt: now,
    updatedAt: now,
  };
}
