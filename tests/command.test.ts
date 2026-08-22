import { describe, it, expect, beforeEach } from 'vitest';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry.js';
import { BambuCommandBuilder } from '../src/bambu/commands/BambuCommandBuilder.js';
import { CommandQueue } from '../src/domain/commands/CommandQueue.js';
import { CommandAuditLog } from '../src/domain/commands/CommandAuditLog.js';

describe('Command Architecture & Capability System', () => {
  let capabilityRegistry: CapabilityRegistry;

  beforeEach(() => {
    capabilityRegistry = new CapabilityRegistry();
  });

  it('CapabilityRegistry should register default capabilities correctly', () => {
    const caps = capabilityRegistry.getAllCapabilities();
    expect(caps.length).toBeGreaterThan(5);

    const pauseCap = capabilityRegistry.getCapability('print.pause');
    expect(pauseCap).toBeDefined();
    expect(pauseCap?.status).toBe('SUPPORTED');

    const startCap = capabilityRegistry.getCapability('print.start');
    expect(startCap?.status).toBe('UNKNOWN');

    const uploadCap = capabilityRegistry.getCapability('file.upload');
    expect(uploadCap?.status).toBe('UNSUPPORTED');
  });

  it('BambuCommandBuilder should build valid Bambu LAN MQTT JSON payloads', () => {
    const pausePayload = BambuCommandBuilder.buildPausePayload() as any;
    expect(pausePayload.print).toBeDefined();
    expect(pausePayload.print.command).toBe('pause');
    expect(pausePayload.print.sequence_id).toBeDefined();

    const nozzlePayload = BambuCommandBuilder.buildSetNozzleTempPayload(230, 0) as any;
    expect(nozzlePayload.print.command).toBe('gcode_line');
    expect(nozzlePayload.print.param).toBe('M104 S230\n');

    const nozzle2Payload = BambuCommandBuilder.buildSetNozzleTempPayload(245, 1) as any;
    expect(nozzle2Payload.print.command).toBe('gcode_line');
    expect(nozzle2Payload.print.param).toBe('M104 T1 S245\n');

    const fanPayload = BambuCommandBuilder.buildSetFanSpeedPayload('part', 80) as any;
    expect(fanPayload.print.command).toBe('gcode_line');
    expect(fanPayload.print.param).toBe('M106 P1 S204\n');
  });

  it('CommandQueue should process tasks sequentially in FIFO order', async () => {
    const queue = new CommandQueue();
    const order: number[] = [];

    const p1 = queue.enqueue('c1', 'cmd1', async () => {
      order.push(1);
      return 1;
    });

    const p2 = queue.enqueue('c2', 'cmd2', async () => {
      order.push(2);
      return 2;
    });

    const results = await Promise.all([p1, p2]);
    expect(results).toEqual([1, 2]);
    expect(order).toEqual([1, 2]);
  });

  it('CommandAuditLog should record and retrieve audit entries', () => {
    const auditLog = new CommandAuditLog();
    auditLog.addEntry({
      id: 'cmd_1',
      command: 'pause',
      capabilityId: 'print.pause',
      createdAt: new Date().toISOString(),
      success: true,
    });

    const entries = auditLog.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].command).toBe('pause');

    const found = auditLog.getEntryById('cmd_1');
    expect(found).toBeDefined();
  });
});
