import { PrinterStateStore } from './PrinterStateStore.js';
import { CapabilityRegistry } from './capabilities/CapabilityRegistry.js';
import { PrinterCommandService } from './commands/PrinterCommandService.js';
import { BambuCameraService } from '../bambu/BambuCameraService.js';
import { BambuMqttClient } from '../bambu/BambuMqttClient.js';

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
