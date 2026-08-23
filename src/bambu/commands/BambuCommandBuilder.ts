export class BambuCommandBuilder {
  private static sequenceId = 2000;

  private static getNextSequenceId(): string {
    this.sequenceId = (this.sequenceId + 1) % 100000;
    return String(this.sequenceId);
  }

  public static buildPushAllPayload(): Record<string, unknown> {
    return {
      pushing: {
        sequence_id: '0',
        command: 'pushall',
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
    nozzleTempMax = 240
  ): Record<string, unknown> {
    const formattedColor = trayColor.replace('#', '').toUpperCase();
    const colorHex = formattedColor.length === 6 ? `${formattedColor}FF` : formattedColor;

    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'ams_filament_setting',
        ams_id: amsId,
        tray_id: trayId,
        tray_info_idx: trayInfoIdx,
        tray_color: colorHex,
        nozzle_temp_min: nozzleTempMin,
        nozzle_temp_max: nozzleTempMax,
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
