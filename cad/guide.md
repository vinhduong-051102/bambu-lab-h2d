# Modelling for the Bambu Lab H2D with text-to-cad (cadgen + build123d)

A model is one Python file, `model.py`, written the way text-to-cad's `cad` skill writes models: a function with
no parameters, decorated `@model` from `cadgen`, that returns a build123d shape
(https://build123d.readthedocs.io). cadgen's engine builds it. The build runner (`python /opt/cad/build.py
model.py`) builds the file's last `@model` (or the one `MODEL = "name"` names), exports it to STL, STEP and GLB,
draws a preview with `cadgen snapshot` and checks it against the printer. The `cad` skill and its references
(model contract, build123d, positioning, inspection, kinematics) are the rules for the code itself; this guide adds
what printing on the H2D needs.

## Rules

- Units are millimetres. Z points up; the part sits on the build plate at Z = 0 (its lowest point at Z = 0)
  in the orientation it should be printed in, with its largest flat face down where possible.
- The model returns one solid, or for parts that work together an assembly: a `Compound` of labelled children,
  each part (or sub-assembly) in its assembled place (see below). Not a sketch, a face or a wire.
- Keep every dimension that a user might want to change as a named constant at the top of the file (numbers at
  module level, kernel objects inside the function), with a short comment, e.g. `WALL = 2.0  # wall thickness`.
- Give every part a `label` and a `color` (sRGB, `"#4a6fa5"`); a `material` from `bd_materials` when it matters.
- Fit the H2D: one part at most 320 × 320 × 320 mm (X × Y × Z). Leave room on the plate between parts.
- Design for FDM printing with a 0.4 mm nozzle:
  - walls at least 1.2 mm (3 lines), thin features no thinner than 0.8 mm;
  - overhangs no steeper than 45° from vertical, or chamfer them; prefer chamfers to fillets on edges that
    face down;
  - bridges under 20 mm;
  - holes print about 0.2 mm small: add 0.2 mm to the diameter of holes for screws, pins and shafts;
  - parts that fit together need 0.2–0.3 mm clearance per side;
  - text embossed or engraved at least 0.6 mm deep and 5 mm tall.
- Imports: build123d, cadgen, bd_materials, math and the standard library. Vendor parts (a bearing, a servo, a
  screw) may come from step.parts (the `step-parts` skill) into `vendor/` beside model.py, read with `read_step`
  in the body; they are not printed (list them in `not_printed`). Electronic modules (boards, servos, batteries,
  switches) and their wires come from `electronics` (`/opt/cad/electronics.md`), with a `circuit` the build
  checks and simulates; they are left off the print by themselves. For a tolerance calibration print (holes, pins
  and fit slots to measure the printer's real tolerances), return `calibration_plate()` from
  `from calibration import calibration_plate` rather than drawing one.

## A part

```python
import build123d as bd
from cadgen import model

WIDTH, DEPTH, HEIGHT = 60.0, 40.0, 20.0  # outer size
WALL = 2.0                               # wall thickness
HOLE_D = 3.4                             # M3 clearance hole, printed oversize


@model
def box():
    body = bd.Box(WIDTH, DEPTH, HEIGHT, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    # Hollow it out from the top face, keeping the walls and the floor
    body = bd.offset(body, amount=-WALL, openings=body.faces().sort_by(bd.Axis.Z)[-1])
    # Two holes through the floor
    for x in (-20, 20):
        body -= bd.Pos(x, 0, 0) * bd.Cylinder(HOLE_D / 2, WALL, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    body = bd.chamfer(body.edges().group_by(bd.Axis.Z)[0], length=0.6)
    body.label = "box"
    body.color = "#4a6fa5"
    return body


if __name__ == "__main__":
    box()
```

- `python model.py` (cadgen's own run) prints the model's id and its bounds; `cadgen snapshot <id> tmp/x.png
  --camera top` draws one view, `cadgen inspect <id> [ref]` measures. build.py is the build the dashboard keeps:
  run it after every change, it writes `out/`.
- An assertion in the body on what the geometry measures (`assert abs(body.bounding_box().size.X - WIDTH) < 1e-6`)
  checks a dimension the user gave.

## Assemblies that move

When the request is a mechanism or several parts that work together (a hinge, gears on shafts, a crank and a
slider…), keep every part separate, in its assembled place:

- Return an assembly, as the `cad` skill composes one: each part its own `@model` (or a helper), placed **in its
  assembled place** (shafts in their holes, gears meshing), labelled, and the parts returned as
  `bd.Compound(children=[...])`. Each child of the assembly is a component, named by its label (letters, digits,
  `_`, `-`; unique). An assembly of sub-assemblies (a robot's links, each holding its printed parts, servos and
  bearings) gives every part in them; name the ones to print in `print_parts = ["base", "arm", ...]` at module
  level, and the rest (bought, wired, drawn for fit) stays out of the print layout. Don't lay the parts out for printing: build.py does it, each part on the face it prints best
  on, packed onto as many H2D plates as it takes (report.json `print_layout`; model.3mf has the plates). Parts
  that are bought, not printed (a steel shaft, a screw, a spring, a step.parts bearing): list them in
  `not_printed = ["shaft"]` at module level (a `mechanism` part of metal is left out by itself). Only when a part
  must print in a particular way the build can't guess, set `print_layout = "manual"`: the model is then printed as
  it stands, so return the parts laid out for printing.
- How it moves is shown in text-to-cad's CAD Viewer (🧭 CAD Viewer on the dashboard): give the model build123d joints
  and cadgen's mechanism states (the `cad` skill's kinematics), which also pose the model in the GLB and the
  snapshots. Nothing simulates the physics (forces, motor torque, masses): the motion is kinematic only.
- When the parts are jointed together, also assign `mechanism` at module level, naming parts by their component name
  (mm, degrees; positions and axes in the assembled frame). build.py reads it to leave metal parts off the print
  layout, and the assembly guide below to work out the order:

```python
mechanism = {
    "parts": {"base": {"fixed": True, "material": "pla"}, "arm": {"material": "pla"},
              "pin": {"material": "steel"}},
    "joints": [{"id": "hinge", "type": "revolute", "part_a": "base", "part_b": "arm",
                "position": [0, 0, 20], "axis": [0, 1, 0]}],
}
```

  Parts: `fixed` (the frame the others go onto), `material` (a metal one, steel or brass…, is bought, not
  printed). Joint types: fixed, revolute, prismatic, cylindrical, spherical. `gears`: `[{"id", "gear_a", "gear_b",
  "teeth_a", "teeth_b"}]`, each gear on its own revolute joint to a common part. Only write what the user asked for
  or what the design itself fixes (a joint is where you put the pin).
- The dashboard draws an assembly guide from it (a picture per step and a video): the fixed parts first, then each
  part after the one it is jointed to, along its joint's axis. When the order or the way in matters (a shaft that
  takes its gears before it goes into the housing, a lid last), assign `assembly_steps` at module level, in
  Vietnamese:

```python
assembly_steps = [
    {"parts": ["shaft", "gear"], "text": "Lồng bánh răng vào trục trước khi lắp trục vào vỏ."},
    {"parts": ["housing"], "text": "Đặt vỏ xuống, đưa trục vào hai lỗ ổ.", "direction": [0, 0, -1]},
]
```

  `direction` is the way the parts move to their place (mm-frame vector); parts left out go on after, in the order
  above. Name only components.
