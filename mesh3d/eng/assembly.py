"""
Step 3: an assembly of components. What can be measured on the meshes is measured; what a joint is, the user says.

- Cylindrical features: groups of connected faces parallel to an axis whose vertices lie on a circle (fitted by
  least squares, the residual and the angle they cover checked) with normals pointing away from the axis (a shaft)
  or towards it (a hole).
- Coaxial pairs: a hole of one component and a shaft of another on the same line (axes within 1°, offset within
  the radial clearance): a revolute (or cylindrical) joint is *suggested*, never assumed.
- Touching pairs: components closer than `touch_mm`.
- Joints the user confirms are kept in the model version's assembly.json and used by the motion setup.
"""

import math
from pathlib import Path

import numpy as np
import trimesh

from . import geometry, schema
from .schema import FAIL, NOT_EVALUATED, PASS, WARNING, check
from .store import EngError, read_json, write_json

AXIS_TOLERANCE = 0.03  # |n·a| below this: a face parallel to the axis
MIN_FACES = 12
MAX_RESIDUAL = 0.01  # vertex distance spread / radius
MIN_COVER_DEG = 200  # a cylinder covers most of the circle (a fillet or a half-round slot is not a bearing)
COAXIAL_DEG = 1.0
JOINT_TYPES = ("fixed", "revolute", "prismatic", "cylindrical", "spherical", "gear")


def candidate_axes(mesh):
    """The world axes and the mesh's principal axes, without near-duplicates"""
    axes = [np.eye(3)[i] for i in range(3)]
    if geometry.solid_ok(mesh):
        _, vectors = trimesh.inertia.principal_axis(mesh.moment_inertia)
        axes += [v / np.linalg.norm(v) for v in vectors]
    out = []
    for a in axes:
        if all(abs(np.dot(a, b)) < math.cos(math.radians(2)) for b in out):
            out.append(a)
    return out


def fit_circle(points2d):
    """Least-squares circle (Kåsa): centre, radius"""
    x, y = points2d[:, 0], points2d[:, 1]
    a = np.column_stack([x, y, np.ones_like(x)])
    b = x * x + y * y
    sol, *_ = np.linalg.lstsq(a, b, rcond=None)
    cx, cy = sol[0] / 2, sol[1] / 2
    r = math.sqrt(max(sol[2] + cx * cx + cy * cy, 0.0))
    return np.array([cx, cy]), r


def plane_basis(axis):
    helper = np.array([1.0, 0, 0]) if abs(axis[0]) < 0.9 else np.array([0, 1.0, 0])
    u = np.cross(axis, helper)
    u /= np.linalg.norm(u)
    return u, np.cross(axis, u)


def cylinders(mesh, min_radius=0.3):
    """Cylindrical faces of a mesh: [{"kind": "hole"|"shaft", "axis", "center", "radius", "length", "cover_deg",
    "residual", "faces"}], centre on the axis at the middle of the face group"""
    found = []
    normals, centres = mesh.face_normals, mesh.triangles_center
    adjacency = mesh.face_adjacency
    for axis in candidate_axes(mesh):
        side = np.abs(normals @ axis) < AXIS_TOLERANCE
        if side.sum() < MIN_FACES:
            continue
        pairs = adjacency[side[adjacency[:, 0]] & side[adjacency[:, 1]]]
        groups = trimesh.graph.connected_components(pairs, nodes=np.nonzero(side)[0], min_len=MIN_FACES)
        u, v = plane_basis(axis)
        for group in groups:
            verts = mesh.vertices[np.unique(mesh.faces[group])]
            flat = np.column_stack([verts @ u, verts @ v])
            centre2, r = fit_circle(flat)
            if r < min_radius or r > 1e4:
                continue
            dist = np.linalg.norm(flat - centre2, axis=1)
            residual = float(np.ptp(dist) / r)
            if residual > MAX_RESIDUAL:
                continue
            angles = np.sort(np.arctan2(flat[:, 1] - centre2[1], flat[:, 0] - centre2[0]))
            gaps = np.diff(np.concatenate([angles, angles[:1] + 2 * math.pi]))
            cover = 360 - math.degrees(float(gaps.max()))
            if cover < MIN_COVER_DEG:
                continue
            c3 = centres[group]
            radial = np.column_stack([c3 @ u, c3 @ v]) - centre2
            radial /= np.linalg.norm(radial, axis=1, keepdims=True)
            n2 = np.column_stack([normals[group] @ u, normals[group] @ v])
            direction = float(np.mean(np.sum(radial * n2, axis=1)))
            if abs(direction) < 0.9:
                continue
            along = verts @ axis
            mid = (along.min() + along.max()) / 2
            centre = centre2[0] * u + centre2[1] * v + mid * axis
            # Same feature seen from two candidate axes: keep one
            if any(abs(abs(np.dot(f["axis"], axis)) - 1) < 1e-3 and np.linalg.norm(f["center"] - centre) < 1e-3
                   for f in found):
                continue
            found.append({"kind": "shaft" if direction > 0 else "hole", "axis": axis, "center": centre,
                          "radius": r, "length": float(along.max() - along.min()), "cover_deg": cover,
                          "residual": residual, "faces": len(group), "span": (float(along.min()), float(along.max()))})
    return found


