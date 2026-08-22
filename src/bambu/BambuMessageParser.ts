import { logger } from '../logger/logger.js';
import { BambuRawReportPayload } from './types.js';
import { PrinterStateStatus, TemperatureSensor, AMSUnit } from '../domain/PrinterState.js';

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
      nozzle: TemperatureSensor;
      bed: TemperatureSensor;
      chamber: number | null;
    };
    job?: {
      name: string | null;
      currentLayer: number | null;
      totalLayers: number | null;
      remainingTimeMinutes: number | null;
    };
    fan?: {
      part: number | null;
      aux: number | null;
      chamber: number | null;
    };
    ams?: AMSUnit[];
  } {
    const print = payload.print;
    if (!print || typeof print !== 'object') {
      return {};
    }

    // 1. Map printer status
    let state: PrinterStateStatus | undefined;
    if (typeof print.gcode_state === 'string') {
      state = this.mapGcodeState(print.gcode_state);
    }

    // 2. Map progress
    let progress: number | null = null;
    if (typeof print.mc_percent === 'number') {
      progress = Math.max(0, Math.min(100, Math.round(print.mc_percent)));
    }

    // 3. Map temperatures (support dual nozzles for H2D)
    const noz2Cur = typeof print.nozzle_temper_1 === 'number'
      ? print.nozzle_temper_1
      : (typeof print.nozzle_temper_2 === 'number' ? print.nozzle_temper_2 : null);
    const noz2Tar = typeof print.nozzle_target_temper_1 === 'number'
      ? print.nozzle_target_temper_1
      : (typeof print.nozzle_target_temper_2 === 'number' ? print.nozzle_target_temper_2 : null);

    const temperatures = {
      nozzle: {
        current: typeof print.nozzle_temper === 'number' ? print.nozzle_temper : null,
        target: typeof print.nozzle_target_temper === 'number' ? print.nozzle_target_temper : null,
      },
      nozzle2: {
        current: noz2Cur,
        target: noz2Tar,
      },
      bed: {
        current: typeof print.bed_temper === 'number' ? print.bed_temper : null,
        target: typeof print.bed_target_temper === 'number' ? print.bed_target_temper : null,
      },
      chamber: typeof print.chamber_temper === 'number' ? print.chamber_temper : null,
    };

    // 4. Map job info
    const jobName = typeof print.subtask_name === 'string' && print.subtask_name.trim() !== ''
      ? print.subtask_name
      : typeof print.gcode_file === 'string' && print.gcode_file.trim() !== ''
      ? print.gcode_file
      : null;

    const job = {
      name: jobName,
      currentLayer: typeof print.layer_num === 'number' ? print.layer_num : null,
      totalLayers: typeof print.total_layer_num === 'number' ? print.total_layer_num : null,
      remainingTimeMinutes: typeof print.mc_remaining_time === 'number' ? print.mc_remaining_time : null,
    };

    // 5. Map fan speeds
    const fan = {
      part: this.parseFanSpeed(print.cooling_fan_speed),
      aux: this.parseFanSpeed(print.big_fan1_speed),
      chamber: this.parseFanSpeed(print.big_fan2_speed),
    };

    // 6. Map AMS data (optional extension)
    const ams = this.parseAmsData(print.ams);

    return {
      ...(state !== undefined && { state }),
      progress,
      temperatures,
      job,
      fan,
      ams,
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

  private static parseFanSpeed(val: unknown): number | null {
    if (typeof val === 'number') {
      return val;
    }
    if (typeof val === 'string') {
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  private static parseAmsData(amsObj: unknown): AMSUnit[] {
    if (!amsObj || typeof amsObj !== 'object') return [];
    const amsWrapper = amsObj as { ams?: unknown[] };
    if (!Array.isArray(amsWrapper.ams)) return [];

    return amsWrapper.ams.map((unit: any, idx: number) => {
      const filaments = Array.isArray(unit.tray)
        ? unit.tray.map((tray: any, trayIdx: number) => ({
            id: String(tray?.id ?? trayIdx),
            type: typeof tray?.tray_type === 'string' ? tray.tray_type : null,
            color: typeof tray?.tray_color === 'string' ? tray.tray_color : null,
            remainingPercentage: typeof tray?.remain === 'number' ? tray.remain : null,
          }))
        : [];

      return {
        id: String(unit?.id ?? idx),
        humidity: typeof unit?.humidity === 'number' || typeof unit?.humidity === 'string' ? Number(unit.humidity) || null : null,
        rawHumidity: unit?.humidity ?? unit?.humidity_raw ?? null,
        temperature: typeof unit?.temp === 'number' || typeof unit?.temp === 'string' ? Number(unit.temp) || null : null,
        filaments,
      };
    });
  }
}
