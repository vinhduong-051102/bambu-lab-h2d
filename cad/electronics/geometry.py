"""
Modules as build123d shapes (catalog.py), and what the case needs to hold them: standoffs, cradles and the openings
their ports need. A module's shape is built in its own frame and placed with a Location (`Pos * Rot * shape`, which
keeps it whole): its pins and ports are read back from where it ended up (`shape.location`), so place modules
only by moving them, never by booleans, and at the top level of the assembly.
"""

import build123d as bd

from . import catalog

CENTER_MIN = (bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN)

# Which module key each label stands for, for the helpers called on a shape in the same model run
_KEYS = {}


def _box(x, y, z, length, width, height):
    return bd.Pos(x, y, z) * bd.Box(length, width, height, align=CENTER_MIN)


def _coloured(shape, colour):
    shape.color = colour
    return shape


def module(key, name, location=None):
    """The module `key` of the catalogue as a part labelled `name` (the name the circuit gives it), placed at
    `location` (a Location, or a Pos * Rot); its frame is the catalogue's"""
    spec = catalog.get(key)
    solids = []
    board = spec["board"]
    if board:
        length, width, thick = board
        if spec.get("round"):
            plate = bd.Cylinder(length / 2, thick, align=CENTER_MIN) - bd.Cylinder(spec["round"] / 2, thick, align=CENTER_MIN)
        else:
            plate = bd.Box(length, width, thick, align=CENTER_MIN)
        solids.append(_coloured(plate, spec["color"]))
    for x, y, z, length, width, height, colour in spec.get("blocks", []):
        solids.append(_coloured(_box(x, y, z, length, width, height), colour))
    for x, y, z, diameter, height, colour in spec.get("cylinders", []):
        solids.append(_coloured(bd.Pos(x, y, z) * bd.Cylinder(diameter / 2, height, align=CENTER_MIN), colour))
    for y, colour in spec.get("cells", []):
        cell = bd.Pos(0, y, 2.0 + 9.25) * bd.Rot(0, 90, 0) * bd.Cylinder(9.25, 65.0)
        solids.append(_coloured(cell, colour))
    if spec.get("holes"):
        drills = [bd.Pos(x, y, -1) * bd.Cylinder(d / 2, 200, align=CENTER_MIN) for x, y, d in spec["holes"]]
        cut = []
        for solid in solids:
            colour = solid.color
            for drill in drills:
                solid = solid - drill
            cut.append(_coloured(solid, colour))
        solids = cut
    shape = bd.Compound([s for s in solids if s.solids()])
    shape.label = name
    shape.color = spec["color"]
    _KEYS[name] = key
    return shape.moved(location) if location is not None else shape


def key_of(shape, circuit=None):
    name = str(getattr(shape, "label", "") or "")
    key = (circuit or {}).get("parts", {}).get(name) or _KEYS.get(name)
    if key is None:
        raise ValueError(f"{name!r} is not a module made by electronics.module (or named in circuit['parts']).")
    return key


def local_to_world(shape, point):
    return (shape.location * bd.Location(bd.Vector(*point))).position


def direction_to_world(shape, direction):
    origin = (shape.location * bd.Location(bd.Vector(0, 0, 0))).position
    return (local_to_world(shape, direction) - origin).normalized()


def pin(shape, name, circuit=None):
    """Where a wire meets pin `name` of a placed module, in the model's frame"""
    spec = catalog.get(key_of(shape, circuit))
    if name not in spec["pins"]:
        raise ValueError(f"{shape.label}: no pin {name!r} on {spec['name']} (pins: {list(spec['pins'])}).")
    return local_to_world(shape, spec["pins"][name])


def board_bottom(shape):
    """Z of the module's bottom face (its frame's Z = 0) at its origin: what standoffs rise to"""
    return local_to_world(shape, (0, 0, 0)).Z


def _opening(at, direction, size, shape_kind, depth, back):
    """A box (or cylinder) of `size` across `direction`, from `back` behind `at` to `depth` in front of it"""
    d = bd.Vector(*direction).normalized()
    origin = bd.Vector(*at) - d * back
    x_dir = bd.Vector(1, 0, 0) if abs(d.Z) > 0.9 else bd.Vector(0, 0, 1).cross(d).normalized()
    plane = bd.Plane(origin=origin, x_dir=x_dir, z_dir=d)
    width, height = size
    if shape_kind == "round":
        body = bd.Cylinder(max(width, height) / 2, depth + back, align=CENTER_MIN)
    else:
        body = bd.Box(width, height, depth + back, align=CENTER_MIN)
    return plane * body


