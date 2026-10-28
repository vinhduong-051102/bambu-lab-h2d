# Mechanical model: parts, assembly, joints, physics (Mô hình cơ khí)

A layer that turns either a design request or an imported CAD/3D assembly into a **mechanical model**: parts with
stable ids, geometry, transforms, materials and mass properties with their provenance; joints, gear pairs, motors and
loads; then checks it (frames, joint closure, degrees of freedom, redundant and conflicting constraints, motion
paths, gears, interference), compiles it for Project Chrono through the existing `sim` package, runs it, and reports
results per part and per joint against what kinematics predicts. It builds on what was there; nothing is replaced.

## 1. Audit (2026-10-29)

Read first: `docs/mechanical-simulation.md`, `docs/engineering-analysis.md`, `docs/interactive-physics.md`,
`docs/cad.md`. Test suites run in this environment on 2026-10-29 (results below are from these runs).

| Capability | Where | Status |
|---|---|---|
| Mechanism JSON (bodies, joints fixed/revolute/prismatic/spherical/cylindrical/distance/gear, motors, forces, springs), SI conversion, assumptions | `mesh3d/sim/schema.py` | Implemented and verified (`test_schema`, 29 tests, OK) |
| Chrono offline runs: rigid bodies, ideal gears, tooth-contact gears, NSC/SMC contacts, checks against theory | `mesh3d/sim/chrono_run.py`, `runs.py` | Implemented and verified (`test_chrono` 10, `test_runs` 11, OK) |
| Interactive Chrono sessions with a three.js viewer, actions, SSE | `mesh3d/sim/live.py`, `/api/sim/live/*` | Implemented and verified (`test_live`, OK) — added by another session |
| Blender replay of a run (keyframes, self-check, .blend, MP4) | `mesh3d/sim/playback.py` | Implemented and verified (`test_runs`) |
| Planar, belt/pulley, rack-and-pinion, screw joints | Chrono 10 has `ChLinkLockPlanar`, `ChLinkLockPulley`, `ChLinkMateRackPinion`, `ChLinkLockScrew` | **Supported by the engine, missing in the mechanism schema** (not wired) |
| Flexible bodies, thermal, fluid | — | Unsupported in the current configuration (no FEA-in-the-loop, no CFD); not claimed |
| Static FEA of one part (gmsh + CalculiX) | `mesh3d/eng/fea.py` | Implemented and verified (`test_eng`: cantilever within 1 % of Timoshenko) |
| Import STL/OBJ/PLY/GLB/glTF (node names and transforms), 3MF (objects, build transforms, unit), .blend | `mesh3d/eng/geometry.py` | Implemented and verified (`test_eng`) |
| STEP/IGES → one STL per solid | CAD container, `cad/convert.py`, `/api/cad/convert` | Implemented and verified (`cad` tests, OK) — added by the second account |
| Hole/shaft detection, coaxial pairs, suggested joints, fits, walls, printability | `mesh3d/eng/assembly.py`, `clearance.py`, `printability.py` | Implemented and verified (`test_eng`) |
| Parametric CAD (build123d, OpenCascade) driven by Claude | CAD container | Implemented and verified (`cad` tests); produces one solid per job, not an assembly |
| A part/assembly model with stable part ids, provenance and confidence | — | **Missing** |
| Rigid groups (gear fixed on a shaft) as one body; DOF from the constraint Jacobian; redundant/conflicting constraint diagnosis; motion paths; kinematic prediction | — | **Missing** (`sim` has Grübler's count as a hint only) |
| Per-part results linked to parts and joints, expected vs simulated | — | **Partially** (per body/joint summary exists in `sim`, no part mapping or kinematic expectation) |
| Natural language → mechanism | MCP: the agent writes `sim` JSON itself | **Partially** (no part/assembly structure, no geometry per part) |
| Design revisions, repair proposals | — | **Missing** |

Engines in the image: PyChrono 10.0.0 (`/opt/chrono`), Blender 4.5.5, gmsh 4.15.2 + CalculiX 2.23 (`/opt/fea`),
trimesh + manifold3d + pymeshlab + Embree (worker Python), build123d/OCP (CAD container). No new engine is needed.

**CAD kernel.** The CAD container already has OpenCascade through build123d (solids, booleans, STEP in/out,
parametric features), and FreeCAD would only add a second backend. The mechanical model therefore takes its
parametric part geometry from simple generators (shafts, involute gears, plates, links, blocks) for simulation and
from the CAD container for printable parts; imported STEP goes through `/api/cad/convert`.

## 2. Architecture

```
 Claude (MCP: mech_* tools)          dashboard (⚙️ Mô phỏng)
        │                                   │
   gateway /api/mech/*  ── pass-through ──► mesh3d worker /mech/*            (mesh3d/mech/service.py)
        │
        ├─ model.py        Mechanical Model Schema (mech/1): parts, joints, gears, motors, loads, provenance
        ├─ shapes.py       parametric part geometry (shaft, gear, plate, link, block) → meshes and mass properties
        ├─ importer.py     eng model (STL/3MF/GLB/glTF/.blend, STEP via CAD) → draft model + hypotheses
        ├─ kinematics.py   frames, rigid groups, constraint Jacobian, DOF, redundancy, conflicts, motion paths,
        │                  kinematic position/velocity solution (the expectation)
        ├─ chrono_adapter.py  capability table, model → sim mechanism (schema v1) → existing Chrono pipeline
        ├─ results.py      sim run → per-part / per-joint results, expected vs simulated
        ├─ repair.py       diagnostics → proposals (geometry / assembly / simulation), new revision on approval
        └─ service.py      designs/<id>/r<n>/ (input.json, model.json, validation.json, revision.json, runs/<sim>.json);
                           part meshes for the viewer in sim/files/mech/<id>/r<n>/
                     │
                     ▼
        mesh3d/sim (unchanged API): schema → chrono_run (PyChrono) → results → Blender playback / live viewer
```

The `sim_*` and `eng` tools and routes stay as they are; `mech_*` sits above them.

## 3. The Mechanical Model Schema (mech/1)

The full field list is in `mesh3d/mech/guide.md` (what the agent reads through `mech_guide`); the code is
`mesh3d/mech/model.py`. In short:

```json
{
  "schema": "mech/1", "name": "…", "request": "the user's words (optional)",
  "units": { "length": "mm", "angle": "deg" },
  "parts":  [{ "id", "name", "role", "fixed", "shape" | "geometry_file", "position", "orientation", "material",
               "mass", "center_of_mass", "inertia" }],
  "joints": [{ "id", "type", "part_a", "part_b", "position", "axis", "limits" }],
  "gears":  [{ "id", "gear_a", "gear_b", "internal", "model" }],
  "motors": [{ "id", "joint", "speed_rpm", "ramp_s" } | { "id", "joint", "mode", "law" }],
  "loads":  [{ "id", "type": "torque" | "force" | "spring_damper" | "rotational_spring_damper", "part", … }],
  "simulation": { "duration", "time_step", "gravity", … }
}
```

- Part shapes: `shaft`, `gear` (involute spur, with bore), `box`, `link` (round ends, holes), `sphere`; or a mesh
  (`geometry_file`) from an imported model.
- **Provenance.** After `normalise()` every physical value is `{"value", "source", "unit", "note"}` with source
  `user`, `imported_cad`, `geometry` (computed from the mesh), `material_database` (a named material's nominal
  density), `solver`, `assumption` or `unknown`. A value nobody gave stays unknown and is listed in `missing`.
- **Statuses** everywhere: `passed`, `warning`, `failed`, `not_verified`.
- **Revisions.** A design is `d-YYYYMMDD-HHMMSS-xxxx`; every change (by hand or an approved repair) writes `r<n+1>`
  with `revision.json` (note, parent). Nothing is overwritten.

## 4. Assembly engine (`kinematics.py`)

1. Places every part (shape built in its frame, then `position`/`orientation`), computes mass properties from the
   mesh and density, or takes the given mass, centre of mass and inertia.
2. Merges parts joined by fixed joints into **rigid groups** (union-find); fixed parts form `ground`.
3. Builds the **constraint Jacobian** of all joints, ideal gear rows (N_a(dθ_a−dθ_c)·n + s·N_b(dθ_b−dθ_c)·n about
   the common carrier) and motor rows. DOF = 6n − rank. Redundant equations are found by incremental rank and
   attributed to joints; a motor whose row adds no rank drives a locked coordinate.
4. Diagnostics: `JOINT_INSIDE_RIGID_GROUP`, `MOTOR_ON_LOCKED_PAIR`, `MOTOR_DRIVES_LOCKED_COORDINATE`,
   `MOTORS_CONFLICT`, `UNDRIVEN_DOF`, `NO_MOBILITY`, `REDUNDANT_CONSTRAINTS`, `MASS_UNKNOWN`,
   `JOINT_AWAY_FROM_PART`, `JOINT_NOT_AT_HOLE`, `AXIS_MISALIGNED`, `GEAR_NO_COMMON_CARRIER`, `GEAR_MODULE_MISMATCH`,
   `GEAR_CENTER_DISTANCE`, `GEAR_MESH_OK`, `PARTS_OVERLAP`, plus the Chrono capability check (`UNSUPPORTED_JOINT`,
   `UNSUPPORTED_GEAR`). Each names its parts and joints.
5. The **kinematic prediction**: a least-squares velocity solution (every group's rpm and speed) and, for a linkage
   with one rotary motor, a Newton position sweep over a turn. Dynamics are compared against it.

## 5. Chrono adapter (`chrono_adapter.py`)

A capability table (`/api/mech/capabilities`) says what is supported, unsupported or engine-only. `compile_model`
turns each rigid group into one `sim` body at the world origin with explicit mass, centre of mass and inertia and a
visual mesh; joints, gears (the carrier is body_a), motors and loads map onto the existing `sim` schema v1, so the
Chrono run, its checks, the Blender playback and the live viewer are the existing ones. When the model has
redundant equations, the run uses the MINRES solver (stated as an assumption in the run): with the default
iterative solver a crank-slider drifted 6.6 µm, with MINRES 0.1 µm.

## 6. Results (`results.py`)

Per part: steady and maximum rpm, the motion **of the part's own centre of mass** (path length, displacement,
maximum and steady speed; a group's body frame sits at the world origin, so its own path says nothing about a shaft
turning in place), and the expected rpm. Per joint: coordinate range and maximum reaction force and torque. Per gear
pair: the steady and maximum force of the ideal gear constraint (labelled as such, not a tooth stress). Per motor:
its steady effort. Checks: the run's own (finite values, constraint drift, motor law, gear ratios), each part
turning on a bearing against the kinematic rpm (1 %), and slider positions against the kinematic sweep (0.1 mm).

## 7. Repair loop (`repair.py`)

`mech_propose_repairs` lists proposals: remove a fixed joint or unfix a part (locked conflicts), move gear b's group
to the right centre distance (geometry), move a joint onto its axis (misaligned), data the user must give (changes
`null`), and solver advice for redundancy. Nothing changes until `mech_apply_repairs` with `approved: true`, which
writes a new revision and returns the validation before and after. At most 5 automatic repair rounds per design;
then it stops and asks for a person.

## 8. API and MCP

Gateway (`src/api/routes/mech.ts`, pass-through to the mesh3d worker, whitelisted paths, 12 min timeout):

| Route | What |
|---|---|
| `GET /api/mech/guide` · `/capabilities` · `/designs` | Agent guide (markdown), capability table, designs list |
| `GET /api/mech/designs/:id[?revision=n]` | Revisions, model, validation, runs |
| `GET /api/mech/designs/:id/runs/:sim_id` | Results per part/joint/gear/motor |
| `POST /api/mech/designs` `{model, note}` | Revision 1 + validation |
| `POST /api/mech/import` `{model_id, version, fixed, materials, accept}` | From an `eng` model (CAD import) |
| `POST /api/mech/designs/:id` `{changes, note}` | New revision |
| `POST /api/mech/designs/:id/validate` · `/repairs` | Validation · proposals |
| `POST /api/mech/designs/:id/apply` `{proposal_ids, approved}` | Approved repair → new revision |
| `POST /api/mech/designs/:id/simulate` `{revision, simulation, wait_s}` | Chrono run (refused, 422, when invalid) |

MCP (`cad/mcp/server.mjs`), group **Design**: `mech_guide`, `mech_create_design`, `mech_import_model`,
`mech_update_design`, `mech_get_design`; **Assembly**: `mech_validate`, `mech_propose_repairs`,
`mech_apply_repairs`; **Simulation**: `mech_simulate`, `mech_get_results`, then the existing
`sim_play_simulation_in_blender` / `sim_start_interactive` with the run's `sim_id`. The `sim_*` and `eng` tools are
unchanged. Dashboard: ⚙️ Mô phỏng → 🧩 Thiết kế cơ khí (revisions, diagnostics, parts with provenance, approve
repairs, results per part; a run opens below for charts and Blender).

## 9. Tests and actual results (2026-10-29)

`mesh3d/mech/tests/test_mech.py`, run in the mesh3d container: **10 tests, OK**.

| Test | What it shows | Result |
|---|---|---|
| A crank-slider r 30, L 100 | DOF 1, 3 redundant equations, driven 0; kinematic slider position vs r·cos θ + √(L² − r² sin² θ) | error ~1e-11 mm; Chrono stroke 60.0003 mm, worst position error 0.013 mm (tolerance 0.1), crank 60 rpm |
| B two-stage gearbox 20/40 · 18/45, 1500 rpm, 2 N·m on output | groups, DOF 1, speeds, motor torque, gear forces T/r | 1500 / 750 / 300 rpm, motor 0.400 N·m, gear forces 20.0 N and 35.556 N (by hand: 20 N, 35.56 N); shaft centres move < 0.01 mm |
| C GLB hinge (named nodes) | parts keep names and placement; hole/pin → probable revolute, a joint only when accepted; swings in Chrono | OK |
| D invalid | shaft keyed to housing and driven → `MOTOR_ON_LOCKED_PAIR`, refused before a run; gears 10 mm too far → `GEAR_CENTER_DISTANCE`, repair approved → r2 passes; pivot off its hole → `JOINT_NOT_AT_HOLE` | OK |
| E missing data | no material, no motor law, no simulation settings → listed, run refused, nothing filled in | OK |
| F words → results | request → spec → parts → assembly → validation → Chrono → per-part results → Blender playback checked | OK |

Live, through the MCP server against the running gateway (2026-10-29): the gearbox request → `mech_create_design`
(passed, DOF 1) → `mech_simulate` (completed, every check passed: 1500.000 / 750.000 / 300.000 rpm, 0.400 N·m,
20.0 N / 35.556 N) → `mech_get_results` → `sim_play_simulation_in_blender` (31 frames, position error 0 mm, joint
angle error ≤ 0.0055°). A broken copy (output stage 10 mm off, input shaft also welded to the housing) → failed with
`JOINT_INSIDE_RIGID_GROUP`, `MOTOR_ON_LOCKED_PAIR`, `GEAR_NO_COMMON_CARRIER`, `GEAR_CENTER_DISTANCE`; simulate
refused; apply without approval refused; approved proposals → r2 passed → simulated, output 300.000 rpm.

Other suites on the same day: `sim` schema 29, chrono 10, runs 11, live 19; `eng` 26; `cad` 22; gateway vitest
35 files / 424 tests: all OK.

Example artifacts: `mesh3d/mech/examples/crank_slider.json`, `gearbox_two_stage.json`.

## 10. Limitations (not claimed)

- Rigid bodies only: no stress, deflection or fatigue in the mechanism run (use the `eng` FEA per part); gear forces
  are ideal-constraint reactions, not tooth contact stresses. A gear pair with `"model": "contact"` is passed to the
  `sim` tooth-contact model with the data given, but only ideal gears are covered by the `mech` tests.
- Not wired: planar joints, belts/pulleys, rack-and-pinion, screws (Chrono 10 has them), internal gears. Flexible
  bodies, thermal and fluid are unsupported.
- Part shapes are simple generators (shaft, spur gear, box, link, sphere); printable CAD parts come from the CAD
  container, imported meshes through `eng`. No helical or bevel gears.
- Imported assemblies: joints are hypotheses from geometry (coaxial hole/shaft, touching faces) and need the user's
  confirmation; no mates are read from STEP.
- Kinematic position sweep only for a single rotary motor driving a linkage with sliders.
- Repairs cover locked conflicts, gear centre distance and misaligned joints; other problems are reported for a
  person to fix.
