import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { BambuColourCatalogue, deltaE, parseCatalogue } from '../src/domain/filaments/bambuColors';
import { bambuColours, setBambuColours } from '../src/domain/filaments/catalogueStore';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { normalizePrinterState } from '../src/domain/normalizePrinterState';
import { CadJobStore, type MeshParams, type MeshWorkerApi } from '../src/domain/cad/cadJobs';
import { setCadJobStore, setMeshWorker } from '../src/api/routes/cad';
import { createTestApp, type TestApp } from './helpers/testApp';

/** A few entries in the shape of Bambu Studio's filaments_color_codes.json */
const RAW = {
  data: [
    { fila_color_code: '10300', fila_id: 'GFA00', fila_color_type: '单色', fila_type: 'PLA Basic', fila_color_name: { en: 'Orange', zh: '橙色' }, fila_color: ['#FF6A13FF'] },
    { fila_color_code: '10101', fila_id: 'GFA00', fila_color_type: '单色', fila_type: 'PLA Basic', fila_color_name: { en: 'Black' }, fila_color: ['#000000FF'] },
    { fila_color_code: '10100', fila_id: 'GFA00', fila_color_type: '单色', fila_type: 'PLA Basic', fila_color_name: { en: 'Jade White' }, fila_color: ['#FFFFFFFF'] },
    { fila_color_code: '10900', fila_id: 'GFA00', fila_color_type: '渐变色', fila_type: 'PLA Basic', fila_color_name: { en: 'Arctic Whisper' }, fila_color: ['#9CDBD9FF', '#FFFFFFFF'] },
    { fila_color_code: '16603', fila_id: 'GFA18', fila_color_type: '单色', fila_type: 'PLA Lite', fila_color_name: { en: 'Cyan' }, fila_color: ['#4DAFDAFF'] },
    { fila_color_code: '33102', fila_id: 'GFG00', fila_color_type: '单色', fila_type: 'PETG Basic', fila_color_name: { en: 'Black' }, fila_color: ['#000000FF'] },
  ],
};

const catalogue = () => new BambuColourCatalogue(parseCatalogue(RAW));

