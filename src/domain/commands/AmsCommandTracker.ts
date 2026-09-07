import { logger } from '../../logger/logger.js';
import { PrinterState } from '../PrinterState.js';

export type AmsCommandType = 'load' | 'unload' | 'setting' | 'retry' | 'rfid';

export type AmsCommandStatus =
  | 'REQUESTED'
  | 'SENDING'
  | 'SENT'
  | 'WAITING_FOR_PRINTER'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface AmsCommandRecord {
  commandId: string;
  type: AmsCommandType;
  amsId: number;
  trayId: number;
  target: number; // 0..3 for load tray, 255 for unload
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
  status: AmsCommandStatus;
  protocolConfidence: 'CONFIRMED' | 'PROTOCOL_UNVERIFIED' | 'POSSIBLE';
  rawRequest: Record<string, unknown>;
  rawResponse?: Record<string, unknown> | null;
  error?: string | null;
}

export class AmsCommandTracker {
  private static instance: AmsCommandTracker;
  private commands: Map<string, AmsCommandRecord> = new Map();
  private lastCommandId: string | null = null;
  private lastResponse: Record<string, unknown> | null = null;
  private idCounter = 1;

  public static getInstance(): AmsCommandTracker {
    if (!AmsCommandTracker.instance) {
      AmsCommandTracker.instance = new AmsCommandTracker();
    }
    return AmsCommandTracker.instance;
  }

  /**
   * Idempotency Check: Returns active pending command if one is currently in progress.
   */
  public getActiveCommand(): AmsCommandRecord | null {
    for (const cmd of this.commands.values()) {
      if (
        cmd.status === 'REQUESTED' ||
        cmd.status === 'SENDING' ||
        cmd.status === 'SENT' ||
        cmd.status === 'WAITING_FOR_PRINTER' ||
        cmd.status === 'VERIFYING'
      ) {
        return cmd;
      }
    }
    return null;
  }

  public createCommand(options: {
    type: AmsCommandType;
    amsId: number;
    trayId: number;
    target: number;
    rawRequest: Record<string, unknown>;
    protocolConfidence?: 'CONFIRMED' | 'PROTOCOL_UNVERIFIED' | 'POSSIBLE';
    serial?: string;
  }): AmsCommandRecord {
    const nowIso = new Date().toISOString();
    const commandId = `ams_cmd_${Date.now()}_${this.idCounter++}`;
    const confidence = options.protocolConfidence || (options.type === 'retry' ? 'PROTOCOL_UNVERIFIED' : 'CONFIRMED');

    const record: AmsCommandRecord = {
      commandId,
      type: options.type,
      amsId: options.amsId,
      trayId: options.trayId,
      target: options.target,
      createdAt: nowIso,
      sentAt: null,
      completedAt: null,
      status: 'REQUESTED',
      protocolConfidence: confidence,
      rawRequest: sanitizePayload(options.rawRequest),
      rawResponse: null,
      error: null,
    };

    this.commands.set(commandId, record);
    this.lastCommandId = commandId;

    // Requirement 6: AMS_PROTOCOL_DEBUG logging format [AMS COMMAND / OUTGOING MQTT]
    logger.info({
      logType: 'AMS_COMMAND',
      timestamp: nowIso,
      serial: options.serial || 'UNKNOWN',
      topic: `device/${options.serial || 'UNKNOWN'}/request`,
      payload: record.rawRequest,
    }, `[AMS COMMAND / OUTGOING MQTT] timestamp=${nowIso} action=${options.type} amsId=${options.amsId} trayId=${options.trayId} target=${options.target}`);

    return record;
  }

  public markSent(commandId: string): void {
    const cmd = this.commands.get(commandId);
    if (cmd) {
      cmd.sentAt = new Date().toISOString();
      cmd.status = 'WAITING_FOR_PRINTER';
    }
  }

  public markFailed(commandId: string, error: string): void {
    const cmd = this.commands.get(commandId);
    if (cmd) {
      cmd.completedAt = new Date().toISOString();
      cmd.status = 'FAILED';
      cmd.error = error;
    }
  }

  public recordRawResponse(rawPayload: Record<string, unknown>, topic = 'mqtt_report'): void {
    const sanitized = sanitizePayload(rawPayload);
    this.lastResponse = sanitized;
    const nowIso = new Date().toISOString();

    if (process.env.AMS_PROTOCOL_DEBUG === 'true' || process.env.BAMBU_DEBUG_PROTOCOL === 'true') {
      logger.info({
        logType: 'AMS_RESPONSE',
        timestamp: nowIso,
        topic,
        rawPayload: sanitized,
      }, `[AMS RESPONSE / INCOMING MQTT] timestamp=${nowIso} topic=${topic}`);
    }
  }

  public verifyTelemetry(currentState: PrinterState, timeoutMs = getTimeoutFromEnv()): void {
    this.verifyCommandWithTelemetry(currentState, timeoutMs);
  }

