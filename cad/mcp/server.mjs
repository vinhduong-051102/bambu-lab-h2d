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
// ---------- mechanical model (docs/mechanical-model.md): parts, assembly, DOF, gears, Chrono, repairs ----------
const MECH_STATUS =
  ' Statuses are passed, warning, failed or not_verified (never a pass). Every value carries its source (user, ' +
  'imported_cad, geometry, material_database, solver, assumption, unknown): repeat assumptions and missing data to the user.';
const designRef = {
  design_id: { type: 'string', description: 'From mech_create_design or mech_import_model' },
  revision: { type: 'integer', minimum: 1, description: 'Revision (default: the latest)' },
};
const MECH_TOOLS = [
  {
    name: 'mech_guide',
    description:
      'Read this before the first mechanical design. The Mechanical Model Schema (mech/1): parts (shape or mesh, ' +
      'material, mass, placement), joints, gear pairs, motors, loads, simulation settings; provenance of every value; ' +
      'the workflow (create, validate, repair with approval, simulate, results); what Chrono does not support.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mech_create_design',
    description:
      'Store a mechanical design (mech/1, see mech_guide) as revision 1 and validate it: the parts table with each ' +
      'value\'s source, degrees of freedom, diagnostics and missing data. Physical data the user did not give is ' +
      'never filled in: ask for it.' + MECH_STATUS,
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'object', description: 'The mech/1 model' },
        note: { type: 'string', description: 'What this revision is' },
      },
      required: ['model'],
      additionalProperties: false,
    },
  },
  {
    name: 'mech_import_model',
    description:
      'Start a design from a CAD assembly inspected with inspect_3d_model: each component becomes a part (geometry ' +
      'from the mesh, source imported_cad), and joint hypotheses (coaxial hole/shaft, touching faces) are listed with ' +
      'their confidence. A hypothesis becomes a joint only when listed in `accept` after the user confirmed it.' + MECH_STATUS,
    inputSchema: {
      type: 'object',
      properties: {
        model_id: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        fixed: { type: 'array', items: { type: 'string' }, description: 'Components fixed to the ground' },
        materials: { type: 'object', additionalProperties: { type: 'string' }, description: '{component: material}' },
        accept: { type: 'array', items: { type: 'string' }, description: 'Hypothesis ids the user confirmed' },
        simulation: { type: 'object' },
        create: { type: 'boolean', description: 'Store as a design (default true); false only drafts it' },
      },
      required: ['model_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'mech_update_design',
    description:
      'Change a design: a new revision with `changes` merged into the latest. Lists (parts, joints, gears, motors, ' +
      'loads) are updated by id: an item replaces the one with its id or is added; {"id", "remove": true} removes ' +
      'it. `simulation` is merged. The old revision is kept.' + MECH_STATUS,
    inputSchema: {
      type: 'object',
      properties: {
        design_id: { type: 'string' },
        changes: { type: 'object' },
        note: { type: 'string', description: 'What changed and why' },
      },
      required: ['design_id', 'changes'],
      additionalProperties: false,
    },
  },
  {
    name: 'mech_validate',
    description:
      'Check the assembly: rigid groups, degrees of freedom from the constraint Jacobian (mobility, driven, ' +
      'redundant equations by joint), motors driving locked coordinates or conflicting, undriven DOF, gear checks ' +
      '(module, centre distance, common carrier), joints away from their part or hole, misaligned axes, overlaps, ' +
      'Chrono capability, and the expected speed of every part.' + MECH_STATUS,
    inputSchema: { type: 'object', properties: designRef, required: ['design_id'], additionalProperties: false },
  },
  {
    name: 'mech_get_design',
    description: 'A design: its revisions, the stored model, the validation and its runs. Without design_id, lists the designs.',
    inputSchema: { type: 'object', properties: designRef, additionalProperties: false },
  },
  {
    name: 'mech_propose_repairs',
    description:
      'Repair proposals for a design\'s problems: what each changes, and whether it needs data from the user ' +
      '(changes null). Show them to the user; nothing is changed here.',
    inputSchema: { type: 'object', properties: designRef, required: ['design_id'], additionalProperties: false },
  },
  {
    name: 'mech_apply_repairs',
    description:
      'Apply proposals the USER APPROVED (approved: true) as a new revision, and compare the validation before and ' +
      'after. At most 5 automatic repair rounds per design.',
    inputSchema: {
      type: 'object',
      properties: {
        design_id: { type: 'string' },
        proposal_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        approved: { type: 'boolean', description: 'true only when the user agreed to these proposals' },
      },
      required: ['design_id', 'proposal_ids', 'approved'],
      additionalProperties: false,
    },
  },
  {
    name: 'mech_simulate',
    description:
      'Simulate a valid design in Project Chrono (refused with the errors when validation failed): compiles rigid ' +
      'groups to bodies, runs, and compares to the kinematic prediction. Returns the sim_id and the results per part, ' +
      'joint, gear and motor. Then sim_play_simulation_in_blender with the sim_id.' + MECH_STATUS,
    inputSchema: {
      type: 'object',
      properties: {
        ...designRef,
        simulation: { type: 'object', description: 'Overrides for this run: duration, time_step, ...' },
        wait_s: { type: 'number', minimum: 0, maximum: 600, description: 'Wait this long for Chrono (default 120)' },
      },
      required: ['design_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'mech_get_results',
    description:
      'The results of a design\'s run, per part (simulated vs expected speed, mass and its source), per joint ' +
      '(reaction force and torque), per gear (tooth force of the ideal constraint), per motor (effort) and the ' +
      'system checks. Simulated with rigid bodies, not measured.' + MECH_STATUS,
    inputSchema: {
      type: 'object',
      properties: { design_id: { type: 'string' }, sim_id: { type: 'string' } },
      required: ['design_id', 'sim_id'],
      additionalProperties: false,
    },
  },
];

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
        gateway_files: { type: 'array', items: { type: 'string' }, description: 'Files the gateway has: jobs/<job id>/out/model.stl, sim/files/…' },
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
      'line width, gear backlash from the centre distance of declared gear pairs, or, with sim_id, collisions and the ' +
      'smallest gap through a motion run.' + ENG_STATUS,
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
        sim_id: { type: 'string', description: 'A finished motion run of this model: check the parts through the motion' },
        bodies: { type: 'object', additionalProperties: { type: 'string' }, description: '{component: sim body} (default: same ids)' },
        frames: { type: 'integer', minimum: 2, maximum: 500 },
      },
      required: ['model_id'],
      additionalProperties: false,
      $defs: ENG_DEFS,
    },
  },
  {
    name: 'configure_motion_simulation',
    description:
      'Set up a Project Chrono simulation of the model: every component a rigid body placed as in the model (mass ' +
      'properties from its closed mesh and the density or mass given; printed parts depend on infill, so ask), the ' +
      'joints the user confirmed in analyze_assembly (or `joints` here, in sim_guide\'s format over component ids), ' +
      'motors, loads and simulation settings (see sim_guide). Returns mechanism_id and the validation. Rigid bodies: ' +
      'no bending or breaking is predicted.',
    inputSchema: {
      type: 'object',
      properties: {
        ...modelRef,
        components: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: {
              fixed: { type: 'boolean' },
              density_kg_m3: { type: 'number' },
              mass_kg: { type: 'number' },
              collision: { type: 'boolean' },
              material: { type: 'object' },
            },
          },
        },
        joints: { type: 'array', items: { $ref: '#/$defs/joint' } },
        actuators: { type: 'array', items: { $ref: '#/$defs/actuator' } },
        forces: { type: 'array', items: { $ref: '#/$defs/force' } },
        simulation: { $ref: '#/$defs/simulation' },
        assumed_density_kg_m3: { type: 'number', description: 'Only when the user accepts an assumed density: listed as an assumption with its effect' },
        name: { type: 'string' },
      },
      required: ['model_id', 'simulation'],
      additionalProperties: false,
      $defs: MECHANISM_DEFS,
    },
  },
  {
    name: 'run_motion_simulation',
    description:
      'Run a configured motion simulation in Chrono (or collect a run with sim_id): the checks against theory (motor ' +
      'laws, gear ratios, constraint violation), the per-joint ranges and reactions, and a collision sweep of the ' +
      'moving parts through the motion. Video: visualize_results_in_blender mode "motion".' + ENG_STATUS,
    inputSchema: {
      type: 'object',
      properties: {
        ...modelRef,
        mechanism_id: { type: 'string' },
        sim_id: { type: 'string', description: 'Collect a run already started' },
        simulation: { type: 'object', description: 'Overrides for this run (duration, time_step…)' },
        wait_s: { type: 'number', minimum: 0, maximum: 600 },
        check_clearance: { type: 'boolean', description: 'Sweep the parts for collisions (default true)' },
        frames: { type: 'integer', minimum: 2, maximum: 500 },
      },
      required: ['model_id'],
      additionalProperties: false,
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
      'errors, assembly, fits, motion, FEA, printability, assumptions and missing data, recommendations, confidence. ' +
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
      'deformed part, from a finished FEA), "interference" (overlaps in red), "thickness" (walls coloured by ' +
      'thickness), "motion" (renders a motion run\'s playback video).',
    inputSchema: {
      type: 'object',
      properties: {
        ...modelRef,
        mode: { enum: ['fea', 'interference', 'thickness', 'motion'] },
        analysis_id: { type: 'string', description: 'fea: the FEA analysis' },
        sim_id: { type: 'string', description: 'motion: the run' },
        print: { $ref: '#/$defs/print' },
        deformation_scale: { type: 'number' },
      },
      required: ['model_id', 'mode'],
      additionalProperties: false,
      $defs: ENG_DEFS,
    },
  },
];

