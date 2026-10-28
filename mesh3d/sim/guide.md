# Mechanism simulation: guide for the agent

You describe a mechanism in JSON. Project Chrono 10 (PyChrono) simulates it on this machine, and Blender plays the
motion back. Nothing is sent to the cloud. The steps:

1. `sim_create_mechanism`: store the mechanism.
2. `sim_add_joint`, `sim_add_motor`, `sim_add_force`: add parts.
3. `sim_validate_mechanism`: check it.
4. `sim_run_simulation`, then `sim_get_simulation_status`: run it and follow the run.
5. `sim_get_simulation_results`: read the results.
6. `sim_play_simulation_in_blender`: play it back.

## Rules

- **Never invent physical data.** A dynamic body needs `mass` or `density` (kg/m³). A motor needs its `law`. A
  spring needs its stiffness and damping. If the user has not given them, ask, or state the value you chose as an
  assumption in your answer. Do not present a guessed value as fact.
- **What is derived is listed.** The run lists everything it derived or defaulted under `assumptions`, for
  example an inertia from the geometry with uniform density, or gravity. Repeat these to the user.
- **Results are simulation results.** They are not measurements. Joints are ideal. A `gear` joint is an ideal
  kinematic constraint unless it has `"model": "contact"`: then the teeth push along the line of action, with
  backlash, tooth stiffness and friction (a lumped mesh model, not a collision of the tooth shapes).

## Frames and units

- **Frames.** The world is Z up, the same as Blender. A body's own frame is the frame its geometry and Blender mesh
  are drawn in. `position` (and `orientation`) place that frame in the world at t = 0.
- **Joint and motor positions.** `position` and `axis` are in the world at t = 0. A joint closes where the bodies
  are: its coordinates (angle, slide) count from 0 at t = 0.
- **`units`.** `length` is `mm` or `m` (required). `mass` is `kg` (default) or `g`. `angle` is `deg` (default) or
  `rad`. Speeds are in these units per second.
- **Fixed units.** Forces are always in N and torques in N·m. Stiffness is `stiffness_N_per_m` or
  `stiffness_Nm_per_rad`, and damping is `damping_Ns_per_m` or `damping_Nms_per_rad`. Density is always kg/m³.
- **Inertia.** It is given in the mechanism's mass·length² units, about the centre of mass, along the body's axes.
- **Result files.** These are in SI units (m, kg, s, rad, N, N·m). Quaternions are w, x, y, z.

## The mechanism (schema_version 1)

```json
{
  "schema_version": 1,
  "name": "…",
  "units": {"length": "mm", "mass": "kg", "angle": "deg"},
  "bodies": [ … ], "joints": [ … ], "actuators": [ … ], "forces": [ … ],
  "simulation": { … }
}
```

Every part has an `id` that is unique in the mechanism: letters, digits and `_ . -`.

### Bodies

Each body has these fields:

- `id`: required.
- `name`
- `fixed`: true for the ground or frame.
- `position` [x, y, z]
- `orientation`: `{"euler_xyz": [x, y, z]}` (X, then Y, then Z, as Blender's XYZ Euler) or
  `{"quaternion": [w, x, y, z]}`.
- `geometry`, one of:
  - `{"type": "box", "size": [x, y, z]}`
  - `{"type": "cylinder", "radius", "length", "axis": "z"}`
  - `{"type": "sphere", "radius"}`
  - `{"type": "gear", "teeth", "module", "width", "axis": "z"}`. A standard 20° involute spur gear: its mass
    properties are those of a solid cylinder on the pitch circle, and Blender draws its involute teeth.
  - `{"type": "mesh", "file": "jobs/<job id>/out/model.stl"}`. A closed STL, OBJ or PLY mesh, drawn in the body
    frame in the mechanism's length unit.

  All geometry is centred on the body's origin.
- `mass`, or `density` with a geometry.
- `center_of_mass`: needed with a mass and no geometry.
- `inertia`: `{"ixx", "iyy", "izz", "ixy", "ixz", "iyz"}`. Without it, the inertia is computed from the geometry
  (an assumption).
- `collision`: true, only with `simulation.collision.enabled`. It needs `material.friction` (and
  `material.restitution`, 0 if not given). With SMC contacts it also needs `material.young_modulus_Pa` and
  `material.poisson_ratio`. Gears do not collide by shape; join them with a `gear` joint (`"model": "contact"` for
  their teeth).
- `visual`: how Blender draws the body:
  - `{"color": "#RRGGBB"}`
  - `{"mesh_file": "jobs/<id>/out/model.stl"}`
  - `{"blend_file": …, "blender_object": …}`

Mesh files can only come from `jobs/<job id>/…` (the model jobs) or `sim/files/…`.

### Joints

Each joint names `body_a` (the base) and `body_b` (the moving body). Chrono moves body_b relative to body_a. The
types:

- `fixed`, `spherical`: `position`.
- `revolute`, `prismatic`, `cylindrical`: `position`, `axis`. Optional `limits` `{"min", "max"}`, for revolute
  (an angle) and prismatic (a travel) only. The range must contain 0, the pose at t = 0.
- `distance`: `point_a`, `point_b`. Keeps the distance between them as it is at t = 0.
- `gear`: a spur pair.
  - Fields: `joint_a`, `joint_b`, `teeth_a`, `teeth_b`, `internal` (false by default), `model` (`ideal` by
    default, or `contact`).
  - `joint_a` and `joint_b` are two revolute joints on the same base (`body_a`), with parallel axes. Declare them
    before the gear.
  - Ideal: the gears turn at exactly ω_b/ω_a = −N_a/N_b, or +N_a/N_b when `internal`. With gear geometry on both
    bodies, the centre distance must be m(N_a + N_b)/2.
  - Contact (external pairs only, both bodies with `gear` geometry): the teeth push each other along the line of
    action. Each tooth pair in contact is a spring k with damping; there is no force while the teeth are inside the
    backlash; one or two pairs touch as the gears turn (the contact ratio), so the mesh stiffens and softens; and
    Coulomb friction acts against each pair's sliding. Ask the user for what it needs, do not guess it:
    - `backlash`: the circumferential backlash on the pitch circle as mounted, both gears together, in the length
      unit (0 is allowed).
    - `friction`: the tooth friction coefficient (0 for none).
    - `mesh_stiffness_N_per_m` (one tooth pair), or `young_modulus_Pa` of the gears' material: ISO 6336's 14
      N/(mm·µm) for steel, scaled by E/206 GPa and the face width (an assumption).
    - Optional: `pressure_angle` (20° by default), `damping_ratio` (0.1 by default).
  - The centre distance may be larger than m(N_a + N_b)/2 (more backlash, a larger working pressure angle), not
    smaller. At t = 0 the teeth sit in the middle of the backlash.
  - The teeth vibrate fast: `time_step` must be at most 1/20 of the mesh period, and the validation says how small
    (about 1e-5 s for plastic module 2 gears). A second of motion then takes ten seconds or more to run.

### Actuators

- `rotational_motor`, with `mode` `angle`, `speed` or `torque`.
- `linear_actuator`, with `mode` `position`, `speed` or `force`.

Both need `body_a`, `body_b`, `position`, `axis` and `law`. When a revolute (or prismatic) joint already guides the
pair, the motor only drives. Otherwise it also acts as the joint (`guide`: `auto`, `joint` or `free`).

The `law` is one of:

- `{"type": "constant", "value"}`
- `{"type": "ramp", "start", "slope"}`
- `{"type": "sine", "amplitude", "frequency_hz", "phase", "offset"}`, with the phase in rad
- `{"type": "table", "points": [[t, v], …]}`, linear between the points and held after the last one

Values are in the mode's unit: deg/s for a speed with angle in deg, mm for a position with length in mm, N·m, N.

### Forces

- `force`: `body`, `vector` (N, in the world, or in the body with `frame: "body"`), `point` (in the body frame).
  Optional `law` for the magnitude over time.
- `torque`: `body`, `vector` (N·m). Optional `law`.
- `spring_damper`: `body_a`, `body_b`, `point_a`, `point_b` (world, t = 0), `stiffness_N_per_m`,
  `damping_Ns_per_m`. Optional `rest_length`: the length at t = 0 by default.
- `rotational_spring_damper`: `body_a`, `body_b`, `position`, `axis`, `stiffness_Nm_per_rad`,
  `damping_Nms_per_rad`, `rest_angle`.

### Simulation

- `duration` (s, required).
- `time_step` (s, required). 1e-3 suits most mechanisms; use smaller steps for fast or stiff ones.
- `output_interval` (s).
- `gravity` (m/s²): [0, 0, −9.81] by default.
- `solver`: `default`, `psor`, `apgd`, `barzilai_borwein` or `minres`.
- `integrator`: `default`, `euler_implicit_linearized`, `euler_implicit_projected` or `hht`.
- `max_iterations`, `tolerance`.
- `collision`: `{"enabled": false, "method": "nsc", "envelope", "margin"}`.
  - `nsc` (default): rigid contacts (complementarity), with friction and restitution.
  - `smc`: soft contacts (Hertz springs from each body's Young's modulus and Poisson's ratio). Use `time_step` ≤ 1e-4 s.
  - `envelope` and `margin` are in the length unit: 0.5 mm and 0.1 mm by default.
  - With collision on, `contacts.csv` holds the total contact force and torque on every colliding body.
- `constraint_tolerance`: 1e-6 m or rad by default.

A run has at most 2,000,000 steps and 200,000 output samples.

## What a run checks

- **Assembly at t = 0.** The joints must close. A run that cannot assemble fails with the joint that does not
  close.
- **Finite values.** NaN or infinity stops the run.
- **Constraint violation.** It must stay below `constraint_tolerance` all along. Over-constrained mechanisms (two
  joints doing one job, a motor fighting a joint) fail this check.
- **Theory.**
  - A speed motor's angle or position against the integral of its law. The tolerance is about one time step's
    travel.
  - An angle or position motor against its law.
  - Each ideal gear pair's speed ratio against −N_a/N_b (1e-4).
  - Each contact gear pair's turn over the run against −N_a/N_b, within what the backlash and the teeth's
    deflection allow; and, with friction and one flank driving, the tooth efficiency against Ohlendorf's
    1 − μ·H_v (ISO/TR 14179-2).
  - A colliding body that has come to rest on others: the contact force against its weight, −m·g (1 %).
- **Blender playback.** Every body's pose is compared with Chrono's (0.01 mm, 0.05°). Every revolute joint's and
  rotational motor's angle is measured on the Blender objects and compared with the joint's own coordinate, which
  catches a wrong direction of rotation.

`dof_estimate` (Grübler's count) is a hint only. A negative value means redundant constraints.
