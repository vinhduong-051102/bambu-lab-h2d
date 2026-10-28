#!/usr/bin/env node
/**
 * MCP server (stdio) that lets an agent such as Antigravity's design 3D-printable models with the gateway's CAD
 * worker (docs/cad.md): the agent writes build123d code on its own plan, this server has it built (STL, STEP,
 * preview, checks) and sends finished models to Bambu Studio. It only calls the gateway's /api/cad routes.
 *
 *   node cad/mcp/server.mjs        env: GATEWAY_URL (default http://localhost:3000), GATEWAY_API_KEY (if set)
 *
 * No dependencies: MCP over stdio is newline-delimited JSON-RPC 2.0, and this server only offers tools.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';

const GATEWAY_URL = (process.env.GATEWAY_URL || 'http://localhost:3000').replace(/\/+$/, '');
const API_KEY = process.env.GATEWAY_API_KEY || '';
const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'cad_guide',
    description:
      'Read this first. The rules for models on the Bambu Lab H2D (millimetres, Z up, sits on Z = 0, printable ' +
      'walls/overhangs/clearances, assign the finished solid to `result`) and a build123d primer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cad_build',
    description:
      'Build a model from build123d Python code that assigns the finished solid to `result`. Returns the build ' +
      'report (size in mm, volume, mesh checks, warnings, or the error and traceback) and a preview image with ' +
      'four views. Check the preview against the request and build again with fixed code until it matches. ' +
      'Each call makes a new job; pass parent_id to link it to the job it revises.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The whole build123d model file' },
        title: { type: 'string', description: 'Short name of the model, in the user\'s language' },
        prompt: { type: 'string', description: 'What the user asked for' },
        parent_id: { type: 'string', description: 'The job this one revises' },
      },
      required: ['code', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'cad_get_job',
    description: 'One model job: its state, report, the summary when Claude made it, its code and its preview image.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        include_code: { type: 'boolean', description: 'Also return model.py (default true)' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'cad_list_jobs',
    description: 'Recent model jobs, newest first: id, title, state, size, and who made it (claude or code).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: 'cad_send_to_studio',
    description:
      'Put a finished model into Bambu Studio\'s /imports folder (STL meshes are repaired on the way). The user ' +
      'then opens it in Studio with File → Import. Only send models the user has accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        format: { type: 'string', enum: ['stl', 'step'], description: 'Default stl' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'cad_make_figure',
    description:
      'Make an organic model (character, animal, toy, decoration) in the gateway\'s mesh container, sized for ' +
      'printing: from a picture on this computer Hunyuan3D-2 shapes it on the GPU and Claude finishes it in Blender ' +
      '(fixes, plinth, the picture\'s colours); from a description alone Claude makes it in Blender. build123d ' +
      'cannot make such shapes. Runs in the background for 5-15 minutes: follow it with cad_get_job.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to make; with image_path, anything to add to the picture' },
        image_path: { type: 'string', description: 'A PNG, JPEG or WebP file on this computer' },
        height_mm: { type: 'number', minimum: 10, maximum: 300, description: 'Height of the figure, default 80' },
        base: { type: 'boolean', description: 'Add a round plinth so it stands steadily (default false)' },
        colour: { type: 'boolean', description: 'Print it in several filaments: Claude paints its parts, in a 3MF' },
        colours: { type: 'integer', minimum: 2, maximum: 8, description: 'How many filaments, default 4' },
        palette: { type: 'string', enum: ['auto', 'ams'], description: 'ams: use the colours loaded in the AMS instead' },
        multiview: { type: 'boolean', description: 'With image_path: shape it from four sides, the AI drawing the other three' },
        seed: { type: 'integer', minimum: 0, description: 'With a picture, Hunyuan3D-2\'s seed: another seed, another shape' },
        parent_id: { type: 'string', description: 'A figure job to make again from its picture and description' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cad_fix_figure',
    description:
      'Have Claude review a finished figure (from cad_make_figure, or a fix of one) against its picture from six ' +
      'sides and fix it with mesh code: feet cut off, loose bits, crumpled surfaces, holes, thin parts, or what ' +
      'the prompt asks. Keeps its size, pose and filament colours. A new job; runs in the background for several ' +
      'minutes on the user\'s Claude subscription: follow it with cad_get_job.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The finished figure to fix' },
        prompt: { type: 'string', description: 'What to fix; leave out to let Claude find the problems itself' },
        model: { type: 'string', enum: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'cad_ask_claude',
    description:
      'Hand a model request to Claude in the CAD container instead (it runs on the user\'s Claude subscription, ' +
      'in the background, for several minutes). Returns the job id: follow it with cad_get_job.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to design, or for a revision what to change' },
        model: { type: 'string', enum: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
        parent_id: { type: 'string', description: 'The job whose model Claude should change' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
];

class GatewayError extends Error {}

async function gateway(method, route, body) {
  let res;
  try {
    // FormData (a picture upload) sets its own multipart Content-Type
    const form = body instanceof FormData;
    res = await fetch(`${GATEWAY_URL}${route}`, {
      method,
      headers: {
        ...(body !== undefined && !form && { 'Content-Type': 'application/json' }),
        ...(API_KEY && { Authorization: `Bearer ${API_KEY}` }),
      },
      body: body === undefined || form ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(240000),
    });
  } catch (err) {
    throw new GatewayError(`Cannot reach the gateway at ${GATEWAY_URL}: ${err.message}`);
  }
  if (res.status === 401) throw new GatewayError('The gateway refused the request: set GATEWAY_API_KEY for this MCP server.');
  return res;
}

async function gatewayJson(method, route, body) {
  const res = await gateway(method, route, body);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new GatewayError(data?.message || `Gateway answered HTTP ${res.status} for ${route}.`);
  return data;
}

const text = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });

async function preview(jobId) {
  const res = await gateway('GET', `/api/cad/jobs/${encodeURIComponent(jobId)}/files/preview.png`);
  if (!res.ok) return null;
  return { type: 'image', data: Buffer.from(await res.arrayBuffer()).toString('base64'), mimeType: 'image/png' };
}

/** The parts of a job an agent needs, without the dashboard's bookkeeping */
function describe(job) {
  return {
    job_id: job.id,
    title: job.title,
    state: job.state,
    source: job.source,
    parent_id: job.parent_id,
    error: job.error,
    notes: job.notes?.length ? job.notes : undefined,
    summary: job.result ?? undefined,
    report: job.report,
    files: `${GATEWAY_URL}/api/cad/jobs/${job.id}/files/<model.py|model.stl|model.step|model.3mf|preview.png|fix.py|views.png>`,
    sent_to_studio: job.sent?.map((s) => s.name),
  };
}

