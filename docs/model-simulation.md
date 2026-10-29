# Simulating a 3D model as it is (Mô phỏng chính mô hình 3D)

The 3D model the user had Claude design, or imported, is simulated directly: its own components, set up once, run
in the dashboard's 3D viewer with Project Chrono, each component picked to see its data and how it moves. There is
no second model to draw. Built on what was there: the CAD jobs, the engineering models (`eng`), the mechanical
model (`mech`, docs/mechanical-model.md) and the live Chrono viewer (docs/interactive-physics.md).

## 1. Audit (2026-10-29)

| Piece | Before | Where |
|---|---|---|
| AI model creation | Claude writes build123d `model.py`; `result` (one solid or a Compound) exported as **one** `model.stl` + STEP + preview PNG. Parts of an assembly were merged | `cad/build.py`, `cad/worker.py`, `cad/guide.md` |
| CAD import | STL/3MF/OBJ/PLY/GLB/glTF/.blend read into a versioned engineering model (`eng/models/<id>/v<n>`), one component per object/node with its name and transform; STEP via `/api/cad/convert` | `mesh3d/eng/geometry.py`, `eng/store.py` |
| Model versions | A job's model is `job-<job id>` in eng, a new version per import; a design job's revision is a new job (`parent_id`) | `eng/service.job_model_id` |
| 3D viewer | The CAD tab shows a static preview PNG. The only interactive 3D viewer is the live Chrono viewer (three.js, real Chrono state streamed by SSE, pause/resume/step/reset/speed, pick, drag), which ran `sim` mechanisms only | `src/ui/sim/SimLive.tsx`, `mesh3d/sim/live.py` |
| Physics | Chrono offline runs + Blender replay, live sessions; mech designs (parts, joints, DOF, revisions) compiled to `sim`. A mech design had to be written as a new model | `mesh3d/sim`, `mesh3d/mech` |
| Per-component hierarchy | Kept by eng for files that have it; lost in CAD jobs (one STL); a live body drawn as one mesh | — |

Decision: no new editor or viewer. The CAD build keeps parts; eng stays the model and its versions; mech is its
simulation setup (one design per model, one revision per change); the live viewer draws components.

## 2. How it fits

```
 CAD job (Claude, model.py: components + mechanism)        imported file (STL/3MF/GLB/…)
        │ build.py: components/<name>.stl, assembly.json             │ /api/eng/inspect
        ▼                                                             ▼
 eng model job-<id> v1, v2…  ◄──── one version per changed geometry ── eng model m-… v1…
        │ POST /api/mech/models/setup {job_id | model_id}
        ▼
 mech design d-… r1, r2…  (parts = components, joints declared / confirmed, motors, materials; provenance)
        │ GET /api/mech/models/<id> → state         POST /api/mech/designs/<id>/live
        ▼                                                     │ worker compiles (refused if invalid)
 state: NOT_CONFIGURED · NEEDS_VALIDATION · INVALID · READY ·  ▼
        RUNNING · PAUSED · COMPLETED · FAILED          sim-live session (Chrono, real time) ──SSE──► SimLive viewer
                                                          origin {design_id, revision}            per-part meshes,
 recorded run: POST designs/<id>/simulate → results per part, Blender replay (sim)                  inspector
```

- **Mapping.** A rigid group (parts joined by fixed joints) is one Chrono body; its `visual.parts` lists each
  component's mesh, so the viewer draws and picks components while the body moves as one. The viewer gets, per
  part: its body, its point (centre of mass), its joints, mass/inertia with their source, and the kinematic speed.
- **Where a part is.** Every pose drawn is Chrono's (body position and quaternion streamed by the session). A part's
  centre, displacement and speed are computed from its body's pose, velocity and angular velocity
  (`src/ui/modelSim.js`, tested); nothing is animated from a script.
- **Contact.** A part with `collision: true` needs a `friction` (asked for, never assumed); its group's convex hull
  is computed in the mesh worker and sent with the mechanism, because the live container has no trimesh.
- **Time.** Physics step = the design's `time_step`; the session steps against the wall clock (×speed) and drops
  what it cannot do, reporting the real-time factor; the viewer draws at the browser's frame rate from the latest
  state (≤ 30 Hz stream); simulation time `t` is shown. Chrono runs in its own container: the page never blocks.

## 3. States (read from stored data, never from the page)

| State | When |
|---|---|
| NOT_CONFIGURED | No setup for this model |
| NEEDS_VALIDATION | The model has a newer version than the setup (old results belong to the old revision), or the revision was never checked |
| INVALID | Validation failed: the reason (diagnostics naming parts and joints, missing data, malformed fields) |
| READY | Valid; no recorded run for this revision |
| RUNNING / PAUSED | A live session of **this** revision is open and running / paused (the gateway asks sim-live); a session of an older revision is listed as `live_stale` |
| COMPLETED / FAILED | The latest recorded run of this revision finished / failed (RUNNING while it runs) |

