import { describe, it, expect } from 'vitest';
import { BambuMessageParser } from '../src/bambu/BambuMessageParser.js';

describe('BambuMessageParser', () => {
  it('should parse valid MQTT JSON payload correctly', () => {
    const rawPayload = {
      print: {
        gcode_state: 'RUNNING',
        mc_percent: 45,
        nozzle_temper: 220.5,
        nozzle_target_temper: 220,
        bed_temper: 60.1,
        bed_target_temper: 60,
        chamber_temper: 35,
        subtask_name: 'test_cube.3mf',
        layer_num: 50,
        total_layer_num: 200,
        mc_remaining_time: 15,
        cooling_fan_speed: '12',
        big_fan1_speed: 8,
        big_fan2_speed: '0',
      },
    };

    const parsedJson = BambuMessageParser.parseJsonPayload(JSON.stringify(rawPayload));
    expect(parsedJson).not.toBeNull();

    const result = BambuMessageParser.parseReport(parsedJson!);
    expect(result.state).toBe('RUNNING');
    expect(result.progress).toBe(45);
    expect(result.temperatures?.nozzle.current).toBe(220.5);
    expect(result.temperatures?.nozzle.target).toBe(220);
    expect(result.temperatures?.bed.current).toBe(60.1);
    expect(result.temperatures?.bed.target).toBe(60);
    expect(result.temperatures?.chamber).toBe(35);
    expect(result.job?.name).toBe('test_cube.3mf');
    expect(result.job?.currentLayer).toBe(50);
    expect(result.job?.totalLayers).toBe(200);
    expect(result.job?.remainingTimeMinutes).toBe(15);
    expect(result.fan?.part).toBe(12);
    expect(result.fan?.aux).toBe(8);
    expect(result.fan?.chamber).toBe(0);
  });

  it('should handle payload with missing fields gracefully without throwing', () => {
    const rawPayload = {
      print: {
        mc_percent: 10,
      },
    };

    const parsedJson = BambuMessageParser.parseJsonPayload(JSON.stringify(rawPayload));
    expect(parsedJson).not.toBeNull();

    const result = BambuMessageParser.parseReport(parsedJson!);
    expect(result.state).toBeUndefined();
    expect(result.progress).toBe(10);
    expect(result.temperatures?.nozzle.current).toBeNull();
    expect(result.job?.name).toBeNull();
    expect(result.fan?.part).toBeNull();
  });

  it('should handle invalid JSON strings safely without crashing', () => {
    const invalidJson = '{ bad json syntax: 123 ';
    const parsed = BambuMessageParser.parseJsonPayload(invalidJson);
    expect(parsed).toBeNull();
  });

  it('should handle non-object JSON values safely', () => {
    const stringJson = '"just a string"';
    const parsed = BambuMessageParser.parseJsonPayload(stringJson);
    expect(parsed).toBeNull();
  });
});
