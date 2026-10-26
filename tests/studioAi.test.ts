import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { setAiProposalSource, setAiSessionStore } from '../src/api/routes/studio';
import { AiSessionStore } from '../src/domain/studio/aiSessions';
import {
  buildUserPrompt,
  checkProposal,
  normalizeOptionValue,
  normalizeValue,
  type AiProposal,
  type StudioRequest,
} from '../src/domain/studio/aiOptimize';
import { createTestApp, type TestApp } from './helpers/testApp';

const studioRequest: StudioRequest = {
  version: 1,
  goal: 'balanced',
  printer_preset: 'Bambu Lab H2D 0.4 nozzle',
  process_preset: '0.20mm Standard @BBL H2D',
  nozzle_diameters: [0.4, 0.4],
  filaments: [{ preset: 'Bambu PLA Basic @BBL H2D', type: 'PLA' }],
  settings: {
    layer_height: '0.2',
    sparse_infill_density: '15%',
    enable_support: '0',
    brim_type: 'auto_brim',
    wall_loops: '2',
  },
  objects: [
    {
      name: 'Bracket.stl',
      instances: 1,
      size_mm: [40, 20, 120],
      volume_mm3: 12000,
      surface_area_mm2: 9000,
      base_area_mm2: 300,
      overhang_area_mm2: 850,
      triangles: 5000,
    },
  ],
};

