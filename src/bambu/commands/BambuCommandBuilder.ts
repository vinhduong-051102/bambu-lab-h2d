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

  public static buildAmsChangeFilamentPayload(
    target: number,
    currTemp = 220,
    tarTemp = 220
  ): Record<string, unknown> {
    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'ams_change_filament',
        target,
        curr_temp: currTemp,
        tar_temp: tarTemp,
      },
    };
  }

  public static buildAmsFilamentSettingPayload(
    amsId: number,
    trayId: number,
    trayInfoIdx: string,
    trayColor: string,
    nozzleTempMin = 190,
    nozzleTempMax = 240,
    trayType?: string
  ): Record<string, unknown> {
    const formattedColor = trayColor.replace('#', '').toUpperCase();
    const colorHex = formattedColor.length === 6 ? `${formattedColor}FF` : formattedColor;
    const materialType = trayType || trayInfoIdx;

    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'ams_filament_setting',
        ams_id: amsId,
        tray_id: trayId,
        tray_info_idx: trayInfoIdx,
        tray_type: materialType,
        tray_color: colorHex,
        nozzle_temp_min: nozzleTempMin,
        nozzle_temp_max: nozzleTempMax,
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
