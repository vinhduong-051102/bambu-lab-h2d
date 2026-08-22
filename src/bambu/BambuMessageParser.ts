import { logger } from '../logger/logger.js';
import { BambuRawReportPayload } from './types.js';
import {
  PrinterStateStatus,
  PrimaryNozzleTempState,
  BedState,
  ChamberState,
  NozzleState,
  ExtruderState,
  HMSError,
  AMSUnit,
  AMSTray,
  FanState,
  FieldMetadata,
  IPCamData,
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
      nozzle: PrimaryNozzleTempState;
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
    ipcam?: IPCamData;
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

    const parseTemp = (val: unknown, maxValid = 400): number | null => {
      const num = parseNum(val);
      if (num === null) return null;
      // Filter out uint16 overflow sentinel values (e.g. 65535, 65279, 32767) and unphysical temps
      if (num < 0 || num > maxValid || num === 65535 || num === 65279 || num === 32767) {
        return null;
      }
      return num;
    };

    const parseId = (val: unknown): number | null => {
      if (typeof val === 'number') return isNaN(val) ? null : val;
      if (typeof val === 'string') {
        const p = parseInt(val, 10);
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
      state = this.mapGcodeState(print.gcode_state);
      stateMetadata = {
        source: 'print.gcode_state',
        confidence: 'CONFIRMED',
        updatedAt: now,
      };
    } else if (print.stg_cur !== undefined || print.mc_print_stage !== undefined) {
      if (print.stg_cur !== undefined) processedKeys.add('stg_cur');
      if (print.mc_print_stage !== undefined) processedKeys.add('mc_print_stage');
      const stage = print.stg_cur ?? print.mc_print_stage;
      state = this.mapGcodeState(stage);
      stateMetadata = {
        source: print.stg_cur !== undefined ? 'print.stg_cur' : 'print.mc_print_stage',
        confidence: 'POSSIBLE',
        updatedAt: now,
      };
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

    // 3. Primary Scalar Machine / Active Nozzle Temperature (print.nozzle_temper & print.nozzle_target_temper)
    let nozzleCurrentTemp: number | null = null;
    let nozzleTargetTemp: number | null = null;

    if (print.nozzle_temper !== undefined) {
      processedKeys.add('nozzle_temper');
      nozzleCurrentTemp = parseTemp(print.nozzle_temper, 400);
    }
    if (print.nozzle_target_temper !== undefined) {
      processedKeys.add('nozzle_target_temper');
      nozzleTargetTemp = parseTemp(print.nozzle_target_temper, 400);
    }

    // Determine activeNozzleId exclusively from src_id or tar_id
    const activeNozzleId = parseId(print.nozzle?.src_id) ?? parseId(print.nozzle?.tar_id) ?? parseId(print.device?.nozzle?.src_id) ?? null;

    // Resolve extruder and nozzle objects from top-level or print.device wrapper
    const extruderObj = (print.extruder ?? print.device?.extruder) as Record<string, any> | undefined;
    const nozzleObj = (print.nozzle ?? print.device?.nozzle) as Record<string, any> | undefined;

    if (print.extruder !== undefined) processedKeys.add('extruder');
    if (print.nozzle !== undefined) processedKeys.add('nozzle');
    if (print.device !== undefined) processedKeys.add('device');

    // 4. Nozzle Hardware Info Array & Extruder Temperature Mapping
    const nozzles: NozzleState[] = [];
    const nozzleMap = new Map<number, Partial<NozzleState>>();

    // A. First process extruderObj.info[] for nozzle temperatures (id 0 -> T0, id 1 -> T1)
    if (extruderObj !== undefined && Array.isArray(extruderObj?.info)) {
      extruderObj.info.forEach((item: any, idx: number) => {
        const id = item?.id !== undefined ? parseId(item.id) ?? idx : idx;
        const temp = parseTemp(item?.temp, 400);
        const target = parseTemp(item?.target_temp ?? item?.target, 400);

        nozzleMap.set(id, {
          id,
          current: temp,
          target: target ?? 0,
          temperatureSource: `print.extruder.info[${idx}].temp`,
          temperatureConfidence: 'CONFIRMED',
        });
      });
    }

    // B. Merge nozzleObj.info[] to overlay hardware metadata (diameter, type, serial, etc.)
    if (nozzleObj !== undefined && Array.isArray(nozzleObj?.info)) {
      nozzleObj.info.forEach((item: any, idx: number) => {
        const id = item?.id !== undefined ? parseId(item.id) ?? idx : idx;
        const itemTemp = parseTemp(item?.temp, 400);
        const itemTarget = parseTemp(item?.target_temp ?? item?.target, 400);
        const existing = nozzleMap.get(id);

        const current = itemTemp !== null ? itemTemp : (existing?.current ?? null);
        const target = itemTarget !== null ? itemTarget : (existing?.target ?? 0);
        const tempSource = itemTemp !== null ? `print.nozzle.info[${idx}].temp` : (existing?.temperatureSource || `print.extruder.info[${idx}].temp`);

        nozzleMap.set(id, {
          id,
          current,
          target,
          diameter: parseNum(item?.diameter) ?? existing?.diameter ?? null,
          type: item?.type !== undefined ? String(item.type) : (existing?.type ?? null),
          serial: item?.sn !== undefined ? String(item.sn) : (item?.serial !== undefined ? String(item.serial) : (existing?.serial ?? null)),
          filamentId: item?.fila_id !== undefined ? String(item.fila_id) : (item?.filament_id !== undefined ? String(item.filament_id) : (existing?.filamentId ?? null)),
          state: item?.stat !== undefined ? item.stat : (item?.state !== undefined ? item.state : (existing?.state ?? null)),
          wear: parseNum(item?.wear) ?? existing?.wear ?? null,
          tm: parseNum(item?.tm) ?? existing?.tm ?? null,
          temperatureSource: tempSource,
          temperatureConfidence: itemTemp !== null ? 'CONFIRMED' : (existing?.temperatureConfidence || 'CONFIRMED'),
        });
      });
    }

    // Build sorted nozzles array
    const sortedIds = Array.from(nozzleMap.keys()).sort((a, b) => a - b);
    sortedIds.forEach((id) => {
      const item = nozzleMap.get(id)!;
      nozzles.push({
        id,
        current: item.current ?? null,
        target: item.target ?? 0,
        diameter: item.diameter ?? null,
        type: item.type ?? null,
        serial: item.serial ?? null,
        filamentId: item.filamentId ?? null,
        state: item.state ?? null,
        wear: item.wear ?? null,
        tm: item.tm ?? null,
        temperatureSource: item.temperatureSource || `print.extruder.info[${id}].temp`,
        temperatureConfidence: item.temperatureConfidence || 'CONFIRMED',
        metadata: {
          source: item.temperatureSource || `print.extruder.info[${id}]`,
          confidence: item.temperatureConfidence || 'CONFIRMED',
          updatedAt: now,
        },
      });
    });

    // Fallback primaryNozzleTemp if nozzle_temper scalar is absent
    if (nozzleCurrentTemp === null && nozzles.length > 0 && nozzles[0].current !== null) {
      nozzleCurrentTemp = nozzles[0].current;
      if (nozzleTargetTemp === null) nozzleTargetTemp = nozzles[0].target;
    }

    const primaryNozzleTemp: PrimaryNozzleTempState = {
      current: nozzleCurrentTemp,
      target: nozzleTargetTemp,
      activeNozzleId,
      source: nozzleCurrentTemp !== null ? (print.nozzle_temper !== undefined ? 'print.nozzle_temper' : (nozzles[0]?.temperatureSource || 'print.extruder.info[0].temp')) : 'print.nozzle_temper',
      confidence: 'POSSIBLE',
      metadata: {
        source: 'print.nozzle_temper',
        confidence: 'POSSIBLE',
        updatedAt: now,
      },
    };

    // 5. Extruders (extruderObj.info[]) - Extruder Telemetry
    const extruders: ExtruderState[] = [];
    if (extruderObj !== undefined && Array.isArray(extruderObj?.info)) {
      extruderObj.info.forEach((item: any, idx: number) => {
        extruders.push({
          id: item?.id !== undefined ? item.id : idx,
          temp: parseTemp(item?.temp, 400),
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

    // 6. Bed Temperature
    let bedCurrent: number | null = null;
    let bedTarget: number | null = null;
    if (print.bed_temper !== undefined) processedKeys.add('bed_temper');
    if (print.bed_target_temper !== undefined) processedKeys.add('bed_target_temper');
    if (print.bed_temper !== undefined || print.bed_target_temper !== undefined) {
      bedCurrent = parseTemp(print.bed_temper, 150);
      bedTarget = parseTemp(print.bed_target_temper, 150);
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

    // 7. Chamber Temperature
    let chamberCurrent: number | null = null;
    let chamberSource: string | null = null;

    if (print.ctc?.info?.temp !== undefined) {
      processedKeys.add('ctc');
      chamberCurrent = parseTemp(print.ctc.info.temp, 100);
      chamberSource = 'print.ctc.info.temp';
    } else if (print.info?.temp !== undefined) {
      processedKeys.add('info');
      chamberCurrent = parseTemp(print.info.temp, 100);
      chamberSource = 'print.info.temp';
    } else if (print.chamber_temper !== undefined) {
      processedKeys.add('chamber_temper');
      chamberCurrent = parseTemp(print.chamber_temper, 100);
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
      nozzle: primaryNozzleTemp,
      nozzles,
      bed,
      chamber,
    };

    // 8. Job Info
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

    // 9. Fans
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

    // 10. AMS
    if (print.ams !== undefined) processedKeys.add('ams');
    const ams = this.parseAmsData(print.ams, now);

    // 11. HMS Errors
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

    // 12. IPCam Data
    let ipcam: IPCamData | undefined;
    if (print.ipcam !== undefined && typeof print.ipcam === 'object' && print.ipcam !== null) {
      processedKeys.add('ipcam');
      const camObj = print.ipcam as Record<string, unknown>;
      ipcam = {
        ipcamDev: typeof camObj.ipcam_dev === 'string' ? String(camObj.ipcam_dev) : undefined,
        ipcamRecord: typeof camObj.ipcam_record === 'string' ? String(camObj.ipcam_record) : undefined,
        resolution: typeof camObj.resolution === 'string' ? String(camObj.resolution) : undefined,
        rtspUrl: typeof camObj.rtsp_url === 'string' ? String(camObj.rtsp_url) : undefined,
        brtcService: typeof camObj.brtc_service === 'string' ? String(camObj.brtc_service) : undefined,
        agoraService: typeof camObj.agora_service === 'string' ? String(camObj.agora_service) : undefined,
        tutkServer: typeof camObj.tutk_server === 'string' ? String(camObj.tutk_server) : undefined,
        metadata: {
          source: 'print.ipcam',
          confidence: 'CONFIRMED',
          updatedAt: now,
        },
      };
    }

    // Standard RPC command keys to ignore in rawExtensions
    processedKeys.add('sequence_id');
    processedKeys.add('command');
    processedKeys.add('result');
    processedKeys.add('reason');

    // 13. Extract ONLY unparsed / unknown fields into rawExtensions
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
      ipcam,
      rawExtensions: Object.keys(rawExtensions).length > 0 ? rawExtensions : undefined,
    };
  }

  private static mapGcodeState(rawState: unknown): PrinterStateStatus {
    if (rawState === null || rawState === undefined) return 'UNKNOWN';

    if (typeof rawState === 'number') {
      switch (rawState) {
        case 0:
        case 6:
          return 'IDLE';
        case 1:
        case 2:
          return 'RUNNING';
        case 3:
          return 'PAUSED';
        case 4:
          return 'FINISHED';
        case 5:
          return 'FAILED';
        default:
          return 'UNKNOWN';
      }
    }

    const strState = String(rawState).trim().toUpperCase();
    switch (strState) {
      case 'IDLE':
      case 'STANDBY':
      case 'OFF':
      case 'READY':
      case 'INIT':
      case '0':
      case '6':
        return 'IDLE';
      case 'PREPARE':
      case 'PREPARED':
      case 'SLICING':
      case 'RUNNING':
      case 'PRINTING':
      case 'WARMUP':
      case 'HEATING':
      case '1':
      case '2':
        return 'RUNNING';
      case 'PAUSE':
      case 'PAUSED':
      case '3':
        return 'PAUSED';
      case 'FINISH':
      case 'FINISHED':
      case 'SUCCESS':
      case 'COMPLETED':
      case '4':
        return 'FINISHED';
      case 'FAILED':
      case 'FAIL':
      case 'ERROR':
      case 'CANCELLED':
      case 'CANCELED':
      case 'ABORTED':
      case '5':
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
