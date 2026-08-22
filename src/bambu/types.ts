export interface BambuRawReportPayload {
  print?: {
    gcode_state?: string;
    mc_percent?: number;
    nozzle_temper?: number;
    nozzle_target_temper?: number;
    bed_temper?: number;
    bed_target_temper?: number;
    chamber_temper?: number;
    subtask_name?: string;
    gcode_file?: string;
    layer_num?: number;
    total_layer_num?: number;
    mc_remaining_time?: number;
    cooling_fan_speed?: string | number;
    big_fan1_speed?: string | number;
    big_fan2_speed?: string | number;
    ams?: {
      ams?: Array<{
        id?: string;
        humidity?: string | number;
        temp?: string | number;
        tray?: Array<{
          id?: string;
          tray_color?: string;
          tray_type?: string;
          remain?: number;
        }>;
      }>;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface BambuClientOptions {
  host: string;
  port: number;
  serial: string;
  accessCode: string;
  reconnectPeriod?: number;
}