describe('AI tối ưu: checking proposals', () => {
  it('normalizes values to how Studio serializes them', () => {
    expect(normalizeValue('sparse_infill_density', '20', [0.4])).toEqual({ value: '20%' });
    expect(normalizeValue('enable_support', 'true', [0.4])).toEqual({ value: '1' });
    expect(normalizeValue('support_type', 'Tree(auto)', [0.4])).toEqual({ value: 'tree(auto)' });
    expect(normalizeValue('layer_height', '0.16mm', [0.4])).toEqual({ value: '0.16' });
  });

  it('rejects out-of-range values, non-integers and layers too thick for the nozzle', () => {
    expect(normalizeValue('wall_loops', '2.5', [0.4])).toHaveProperty('error');
    expect(normalizeValue('sparse_infill_density', '150%', [0.4])).toHaveProperty('error');
    expect(normalizeValue('layer_height', '0.32', [0.4, 0.2])).toHaveProperty('error');
    expect(normalizeValue('support_type', 'tree(manual)', [0.4])).toHaveProperty('error');
  });

  it('scales per-variant speeds by the ratio given for the first variant', () => {
    // H2D: standard nozzle variants at 200, High Flow at 500 (as Studio v02.08.04.57 sends them)
    expect(normalizeValue('outer_wall_speed', '150', [0.4], '200,500,500,200,500,500,500')).toEqual({
      value: '150,375,375,150,375,375,375',
    });
    expect(normalizeValue('outer_wall_speed', '150', [0.4], 'nil,200,nil,500')).toEqual({ value: 'nil,150,nil,375' });
    expect(normalizeValue('outer_wall_speed', '150, 150', [0.4], '200,200')).toEqual({ value: '150,150' });
    expect(normalizeValue('inner_wall_speed', '100', [0.4], '300,600')).toEqual({ value: '100,200' });
    expect(normalizeValue('outer_wall_speed', '150,200', [0.4], '200,200')).toEqual({ value: '150,200' });
    expect(normalizeValue('outer_wall_speed', '100,250,nil', [0.4], '200,500,nil')).toEqual({ value: '100,250,nil' });
    expect(normalizeValue('outer_wall_speed', '150,200', [0.4], '200,200,200')).toHaveProperty('error');
    expect(normalizeValue('outer_wall_speed', '150,900', [0.4], '200,200')).toHaveProperty('error');
    expect(normalizeValue('outer_wall_speed', '900', [0.4], '200,200')).toHaveProperty('error');
    expect(normalizeValue('outer_wall_speed', '150', [0.4])).toHaveProperty('error');
    expect(normalizeValue('outer_wall_speed', '150', [0.4], 'nil,nil')).toHaveProperty('error');
  });

  it('sets per-variant switches to one value for every variant', () => {
    expect(normalizeValue('enable_overhang_speed', 'false', [0.4], '1,1,nil')).toEqual({ value: '0,0,nil' });
  });

  it('shows the first variant of a speed in the prompt', () => {
    const request = { ...studioRequest, settings: { ...studioRequest.settings, outer_wall_speed: '200,500,500,200' } };
    expect(buildUserPrompt(request, null)).toContain('- outer_wall_speed (Tốc độ tường ngoài): hiện tại 200 (tất cả biến thể: 200,500,500,200)');
  });

  it('drops a per-variant change that keeps every value', () => {
    const request = { ...studioRequest, settings: { ...studioRequest.settings, outer_wall_speed: '200,200.0' } };
    const result = checkProposal(
      { summary: '', changes: [{ key: 'outer_wall_speed', value: '200', reason: 'Giữ nguyên' }] },
      request
    );
    expect(result.changes).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('keeps only allowed keys that change something, once each', () => {
    const result = checkProposal(
      {
        summary: ' Mẫu cao, đáy nhỏ. ',
        changes: [
          { key: 'enable_support', value: '1', reason: 'Nhô 850 mm²' },
          { key: 'layer_height', value: '0.20', reason: 'Giữ nguyên' },
          { key: 'machine_start_gcode', value: 'G28', reason: 'x' },
          { key: 'enable_support', value: '0', reason: 'trùng' },
          { key: 'brim_type', value: 'outer_only', reason: 'Vật cao 120 mm' },
        ],
      },
      studioRequest
    );
    expect(result.summary).toBe('Mẫu cao, đáy nhỏ.');
    expect(result.changes).toEqual([
      { key: 'enable_support', label: 'Bật support', value: '1', reason: 'Nhô 850 mm²' },
      { key: 'brim_type', label: 'Kiểu brim', value: 'outer_only', reason: 'Vật cao 120 mm' },
    ]);
    expect(result.rejected.map((r) => r.key)).toEqual(['machine_start_gcode', 'enable_support']);
  });

  it('puts the current settings and geometry in the prompt', () => {
    const prompt = buildUserPrompt(studioRequest, null);
    expect(prompt).toContain('- sparse_infill_density (Mật độ infill): hiện tại 15%');
    expect(prompt).toContain('"overhang_area_mm2": 850');
    expect(prompt).toContain('Bambu PLA Basic @BBL H2D (PLA)');
  });
});

// Version 2: Studio also sends how it defines each setting, and the settings of every filament
const fullRequest: StudioRequest = {
  ...studioRequest,
  version: 2,
  settings: { ...studioRequest.settings, gap_infill_speed: '250,250', spiral_mode: '0', top_one_wall_type: 'all top', wipe_tower_x: '165' },
  process_variants: ['Direct Drive Standard', 'Direct Drive High Flow'],
  filaments: [
    {
      preset: 'Bambu PLA Basic @BBL H2D',
      type: 'PLA',
      used: true,
      variants: ['Direct Drive Standard', 'Direct Drive High Flow'],
      settings: {
        nozzle_temperature: '220,230',
        nozzle_temperature_range_low: '190,190',
        nozzle_temperature_range_high: '240,240',
        filament_max_volumetric_speed: '21,40',
        fan_max_speed: '100,100',
        filament_retraction_length: 'nil,nil',
        filament_density: '1.26',
      },
    },
    { preset: 'Bambu PETG HF @BBL H2D', type: 'PETG', used: true, settings: { nozzle_temperature: '250', nozzle_temperature_range_low: '230', nozzle_temperature_range_high: '270' } },
    { preset: 'Bambu PLA Basic @BBL H2D', type: 'PLA', used: false, settings: {} },
  ],
  options: {
    gap_infill_speed: { type: 'float', vector: true, label: 'Gap infill', category: 'Speed', unit: 'mm/s', min: 1, max: 1000, mode: 'advanced' },
    spiral_mode: { type: 'bool', vector: false, label: 'Spiral vase', category: 'Others', unit: '', mode: 'simple' },
    top_one_wall_type: { type: 'enum', vector: false, label: 'Only one wall on top surfaces', category: 'Quality', unit: '', values: ['not apply', 'all top', 'topmost'], mode: 'develop' },
    wipe_tower_x: { type: 'float', vector: false, label: 'X', category: 'Others', unit: 'mm', mode: 'simple' },
    nozzle_temperature: { type: 'int', vector: true, label: 'Nozzle', category: 'Filament', unit: '°C', min: 0, max: 500, mode: 'simple' },
    nozzle_temperature_range_low: { type: 'int', vector: true, label: 'Min', category: 'Filament', unit: '°C', mode: 'simple' },
    nozzle_temperature_range_high: { type: 'int', vector: true, label: 'Max', category: 'Filament', unit: '°C', mode: 'simple' },
    filament_max_volumetric_speed: { type: 'float', vector: true, label: 'Max volumetric speed', category: 'Filament', unit: 'mm³/s', min: 0, mode: 'simple' },
    fan_max_speed: { type: 'int', vector: true, label: 'Fan max speed', category: 'Cooling', unit: '%', min: 0, max: 100, mode: 'simple' },
    filament_retraction_length: { type: 'float', vector: true, label: 'Length', category: 'Setting Overrides', unit: 'mm', min: 0, mode: 'simple' },
    filament_density: { type: 'float', vector: true, label: 'Density', category: 'Filament', unit: 'g/cm³', min: 0, mode: 'simple' },
  },
};

describe('AI tối ưu: every setting Studio describes', () => {
  const check = (changes: AiProposal['changes']) => checkProposal({ summary: '', changes }, fullRequest);

  it('opens the other process settings within Studio limits, but not develop-mode or denied ones', () => {
    const result = check([
      { key: 'gap_infill_speed', value: '150', reason: 'Bề mặt đẹp hơn' },
      { key: 'spiral_mode', value: 'true', reason: 'Bình hoa' },
      { key: 'top_one_wall_type', value: 'topmost', reason: 'x' },
      { key: 'wipe_tower_x', value: '100', reason: 'x' },
      { key: 'gap_infill_speed', value: '2000', reason: 'trùng' },
    ]);
    expect(result.changes).toEqual([
      { key: 'gap_infill_speed', label: 'Gap infill (gap_infill_speed)', value: '150,150', reason: 'Bề mặt đẹp hơn' },
      { key: 'spiral_mode', label: 'Spiral vase (spiral_mode)', value: '1', reason: 'Bình hoa' },
    ]);
    expect(result.rejected.map((r) => r.key)).toEqual(['top_one_wall_type', 'wipe_tower_x', 'gap_infill_speed']);
    expect(checkProposal({ summary: '', changes: [{ key: 'gap_infill_speed', value: '2000', reason: 'x' }] }, fullRequest).rejected[0].reason).toContain('1000');
  });

  it('changes one filament preset, scaling or setting each variant', () => {
    const result = check([
      { target: 'filament', filament: 1, key: 'nozzle_temperature', value: '225, 235', reason: 'Bám lớp tốt hơn' },
      { target: 'filament', filament: 1, key: 'filament_max_volumetric_speed', value: '15', reason: 'In chậm cho đẹp' },
      { target: 'filament', filament: 1, key: 'fan_max_speed', value: '80', reason: 'Giảm cong vênh' },
      { target: 'filament', filament: 1, key: 'filament_retraction_length', value: '0.6', reason: 'Bớt kéo sợi' },
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.changes.map((c) => [c.target, c.filament, c.preset, c.key, c.value])).toEqual([
      ['filament', 1, 'Bambu PLA Basic @BBL H2D', 'nozzle_temperature', '225,235'],
      ['filament', 1, 'Bambu PLA Basic @BBL H2D', 'filament_max_volumetric_speed', '15,28.57'],
      ['filament', 1, 'Bambu PLA Basic @BBL H2D', 'fan_max_speed', '80,80'],
      ['filament', 1, 'Bambu PLA Basic @BBL H2D', 'filament_retraction_length', '0.6,0.6'],
    ]);
  });

  it('keeps to one filament preset, the filament temperature range, and settings that describe the material', () => {
    const result = check([
      { target: 'filament', filament: 1, key: 'nozzle_temperature', value: '250', reason: 'x' },
      { target: 'filament', filament: 1, key: 'filament_density', value: '1.3', reason: 'x' },
      { target: 'filament', filament: 1, key: 'fan_max_speed', value: '80', reason: 'ok' },
      { target: 'filament', filament: 3, key: 'fan_max_speed', value: '70', reason: 'cùng preset' },
      { target: 'filament', filament: 2, key: 'nozzle_temperature', value: '255', reason: 'preset khác' },
      { target: 'filament', filament: 9, key: 'fan_max_speed', value: '70', reason: 'x' },
    ]);
    expect(result.changes.map((c) => c.key)).toEqual(['fan_max_speed']);
    expect(result.rejected.map((r) => [r.filament, r.key, r.reason])).toEqual([
      [1, 'nozzle_temperature', expect.stringContaining('190–240')],
      [1, 'filament_density', 'Tham số không nằm trong danh sách AI được phép đổi'],
      [3, 'fan_max_speed', 'Đề xuất trùng lặp'],
      [2, 'nozzle_temperature', expect.stringContaining('Bambu PLA Basic @BBL H2D')],
      [9, 'fan_max_speed', expect.stringContaining('#9')],
    ]);
  });

  it('normalizes per-variant values', () => {
    const option = fullRequest.options!.nozzle_temperature;
    expect(normalizeOptionValue(option, '210', '220,230,nil')).toEqual({ value: '210,220,nil' });
    expect(normalizeOptionValue(option, '210', 'nil,nil')).toEqual({ value: '210,210' });
    expect(normalizeOptionValue(option, '210,215', '220,230')).toEqual({ value: '210,215' });
    expect(normalizeOptionValue(option, '210,215,220', '220,230')).toHaveProperty('error');
    expect(normalizeOptionValue(option, '210.5', '220')).toHaveProperty('error');
    expect(normalizeOptionValue(fullRequest.options!.spiral_mode, 'on', '0')).toEqual({ value: '1' });
  });

  it('lists the other settings and the filaments on the plate in the prompt', () => {
    const prompt = buildUserPrompt(fullRequest, null);
    expect(prompt).toContain('- gap_infill_speed (Gap infill, mm/s): hiện tại 250,250; số 1–1000');
    expect(prompt).toContain('Tham số filament #1: Bambu PLA Basic @BBL H2D (PLA) (target "filament", filament 1):');
    expect(prompt).toContain('- nozzle_temperature (Nozzle, °C): hiện tại 220,230; số nguyên 0–500');
    expect(prompt).toContain('#3 Bambu PLA Basic @BBL H2D (PLA) (không dùng trên plate này)');
    expect(prompt).not.toContain('top_one_wall_type');
    expect(prompt).not.toContain('filament_density');
    // AI_SETTINGS stay listed once, with their own ranges
    expect(prompt.match(/- layer_height /g)).toHaveLength(1);
  });

  it('records filament values before the change and reports them with past prints', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-sessions-'));
    try {
      const store = new AiSessionStore(dir);
      const result = check([{ target: 'filament', filament: 1, key: 'fan_max_speed', value: '80', reason: 'Giảm cong vênh' }]);
      const session = await store.create(fullRequest, result, null);
      expect(session.settings_before).toEqual({ 'filament#1:fan_max_speed': '100,100' });
      await store.markApplied(session.id, [{ target: 'filament', filament: 1, key: 'fan_max_speed', value: '80,80' }]);
      await store.saveFeedback(session.id, { outcome: 'success', issues: [], note: '' });
      const [past] = await store.pastPrints(fullRequest);
      expect(past.changes).toEqual([{ key: 'filament#1:fan_max_speed', label: 'Fan max speed (fan_max_speed)', before: '100,100', after: '80,80' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/studio/ai-optimize', () => {
  let app: TestApp;
  let stateStore: PrinterStateStore;
  let prompts: string[];
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(path.join(os.tmpdir(), 'ai-sessions-'));
    setAiSessionStore(new AiSessionStore(sessionDir));
    stateStore = new PrinterStateStore('TEST_SERIAL_AI');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_AI', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);
    prompts = [];
    setAiProposalSource(async (_system, user) => {
      prompts.push(user);
      return { summary: 'Cần support.', changes: [{ key: 'enable_support', value: '1', reason: 'Phần nhô lớn' }] };
    });
  });

  afterEach(() => {
    setAiProposalSource(null);
    setAiSessionStore(null);
    rmSync(sessionDir, { recursive: true, force: true });
    stateStore.destroy();
    app.close();
  });

  it('returns the checked changes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/studio/ai-optimize', payload: studioRequest });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      session_id: expect.stringMatching(/^\d{8}-\d{6}-[0-9a-f]{6}$/),
      summary: 'Cần support.',
      changes: [{ key: 'enable_support', label: 'Bật support', value: '1', reason: 'Phần nhô lớn' }],
      rejected: [],
    });
    expect(prompts[0]).toContain('Máy in thực tế:');
  });

  it('rejects a malformed Studio request', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/studio/ai-optimize', payload: { ...studioRequest, version: 3 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_PAYLOAD');
    expect(prompts).toEqual([]);
  });

  it('says when no Claude key is configured', async () => {
    setAiProposalSource(null);
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const res = await app.inject({ method: 'POST', url: '/api/studio/ai-optimize', payload: studioRequest });
      expect(res.statusCode).toBe(501);
      expect(res.json().error).toBe('AI_DISABLED');
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
  });

  it('hands out the prompts and schema for claude -p, without a Claude key', async () => {
    setAiProposalSource(null);
    const res = await app.inject({ method: 'POST', url: '/api/studio/ai-optimize/prompt', payload: studioRequest });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.system).toContain('Bambu Lab H2D');
    expect(body.system).toContain('mỗi ý một dòng bắt đầu bằng "• "');
    expect(body.user).toContain('Máy in thực tế:');
    expect(body.schema.properties.changes.items.properties.target.enum).toEqual(['process', 'filament']);
  });

  it('checks a proposal made by claude -p', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/studio/ai-optimize/check',
      payload: {
        request: studioRequest,
        proposal: { summary: 'Cần support.', changes: [{ key: 'enable_support', value: 'true', reason: 'Phần nhô lớn' }, { key: 'machine_start_gcode', value: 'G28', reason: 'x' }] },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changes).toEqual([{ key: 'enable_support', label: 'Bật support', value: '1', reason: 'Phần nhô lớn' }]);
    expect(res.json().rejected.map((r: { key: string }) => r.key)).toEqual(['machine_start_gcode']);
    expect(prompts).toEqual([]);
  });

  it('rejects a missing proposal', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/studio/ai-optimize/check', payload: { request: studioRequest } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('AI_NO_OUTPUT');
  });
});

