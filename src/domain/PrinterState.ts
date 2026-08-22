export type PrinterStateStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'PAUSED'
  | 'FINISHED'
  | 'FAILED'
  | 'UNKNOWN';

export interface TemperatureSensor {
  /** normalized: temperatures.bed.current -> print.bed_temper -> CONFIRMED */
  current: number | null;
  /** normalized: temperatures.bed.target -> print.bed_target_temper -> CONFIRMED */
  target: number | null;
}

/**
 * Detailed Nozzle State for Bambu Lab H2D Multi-Nozzle / Dual-Toolhead
 * Source Path: print.nozzle.info[]
 * Confidence: CONFIRMED
 */
export interface NozzleState {
  /** normalized: temperatures.nozzles[i].id -> print.nozzle.info[i].id -> CONFIRMED */
  id: string;
  /** normalized: temperatures.nozzles[i].current -> print.nozzle.info[i].temp -> CONFIRMED */
  current: number | null;
  /** normalized: temperatures.nozzles[i].target -> print.nozzle.info[i].target_temp -> CONFIRMED */
  target: number | null;
  /** normalized: temperatures.nozzles[i].diameter -> print.nozzle.info[i].diameter -> CONFIRMED */
  diameter: number | null;
  /** normalized: temperatures.nozzles[i].type -> print.nozzle.info[i].type -> CONFIRMED */
  type: string | null;
  /** normalized: temperatures.nozzles[i].serial -> print.nozzle.info[i].serial -> CONFIRMED */
  serial: string | null;
  /** normalized: temperatures.nozzles[i].filamentId -> print.nozzle.info[i].filament_id -> CONFIRMED */
  filamentId: string | null;
  /** normalized: temperatures.nozzles[i].state -> print.nozzle.info[i].state -> CONFIRMED */
  state: string | null;
  /** normalized: temperatures.nozzles[i].wear -> print.nozzle.info[i].wear -> CONFIRMED */
  wear: number | null;
}

/**
 * Extruder State for H2D Extruder Units
 * Source Path: print.extruder.info[]
 * Confidence: CONFIRMED
 */
export interface ExtruderState {
  /** normalized: extruders[i].id -> print.extruder.info[i].id -> CONFIRMED */
  id: string;
  /** normalized: extruders[i].temp -> print.extruder.info[i].temp -> CONFIRMED */
  temp: number | null;
  /** normalized: extruders[i].targetTemp -> print.extruder.info[i].target_temp -> CONFIRMED */
  targetTemp: number | null;
  /** normalized: extruders[i].state -> print.extruder.info[i].state -> CONFIRMED */
  state: string | null;
  /** Unmapped raw extruder properties -> CONFIRMED */
  raw?: Record<string, unknown>;
}

/**
 * HMS Diagnostic Error Entry
 * Source Path: print.hms[]
 * Confidence: CONFIRMED
 */
export interface HMSError {
  /** normalized: hmsErrors[i].attr -> print.hms[i].attr -> CONFIRMED */
  attr: number | string | null;
  /** normalized: hmsErrors[i].code -> print.hms[i].code -> CONFIRMED */
  code: number | string | null;
}

/**
 * Filament Tray Item inside AMS
 * Source Path: print.ams.ams[].tray[]
 * Confidence: CONFIRMED
 */
export interface AMSFilament {
  /** normalized: ams[i].filaments[j].id -> tray.id -> CONFIRMED */
  id: string;
  /** normalized: ams[i].filaments[j].type -> tray.tray_type -> CONFIRMED */
  type: string | null;
  /** normalized: ams[i].filaments[j].subBrands -> tray.tray_sub_brands -> CONFIRMED */
  subBrands: string | null;
  /** normalized: ams[i].filaments[j].color -> tray.tray_color (#RRGGBB) -> CONFIRMED */
  color: string | null;
  /** normalized: ams[i].filaments[j].rawColor -> tray.tray_color (DBC8B6FF) -> CONFIRMED */
  rawColor: string | null;
  /** normalized: ams[i].filaments[j].remainingPercentage -> tray.remain -> CONFIRMED */
  remainingPercentage: number | null;
  /** normalized: ams[i].filaments[j].diameter -> tray.tray_diameter -> CONFIRMED */
  diameter: number | null;
  /** normalized: ams[i].filaments[j].weight -> tray.tray_weight -> CONFIRMED */
  weight: number | null;
  /** normalized: ams[i].filaments[j].uuid -> tray.tray_uuid -> CONFIRMED */
  uuid: string | null;
  /** normalized: ams[i].filaments[j].tagUid -> tray.tag_uid -> CONFIRMED */
  tagUid: string | null;
  /** normalized: ams[i].filaments[j].infoIdx -> tray.tray_info_idx -> CONFIRMED */
  infoIdx: number | null;
}

