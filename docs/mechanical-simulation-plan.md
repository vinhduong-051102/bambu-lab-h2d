# Mechanical simulation: plan

Claude designs a mechanism (bodies, joints, motors, springs), Project Chrono simulates it on this machine, and
Blender plays the motion back. This page records what the repository had before, the design, the phases and the
risks. How to use what was built is in [mechanical-simulation.md](mechanical-simulation.md).

## 1. What was there (survey, 2026-10-28)

| Part | Where | What it does |
|---|---|---|
| Gateway | `server.ts`, `app/api/**/route.ts` → `src/api/routes/*` | Next.js in Docker (`bambu-gateway`, :3000 / :3443). Talks to the workers over HTTP with `WorkerHttp` (`src/domain/cad/cadJobs.ts`). |
| CAD worker | `cad/` (`bambu-cad`) | build123d models; Claude writes code with `claude -p`. |
| Mesh worker | `mesh3d/` (`bambu-mesh3d`, :3103 → 8000) | `worker.py` (stdlib HTTP server). Hunyuan3D-2 on the GPU (`shape.py`, PyTorch 2.7.1 / CUDA 12.8, Python 3.11). Claude in Blender (`review.py`). |
| Blender | `mesh3d` image, Blender 4.5.5 | Per job, `review.py` starts GUI Blender under `xvfb-run` (Mesa llvmpipe) with the MCP for Blender add-on on a free port (`BlenderSession`). Claude reaches it through two stdio MCP servers: `mcp-for-blender` and `figure_mcp.py`. Plain scripts can use `blender -b`. |
| MCP for outside agents | `cad/mcp/server.mjs` (`bambu-cad`) | Node, no dependencies. Calls only the gateway's `/api/cad/*` routes. Tools `cad_*`. |
| Files | `data/cad/jobs` → `/jobs` | One folder per job. `mesh3d/` is mounted read-only at `/opt/mesh3d`, so code changes need no image rebuild. |
| Tests | `tests/*.test.ts` (vitest) | 344 tests. There were no Python tests. |
| Host | Windows 11, Docker 29.5.2 (Linux containers), RTX 5070 Ti | Large data goes on `F:`. |

**Process and logs.** Workers log to stdout (`docker logs`). Jobs write `status.json` and `work/*.log`. A
cancelled or timed-out child is killed by process group.

## 2. Target design

```
Claude (Claude Code, Antigravity …)
  └─ MCP: cad/mcp/server.mjs, tools sim_*            (the existing server, extended)
       └─ gateway /api/sim/*                          (pass-through to the mesh worker)
            └─ mesh3d worker.py /sim/*                (orchestrator: sim/runs.py)
                 ├─ sim/schema.py   check, SI units, mass properties   (worker Python + trimesh)
                 ├─ sim/chrono_run.py  PyChrono run → CSV/JSON          (/opt/chrono Python, its own conda env)
                 ├─ results: summary.json, checks against theory
                 └─ sim/playback.py  Blender -b: keyframes from body_transforms.csv → .blend, frames, MP4
```

- **Chrono runs in its own environment.** `/opt/chrono` is a micromamba environment in the mesh3d image, with
  Python 3.12, `projectchrono::pychrono` 10.0.0 and conda-forge. It shares nothing with Hunyuan3D's Python 3.11 and
  PyTorch, and it runs as a subprocess. The solvers used are CPU only (NSC/SMC multibody). No GPU is assumed.
- **Why not a separate container?** Blender playback, the job files and the worker's process handling are already
  in mesh3d. A separate environment gives the isolation; a second container would only add a network hop.
- **One MCP server.** The `sim_*` tools join `cad/mcp/server.mjs` and follow its convention (gateway only). The
  in-job servers (`figure_mcp.py`, `mcp-for-blender`) are untouched.
- **Local only.** The pipeline (checks, Chrono, Blender) calls no cloud service and no paid simulator. The agent
  driving it is still Claude, as for the rest of this repository.

## 3. Data

- `data/sim/mechanisms/<id>/mechanism.json`: the mechanism as the agent wrote it (schema version 1). It is
  changed by `sim_add_joint` and `sim_add_motor`.
- `data/sim/runs/<sim id>/`: one folder per run, never shared:
  - `mechanism.json`: the input.
  - `model.json`: the SI model Chrono ran.
  - `status.json`
  - `metadata.json`: configuration, units, engine version, assumptions, state.
  - `body_transforms.csv`: t, body, position, quaternion, velocities, accelerations.
  - `joint_results.csv`: reaction force and torque, motor angle, speed and torque.
  - `simulation.log`
  - `summary.json`: ranges, checks, comparison with theory.
  - `blender/`: `playback.blend`, frames, `playback.mp4`.

**Units and frames.** The mechanism declares `length` (mm|m), `mass` (kg|g) and `angle` (deg|rad). Forces and
torques are always N and N·m. Chrono gets SI. Both Blender and the world frame are Z up, so frames only scale
(1 Blender unit = 1 mm, as in the figure jobs). Quaternions are w, x, y, z on both sides. Chrono's joints and
motors act along their frame's Z axis: the adapter builds that frame from the joint's position and axis, given
in the world at t = 0.

## 4. Phases

1. **Environment.** Add micromamba and `/opt/chrono` to the image. A check script imports PyChrono, builds a
   system and steps a falling body. Record the versions and commands.
2. **MVP.** A fixed base, a shaft with mass and inertia, a revolute joint and a speed motor, simulated for a few
   seconds. The motor angle should be ω·t within 1e-6 rad, and the run should be continuous with no NaN.
