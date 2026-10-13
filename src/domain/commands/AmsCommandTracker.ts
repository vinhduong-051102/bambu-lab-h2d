import { logger } from '../../logger/logger';
import { PrinterState } from '../PrinterState';
import { findTray } from '../ams/amsTrays';
import { formatHms, isAmsHms } from '../hms';

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

export interface AmsCommandBaseline {
  /** Absolute indexes of the AMS trays loaded when the command was issued */
  loadedTrays: number[];
  /** HMS codes already active when the command was issued */
  hms: string[];
}

export interface AmsCommandRecord {
  commandId: string;
  type: AmsCommandType;
  amsId: number;
  trayId: number;
  target: number; // absolute tray index for load, 255 for unload
  createdAt: string;
  sentAt: string | null;
  /** Set when the printer answers the request (same sequence_id) with result "success" */
  acknowledgedAt: string | null;
  completedAt: string | null;
  status: AmsCommandStatus;
  protocolConfidence: 'CONFIRMED' | 'PROTOCOL_UNVERIFIED' | 'POSSIBLE';
  sequenceId: string | null;
  baseline: AmsCommandBaseline;
  rawRequest: Record<string, unknown>;
  rawResponse?: Record<string, unknown> | null;
  error?: string | null;
}

const PENDING_STATUSES: AmsCommandStatus[] = ['REQUESTED', 'SENDING', 'SENT', 'WAITING_FOR_PRINTER', 'VERIFYING'];
const AMS_COMMANDS = new Set(['ams_change_filament', 'ams_filament_setting', 'ams_get_rfid', 'ams_control']);

// Stored on globalThis so the custom server and Next.js route bundles share one tracker
const globalForTracker = globalThis as unknown as { __bambuAmsCommandTracker?: AmsCommandTracker };

export function snapshotBaseline(state: PrinterState): AmsCommandBaseline {
  return {
    loadedTrays: (state.amsLoadedTrays ?? []).map((t) => t.trayIndex),
    hms: (state.hmsErrors ?? []).map(formatHms).filter((c): c is string => c !== null),
  };
}

export class AmsCommandTracker {
  private commands: Map<string, AmsCommandRecord> = new Map();
  private lastCommandId: string | null = null;
  private lastResponse: Record<string, unknown> | null = null;
  private idCounter = 1;

  public static getInstance(): AmsCommandTracker {
    if (!globalForTracker.__bambuAmsCommandTracker) {
      globalForTracker.__bambuAmsCommandTracker = new AmsCommandTracker();
    }
    return globalForTracker.__bambuAmsCommandTracker;
  }

