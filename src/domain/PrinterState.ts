export type PrinterStateStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'PAUSED'
  | 'FINISHED'
  | 'FAILED'
  | 'UNKNOWN';

export interface FieldMetadata {
  source: string;
  confidence: 'CONFIRMED' | 'POSSIBLE' | 'UNKNOWN';
  updatedAt?: number;
}

export interface PrimaryNozzleTempState {
  current: number | null;
  target: number | null;
  activeNozzleId?: string | number | null;
  source: string;
  confidence: 'CONFIRMED' | 'POSSIBLE' | 'UNKNOWN';
  metadata?: FieldMetadata;
}

export interface BedState {
  current: number | null;
  target: number | null;
  metadata?: FieldMetadata;
}

export interface ChamberState {
  current: number | null;
  source: string | null;
  confidence: 'CONFIRMED' | 'POSSIBLE' | 'UNKNOWN';
  metadata?: FieldMetadata;
}

export interface NozzleState {
  id: string | number;
  current: number | null;
  target: number | null;
  diameter: number | null;
  type: string | null;
  serial: string | null;
  filamentId: string | null;
  state: string | number | null;
  wear: number | null;
  temperatureSource?: string | null;
  temperatureConfidence?: 'CONFIRMED' | 'POSSIBLE' | 'UNKNOWN';
  metadata?: FieldMetadata;
}

export interface ExtruderState {
  id: string | number;
  temp: number | null;
  hnow: number | null;
  hpre: number | null;
  htar: number | null;
  state: string | number | null;
  metadata?: FieldMetadata;
}

export interface HMSError {
  attr: number | string | null;
  code: number | string | null;
  metadata?: FieldMetadata;
}

export interface AMSTray {
  id: string;
  type: string | null;
  subBrands: string | null;
  color: string | null;
  rawColor: string | null;
  remain: number | null;
  diameter: number | null;
  weight: number | null;
  uuid: string | null;
  tagUid: string | null;
  infoIdx: number | null;
  metadata?: FieldMetadata;
}

export interface AMSUnit {
  id: string;
  humidity: number | null;
  humidityRaw: string | number | null;
  temperature: number | null;
  trays: AMSTray[];
  metadata?: FieldMetadata;
}

export interface FanState {
  cooling: number | null;
  bigFan1: number | null;
  bigFan2: number | null;
  fan: number | null;
  fanGear: number | null;
  metadata?: FieldMetadata;
}

export interface PrinterState {
  serial: string;
  online: boolean;
  state: PrinterStateStatus;
  stateMetadata?: FieldMetadata;
  progress: number | null;
  temperatures: {
    nozzle: PrimaryNozzleTempState;
    nozzles: NozzleState[];
    bed: BedState;
    chamber: ChamberState;
  };
  extruders: ExtruderState[];
  job: {
    name: string | null;
    currentLayer: number | null;
    totalLayers: number | null;
    remainingTimeMinutes: number | null;
  };
  fan: FanState;
  model?: string;
  firmware?: string;
  hmsErrors?: HMSError[];
  amsActiveTrayId?: number | null;
  ams?: AMSUnit[];
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
      nozzle: {
        current: null,
        target: null,
        activeNozzleId: null,
        source: 'print.nozzle_temper',
        confidence: 'POSSIBLE',
      },
      nozzles: [],
      bed: { current: null, target: null },
      chamber: { current: null, source: null, confidence: 'POSSIBLE' },
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