def feature_json(cid, k, f):
    return {"id": f"{cid}.{f['kind']}{k}", "component": cid, "kind": f["kind"],
            "diameter": round(2 * f["radius"], 4), "axis": np.round(f["axis"], 6).tolist(),
            "center": np.round(f["center"], 4).tolist(), "length": round(f["length"], 4),
            "cover_deg": round(f["cover_deg"], 1), "fit_residual": round(f["residual"], 5)}


def all_features(meshes):
    out = []
    for cid, mesh in meshes.items():
        for k, f in enumerate(cylinders(mesh), 1):
            out.append((feature_json(cid, k, f), f))
    return out


def coaxial_pairs(features):
    """Hole of one component, shaft of another, on one line and overlapping along it"""
    pairs = []
    for hj, h in features:
        if h["kind"] != "hole":
            continue
        for sj, s in features:
            if s["kind"] != "shaft" or sj["component"] == hj["component"]:
                continue
            angle = math.degrees(math.acos(min(1.0, abs(float(np.dot(h["axis"], s["axis"]))))))
            if angle > COAXIAL_DEG:
                continue
            d = s["center"] - h["center"]
            offset = float(np.linalg.norm(d - np.dot(d, h["axis"]) * h["axis"]))
            radial = h["radius"] - s["radius"]
            if offset > max(abs(radial), 0.05) + 0.05 * h["radius"]:
                continue
            # Overlap along the hole's axis
            hc, sc = float(np.dot(h["center"], h["axis"])), float(np.dot(s["center"], h["axis"]))
            overlap = min(hc + h["length"] / 2, sc + s["length"] / 2) - max(hc - h["length"] / 2, sc - s["length"] / 2)
            if overlap <= 0:
                continue
            pairs.append({"hole": hj["id"], "shaft": sj["id"], "hole_component": hj["component"],
                          "shaft_component": sj["component"], "hole_diameter": hj["diameter"],
                          "shaft_diameter": sj["diameter"],
                          "diametral_clearance": round(hj["diameter"] - sj["diameter"], 4),
                          "axis_angle_deg": round(angle, 4), "axis_offset": round(offset, 4),
                          "engagement_length": round(float(overlap), 4),
                          "axis": hj["axis"], "position": hj["center"]})
    return pairs


def min_distance(a, b, samples=20000):
    """The smallest gap between two surfaces (mm) and where, from surface samples of each onto the other"""
    best = (math.inf, None, None)
    for x, y in ((a, b), (b, a)):
        pts = np.vstack([x.vertices, trimesh.sample.sample_surface(x, samples, seed=3)[0]])
        closest, dist, _ = trimesh.proximity.closest_point(y, pts)
        i = int(np.argmin(dist))
        if dist[i] < best[0]:
            best = (float(dist[i]), pts[i], closest[i])
    return best


def assembly_file(model):
    return Path(model["_dir"]) / "assembly.json"


def read_joints(r, joints, components):
    out = []
    for i, j in enumerate(joints or []):
        path = f"joints[{i}]"
        if not isinstance(j, dict):
            r.error(path, "Phải là object.")
            continue
        jt = r.choice(j, "type", path, JOINT_TYPES)
        for key in ("component_a", "component_b"):
            if j.get(key) not in components:
                r.error(f"{path}.{key}", f"Không có chi tiết {j.get(key)!r} (có: {', '.join(components)}).")
        axis = r.vector(j, "axis", path, unit=True, required=jt in ("revolute", "prismatic", "cylindrical"))
        pos = r.vector(j, "position", path, required=jt != "fixed")
        out.append({"id": str(j.get("id") or f"j{i + 1}"), "type": jt, "component_a": j.get("component_a"),
                    "component_b": j.get("component_b"), "axis": axis, "position": pos,
                    "confirmed_by": "user", "note": j.get("note")})
    return out