/**
 * AMS Unit State
 * Source Path: print.ams.ams[]
 * Confidence: CONFIRMED
 */
export interface AMSUnit {
  /** normalized: ams[i].id -> print.ams.ams[i].id -> CONFIRMED */
  id: string;
  /** normalized: ams[i].humidity -> print.ams.ams[i].humidity -> CONFIRMED */
  humidity: number | null;
  /** normalized: ams[i].humidityRaw -> print.ams.ams[i].humidity_raw / humidity -> CONFIRMED */
  humidityRaw: string | number | null;
  /** normalized: ams[i].temperature -> print.ams.ams[i].temp -> CONFIRMED */
  temperature: number | null;
  /** normalized: ams[i].filaments -> print.ams.ams[i].tray[] -> CONFIRMED */
  filaments: AMSFilament[];
}

/**
 * H2D Fan Speeds State
 * Confidence: CONFIRMED for cooling, bigFan1, bigFan2. POSSIBLE for fan, fanGear.
 */
export interface FanState {
  /** normalized: fan.cooling -> print.cooling_fan_speed -> CONFIRMED */
  cooling: number | null;
  /** normalized: fan.bigFan1 -> print.big_fan1_speed -> CONFIRMED */
  bigFan1: number | null;
  /** normalized: fan.bigFan2 -> print.big_fan2_speed -> CONFIRMED */
  bigFan2: number | null;
  /** normalized: fan.fan -> print.fan -> POSSIBLE */
  fan?: number | null;
  /** normalized: fan.fanGear -> print.fan_gear -> POSSIBLE */
  fanGear?: number | null;
}

export interface PrinterState {
  serial: string;
  online: boolean;
  /** normalized: state -> print.gcode_state -> CONFIRMED */
  state: PrinterStateStatus;
  /** normalized: progress -> print.mc_percent -> CONFIRMED */
  progress: number | null;
  temperatures: {
    /** normalized: temperatures.nozzles -> print.nozzle.info[] -> CONFIRMED */
    nozzles: NozzleState[];
    /** normalized: temperatures.bed -> print.bed_temper & print.bed_target_temper -> CONFIRMED */
    bed: TemperatureSensor;
    /** normalized: temperatures.chamber -> print.ctc.info.temp / print.chamber_temper -> POSSIBLE */
    chamber: number | null;
  };
  /** normalized: extruders -> print.extruder.info[] -> CONFIRMED */
  extruders: ExtruderState[];
  job: {
    /** normalized: job.name -> print.subtask_name / print.gcode_file -> CONFIRMED */
    name: string | null;
    /** normalized: job.currentLayer -> print.layer_num -> CONFIRMED */
    currentLayer: number | null;
    /** normalized: job.totalLayers -> print.total_layer_num -> CONFIRMED */
    totalLayers: number | null;
    /** normalized: job.remainingTimeMinutes -> print.mc_remaining_time -> CONFIRMED */
    remainingTimeMinutes: number | null;
  };
  fan: FanState;
  model?: string;
  firmware?: string;
  /** normalized: hmsErrors -> print.hms[] -> CONFIRMED */
  hmsErrors?: HMSError[];
  amsActiveTrayId?: number | null;
  ams?: AMSUnit[];
  /** Preserved raw/unparsed extra fields from H2D telemetry -> CONFIRMED */
  rawExtensions?: Record<string, unknown>;
  lastMessageAt: string | null;
  updatedAt: string | null;
}

export function createInitialPrinterState(serial: string): PrinterState {
  return {
    serial,
    online: false,
    state: 'UNKNOWN',
    progress: null,
    temperatures: {
      nozzles: [],
      bed: { current: null, target: null },
      chamber: null,
    },
    extruders: [],
    job: {
      name: null,
      currentLayer: null,
      totalLayers: null,
      remainingTimeMinutes: null,
    },
    fan: {
      cooling: null,
      bigFan1: null,
      bigFan2: null,
      fan: null,
      fanGear: null,
    },
    hmsErrors: [],
    ams: [],
    rawExtensions: {},
    lastMessageAt: null,
    updatedAt: null,
  };
}
