import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { BambuColourCatalogue, familyOf, parseCatalogue } from '../src/domain/filaments/bambuColors';
import { deltaLabel, parseRecipes, suggestMix } from '../src/domain/filaments/colourMixing';
import { setBambuColours, setMixRecipes } from '../src/domain/filaments/catalogueStore';
import { CustomFilamentStore } from '../src/domain/filaments/customFilaments';
import { setCustomFilamentStore } from '../src/api/routes/filaments';
import { setCadJobStore, setMeshWorker } from '../src/api/routes/cad';
import { CadJobStore, type MeshParams, type MeshWorkerApi } from '../src/domain/cad/cadJobs';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { renderPaletteEntry } from '../src/ui/cad.js';
import { createTestApp, type TestApp } from './helpers/testApp';

const single = (code: string, id: string, type: string, name: string, hex: string) => ({
  fila_color_code: code,
  fila_id: id,
  fila_color_type: '单色',
  fila_type: type,
  fila_color_name: { en: name },
  fila_color: [`${hex}FF`],
});

const CATALOGUE = {
  data: [
    single('10300', 'GFA00', 'PLA Basic', 'Orange', '#FF6A13'),
    single('10101', 'GFA00', 'PLA Basic', 'Black', '#000000'),
    single('10200', 'GFA00', 'PLA Basic', 'Red', '#C12E1F'),
    single('10400', 'GFA00', 'PLA Basic', 'Yellow', '#F4EE2A'),
    single('10100', 'GFA00', 'PLA Basic', 'Jade White', '#FFFFFF'),
    single('11500', 'GFA01', 'PLA Matte', 'Mandarin Orange', '#F99963'),
    single('65500', 'GFS02', 'Support for PLA', 'White', '#FFFFFF'),
    single('30101', 'GFG00', 'PETG Basic', 'Black', '#000000'),
    single('13800', 'GFA17', 'PLA Translucent', 'Translucent Brown', '#C9A381'),
  ],
};

const RECIPES = {
  entries: [
    { mode: 'RYBW', material: 'PLA Basic', components: [{ key: 'Red', rgb: '#C12E1F' }, { key: 'Yellow', rgb: '#F4EE2A' }], ratios: [50, 50], measured_rgb: '#D2702F', source: 'measured' },
    { mode: 'RYBW', material: 'PLA Basic', components: [{ key: 'Red', rgb: '#C12E1F' }, { key: 'White', rgb: '#FFFFFF' }], ratios: [30, 70], measured_rgb: '#E7A39A', source: 'measured' },
    { mode: 'CMYW', material: 'PLA Basic', components: [{ key: 'Cyan', rgb: '#0086D6' }, { key: 'White', rgb: '#FFFFFF' }], ratios: [40, 60], measured_rgb: '#80B3DB', source: 'measured' },
  ],
};

