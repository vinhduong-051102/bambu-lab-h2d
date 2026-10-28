# Mechanical simulation (Mô phỏng cơ cấu)

An agent describes a mechanism in JSON: bodies, joints, motors, springs. **Project Chrono** simulates it on this
computer, and **Blender** plays the motion back as an animation. Nothing goes to a cloud service or a paid
simulator. The design and its risks are in [mechanical-simulation-plan.md](mechanical-simulation-plan.md).
The same mechanisms also run live, acted on while they run (drag, push, motors): [interactive-physics.md](interactive-physics.md).

```
Agent (Claude Code, Antigravity …) ── MCP: cad/mcp/server.mjs, tools sim_*
  └─ gateway /api/sim/*  ──►  mesh3d worker /sim/*  (mesh3d/sim/runs.py)
        ├─ sim/schema.py      check the mechanism, convert to SI, mass properties
        ├─ sim/chrono_run.py  PyChrono 10.0.0 in /opt/chrono (its own Python 3.12; not Hunyuan3D's PyTorch)
        └─ sim/playback.py    Blender 4.5 in the background: keyframes, self-check, .blend, MP4
```

## Environment

| | Version | Where |
|---|---|---|
| Project Chrono (PyChrono) | 10.0.0 (`projectchrono::pychrono=10.0.0`, build `py312h98ab86c_1198`) | `/opt/chrono` in the mesh3d image, a micromamba environment |
| Python for Chrono | 3.12, NumPy 2.5 | `/opt/chrono/bin/python` |
| micromamba | 2.10.0 | `/usr/local/bin/micromamba` (build time only) |
| Blender | 4.5.5 | `blender -b`, under `xvfb-run` for Workbench rendering |
| Worker Python | 3.11 (PyTorch 2.7.1 image), trimesh | `python` in the container |

The environment is installed by the Dockerfile layer:

```
micromamba create -y -p /opt/chrono -c projectchrono -c conda-forge "projectchrono::pychrono=10.0.0" python=3.12
```

It takes about 5 GB, because the conda package brings CUDA, MKL and VSG libraries. The simulation runs on the CPU
(`ChSystemNSC`, or `ChSystemSMC` for soft contacts). No GPU is used, and none is needed.

**API checked against 10.0.0.** These are the API facts the adapter relies on; each was checked against the
installed module.

- `ChLink*.Initialize(body1, body2, ChFramed)` moves body1 relative to body2, along the frame's **Z** axis. This
  holds for revolute, prismatic and cylindrical joints, for both rotational and linear motors, and for `ChLinkRSDA`.
- `ChBodyAuxRef`: `SetFrameRefToAbs` places the body's own frame. `SetFrameCOMToRef` sets the centre of mass. The
  "body" frame of a link is the centre of mass.
- `ChLinkMotorRotation.SpindleConstraint_FREE` and `ChLinkMotorLinear.GuideConstraint_FREE` let a motor only
  drive.
- `ChLinkLockGear`:
  - `SetFrameShaft1/2` are relative to each body's centre-of-mass frame.
  - `SetTransmissionRatio(N_a/N_b)` sets the ratio; the radii come from the shaft distance.
  - External gears turn opposite ways. `SetEpicyclic(true)` is used for internal gears.
- `ChFunctionSine(A, f[Hz], phase, shift)` is `shift + A sin(2πft + phase)`. `ChFunctionInterp` with
  `SetExtrapolate(False)` holds its last value.
- `GetRelAngle()` is unsigned. `GetRelAngleAxis().z` gives the signed revolute angle.
- `DoAssembly(FULL)` returns an `ExitFlag_*`. `NOT_CONVERGED` = 0.
- `ChCollisionModel.SetDefaultSuggestedEnvelope/Margin` are read when a shape is added. Chrono's defaults (30 mm,
  10 mm) are for metre-sized bodies, so the runner sets 0.5 mm and 0.1 mm unless the mechanism says otherwise.
- `ChContactMaterialSMC`: `SetYoungModulus`, `SetPoissonRatio`, `SetFriction`, `SetRestitution`; `ChSystemSMC`
  uses the Hertz model from the material by default.