describe('AI sessions: re-ask, applied changes and print reports', () => {
  let app: TestApp;
  let stateStore: PrinterStateStore;
  let prompts: string[];
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(path.join(os.tmpdir(), 'ai-sessions-'));
    setAiSessionStore(new AiSessionStore(sessionDir));
    stateStore = new PrinterStateStore('TEST_SERIAL_AI_SESSIONS');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const printerService = new PrinterService({ serial: 'TEST_SERIAL_AI_SESSIONS', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any });
    app = createTestApp(printerService);
    prompts = [];
    setAiProposalSource(async (_system, user) => {
      prompts.push(user);
      return prompts.length === 1
        ? { summary: 'Cần support.', changes: [{ key: 'enable_support', value: '1', reason: 'Phần nhô lớn' }] }
        : { summary: 'Dùng brim thay support.', changes: [{ key: 'brim_type', value: 'outer_only', reason: 'Theo ý người dùng' }] };
    });
  });

  afterEach(() => {
    setAiProposalSource(null);
    setAiSessionStore(null);
    rmSync(sessionDir, { recursive: true, force: true });
    stateStore.destroy();
    app.close();
  });

  const ask = async (payload: unknown) => {
    const res = await app.inject({ method: 'POST', url: '/api/studio/ai-optimize', payload });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it('re-asks with the previous proposal and the user comment in the prompt', async () => {
    const first = await ask(studioRequest);
    const second = await ask({ ...studioRequest, follow_up: { session_id: first.session_id, comment: 'Không muốn support, gỡ khó lắm' } });

    expect(prompts[1]).toContain('Lần trước bạn đã đề xuất');
    expect(prompts[1]).toContain('- enable_support (Bật support) = 1: Phần nhô lớn');
    expect(prompts[1]).toContain('"Không muốn support, gỡ khó lắm"');
    expect(second.changes.map((c: { key: string }) => c.key)).toEqual(['brim_type']);

    const res = await app.inject({ method: 'GET', url: `/api/studio/ai-sessions/${second.session_id}` });
    expect(res.json().session).toMatchObject({ previous_id: first.session_id, comment: 'Không muốn support, gỡ khó lắm' });
  });

  it('builds the claude -p prompt for a re-ask too', async () => {
    const first = await ask(studioRequest);
    const res = await app.inject({
      method: 'POST',
      url: '/api/studio/ai-optimize/prompt',
      payload: { ...studioRequest, follow_up: { session_id: first.session_id, comment: 'In nhanh hơn' } },
    });
    expect(res.json().user).toContain('"In nhanh hơn"');
  });

  it('rejects an empty comment', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/studio/ai-optimize', payload: { ...studioRequest, follow_up: { session_id: 'x', comment: '  ' } } });
    expect(res.statusCode).toBe(400);
  });

  it('records the applied changes and the print report, and lists sessions newest first', async () => {
    const first = await ask(studioRequest);
    const second = await ask(studioRequest);

    const applied = await app.inject({
      method: 'POST',
      url: `/api/studio/ai-sessions/${first.session_id}/applied`,
      payload: { changes: [{ key: 'enable_support', value: '1' }] },
    });
    expect(applied.statusCode).toBe(200);

    const feedback = await app.inject({
      method: 'POST',
      url: `/api/studio/ai-sessions/${first.session_id}/feedback`,
      payload: { outcome: 'usable', issues: ['support_removal'], note: 'Support dính chặt ở mặt dưới' },
    });
    expect(feedback.statusCode).toBe(200);

    const list = (await app.inject({ method: 'GET', url: '/api/studio/ai-sessions' })).json();
    expect(list.sessions.map((s: { id: string }) => s.id)).toEqual([second.session_id, first.session_id].sort().reverse());
    expect(list.sessions.find((s: { id: string }) => s.id === first.session_id)).toMatchObject({
      objects: ['Bracket.stl'],
      change_count: 1,
      applied_at: expect.any(String),
      feedback_outcome: 'usable',
    });
    expect(list.issues).toContainEqual({ id: 'support_removal', label: 'Support khó gỡ' });
    expect(list.outcomes.map((o: { id: string }) => o.id)).toEqual(['success', 'usable', 'failed']);

    const session = (await app.inject({ method: 'GET', url: `/api/studio/ai-sessions/${first.session_id}` })).json().session;
    expect(session.settings_before).toEqual({ enable_support: '0' });
    expect(session.feedback).toMatchObject({ outcome: 'usable', issues: ['support_removal'], note: 'Support dính chặt ở mặt dưới' });
  });

  it('rejects unknown issues and unknown or malformed session ids', async () => {
    const first = await ask(studioRequest);
    const bad = await app.inject({ method: 'POST', url: `/api/studio/ai-sessions/${first.session_id}/feedback`, payload: { outcome: 'failed', issues: ['aliens'] } });
    expect(bad.statusCode).toBe(400);
    for (const id of ['20990101-000000-abcdef', '..%2F..%2Fetc']) {
      const res = await app.inject({ method: 'POST', url: `/api/studio/ai-sessions/${id}/feedback`, payload: { outcome: 'success' } });
      expect(res.statusCode, id).toBe(404);
    }
  });
});