Each revision keeps its runs; `runs[].current` says whether a run belongs to the revision shown. Changing the
model (a revised job, a new import version) and calling setup again carries the setup over by component id: new
components arrive unconfigured, removed ones are dropped with their joints, the note says which.

## 4. Using it

- **Dashboard, AI model:** ✨ Thiết kế AI → a finished job → **⚙️ Mô phỏng**. The state and why; *Chuẩn bị mô
  phỏng* (first time) or *Cập nhật cấu hình cho v<n>*; *Cấu hình vật lý*: role, fixed, material, mass, collision and
  friction per part; joints (declared by the design, confirmed by the user, or suggested by the geometry with their
  confidence — a suggestion is used only after *Xác nhận*); motor speed and ramp per revolute joint; time step,
  duration, gravity. *Lưu* = a new revision, checked. **Simulate** opens the viewer in place: Tạm dừng/Chạy, 1 bước,
  +10 ms, Reset, speed ×0.1–×5, *Mô hình gốc* (the model as made, faint, beside the moving one), click a component
  for its id, geometry, material, mass and inertia with their source, joints, displacement and speed of its centre
  (with a short history), rpm against the kinematic value, and its results from the latest recorded run. The joints
  table lists each joint's type, parts, DOF and checks. *Chạy ghi kết quả* = a recorded run (results per part,
  checks, Blender replay).
- **Dashboard, imported model:** ⚙️ Mô phỏng → 📦 Mô hình 3D đã nhập → *Nhập mô hình* (STL, 3MF, OBJ, PLY, GLB/glTF),
  then the same panel.
- **Claude (MCP):** `cad_ask_claude` (the CAD guide tells it to keep `components` and declare `mechanism` for a
  mechanism, never inventing speeds, loads or masses) → `mech_import_model {job_id}` → `mech_update_design` for one
  value → `mech_simulate {live: true}` (then `sim_get_live_state`, `sim_control_interactive`) or a recorded run →
  `mech_get_design {model_id}` for the state. No new tool: the existing ones gained `job_id`, `model_id` and `live`.

## 5. API