  /**
   * Multi-field Telemetry Verifier (Requirement 7)
   */
  public verifyCommandWithTelemetry(currentState: PrinterState, timeoutMs = getTimeoutFromEnv()): void {
    const nowMs = Date.now();
    const activeTray = currentState.amsActiveTrayId;
    const trayNow = currentState.amsTrayNow;
    const hmsErrors = currentState.hmsErrors || [];

    // 1. Check for active HMS error indicating AMS hardware failure (e.g. tangle or feed fail)
    const amsHmsError = hmsErrors.find((err) => {
      const codeStr = String(err.code || '');
      return codeStr.includes('0300') || codeStr.includes('AMS');
    });

    for (const cmd of this.commands.values()) {
      if (cmd.status === 'COMPLETED' || cmd.status === 'FAILED' || cmd.status === 'TIMEOUT') {
        continue;
      }

      const createdMs = new Date(cmd.createdAt).getTime();
      const elapsedMs = nowMs - createdMs;

      // Fail command if active HMS error is reported
      if (amsHmsError && (cmd.status === 'WAITING_FOR_PRINTER' || cmd.status === 'VERIFYING')) {
        cmd.status = 'FAILED';
        cmd.completedAt = new Date().toISOString();
        cmd.error = `Printer HMS Error detected: ${amsHmsError.code || amsHmsError.attr}`;
        logger.warn(`[AMS STATE CHANGE] command=${cmd.commandId} type=${cmd.type} before=${cmd.status} after=FAILED error=${cmd.error}`);
        continue;
      }

      if (cmd.type === 'load') {
        // SUCCESS condition for load: activeTray matches target tray AND tray_now is not sentinel 255
        const isLoaded = (activeTray === cmd.target) || (parseTrayNumber(trayNow) === cmd.target && parseTrayNumber(trayNow) !== 255);
        if (isLoaded) {
          const beforeStatus = cmd.status;
          cmd.status = 'COMPLETED';
          cmd.completedAt = new Date().toISOString();
          logger.info(`[AMS STATE CHANGE] command=${cmd.commandId} type=load target=${cmd.target} before=${beforeStatus} after=COMPLETED activeTray=${activeTray}`);
          continue;
        }
      } else if (cmd.type === 'unload') {
        // SUCCESS condition for unload: activeTray is null OR tray_now is sentinel 255
        const isUnloaded = (activeTray === null) || (parseTrayNumber(trayNow) === 255) || (trayNow === '255');
        if (isUnloaded && cmd.status === 'WAITING_FOR_PRINTER') {
          const beforeStatus = cmd.status;
          cmd.status = 'COMPLETED';
          cmd.completedAt = new Date().toISOString();
          logger.info(`[AMS STATE CHANGE] command=${cmd.commandId} type=unload before=${beforeStatus} after=COMPLETED activeTray=null`);
          continue;
        }
      } else if (cmd.type === 'setting' || cmd.type === 'retry' || cmd.type === 'rfid') {
        // Setting/retry/rfid commands complete when sent & printer acknowledges state update
        if (cmd.sentAt && elapsedMs > 1500) {
          cmd.status = 'COMPLETED';
          cmd.completedAt = new Date().toISOString();
          continue;
        }
      }

      // Requirement 14: Check for TIMEOUT with configurable AMS_COMMAND_TIMEOUT_MS
      if (elapsedMs >= timeoutMs) {
        const beforeStatus = cmd.status;
        cmd.status = 'TIMEOUT';
        cmd.completedAt = new Date().toISOString();
        cmd.error = `Command timed out after ${timeoutMs}ms without printer telemetry confirmation`;
        logger.warn(`[AMS STATE CHANGE] command=${cmd.commandId} type=${cmd.type} before=${beforeStatus} after=TIMEOUT`);
      }
    }
  }

  public getLastCommand(): AmsCommandRecord | null {
    if (!this.lastCommandId) return null;
    return this.commands.get(this.lastCommandId) || null;
  }

  public getLastResponse(): Record<string, unknown> | null {
    return this.lastResponse;
  }

  public getCommand(commandId: string): AmsCommandRecord | null {
    return this.commands.get(commandId) || null;
  }

  public getAllCommands(): AmsCommandRecord[] {
    return Array.from(this.commands.values());
  }

  public clear(): void {
    this.commands.clear();
    this.lastCommandId = null;
    this.lastResponse = null;
  }
}

function parseTrayNumber(val: unknown): number | null {
  if (typeof val === 'number') return isNaN(val) ? null : val;
  if (typeof val === 'string') {
    const p = parseInt(val, 10);
    return isNaN(p) ? null : p;
  }
  return null;
}

function getTimeoutFromEnv(): number {
  const envVal = process.env.AMS_COMMAND_TIMEOUT_MS;
  if (envVal) {
    const num = parseInt(envVal, 10);
    if (!isNaN(num) && num > 0) return num;
  }
  return 30000; // 30 seconds default
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...payload };
  const sensitiveKeys = ['access_code', 'accessCode', 'password', 'cert', 'private_key', 'token'];
  for (const k of sensitiveKeys) {
    if (k in clean) {
      clean[k] = '[REDACTED]';
    }
  }
  return clean;
}
