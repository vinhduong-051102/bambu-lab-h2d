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
  tm?: number | null;
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
  /** H2 slot words, (ams_id << 8) | slot_id: tray now loaded / previously loaded / being loaded. 0xFFFF = none */
  snow: number | null;
  spre: number | null;
  star: number | null;
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
  subBrand: string | null;
  subBrands?: string | null; // Alias for backward compatibility
  color: string | null;      // Normalized hex e.g. "#DBC8B6"
  rawColor: string | null;   // Full raw hex e.g. "DBC8B6FF"
  remain: number | null;
  diameter: number | null;
  weight: number | null;
  uuid: string | null;
  tagUid: string | null;
  state: number | string | null;
  isActive: boolean;
  isTarget: boolean;
  isEmpty: boolean;
  /** Filament from this tray is fed into a toolhead (not just present in the slot) */
  isLoaded: boolean;
  /** Extruder the tray is loaded into (H2D: 0 = right, 1 = left); null when not loaded or unknown */
  loadedExtruderId?: number | null;
  /** Filament profile id, e.g. "GFA18" */
  infoIdx: string | null;
  nozzleTempMin?: number | null;
  nozzleTempMax?: number | null;
  metadata?: FieldMetadata;
}

export interface AmsLoadedTray {
  trayIndex: number;
  amsId: number;
  slotId: number;
  extruderId: number | null;
}

export interface AMSUnit {
  id: string;
  temperature: number | null;
  humidity: number | null;
  humidityRaw: string | number | null;
  status: number | string | null;
  trays: AMSTray[];
  /** Slot ids (within this unit) of the loaded / target / previous tray */
  activeTrayId: number | null;
  targetTrayId: number | null;
  currentTrayId: number | null;
  exists: boolean;
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

export interface IPCamData {
  ipcamDev?: string;
  ipcamRecord?: string;
  resolution?: string;
  rtspUrl?: string;
  brtcService?: string;
  agoraService?: string;
  tutkServer?: string;
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
  /** Absolute tray indexes (ams_id * 4 + slot, AMS HT = ams_id) */
  amsActiveTrayId?: number | null;
  amsTargetTrayId?: number | null;
  amsCurrentTrayId?: number | null;
  /** Every AMS tray currently fed into a toolhead (H2D can have one per extruder) */
  amsLoadedTrays?: AmsLoadedTray[];
  amsTrayNow?: string | number | null;
  amsTrayTar?: string | number | null;
  amsTrayPre?: string | number | null;
  amsExistBits?: string | number | null;
  trayExistBits?: string | number | null;
  trayIsBblBits?: string | number | null;
  /** print.ams_status: (main << 8) | sub; main 0 = idle, 1 = filament change in progress */
  amsStatus?: number | null;
  ams?: AMSUnit[];
  ipcam?: IPCamData;
  rawAmsPayload?: Record<string, unknown>;
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