describe('colour mixing and families', () => {
  it('finds the recipe that prints closest to a colour', () => {
    const recipes = parseRecipes(RECIPES);
    expect(recipes[0]).toMatchObject({ mode: 'RYBW', hex: '#D2702F', components: [{ key: 'Red', hex: '#C12E1F', percent: 50 }, { key: 'Yellow', hex: '#F4EE2A', percent: 50 }] });
    const orange = suggestMix(recipes, '#CF7232');
    expect(orange?.recipe.hex).toBe('#D2702F');
    expect(orange!.deltaE).toBeLessThan(3);
    expect(suggestMix(recipes, '#7FB2DA')?.recipe.mode).toBe('CMYW');
    expect(suggestMix([], '#000000')).toBeNull();
  });

  it('puts colour differences in words', () => {
    expect([1, 4, 9, 20].map(deltaLabel)).toEqual(['giống', 'gần đúng', 'hơi lệch', 'lệch rõ']);
  });

  it('groups materials into families that print together, support materials apart', () => {
    expect(['PLA Basic', 'PLA-CF', 'PETG HF', 'Support for PLA', 'PVA'].map(familyOf)).toEqual(['PLA', 'PLA', 'PETG', null, null]);
    const catalogue = new BambuColourCatalogue(parseCatalogue(CATALOGUE));
    expect(catalogue.families()).toEqual([{ family: 'PLA', materials: 3, colours: 7 }]);
    // Whole families leave out see-through filament, whose listed colour isn't how a solid print looks
    expect(catalogue.ofFamily('PLA').map((c) => c.material)).not.toContain('PLA Translucent');
    expect(catalogue.ofFamily('PLA').map((c) => c.name)).toContain('Mandarin Orange');
  });

  it('draws a filament far from the model\'s colour with its difference and the mixing recipe', () => {
    const html = renderPaletteEntry({
      slot: 2,
      hex: '#FF6A13',
      label: 'PLA Basic Orange (10300)',
      share: 0.3,
      source_hex: '#CF7232',
      delta_e: 14.2,
      mix: {
        components: [
          { key: 'Red', hex: '#C12E1F', percent: 50, name: 'PLA Basic Red (10200)' },
          { key: 'Yellow', hex: '#F4EE2A', percent: 50, name: null },
        ],
        hex: '#D2702F',
        delta_e: 2.1,
      },
    });
    expect(html).toContain('2. #FF6A13 30% · PLA Basic Orange (10300)');
    expect(html).toContain('cad-delta-far');
    expect(html).toContain('gốc #CF7232 · lệch rõ');
    expect(html).toContain('PLA Basic Red (10200) 50%');
    expect(html).toContain('Yellow 50%');
    expect(html).toContain('#D2702F (giống, ΔE 2.1)');
    // A filament on the model's own colour says nothing more
    expect(renderPaletteEntry({ slot: 1, hex: '#000000', label: null, share: 0.5, source_hex: '#010101', delta_e: 0.4 })).not.toContain('cad-delta');
  });
});