describe('Bambu colour catalogue', () => {
  it('reads Bambu Studio\'s file: spool code, material, English name, colours, kind', () => {
    const colours = parseCatalogue(RAW);
    expect(colours[0]).toEqual({ code: '10300', filamentId: 'GFA00', material: 'PLA Basic', name: 'Orange', hex: ['#FF6A13'], kind: 'single' });
    expect(colours[3]).toMatchObject({ kind: 'gradient', hex: ['#9CDBD9', '#FFFFFF'] });
    expect(() => parseCatalogue({})).toThrow();
  });

  it('measures colour difference in Lab', () => {
    expect(deltaE('#FF6A13', '#FF6A13')).toBe(0);
    expect(deltaE('#000000', '#FFFFFF')).toBeCloseTo(100, 0);
  });

  it('names an AMS tray by its material id and colour, and nothing else', () => {
    const c = catalogue();
    expect(c.identify('GFA18', '#4DAFDA')?.name).toBe('Cyan');
    expect(c.identify('GFA00', 'FF6B14FF')?.code).toBe('10300');
    // The same colour of another material, a colour Bambu doesn't make, and no material id
    expect(c.identify('GFG00', '#FF6A13')).toBeNull();
    expect(c.identify('GFA00', '#3366FF')).toBeNull();
    expect(c.identify(null, '#FF6A13')).toBeNull();
  });

  it('lists materials by their number of single colours, and one material\'s colours', () => {
    const c = catalogue();
    expect(c.materials(1).map((m) => [m.material, m.colours])).toEqual([['PLA Basic', 3], ['PETG Basic', 1], ['PLA Lite', 1]]);
    expect(c.ofMaterial('PLA Basic').map((x) => x.name)).toEqual(['Orange', 'Black', 'Jade White']);
  });

  it('loads the catalogue from its cached copy', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-colours-'));
    try {
      const file = path.join(dir, 'filaments_color_codes.json');
      await fs.writeFile(file, JSON.stringify(RAW));
      const loaded = await bambuColours(file, 'http://127.0.0.1:9/never-fetched');
      expect(loaded?.colours).toHaveLength(6);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Bambu colours in the API', () => {
  let app: TestApp;
  let stateStore: PrinterStateStore;

  beforeEach(() => {
    stateStore = new PrinterStateStore('TEST_SERIAL_COLOURS');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_COLOURS', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);
    setBambuColours(catalogue());
    const tray = (id: string, type: string, idx: string, color: string) => ({ id, tray_type: type, tray_sub_brands: type, tray_info_idx: idx, tray_color: color, state: 11 });
    stateStore.updateState(
      normalizePrinterState(stateStore.getState(), {
        print: { ams: { ams: [{ id: '0', tray: [tray('0', 'PLA', 'GFA18', '4DAFDAFF'), tray('1', 'PLA', 'GFL99', 'FF6A13FF')] }] } },
      })
    );
  });

  afterEach(() => {
    app.close();
    setBambuColours(undefined);
    setMeshWorker(null);
    setCadJobStore(null);
  });

  it('serves the catalogue, or one material of it', async () => {
    const all = (await app.inject({ method: 'GET', url: '/api/filaments/colors' })).json();
    expect(all.colours).toHaveLength(6);
    expect(all.materials[0]).toEqual({ material: 'PLA Basic', filamentId: 'GFA00', colours: 3 });
    const pla = (await app.inject({ method: 'GET', url: '/api/filaments/colors?material=PLA%20Lite' })).json();
    expect(pla.colours.map((c: { name: string }) => c.name)).toEqual(['Cyan']);
  });

  it('answers 503 when the catalogue could not be had', async () => {
    setBambuColours(null);
    expect((await app.inject({ method: 'GET', url: '/api/filaments/colors' })).statusCode).toBe(503);
  });

  it('names AMS trays holding a Bambu colour', async () => {
    const trays = (await app.inject({ method: 'GET', url: '/api/ams' })).json().units[0].trays;
    expect(trays[0]).toMatchObject({ colorName: 'Cyan', colorCode: '16603' });
    // Generic PLA (GFL99) in Bambu's orange is still not a Bambu spool
    expect(trays[1]).toMatchObject({ colorName: null, colorCode: null });
  });

  it('paints figures in one Bambu material\'s colours, and names AMS colours', async () => {
    const jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'colour-jobs-'));
    const generated: MeshParams[] = [];
    const worker: MeshWorkerApi = {
      health: async () => ({ ok: true, claude: true, running: [], loaded: false }),
      generate: async (_id, params) => {
        generated.push(params);
      },
      fix: async () => {},
      cancel: async () => {},
    };
    setCadJobStore(new CadJobStore(jobsDir));
    setMeshWorker(worker);
    try {
      const bambu = await app.inject({ method: 'POST', url: '/api/cad/meshes', payload: { prompt: 'Mèo cam', colour: true, palette: 'bambu', material: 'PLA Basic', colours: 3 } });
      expect(bambu.statusCode).toBe(202);
      expect(generated[0].colour).toMatchObject({
        count: 3,
        snap: [
          { hex: '#FF6A13', label: 'PLA Basic Orange (10300)' },
          { hex: '#000000', label: 'PLA Basic Black (10101)' },
          { hex: '#FFFFFF', label: 'PLA Basic Jade White (10100)' },
        ],
      });
      const unknown = await app.inject({ method: 'POST', url: '/api/cad/meshes', payload: { prompt: 'Mèo cam', colour: true, palette: 'bambu', material: 'Gỗ' } });
      expect(unknown.json().error).toBe('UNKNOWN_MATERIAL');

      await app.inject({ method: 'POST', url: '/api/cad/meshes', payload: { prompt: 'Mèo cam', colour: true, palette: 'ams' } });
      expect(generated[1].colour).toMatchObject({
        palette: [
          { hex: '#4DAFDA', label: 'AMS 1 khay 1: PLA Cyan (16603)', material: 'PLA' },
          { hex: '#FF6A13', label: 'AMS 1 khay 2: PLA', material: 'PLA' },
        ],
      });
    } finally {
      await fs.rm(jobsDir, { recursive: true, force: true });
    }
  });
});