- `ChBody.AddAccumulator()`, `EmptyAccumulator(i)`, `AccumulateForce(i, F, point, local)`, `AccumulateTorque(i,
  T, local)`: external loads that stay until emptied. The contact gears use them.
- `ChBody.GetContactForce()` / `GetContactTorque()`: the total on a body, in the world.

**Why the gears' teeth are a mesh model, not colliding shapes.** Tried first: each tooth as a convex hull
(Bullet, and Chrono's Multicore narrowphase) and the outline as a 2D path (`ChCollisionShapePath2D`). The hulls
reported hundreds of contacts tens of millimetres apart and jammed the pair (speed ratio -0.05 instead of -0.5),
and the 2D path took over 10 minutes for 1 s of motion. The line-of-action model below is the one gear dynamics
uses (backlash, varying mesh stiffness, friction), runs a second of motion in about 10 s, and its results check
against theory.

**Check the environment:**

```
docker exec bambu-mesh3d /opt/chrono/bin/python -c "import pychrono as ch; ch.ChSystemNSC(); print('ok')"
docker exec -w /opt/mesh3d bambu-mesh3d /opt/chrono/bin/python -m unittest sim.tests.test_chrono
```

## Setup

The mesh3d container ([cad.md](cad.md#setup)) already carries everything. After pulling this change:

```
docker compose -f docker-compose.mesh3d.yml build
docker compose -f docker-compose.mesh3d.yml up -d
```

This adds the Chrono layer and mounts `./data/sim` at `/sim`.

The gateway needs `MESH_WORKER_URL`, as for figures, and a rebuild for the `/api/sim` routes:

```
DOCKER_BUILDKIT=0 docker build -t bambu-lab-h2d/gateway:latest .
docker compose -f docker-compose.gateway.yml up -d --no-build
```

**MCP.** The `sim_*` tools are part of the existing `bambu-cad` server (`cad/mcp/server.mjs`, see
[cad.md](cad.md#antigravity-mcp)). For Claude Code in this repository, `.mcp.json` registers it. Claude Code asks
once before it starts a project server.

## Use

Ask the agent, for example: "Mô phỏng cặp bánh răng 20/40 module 2, bánh nhỏ quay 60 vòng/phút, phát lại trong
Blender".

The agent works through the tools in this order:

| Tool | What it does |
|---|---|
| `sim_guide` | The format, units, frames and rules (`mesh3d/sim/guide.md`) |
| `sim_create_mechanism` | Stores a mechanism, even an incomplete one. Returns `mechanism_id` and the validation. |
| `sim_add_joint` / `sim_add_motor` / `sim_add_force` | Add one part. A part with its own error is refused and nothing is saved. |
| `sim_validate_mechanism` | Errors (with the field path), warnings, assumptions, estimated degrees of freedom |
| `sim_run_simulation` | Queues a Chrono run. With `wait_s` it waits for the result. `simulation` overrides duration or step for this run. |
| `sim_get_simulation_status` | State, progress, failed checks, playback state. `cancel: true` stops the run. |
| `sim_get_simulation_results` | `summary.json`, `metadata.json` and the file URLs |
| `sim_play_simulation_in_blender` | Animation, self-check, `.blend`, MP4 and a preview sheet (returned as an image) |

`mesh3d/sim/examples/` has four examples:

- `motor_shaft.json`: the MVP, a shaft with an arm on a bearing, turned at 360°/s.
- `gear_pair.json`: an ideal pair, 20/40 teeth, module 2.
- `gear_contact.json`: the same pair with its teeth in contact (PLA, 0.2 mm backlash, μ = 0.2, a 0.2 N·m load).
- `pendulum.json`: a physical pendulum.

You can call the API directly (see [api](#api)):

```
curl -X POST localhost:3000/api/sim/runs -H "Content-Type: application/json" \
     -d "{\"mechanism\": $(cat mesh3d/sim/examples/gear_pair.json)}"
curl localhost:3000/api/sim/runs/<sim id>/results
curl -X POST localhost:3000/api/sim/runs/<sim id>/play -H "Content-Type: application/json" -d "{}"
```

## The mechanism

The full reference for the format is `mesh3d/sim/guide.md`; the agent reads it through `sim_guide`. The points
that matter most:

- **Units.**
  - `units.length` (`mm` or `m`) is required. Mass is `kg` or `g`. Angles are `deg` (the default) or `rad`.
  - Forces and torques are always N and N·m. Density is always kg/m³.
  - The result files are in SI units.
- **Frames.**
  - Z is up, as in Blender, so Chrono and Blender share the world frame; 1 Blender unit = 1 mm.
  - A body's `position` and `orientation` place its own frame, the one its geometry or mesh is drawn in.
  - Joint positions and axes are in the world at t = 0. A joint's coordinate is 0 at t = 0.
- **Nothing is invented.**
  - A dynamic body needs `mass` or `density`. A motor needs a `law`. A spring needs its stiffness and damping.
    Otherwise the mechanism is refused, with the field named.
  - An inertia computed from the geometry (uniform density), a default gravity, or a spring's rest length taken
    at t = 0 is listed under `assumptions`, in the answer and in `metadata.json`.
- **Gears.** A `gear` joint joins two revolute joints on the same frame. By default it is an ideal kinematic
  constraint (`"model": "ideal"`): an exact ratio, no backlash or friction. With `"model": "contact"` the teeth are
  in contact ([Gear teeth in contact](#gear-teeth-in-contact)).
- **Contacts.** `simulation.collision` turns collision on for the bodies with `collision: true`: `nsc` (rigid,
  the default) or `smc` (Hertz springs; each colliding body needs `material.young_modulus_Pa` and
  `material.poisson_ratio`, and the step should be ≤ 1e-4 s). The total contact force on each colliding body goes to
  `contacts.csv`.
- **Meshes.** A body can use a model job's mesh for its mass properties and its look, e.g.
  `"geometry": {"type": "mesh", "file": "jobs/<job id>/out/model.stl"}` or
  `"visual": {"mesh_file": "jobs/<job id>/out/model.stl"}`. The mesh must be drawn in the body frame. Files come
  only from `jobs/…` or `sim/files/…`.

## Gear teeth in contact

`"model": "contact"` on a `gear` joint (external spur pairs of standard 20° involute gears, both bodies with `gear`
geometry). Each step, before Chrono integrates, `GearContact` in `chrono_run.py`:

1. reads both gears' angles on their revolute joints and works out δ = r_ba·φ_a − r_bb·φ_b, how far gear a's base
   circle has run ahead of gear b's (b counted in the meshing direction);
2. applies no force while |δ| is inside half the backlash along the line of action (j_n = j_t·cos α_w);
3. beyond it, has each tooth pair in contact push k·(|δ| − j_n/2) + c·δ̇. The pairs are a base pitch apart on the
   stretch of the line of action between the two tip circles, so one or two pairs carry the load in turn (contact
   ratio 1.64 for 20/40) and the mesh stiffness changes as the gears turn;
4. adds Coulomb friction μ·F against each pair's sliding speed ω_a·x − ω_b·(L − x), which changes sign at the
   pitch point;
5. applies the result as a torque on each gear and the separating force at each bearing (drive flank when a
   leads, coast flank when b does).

What it needs, none of it guessed: `backlash` (circumferential, on the pitch circle, both gears together),
`friction`, and `mesh_stiffness_N_per_m` per tooth pair or `young_modulus_Pa` (ISO 6336's 14 N/(mm·µm) for steel,
scaled by E/206 GPa and the face width, listed as an assumption). `pressure_angle` defaults to 20°, `damping_ratio`
to 0.1. The time step must be at most 1/20 of the mesh period; the validation gives the figure (about 1e-5 s for
PLA module 2 gears). `gear_contact.json` is the example: 20/40 PLA gears, 0.2 mm backlash, μ = 0.2, a 0.2 N·m load.

In `joint_results.csv` the gear's `value` is δ (m), `rate` is δ̇, `effort` the total tooth force (N), `fx…fz` the
tooth force on gear b in the world and `tz` its torque.

Limits: spur gears only (no helix, no internal pairs), standard addendum, the tooth stiffness constant along the
line of action, the teeth centred in the backlash at t = 0, and friction as torques (its small bearing load left
out).

## Results

Each run has its own folder, `data/sim/runs/<sim id>/`. Runs never share or overwrite a folder.

| File | What it holds |
|---|---|
| `mechanism.json`, `model.json` | The input as written, and in SI as Chrono ran it (to rerun it exactly) |
| `status.json` | queued / running / completed / failed / cancelled, progress, error, failed checks |
| `metadata.json` | Configuration, units in and out, engine and version, assumptions, warnings, assembly result, step count, timings |
| `body_transforms.csv` | One row per output time per body: `t, body, x, y, z, qw, qx, qy, qz, vx, vy, vz, wx, wy, wz, ax, ay, az, alpha_x, alpha_y, alpha_z` (world, SI; the body's own frame; quaternion signs kept continuous) |
| `joint_results.csv` | One row per output time per joint, motor and spring: `t, item, kind, value, rate, effort, fx, fy, fz, tx, ty, tz, violation`. `value`/`rate` is the joint angle or slide and its rate (0 at t = 0). `effort` is motor torque/force or spring force/torque. `f`/`t` is the reaction on body_b in the joint frame (Z = axis). A contact gear: see [above](#gear-teeth-in-contact). |
| `contacts.csv` | With collision on: `t, body, fx, fy, fz, tx, ty, tz, contacts`, the total contact force and torque on each colliding body (world) and the system's contact count |
| `simulation.log` | Chrono's run: assembly, warnings, errors |
| `engine.json`, `summary.json` | Ranges per body and joint, the largest reactions, the checks |
| `blender/` | `playback.blend`, `playback.mp4`, `preview.png`, `check.json`, `blender.log` |

**Checks.** Every check is in `summary.json`, and `checks_passed` is false if any fails.

| Check | Pass when |
|---|---|
| Assembly at t = 0 | Chrono closes every joint. Otherwise the run fails and names the joint. |
| Finite values | No NaN or infinity anywhere. The run stops at the first one. |
| Constraint violation | Under `constraint_tolerance` (1e-6) all through the run. Redundant or contradictory constraints fail here. |
| Motor law | A speed motor's angle or position against ∫law dt, within about one step's travel. An angle or position motor against its law, within 1e-6. |
| Gear ratio | Ideal: ω_b/ω_a = −N_a/N_b (+ for internal), within 1e-4. Contact: the turn over the run, within what the backlash and the teeth's deflection allow. |
| Gear efficiency | Contact gears with friction, driving on one flank: the power through the teeth against 1 − μ·H_v (Ohlendorf, ISO/TR 14179-2), within a quarter of the loss |
| Contact equilibrium | A colliding body with nothing else attached that has come to rest: the contact force is −m·g within 1 % |
| Blender playback | Every body's pose against Chrono's: 0.01 mm and 0.05°. Every revolute joint and rotational motor's angle, measured on the Blender objects, against the joint's coordinate. This catches a wrong direction of rotation. |

## Tests

```
# Schema, units, errors (any Python)
docker exec -w /opt/mesh3d bambu-mesh3d python -m unittest sim.tests.test_schema
# Chrono against theory (Chrono's Python)
docker exec -w /opt/mesh3d bambu-mesh3d /opt/chrono/bin/python -m unittest sim.tests.test_chrono
# The orchestrator, runs and Blender playback (the worker's Python)
docker exec -w /opt/mesh3d bambu-mesh3d python -m unittest sim.tests.test_runs
# Gateway routes and the dashboard's helpers
npx vitest run tests/sim.test.ts tests/simUi.test.ts
```

`test_chrono` checks exact answers:

- **Motor.** A shaft turned at 360°/s is at ω·t within 1e-5 rad. Each output interval adds the same turn, and the
  turn is counter-clockwise about +Z.
- **Gears.** The 20/40 pair turns at −0.5.
- **Pendulum.** The period is 2π√(I_p/(m g d))·(1 + θ₀²/16), within 0.1 %, and the amplitude is kept within 1 %.
- **Free fall.** Within g·t·dt of z₀ − g t²/2; halving the step halves the error (first-order stepper).
- **Spring and mass.** The period is 2π√(m/k), within 0.2 %.
- **Over-constrained shaft.** A second bearing makes a check fail.
- **Gear teeth, no friction.** With a 0.2 N·m load the motor needs 0.2·20/40 N·m and the teeth push 0.2/r_bb N,
  both within 1 % averaged over the mesh cycles.
- **Gear teeth, friction 0.2.** The efficiency check passes (0.963 against Ohlendorf's 0.967).
- **Backlash.** Turned slowly with 0.4 mm backlash, the pinion turns j_n/(2·r_ba) before the wheel moves.
- **Ball on a plate.** A steel ball comes to rest with the contacts carrying m·g (1 %), with SMC and with NSC.

## Dashboard

The gateway dashboard has a **⚙️ Mô phỏng** tab when the mesh worker answers `/api/sim` (`src/ui/sim/SimCard.tsx`):
the runs (refreshed while one is running, with a cancel button), and for the picked run its checks, a chart of any
joint's value, rate or effort over time (from `joint_results.csv`), the bodies' largest travel and speeds, the
assumptions and warnings, the result files, and the Blender video, which **Dựng video** renders. Runs are started
by the agent through the `sim_*` tools, not from the page.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `SIM_DISABLED` (501) | `MESH_WORKER_URL` is not set in the gateway's `.env` |
| `/health` shows `"chrono": false` | The image predates the Chrono layer: rebuild mesh3d |
| `INVALID_MECHANISM` with `details` | Fix the named fields. Missing mass, inertia or law has to come from the user. |
| "Không lắp ráp được cơ cấu" | The joints cannot all close at t = 0: check positions and axes against where the bodies are |
| `constraints` check failed | Redundant constraints (e.g. a motor with `guide: "joint"` on a pair a joint already guides, two bearings on one shaft), or a time step too large |
| Motor law check failed | The motor cannot follow its law (blocked, over-constrained), or the step is too coarse for a fast law |
| Run stopped at a non-finite value | The mechanism became unstable: use a smaller `time_step`, or check masses and stiffnesses |
| "cần time_step ≤ …" on a contact gear | The teeth's own vibration is faster than the step: use the step it gives |
| A body floats above another or sinks into it | Collision `envelope`/`margin` too large for the parts, or SMC with too large a step |
| Playback failed | `data/sim/runs/<id>/blender/blender.log`. A mesh file must be readable from inside the container. |
| A run takes too long | Each run is capped by `SIM_TIMEOUT_S` (900 s by default) and playback by `SIM_PLAYBACK_TIMEOUT_S`. Cancel with `sim_get_simulation_status` `cancel: true`. |

## API

All routes are passed through to the mesh worker. Answers are `{"success": …}` JSON, or the file itself.

| Method | Path | |
|---|---|---|
| GET | `/api/sim/guide` | The format and rules (Markdown) |
| GET / POST | `/api/sim/mechanisms` | List / store `{"mechanism", "mechanism_id"?}` |
| GET | `/api/sim/mechanisms/:id` | A mechanism and its validation |
| POST | `/api/sim/mechanisms/:id/joints` `…/actuators` `…/forces` | `{"joint"}` / `{"actuator"}` / `{"force"}` |
| POST | `/api/sim/validate` | `{"mechanism"}` or `{"mechanism_id"}` |
| GET / POST | `/api/sim/runs` | List / start `{"mechanism_id" or "mechanism", "simulation"?}` (202) |
| GET | `/api/sim/runs/:id` | `{"status"}` with `playback` |
| GET | `/api/sim/runs/:id/results` | `summary`, `metadata`, `files` (409 until completed) |
| POST | `/api/sim/runs/:id/cancel` | Stops the run or its playback |
| POST | `/api/sim/runs/:id/play` | `{"render", "fps", "speed", "width", "height"}` (202) |
| GET | `/api/sim/runs/:id/files/:name`, `…/files/blender/:name` | Result files |
