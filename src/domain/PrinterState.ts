export type PrinterStateStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'PAUSED'
  | 'FINISHED'
  | 'FAILED'
  | 'UNKNOWN';

export interface TemperatureSensor {
  current: number | null;
  target: number | null;
}

export interface AMSFilament {
  id: string;
  type: string | null;
  color: string | null;
  remainingPercentage: number | null;
}

export interface AMSUnit {
  id: string;
  humidity: number | null;
  rawHumidity?: string | number | null;
  temperature: number | null;
  filaments: AMSFilament[];
}

export interface PrinterState {
  serial: string;
  online: boolean;
  state: PrinterStateStatus;
  progress: number | null;
  temperatures: {
    nozzle: TemperatureSensor;
    bed: TemperatureSensor;
    chamber: number | null;
  };
  job: {
    name: string | null;
    currentLayer: number | null;
    totalLayers: number | null;
    remainingTimeMinutes: number | null;
  };
  fan: {
    part: number | null;
    aux: number | null;
    chamber: number | null;
  };
  model?: string;
  firmware?: string;
  hmsErrors?: string[];
  amsActiveTrayId?: number | null;
  ams?: AMSUnit[];
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
      nozzle: { current: null, target: null },
      bed: { current: null, target: null },
      chamber: null,
    },
    job: {
      name: null,
      currentLayer: null,
      totalLayers: null,
      remainingTimeMinutes: null,
    },
    fan: {
      part: null,
      aux: null,
      chamber: null,
    },
    ams: [],
    lastMessageAt: null,
    updatedAt: null,
  };
}