// Interactive simulation (docs/interactive-physics.md): a live Chrono session the user drags and pushes in the
// dashboard while it runs. Everything is SI: m, kg, s, rad, N, N·m, positions and vectors in the world (Z up).
const sessionId = { type: 'string', description: 'From sim_start_interactive' };
const LIVE_TOOLS = [
  {
    name: 'sim_start_interactive',
    description:
      'Start a live simulation: Chrono keeps running in real time (when it can: the state says behind and the ' +
      'real-time factor otherwise) and the user acts on it in the dashboard (tab ⚙️ Mô phỏng: drag bodies with the ' +
      'mouse, push them, change motors and gravity), or you do with sim_control_interactive and sim_act_interactive. ' +
      'From a stored mechanism (mechanism_id), a run as it ran (sim_id), an example (drop_box, motor_shaft, pendulum, ' +
      "gear_pair, gear_contact) or a mechanism in sim_guide's format. Returns session_id, the bodies (which are " +
      'fixed or held by joints), the motors with their SI units, and the state. Tell the user to open the dashboard ' +
      'tab to interact; for full results and a video, run the same mechanism with sim_run_simulation.',
    inputSchema: {
      type: 'object',
      properties: {
        mechanism_id: { type: 'string' },
        sim_id: { type: 'string', description: 'A run: its model exactly as it ran (meshes that collide need this)' },
        example: { type: 'string', enum: ['drop_box', 'motor_shaft', 'pendulum', 'gear_pair', 'gear_contact'] },
        mechanism: { type: 'object', description: 'A mechanism (sim_guide)' },
        paused: { type: 'boolean', description: 'Start paused (default: running)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sim_control_interactive',
    description:
      "Control a live session's time: pause, resume, step (count steps of its fixed time step, then paused), reset " +
      '(to the start; overrides changes the initial conditions for this reset: gravity [m/s²], friction ' +
      '{body: μ}, position {body: [m]} or velocity {body: [m/s]} of free bodies), or speed (value: 0.01–100 × real time).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: sessionId,
        action: { type: 'string', enum: ['pause', 'resume', 'step', 'reset', 'speed'] },
        count: { type: 'integer', minimum: 1, maximum: 100000 },
        value: { type: 'number' },
        overrides: { type: 'object' },
      },
      required: ['session_id', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'sim_act_interactive',
    description:
      'Act on a live session while it runs, through Chrono (joints, motors and contacts still apply): push (force ' +
      '[N] on body, at point [m] or its centre of mass, for duration s, default 0.1), twist (torque [N·m]), motor ' +
      '(id, value in its SI unit: rad/s, rad, N·m, m/s, m or N; enabled true/false), gravity (vector [m/s²]), spring ' +
      '(id, stiffness, damping), drag (body, point grabbed [m], target [m]: a hand pulling that point with a finite ' +
      'force; then release), teleport (a body no joint holds to position [m], velocity zeroed: not physical), select ' +
      '(the body whose mass, velocity, contact and applied forces the state then shows).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: sessionId,
        action: { type: 'string', enum: ['push', 'twist', 'motor', 'gravity', 'spring', 'drag', 'release', 'teleport', 'select'] },
        body: { type: 'string' },
        id: { type: 'string', description: 'motor or spring id' },
        force: vec3,
        torque: vec3,
        point: vec3,
        target: vec3,
        position: vec3,
        vector: vec3,
        duration: { type: 'number' },
        value: { type: 'number' },
        enabled: { type: 'boolean' },
        stiffness: { type: 'number' },
        damping: { type: 'number' },
      },
      required: ['session_id', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'sim_get_live_state',
    description:
      "A live session's latest state: time, running, real-time factor (behind when it cannot keep up), contacts, " +
      "gravity, each body's position, each motor's coordinate, rate and effort, the drag and the selected body. " +
      'One snapshot: do not poll it in a loop; the dashboard streams it to the user.',
    inputSchema: { type: 'object', properties: { session_id: sessionId }, required: ['session_id'], additionalProperties: false },
  },
  {
    name: 'sim_stop_interactive',
    description: 'End a live session (it also ends by itself after 10 minutes nobody watches or acts on it).',
    inputSchema: { type: 'object', properties: { session_id: sessionId }, required: ['session_id'], additionalProperties: false },
  },
];

/** A live state for the agent: body positions in mm next to the SI rest */
function liveSummary(state) {
  if (!state) return state;
  const mm = (v) => v.map((x) => Math.round(x * 1e5) / 100);
  return {
    t_s: Math.round(state.t * 1e6) / 1e6,
    running: state.running,
    failed: state.failed,
    real_time_factor: state.rtf,
    behind_real_time: state.behind,
    contacts: state.contacts,
    gravity: state.gravity,
    bodies_mm: Object.fromEntries(Object.entries(state.bodies).map(([id, b]) => [id, mm(b.p)])),
    motors: state.motors,
    drag: state.drag,
    selected: state.selected,
  };
}

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
  ...LIVE_TOOLS,
  ...ENG_TOOLS,
  ...MECH_TOOLS,
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

/** An /api/mech answer; a refusal carries its diagnostics and missing data, for the agent to fix or ask about */
async function mechJson(method, route, body) {
  const res = await gateway(method, `/api/mech/${route}`, body, 12 * 60 * 1000);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    const details = data?.details ? `\n${JSON.stringify(data.details, null, 2)}` : '';
    throw new GatewayError(`${data?.message || `Gateway answered HTTP ${res.status} for /api/mech/${route}.`}${details}`);
  }
  const { success, ...rest } = data;
  return rest;
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
    case 'sim_start_interactive': {
      const started = await simJson('POST', '/api/sim/live', args);
      const { scene } = started;
      return [text({
        session_id: started.session_id,
        name: scene.name,
        time_step_s: scene.time_step,
        bodies: scene.bodies.map((b) => ({ id: b.id, name: b.name, fixed: b.fixed, held_by_joint: b.held, mass_kg: b.mass })),
        motors: scene.motors.map((m) => ({ id: m.id, type: m.type, mode: m.mode, unit: m.unit })),
        warnings: scene.warnings,
        assumptions: scene.assumptions,
        state: liveSummary(started.state),
        next: 'Ask the user to open the dashboard, tab ⚙️ Mô phỏng: the session shows there (drag with the left mouse button).',
      })];
    }
    case 'sim_control_interactive':
    case 'sim_act_interactive': {
      const { session_id: sid, ...action } = args;
      const done = await simJson('POST', `/api/sim/live/${encodeURIComponent(sid)}/actions`, action);
      return [text({ t_s: Math.round(done.t * 1e6) / 1e6, state: liveSummary(done.state) })];
    }
    case 'sim_get_live_state': {
      const { state } = await simJson('GET', `/api/sim/live/${encodeURIComponent(args.session_id)}/state`);
      return [text(liveSummary(state))];
    }
    case 'sim_stop_interactive':
      await simJson('POST', `/api/sim/live/${encodeURIComponent(args.session_id)}/stop`, {});
      return [text({ stopped: args.session_id })];
    case 'mech_guide': {
      const res = await gateway('GET', '/api/mech/guide');
      if (!res.ok) throw new GatewayError(`Gateway answered HTTP ${res.status} for the mechanical model guide.`);
      return [text(await res.text())];
    }
    case 'mech_create_design':
      return [text(await mechJson('POST', 'designs', args))];
    case 'mech_import_model':
      return [text(await mechJson('POST', 'import', args))];
    case 'mech_update_design': {
      const { design_id: designId, ...body } = args;
      return [text(await mechJson('POST', `designs/${encodeURIComponent(designId)}`, body))];
    }
    case 'mech_validate':
      return [text(await mechJson('POST', `designs/${encodeURIComponent(args.design_id)}/validate`, { revision: args.revision }))];
    case 'mech_get_design': {
      if (!args.design_id) return [text(await mechJson('GET', 'designs'))];
      const query = args.revision ? `?revision=${args.revision}` : '';
      return [text(await mechJson('GET', `designs/${encodeURIComponent(args.design_id)}${query}`))];
    }
    case 'mech_propose_repairs':
      return [text(await mechJson('POST', `designs/${encodeURIComponent(args.design_id)}/repairs`, { revision: args.revision }))];
    case 'mech_apply_repairs': {
      const { design_id: designId, ...body } = args;
      return [text(await mechJson('POST', `designs/${encodeURIComponent(designId)}/apply`, body))];
    }
    case 'mech_simulate': {
      const { design_id: designId, ...body } = args;
      const out = await mechJson('POST', `designs/${encodeURIComponent(designId)}/simulate`, body);
      if (out.state === 'completed') out.next = 'sim_play_simulation_in_blender with this sim_id to watch it';
      else if (['queued', 'running'].includes(out.state)) out.next = 'Still running: check with mech_get_results.';
      return [text(out)];
    }
    case 'mech_get_results':
      return [text(await mechJson('GET', `designs/${encodeURIComponent(args.design_id)}/runs/${encodeURIComponent(args.sim_id)}`))];
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
    case 'configure_motion_simulation':
      return [text(await engJson('POST', 'motion/configure', args))];
    case 'run_motion_simulation':
      return [text(engResult((await engJson('POST', 'motion/run', args)).result))];
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
          'Design 3D-printable models for the Bambu Lab H2D. Technical parts: call cad_guide once, write build123d code, call ' +
          'cad_build and check the preview. Characters and other organic shapes: cad_make_figure, then cad_fix_figure ' +
          'when the preview shows problems. Send the accepted ' +
          'model with cad_send_to_studio. Mechanisms (linkages, gears, motors, springs): call sim_guide once, describe ' +
          'the mechanism with sim_create_mechanism (and sim_add_*), sim_run_simulation (Project Chrono, on this ' +
          'computer), sim_get_simulation_results, then sim_play_simulation_in_blender. To let the user act on a mechanism ' +
          'while it runs (drag, push, change motors), sim_start_interactive and point them to the dashboard. ' +
          'Engineering checks of a printed ' +
          'part or assembly (local, no cloud): inspect_3d_model, validate_mesh, analyze_assembly (confirm joints with ' +
          'the user), check_clearance, configure/run_motion_simulation, configure/run_fea_analysis, ' +
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