| Route | What |
|---|---|
| `POST /api/mech/models/setup` `{job_id}` or `{model_id, fixed?, materials?, accept?}` | The model's setup (created, or carried to the model's new version) → its state |
| `GET /api/mech/models/:model_id` | State, reason, design and revision, validation, hypotheses, runs per revision, live session |
| `GET /api/mech/designs/:id/viewer[?revision]` | The compiled mechanism and per-part/per-joint data (422 when invalid) |
| `POST /api/mech/designs/:id/live` `{revision?, paused?, simulation?}` | Opens the revision in a live session (replacing this design's earlier one) → session, scene, parts, joints |

Unchanged and reused: `/api/sim/live/*` (state, stream, actions, meshes — part meshes as `mesh/<body>.part<k>`),
`/api/mech/designs/*`, `/api/eng/inspect`. The sim mechanism format gained two optional body fields:
`visual.parts` and `collision_hull`.

## 6. Tests and actual results (2026-10-29)

| Suite | Result |
|---|---|
| `mech/tests/test_model_sim.py` (job → setup, revisions keep their runs, contradicting joint refused, contact hull, friction asked) | 6 tests OK |
| `mech/tests/live_check.py` against the running containers | **18/18 checks passed** (below) |
| `cad/tests/test_assembly.py` (components in their assembled place, assembly.json, bad names refused, single part writes none) | 3 tests OK |
| `tests/mech.test.ts` (paths, state merged with live sessions, live start/refusal, part motion math) | 9 tests OK |
| Regression: sim schema 29, runs 11, chrono 10, live 19; eng 26; mech 10; cad 25; vitest 35 files / 430 tests | all OK |
| MCP end-to-end (gearbox, repairs with approval, Blender replay: 31 frames, 0 mm, ≤ 0.0055°) | unchanged, passes |

`live_check.py` (imported STL files, set up and edited through `/api/mech`, run in sim-live):

1. **Rigid body:** a plate and a 100 g block, no mass given at first → INVALID (nothing invented); with mass,
   collision and friction 0.5 → READY; the block falls (z 0 → −20.00 mm at t 0.23 s) and rests on the plate (2
   contacts, 0.00 mm/s); Reset (paused) → t 0, z 0.000 mm.
2. **Rotating component:** a PLA disk on a bearing, motor 60 rpm with a 0.2 s ramp → motor 60.0000 rpm and the disk
   60.0000 rpm from the solver; the model's state RUNNING, then PAUSED when paused.
3. **Crank-slider** (the CAD build of `mech/examples/crank_slider_cad.py`): READY, 1 DOF driven, each component on
   its body; the slider against r cos θ + √(L² − r² sin² θ) for the crank angle Chrono reports: worst error
   0.0003 mm over 41 states up to 843°, off-axis 0.00000 mm.
4. **Editing:** a recorded run of r2 (completed, passed); motor 60 → 30 rpm = r3, validated, READY; the r2 run is
   listed as not current, the open r2 session as stale.
5. **Invalid:** the crank welded to the frame and driven → status failed, the viewer refused (HTTP 422) with
   `JOINT_INSIDE_RIGID_GROUP` and `MOTOR_ON_LOCKED_PAIR` naming base, crank and weld; no session started; state INVALID.

**AI-made model, live (job 20261029-015927-e144):** asked "Create a mechanical assembly with a rotating shaft, two
gears and a connecting rod. Let me simulate the mechanism directly in the 3D viewport." Claude built six separate
components (base, shaft, gear_a 20T, gear_b 30T, rod, slider) with joints and the gear pair declared and **no motor
speed** (none was given). Setup: 1 DOF, INVALID only for the missing time step and duration. In the dashboard
(⚙️ Mô phỏng on the job): motor 30 rpm, step 0.5 ms, duration 3 s → r2 READY → Simulate: the mechanism runs in
the viewer; the solver reports gear A 30.0 rpm and gear B −20.0 rpm (20/30, opposite way). Through MCP:
`mech_import_model {job_id}` READY, `mech_simulate {live: true}` opened it, `mech_update_design` set 15 rpm → r3.

Found and fixed while testing: the importer crashed on a second touching pair; sim-live answers 201 for a new
session (the gateway expected 200); a run's status read while being rewritten lost its state; a role the schema
does not know (`connecting_rod` from Claude) stopped validation instead of being reported.

## 7. Limitations

- Rigid bodies only in the viewer and in recorded runs: no stress, strain or deformation. Strength is the separate
  FEA check (*Kiểm tra kỹ thuật*, `run_fea_analysis`) on the same model.
- Collision uses each colliding group's **convex hull**: a part with holes or slots collides as if filled. Gears
  mesh through ideal gear constraints, not tooth contact, in models set up here.
- Joint reactions and gear forces come from recorded runs (per part in the inspector after *Chạy ghi kết quả*); the
  live state gives positions, velocities, motor angle/speed/effort and contact forces.
- A single mesh is one part: the pieces of a merged STL are not guessed. Imported files keep the objects/nodes they
  have; STEP goes through `/api/cad/convert` (MCP) first — the dashboard upload takes STL/3MF/OBJ/PLY/GLB/glTF.
- One design per model. sim-live runs at most 2 sessions (SIM_LIVE_MAX_SESSIONS); opening a design replaces its own
  earlier session; idle sessions stop after 10 minutes.
- Joint hypotheses come from coaxial hole/shaft pairs and touching faces only; planar joints, belts, rack-and-pinion
  and screws are not wired (docs/mechanical-model.md §10).
- The joint editor takes position and axis as numbers; there is no gizmo to place a joint by dragging in the view.

## 8. Files

New: `mesh3d/mech/models.py`, `mesh3d/mech/tests/test_model_sim.py`, `mesh3d/mech/tests/live_check.py`,
`mesh3d/mech/examples/crank_slider_cad.py`, `cad/tests/test_assembly.py`, `src/ui/sim/ModelSim.tsx`,
`src/ui/modelSim.js`, `docs/model-simulation.md`.
Changed: `cad/build.py` (components, assembly.json), `cad/guide.md` (assemblies that move), `mesh3d/sim/schema.py`
(`visual.parts`, `collision_hull`; mesh properties skipped when mass, centre and inertia are given), `mesh3d/sim/runs.py`
(a given hull is kept), `mesh3d/sim/live.py` (origin, part meshes, initial pose, hull without trimesh),
`mesh3d/mech/chrono_adapter.py` (per-part meshes and colours, collision hull and friction), `mesh3d/mech/model.py`
(part `collision`, `friction`), `mesh3d/mech/service.py` (malformed revisions stored as failed, run status read
safely), `mesh3d/mech/importer.py` (contact hypotheses), `mesh3d/mech/tests/test_mech.py` (part meshes counted), `mesh3d/mech/guide.md`,
`mesh3d/worker.py` (routes), `src/api/routes/mech.ts` (models, viewer, live), `src/api/routes/simLive.ts` (`liveJson`),
`src/api/routeDocs.ts`, `src/ui/sim/SimLive.tsx` (parts, pick, inspect slot, original model), `src/ui/sim/MechCard.tsx`
(exports), `src/ui/sim/SimCard.tsx`, `src/ui/cad/CadJob.tsx` (⚙️ Mô phỏng), `cad/mcp/server.mjs` (`job_id`,
`model_id`, `live`), `tests/mech.test.ts`.