  /**
   * Idempotency Check: Returns active pending command if one is currently in progress.
   */
  public getActiveCommand(): AmsCommandRecord | null {
    for (const cmd of this.commands.values()) {
      if (PENDING_STATUSES.includes(cmd.status)) return cmd;
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
    baseline?: AmsCommandBaseline;
  }): AmsCommandRecord {
    const nowIso = new Date().toISOString();
    const commandId = `ams_cmd_${Date.now()}_${this.idCounter++}`;
    const confidence = options.protocolConfidence || (options.type === 'retry' ? 'PROTOCOL_UNVERIFIED' : 'CONFIRMED');
    const print = options.rawRequest.print as Record<string, unknown> | undefined;

    const record: AmsCommandRecord = {
      commandId,
      type: options.type,
      amsId: options.amsId,
      trayId: options.trayId,
      target: options.target,
      createdAt: nowIso,
      sentAt: null,
      acknowledgedAt: null,
      completedAt: null,
      status: 'REQUESTED',
      protocolConfidence: confidence,
      sequenceId: print?.sequence_id !== undefined ? String(print.sequence_id) : null,
      baseline: options.baseline ?? { loadedTrays: [], hms: [] },
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

  /**
   * Inspects every report: the printer answers AMS requests on the report topic with the same
   * command + sequence_id and a `result` ("success" / "fail") plus optional `reason`.
   */
  public recordRawResponse(rawPayload: Record<string, unknown>, topic = 'mqtt_report'): void {
    const print = rawPayload.print as Record<string, unknown> | undefined;
    const isAmsReply = !!print && typeof print.command === 'string' && AMS_COMMANDS.has(print.command);
    const nowIso = new Date().toISOString();

    if (isAmsReply) {
      this.lastResponse = sanitizePayload(rawPayload);
      // Replies are rare and small, so always log them: they are the only evidence of why the printer refused
      logger.info({ logType: 'AMS_RESPONSE', topic, rawPayload: this.lastResponse }, `[AMS RESPONSE] command=${print!.command} sequence_id=${print!.sequence_id} result=${print!.result} reason=${print!.reason ?? ''}`);
      this.applyReply(print!, nowIso);
    } else if (process.env.AMS_PROTOCOL_DEBUG === 'true' || process.env.BAMBU_DEBUG_PROTOCOL === 'true') {
      if (print?.ams !== undefined) {
        logger.info({ logType: 'AMS_TELEMETRY', timestamp: nowIso, topic, ams: print.ams }, `[AMS TELEMETRY / INCOMING MQTT] timestamp=${nowIso} topic=${topic}`);
      }
    }
  }

  private applyReply(print: Record<string, unknown>, nowIso: string): void {
    const sequenceId = print.sequence_id !== undefined ? String(print.sequence_id) : null;
    if (!sequenceId) return;

    const cmd = Array.from(this.commands.values()).find(
      (c) => c.sequenceId === sequenceId && PENDING_STATUSES.includes(c.status)
        && (c.rawRequest.print as Record<string, unknown> | undefined)?.command === print.command
    );
    const result = typeof print.result === 'string' ? print.result.toLowerCase() : null;
    if (!cmd || !result) return;

    cmd.rawResponse = sanitizePayload({ print });
    if (result === 'success') {
      cmd.acknowledgedAt = nowIso;
      if (cmd.status === 'WAITING_FOR_PRINTER') cmd.status = 'VERIFYING';
      logger.info(`[AMS STATE CHANGE] command=${cmd.commandId} type=${cmd.type} printer acknowledged`);
    } else {
      cmd.status = 'FAILED';
      cmd.completedAt = nowIso;
      const reason = typeof print.reason === 'string' && print.reason ? print.reason : String(print.result);
      cmd.error = `Máy in từ chối lệnh: ${reason}`;
      logger.warn(`[AMS STATE CHANGE] command=${cmd.commandId} type=${cmd.type} after=FAILED error=${cmd.error}`);
    }
  }

  public verifyTelemetry(currentState: PrinterState, timeoutMs?: number): void {
    this.verifyCommandWithTelemetry(currentState, timeoutMs);
  }

  /**
   * Multi-field Telemetry Verifier (Requirement 7)
   */
  public verifyCommandWithTelemetry(currentState: PrinterState, timeoutMs?: number): void {
    const nowMs = Date.now();
    const loadedTrays = (currentState.amsLoadedTrays ?? []).map((t) => t.trayIndex);
    // H2D switches extruder.snow to the target as soon as a load starts; the change is only finished once
    // the AMS is back to idle. Printers that never report ams_status fall back to the slot alone.
    const amsStatus = currentState.amsStatus;
    const amsIdle = amsStatus === null || amsStatus === undefined || ((amsStatus >> 8) & 0xff) === 0;
    const amsHms = (currentState.hmsErrors ?? [])
      .filter(isAmsHms)
      .map(formatHms)
      .filter((c): c is string => c !== null);

    for (const cmd of this.commands.values()) {
      if (!PENDING_STATUSES.includes(cmd.status)) continue;

      const elapsedMs = nowMs - new Date(cmd.createdAt).getTime();
      const acked = cmd.acknowledgedAt !== null;

      // Only an AMS error raised after the command was issued counts as its failure
      const newHms = amsHms.find((code) => !cmd.baseline.hms.includes(code));
      if (newHms && (cmd.status === 'WAITING_FOR_PRINTER' || cmd.status === 'VERIFYING')) {
        this.finish(cmd, 'FAILED', `Máy in báo lỗi HMS của AMS: ${newHms}`);
        continue;
      }

      let done = false;
      if (cmd.type === 'load') {
        // Target fed into an extruder; if it already was, only a printer ack proves this command did anything
        done = amsIdle && loadedTrays.includes(cmd.target) && (!cmd.baseline.loadedTrays.includes(cmd.target) || acked);
      } else if (cmd.type === 'unload') {
        done = amsIdle && loadedTrays.length === 0 && (cmd.baseline.loadedTrays.length > 0 || acked);
      } else if (cmd.type === 'setting') {
        done = acked || settingApplied(cmd, currentState);
      } else {
        done = acked;
      }

      if (done) {
        this.finish(cmd, 'COMPLETED', null);
        continue;
      }

      const limit = timeoutMs ?? getTimeoutFromEnv(cmd.type);
      if (elapsedMs >= limit) {
        this.finish(cmd, 'TIMEOUT', acked
          ? `Máy in đã nhận lệnh nhưng telemetry chưa xác nhận kết quả sau ${Math.round(limit / 1000)}s (timed out)`
          : `Máy in không phản hồi lệnh sau ${Math.round(limit / 1000)}s (timed out)`);
      }
    }
  }

  private finish(cmd: AmsCommandRecord, status: 'COMPLETED' | 'FAILED' | 'TIMEOUT', error: string | null): void {
    const before = cmd.status;
    cmd.status = status;
    cmd.completedAt = new Date().toISOString();
    cmd.error = error;
    const line = `[AMS STATE CHANGE] command=${cmd.commandId} type=${cmd.type} target=${cmd.target} before=${before} after=${status}${error ? ` error=${error}` : ''}`;
    if (status === 'COMPLETED') logger.info(line);
    else logger.warn(line);
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

/** The tray already shows the requested material and colour (printers that don't ack the setting) */
function settingApplied(cmd: AmsCommandRecord, state: PrinterState): boolean {
  const req = cmd.rawRequest.print as Record<string, unknown> | undefined;
  const tray = findTray(state, cmd.amsId, cmd.trayId);
  if (!req || !tray?.type || !tray.rawColor) return false;
  return tray.type.toUpperCase() === String(req.tray_type).toUpperCase()
    && tray.rawColor.slice(0, 6).toUpperCase() === String(req.tray_color).slice(0, 6).toUpperCase();
}

function getTimeoutFromEnv(type: AmsCommandType): number {
  const envVal = process.env.AMS_COMMAND_TIMEOUT_MS;
  if (envVal) {
    const num = parseInt(envVal, 10);
    if (!isNaN(num) && num > 0) return num;
  }
  // Load/unload heat the nozzle, cut, feed and purge: well over a minute on H2D
  return type === 'load' || type === 'unload' ? 180000 : 30000;
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
