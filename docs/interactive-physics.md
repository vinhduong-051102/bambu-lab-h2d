# Interactive simulation (Mô phỏng tương tác)

A mechanism keeps running in Project Chrono while you act on it: drag a body with the mouse and let go, push it,
change a motor's speed, switch gravity off, pause, step, reset. Each of these acts on Chrono's own state; the view
only draws where Chrono puts the bodies. The offline runs ([mechanical-simulation.md](mechanical-simulation.md)) are
unchanged, and the same mechanism runs either way. The plan, the survey behind it and what comes next are in
[interactive-physics-roadmap.md](interactive-physics-roadmap.md).

```
Dashboard ⚙️ Mô phỏng (three.js viewer, src/ui/sim/SimLive.tsx)        Agent (MCP: sim_*_interactive)
   │  actions: POST /api/sim/live/:id/actions                              │
   │  state:   GET  /api/sim/live/:id/stream (Server-Sent Events, 30/s)    │
   └──────────── gateway /api/sim/live/* (src/api/routes/simLive.ts) ◄─────┘
                    │
                    ▼
   sim-live container (docker-compose.sim-live.yml, the mesh3d image)
     mesh3d/sim/live.py: one thread per session steps chrono_run.Model against the wall clock
```

## Setup

The mesh3d image already has Chrono, so nothing is built; this starts its own process next to the mesh worker:

```bash
docker compose -f docker-compose.sim-live.yml up -d
```