describe('"Filament của tôi" and figure colours', () => {
  let app: TestApp;
  let dir: string;
  let generated: MeshParams[];

  beforeEach(async () => {
    const stateStore = new PrinterStateStore('TEST_SERIAL_FILAMENTS');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_FILAMENTS', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filaments-'));
    generated = [];
    const worker: MeshWorkerApi = {
      health: async () => ({ ok: true, claude: true, running: [], loaded: false }),
      generate: async (_id, params) => {
        generated.push(params);
      },
      fix: async () => {},
      cancel: async () => {},
    };
    setCustomFilamentStore(new CustomFilamentStore(path.join(dir, 'custom.json')));
    setCadJobStore(new CadJobStore(path.join(dir, 'jobs')));
    setMeshWorker(worker);
    setBambuColours(new BambuColourCatalogue(parseCatalogue(CATALOGUE)));
    setMixRecipes(parseRecipes(RECIPES));
  });

  afterEach(async () => {
    app.close();
    setCustomFilamentStore(null);
    setCadJobStore(null);
    setMeshWorker(null);
    setBambuColours(undefined);
    setMixRecipes(undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });

  const add = (payload: unknown) => app.inject({ method: 'POST', url: '/api/filaments/custom', payload });

  it('saves, lists and deletes custom filaments', async () => {
    const res = await add({ name: 'Cam đất', brand: 'eSun', material: 'PLA', hex: 'c8783c' });
    expect(res.statusCode).toBe(201);
    const { filament } = res.json();
    expect(filament).toMatchObject({ name: 'Cam đất', brand: 'eSun', material: 'PLA', hex: '#C8783C' });
    expect((await add({ name: 'Sai', material: 'PLA', hex: '#12' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/filaments/custom' })).json().filaments).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/filaments/custom/${filament.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/filaments/custom/${filament.id}` })).statusCode).toBe(404);
  });

  it('paints a figure in the ticked custom filaments', async () => {
    const a = (await add({ name: 'Cam đất', brand: 'eSun', material: 'PLA', hex: '#C8783C' })).json().filament;
    const b = (await add({ name: 'Kem', material: 'PLA', hex: '#F2E6D0' })).json().filament;
    await add({ name: 'Không dùng', material: 'PLA', hex: '#00FF00' });
    const res = await app.inject({ method: 'POST', url: '/api/cad/meshes', payload: { prompt: 'Mèo', colour: true, palette: 'custom', filaments: `${a.id},${b.id}`, colours: 3 } });
    expect(res.statusCode).toBe(202);
    expect(generated[0].colour).toMatchObject({
      count: 3,
      snap: [
        { hex: '#C8783C', label: 'eSun PLA Cam đất' },
        { hex: '#F2E6D0', label: 'PLA Kem' },
      ],
    });
    const few = await app.inject({ method: 'POST', url: '/api/cad/meshes', payload: { prompt: 'Mèo', colour: true, palette: 'custom', filaments: a.id } });
    expect(few.json().error).toBe('TOO_FEW_FILAMENTS');
  });

  it('prefers what the AMS holds, then the user\'s own, then Bambu\'s colours of the AMS\'s family to buy', async () => {
    await add({ name: 'Cam đất', brand: 'eSun', material: 'PLA', hex: '#C8783C' });
    const res = await app.inject({ method: 'POST', url: '/api/cad/meshes', payload: { prompt: 'Mèo', colour: true, palette: 'prefer', colours: 4 } });
    expect(res.statusCode).toBe(202);
    const colour = generated[0].colour as { snap: { label: string; tier: number; origin: string }[]; request: unknown };
    // No AMS in this printer state: the user's filament first, then every PLA colour (the default family) to buy
    expect(colour.snap[0]).toEqual({ hex: '#C8783C', label: 'eSun PLA Cam đất', tier: 2, origin: 'custom' });
    expect(colour.snap.slice(1).every((c) => c.tier === 3 && c.origin === 'bambu')).toBe(true);
    expect(colour.snap.map((c) => c.label)).toContain('PLA Matte Mandarin Orange (11500)');
    expect(colour.request).toEqual({ palette: 'prefer', colours: 4, material: '', filaments: '' });
  });

  it('paints a figure in a whole family\'s Bambu colours', async () => {
    await app.inject({ method: 'POST', url: '/api/cad/meshes', payload: { prompt: 'Mèo', colour: true, palette: 'bambu', material: 'family:PLA' } });
    const labels = (generated[0].colour as { snap: { label: string }[] }).snap.map((s) => s.label);
    expect(labels).toContain('PLA Matte Mandarin Orange (11500)');
    expect(labels).not.toContain('Support for PLA White (65500)');
    expect(labels).not.toContain('PETG Basic Black (30101)');
  });

  it('suggests a mixing recipe for a filament far from the model\'s colour', async () => {
    const { job } = (await app.inject({ method: 'POST', url: '/api/cad/meshes', payload: { prompt: 'Mèo', colour: true } })).json();
    const out = path.join(dir, 'jobs', job.id, 'out');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'jobs', job.id, 'status.json'),
      JSON.stringify({
        state: 'done',
        report: {
          ok: true,
          palette: [
            { slot: 1, hex: '#000000', label: 'PLA Basic Black (10101)', share: 0.6, source_hex: '#050505', delta_e: 1.2 },
            { slot: 2, hex: '#FF6A13', label: 'PLA Basic Orange (10300)', share: 0.4, source_hex: '#CF7232', delta_e: 14.2 },
          ],
        },
      })
    );
    const palette = (await app.inject({ method: 'GET', url: `/api/cad/jobs/${job.id}` })).json().job.report.palette;
    expect(palette[0].mix).toBeUndefined();
    expect(palette[1].mix).toMatchObject({
      hex: '#D2702F',
      components: [
        { key: 'Red', percent: 50, name: 'PLA Basic Red (10200)' },
        { key: 'Yellow', percent: 50, name: 'PLA Basic Yellow (10400)' },
      ],
    });
  });
});
