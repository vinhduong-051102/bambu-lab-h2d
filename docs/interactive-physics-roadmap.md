# Interactive physics: survey and roadmap

Where the simulation platform stands, what was added for interactive simulation, and what comes next. Written
2026-10-29 from the code and from runs on this machine, not from feature names: each "verified" below says what was
run. How to use the interactive part is in [interactive-physics.md](interactive-physics.md).

## 1. What exists and is verified

Run on 2026-10-29 in the mesh3d image (Chrono 10.0.0, Blender 4.5.5), before any change in this work:
`test_schema` 29/29, `test_chrono` 10/10, `test_runs` 11/11, all passed.

| Function | Verified by |
| --- | --- |
| Mechanism JSON (schema_version 1): units, frames, validation with field paths, assumptions listed | `test_schema` (29), including every example |
| Rigid bodies, revolute/prismatic/cylindrical/spherical/fixed/distance joints, motors (angle/speed/torque, position/speed/force), springs | `test_chrono`: motor ω·t within 1e-5 rad; spring–mass period 0.2 %; pendulum 0.1 % |
| Ideal gears and spur gears with teeth in contact (backlash, mesh stiffness, friction) | `test_chrono`: ratio −0.5; tooth force 1 %; efficiency 0.963 against 0.967 (Ohlendorf); backlash |
| NSC and SMC contacts | `test_chrono`: ball at rest carries m·g (1 %) with both |
| Runs queued one at a time, own process, own folder, cancel, timeout | `test_runs` |
| Blender playback: keyframes from Chrono, self-check of poses and turning direction, .blend, MP4 | `test_runs` |
| Gateway `/api/sim/*`, dashboard tab, MCP `sim_*` tools | `tests/sim.test.ts`, `tests/simUi.test.ts`; the tools by name only (no MCP test existed) |

The history (22 runs, 21 completed) is a record, not a test.

## 2. Exists, not fully settled

- **Contact gears are slower than real time**: ×0.19 with Chrono alone at their 10 µs step (measured). Fine
  offline; interactively they run behind and say so.
- **One-step lag of the contact gears' tooth forces offline.** Chrono sums a body's forces at the end of the step
  before, so forces accumulated just before `DoStepDynamics` act one step late (measured: a force added between two
  steps of a running system changes nothing in that step unless the system is updated first). `chrono_run.py`'s
  `GearContact` applies its forces this way. With 10 µs steps the effect is below what the checks resolve, and the
  offline runner was left unchanged; the live session updates the system before each step.
- **Colliding meshes need trimesh** (their convex hull), which only the worker's Python has: a live session gets
  them from a run's model.
- **The MCP server had no tests.** The new tools were exercised end to end over stdio (see §6); the old ones were
  not tested here.
- **Vitest's module cache** (`node_modules/.vitest-cache`) keeps `tests/helpers/testApp.ts` compiled with the route
  list it saw first, so a newly added `app/api/**/route.ts` answers 404 in tests until the cache is cleared or
  vitest runs with `--no-fsModuleCache`.

## 3. Did not exist (before this work)

A Chrono system kept alive between requests; acting on it while it runs (drag, push, motor, gravity); pausing,
stepping, resetting; a view of it updated live; pacing against the wall clock. Offline runs start, run to the end
and only then can be watched.

## 4. Architecture chosen

**Viewer: the dashboard (three.js), not Blender's interface.** Blender in the container runs on a virtual display
(`xvfb-run`): nobody can see or click its viewport, and a modal operator stepping physics would tie Chrono to
Blender's event loop and its Python. The dashboard already is where the user works, three.js 0.186 is a dependency,
and it reaches the session through the gateway's authentication. Blender keeps what it does well: playback and video
of offline runs.

```
Physics engine          chrono_run.Model (unchanged): the same system offline and live
Simulation controller   mesh3d/sim/live.py Session: fixed step, wall-clock pacing, action queue, drag as a force,
                        reset by rebuilding, state snapshots; its own process (bambu-sim-live container)
Transport               HTTP actions; state as Server-Sent Events (stdlib only: Chrono's Python has no WebSocket
                        library), passed through the gateway (/api/sim/live/*)
Visualization           src/ui/sim/SimLive.tsx: draws the bodies where the state says, arrows for forces and
                        velocity; pointer → drag target; never moves a body by itself
Offline                 unchanged: the viewer's "Chạy ngoại tuyến" sends the same mechanism to /api/sim/runs
```

