# Modelling for the Bambu Lab H2D with build123d

A model is one Python file that builds the part with build123d (https://build123d.readthedocs.io) and
assigns the finished solid to a variable named `result`. The build runner executes the file, exports
`result` to STL and STEP, renders a preview and checks it.

## Rules

- Units are millimetres. Z points up; the part sits on the build plate at Z = 0 (its lowest point at Z = 0)
  in the orientation it should be printed in, with its largest flat face down where possible.
- `result` must be one solid, or a `Compound` of solids for a set of parts printed together, with a real
  volume. Not a sketch, a face or a wire.
- Keep every dimension that a user might want to change as a named variable at the top of the file, with a
  short comment, e.g. `wall = 2.0  # wall thickness`.
- Fit the H2D: one part at most 320 × 320 × 320 mm (X × Y × Z). Leave room on the plate between parts.
- Design for FDM printing with a 0.4 mm nozzle:
  - walls at least 1.2 mm (3 lines), thin features no thinner than 0.8 mm;
  - overhangs no steeper than 45° from vertical, or chamfer them; prefer chamfers to fillets on edges that
    face down;
  - bridges under 20 mm;
  - holes print about 0.2 mm small: add 0.2 mm to the diameter of holes for screws, pins and shafts;
  - parts that fit together need 0.2–0.3 mm clearance per side;
  - text embossed or engraved at least 0.6 mm deep and 5 mm tall.
- No imports beyond build123d, math and the standard library. No file or network access. The one exception:
  for a tolerance calibration print (holes, pins and fit slots to measure the printer's real tolerances), use
  `from calibration import calibration_plate` and `result = calibration_plate()` rather than drawing one.

## build123d in brief

```python
from build123d import *

width, depth, height = 60.0, 40.0, 20.0  # outer size
wall = 2.0                               # wall thickness
hole_d = 3.4                             # M3 clearance hole, printed oversize

with BuildPart() as part:
    Box(width, depth, height, align=(Align.CENTER, Align.CENTER, Align.MIN))
    # Hollow it out from the top face, keeping the walls and the floor
    offset(amount=-wall, openings=part.faces().sort_by(Axis.Z)[-1])
    # Two holes through the floor
    with Locations((-20, 0, 0), (20, 0, 0)):
        Cylinder(hole_d / 2, wall, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    chamfer(part.edges().group_by(Axis.Z)[0], length=0.6)

result = part.part
```

- Builders: `BuildPart` (solids), `BuildSketch` (2D faces, used with `extrude`, `revolve`, `loft`, `sweep`),
  `BuildLine` (curves for sketches and sweep paths).
- Solids: `Box`, `Cylinder`, `Cone`, `Sphere`, `Torus`, `Wedge`, `Hole`, `CounterBoreHole`,
  `CounterSinkHole`. 2D: `Rectangle`, `RectangleRounded`, `Circle`, `Ellipse`, `Polygon`,
  `RegularPolygon`, `SlotOverall`, `Text`.
- `mode=Mode.SUBTRACT` cuts, `Mode.INTERSECT` intersects; `Locations`, `GridLocations`, `PolarLocations`
  place copies; `Plane.XZ`, `Plane.YZ` or a face (`part.faces().sort_by(Axis.Z)[-1]`) start a sketch on it.
- Select edges/faces with `.edges()`, `.faces()`, `.filter_by(Axis.Z)`, `.sort_by(Axis.Z)`, `.group_by(...)`,
  then `fillet(edges, radius=...)` / `chamfer(edges, length=...)`.
- Without builders (algebra mode) shapes combine with `+`, `-`, `&` and move with `Pos(x, y, z) * shape`
  and `Rot(0, 0, 45) * shape`.

## Assemblies that move

When the request is a mechanism or several parts that work together (a hinge, gears on shafts, a crank and a
slider…), keep every part separate so the dashboard can simulate the model as it is:

- Assign `components = {"name": solid, ...}`: each part on its own, **in its assembled place** (shafts in their
  holes, gears meshing). Names: letters, digits, `_`, `-`. `result` is then the print layout (parts laid flat,
  apart), or leave it out to print the assembly as it stands.
- When the user said how it moves, also assign `mechanism`, naming parts by their component name (mm, degrees,
  kg, N, N·m; positions and axes in the assembled frame):

```python
mechanism = {
    "parts": {"base": {"fixed": True, "role": "frame", "material": "pla"},
              "arm": {"role": "arm", "material": "pla"}},
    "joints": [{"id": "hinge", "type": "revolute", "part_a": "base", "part_b": "arm",
                "position": [0, 0, 20], "axis": [0, 1, 0]}],
    "motors": [{"id": "drive", "joint": "hinge", "speed_rpm": 30}],
    "simulation": {"duration": 2, "time_step": 0.001},
}
```

  Roles: frame, housing, shaft, gear, pulley, crank, rod, link, slider, rocker, arm, bearing, pin, other. Joint
  types: fixed, revolute, prismatic, cylindrical, spherical. `gears`: `[{"id", "gear_a", "gear_b",
  "teeth_a", "teeth_b"}]`, each gear on its own revolute joint to a common part. Parts may give `mass`
  (kg), `collision: True` with `friction`. Only write what the user asked for or what the design itself fixes (a
  joint is where you put the pin): never invent a motor speed, a load or a mass the user did not give. What is
  missing is asked for in the dashboard before simulating.
