"""
Parametric part geometry for the mechanical model, in mm, in the part's own frame:

  shaft / cylinder  {"diameter" | "radius", "length", "axis": "x"|"y"|"z"}       centred on the origin
  gear              {"teeth", "module", "width", "bore"?, "axis", "pressure_angle"?} standard involute spur gear,
                                                                                   a tooth on +X (before the axis turn)
  box / plate / block {"size": [x, y, z]}                                           centred
  link              {"length", "width", "thickness", "hole_diameter"?}             a bar with round ends in XY, from a
                                                                                   hole at the origin to one at +X·length
  sphere            {"radius" | "diameter"}

The meshes are closed solids (manifold booleans), so volume, centre of mass and inertia come from them exactly
for a uniform material ("geometry" provenance). A mesh file (imported CAD) is used as it is.
"""

import math

import numpy as np
import trimesh

TYPES = ("shaft", "cylinder", "gear", "box", "plate", "block", "link", "sphere")
AXES = {"x": np.array([1.0, 0, 0]), "y": np.array([0, 1.0, 0]), "z": np.array([0, 0, 1.0])}


def _num(spec, key, positive=True):
    v = spec.get(key)
    if v is None or isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or (positive and v <= 0):
        raise ValueError(f"shape.{key} phải là số dương, nhận {v!r}.")
    return float(v)


def read_shape(spec, L=1.0):
    """The shape in mm, checked"""
    if not isinstance(spec, dict) or spec.get("type") not in TYPES:
        raise ValueError(f"shape.type phải là một trong {', '.join(TYPES)}.")
    t = spec["type"]
    axis = spec.get("axis", "z")
    if axis not in AXES:
        raise ValueError("shape.axis phải là x, y hoặc z.")
    if t in ("shaft", "cylinder"):
        r = _num(spec, "radius") if "radius" in spec else _num(spec, "diameter") / 2
        return {"type": "shaft", "radius": r * L, "length": _num(spec, "length") * L, "axis": axis}
    if t == "gear":
        teeth = spec.get("teeth")
        if not isinstance(teeth, int) or isinstance(teeth, bool) or teeth < 6:
            raise ValueError(f"shape.teeth phải là số nguyên ≥ 6, nhận {teeth!r}.")
        out = {"type": "gear", "teeth": teeth, "module": _num(spec, "module") * L, "width": _num(spec, "width") * L,
               "axis": axis, "pressure_angle_deg": float(spec.get("pressure_angle", 20))}
        out["bore"] = _num(spec, "bore") * L if spec.get("bore") else 0.0
        out["pitch_radius"] = teeth * out["module"] / 2
        if out["bore"] >= 2 * (out["pitch_radius"] - 1.25 * out["module"]):
            raise ValueError("shape.bore lớn hơn vòng chân răng.")
        return out
    if t in ("box", "plate", "block"):
        size = spec.get("size")
        if not isinstance(size, (list, tuple)) or len(size) != 3 or any(not isinstance(v, (int, float)) or v <= 0 for v in size):
            raise ValueError("shape.size phải là [x, y, z] dương.")
        return {"type": "box", "size": [float(v) * L for v in size]}
    if t == "link":
        out = {"type": "link", "length": _num(spec, "length") * L, "width": _num(spec, "width") * L,
               "thickness": _num(spec, "thickness") * L,
               "hole_diameter": _num(spec, "hole_diameter") * L if spec.get("hole_diameter") else 0.0}
        if out["hole_diameter"] >= out["width"]:
            raise ValueError("shape.hole_diameter phải nhỏ hơn width.")
        return out
    r = _num(spec, "radius") if "radius" in spec else _num(spec, "diameter") / 2
    return {"type": "sphere", "radius": r * L}


def gear_outline(teeth, module, pressure_angle_deg=20.0, samples=6):
    """Standard involute spur gear outline (addendum m, dedendum 1.25 m), a tooth centred on +X, counter-clockwise"""
    alpha = math.radians(pressure_angle_deg)
    r = teeth * module / 2
    base, root, tip = r * math.cos(alpha), r - 1.25 * module, r + module

    def inv(a):
        return math.tan(a) - a

    def half(rho):
        return math.pi / (2 * teeth) + inv(alpha) - inv(math.acos(min(1.0, base / rho)))

    radii = list(np.linspace(max(base, root), tip, samples))
    flank = ([(root, half(radii[0]))] if root < base else []) + [(rho, half(rho)) for rho in radii]
    pts = []
    for i in range(teeth):
        c = 2 * math.pi * i / teeth
        side = [(rho, c - h) for rho, h in flank] + [(rho, c + h) for rho, h in reversed(flank)]
        pts += [(rho * math.cos(a), rho * math.sin(a)) for rho, a in side]
    return pts


def _turn(mesh, axis):
    """Built along Z: turned onto the shape's axis"""
    if axis == "x":
        mesh.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [0, 1, 0]))
    elif axis == "y":
        mesh.apply_transform(trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0]))
    return mesh


def build(shape):
    """The shape's closed mesh in mm, in the part frame"""
    from shapely.geometry import Point, Polygon

    t = shape["type"]
    if t == "shaft":
        return _turn(trimesh.creation.cylinder(shape["radius"], shape["length"], sections=64), shape["axis"])
    if t == "gear":
        poly = Polygon(gear_outline(shape["teeth"], shape["module"], shape["pressure_angle_deg"]))
        if shape["bore"]:
            poly = poly.difference(Point(0, 0).buffer(shape["bore"] / 2, 32))
        mesh = trimesh.creation.extrude_polygon(poly, shape["width"])
        mesh.apply_translation([0, 0, -shape["width"] / 2])
        return _turn(mesh, shape["axis"])
    if t == "box":
        return trimesh.creation.box(shape["size"])
    if t == "link":
        w = shape["width"]
        bar = Point(0, 0).buffer(w / 2, 32).union(Point(shape["length"], 0).buffer(w / 2, 32)).convex_hull
        if shape["hole_diameter"]:
            for x in (0, shape["length"]):
                bar = bar.difference(Point(x, 0).buffer(shape["hole_diameter"] / 2, 32))
        mesh = trimesh.creation.extrude_polygon(bar, shape["thickness"])
        mesh.apply_translation([0, 0, -shape["thickness"] / 2])
        return mesh
    return trimesh.creation.icosphere(subdivisions=4, radius=shape["radius"])


def mass_properties(mesh, density_kg_m3=None, mass_kg=None):
    """(mass kg, centre of mass mm in the mesh frame, inertia kg·mm² about the centre of mass) for a uniform solid of
    the given density or mass; None when neither is known or the mesh is not a closed solid"""
    if not (mesh.is_watertight and mesh.volume > 0) or (density_kg_m3 is None and mass_kg is None):
        return None
    volume_m3 = mesh.volume * 1e-9
    density = density_kg_m3 if mass_kg is None else mass_kg / volume_m3
    mass = density * volume_m3
    # trimesh's moment_inertia is for density 1 in mesh units (mm⁵): kg/mm³ × mm⁵ = kg·mm²
    inertia = np.asarray(mesh.moment_inertia) * density * 1e-9
    return mass, np.asarray(mesh.center_mass), inertia