describe('AI sessions: past prints in the prompt', () => {
  let sessionDir: string;
  let store: AiSessionStore;

  beforeEach(() => {
    sessionDir = mkdtempSync(path.join(os.tmpdir(), 'ai-sessions-'));
    store = new AiSessionStore(sessionDir);
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  const supportResult = {
    summary: 'Cần support.',
    changes: [{ key: 'enable_support' as const, label: 'Bật support', value: '1', reason: 'Phần nhô lớn' }],
    rejected: [],
  };

  /** A session for `request`, applied and reported unless told otherwise; `second` keeps ids in time order */
  const printed = async (
    request: StudioRequest,
    second: number,
    report: { applied?: boolean; feedback?: Parameters<AiSessionStore['saveFeedback']>[1] | null } = {}
  ) => {
    const session = await store.create(request, supportResult, null, new Date(2026, 9, 1, 10, 0, second));
    if (report.applied !== false) await store.markApplied(session.id, [{ key: 'enable_support', value: '1' }]);
    const feedback = report.feedback === undefined ? { outcome: 'usable' as const, issues: ['support_removal' as const], note: 'Support dính chặt' } : report.feedback;
    if (feedback) await store.saveFeedback(session.id, feedback);
    return session;
  };

  const petg: StudioRequest = { ...studioRequest, filaments: [{ preset: 'Bambu PETG HF @BBL H2D', type: 'PETG' }] };

  it('keeps only applied and reported prints of the same material and nozzle', async () => {
    const kept = await printed(studioRequest, 1);
    await printed(studioRequest, 2, { applied: false });
    await printed(studioRequest, 3, { feedback: null });
    await printed(petg, 4);
    await printed({ ...studioRequest, nozzle_diameters: [0.6, 0.6] }, 5);

    const past = await store.pastPrints(studioRequest);
    expect(past).toEqual([
      {
        created_at: kept.created_at,
        goal: 'balanced',
        process_preset: '0.20mm Standard @BBL H2D',
        filaments: ['Bambu PLA Basic @BBL H2D (PLA)'],
        objects: ['Bracket.stl 40×20×120 mm'],
        changes: [{ key: 'enable_support', label: 'Bật support', before: '0', after: '1' }],
        outcome: 'Có lỗi nhưng dùng được',
        issues: ['Support khó gỡ'],
        note: 'Support dính chặt',
      },
    ]);
  });

  it('puts the most similar plate first, then the newest', async () => {
    const other = await printed({ ...studioRequest, goal: 'speed', process_preset: '0.28mm Extra Draft @BBL H2D' }, 1);
    const older = await printed(studioRequest, 2);
    const newer = await printed(studioRequest, 3);
    const tiny = await printed(
      { ...studioRequest, objects: [{ ...studioRequest.objects[0], name: 'Coin.stl', size_mm: [20, 20, 2], overhang_area_mm2: 0 }] },
      4
    );

    const past = await store.pastPrints(studioRequest);
    expect(past.map((p) => p.created_at)).toEqual([newer.created_at, older.created_at, tiny.created_at, other.created_at]);
    expect(await store.pastPrints(studioRequest, 2)).toHaveLength(2);
  });

  it('describes past prints in the prompt, and leaves the section out without any', async () => {
    await printed(studioRequest, 1, { feedback: { outcome: 'failed', issues: ['warping'], note: 'Bong góc "trái"' } });
    const prompt = buildUserPrompt(studioRequest, null, null, await store.pastPrints(studioRequest));
    expect(prompt).toContain('Kết quả in thực tế của các plate tương tự trên máy này');
    expect(prompt).toContain('Đã đổi: enable_support (Bật support) 0 → 1');
    expect(prompt).toContain('Kết quả: Hỏng, phải in lại; lỗi: Cong vênh, bong khỏi bàn');
    expect(prompt).toContain('Ghi chú của người dùng: "Bong góc \\"trái\\""');
    expect(buildUserPrompt(studioRequest, null)).not.toContain('Kết quả in thực tế');
  });

  it('counts a print the local AI reviewed from its timelapse, even before the user reports', async () => {
    const session = await printed(studioRequest, 1, { feedback: null });
    await store.saveVideoReview(session.id, {
      video: 'video_2026-10-12_00-32-49.mp4',
      model: 'claude-opus-5-5',
      at: '2026-10-01T12:00:00.000Z',
      print_id: null,
      frames_at: [0, 50, 100],
      summary: 'Góc trái bong khỏi bàn từ giữa bản in.',
      outcome_guess: 'usable',
      issues: ['warping'],
      observations: [{ frame: 2, problem: 'Góc trái cong lên' }],
      suggestions: ['Thêm brim 5 mm'],
      used: { at: '2026-10-01T12:05:00.000Z', print_id: '20261001-120000-abcdef' },
    });
    const [past] = await store.pastPrints(studioRequest);
    expect(past).toMatchObject({ outcome: 'người dùng chưa báo', issues: [], note: '' });
    expect(past.video_review).toBe('Góc trái bong khỏi bàn từ giữa bản in. Lỗi thấy: Cong vênh, bong khỏi bàn. Đề xuất: Thêm brim 5 mm');
    expect(buildUserPrompt(studioRequest, null, null, [past])).toContain('Claude xem timelapse');
  });

  it('sends past prints to the AI through the API', async () => {
    const session = await printed(studioRequest, 1);
    setAiSessionStore(store);
    const stateStore = new PrinterStateStore('TEST_SERIAL_AI_PAST');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    const app = createTestApp(new PrinterService({ serial: 'TEST_SERIAL_AI_PAST', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any }));
    const prompts: string[] = [];
    setAiProposalSource(async (_system, user) => {
      prompts.push(user);
      return { summary: 'Giữ nguyên.', changes: [] };
    });
    try {
      expect((await app.inject({ method: 'POST', url: '/api/studio/ai-optimize', payload: studioRequest })).statusCode).toBe(200);
      expect(prompts[0]).toContain(`1. ${session.created_at.slice(0, 10)}, mục tiêu balanced`);
      const res = await app.inject({ method: 'POST', url: '/api/studio/ai-optimize/prompt', payload: studioRequest });
      expect(res.json().user).toContain('Kết quả: Có lỗi nhưng dùng được; lỗi: Support khó gỡ');
    } finally {
      setAiProposalSource(null);
      setAiSessionStore(null);
      stateStore.destroy();
      app.close();
    }
  });
});
