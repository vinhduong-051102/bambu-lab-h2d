import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { PrinterStateStore } from '../src/domain/PrinterStateStore';
import { CapabilityRegistry } from '../src/domain/capabilities/CapabilityRegistry';
import { PrinterCommandService } from '../src/domain/commands/PrinterCommandService';
import { PrinterService } from '../src/domain/PrinterService';
import { env } from '../src/config/env';
import { claudeEntry, fromClaude, planUse, readStream, recordAiUsage, setAiUsageFile, summarize, type AiUsageEntry } from '../src/domain/ai/aiUsage';
import { formatPlanUse, formatShare, formatTokens, formatUsd } from '../src/ui/aiUsage';
import { createTestApp, type TestApp } from './helpers/testApp';

/** A result line as Claude Code writes it (`claude -p --output-format stream-json`) */
const RESULT = {
  type: 'result',
  is_error: false,
  num_turns: 17,
  duration_ms: 308364,
  total_cost_usd: 0.75,
  usage: { input_tokens: 30, output_tokens: 17924, cache_read_input_tokens: 364257, cache_creation_input_tokens: 40846 },
  modelUsage: {
    'claude-opus-5-5': { inputTokens: 30, outputTokens: 17924, cacheReadInputTokens: 364257, cacheCreationInputTokens: 40846, thinkingTokens: 5188, costUSD: 0.75 },
  },
};
const limit = (five: number, seven: number, fiveReset = 1793171400) => ({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: five, resetsAt: fiveReset }, seven_day: { utilization: seven, resetsAt: 1793635200 } } },
});
const stream = (...events: object[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n{"type":"res';

describe('AI usage statistics', () => {
  it('reads tokens, cost and the plan use from a Claude Code stream', () => {
    const { results, windows } = readStream(stream({ type: 'system' }, limit(0.09, 0.26), { type: 'assistant' }, limit(0.18, 0.27), RESULT));
    const usage = fromClaude(results, windows);
    expect(usage.tokens).toEqual({ input: 30, output: 17924, cache_read: 364257, cache_write: 40846, thinking: 5188 });
    expect(usage).toMatchObject({ cost_usd: 0.75, turns: 17, duration_ms: 308364, ok: true, models: ['claude-opus-5-5'] });
    expect(usage.plan?.five_hour).toMatchObject({ from: 0.09, to: 0.18, used: 0.09 });
    expect(usage.plan?.seven_day?.used).toBe(0.01);
  });

  it('counts a window that started over during the task from zero', () => {
    expect(planUse([limit(0.95, 0.5).rate_limit_info.unifiedWindows, limit(0.04, 0.52, 1793189400).rate_limit_info.unifiedWindows])?.five_hour?.used).toBe(0.04);
    expect(planUse([])).toBeNull();
  });

  it('counts a run without a result as failed', () => {
    expect(fromClaude([], []).ok).toBe(false);
    expect(fromClaude([{ ...RESULT, is_error: true }], []).ok).toBe(false);
  });

  it("gives each task its share of the period's cost and tokens", () => {
    const entry = (id: string, at: string, cost: number | null, input: number): AiUsageEntry => ({
      ...claudeEntry('cad', id, null, [], new Date(at)),
      id,
      cost_usd: cost,
      tokens: { input, output: 0, cache_read: 0, cache_write: 0, thinking: 0 },
      ok: true,
    });
    const summary = summarize(
      [entry('a', '2026-10-29T01:00:00Z', 3, 300), entry('b', '2026-10-29T02:00:00Z', 1, 100), entry('old', '2026-09-01T00:00:00Z', 5, 500)],
      new Date('2026-10-01T00:00:00Z')
    );
    expect(summary.tasks.map((t) => t.id)).toEqual(['b', 'a']);
    expect(summary.tasks.map((t) => t.cost_share)).toEqual([0.25, 0.75]);
    expect(summary.tasks.map((t) => t.token_share)).toEqual([0.25, 0.75]);
    expect(summary.totals).toMatchObject({ runs: 2, cost_usd: 4, total_tokens: 400 });
    expect(summary.features).toEqual([expect.objectContaining({ feature: 'cad', runs: 2, cost_share: 1 })]);
  });

  it('formats the numbers for the dashboard', () => {
    expect(formatTokens(2001637)).toBe('2,00M');
    expect(formatTokens(117624)).toBe('117,6k');
    expect(formatUsd(0.9965)).toBe('$1,00');
    expect(formatUsd(0.0042)).toBe('$0,004');
    expect(formatUsd(null)).toBe('—');
    expect(formatShare(0.186)).toBe('18,6 %');
    expect(formatPlanUse({ from: 0.09, to: 0.18, used: 0.09, resets_at: null })).toBe('+9 %');
    expect(formatPlanUse({ from: 0.3, to: 0.3, used: 0, resets_at: null })).toBe('<1 %');
  });
});

describe('AI usage API (/api/ai/usage)', () => {
  let app: TestApp;
  let jobsDir: string;
  let ledger: string;
  const jobsBefore = env.CAD_JOBS_DIR;

  beforeEach(async () => {
    const stateStore = new PrinterStateStore('TEST_SERIAL_AI');
    const capabilityRegistry = new CapabilityRegistry();
    const mqtt = { publishRequest: async () => true };
    const commandService = new PrinterCommandService(capabilityRegistry, stateStore, mqtt as any);
    app = createTestApp(new PrinterService({ serial: 'TEST_SERIAL_AI', stateStore, capabilityRegistry, commandService, mqttClient: mqtt as any }));
    jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-jobs-'));
    ledger = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-')), 'usage.jsonl');
    env.CAD_JOBS_DIR = jobsDir;
    setAiUsageFile(ledger);
  });

  afterEach(async () => {
    app.close();
    env.CAD_JOBS_DIR = jobsBefore;
    setAiUsageFile(null);
    await fs.rm(jobsDir, { recursive: true, force: true });
    await fs.rm(path.dirname(ledger), { recursive: true, force: true });
  });

  it("lists the AI jobs from their Claude logs and the gateway's own calls from the ledger", async () => {
    const job = path.join(jobsDir, '20261029-031134-f8d1');
    await fs.mkdir(job);
    await fs.writeFile(path.join(job, 'job.json'), JSON.stringify({ prompt: 'Lịch vạn niên', source: 'ai', created_at: new Date().toISOString() }));
    await fs.writeFile(path.join(job, 'status.json'), JSON.stringify({ started_at: new Date().toISOString(), result: { title: 'Lịch vạn niên cơ khí' } }));
    await fs.writeFile(path.join(job, 'claude.jsonl'), stream(limit(0.09, 0.26), limit(0.18, 0.27), RESULT));
    // A job Claude never ran for (a figure from Hunyuan3D only) is not an AI task
    await fs.mkdir(path.join(jobsDir, '20261029-040000-aaaa'));
    await recordAiUsage(claudeEntry('timelapse', 'Giá đỡ (video_1.mp4)', { ...RESULT, total_cost_usd: 0.25, modelUsage: undefined }));

    const res = await app.inject({ method: 'GET', url: '/api/ai/usage?days=30' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tasks.map((t: { feature: string; title: string }) => [t.feature, t.title]).sort()).toEqual([
      ['cad', 'Lịch vạn niên cơ khí'],
      ['timelapse', 'Giá đỡ (video_1.mp4)'],
    ]);
    expect(body.totals.cost_usd).toBe(1);
    const cad = body.tasks.find((t: { feature: string }) => t.feature === 'cad');
    expect(cad).toMatchObject({ cost_share: 0.75, plan: { five_hour: { used: 0.09 } } });
    expect(body.features.map((f: { feature: string; cost_share: number }) => [f.feature, f.cost_share])).toEqual([
      ['cad', 0.75],
      ['timelapse', 0.25],
    ]);
  });
});
