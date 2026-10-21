import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { setAiProposalSource } from '../src/api/routes/studio';
import { buildUserPrompt, checkProposal, normalizeValue, type StudioRequest } from '../src/domain/studio/aiOptimize';
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

  it('sets per-variant settings to one value for every variant Studio has', () => {
    expect(normalizeValue('outer_wall_speed', '150', [0.4], '200,200,nil,200')).toEqual({ value: '150,150,nil,150' });
    expect(normalizeValue('outer_wall_speed', '150, 150', [0.4], '200,200')).toEqual({ value: '150,150' });
    expect(normalizeValue('enable_overhang_speed', 'false', [0.4], '1,1')).toEqual({ value: '0,0' });
    expect(normalizeValue('outer_wall_speed', '150,200', [0.4], '200,200')).toHaveProperty('error');
    expect(normalizeValue('outer_wall_speed', '900', [0.4], '200,200')).toHaveProperty('error');
    expect(normalizeValue('outer_wall_speed', '150', [0.4])).toHaveProperty('error');
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

describe('POST /api/studio/ai-optimize', () => {
  let app: TestApp;
  let stateStore: PrinterStateStore;
  let prompts: string[];

  beforeEach(() => {
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
    stateStore.destroy();
    app.close();
  });

  it('returns the checked changes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/studio/ai-optimize', payload: studioRequest });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      summary: 'Cần support.',
      changes: [{ key: 'enable_support', label: 'Bật support', value: '1', reason: 'Phần nhô lớn' }],
      rejected: [],
    });
    expect(prompts[0]).toContain('Máy in thực tế:');
  });

  it('rejects a malformed Studio request', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/studio/ai-optimize', payload: { ...studioRequest, version: 2 } });
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
    expect(body.user).toContain('Máy in thực tế:');
    expect(body.schema.properties.changes.items.properties.key.enum).toContain('enable_support');
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
