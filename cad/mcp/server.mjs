#!/usr/bin/env node
/**
 * MCP server (stdio) that lets an agent such as Antigravity's design 3D-printable models with the gateway's CAD
 * worker (docs/cad.md): the agent writes build123d code on its own plan, this server has it built (STL, STEP,
 * preview, checks) and sends finished models to Bambu Studio. The sim_* tools simulate mechanisms with Project
 * Chrono and play them back in Blender (docs/mechanical-simulation.md). It only calls the gateway's /api/cad and
 * /api/sim routes.
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

// The mechanism format (mesh3d/sim/schema.py, schema_version 1) as JSON Schema, for the sim_* tools. The worker
// checks it fully and answers with every error; this tells the agent its shape
const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const MECHANISM_DEFS = {
  law: {
    type: 'object',
    description: 'A value over time, in the quantity\'s unit (deg/s for a speed in deg, mm for a position in mm, N·m, N)',
    properties: {
      type: { enum: ['constant', 'ramp', 'sine', 'table'] },
      value: { type: 'number' },
      start: { type: 'number' },
      slope: { type: 'number', description: 'Per second' },
      amplitude: { type: 'number' },
      frequency_hz: { type: 'number' },
      phase: { type: 'number', description: 'rad' },
      offset: { type: 'number' },
      points: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, description: '[[t, value], …], linear between, held after' },
    },
    required: ['type'],
  },
  body: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      fixed: { type: 'boolean' },
      position: { ...vec3, description: 'The body frame\'s origin in the world at t = 0' },
      orientation: {
        type: 'object',
        properties: { euler_xyz: vec3, quaternion: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: 'w, x, y, z' } },
      },
      geometry: {
        type: 'object',
        description: 'Centred on the body origin: box {size}, cylinder {radius, length, axis}, sphere {radius}, gear {teeth, module, width, axis}, mesh {file: "jobs/<job id>/out/model.stl"}',
        properties: {
          type: { enum: ['box', 'cylinder', 'sphere', 'gear', 'mesh'] },
          size: vec3,
          radius: { type: 'number' },
          length: { type: 'number' },
          axis: { enum: ['x', 'y', 'z'] },
          teeth: { type: 'integer' },
          module: { type: 'number' },
          width: { type: 'number' },
          file: { type: 'string' },
        },
        required: ['type'],
      },
      mass: { type: 'number', description: 'In units.mass; or density' },
      density: { type: 'number', description: 'kg/m³, with a geometry' },
      center_of_mass: { ...vec3, description: 'In the body frame' },
      inertia: {
        type: 'object',
        description: 'About the centre of mass, body axes, in mass·length² of units',
        properties: { ixx: { type: 'number' }, iyy: { type: 'number' }, izz: { type: 'number' }, ixy: { type: 'number' }, ixz: { type: 'number' }, iyz: { type: 'number' } },
        required: ['ixx', 'iyy', 'izz'],
      },
      collision: { type: 'boolean' },
      material: {
        type: 'object',
        properties: {
          friction: { type: 'number' },
          restitution: { type: 'number' },
          young_modulus_Pa: { type: 'number', description: 'SMC contacts only' },
          poisson_ratio: { type: 'number', description: 'SMC contacts only' },
        },
      },
      visual: {
        type: 'object',
        properties: { color: { type: 'string', description: '#RRGGBB' }, mesh_file: { type: 'string' }, blend_file: { type: 'string' }, blender_object: { type: 'string' } },
      },
    },
    required: ['id', 'position'],
  },
  joint: {
    type: 'object',
    description: 'body_b moves relative to body_a; position and axis in the world at t = 0',
    properties: {
      id: { type: 'string' },
      type: { enum: ['fixed', 'revolute', 'prismatic', 'spherical', 'cylindrical', 'distance', 'gear'] },
      body_a: { type: 'string' },
      body_b: { type: 'string' },
      position: vec3,
      axis: vec3,
      limits: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } }, required: ['min', 'max'] },
      point_a: vec3,
      point_b: vec3,
      joint_a: { type: 'string', description: 'gear: the first gear\'s revolute joint' },
      joint_b: { type: 'string', description: 'gear: the second gear\'s revolute joint' },
      teeth_a: { type: 'integer' },
      teeth_b: { type: 'integer' },
      internal: { type: 'boolean' },
      model: { enum: ['ideal', 'contact'], description: 'gear: ideal constraint (default), or teeth in contact (backlash, mesh stiffness, friction)' },
      backlash: { type: 'number', description: 'gear contact: circumferential backlash on the pitch circle, both gears, in the length unit' },
      friction: { type: 'number', description: 'gear contact: tooth friction coefficient' },
      mesh_stiffness_N_per_m: { type: 'number', description: 'gear contact: stiffness of one tooth pair (or give young_modulus_Pa)' },
      young_modulus_Pa: { type: 'number', description: 'gear contact: the gears\' material, for ISO 6336\'s stiffness' },
      pressure_angle: { type: 'number', description: 'gear contact: in the angle unit, default 20°' },
      damping_ratio: { type: 'number', description: 'gear contact: mesh damping, default 0.1' },
    },
    required: ['id', 'type'],
  },
  actuator: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      type: { enum: ['rotational_motor', 'linear_actuator'] },
      mode: { enum: ['angle', 'speed', 'torque', 'position', 'force'] },
      body_a: { type: 'string' },
      body_b: { type: 'string' },
      position: vec3,
      axis: vec3,
      law: { $ref: '#/$defs/law' },
      guide: { enum: ['auto', 'joint', 'free'] },
    },
    required: ['id', 'type', 'mode', 'body_a', 'body_b', 'position', 'axis', 'law'],
  },
  force: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      type: { enum: ['force', 'torque', 'spring_damper', 'rotational_spring_damper'] },
      body: { type: 'string' },
      vector: { ...vec3, description: 'N or N·m' },
      frame: { enum: ['world', 'body'] },
      point: vec3,
      law: { $ref: '#/$defs/law' },
      body_a: { type: 'string' },
      body_b: { type: 'string' },
      point_a: vec3,
      point_b: vec3,
      position: vec3,
      axis: vec3,
      stiffness_N_per_m: { type: 'number' },
      damping_Ns_per_m: { type: 'number' },
      rest_length: { type: 'number' },
      stiffness_Nm_per_rad: { type: 'number' },
      damping_Nms_per_rad: { type: 'number' },
      rest_angle: { type: 'number' },
    },
    required: ['id', 'type'],
  },
  simulation: {
    type: 'object',
    properties: {
      duration: { type: 'number', description: 's' },
      time_step: { type: 'number', description: 's, e.g. 0.001' },
      output_interval: { type: 'number' },
      gravity: { ...vec3, description: 'm/s², default [0, 0, -9.81]' },
      solver: { enum: ['default', 'psor', 'apgd', 'barzilai_borwein', 'minres'] },
      integrator: { enum: ['default', 'euler_implicit_linearized', 'euler_implicit_projected', 'hht'] },
      max_iterations: { type: 'integer' },
      tolerance: { type: 'number' },
      constraint_tolerance: { type: 'number' },
      collision: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          method: { enum: ['nsc', 'smc'], description: 'nsc: rigid (default); smc: Hertz springs, needs young_modulus_Pa and poisson_ratio on each colliding body' },
          envelope: { type: 'number', description: 'In the length unit, default 0.5 mm' },
          margin: { type: 'number', description: 'In the length unit, default 0.1 mm' },
        },
      },
    },
  },
  mechanism: {
    type: 'object',
    properties: {
      schema_version: { const: 1 },
      name: { type: 'string' },
      units: {
        type: 'object',
        properties: { length: { enum: ['mm', 'm'] }, mass: { enum: ['kg', 'g'] }, angle: { enum: ['deg', 'rad'] } },
        required: ['length'],
      },
      bodies: { type: 'array', items: { $ref: '#/$defs/body' } },
      joints: { type: 'array', items: { $ref: '#/$defs/joint' } },
      actuators: { type: 'array', items: { $ref: '#/$defs/actuator' } },
      forces: { type: 'array', items: { $ref: '#/$defs/force' } },
      simulation: { $ref: '#/$defs/simulation' },
    },
    required: ['schema_version', 'units', 'bodies'],
  },
};

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
  // ---------- mechanism simulation (docs/mechanical-simulation.md): Project Chrono + Blender, on this computer ----------
  {
    name: 'sim_guide',
    description:
      'Read this before the first simulation. The mechanism format (schema_version 1): bodies, joints (fixed, ' +
      'revolute, prismatic, spherical, cylindrical, distance, gear), actuators (rotational motor, linear actuator, ' +
      'with a motion law), forces (force, torque, spring-dampers) and the simulation settings; units and frames; and ' +
      'the rule that missing physical data (mass, inertia, motor law, stiffness) is asked for, never invented.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sim_create_mechanism',
    description:
      'Store a mechanism (JSON, schema_version 1; see sim_guide). It may be incomplete: add joints, motors and ' +
      'forces after. Returns its mechanism_id and the validation (errors with the field path, warnings, ' +
      'assumptions, the estimated degrees of freedom). Pass mechanism_id to replace a stored one.',
    inputSchema: {
      type: 'object',
      properties: {
        mechanism: { $ref: '#/$defs/mechanism' },
        mechanism_id: { type: 'string', description: 'Replace this stored mechanism instead of making a new one' },
      },
      required: ['mechanism'],
      additionalProperties: false,
      $defs: MECHANISM_DEFS,
    },
  },
  {
    name: 'sim_add_joint',
    description:
      'Add one joint to a stored mechanism: fixed, revolute, prismatic, spherical, cylindrical, distance, or gear ' +
      '(a gear pair between two revolute joints: ideal, or model "contact" with backlash, tooth stiffness and ' +
      'friction). Refused, and nothing saved, when the joint itself is wrong ' +
      '(a body that does not exist, a zero axis, limits not around 0).',
    inputSchema: {
      type: 'object',
      properties: { mechanism_id: { type: 'string' }, joint: { $ref: '#/$defs/joint' } },
      required: ['mechanism_id', 'joint'],
      additionalProperties: false,
      $defs: MECHANISM_DEFS,
    },
  },
  {
    name: 'sim_add_motor',
    description:
      'Add a rotational motor (angle, speed or torque) or a linear actuator (position, speed or force) with its ' +
      'motion law to a stored mechanism. On a pair a revolute/prismatic joint already guides, it only drives.',
    inputSchema: {
      type: 'object',
      properties: { mechanism_id: { type: 'string' }, actuator: { $ref: '#/$defs/actuator' } },
      required: ['mechanism_id', 'actuator'],
      additionalProperties: false,
      $defs: MECHANISM_DEFS,
    },
  },
  {
    name: 'sim_add_force',
    description: 'Add a force, a torque, a spring-damper or a rotational spring-damper to a stored mechanism.',
    inputSchema: {
      type: 'object',
      properties: { mechanism_id: { type: 'string' }, force: { $ref: '#/$defs/force' } },
      required: ['mechanism_id', 'force'],
      additionalProperties: false,
      $defs: MECHANISM_DEFS,
    },
  },
  {
    name: 'sim_validate_mechanism',
    description:
      'Check a mechanism (stored, or given inline) without running it: every error with its field path, warnings ' +
      '(no fixed body, redundant constraints), the values that were derived or defaulted (assumptions) and the ' +
      'estimated degrees of freedom.',
    inputSchema: {
      type: 'object',
      properties: { mechanism_id: { type: 'string' }, mechanism: { $ref: '#/$defs/mechanism' } },
      additionalProperties: false,
      $defs: MECHANISM_DEFS,
    },
  },
  {
    name: 'sim_run_simulation',
    description:
      'Simulate a mechanism with Project Chrono on this computer (CPU, in the background, one run at a time). ' +
      'Returns the sim_id; with wait_s it waits up to that long and returns the final state. `simulation` overrides ' +
      'the mechanism\'s settings (duration, time_step…) for this run only.',
    inputSchema: {
      type: 'object',
      properties: {
        mechanism_id: { type: 'string' },
        mechanism: { $ref: '#/$defs/mechanism' },
        simulation: { $ref: '#/$defs/simulation' },
        wait_s: { type: 'number', minimum: 0, maximum: 180, description: 'Wait this long for it to finish (default 60)' },
      },
      additionalProperties: false,
      $defs: MECHANISM_DEFS,
    },
  },
  {
    name: 'sim_get_simulation_status',
    description: 'A run\'s state (queued, running, completed, failed, cancelled), progress, warnings, error, failed checks, and its Blender playback.',
    inputSchema: {
      type: 'object',
      properties: { sim_id: { type: 'string' }, cancel: { type: 'boolean', description: 'Stop the run (or its playback)' } },
      required: ['sim_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'sim_get_simulation_results',
    description:
      'A finished run: per body how far and fast it moved, per joint its coordinate range, reaction force/torque ' +
      'and motor effort, the checks against theory, the assumptions, and the URLs of body_transforms.csv, ' +
      'joint_results.csv, metadata.json, summary.json and simulation.log. Results are simulated, not measured.',
    inputSchema: { type: 'object', properties: { sim_id: { type: 'string' } }, required: ['sim_id'], additionalProperties: false },
  },
  {
    name: 'sim_play_simulation_in_blender',
    description:
      'Play a finished run back in Blender: every body keyframed from Chrono\'s poses (Blender\'s physics is not ' +
      'used), checked against Chrono (positions, and each joint\'s angle and turning direction), saved as ' +
      'playback.blend, and with render a Workbench MP4 and a preview sheet, returned as an image.',
    inputSchema: {
      type: 'object',
      properties: {
        sim_id: { type: 'string' },
        render: { type: 'boolean', description: 'Render the MP4 and preview (default true); false only builds the .blend and checks it' },
        fps: { type: 'integer', minimum: 10, maximum: 60 },
        speed: { type: 'number', minimum: 0.05, maximum: 20, description: 'Playback speed: 0.5 is slow motion' },
        width: { type: 'integer', minimum: 320, maximum: 1920 },
        height: { type: 'integer', minimum: 240, maximum: 1080 },
        wait_s: { type: 'number', minimum: 0, maximum: 230, description: 'Wait this long for Blender (default 180)' },
      },
      required: ['sim_id'],
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

/** A /api/sim answer; a refusal carries the worker's field-by-field errors, for the agent to fix */
async function simJson(method, route, body) {
  const res = await gateway(method, route, body);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    const details = Array.isArray(data?.details) ? data.details.map((e) => `\n- ${e.path}: ${e.message}`).join('') : '';
    throw new GatewayError(`${data?.message || `Gateway answered HTTP ${res.status} for ${route}.`}${details}`);
  }
  const { success, ...rest } = data;
  return rest;
}

