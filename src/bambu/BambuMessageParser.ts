import { logger } from '../logger/logger.js';
import { BambuRawReportPayload } from './types.js';
import {
  PrinterStateStatus,
  TemperatureSensor,
  NozzleState,
  ExtruderState,
  HMSError,
  AMSUnit,
  FanState,
} from '../domain/PrinterState.js';

export class BambuMessageParser {
  /**
   * Safely parses raw MQTT Buffer/String to BambuRawReportPayload JSON object.
   * If parsing fails or invalid, logs a warning and returns null without crashing.
   */
  public static parseJsonPayload(raw: Buffer | string): BambuRawReportPayload | null {
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) {
        logger.warn('MQTT payload is not a valid JSON object');
        return null;
      }
      return parsed as BambuRawReportPayload;
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Invalid MQTT JSON payload received');
      return null;
    }
  }

  /**
   * Maps raw Bambu MQTT report payload to structured/normalized partial PrinterState.
   * Handles missing/optional fields gracefully without throwing errors.
   */
  public static parseReport(payload: BambuRawReportPayload): {
    state?: PrinterStateStatus;
    progress?: number | null;
    temperatures?: {
      nozzles: NozzleState[];
      bed: TemperatureSensor;
      chamber: number | null;
    };
    extruders?: ExtruderState[];
    job?: {
      name: string | null;
      currentLayer: number | null;
      totalLayers: number | null;
      remainingTimeMinutes: number | null;
    };
    fan?: FanState;
    ams?: AMSUnit[];
    hmsErrors?: HMSError[];
    rawExtensions?: Record<string, unknown>;
  } {
    const print = payload.print as Record<string, any> | undefined;
    if (!print || typeof print !== 'object') {
      return {};
    }

    const parseNum = (val: unknown): number | null => {
      if (typeof val === 'number') return isNaN(val) ? null : val;
      if (typeof val === 'string') {
        const p = parseFloat(val);
        return isNaN(p) ? null : p;
      }
      return null;
    };

    // 1. Map printer status
    let state: PrinterStateStatus | undefined;
    if (typeof print.gcode_state === 'string') {
      state = this.mapGcodeState(print.gcode_state);
    }

    // 2. Map progress
    let progress: number | null = null;
    if (typeof print.mc_percent === 'number' || typeof print.mc_percent === 'string') {
      const num = parseNum(print.mc_percent);
      if (num !== null) {
        progress = Math.max(0, Math.min(100, Math.round(num)));
      }
    }

    // 3. Map Nozzles (print.nozzle.info[])
    const nozzles: NozzleState[] = [];
    if (print.nozzle && Array.isArray(print.nozzle.info)) {
      print.nozzle.info.forEach((item: any, idx: number) => {
        nozzles.push({
          id: String(item?.id ?? idx),
          current: parseNum(item?.temp),
          target: parseNum(item?.target_temp),
          diameter: parseNum(item?.diameter),
          type: item?.type ? String(item.type) : null,
          serial: item?.serial ? String(item.serial) : null,
          filamentId: item?.filament_id ? String(item.filament_id) : null,
          state: item?.state ? String(item.state) : null,
          wear: parseNum(item?.wear),
        });
      });
    }

    // 4. Map Extruders (print.extruder.info[])
    const extruders: ExtruderState[] = [];
    if (print.extruder && Array.isArray(print.extruder.info)) {
      print.extruder.info.forEach((item: any, idx: number) => {
        extruders.push({
          id: String(item?.id ?? idx),
          temp: parseNum(item?.temp),
          targetTemp: parseNum(item?.target_temp),
          state: item?.state ? String(item.state) : null,
        });
      });
    }

    // 5. Map Bed & Chamber temperatures
    // Chamber: check ctc.info.temp -> info.temp -> device.ctc.info.temp -> chamber_temper
    const chamberTemp =
      parseNum(print.ctc?.info?.temp) ??
      parseNum(print.info?.temp) ??
      parseNum(print.device?.ctc?.info?.temp) ??
      parseNum(print.chamber_temper);

    const temperatures = {
      nozzles,
      bed: {
        current: parseNum(print.bed_temper),
        target: parseNum(print.bed_target_temper),
      },
      chamber: chamberTemp,
    };

    // 6. Map job info
    const jobName = typeof print.subtask_name === 'string' && print.subtask_name.trim() !== ''
      ? print.subtask_name
      : typeof print.gcode_file === 'string' && print.gcode_file.trim() !== ''
      ? print.gcode_file
      : null;

    const job = {
      name: jobName,
      currentLayer: parseNum(print.layer_num),
      totalLayers: parseNum(print.total_layer_num),
      remainingTimeMinutes: parseNum(print.mc_remaining_time),
    };

    // 7. Map Fans
    const fan: FanState = {
      cooling: parseNum(print.cooling_fan_speed),
      bigFan1: parseNum(print.big_fan1_speed),
      bigFan2: parseNum(print.big_fan2_speed),
      fan: parseNum(print.fan),
      fanGear: parseNum(print.fan_gear),
    };

    // 8. Map AMS data
    const ams = this.parseAmsData(print.ams);

    // 9. Map HMS diagnostic codes (attr & code preserved)
    const hmsErrors: HMSError[] = [];
    if (Array.isArray(print.hms)) {
      print.hms.forEach((item: any) => {
        hmsErrors.push({
          attr: item?.attr ?? null,
          code: item?.code ?? null,
        });
      });
    }

    // 10. Preserve Raw Extensions / Unknown Fields
    const knownKeys = new Set([
      'gcode_state', 'mc_percent', 'mc_remaining_time', 'layer_num', 'total_layer_num',
      'subtask_name', 'gcode_file', 'nozzle', 'extruder', 'bed_temper', 'bed_target_temper',
      'cooling_fan_speed', 'big_fan1_speed', 'big_fan2_speed', 'fan', 'fan_gear',
      'ams', 'hms', 'ctc', 'info', 'device', 'chamber_temper', 'sequence_id', 'command'
    ]);
    const rawExtensions: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(print)) {
      if (!knownKeys.has(k)) {
        rawExtensions[k] = v;
      }
    }

    return {
      ...(state !== undefined && { state }),
      progress,
      temperatures,
      extruders,
      job,
      fan,
      ams,
      hmsErrors,
      rawExtensions,
    };
  }

  private static mapGcodeState(rawState: string): PrinterStateStatus {
    const upper = rawState.toUpperCase();
    switch (upper) {
      case 'IDLE':
      case 'STANDBY':
      case 'OFF':
      case 'READY':
      case 'INIT':
        return 'IDLE';
      case 'PREPARE':
      case 'SLICING':
      case 'RUNNING':
      case 'WARMUP':
      case 'HEATING':
        return 'RUNNING';
      case 'PAUSE':
      case 'PAUSED':
        return 'PAUSED';
      case 'FINISH':
      case 'FINISHED':
      case 'SUCCESS':
        return 'FINISHED';
      case 'FAILED':
      case 'FAIL':
      case 'ERROR':
        return 'FAILED';
      default:
        return 'UNKNOWN';
    }
  }

  private static parseAmsData(amsObj: unknown): AMSUnit[] {
    if (!amsObj || typeof amsObj !== 'object') return [];
    const amsWrapper = amsObj as { ams?: unknown[] };
    if (!Array.isArray(amsWrapper.ams)) return [];

    return amsWrapper.ams.map((unit: any, idx: number) => {
      const filaments = Array.isArray(unit.tray)
        ? unit.tray.map((tray: any, trayIdx: number) => {
            const rawColor = typeof tray?.tray_color === 'string' ? tray.tray_color : null;
            let color: string | null = null;
            if (rawColor) {
              const clean = rawColor.startsWith('#') ? rawColor.slice(1) : rawColor;
              color = '#' + clean.slice(0, 6);
            }
            return {
              id: String(tray?.id ?? trayIdx),
              type: typeof tray?.tray_type === 'string' ? tray.tray_type : null,
              subBrands: typeof tray?.tray_sub_brands === 'string' ? tray.tray_sub_brands : null,
              color,
              rawColor,
              remainingPercentage: typeof tray?.remain === 'number' ? tray.remain : (typeof tray?.remain === 'string' ? parseFloat(tray.remain) : null),
              diameter: typeof tray?.tray_diameter === 'number' ? tray.tray_diameter : null,
              weight: typeof tray?.tray_weight === 'number' ? tray.tray_weight : null,
              uuid: tray?.tray_uuid ? String(tray.tray_uuid) : null,
              tagUid: tray?.tag_uid ? String(tray.tag_uid) : null,
              infoIdx: typeof tray?.tray_info_idx === 'number' ? tray.tray_info_idx : null,
            };
          })
        : [];

      const parseNum = (v: unknown): number | null => {
        if (typeof v === 'number') return isNaN(v) ? null : v;
        if (typeof v === 'string') {
          const p = parseFloat(v);
          return isNaN(p) ? null : p;
        }
        return null;
      };

      return {
        id: String(unit?.id ?? idx),
        humidity: parseNum(unit?.humidity),
        humidityRaw: unit?.humidity ?? unit?.humidity_raw ?? null,
        temperature: parseNum(unit?.temp),
        filaments,
      };
    });
  }
}
