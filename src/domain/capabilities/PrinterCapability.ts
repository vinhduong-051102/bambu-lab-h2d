export type CapabilityCategory =
  | 'status'
  | 'print'
  | 'temperature'
  | 'fan'
  | 'ams'
  | 'camera'
  | 'system'
  | 'motion'
  | 'file';

export type CapabilityStatus = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN';

export interface PrinterCapability {
  id: string;
  name: string;
  category: CapabilityCategory;
  read: boolean;
  write: boolean;
  status: CapabilityStatus;
  description?: string;
}
