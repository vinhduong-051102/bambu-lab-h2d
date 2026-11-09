"""
Wires between the modules of a circuit: each net joins its pins by the shortest tree (Prim, by the right-angled
distance), each branch going up from its pin, across in X then Y (or Y then X) at a routing height, and down to the
other pin. The same routes give the wires drawn in the model (`wires`) and the lengths circuit.py simulates their
resistance with, so the two always agree.

circuit["wiring"] (all optional): {"gauge": 24 (AWG), "lift": 5.0 (mm above the higher pin), "nets": {net:
{"gauge", "lift", "z" (an absolute routing height), "first": "x" | "y"}}}
"""

import math

import build123d as bd

from .geometry import pin

# AWG → (copper cross-section mm², outer diameter of the insulated wire mm)
GAUGES = {16: (1.31, 2.6), 18: (0.823, 2.3), 20: (0.518, 1.9), 22: (0.326, 1.6), 24: (0.205, 1.4), 26: (0.129, 1.2),
          28: (0.081, 1.0)}
COPPER_OHM_MM = 1.72e-5  # Ω·mm²/mm
SIGNAL_COLOURS = ["#f5a623", "#2e86de", "#27ae60", "#9b59b6", "#f1c40f", "#16a085", "#e67e22", "#8e44ad"]


def net_style(circuit, net):
    settings = (circuit.get("wiring") or {})
    own = (settings.get("nets") or {}).get(net) or {}
    gauge = own.get("gauge", settings.get("gauge", 24))
    if gauge not in GAUGES:
        raise ValueError(f"wiring gauge {gauge}: AWG {sorted(GAUGES)}.")
    return {"gauge": gauge, "lift": own.get("lift", settings.get("lift", 5.0)), "z": own.get("z"),
            "first": own.get("first", "x")}


def split(ref):
    part, _, name = ref.partition(".")
    if not part or not name:
        raise ValueError(f"circuit net member {ref!r}: write it as \"part.PIN\".")
    return part, name


def pin_positions(circuit, shapes):
    """{"part.PIN": Vector} of every pin a net names, from the placed modules (`shapes`: {label: shape})"""
    out = {}
    for net, members in (circuit.get("nets") or {}).items():
        for ref in members:
            part, name = split(ref)
            if part in shapes:
                out[ref] = pin(shapes[part], name, circuit)
    return out


def manhattan(a, b):
    return abs(a.X - b.X) + abs(a.Y - b.Y) + abs(a.Z - b.Z)


def tree(points):
    """Edges (i, j) of the shortest tree over the points (Prim)"""
    if len(points) < 2:
        return []
    inside, edges = {0}, []
    while len(inside) < len(points):
        i, j = min(((i, j) for i in inside for j in range(len(points)) if j not in inside),
                   key=lambda e: manhattan(points[e[0]], points[e[1]]))
        edges.append((i, j))
        inside.add(j)
    return edges


def path(a, b, style):
    z = style["z"] if style["z"] is not None else max(a.Z, b.Z) + style["lift"]
    mid = (bd.Vector(b.X, a.Y, z) if style["first"] == "x" else bd.Vector(a.X, b.Y, z))
    points = [a, bd.Vector(a.X, a.Y, z), mid, bd.Vector(b.X, b.Y, z), b]
    clean = [points[0]]
    for p in points[1:]:
        if (p - clean[-1]).length > 1e-6:
            clean.append(p)
    return clean


def routes(circuit, shapes):
    """{net: [{"from", "to", "points", "length_mm", "gauge", "ohms"}]}: every branch of every net whose pins are
    all on placed modules"""
    positions = pin_positions(circuit, shapes)
    out = {}
    for net, members in (circuit.get("nets") or {}).items():
        refs = [r for r in members if r in positions]
        if len(refs) < 2 or len(refs) != len(members):
            continue
        style = net_style(circuit, net)
        area = GAUGES[style["gauge"]][0]
        branches = []
        for i, j in tree([positions[r] for r in refs]):
            points = path(positions[refs[i]], positions[refs[j]], style)
            length = sum((q - p).length for p, q in zip(points, points[1:]))
            branches.append({"from": refs[i], "to": refs[j], "points": [tuple(round(c, 2) for c in p) for p in points],
                             "length_mm": round(length, 1), "gauge": style["gauge"],
                             "ohms": round(COPPER_OHM_MM * length / area, 5)})
        out[net] = branches
    return out


def net_colour(circuit, net, index, kinds):
    """Black for ground, red for a battery's or a supply's +, orange-red for other power, a colour each for signals"""
    kind = kinds.get(net)
    if kind == "gnd":
        return "#1a1a1a"
    if kind == "supply":
        return "#d62728"
    if kind == "power":
        return "#ff6f3c"
    return SIGNAL_COLOURS[index % len(SIGNAL_COLOURS)]


def net_kinds(circuit):
    """{net: gnd | supply | power | signal} from the types of its pins"""
    from . import catalog

    out = {}
    for net, members in (circuit.get("nets") or {}).items():
        types = set()
        for ref in members:
            part, name = split(ref)
            key = (circuit.get("parts") or {}).get(part)
            if key not in catalog.MODULES:
                continue
            spec = catalog.MODULES[key]
            t = catalog.pin_type(spec, name)["type"]
            if spec.get("battery") and name == spec["battery"]["plus"]:
                t = "supply"
            types.add(t)
        out[net] = ("gnd" if "gnd" in types else "supply" if "supply" in types else
                    "power" if "power" in types else "signal")
    return out


def wires(circuit, modules):
    """The wires of `circuit` between the placed `modules` (shapes made by electronics.module): one part per net,
    labelled wire_<net>, in the net's colour. Add them to the assembly; build.py leaves them off the print"""
    shapes = {str(m.label): m for m in modules}
    kinds = net_kinds(circuit)
    parts = []
    for index, (net, branches) in enumerate(routes(circuit, shapes).items()):
        radius = GAUGES[branches[0]["gauge"]][1] / 2
        pieces = []
        for branch in branches:
            points = [bd.Vector(*p) for p in branch["points"]]
            for p, q in zip(points, points[1:]):
                d = q - p
                plane = bd.Plane(origin=p, z_dir=d.normalized())
                pieces.append(plane * bd.Cylinder(radius, d.length, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN)))
            pieces += [bd.Pos(*p) * bd.Sphere(radius) for p in points[1:-1]]
        wire = bd.Compound(pieces)
        wire.label = "wire_" + "".join(c if c.isalnum() or c in "_-" else "_" for c in net)
        wire.color = net_colour(circuit, net, index, kinds)
        parts.append(wire)
    return parts


def total_length(branches):
    return math.fsum(b["length_mm"] for b in branches)