It listens on `127.0.0.1:3104` (only the gateway talks to it), has no GPU and at most 2 GB of memory, and reads
`./data/sim` (mechanisms, runs), `./data/cad/jobs` and `./data/eng` read only. The gateway's compose file points
`SIM_LIVE_URL` at it; a gateway run with `npm start` needs `SIM_LIVE_URL=http://127.0.0.1:3104` in `.env`. The new
routes need the gateway rebuilt (as in [mechanical-simulation.md](mechanical-simulation.md#setup)).

Rolling back: `docker compose -f docker-compose.sim-live.yml down`. Nothing it does is written to disk, and the mesh
worker, its runs and their files are never touched.

## Use

**From the dashboard.** Tab **⚙️ Mô phỏng**, card **🎮 Mô phỏng tương tác**: pick an example (Hộp và bi rơi xuống
nền is the place to start), a stored mechanism, or a session already running, and **Bắt đầu**. On a finished run,
**🎮 Mở tương tác** opens that run's model exactly as it ran.

| In the view | Does |
| --- | --- |
| Left button on a body, move | Drags it: the point you grabbed is pulled to the pointer (on the plane facing the camera; with Shift, on the horizontal plane) |
| Let go | Releases it: it moves on under gravity, contacts, joints and motors |
| Click a body | Selects it: mass, speed, acceleration, contact force, the force you apply, its weight; arrows for its velocity (green) and contact force (orange) |
| Right button / middle button / wheel | Turn / pan / zoom the camera |

| In the panel | Does |
| --- | --- |
| Tạm dừng / Chạy | Pause, resume |
| 1 bước, +10 ms | Steps a fixed number of time steps (paused) |
| Reset | Back to the start, in the same running or paused state |
| Tốc độ | ×0.1 … ×5 of real time |
| Trọng lực | Gravity on or off while it runs |
| Motor: Đặt, Bật | A motor's set point while it runs (°/s, °, N·m, mm/s, mm or N), on or off |
| Đẩy 0.1 s | A push on the selected body along an axis, default three times its weight |
| Chạy ngoại tuyến | Runs the same mechanism offline: full results, checks against theory, Blender video |

The title shows how the session keeps up: **Thời gian thực ×1.00**, a speed set on purpose, or **Chậm hơn thời
gian thực: ×0.12** when the CPU cannot step the mechanism that fast (contact gears, 10 µs steps). The time shown is
always simulated time; the session never claims real time it does not reach.

**From an agent.** The MCP server (`cad/mcp/server.mjs`) has:

| Tool | Does |
| --- | --- |
| `sim_start_interactive` | Starts a session from `mechanism_id`, `sim_id`, `example` or a `mechanism`; returns its bodies (fixed, held by a joint), motors with their SI units, and the state |
| `sim_control_interactive` | `pause`, `resume`, `step` (`count`), `reset` (`overrides`), `speed` (`value`) |
| `sim_act_interactive` | `push`, `twist`, `motor`, `gravity`, `spring`, `drag`/`release`, `teleport`, `select` |
| `sim_get_live_state` | One snapshot (the agent does not poll: the dashboard streams to the user) |
| `sim_stop_interactive` | Ends it |

## How it works

**Time.** The physics step is the mechanism's fixed `time_step`. Every frame (1/120 s) the session steps until
simulated time catches up with wall time × speed, for at most 75 % of the frame; what it could not do is dropped,
not owed, so a slow mechanism runs as fast as it can instead of falling further and further behind. A pause of the
machine longer than 0.1 s is not caught up. The real-time factor is measured over the last second.

**What the user does, physically.** Every action goes through Chrono, between two steps:

| Action | Physically |
| --- | --- |
| `drag` | A hand: the grabbed point is pulled to the target by a critically damped 3 Hz spring that also carries the body's weight, never more than 20 × its weight. A finite force, so a body held by a joint or driven by a motor only moves as they let it |
| `push`, `twist` | A force (at a point) or torque for a duration |
| `motor` | The motor's law replaced by a constant set point; or the motor switched off (it drives nothing) and on |
| `gravity`, `spring` | The system's gravity, a spring's stiffness or damping |
| `teleport` | The body placed elsewhere with its velocity zeroed: not physical, and refused for a body a joint, motor or spring holds |
| `reset` | The system built again from the model: exactly the start, or with `overrides` (gravity, a body's friction, a free body's position or velocity) for this reset |

Two things Chrono does that the session corrects for, both checked against Chrono 10.0.0:

- Chrono sums a body's forces when it updates, at the end of the previous step, so a force or gravity changed
  between steps would act one step late. The session updates the system before each step. (The offline runner's
  contact gears have this one-step lag on their tooth forces; with their 10 µs steps it is below what the checks
  against theory resolve, and the offline runner is left as it is.)
- A speed motor keeps the angle its law integrates to and pulls back to it. Switched off, the shaft moved freely, so
  switched on again it would swing back. A speed motor switched back on therefore drives the speed alone
  (`drift_correction: false` in its state).

Friction cannot be changed while running: Chrono does not take a contact material's new friction into contacts it
already has (checked: a box on a slope stayed put after μ went from 0.9 to 0.05). It is a reset override instead.

**API.** All SI: m, kg, s, rad, N, N·m; positions and vectors in the world, Z up.

| Method | Path | |
| --- | --- | --- |
| GET | `/api/sim/live` | Sessions running, and the examples |
| POST | `/api/sim/live` | `{mechanism \| mechanism_id \| example \| sim_id, simulation?, paused?}` → `session_id`, `scene`, `state` (201) |
| GET | `/api/sim/live/:id` | The scene (bodies, geometry, joints and motors in their body's frame, springs, assumptions, the mechanism as written) and the state |
| GET | `/api/sim/live/:id/state` | The latest state |
| GET | `/api/sim/live/:id/stream?hz=30` | The state as Server-Sent Events, at most `hz` (1–60) a second |
| POST | `/api/sim/live/:id/actions` | `{action, ...}` (above) → the state after it |
| POST | `/api/sim/live/:id/stop` | Ends the session |
| GET | `/api/sim/live/:id/mesh/:body` | A body's mesh file, for the viewer |

Errors keep the session's status and code: `BODY_FIXED`, `BODY_HELD`, `MOTOR_NOT_FOUND` (409/404),
`INVALID_MECHANISM` (422), `TOO_MANY_SESSIONS` (409, `SIM_LIVE_MAX_SESSIONS`, default 2), `SIM_LIVE_UNREACHABLE`
(502: the container is not running), `SIM_LIVE_DISABLED` (501: no `SIM_LIVE_URL`).

A session nobody streams or acts on for 10 minutes (`SIM_LIVE_IDLE_S`) stops by itself.

## Performance

Measured on this machine (Intel Core i5-14500, 20 threads), 2026-10-29. The state goes out at 30 events a second
(measured through the gateway: 149 events in about 5 s).

| Mechanism | Time step | Chrono alone | Live session at ×1 | Live session's ceiling |
| --- | --- | --- | --- | --- |
| Box and ball dropped on the ground (NSC contacts) | 1 ms | ×97 | real time (×1.00) | ×47.6 |
| Pendulum | 0.5 ms | ×91 | real time | ×46.9 |
| Motor shaft | 1 ms | ×77 | real time | ×41.8 |
| Ideal gear pair | 1 ms | ×77 | real time | ×36.8 |
| Contact gears (teeth in contact) | 10 µs | ×0.19 | **×0.12, says it is behind** | ×0.1 |

"Chrono alone" is `chrono_run.Model` stepping as fast as it can; the session's ceiling (speed ×100) is lower by the
system update before each step and the 25 % of each frame left free.

Latency of one action (request to answer, the action applied between two steps): 8.5 ms median at the container,
17 ms median (95 % under 42 ms) through the gateway in development mode. The production gateway was not measured.
(Before the session server turned Nagle's algorithm off, the gateway's kept-alive connection waited ~40 ms for a
delayed ACK on every answer: 63 ms median.)

The viewer was driven in Microsoft Edge (headless, software WebGL) with real pointer events; frame rates on a real
GPU were not measured.

## Tests

```bash
# The session: physics against exact answers, refusals, pacing, HTTP and SSE (Chrono's Python)
docker exec -w /opt/mesh3d bambu-sim-live /opt/chrono/bin/python -m unittest sim.tests.test_live
# Gateway routes (the stream passed through unbuffered) and the viewer's helpers
npx vitest run tests/simLive.test.ts tests/simLiveUi.test.ts
```

`test_live` checks, running paused a fixed number of steps so the answers are exact:

- a box dropped on the ground rests on its largest face at z = 10 mm (± 0.5), its contacts carrying m·g (1 %)
- dragged, the grabbed point ends within 1 mm of the pointer, and follows it; the drag force is capped; released,
  the box falls back to rest
- a push F for T changes a free body's velocity by F·T/m; a twist spins it by T·t/I (1 %)
- gravity changed while running takes effect at the next step; a motor's speed changed while running is followed
  to 1e-6 rad/s; switched off, the shaft keeps its speed; switched on at 0, it stops (no swing back)
- dragging a shaft on a bearing sideways moves it nowhere but round
- reset restores the start exactly, or the start asked for (position, velocity, gravity, friction)
- a light mechanism keeps real time (±10 %) and a pause holds time still; the contact gears say they are behind

## Limits

- One viewer: the dashboard's three.js view. Blender stays for playback and video (offline runs); its interface is
  not used interactively (the container's Blender runs on a virtual display nobody sees).
- Friction changes need a reset. Bodies collide by their primitive shapes, or a mesh's convex hull, which only a
  run's model has (open the session from that run: `MESH_COLLISION_NEEDS_RUN` otherwise).
- Dragging is a force, not a constraint: a heavy body or a stiff mechanism lags the pointer, by design. Attaching a
  body to the pointer with a constraint is not implemented.
- A live session keeps the last minute of samples in memory but does not write results; for results, checks and a
  video, run the mechanism offline (**Chạy ngoại tuyến**, `sim_run_simulation`).
- Rigid bodies only, as offline. Flexible bodies, FEA, granular, fluid and thermal are on the roadmap.