3. **Gears.** An ideal gear constraint (`ChLinkLockGear`) between two shafts on revolute joints. Check
   ω₂/ω₁ = −N₁/N₂ to 1e-4. This models no tooth contact, backlash or friction.
4. **Blender.** Each body is a mesh: a primitive, a generated gear, or an STL/OBJ from a job or a file. The
   stable ID is the body id, and objects are named `sim:<id>`. Keyframes come from the CSV. Save a `.blend` and
   render frames and an MP4 headless.
5. **MCP.** Worker routes, a gateway pass-through and the `sim_*` tools. Runs are asynchronous with a timeout,
   can be cancelled, and each has its own folder.
6. **Tests and docs.** Python `unittest` for the schema and adapter, integration tests in the Chrono environment
   with analytic checks, vitest for the gateway route and the MCP tools, plus the user guide.

## 5. Files

New:
- `mesh3d/sim/__init__.py`, `schema.py`, `chrono_run.py`, `runs.py`, `playback.py`, `check_env.py`
- `mesh3d/sim/examples/*.json`
- `mesh3d/sim/tests/test_*.py`
- `app/api/sim/[...path]/route.ts`, `src/api/routes/sim.ts`, `tests/sim.test.ts`
- `docs/mechanical-simulation.md`

Changed:
- `mesh3d/Dockerfile`: a new layer for the Chrono environment; nothing above it changes.
- `mesh3d/worker.py`: the `/sim/*` routes.
- `docker-compose.mesh3d.yml`: the `data/sim` volume.
- `cad/mcp/server.mjs`: the `sim_*` tools.
- `src/api/routeDocs.ts`, `docs/cad.md` (a link).

## 6. Risks

| Risk | How it is handled |
|---|---|
| PyChrono API changes between versions (8 → 9 renamed most methods) | Pinned to 10.0.0. The adapter uses only names checked against the installed module (§7). |
| The conda package is large (~0.5 GB; it pulls CUDA and VSG libraries) | Accepted. It is one layer of the image. |
| Redundant constraints (a motor plus a revolute joint on the same pair) | The motor's guide is free when a joint already guides the pair. After assembly the run checks constraint violation over time and fails above the tolerance. |
| Physical data the agent does not have | Missing mass, inertia or law is an error. Derived values (inertia from geometry) are listed as assumptions in `metadata.json` and the answer. |
| An ideal gear is read as tooth contact | `summary.json` and the tool output say "ideal gear constraint". |
| A runaway run (tiny step, long duration) | Step and sample caps in the schema, a wall-clock timeout, cancel, and one run at a time (a queue). |
| Blender keyframe rotation flips | Quaternion keyframes, with signs kept continuous between samples. |
| The worker blocking | Runs are subprocesses on a worker thread, and HTTP answers at once. |

## 7. Verified environment and API

The real install has PyChrono 10.0.0 (conda `projectchrono`, build py312h98ab86c_1198), Python 3.12 and NumPy
2.5.4 in `/opt/chrono`, created with micromamba 2.10.0. The API facts the adapter relies on are listed in
[mechanical-simulation.md](mechanical-simulation.md#environment).

Two surprises came up during testing:
- `GetRelAngle()` is unsigned, so a pendulum never crossed zero. The adapter reads `GetRelAngleAxis().z` and keeps
  it continuous.
- Interpolating an angle wrapped to ±π between samples gave a 120° error in Blender's self-check. The CSV now
  holds continuous angles.

## 8. Status (2026-10-28)

| Phase | State | Evidence |
|---|---|---|
| 1. Environment | Done | `/health` → `"chrono": true`; the image layer builds and imports PyChrono. |
| 2. MVP shaft + motor | Done | `test_chrono.test_motor_shaft`: angle = ω·t within 1e-5 rad over 3 s, continuous; the bearing agrees. |
| 3. Gears (ideal) | Done | `test_gear_pair`: ω₂/ω₁ = −0.5, error 2e-12. Tooth contact, backlash and friction are not modelled. |
| 4. Blender | Done | `test_runs.Playback`: pose error 0 mm, 1e-5°; joint angles against Chrono within 0.002°; MP4 and preview rendered. |
| 5. MCP | Done | `sim_*` tools in `cad/mcp/server.mjs`, run end to end through the real `/api/sim` handlers against the live worker. |
| 6. Tests and docs | Done | 29 schema, 10 Chrono (theory), 11 orchestrator/playback (Python); 6 route and 5 dashboard-helper tests (vitest); this page and the guide. |
| 7. Gear teeth in contact | Done | `"model": "contact"`: line-of-action mesh model (backlash, single/double tooth stiffness, friction). Frictionless load: motor torque and tooth force within 1 % of T·N_a/N_b and T/r_bb; μ = 0.2: efficiency 0.963 against Ohlendorf's 0.967; backlash taken up at j_n/(2·r_ba). Colliding tooth shapes were tried first and dropped (see [mechanical-simulation.md](mechanical-simulation.md#environment)). |
| 8. SMC contacts | Done | `collision.method: "smc"` with each material's E and ν; envelope and margin scaled to mm parts; `contacts.csv`; a ball at rest carries m·g within 1 % (SMC and NSC). |
| 9. Dashboard | Done | The **⚙️ Mô phỏng** tab: runs, checks, joint charts, Blender video. The gateway was rebuilt on 2026-10-28 and serves `/api/sim`. |
