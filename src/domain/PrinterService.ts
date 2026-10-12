import { PrinterStateStore } from './PrinterStateStore';
import { CapabilityRegistry } from './capabilities/CapabilityRegistry';
import { PrinterCommandService } from './commands/PrinterCommandService';
import { BambuCameraService } from '../bambu/BambuCameraService';
import { BambuMqttClient } from '../bambu/BambuMqttClient';

export class PrinterService {
  public readonly serial: string;
  public readonly stateStore: PrinterStateStore;
  public readonly capabilityRegistry: CapabilityRegistry;
  public readonly commandService: PrinterCommandService;
  public readonly cameraService?: BambuCameraService;
  public readonly mqttClient?: BambuMqttClient;

  constructor(options: {
    serial: string;
    stateStore: PrinterStateStore;
    capabilityRegistry: CapabilityRegistry;
    commandService: PrinterCommandService;
    cameraService?: BambuCameraService;
    mqttClient?: BambuMqttClient;
  }) {
    this.serial = options.serial;
    this.stateStore = options.stateStore;
    this.capabilityRegistry = options.capabilityRegistry;
    this.commandService = options.commandService;
    this.cameraService = options.cameraService;
    this.mqttClient = options.mqttClient;
  }
}
