import { EventEmitter } from 'events';
import { CapabilityRegistry } from '../capabilities/CapabilityRegistry.js';
import { CommandAuditLog } from './CommandAuditLog.js';
import { CommandQueue } from './CommandQueue.js';
import { PrinterStateStore } from '../PrinterStateStore.js';
import { BambuMqttClient } from '../../bambu/BambuMqttClient.js';
import { BambuCommandBuilder } from '../../bambu/commands/BambuCommandBuilder.js';
import { logger } from '../../logger/logger.js';
import { env } from '../../config/env.js';

export interface ExecuteCommandOptions {
  capabilityId: string;
  commandName: string;
  payloadBuilder: () => Record<string, unknown>;
  logPayload?: unknown;
}

export class CommandExecutionError extends Error {
  constructor(message: string, public statusCode: number, public errorCode: string) {
    super(message);
    this.name = 'CommandExecutionError';
  }
}

export class PrinterCommandService extends EventEmitter {
  private auditLog = new CommandAuditLog();
  private queue = new CommandQueue();

  constructor(
    private capabilityRegistry: CapabilityRegistry,
    private stateStore: PrinterStateStore,
    private mqttClient: BambuMqttClient
  ) {
    super();
  }

  public getAuditLog(): CommandAuditLog {
    return this.auditLog;
  }

  public async executeCommand(options: ExecuteCommandOptions): Promise<{ success: boolean; commandId: string; message: string }> {
    const { capabilityId, commandName, payloadBuilder, logPayload } = options;
    const commandId = `cmd_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    // 1. Capability check
    const capability = this.capabilityRegistry.getCapability(capabilityId);
    if (!capability || capability.status !== 'SUPPORTED') {
      throw new CommandExecutionError(
        `Capability '${capabilityId}' is not supported or status is UNKNOWN`,
        501,
        'NOT_SUPPORTED'
      );
    }

    // 2. Real Printer Mode safety check
    if (!env.BAMBU_REAL_PRINTER) {
      logger.warn({ commandId, commandName }, 'Blocked command execution because BAMBU_REAL_PRINTER=false');
      throw new CommandExecutionError(
        `Command execution blocked: BAMBU_REAL_PRINTER is set to false. Set BAMBU_REAL_PRINTER=true in .env to allow sending commands to real printer.`,
        403,
        'TEST_MODE_RESTRICTED'
      );
    }

    // 3. Printer Connection check
    if (!this.stateStore.isOnline() && !this.mqttClient.isConnected()) {
      throw new CommandExecutionError('Printer is currently offline or disconnected from MQTT', 503, 'PRINTER_OFFLINE');
    }

    // Record audit entry
    this.auditLog.addEntry({
      id: commandId,
      command: commandName,
      capabilityId,
      payload: logPayload,
      createdAt: new Date().toISOString(),
      success: false,
    });

    this.emit('command.started', { commandId, command: commandName });

    // Enqueue & execute
    try {
      const result = await this.queue.enqueue(
        commandId,
        commandName,
        async () => {
          const payload = payloadBuilder();

          if (env.BAMBU_DEBUG_PROTOCOL) {
            logger.info({ commandId, commandName, topic: `device/${env.BAMBU_SERIAL}/request`, payload }, '[DEBUG PROTOCOL] Sending MQTT payload');
          }

          const publishSuccess = await this.mqttClient.publishRequest(payload);
          if (!publishSuccess) {
            throw new Error(`Failed to publish MQTT message for command '${commandName}'`);
          }

          return { success: true, message: `Command '${commandName}' sent successfully to printer` };
        },
        env.COMMAND_TIMEOUT_MS
      );

      this.auditLog.updateEntry(commandId, {
        completedAt: new Date().toISOString(),
        success: true,
        message: result.message,
      });

      this.emit('command.completed', { commandId, command: commandName, success: true });
      return { success: true, commandId, message: result.message };
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.auditLog.updateEntry(commandId, {
        completedAt: new Date().toISOString(),
        success: false,
        error: errorMsg,
      });

      this.emit('command.failed', { commandId, command: commandName, success: false, error: errorMsg });

      if (errorMsg.includes('timed out')) {
        throw new CommandExecutionError(errorMsg, 504, 'COMMAND_TIMEOUT');
      }
      throw new CommandExecutionError(errorMsg, 500, 'EXECUTION_FAILED');
    }
  }

  // Helper Methods for Specific Commands
  public pausePrint(): Promise<{ success: boolean; commandId: string; message: string }> {
    return this.executeCommand({
      capabilityId: 'print.pause',
      commandName: 'pause',
      payloadBuilder: () => BambuCommandBuilder.buildPausePayload(),
    });
  }

  public resumePrint(): Promise<{ success: boolean; commandId: string; message: string }> {
    return this.executeCommand({
      capabilityId: 'print.resume',
      commandName: 'resume',
      payloadBuilder: () => BambuCommandBuilder.buildResumePayload(),
    });
  }

  public stopPrint(): Promise<{ success: boolean; commandId: string; message: string }> {
    return this.executeCommand({
      capabilityId: 'print.stop',
      commandName: 'stop',
      payloadBuilder: () => BambuCommandBuilder.buildStopPayload(),
    });
  }

  public setNozzleTemperature(target: number): Promise<{ success: boolean; commandId: string; message: string }> {
    return this.executeCommand({
      capabilityId: 'temperature.nozzle',
      commandName: 'set_nozzle_temp',
      logPayload: { target },
      payloadBuilder: () => BambuCommandBuilder.buildSetNozzleTempPayload(target),
    });
  }

  public setBedTemperature(target: number): Promise<{ success: boolean; commandId: string; message: string }> {
    return this.executeCommand({
      capabilityId: 'temperature.bed',
      commandName: 'set_bed_temp',
      logPayload: { target },
      payloadBuilder: () => BambuCommandBuilder.buildSetBedTempPayload(target),
    });
  }

  public setFanSpeed(fanType: 'part' | 'aux' | 'chamber', speedPercentage: number): Promise<{ success: boolean; commandId: string; message: string }> {
    return this.executeCommand({
      capabilityId: `fan.${fanType}`,
      commandName: `set_${fanType}_fan_speed`,
      logPayload: { fanType, speedPercentage },
      payloadBuilder: () => BambuCommandBuilder.buildSetFanSpeedPayload(fanType, speedPercentage),
    });
  }
}
