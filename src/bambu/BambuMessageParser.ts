import { logger } from '../logger/logger.js';
import { BambuRawReportPayload } from './types.js';
import {
  PrinterStateStatus,
  BedState,
  ChamberState,
  NozzleState,
  ExtruderState,
  HMSError,
  AMSUnit,
  AMSTray,
  FanState,
  FieldMetadata,
} from '../domain/PrinterState.js';

export class BambuMessageParser {
  /**
   * Safely parses raw MQTT Buffer/String to BambuRawReportPayload JSON object.
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
   * Maps raw Bambu MQTT report payload to structured partial PrinterState according to H2D specifications.
   */
  public static parseReport(payload: BambuRawReportPayload): {
    state?: PrinterStateStatus;
    stateMetadata?: FieldMetadata;
    progress?: number | null;
    temperatures?: {
      nozzles: NozzleState[];
      bed: BedState;
      chamber: ChamberState;
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

    const now = Date.now();

    const parseNum = (val: unknown): number | null => {
      if (typeof val === 'number') return isNaN(val) ? null : val;
      if (typeof val === 'string') {
        const p = parseFloat(val);
        return isNaN(p) ? null : p;
      }
      return null;
    };

    // Track processed top-level keys to prevent duplicates in rawExtensions
    const processedKeys = new Set<string>();

    // 1. Printer Status
    let state: PrinterStateStatus | undefined;
    let stateMetadata: FieldMetadata | undefined;
    if (print.gcode_state !== undefined) {
      processedKeys.add('gcode_state');
      if (typeof print.gcode_state === 'string') {
        state = this.mapGcodeState(print.gcode_state);
        stateMetadata = {
          source: 'print.gcode_state',
          confidence: 'CONFIRMED',
          updatedAt: now,
        };
      }
    }

    // 2. Progress
    let progress: number | null = null;
    if (print.mc_percent !== undefined) {
      processedKeys.add('mc_percent');
      const num = parseNum(print.mc_percent);
      if (num !== null) {
        progress = Math.max(0, Math.min(100, Math.round(num)));
      }
    }

    // 3. Nozzles (print.nozzle.info[])
    const nozzles: NozzleState[] = [];
    if (print.nozzle !== undefined) {
      processedKeys.add('nozzle');
      if (Array.isArray(print.nozzle?.info)) {
        print.nozzle.info.forEach((item: any, idx: number) => {
          nozzles.push({
            id: item?.id !== undefined ? item.id : idx,
            current: parseNum(item?.temp),
            target: parseNum(item?.target_temp),
            diameter: parseNum(item?.diameter),
            type: item?.type !== undefined ? String(item.type) : null,
            serial: item?.sn !== undefined ? String(item.sn) : (item?.serial !== undefined ? String(item.serial) : null),
            filamentId: item?.fila_id !== undefined ? String(item.fila_id) : (item?.filament_id !== undefined ? String(item.filament_id) : null),
            state: item?.stat !== undefined ? item.stat : (item?.state !== undefined ? item.state : null),
            wear: parseNum(item?.wear),
            metadata: {
              source: `print.nozzle.info[${idx}]`,
              confidence: 'CONFIRMED',
              updatedAt: now,
            },
          });
        });
      }
    }

    // 4. Extruders (print.extruder.info[])
    const extruders: ExtruderState[] = [];
    if (print.extruder !== undefined) {
      processedKeys.add('extruder');
      if (Array.isArray(print.extruder?.info)) {
        print.extruder.info.forEach((item: any, idx: number) => {
          extruders.push({
            id: item?.id !== undefined ? item.id : idx,
            temp: parseNum(item?.temp),
            hnow: parseNum(item?.hnow),
            hpre: parseNum(item?.hpre),
            htar: parseNum(item?.htar),
            state: item?.stat !== undefined ? item.stat : (item?.state !== undefined ? item.state : null),
            metadata: {
              source: `print.extruder.info[${idx}]`,
              confidence: 'CONFIRMED',
              updatedAt: now,
            },
          });
        });
      }
    }

    // 5. Bed Temperature
    let bedCurrent: number | null = null;
    let bedTarget: number | null = null;
    if (print.bed_temper !== undefined) processedKeys.add('bed_temper');
    if (print.bed_target_temper !== undefined) processedKeys.add('bed_target_temper');
    if (print.bed_temper !== undefined || print.bed_target_temper !== undefined) {
      bedCurrent = parseNum(print.bed_temper);
      bedTarget = parseNum(print.bed_target_temper);
    }
    const bed: BedState = {
      current: bedCurrent,
      target: bedTarget,
      metadata: {
        source: 'print.bed_temper',
        confidence: 'CONFIRMED',
        updatedAt: now,
      },
    };

    // 6. Chamber Temperature (Priority: ctc.info.temp -> info.temp -> chamber_temper)
    let chamberCurrent: number | null = null;
    let chamberSource: string | null = null;

    if (print.ctc?.info?.temp !== undefined) {
      processedKeys.add('ctc');
      chamberCurrent = parseNum(print.ctc.info.temp);
      chamberSource = 'print.ctc.info.temp';
    } else if (print.info?.temp !== undefined) {
      processedKeys.add('info');
      chamberCurrent = parseNum(print.info.temp);
      chamberSource = 'print.info.temp';
    } else if (print.chamber_temper !== undefined) {
      processedKeys.add('chamber_temper');
      chamberCurrent = parseNum(print.chamber_temper);
      chamberSource = 'print.chamber_temper';
    }

    const chamber: ChamberState = {
      current: chamberCurrent,
      source: chamberSource,
      confidence: 'POSSIBLE',
      metadata: {
        source: chamberSource || 'none',
        confidence: 'POSSIBLE',
        updatedAt: now,
      },
    };

    const temperatures = {
      nozzles,
      bed,
      chamber,
    };

    // 7. Job Info
    if (print.subtask_name !== undefined) processedKeys.add('subtask_name');
    if (print.gcode_file !== undefined) processedKeys.add('gcode_file');
    if (print.layer_num !== undefined) processedKeys.add('layer_num');
    if (print.total_layer_num !== undefined) processedKeys.add('total_layer_num');
    if (print.mc_remaining_time !== undefined) processedKeys.add('mc_remaining_time');

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

    // 8. Fans
    if (print.cooling_fan_speed !== undefined) processedKeys.add('cooling_fan_speed');
    if (print.big_fan1_speed !== undefined) processedKeys.add('big_fan1_speed');
    if (print.big_fan2_speed !== undefined) processedKeys.add('big_fan2_speed');
    if (print.fan !== undefined) processedKeys.add('fan');
    if (print.fan_gear !== undefined) processedKeys.add('fan_gear');

    const fan: FanState = {
      cooling: parseNum(print.cooling_fan_speed),
      bigFan1: parseNum(print.big_fan1_speed),
      bigFan2: parseNum(print.big_fan2_speed),
      fan: parseNum(print.fan),
      fanGear: parseNum(print.fan_gear),
      metadata: {
        source: 'print.fan_speeds',
        confidence: 'POSSIBLE',
        updatedAt: now,
      },
    };

    // 9. AMS
    if (print.ams !== undefined) processedKeys.add('ams');
    const ams = this.parseAmsData(print.ams, now);

    // 10. HMS Errors
    if (print.hms !== undefined) processedKeys.add('hms');
    const hmsErrors: HMSError[] = [];
    if (Array.isArray(print.hms)) {
      print.hms.forEach((item: any) => {
        hmsErrors.push({
          attr: item?.attr ?? null,
          code: item?.code ?? null,
          metadata: {
            source: 'print.hms[]',
            confidence: 'CONFIRMED',
            updatedAt: now,
          },
        });
      });
    }

    // Standard RPC command keys to ignore in rawExtensions
    processedKeys.add('sequence_id');
    processedKeys.add('command');
    processedKeys.add('result');
    processedKeys.add('reason');

    // 11. Extract ONLY unparsed / unknown fields into rawExtensions (no duplicate of processed keys!)
    const rawExtensions: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(print)) {
      if (!processedKeys.has(k)) {
        rawExtensions[k] = v;
      }
    }

    return {
      ...(state !== undefined && { state, stateMetadata }),
      progress,
      temperatures,
      extruders,
      job,
      fan,
      ams,
      hmsErrors,
      rawExtensions: Object.keys(rawExtensions).length > 0 ? rawExtensions : undefined,
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

  private static parseAmsData(amsObj: unknown, now: number): AMSUnit[] {
    if (!amsObj || typeof amsObj !== 'object') return [];
    const amsWrapper = amsObj as { ams?: unknown[] };
    if (!Array.isArray(amsWrapper.ams)) return [];

    const parseNum = (v: unknown): number | null => {
      if (typeof v === 'number') return isNaN(v) ? null : v;
      if (typeof v === 'string') {
        const p = parseFloat(v);
        return isNaN(p) ? null : p;
      }
      return null;
    };

    return amsWrapper.ams.map((unit: any, idx: number) => {
      const trays: AMSTray[] = Array.isArray(unit.tray)
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
              remain: parseNum(tray?.remain),
              diameter: parseNum(tray?.tray_diameter),
              weight: parseNum(tray?.tray_weight),
              uuid: tray?.tray_uuid ? String(tray.tray_uuid) : null,
              tagUid: tray?.tag_uid ? String(tray.tag_uid) : null,
              infoIdx: parseNum(tray?.tray_info_idx),
              metadata: {
                source: `print.ams.ams[${idx}].tray[${trayIdx}]`,
                confidence: 'CONFIRMED',
                updatedAt: now,
              },
            };
          })
        : [];

      return {
        id: String(unit?.id ?? idx),
        humidity: parseNum(unit?.humidity),
        humidityRaw: unit?.humidity_raw ?? unit?.humidity ?? null,
        temperature: parseNum(unit?.temp),
        trays,
        metadata: {
          source: `print.ams.ams[${idx}]`,
          confidence: 'CONFIRMED',
          updatedAt: now,
        },
      };
    });
  }
}
