import { describe, it, expect } from 'vitest';
import { BambuMessageParser } from '../src/bambu/BambuMessageParser.js';
import h2dFixture from './fixtures/h2d_raw_payload.json';

describe('BambuMessageParser - H2D RAW Telemetry Fixture', () => {
  it('should parse real Bambu Lab H2D raw payload fixture accurately per specification', () => {
    // 0. Test Mandatory RAW Fixture Keys
    const raw = h2dFixture as any;
    expect(raw.print.nozzle_temper).toBe(45);
    expect(raw.print.nozzle_target_temper).toBe(0);
    expect(raw.print.nozzle.info).toHaveLength(2);
    expect(raw.print.extruder.info[0].temp).toBe(45);
    expect(raw.print.extruder.info[1].temp).toBe(41);

    const parsedJson = BambuMessageParser.parseJsonPayload(JSON.stringify(h2dFixture));
    expect(parsedJson).not.toBeNull();

    const result = BambuMessageParser.parseReport(parsedJson!);

    // 1. PRIMARY SCALAR NOZZLE TEMP & NOZZLE HARDWARE INFO
    expect(result.temperatures?.nozzle.current).toBe(45);
    expect(result.temperatures?.nozzle.target).toBe(0);
    expect(result.temperatures?.nozzle.source).toBe('print.nozzle_temper');
    expect(result.temperatures?.nozzle.confidence).toBe('CONFIRMED');

    expect(result.temperatures?.nozzles).toBeDefined();
    expect(result.temperatures?.nozzles.length).toBe(2);

    expect(result.temperatures?.nozzles[0].id).toBe(0);
    expect(result.temperatures?.nozzles[1].id).toBe(1);

    // Nozzle 0 has current=45 from scalar nozzle_temper
    expect(result.temperatures?.nozzles[0].current).toBe(45);
    expect(result.temperatures?.nozzles[0].target).toBe(0);

    // Nozzle 1 temperature is NULL (not unconfirmedly guessed from extruder!)
    expect(result.temperatures?.nozzles[1].current).toBeNull();
    expect(result.temperatures?.nozzles[1].target).toBeNull();

    expect(result.temperatures?.nozzles[0].diameter).toBe(0.4);
    expect(result.temperatures?.nozzles[1].diameter).toBe(0.4);

    expect(result.temperatures?.nozzles[0].type).toBe('HS01');
    expect(result.temperatures?.nozzles[1].type).toBe('HS01');

    expect(result.temperatures?.nozzles[0].serial).toBe('NZ001');
    expect(result.temperatures?.nozzles[1].serial).toBe('NZ002');

    expect(result.temperatures?.nozzles[0].filamentId).toBe('GFA00');
    expect(result.temperatures?.nozzles[1].filamentId).toBe('GFA01');

    // 2. EXTRUDER (Separated from nozzle temp)
    expect(result.extruders).toBeDefined();
    expect(result.extruders?.length).toBe(2);

    expect(result.extruders?.[0].id).toBe(0);
    expect(result.extruders?.[1].id).toBe(1);

    expect(result.extruders?.[0].temp).toBe(45);
    expect(result.extruders?.[1].temp).toBe(41);

    expect(result.extruders?.[0].hnow).toBe(0);
    expect(result.extruders?.[0].hpre).toBe(0);
    expect(result.extruders?.[0].htar).toBe(0);
    expect(result.extruders?.[0].state).toBe(0);

    // Ensure no targetTemp assumptions
    expect((result.extruders?.[0] as any).targetTemp).toBeUndefined();

    // 3. BED
    expect(result.temperatures?.bed.current).toBe(44);
    expect(result.temperatures?.bed.target).toBe(0);

    // 4. CHAMBER
    expect(result.temperatures?.chamber.current).toBe(37);
    expect(result.temperatures?.chamber.confidence).toBe('POSSIBLE');
    expect(result.temperatures?.chamber.source).toBe('print.ctc.info.temp');

    // 5. AMS & TRAYS
    expect(result.ams).toBeDefined();
    expect(result.ams?.length).toBe(1);

    const amsUnit = result.ams![0];
    expect(amsUnit.id).toBe('0');
    expect(amsUnit.humidityRaw).toBe('40');
    expect(amsUnit.temperature).toBe(31.6);
    expect(amsUnit.trays.length).toBe(4);

    expect(amsUnit.trays[0].remain).toBe(100);
    expect(amsUnit.trays[0].type).toBe('PETG');
    expect(amsUnit.trays[0].subBrands).toBe('PETG Basic');
    expect(amsUnit.trays[0].color).toBe('#DBC8B6');
    expect(amsUnit.trays[0].rawColor).toBe('DBC8B6FF');

    expect(amsUnit.trays[2].remain).toBe(73);
    expect(amsUnit.trays[2].type).toBe('PLA');
    expect(amsUnit.trays[2].subBrands).toBe('PLA Lite');

    // 6. HMS
    expect(result.hmsErrors).toBeDefined();
    expect(result.hmsErrors?.length).toBe(1);
    expect(result.hmsErrors![0].attr).toBe(83887360);
    expect(result.hmsErrors![0].code).toBe(65543);

    // 7. PRINT & JOB
    expect(result.state).toBe('FINISHED');
    expect(result.progress).toBe(100);
    expect(result.job?.currentLayer).toBe(28);
    expect(result.job?.totalLayers).toBe(28);
    expect(result.job?.name).toBe('Torus');

    // 8. RAW EXTENSIONS (No duplicates of parsed keys like nozzle_temper)
    expect(result.rawExtensions).toBeDefined();
    expect(result.rawExtensions?.custom_h2d_unparsed_feature).toEqual({ feature_key: 'val123' });
    expect(result.rawExtensions?.nozzle_temper).toBeUndefined();
    expect(result.rawExtensions?.nozzle_target_temper).toBeUndefined();
    expect(result.rawExtensions?.gcode_state).toBeUndefined();
    expect(result.rawExtensions?.nozzle).toBeUndefined();
  });
});