async function callTool(name, args) {
  switch (name) {
    case 'cad_guide': {
      const res = await gateway('GET', '/api/cad/guide');
      if (!res.ok) throw new GatewayError(`Gateway answered HTTP ${res.status} for the guide.`);
      return [text(await res.text())];
    }
    case 'cad_build': {
      const { job } = await gatewayJson('POST', '/api/cad/builds', args);
      const image = job.files?.preview ? await preview(job.id) : null;
      return image ? [text(describe(job)), image] : [text(describe(job))];
    }
    case 'cad_get_job': {
      const { job } = await gatewayJson('GET', `/api/cad/jobs/${encodeURIComponent(args.job_id)}`);
      const content = [text(describe(job))];
      if (args.include_code !== false && job.files?.code) {
        const res = await gateway('GET', `/api/cad/jobs/${encodeURIComponent(job.id)}/files/model.py`);
        if (res.ok) content.push(text(`model.py:\n\n${await res.text()}`));
      }
      const image = job.files?.preview ? await preview(job.id) : null;
      if (image) content.push(image);
      return content;
    }
    case 'cad_list_jobs': {
      const { jobs } = await gatewayJson('GET', `/api/cad/jobs?limit=${args.limit ?? 20}`);
      return [
        text(jobs.map((job) => ({ job_id: job.id, title: job.title || job.prompt, state: job.state, source: job.source, size_mm: job.report?.size_mm, created_at: job.created_at }))),
      ];
    }
    case 'cad_send_to_studio': {
      const sent = await gatewayJson('POST', `/api/cad/jobs/${encodeURIComponent(args.job_id)}/studio`, { format: args.format ?? 'stl' });
      return [text({ studio_path: sent.studioPath, repair: sent.repair, next: 'In Bambu Studio: File → Import → /imports' })];
    }
    case 'cad_make_figure': {
      const form = new FormData();
      for (const key of ['prompt', 'height_mm', 'base', 'parent_id', 'colour', 'colours', 'palette', 'multiview', 'seed']) {
        if (args[key] !== undefined) form.append(key, String(args[key]));
      }
      if (args.image_path) {
        let data;
        try {
          data = await readFile(args.image_path);
        } catch (err) {
          throw new GatewayError(`Cannot read ${args.image_path}: ${err.message}`);
        }
        form.append('image', new Blob([data]), basename(args.image_path));
      }
      const res = await gateway('POST', '/api/cad/meshes', form);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new GatewayError(data?.message || `Gateway answered HTTP ${res.status} for /api/cad/meshes.`);
      return [text({ job_id: data.job.id, state: data.job.state, next: 'It is made in the background; check with cad_get_job.' })];
    }
    case 'cad_fix_figure': {
      const { job_id: jobId, ...body } = args;
      const { job } = await gatewayJson('POST', `/api/cad/jobs/${encodeURIComponent(jobId)}/fix`, body);
      return [text({ job_id: job.id, state: job.state, next: 'Claude reviews and fixes it in the background; check with cad_get_job.' })];
    }
    case 'cad_ask_claude': {
      const { job } = await gatewayJson('POST', '/api/cad/jobs', args);
      return [text({ job_id: job.id, state: job.state, next: 'It is made in the background; check with cad_get_job.' })];
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  }
}

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'bambu-cad', version: '1.0.0' },
        instructions:
          'Design 3D-printable models for the Bambu Lab H2D. Technical parts: call cad_guide once, write build123d code, call ' +
          'cad_build and check the preview. Characters and other organic shapes: cad_make_figure, then cad_fix_figure ' +
          'when the preview shows problems. Send the accepted ' +
          'model with cad_send_to_studio.',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      try {
        return { content: await callTool(params?.name, params?.arguments ?? {}) };
      } catch (err) {
        if (err.rpcCode) throw err;
        // Gateway and build problems go back to the agent as a tool error it can act on
        return { content: [text(err.message)], isError: true };
      }
    default:
      if (id === undefined) return undefined; // notifications (initialized, cancelled) need no answer
      throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
  }
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  try {
    const result = await handle(message);
    if (message.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: message.id, result });
  } catch (err) {
    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: err.rpcCode ?? -32603, message: err.message } });
  }
});
