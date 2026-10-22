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

  it('scales per-variant speeds by the ratio given for the first variant', () => {
    // H2D: standard nozzle variants at 200, High Flow at 500 (as Studio v02.08.04.57 sends them)
    expect(normalizeValue('outer_wall_speed', '150', [0.4], '200,500,500,200,500,500,500')).toEqual({
      value: '150,375,375,150,375,375,375',
    });
    expect(normalizeValue('outer_wall_speed', '150', [0.4], 'nil,200,nil,500')).toEqual({ value: 'nil,150,nil,375' });
    expect(normalizeValue('outer_wall_speed', '150, 150', [0.4], '200,200')).toEqual({ value: '150,150' });
    expect(normalizeValue('inner_wall_speed', '100', [0.4], '300,600')).toEqual({ value: '100,200' });
    expect(normalizeValue('outer_wall_speed', '150,200', [0.4], '200,200')).toHaveProperty('error');
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
