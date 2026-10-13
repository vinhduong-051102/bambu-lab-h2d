import { trayIndexOf } from '../../domain/ams/amsTrays';

// Stored on globalThis so the custom server and Next.js route bundles share one sequence counter
const globalForSequence = globalThis as unknown as { __bambuSequenceId?: number };

export interface ProjectFilePrintOptions {
  /** Path on the printer's FTPS root, e.g. "/my_part.gcode.3mf" */
  remotePath: string;
  plateIndex: number;
  gcodeMd5: string;
  subtaskName: string;
  amsMapping: number[];
  amsMapping2: { ams_id: number; slot_id: number }[];
  useAms: boolean;
  timelapse: boolean;
  bedLeveling: boolean;
  flowCalibration: boolean;
  vibrationCalibration: boolean;
  layerInspect: boolean;
}

export class BambuCommandBuilder {
  private static getNextSequenceId(): string {
    globalForSequence.__bambuSequenceId = ((globalForSequence.__bambuSequenceId ?? 2000) + 1) % 100000;
    return String(globalForSequence.__bambuSequenceId);
  }

  public static buildPushAllPayload(): Record<string, unknown> {
    return {
      pushing: {
        sequence_id: '0',
        command: 'pushall',
      },
    };
  }

  /**
   * print.project_file: prints a sliced plate of a 3MF already stored on the printer.
   * H2-series printers address FTPS-root files as `ftp:///<path>` (three slashes, empty host);
   * the older X1/P1/A1 form `file:///sdcard/...` is not used here.
   */
  public static buildProjectFilePayload(options: ProjectFilePrintOptions): Record<string, unknown> {
    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'project_file',
        param: `Metadata/plate_${options.plateIndex}.gcode`,
        url: `ftp:///${options.remotePath.replace(/^\/+/, '')}`,
        file: '',
        md5: options.gcodeMd5,
        bed_type: 'auto',
        timelapse: options.timelapse,
        // Both spellings are in circulation (OpenBambuAPI vs. slicer/HA integrations)
        bed_leveling: options.bedLeveling,
        bed_levelling: options.bedLeveling,
        flow_cali: options.flowCalibration,
        vibration_cali: options.vibrationCalibration,
        layer_inspect: options.layerInspect,
        use_ams: options.useAms,
        ams_mapping: options.amsMapping,
        ams_mapping2: options.amsMapping2,
        subtask_name: options.subtaskName,
        profile_id: '0',
        project_id: '0',
        subtask_id: '0',
        task_id: '0',
      },
    };
  }

  public static buildPausePayload(): Record<string, unknown> {
    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'pause',
      },
    };
  }

  public static buildResumePayload(): Record<string, unknown> {
    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'resume',
      },
    };
  }

  public static buildStopPayload(): Record<string, unknown> {
    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'stop',
      },
    };
  }

  public static buildSetNozzleTempPayload(target: number, nozzleIndex = 0): Record<string, unknown> {
    const tool = nozzleIndex === 1 ? 'T1 ' : '';
    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'gcode_line',
        param: `M104 ${tool}S${Math.round(target)}\n`,
      },
    };
  }

  public static buildSetBedTempPayload(target: number): Record<string, unknown> {
    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'gcode_line',
        param: `M140 S${Math.round(target)}\n`,
      },
    };
  }

  public static buildSetFanSpeedPayload(
    fanType: 'part' | 'aux' | 'chamber',
    speedPercentage: number
  ): Record<string, unknown> {
    const fanPIndexMap = {
      part: 1,
      aux: 2,
      chamber: 3,
    };
    const pIndex = fanPIndexMap[fanType];
    const pwmSpeed = Math.round((Math.max(0, Math.min(100, speedPercentage)) * 255) / 100);

    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'gcode_line',
        param: `M106 P${pIndex} S${pwmSpeed}\n`,
      },
    };
  }

  /**
   * ams_change_filament (load). `target` is the absolute tray index (ams_id * 4 + slot, AMS HT = ams_id);
   * H2-series firmware additionally reads `ams_id` / `slot_id`, as sent by Bambu Studio for multi-extruder printers.
   * curr_temp is the temperature for purging the filament being replaced, tar_temp the one for the new filament.
   */
  public static buildAmsLoadFilamentPayload(
    amsId: number,
    slotId: number,
    currTemp: number,
    tarTemp: number
  ): Record<string, unknown> {
    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'ams_change_filament',
        target: trayIndexOf(amsId, slotId),
        ams_id: amsId,
        slot_id: slotId,
        curr_temp: Math.round(currTemp),
        tar_temp: Math.round(tarTemp),
      },
    };
  }

  /** ams_change_filament with the 255 sentinel in target / ams_id / slot_id: retract the loaded filament */
  public static buildAmsUnloadFilamentPayload(currTemp: number, tarTemp = currTemp): Record<string, unknown> {
    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'ams_change_filament',
        target: 255,
        ams_id: 255,
        slot_id: 255,
        curr_temp: Math.round(currTemp),
        tar_temp: Math.round(tarTemp),
      },
    };
  }

  public static buildAmsFilamentSettingPayload(options: {
    amsId: number;
    slotId: number;
    trayInfoIdx: string;
    trayType: string;
    trayColor: string;
    nozzleTempMin: number;
    nozzleTempMax: number;
  }): Record<string, unknown> {
    const formattedColor = options.trayColor.replace('#', '').toUpperCase();
    const colorHex = formattedColor.length === 6 ? `${formattedColor}FF` : formattedColor;

    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'ams_filament_setting',
        ams_id: options.amsId,
        tray_id: options.slotId,
        slot_id: options.slotId,
        tray_info_idx: options.trayInfoIdx,
        tray_type: options.trayType,
        tray_color: colorHex,
        nozzle_temp_min: Math.round(options.nozzleTempMin),
        nozzle_temp_max: Math.round(options.nozzleTempMax),
      },
    };
  }

  public static buildAmsGetRfidPayload(amsId: number, slotId: number): Record<string, unknown> {
    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'ams_get_rfid',
        ams_id: amsId,
        slot_id: slotId,
      },
    };
  }

  public static buildAmsControlPayload(param: 'retry' | 'reset' | 'resume' | 'pause'): Record<string, unknown> {
    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'ams_control',
        param,
      },
    };
  }
}
