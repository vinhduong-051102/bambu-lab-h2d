export class BambuCommandBuilder {
  private static sequenceId = 2000;

  private static getNextSequenceId(): string {
    this.sequenceId = (this.sequenceId + 1) % 100000;
    return String(this.sequenceId);
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

  public static buildSetNozzleTempPayload(target: number): Record<string, unknown> {
    return {
      print: {
        sequence_id: this.getNextSequenceId(),
        command: 'gcode_line',
        param: `M104 S${Math.round(target)}\n`,
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
}
