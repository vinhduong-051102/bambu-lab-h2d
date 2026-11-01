#!/usr/bin/env node
/**
 * MCP server (stdio) that lets an agent such as Antigravity's design 3D-printable models with the gateway's CAD
 * worker (docs/cad.md): the agent writes build123d code on its own plan, as a text-to-cad `@model`
 * (docs/text-to-cad.md), this server has it built by cadgen (STL, STEP, GLB, preview, checks) and sends finished
 * models to Bambu Studio. The engineering tools check printed parts and assemblies in the mesh worker
 * (docs/engineering-analysis.md). It only calls the gateway's /api/cad and /api/eng routes.
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

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

// ---------- engineering analysis of printed parts (docs/engineering-analysis.md) ----------
// Lengths mm, forces N, stresses and moduli MPa. Every result: status PASS / WARNING / FAIL / NOT_EVALUATED per check,
// with its assumptions, warnings and missing data; nothing is filled in when a solver fails
const ENG_STATUS =
  ' The answer is an AnalysisResult: an overall status and checks, each PASS, WARNING, FAIL or NOT_EVALUATED (not enough ' +
  'data, or not run); NOT_EVALUATED is never a pass. Repeat its assumptions and missing data to the user.';
const modelRef = {
  model_id: { type: 'string', description: 'From inspect_3d_model' },
  version: { type: 'integer', minimum: 1, description: 'Model version (default: the latest)' },
};
const ENG_DEFS = {
  print: {
    type: 'object',
    description:
      'How the part is printed, as the user states or measured. Tolerances come from this printer, material and process ' +
      '(a calibration print), never from a generic value.',
    properties: {
      printer: { type: 'string' },
      process: { enum: ['fdm', 'sla', 'sls', 'mjf'] },
      filament: { type: 'string', description: 'Type, e.g. PLA, PETG-CF' },
      brand: { type: 'string' },
      nozzle_mm: { type: 'number' },
      line_width_mm: { type: 'number' },
      layer_height_mm: { type: 'number' },
      walls: { type: 'integer' },
      infill_percent: { type: 'number' },
      infill_pattern: { type: 'string' },
      nozzle_temp_C: { type: 'number' },
      bed_temp_C: { type: 'number' },
      build_direction: { ...vec3, description: 'Model direction that points up on the printer (default +Z)' },
      build_volume_mm: vec3,
      overhang_limit_deg: { type: 'number', description: 'Steepest overhang from vertical printed without support' },
      xy_tolerance_mm: { type: 'number', description: '± error on outer XY sizes' },
      hole_shrink_mm: { type: 'number', description: 'How much smaller a printed hole comes out (on the diameter)' },
      shaft_growth_mm: { type: 'number', description: 'How much larger a printed shaft comes out (on the diameter)' },
      min_clearance_mm: { type: 'number', description: 'Diametral clearance a running fit needs on this printer' },
      tolerance_source: { enum: ['calibration', 'user', 'datasheet', 'unknown'] },
      service: { type: 'string', description: 'Use conditions: temperature, load, expected life' },
    },
  },
  material: {
    type: 'object',
    description: 'Numbers for the printed material (MPa). The name alone gives no property.',
    properties: {
      name: { type: 'string' },
      brand: { type: 'string' },
      young_modulus_MPa: { type: 'number' },
      poisson_ratio: { type: 'number' },
      density_g_cm3: { type: 'number' },
      yield_strength_MPa: { type: 'number' },
      tensile_strength_MPa: { type: 'number' },
      interlayer_strength_MPa: { type: 'number', description: 'Across layers (along the build direction)' },
      source: { enum: ['datasheet', 'test', 'literature', 'unknown'] },
      printed: { type: 'boolean', description: 'Measured on printed specimens' },
    },
  },
  region: {
    type: 'object',
    description: 'Nodes picked on the surface (mm, model frame): exactly one of box, plane, sphere',
    properties: {
      box: { type: 'object', properties: { min: vec3, max: vec3 }, required: ['min', 'max'] },
      plane: { type: 'object', properties: { axis: { enum: ['x', 'y', 'z'] }, value: { type: 'number' }, tolerance: { type: 'number' } }, required: ['axis', 'value'] },
      sphere: { type: 'object', properties: { center: vec3, radius: { type: 'number' } }, required: ['center', 'radius'] },
    },
  },
};
const ENG_TOOLS = [
  {
    name: 'inspect_3d_model',
    description:
      'Import a model and report its geometry: components, bounding boxes, sizes, volumes (only from closed, outward ' +
      'meshes), surface area, centre of mass, mesh counts, units and where each part came from. Reads STL, 3MF (every ' +
      'object, its unit), OBJ, PLY, GLB, and .blend scenes (every visible mesh object, through Blender). STEP is not ' +
      'read (no CAD kernel): export STL/3MF. The files are kept untouched; a new import of model_id is a new version. ' +
      'Without files, describes an existing model.' + ENG_STATUS,
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Paths on this computer: each is uploaded' },
        gateway_files: { type: 'array', items: { type: 'string' }, description: 'Files the gateway has: jobs/<job id>/out/model.stl…' },
        ...modelRef,
        name: { type: 'string' },
        units: { enum: ['mm', 'cm', 'm', 'in'], description: 'For STL/OBJ/PLY, which carry none (default mm, stated as an assumption)' },
        split_bodies: { type: 'boolean', description: 'Make each separate body of a file its own component' },
      },
      additionalProperties: false,
      $defs: ENG_DEFS,
    },
  },
  {
    name: 'validate_mesh',
    description:
      'Check each component\'s mesh: non-manifold edges, inverted or inconsistent normals and self-intersections (FAIL ' +
      'for a solid), open edges (WARNING: a shell may be meant; set intents to "surface"), several bodies, degenerate ' +
      'faces, whether volume and size can be trusted, parts too small for the extrusion width, and components that ' +
      'overlap each other (with the volume).' + ENG_STATUS,
    inputSchema: {
      type: 'object',
      properties: {
        ...modelRef,
        intents: { type: 'object', additionalProperties: { enum: ['solid', 'surface'] }, description: '{component: "solid" | "surface"}' },
        print: { $ref: '#/$defs/print' },
      },
      required: ['model_id'],
      additionalProperties: false,
      $defs: ENG_DEFS,
    },
  },
  {
    name: 'analyze_assembly',
    description:
      'Analyse an assembly: each component\'s placement, overlaps, cylindrical holes and shafts (fitted on the mesh), ' +
      'coaxial hole/shaft pairs with their offset and engagement, touching pairs, and SUGGESTED joints. Suggestions are ' +
      'never used until the user confirms: pass `joints` (what the user confirmed or corrected) to store them for this ' +
      'model version.' + ENG_STATUS,
    inputSchema: {
      type: 'object',
      properties: {
        ...modelRef,
        joints: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { enum: ['fixed', 'revolute', 'prismatic', 'cylindrical', 'spherical'] },
              component_a: { type: 'string', description: 'The base' },
              component_b: { type: 'string', description: 'The moving part' },
              axis: vec3,
              position: { ...vec3, description: 'mm, model frame' },
              note: { type: 'string' },
            },
            required: ['type', 'component_a', 'component_b'],
          },
        },
        touch_mm: { type: 'number', description: 'Closer than this counts as touching (default 0.05)' },
      },
      required: ['model_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_clearance',
    description:
      'Fits and clearances (mm): gaps between components, coaxial hole/shaft fits as designed and as printed (from the ' +
      'printer tolerances in `print`; without them the printed fit is NOT_EVALUATED), wall thickness against walls × ' +
      'line width, and gear backlash from the centre distance of declared gear pairs.' + ENG_STATUS,
    inputSchema: {
      type: 'object',
      properties: {
        ...modelRef,
        print: { $ref: '#/$defs/print' },
        fits: {
          type: 'array',
          items: { type: 'object', properties: { hole: { type: 'string' }, shaft: { type: 'string' }, type: { enum: ['running', 'sliding', 'press', 'free'] } }, required: ['hole', 'shaft'] },
          description: 'Feature ids from analyze_assembly (e.g. bracket.hole1, pin.shaft1); default: every coaxial pair as a running fit',
        },
        gears: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              component_a: { type: 'string' },
              component_b: { type: 'string' },
              teeth_a: { type: 'integer' },
              teeth_b: { type: 'integer' },
              module: { type: 'number' },
              pressure_angle_deg: { type: 'number' },
              axis: vec3,
            },
            required: ['component_a', 'component_b', 'teeth_a', 'teeth_b', 'module'],
          },
        },
        pairs: { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 } },
      },
      required: ['model_id'],
      additionalProperties: false,
      $defs: ENG_DEFS,
    },
  },
  {
    name: 'configure_fea_analysis',
    description:
      'Set up a linear static FEA of one component (gmsh second-order tetrahedra, CalculiX): material (E and ν required, ' +
      'strengths for a safety factor), fixed regions, loads (total force in N over a region, or pressure in MPa), ' +
      'element size and a two-size convergence study. Regions select surface nodes by box, plane or sphere in the model ' +
      'frame (mm): use inspect_3d_model\'s bounds to place them. Loads and supports come from the user. Returns ' +
      'config_id and what is still missing.',
    inputSchema: {
      type: 'object',
      properties: {
        ...modelRef,
        config: {
          type: 'object',
          properties: {
            component: { type: 'string' },
            material: { $ref: '#/$defs/material' },
            constraints: { type: 'array', items: { type: 'object', properties: { region: { $ref: '#/$defs/region' } }, required: ['region'] } },
            loads: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { enum: ['force', 'pressure'] },
                  region: { $ref: '#/$defs/region' },
                  vector: { ...vec3, description: 'force: total N' },
                  value: { type: 'number', description: 'pressure: MPa, into the surface' },
                },
                required: ['type', 'region'],
              },
            },
            mesh_size_mm: { type: 'number' },
            convergence: { type: 'boolean', description: 'Solve at two element sizes and compare (default true)' },
            required_safety_factor: { type: 'number' },
            max_displacement_mm: { type: 'number' },
            print: { $ref: '#/$defs/print' },
          },
          required: ['component', 'material', 'constraints', 'loads'],
        },
      },
      required: ['model_id', 'config'],
      additionalProperties: false,
      $defs: ENG_DEFS,
    },
  },
  {
    name: 'run_fea_analysis',
    description:
      'Solve a configured FEA (or follow one with analysis_id): displacement, von Mises stress (peak, and away from ' +
      'supports and load patches, where idealised boundary conditions make singular peaks), mesh convergence, safety ' +
      'factor only with the material\'s strength and a required factor, tension across layers with the interlayer ' +
      'strength and build direction. A solver failure is reported as such, with no numbers.' + ENG_STATUS,
    inputSchema: {
      type: 'object',
      properties: {
        ...modelRef,
        config_id: { type: 'string' },
        analysis_id: { type: 'string', description: 'Follow a solve already started' },
        wait_s: { type: 'number', minimum: 0, maximum: 900, description: 'Wait this long for the solver (default 300)' },
      },
      required: ['model_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'analyze_printability',
    description:
      'Printability for the declared print setup: overhangs needing support (area, where), bed contact, thin walls, ' +
      'small and horizontal holes, build volume, layers against the load (with an FEA result), and what needs a ' +
      'calibration print. No strength is inferred from a material name.' + ENG_STATUS,
    inputSchema: {
      type: 'object',
      properties: {
        ...modelRef,
        print: { $ref: '#/$defs/print' },
        fea_analysis_id: { type: 'string' },
        intents: { type: 'object', additionalProperties: { enum: ['solid', 'surface'] } },
      },
      required: ['model_id'],
      additionalProperties: false,
      $defs: ENG_DEFS,
    },
  },
  {
    name: 'generate_engineering_report',
    description:
      'The engineering report of a model version from its latest analyses (or the ones named): model, geometry, mesh ' +
      'errors, assembly, fits, FEA, printability, assumptions and missing data, recommendations, confidence. ' +
      'Markdown and a self-contained HTML (with the Blender renders).',
    inputSchema: {
      type: 'object',
      properties: { ...modelRef, analysis_ids: { type: 'array', items: { type: 'string' } } },
      required: ['model_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'visualize_results_in_blender',
    description:
      'Show results in Blender (headless), returned as an image with a .blend to open: "fea" (von Mises on the ' +
      'deformed part, from a finished FEA), "interference" (overlaps in red), "thickness" (walls coloured by thickness).',
    inputSchema: {
      type: 'object',
      properties: {
        ...modelRef,
        mode: { enum: ['fea', 'interference', 'thickness'] },
        analysis_id: { type: 'string', description: 'fea: the FEA analysis' },
        print: { $ref: '#/$defs/print' },
        deformation_scale: { type: 'number' },
      },
      required: ['model_id', 'mode'],
      additionalProperties: false,
      $defs: ENG_DEFS,
    },
  },
];

const TOOLS = [
  {
    name: 'cad_guide',
    description:
      'Read this first. The rules for models on the Bambu Lab H2D (millimetres, Z up, sits on Z = 0, printable ' +
      'walls/overhangs/clearances) in text-to-cad\'s format: a cadgen `@model` function that returns a build123d ' +
      'shape, or an assembly of labelled children.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cad_build',
    description:
      'Build a model with text-to-cad\'s cadgen engine from a Python file that defines a `@model` function (from ' +
      'cadgen; the last one, or the one `MODEL = "name"` names) returning a build123d shape; a file that assigns ' +
      '`result` (the older format) builds too. Returns the build report (size in mm, volume, mesh checks, ' +
      'warnings, or the error and traceback) and a preview image with four views drawn by cadgen. Check the preview against the request and build again with fixed code until it matches. ' +
      'Each call makes a new job; pass parent_id to link it to the job it revises.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The whole model file (cadgen @model + build123d)' },
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
  ...ENG_TOOLS,
];

class GatewayError extends Error {}

async function gateway(method, route, body, timeoutMs = 240000) {
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
      signal: AbortSignal.timeout(timeoutMs),
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

/** An /api/eng answer (long operations: up to 15 minutes); a refusal carries the field-by-field errors */
async function engJson(method, route, body) {
  const res = await gateway(method, `/api/eng/${route}`, body, 16 * 60 * 1000);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    const details = Array.isArray(data?.details)
      ? data.details.map((e) => (typeof e === 'string' ? `
- ${e}` : `
- ${e.path}: ${e.message}`)).join('')
      : '';
    throw new GatewayError(`${data?.message || `Gateway answered HTTP ${res.status} for /api/eng/${route}.`}${details}`);
  }
  const { success, ...rest } = data;
  return rest;
}