def analyze(model, joints=None, touch_mm=0.05):
    """Step 3: components, their placement, overlaps, cylindrical features, coaxial pairs, touching pairs and the
    joints they suggest; with `joints`, stores the user's joints for this model version"""
    result = schema.new_result("assembly", model, {"joints": joints, "touch_mm": touch_mm})
    ms = geometry.meshes(model)
    r = schema.Reader()
    confirmed = read_joints(r, joints, ms)
    if r.errors:
        raise EngError(422, "INVALID_JOINTS", "Khớp chưa hợp lệ.", r.errors)
    stored = read_json(assembly_file(model), {"joints": []})
    if joints is not None:
        stored = {"joints": confirmed}
        write_json(assembly_file(model), stored)

    placement = {cid: {"bounds_min": m.bounds[0].round(4).tolist(), "bounds_max": m.bounds[1].round(4).tolist(),
                       "center_of_mass": m.center_mass.round(4).tolist() if geometry.solid_ok(m) else None}
                 for cid, m in ms.items()}
    features = all_features(ms)
    pairs = coaxial_pairs(features)
    overlaps = geometry.interference(ms) if len(ms) > 1 else []
    touching = []
    ids = list(ms)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            lo = np.maximum(ms[a].bounds[0], ms[b].bounds[0]) - touch_mm
            hi = np.minimum(ms[a].bounds[1], ms[b].bounds[1]) + touch_mm
            if np.any(lo > hi):
                continue
            gap, pa, _ = min_distance(ms[a], ms[b], samples=4000)
            if gap <= touch_mm:
                touching.append({"a": a, "b": b, "gap": round(gap, 5), "at": np.round(pa, 3).tolist()})

    suggestions = []
    for p in pairs:
        kind = "revolute" if p["diametral_clearance"] > 0 else "fixed"
        suggestions.append({
            "type": kind, "component_a": p["hole_component"], "component_b": p["shaft_component"],
            "axis": np.round(p["axis"], 6).tolist(), "position": np.round(p["position"], 4).tolist(),
            "confidence": "medium" if p["diametral_clearance"] > 0 else "low",
            "reason": (f"Lỗ Ø{p['hole_diameter']:.3f} và trục Ø{p['shaft_diameter']:.3f} đồng trục "
                       f"(lệch {p['axis_offset']:.3g} mm, {p['axis_angle_deg']:.2g}°), ăn sâu "
                       f"{p['engagement_length']:.3g} mm" + (": khe hở → quay hoặc trượt dọc trục (cylindrical)."
                                                              if kind == "revolute" else
                                                              ": không có khe hở → lắp chặt (fixed)?")),
            "needs_confirmation": True})
    result["data"] = {"components": placement, "features": [fj for fj, _ in features], "coaxial": [
        {k: (np.round(v, 6).tolist() if isinstance(v, np.ndarray) else v) for k, v in p.items()} for p in pairs],
        "overlaps": overlaps, "touching": touching, "suggested_joints": suggestions,
        "joints": stored["joints"]}
    checks = result["checks"]
    for o in overlaps:
        if o["volume"] is not None:
            checks.append(check(f"overlap.{o['a']}.{o['b']}", FAIL, f"Giao nhau {o['a']} / {o['b']}",
                                f"Chồng lên nhau {o['volume']:.4g} mm³ ở vị trí lắp.", o["volume"], 0, "mm³"))
        else:
            checks.append(check(f"overlap.{o['a']}.{o['b']}", NOT_EVALUATED, f"Giao nhau {o['a']} / {o['b']}",
                                o["note"]))
    if len(ms) > 1 and not overlaps:
        checks.append(check("overlap", PASS, "Giao nhau ở vị trí lắp", "Không có chi tiết nào chồng lên nhau."))
    for p in pairs:
        status = PASS if p["axis_angle_deg"] <= 0.1 and p["axis_offset"] <= 0.01 else WARNING
        checks.append(check(f"coaxial.{p['hole']}.{p['shaft']}", status, f"Đồng tâm {p['hole']} / {p['shaft']}",
                            f"Lệch tâm {p['axis_offset']:.4g} mm, lệch góc {p['axis_angle_deg']:.3g}°.",
                            p["axis_offset"], 0.01, "mm"))
    if len(ms) > 1:
        if stored["joints"]:
            checks.append(check("joints", PASS, "Khớp đã được xác nhận",
                                f"{len(stored['joints'])} khớp do người dùng khai báo."))
        else:
            checks.append(check("joints", NOT_EVALUATED, "Khớp cơ khí",
                                f"Chưa có khớp nào được xác nhận; {len(suggestions)} khớp đề xuất từ hình học cần "
                                "người dùng xác nhận (analyze_assembly với joints)."))
    result["status"] = schema.overall(checks)
    return result
