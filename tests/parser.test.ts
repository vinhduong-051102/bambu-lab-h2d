import { describe, it, expect } from 'vitest';
import { BambuMessageParser } from '../src/bambu/BambuMessageParser.js';
import h2dFixture from './fixtures/h2d_raw_payload.json';

describe('BambuMessageParser with H2D Raw Telemetry Fixture', () => {
  it('should parse real Bambu Lab H2D raw payload fixture accurately', () => {
    const parsedJson = BambuMessageParser.parseJsonPayload(JSON.stringify(h2dFixture));
    expect(parsedJson).not.toBeNull();

    const result = BambuMessageParser.parseReport(parsedJson!);

    // 1. Nozzles parsing (print.nozzle.info[])
    expect(result.temperatures?.nozzles).toBeDefined();
    expect(result.temperatures?.nozzles.length).toBe(2);

    expect(result.temperatures?.nozzles[0].current).toBe(45);
    expect(result.temperatures?.nozzles[0].diameter).toBe(0.4);

    expect(result.temperatures?.nozzles[1].current).toBe(41);
    expect(result.temperatures?.nozzles[1].diameter).toBe(0.4);

    // 2. Extruders parsing (print.extruder.info[])
    expect(result.extruders).toBeDefined();
    expect(result.extruders?.length).toBe(2);
    expect(result.extruders?.[0].temp).toBe(44);
    expect(result.extruders?.[1].temp).toBe(40);

    // 3. AMS & Trays parsing
    expect(result.ams).toBeDefined();
    expect(result.ams?.length).toBe(1);
    const unit = result.ams![0];
    expect(unit.filaments.length).toBe(4);
    expect(unit.filaments[0].remainingPercentage).toBe(100);
    expect(unit.filaments[2].remainingPercentage).toBe(73);
    expect(unit.filaments[0].color).toBe('#DBC8B6');
    expect(unit.filaments[0].rawColor).toBe('DBC8B6FF');

    // 4. HMS Diagnostics parsing (code = 65543)
    expect(result.hmsErrors).toBeDefined();
    expect(result.hmsErrors?.length).toBe(1);
    expect(result.hmsErrors![0].code).toBe(65543);

    // 5. Job & Printer State
    expect(result.state).toBe('FINISHED');
    expect(result.progress).toBe(100);
    expect(result.job?.currentLayer).toBe(28);
    expect(result.job?.totalLayers).toBe(28);
    expect(result.job?.name).toBe('Torus');

    // 6. Chamber temperature from ctc.info.temp
    expect(result.temperatures?.chamber).toBe(26);

    // 7. Raw extensions preserving extra H2D features
    expect(result.rawExtensions).toBeDefined();
    expect(result.rawExtensions?.custom_h2d_feature).toEqual({ version: '1.0.4', mode: 'dual' });
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
    expect(result.temperatures?.nozzles).toEqual([]);
    expect(result.job?.name).toBeNull();
  });

  it('should handle invalid JSON strings safely without crashing', () => {
    const invalidJson = '{ bad json syntax: 123 ';
    const parsed = BambuMessageParser.parseJsonPayload(invalidJson);
    expect(parsed).toBeNull();
  });
});