const engFileUrls = (result) =>
  result?.files &&
  Object.fromEntries(Object.entries(result.files).map(([name, path]) => [name, `${GATEWAY_URL}/api/eng/analyses/${result.analysis_id}/files/${path}`]));

/** An analysis result for the agent: everything, with the files as URLs */
const engResult = (result) => ({ ...result, files: engFileUrls(result) });

async function engImage(analysisId, name = 'result.png') {
  const res = await gateway('GET', `/api/eng/analyses/${encodeURIComponent(analysisId)}/files/${name}`);
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
    files: `${GATEWAY_URL}/api/cad/jobs/${job.id}/files/<model.py|model.stl|model.step|model.glb|model.3mf|preview.png|drawing.pdf|dfam.json|fix.py|views.png>`,
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
    case 'inspect_3d_model': {
      const { files = [], gateway_files: gatewayFiles = [], ...rest } = args;
      const sources = gatewayFiles.map((file) => ({ file }));
      for (const path of files) {
        let data;
        try {
          data = await readFile(path);
        } catch (err) {
          throw new GatewayError(`Cannot read ${path}: ${err.message}`);
        }
        sources.push({ filename: basename(path), data_base64: data.toString('base64') });
      }
      const out = await engJson('POST', 'inspect', { ...rest, ...(sources.length && { sources }) });
      return [text({ model: out.model, result: engResult(out.result) })];
    }
    case 'validate_mesh':
      return [text(engResult((await engJson('POST', 'validate', args)).result))];
    case 'analyze_assembly':
      return [text(engResult((await engJson('POST', 'assembly', args)).result))];
    case 'check_clearance':
      return [text(engResult((await engJson('POST', 'clearance', args)).result))];
    case 'configure_fea_analysis':
      return [text(await engJson('POST', 'fea/configure', args))];
    case 'run_fea_analysis': {
      const { wait_s: waitS = 300, analysis_id: given, ...body } = args;
      const analysisId = given ?? (await engJson('POST', 'fea/run', body)).analysis_id;
      const deadline = Date.now() + waitS * 1000;
      let result;
      for (;;) {
        ({ result } = await engJson('GET', `analyses/${encodeURIComponent(analysisId)}`));
        if (!['queued', 'running'].includes(result.state) || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      const out = engResult(result);
      if (['queued', 'running'].includes(result.state)) out.next = 'Still solving: call run_fea_analysis with this analysis_id.';
      return [text(out)];
    }
    case 'analyze_printability':
      return [text(engResult((await engJson('POST', 'printability', args)).result))];
    case 'generate_engineering_report': {
      const { result, markdown } = await engJson('POST', 'report', args);
      return [text({ ...engResult(result), markdown })];
    }
    case 'visualize_results_in_blender': {
      const { result } = await engJson('POST', 'visualize', args);
      const image = result.files?.['result.png'] ? await engImage(result.analysis_id) : null;
      return image ? [text(engResult(result)), image] : [text(engResult(result))];
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
          'Design 3D-printable models for the Bambu Lab H2D. Technical parts: call cad_guide once, write a text-to-cad @model (cadgen + build123d), call ' +
          'cad_build and check the preview. Characters and other organic shapes: cad_make_figure, then cad_fix_figure ' +
          'when the preview shows problems. Send the accepted ' +
          'model with cad_send_to_studio. ' +
          'Engineering checks of a printed ' +
          'part or assembly (local, no cloud): inspect_3d_model, validate_mesh, analyze_assembly (confirm joints with ' +
          'the user), check_clearance, configure/run_fea_analysis, ' +
          'analyze_printability, visualize_results_in_blender, generate_engineering_report. Ask the user for material, ' +
          'printer tolerances, loads and supports; never invent them.',
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