Internal interface of a session (not Chrono's API): `load_model`, `Session(model)` (build = initialize),
`step`, `act` (= apply_action: pause, resume, step, reset, speed, drag, release, push, twist, motor, gravity,
spring, teleport, select), `publish` / `latest` (= get_state), `stopped` (= stop). `export_results` is not built: a
session keeps its last minute of samples in memory only.

## 5. Kept unchanged

`chrono_run.py`, `schema.py`, `runs.py`, `playback.py`, the mesh worker and its routes, the result files, the
`/api/sim/*` routes and the `sim_*` tools (five tools added beside them). The only edits to existing simulation
files: `test_schema.py` declares the new example's 12 free degrees of freedom, and `SimCard.tsx` hosts the viewer.

## 6. Risks and how they are tested

| Risk | Test |
| --- | --- |
| The live system drifts from the offline one | Both are `chrono_run.Model`; `test_live` checks exact answers (rest height, m·g, F·T/m, T·t/I, motor speed) |
| Viewer moves meshes instead of physics | The viewer has no position source but the state; the UI test drags with real pointer events and checks Chrono's state (box lifted to 77–150 mm, then back to 10.00 mm at rest) |
| Drag tears a mechanism apart | Drag is a capped force; `test_live`: a shaft on a bearing pulled sideways stays on its axis to 1e-6 m |
| Claiming real time not reached | `behind` and the measured factor; `test_live`: contact gears report behind |
| Spiral of death on a slow mechanism | Debt dropped each frame, catch-up capped at 0.1 s; measured: contact gears hold ×0.12 steady |
| Unstable system | Non-finite values pause the session with the reason; reset rebuilds it |
| A closed tab leaves Chrono running | 10-minute idle stop; at most 2 sessions |
| Offline behaviour changes | `test_schema`, `test_chrono`, `test_runs` run again after the work: 29/29, 10/10, 11/11 |

End to end, on 2026-10-29: the sim-live container from this branch, the dashboard (development server) and Microsoft
Edge driven with real pointer events: open the drop example, see it fall and rest, drag the box up, release it,
select it, pause/resume, push it, reset, open the motor shaft and change its speed from 360 to 720 °/s while it
runs. And the MCP tools over stdio: start, step, read the state, push, refusal of a fixed body, stop.

## 7. Next: other kinds of physics

Not started: §12 of the brief puts these after the interactive MVP. Checked in the mesh3d image on 2026-10-29
(imports only, nothing simulated yet):

| Domain | Candidate | Licence | Local / CPU–GPU | Checked | Exchange, reference test |
| --- | --- | --- | --- | --- | --- |
| Rigid bodies, contacts | Chrono (in use) | BSD-3 | CPU | Running (above) | — |
| Flexible bodies: beams, shells, solids | Chrono FEA (`pychrono.fea`) | BSD-3 | CPU | Imports; has `ChElementBeamEuler`, `ChElementShellANCF_3423`, `ChElementTetraCorot_4` | Same system as the rigid bodies, so live too; test: cantilever tip deflection P·L³/(3EI), first bending frequency |
| Structural FEA, stress | CalculiX + gmsh (`/opt/fea`, the engineering analysis) | GPL-2 (CalculiX), GPL-2+ (gmsh) | CPU | Installed (`ccx`, `gmsh`) | Offline only (a solve, not a time loop); loads from a run's joint reactions (`joint_results.csv`); test: beam bending stress M·c/I |
| Granular (DEM) | Chrono::Multicore / Chrono::GPU | BSD-3 | CPU / CUDA | **Not in this build** (`pychrono.multicore` missing) | Needs Chrono built from source with them, or another engine (LIGGGHTS, GPL); test: angle of repose, hopper discharge (Beverloo) |
| Fluids, fluid–solid | Chrono::FSI-SPH (`pychrono.fsi`) | BSD-3 | CUDA | Imports; **not known whether built with CUDA** (to check by running a dam break) | Bodies shared with the rigid system; test: dam break front position (Martin & Moyce) |
| Heat | CalculiX heat transfer | GPL-2 | CPU | Installed, heat steps not tried | Offline; test: 1-D conduction against the analytic profile |

Rule for each: an adapter only once the solver runs here and a test against a reference answer passes; each
declares what it simulates, what can be done to it while running (FEA and heat: nothing, offline), its units and
frames, and its limits.

Order proposed: Chrono FEA flexible bodies first (same engine, same live session, already importable), then
CalculiX loads from runs, then the GPU solvers once they are proven to run on this GPU.