/** Polls a run until `stateOf` its status is final or `seconds` pass; returns the last status */
async function waitFor(simId, seconds, stateOf) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const { status } = await simJson('GET', `/api/sim/runs/${encodeURIComponent(simId)}`);
    if (!['queued', 'running', undefined].includes(stateOf(status)) || Date.now() >= deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const fileUrls = (id, files) =>
  files && Object.fromEntries(Object.keys(files).map((name) => [name, `${GATEWAY_URL}/api/sim/runs/${id}/files/${name}`]));

async function simImage(id) {
  const res = await gateway('GET', `/api/sim/runs/${id}/files/blender/preview.png`);
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
    case 'sim_guide': {
      const res = await gateway('GET', '/api/sim/guide');
      if (!res.ok) throw new GatewayError(`Gateway answered HTTP ${res.status} for the simulation guide.`);
      return [text(await res.text())];
    }
    case 'sim_create_mechanism':
      return [text(await simJson('POST', '/api/sim/mechanisms', args))];
    case 'sim_add_joint':
    case 'sim_add_motor':
    case 'sim_add_force': {
      const [part, key] = { sim_add_joint: ['joints', 'joint'], sim_add_motor: ['actuators', 'actuator'], sim_add_force: ['forces', 'force'] }[name];
      return [text(await simJson('POST', `/api/sim/mechanisms/${encodeURIComponent(args.mechanism_id)}/${part}`, { [key]: args[key] }))];
    }
    case 'sim_validate_mechanism':
      return [text(await simJson('POST', '/api/sim/validate', args))];
    case 'sim_run_simulation': {
      const { wait_s: waitS = 60, ...body } = args;
      const started = await simJson('POST', '/api/sim/runs', body);
      const status = await waitFor(started.sim_id, waitS, (s) => s.state);
      const out = { ...started, status };
      if (status.state === 'completed') out.next = 'sim_get_simulation_results, then sim_play_simulation_in_blender';
      else if (['queued', 'running'].includes(status.state)) out.next = 'Still running: check with sim_get_simulation_status.';
      return [text(out)];
    }
    case 'sim_get_simulation_status': {
      const id = encodeURIComponent(args.sim_id);
      if (args.cancel) await simJson('POST', `/api/sim/runs/${id}/cancel`, {});
      return [text((await simJson('GET', `/api/sim/runs/${id}`)).status)];
    }
    case 'sim_get_simulation_results': {
      const id = encodeURIComponent(args.sim_id);
      const results = await simJson('GET', `/api/sim/runs/${id}/results`);
      const content = [text({ ...results, files: fileUrls(id, results.files) })];
      const image = results.playback?.files?.['blender/preview.png'] ? await simImage(id) : null;
      return image ? [...content, image] : content;
    }
    case 'sim_play_simulation_in_blender': {
      const { sim_id: simId, wait_s: waitS = 180, ...options } = args;
      const id = encodeURIComponent(simId);
      await simJson('POST', `/api/sim/runs/${id}/play`, options);
      const status = await waitFor(simId, waitS, (s) => s.playback?.state);
      const play = status.playback ?? {};
      const out = { sim_id: simId, playback: { ...play, files: fileUrls(id, play.files) } };
      if (['queued', 'running'].includes(play.state)) out.next = 'Blender is still working: check with sim_get_simulation_status.';
      const image = play.files?.['blender/preview.png'] ? await simImage(id) : null;
      return image ? [text(out), image] : [text(out)];
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
          'model with cad_send_to_studio. Mechanisms (linkages, gears, motors, springs): call sim_guide once, describe ' +
          'the mechanism with sim_create_mechanism (and sim_add_*), sim_run_simulation (Project Chrono, on this ' +
          'computer), sim_get_simulation_results, then sim_play_simulation_in_blender.',
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