def port_cutout(shape, port, depth=15.0, clearance=0.4, back=1.0, circuit=None):
    """The opening a case needs in front of a placed module's port (subtract it from the case): the port's size
    plus `clearance` on every side, from `back` behind its face to `depth` in front"""
    spec = catalog.get(key_of(shape, circuit))
    if port not in spec["ports"]:
        raise ValueError(f"{shape.label}: no port {port!r} on {spec['name']} (ports: {list(spec['ports'])}).")
    p = spec["ports"][port]
    size = (p["size"][0] + 2 * clearance, p["size"][1] + 2 * clearance)
    local = _opening(p["at"], p["dir"], size, p["shape"], depth, back)
    return local.moved(shape.location)


def port_probe(shape, port, circuit=None, depth=12.0):
    """What must stay clear in front of a port for it to be reached: a little smaller than the port, from just in
    front of its face (build.py's check)"""
    spec = catalog.get(key_of(shape, circuit))
    p = spec["ports"][port]
    size = (max(p["size"][0] - 0.8, 0.5), max(p["size"][1] - 0.8, 0.5))
    return _opening(p["at"], p["dir"], size, p["shape"], depth, -0.5).moved(shape.location)


SCREW_PILOT = {1.6: 1.3, 1.8: 1.5, 2.1: 1.7, 2.2: 1.7, 3.0: 2.6, 3.2: 2.6}


def standoffs(shape, floor_z, outer=5.5, pilot=None, circuit=None):
    """Posts from `floor_z` up to the bottom of a placed (level) module, one under each of its mounting holes, each
    with a pilot hole for a self-tapping screw (M2 → Ø1.7, M3 → Ø2.6)"""
    spec = catalog.get(key_of(shape, circuit))
    if not spec.get("holes"):
        raise ValueError(f"{spec['name']} has no mounting holes: hold it with electronics.cradle.")
    top = board_bottom(shape)
    height = top - floor_z
    if height < 0.6:
        raise ValueError(f"{shape.label} sits {height:.1f} mm above the floor: no room for standoffs.")
    posts = None
    for x, y, d in spec["holes"]:
        c = local_to_world(shape, (x, y, 0))
        post = bd.Pos(c.X, c.Y, floor_z) * bd.Cylinder(outer / 2, height, align=CENTER_MIN)
        hole = bd.Pos(c.X, c.Y, floor_z + 0.8) * bd.Cylinder((pilot or SCREW_PILOT.get(d, d * 0.8)) / 2, height,
                                                             align=CENTER_MIN)
        post = post - hole
        posts = post if posts is None else posts + post
    return posts


def cradle(shape, floor_z, wall=1.6, clearance=0.3, ledge=3.0, rise=1.5, circuit=None):
    """For a level board without mounting holes: ledges under its two short ends up to its bottom and corner
    guides around it to `rise` above its top, `clearance` from its edges. The board drops in from above; a lid or
    a clip keeps it down"""
    spec = catalog.get(key_of(shape, circuit))
    if not spec["board"]:
        raise ValueError(f"{spec['name']} is not a board: hold it by its holes or a pocket of its own.")
    length, width, thick = spec["board"]
    pins_x = [abs(p[0]) for p in spec["pins"].values()]
    free = length / 2 - (max(pins_x) if pins_x else 0) - 1.0
    ledge = max(1.0, min(ledge, free))
    bottom = board_bottom(shape)
    if bottom - floor_z < 0.6:
        raise ValueError(f"{shape.label} sits {bottom - floor_z:.1f} mm above the floor: no room for a cradle.")
    out_l, out_w = length + 2 * (clearance + wall), width + 2 * (clearance + wall)
    parts = []
    for sx in (-1, 1):
        # Ledge under the end of the board
        parts.append(_box(sx * (length / 2 - ledge / 2), 0, floor_z - bottom, ledge, width, bottom - floor_z))
        for sy in (-1, 1):
            # An L around each corner
            cx, cy = sx * (out_l / 2 - wall / 2), sy * (out_w / 2 - 3.0)
            parts.append(_box(cx, cy, floor_z - bottom, wall, 6.0, bottom - floor_z + thick + rise))
            parts.append(_box(sx * (out_l / 2 - 3.0), sy * (out_w / 2 - wall / 2), floor_z - bottom, 6.0, wall,
                              bottom - floor_z + thick + rise))
    held = parts[0]
    for p in parts[1:]:
        held = held + p
    # Built in the module's frame, level, and placed where the module is
    return held.moved(shape.location)
