import { describe, it, expect } from 'vitest';
import { BambuMessageParser } from '../src/bambu/BambuMessageParser.js';
import { discoverTemperatureFields } from '../src/utils/temperatureDiscovery.js';
import h2dFixture from './fixtures/h2d_raw_payload.json';

describe('BambuMessageParser & Temperature Discovery - H2D RAW Telemetry Fixture', () => {
  it('should discover all temperature-related fields recursively in raw payload', () => {
    const discovered = discoverTemperatureFields(h2dFixture.print, 'print');
    const paths = discovered.map((d) => d.path);

    expect(paths).toContain('print.nozzle_temper');
    expect(paths).toContain('print.nozzle_target_temper');
    expect(paths).toContain('print.extruder.info[0].temp');
    expect(paths).toContain('print.extruder.info[1].temp');
    expect(paths).toContain('print.bed_temper');
    expect(paths).toContain('print.bed_target_temper');
    expect(paths).toContain('print.ams.ams[0].temp');
    expect(paths).toContain('print.ctc.info.temp');
  });

  it('should parse real Bambu Lab H2D raw payload fixture accurately per specification', () => {
    // 0. Test Mandatory RAW Fixture Keys
    const raw = h2dFixture as any;
    expect(raw.print.nozzle_temper).toBe(36);
    expect(raw.print.nozzle_target_temper).toBe(0);
    expect(raw.print.nozzle.src_id).toBe(0);
    expect(raw.print.nozzle.tar_id).toBe(0);
    expect(raw.print.nozzle.info).toHaveLength(2);
    expect(raw.print.extruder.info[0].temp).toBe(36);
    expect(raw.print.extruder.info[1].temp).toBe(36);

    const parsedJson = BambuMessageParser.parseJsonPayload(JSON.stringify(h2dFixture));
    expect(parsedJson).not.toBeNull();

    const result = BambuMessageParser.parseReport(parsedJson!);

    // 1. PRIMARY SCALAR MACHINE / ACTIVE NOZZLE TEMP & ACTIVE TOOL ID
    expect(result.temperatures?.nozzle.current).toBe(36);
    expect(result.temperatures?.nozzle.target).toBe(0);
    expect(result.temperatures?.nozzle.activeNozzleId).toBe(0);
    expect(result.temperatures?.nozzle.source).toBe('print.nozzle_temper');
    expect(result.temperatures?.nozzle.confidence).toBe('POSSIBLE');

    // 2. HARDWARE NOZZLES ARRAY (using extruder temp fallback)
    expect(result.temperatures?.nozzles).toBeDefined();
    expect(result.temperatures?.nozzles.length).toBe(2);

    expect(result.temperatures?.nozzles[0].id).toBe(0);
    expect(result.temperatures?.nozzles[1].id).toBe(1);

    expect(result.temperatures?.nozzles[0].current).toBe(36);
    expect(result.temperatures?.nozzles[0].temperatureConfidence).toBe('CONFIRMED');
    expect(result.temperatures?.nozzles[0].temperatureSource).toBe('print.extruder.info[0].temp');
    expect(result.temperatures?.nozzles[0].tm).toBe(0);

    expect(result.temperatures?.nozzles[1].current).toBe(36);
    expect(result.temperatures?.nozzles[1].temperatureConfidence).toBe('CONFIRMED');
    expect(result.temperatures?.nozzles[1].temperatureSource).toBe('print.extruder.info[1].temp');
    expect(result.temperatures?.nozzles[1].tm).toBe(0);

    expect(result.temperatures?.nozzles[0].diameter).toBe(0.4);
    expect(result.temperatures?.nozzles[1].diameter).toBe(0.4);

    expect(result.temperatures?.nozzles[0].type).toBe('HS01');
    expect(result.temperatures?.nozzles[1].type).toBe('HS01');

    expect(result.temperatures?.nozzles[0].serial).toBe('N/A');
    expect(result.temperatures?.nozzles[1].serial).toBe('N/A');

    expect(result.temperatures?.nozzles[0].filamentId).toBe('');
    expect(result.temperatures?.nozzles[1].filamentId).toBe('');

    // 3. EXTRUDER (Extruder telemetry)
    expect(result.extruders).toBeDefined();
    expect(result.extruders?.length).toBe(2);

    expect(result.extruders?.[0].id).toBe(0);
    expect(result.extruders?.[1].id).toBe(1);

    expect(result.extruders?.[0].temp).toBe(36);
    expect(result.extruders?.[1].temp).toBe(36);

    expect(result.extruders?.[0].hnow).toBe(0);
    expect(result.extruders?.[0].hpre).toBe(0);
    expect(result.extruders?.[0].htar).toBe(0);

    expect(result.extruders?.[1].hnow).toBe(1);
    expect(result.extruders?.[1].hpre).toBe(1);
    expect(result.extruders?.[1].htar).toBe(1);

    // 4. BED & CHAMBER
    expect(result.temperatures?.bed.current).toBe(44);
    expect(result.temperatures?.bed.target).toBe(0);
    expect(result.temperatures?.chamber.current).toBe(37);

    // 5. AMS & TRAYS
    expect(result.ams).toBeDefined();
    expect(result.ams?.length).toBe(1);

    // 6. RAW EXTENSIONS (No duplicates of parsed keys like nozzle_temper)
    expect(result.rawExtensions).toBeDefined();
    expect(result.rawExtensions?.custom_h2d_unparsed_feature).toEqual({ feature_key: 'val123' });
    expect(result.rawExtensions?.nozzle_temper).toBeUndefined();
    expect(result.rawExtensions?.nozzle_target_temper).toBeUndefined();
    expect(result.rawExtensions?.gcode_state).toBeUndefined();
    expect(result.rawExtensions?.nozzle).toBeUndefined();
  });

  it('should map nozzle temperatures directly from print.extruder.info structure', () => {
    const rawPayload = {
      print: {
        extruder: {
          info: [
            {
              filam_bak: [],
              hnow: 0,
              hpre: 0,
              htar: 0,
              id: 0,
              info: 1032,
              snow: 65535,
              spre: 65535,
              star: 255,
              stat: 0,
              temp: 41,
            },
            {
              filam_bak: [],
              hnow: 1,
              hpre: 1,
              htar: 1,
              id: 1,
              info: 1048,
              snow: 65279,
              spre: 65279,
              star: 65279,
              stat: 0,
              temp: 33,
            },
          ],
          state: 2,
        },
      },
    };

    const parsed = BambuMessageParser.parseReport(rawPayload as any);

    expect(parsed.temperatures?.nozzles).toBeDefined();
    expect(parsed.temperatures?.nozzles).toHaveLength(2);

    expect(parsed.temperatures?.nozzles[0].id).toBe(0);
    expect(parsed.temperatures?.nozzles[0].current).toBe(41);
    expect(parsed.temperatures?.nozzles[0].temperatureSource).toBe('print.extruder.info[0].temp');

    expect(parsed.temperatures?.nozzles[1].id).toBe(1);
    expect(parsed.temperatures?.nozzles[1].current).toBe(33);
    expect(parsed.temperatures?.nozzles[1].temperatureSource).toBe('print.extruder.info[1].temp');
  });

  it('should filter out uint16 sentinel overflow values (65535, 65279) and keep valid temperatures', () => {
    const rawPayload = {
      print: {
        extruder: {
          info: [
            {
              filam_bak: [],
              hnow: 0,
              hpre: 0,
              htar: 0,
              id: 0,
              info: 1032,
              snow: 65535,
              spre: 65535,
              star: 255,
              stat: 0,
              temp: 220,
            },
            {
              filam_bak: [],
              hnow: 1,
              hpre: 1,
              htar: 1,
              id: 1,
              info: 1048,
              snow: 65279,
              spre: 65279,
              star: 65279,
              stat: 0,
              temp: 65535, // Uncalibrated / disabled sensor value sent by firmware
            },
          ],
          state: 2,
        },
      },
    };

    const parsed = BambuMessageParser.parseReport(rawPayload as any);

    expect(parsed.temperatures?.nozzles[0].current).toBe(220);
    expect(parsed.temperatures?.nozzles[0].target).toBe(0); // htar: 0 is ignored, target is valid number 0

    expect(parsed.temperatures?.nozzles[1].current).toBeNull(); // 65535 filtered out to null instead of 65535°C
    expect(parsed.temperatures?.nozzles[1].target).toBe(0); // htar: 1 is ignored instead of target = 1°C
  });
});
