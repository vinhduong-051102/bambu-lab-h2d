import { env } from '../config/env';
import { logger } from '../logger/logger';
import { PrinterStateStore } from '../domain/PrinterStateStore';
import { CapabilityRegistry } from '../domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../domain/commands/PrinterCommandService';
import { PrinterService } from '../domain/PrinterService';
import { PrinterManager } from '../domain/PrinterManager';
import { normalizePrinterState } from '../domain/normalizePrinterState';
import { BambuMqttClient } from '../bambu/BambuMqttClient';
import { BambuCameraService } from '../bambu/BambuCameraService';
import { BambuMessageParser } from '../bambu/BambuMessageParser';
import { BambuCommandBuilder } from '../bambu/commands/BambuCommandBuilder';
import { BambuTopics } from '../bambu/BambuTopics';
import { AmsCommandTracker } from '../domain/commands/AmsCommandTracker';
import { PrintJournal } from '../domain/prints/PrintJournal';
import { PrintRecorder } from '../domain/prints/PrintRecorder';
import { setRuntime, type GatewayRuntime } from './runtime';
import { followUpCadJobs } from '../api/routes/cad';
import path from 'path';
import { refreshPlans } from '../domain/ai/keyVault';
import { loadState } from '../domain/keyvault/keyVaultClient';

export interface StartedGateway extends GatewayRuntime {
  printerService: PrinterService;
  printerManager: PrinterManager;
  stop(): Promise<void>;
}

/**
 * Creates the printer services, registers them as the shared runtime used by the
 * Next.js Route Handlers, and starts the MQTT connection and camera stream.
 */
export async function startGateway(): Promise<StartedGateway> {
  // 1. Initialize MQTT Client & Camera Service
  const mqttClient = new BambuMqttClient({
    host: env.BAMBU_HOST,
    port: env.BAMBU_PORT,
    serial: env.BAMBU_SERIAL,
    accessCode: env.BAMBU_ACCESS_CODE,
  });

  const cameraService = new BambuCameraService(env.BAMBU_HOST, env.BAMBU_ACCESS_CODE);
  cameraService.start();

  // 2. Initialize Domain Services (StateStore, CapabilityRegistry, CommandService, PrinterService)
  const stateStore = new PrinterStateStore(env.BAMBU_SERIAL, env.PRINTER_OFFLINE_TIMEOUT_MS);
  const capabilityRegistry = new CapabilityRegistry();
  const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqttClient);

  const printerService = new PrinterService({
    serial: env.BAMBU_SERIAL,
    stateStore,
    capabilityRegistry,
    commandService,
    cameraService,
    mqttClient,
  });

  const printerManager = new PrinterManager();
  printerManager.registerPrinter(env.BAMBU_SERIAL, printerService);

  setRuntime({ printerService, printerManager });

  // The Claude plans follow the KeyVault's key list: a key granted shows as a plan, one taken back loses its plan
  const vaultTokens = setInterval(async () => {
    if ((await loadState()).stage !== 'active') return;
    await refreshPlans().catch((err) => logger.warn({ err: err instanceof Error ? err.message : err }, 'Could not read the KeyVault key list'));
  }, 10 * 60_000);

  // Print history: a record per print, with the camera's photo when it ends
  const printRecorder = new PrintRecorder(new PrintJournal(path.resolve(env.PRINT_HISTORY_DIR)), stateStore, cameraService);
  printRecorder.start();

  // AI models end in their workers, not here: now and then see which ended, so a retry's outcome is learned from and a
  // failure a rule mends runs again on its own even when no dashboard is open (the panel also does it as it polls)
  const cadFollowUp = setInterval(() => {
    followUpCadJobs().catch((err) => logger.warn({ err }, 'Could not follow up AI modelling jobs'));
  }, 60_000);

  // Handle incoming MQTT messages
  mqttClient.onMessage((topic, message) => {
    const rawPayload = BambuMessageParser.parseJsonPayload(message);
    if (!rawPayload) {
      return;
    }

    if (env.BAMBU_DEBUG_PROTOCOL) {
      logger.info({ topic, payloadLength: message.length }, '[DEBUG PROTOCOL] Received MQTT report');
    }

    const payloadObj = rawPayload as Record<string, unknown>;
    AmsCommandTracker.getInstance().recordRawResponse(payloadObj, topic);
    stateStore.setRawPayload(payloadObj);
    const currentState = stateStore.getState();
    const nextState = normalizePrinterState(currentState, rawPayload);
    stateStore.updateState(nextState);
    AmsCommandTracker.getInstance().verifyTelemetry(nextState);

    if (nextState.ipcam?.rtspUrl) {
      cameraService.updateRtspUrl(nextState.ipcam.rtspUrl);
    }
  });

  // Subscribe and request a full status dump on every (re)connect, not just the first one
  mqttClient.onConnect(async () => {
    await mqttClient.subscribeReports();
    await mqttClient.publishRequest(BambuCommandBuilder.buildPushAllPayload());
  });

  // Attempt connection to printer
  try {
    await mqttClient.connect();
    console.log(`
MQTT:
  Status: connected

Subscribed:
  ${BambuTopics.getReportTopic(env.BAMBU_SERIAL)}
`);
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Initial MQTT connection attempt failed. Gateway will auto-retry in background.');
  }

  return {
    printerService,
    printerManager,
    async stop() {
      clearInterval(cadFollowUp);
      clearInterval(vaultTokens);
      printRecorder.stop();
      cameraService.stop();
      stateStore.destroy();
      await mqttClient.disconnect();
      setRuntime(undefined);
    },
  };
}
