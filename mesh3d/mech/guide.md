# Mechanical model (mech/1): guide for the agent

A design is a mechanism described part by part: what each part is, how parts are joined, what drives them and what
loads them. The platform checks the assembly (degrees of freedom, conflicts, gear meshes, geometry), turns it into a
Project Chrono model and reports results per part and for the whole system. Every design is versioned: each change is
a new revision (r1, r2, …) and nothing is overwritten.

## Rules

- **Never invent physical data.** A value the user did not give and that cannot be measured from geometry or looked
  up stays unknown: the validation lists it under `missing`, and you ask the user. A named material (`steel`, `pla`…)
  gives a handbook density, labelled `material_database`; printed parts are lighter (infill), so ask for their mass.
- Every value in the stored model carries its source: `user`, `imported_cad`, `geometry`, `material_database`,
  `solver`, `assumption` or `unknown`. Repeat assumptions to the user.
- Statuses are `passed`, `warning`, `failed` or `not_verified`. `not_verified` is never a pass.
- Repairs are only proposals. Apply one (`mech_apply_repairs` with `approved: true`) only after the user agreed to
  that proposal. Each application makes a new revision; at most 5 automatic rounds per design.
- Results are simulated with ideal rigid bodies, not measured.

## Format

```json
{
  "schema": "mech/1",
  "name": "…",
  "units": { "length": "mm", "angle": "deg" },
  "parts": [ … ], "joints": [ … ], "gears": [ … ], "motors": [ … ], "loads": [ … ],
  "simulation": { "duration": 1, "time_step": 0.0005, "gravity": [0, 0, -9.81] }
}
```

Lengths in `units.length` (mm, cm, m, in; default mm), angles in degrees, mass kg, forces N, torques N·m. Positions
and axes are in the assembly (world) frame at t = 0, Z up. Ids: letters, digits, `_ . -`, up to 64 characters.

### Parts

`{"id", "name", "role", "fixed", "shape" | "geometry_file", "position", "orientation", "material", "mass",
"center_of_mass", "inertia"}`

- `role`: ground, housing, frame, shaft, gear, pulley, crank, rod, link, slider, rocker, arm, bearing, pin, motor,
  load, other.
- `fixed: true` for the frame/housing (at least one part must be fixed).
- `orientation`: `{"euler_xyz": [rx, ry, rz]}` in degrees.
- `shape` (drawn in the part's own frame, centred on its origin):
  - `{"type": "shaft", "diameter" | "radius", "length", "axis": "x"|"y"|"z"}`
  - `{"type": "gear", "teeth", "module", "width", "bore"?, "pressure_angle"? (20), "axis"}`: involute spur gear
  - `{"type": "box", "size": [x, y, z]}`
  - `{"type": "link", "length", "width", "thickness", "hole_diameter"?}`: a bar along X with round ends, its hole
    centres at x = ±length/2
  - `{"type": "sphere", "diameter" | "radius"}`
- `geometry_file`: a mesh the platform has (`eng/models/<id>/v<n>/…`, `jobs/<id>/out/model.stl`, `sim/files/…`).
- Mass: `mass` (kg) given, or computed from the geometry and the material's density. Without both it is missing.

### Joints

`{"id", "type", "part_a", "part_b", "position", "axis"?, "limits"?}`: types fixed, revolute, prismatic, cylindrical,
spherical, distance. `planar` is read but Chrono is not wired for it (capability check refuses it). A fixed joint
welds two parts into one rigid group (a gear keyed on its shaft).

### Gears

`{"id", "gear_a", "gear_b", "internal"?, "model"?: "ideal"}`: two gear parts, each turning on a revolute joint with
a common carrier. Teeth and module come from their shapes. Checked: same module, centre distance m(z₁+z₂)/2, axes
parallel. Internal gears are not supported yet.

### Motors

`{"id", "joint", "speed_rpm", "ramp_s"?}` on a revolute/cylindrical joint, or `{"id", "joint", "mode", "law"}` with
mode speed/angle/torque (revolute) or speed/position/force (prismatic) and a law as in sim_guide (constant, ramp, sine,
table). A short `ramp_s` avoids a start-up torque spike.

### Loads

- `{"id", "type": "torque", "part", "vector": [x, y, z]}` (N·m, world)
- `{"id", "type": "force", "part", "vector", "point"?}` (N; the point in world coordinates at t = 0)
- `spring_damper` / `rotational_spring_damper`: `part_a`, `part_b` and the fields of sim_guide.

## A 3D model the user already has (preferred)

A design job (cad_ask_claude) or an imported model (inspect_3d_model) is simulated as it is, not redrawn:

1. For a mechanism, the CAD job's model.py assigns `components` and `mechanism` (cad/guide.md, "Assemblies that
   move"), so each part stays separate.
2. `mech_import_model` with `job_id` (or `model_id`): the model's setup and its state (NOT_CONFIGURED,
   NEEDS_VALIDATION, INVALID, READY, RUNNING, PAUSED, COMPLETED, FAILED) with the reason. Called again after the
   model changed, it carries the setup over to a new revision.
3. Missing data (masses, motor speed, time step) is asked for; give it with `mech_update_design`, one value at a
   time: `{"changes": {"motors": [{"id": "drive", "speed_rpm": 30}]}}`. Remove with `{"remove": {"joints": [ids]}}`.
4. `mech_simulate` with `live: true` opens it in the dashboard's 3D viewer (the user presses Simulate there too);
   without, a recorded run with results per part. `mech_get_design` with `model_id` reads the state again.

## Workflow from a written request

1. Turn the request into a model. Ask for what is missing (masses, speeds, loads, duration) rather than guessing.
   A CAD assembly: `mech_import_model` with the `model_id` from inspect_3d_model; it proposes joints (hypotheses)
   that become joints only when the user accepts them (`accept`).
2. `mech_create_design`: stores revision 1 and validates it.
3. `mech_validate`: DOF (Jacobian rank), redundant constraints, motors on locked coordinates, undriven DOF, gear
   checks, joints away from their part or hole, misaligned axes, overlaps. Fix errors with `mech_update_design`
   (a new revision) or `mech_propose_repairs` → user approval → `mech_apply_repairs`.
4. `mech_simulate`: runs Chrono (through the sim_* runner), compares to the kinematic prediction.
5. `mech_get_results`: per part (speed simulated vs expected, mass, provenance), per joint (reaction), per gear
   (tooth force), per motor (effort), system checks. Then `sim_play_simulation_in_blender` with the `sim_id`.
