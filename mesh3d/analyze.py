"""
The parts of a model that matter for printing it (docs/studio.md, "Thành phần của mẫu"), measured on its mesh for
Studio's "AI tối ưu": the gateway compares them with the parts of earlier prints, whose settings and outcomes are
known. No GPU: the mesh worker runs it next to its queue (POST /analyze).

The mesh is first turned and scaled to match the numbers Studio sent for the object (size, volume, base and overhang
area, worked out exactly as the Studio patch does), so the parts are measured as the object sits on the plate. When no
axis-aligned turn matches, the object was placed some other way and nothing is measured.

Parts ("features"), each with an id, its kind, numbers and where it is (mm, the object's corner at 0,0,0):
  base        what stands on the plate: contact area, footprint, how tall the object is for it
  thin_wall   walls under THIN_MM thick (rays from the surface straight in)
  thin_plate  plates under THIN_MM thick, lying flat
  overhang    surfaces facing down more than 45° from vertical, off the plate (the area Studio counts as overhang)
  ceiling     the flat ones among those: bridges and roofs
  hole        round openings through the part, vertical or horizontal, with their diameter
  pillar      narrow columns standing tall for their width
  top         large flat surfaces facing up (where the top layers show)
Two renders from six sides are written: the model, and the same with each part in its own colour (`colour` names it).
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
import trimesh

COS45 = math.sqrt(0.5)
# A wall or plate thinner than this takes few perimeters with a 0.4 mm nozzle (0.45 mm lines)
THIN_MM = 2.5
THICKNESS_SAMPLES = 4000
# Cells for grouping thin spots into walls
CLUSTER_MM = 6.0
SECTIONS = 16
MAX_HOLE_MM = 25.0
PILLAR_WIDTH_MM = 6.0
MAX_FEATURES = 14
# Studio's numbers agree with a turned mesh within these
SIZE_TOLERANCE = 0.03
MATCH_TOLERANCE = 0.2

# Distinct colours for the parts on the coloured render, with the names Claude is told
PALETTE = [
    ("đỏ", (220, 38, 38)), ("cam", (234, 120, 20)), ("vàng", (234, 196, 20)), ("xanh lá", (34, 160, 70)),
    ("xanh ngọc", (20, 170, 170)), ("xanh dương", (37, 99, 235)), ("tím", (124, 58, 237)), ("hồng", (219, 39, 160)),
    ("nâu", (140, 90, 40)), ("xanh nõn chuối", (140, 200, 30)), ("xanh rêu", (70, 110, 60)), ("hồng nhạt", (244, 150, 180)),
    ("xanh nhạt", (120, 180, 240)), ("đen", (30, 30, 30)),
]
BASE_GREY = (200, 200, 200)

SIX_VIEWS = [
    ("Front (−Y)", 0, -90, "y"), ("Back (+Y)", 0, 90, "y"), ("Left (−X)", 0, 180, "x"),
    ("Right (+X)", 0, 0, "x"), ("Isometric front", 25, -60, None), ("Isometric back", 25, 120, None),
]


def r1(v):
    return round(float(v), 1)


def r2(v):
    return round(float(v), 2)


# ---------- Loading and placing ----------

def load_mesh(path):
    mesh = trimesh.load(path, force="mesh", process=True)
    if not isinstance(mesh, trimesh.Trimesh) or not len(mesh.faces):
        raise ValueError("Không đọc được lưới trong file.")
    return mesh


def studio_numbers(mesh):
    """What the Studio patch reports for an object (ai_describe_object), for this mesh as it is"""
    tris = mesh.triangles
    cross = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    twice = np.linalg.norm(cross, axis=1)
    ok = twice > 0
    nz = np.zeros(len(tris))
    nz[ok] = cross[ok, 2] / twice[ok]
    down = ok & (nz < -COS45)
    projected = twice / 2 * -nz
    on_bed = tris[:, :, 2].max(axis=1) < mesh.bounds[0][2] + 0.05
    return {
        "size_mm": mesh.extents.tolist(),
        "volume_mm3": float(abs(mesh.volume)),
        "surface_area_mm2": float(twice[ok].sum() / 2),
        "base_area_mm2": float(projected[down & on_bed].sum()),
        "overhang_area_mm2": float(projected[down & ~on_bed].sum()),
    }


def axis_turns():
    """The 24 turns that keep the axes on axes"""
    turns = []
    for perm in ([0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]):
        for signs in np.ndindex(2, 2, 2):
            m = np.zeros((3, 3))
            for row, col in enumerate(perm):
                m[row, col] = 1 if signs[row] else -1
            if np.linalg.det(m) > 0:
                turns.append(m)
    return turns


def rel(a, b, floor):
    return abs(a - b) / max(abs(b), floor)


def orient(mesh, target):
    """The mesh turned and scaled to the object Studio described (`target`), or (None, why) when no axis-aligned turn
    fits. Without a target the mesh stays as it is."""
    if not target:
        return mesh, {"matched": None, "turn": None, "scale": 1.0}
    want = np.array(target["size_mm"], dtype=float)
    best = None
    for turn in axis_turns():
        extents = np.abs(turn @ mesh.extents)
        ratios = want / np.maximum(extents, 1e-6)
        if ratios.max() / ratios.min() > 1 + SIZE_TOLERANCE:
            continue
        scale = float(ratios.mean())
        candidate = mesh.copy()
        matrix = np.eye(4)
        matrix[:3, :3] = turn * scale
        candidate.apply_transform(matrix)
        got = studio_numbers(candidate)
        error = (
            rel(got["volume_mm3"], target.get("volume_mm3", got["volume_mm3"]), 100)
            + rel(got["base_area_mm2"], target.get("base_area_mm2", got["base_area_mm2"]), 100)
            + rel(got["overhang_area_mm2"], target.get("overhang_area_mm2", got["overhang_area_mm2"]), 100)
        )
        if best is None or error < best[0]:
            best = (error, candidate, turn, scale)
    if best is None:
        return None, {"matched": False, "reason": "Kích thước trong Studio không khớp file (đã xoay chéo hoặc co giãn không đều)."}
    error, candidate, turn, scale = best
    if error > MATCH_TOLERANCE:
        return None, {"matched": False, "reason": f"Hướng đặt trong Studio không khớp file (sai lệch {error:.2f}).", "error": r2(error)}
    return candidate, {"matched": True, "turn": turn.astype(int).tolist(), "scale": round(scale, 4), "error": r2(error)}


def place(mesh):
    """Corner of the bounding box at 0,0,0: the numbers below read as distances from the left, front and plate"""
    mesh = mesh.copy()
    mesh.apply_translation(-mesh.bounds[0])
    return mesh


# ---------- Parts ----------

def bbox(points):
    points = np.asarray(points)
    lo, hi = points.min(axis=0), points.max(axis=0)
    return {"x": [r1(lo[0]), r1(hi[0])], "y": [r1(lo[1]), r1(hi[1])], "z": [r1(lo[2]), r1(hi[2])]}


def face_groups(mesh, mask):
    """Faces in `mask` grouped by shared edges, largest area first"""
    faces = np.flatnonzero(mask)
    if not len(faces):
        return []
    adjacency = mesh.face_adjacency
    keep = mask[adjacency[:, 0]] & mask[adjacency[:, 1]]
    groups = trimesh.graph.connected_components(adjacency[keep], nodes=faces, min_len=1)
    return sorted(groups, key=lambda g: -mesh.area_faces[g].sum())


def base_part(mesh):
    normals = mesh.face_normals
    on_bed = (normals[:, 2] < -COS45) & (mesh.triangles[:, :, 2].max(axis=1) < 0.05)
    area = float((mesh.area_faces[on_bed] * -normals[on_bed, 2]).sum())
    if not on_bed.any():
        return None, on_bed
    foot = mesh.triangles[on_bed].reshape(-1, 3)
    width = np.ptp(foot[:, :2], axis=0)
    height = mesh.extents[2]
    return {
        "kind": "base",
        "metrics": {
            "contact_mm2": round(area),
            "footprint_mm": [r1(width[0]), r1(width[1])],
            # Of the footprint's own box: low means feet or a thin rim on the plate
            "contact_share": r2(area / max(width[0] * width[1], 1)),
            "height_mm": r1(height),
            # Tall for a narrow footprint: tips over, needs a brim
            "height_per_width": r2(height / max(min(width), 1)),
        },
        "where": bbox(foot),
    }, on_bed


def thickness_parts(mesh):
    """Thin walls and thin plates: points of the surface whose ray straight in meets the other side within THIN_MM,
    grouped by nearness"""
    points, faces = trimesh.sample.sample_surface(mesh, THICKNESS_SAMPLES, seed=1)
    inward = -mesh.face_normals[faces]
    hits, rays, _ = mesh.ray.intersects_location(points + inward * 0.01, inward, multiple_hits=False)
    depth = np.full(len(points), np.nan)
    if len(rays):
        depth[rays] = np.linalg.norm(np.asarray(hits).reshape(-1, 3) - points[rays], axis=1)
    thin = ~np.isnan(depth) & (depth < THIN_MM)
    if not thin.any():
        return []
    from scipy import ndimage

    cells = np.floor(points / CLUSTER_MM).astype(int)
    lo = cells.min(axis=0)
    grid = np.zeros(cells.max(axis=0) - lo + 1, dtype=bool)
    grid[tuple((cells[thin] - lo).T)] = True
    labels, count = ndimage.label(grid, structure=np.ones((3, 3, 3)))
    point_labels = np.where(thin, labels[tuple((cells - lo).T)], 0)
    per_point = mesh.area / len(points)
    parts = []
    for label in range(1, count + 1):
        members = point_labels == label
        area = members.sum() * per_point
        if area < max(40.0, 0.01 * mesh.area):
            continue
        d = depth[members]
        upright = np.abs(mesh.face_normals[faces[members], 2]) < 0.5
        kind = "thin_wall" if upright.mean() >= 0.5 else "thin_plate"
        where = bbox(points[members])
        parts.append({
            "kind": kind,
            "metrics": {
                "thin_mm": r2(np.percentile(d, 10)),
                "median_mm": r2(np.median(d)),
                "area_mm2": round(area),
                "height_mm": r1(where["z"][1] - where["z"][0]),
            },
            "where": where,
            "_faces": np.unique(faces[members]),
        })
    return sorted(parts, key=lambda p: -p["metrics"]["area_mm2"])[:5]


def down_parts(mesh, on_bed):
    """Overhangs and flat ceilings (bridges, roofs), by connected surface"""
    normals = mesh.face_normals
    nz = normals[:, 2]
    mask = (nz < -COS45) & ~on_bed
    parts = []
    for group in face_groups(mesh, mask):
        areas = mesh.area_faces[group]
        projected = float((areas * -nz[group]).sum())
        if projected < 20:
            break
        flat = nz[group] < -0.98
        flat_share = float(areas[flat].sum() / areas.sum())
        # 0° is a flat ceiling, 45° the steepest Studio still counts
        angle = float(np.degrees(np.arccos(np.clip(-nz[group], -1, 1))) @ areas / areas.sum())
        centres = mesh.triangles_center[group]
        # What is under it: the plate, or the part itself (and how far down)
        sample = centres[np.linspace(0, len(centres) - 1, min(30, len(centres))).astype(int)]
        hits, rays, _ = mesh.ray.intersects_location(sample - [0, 0, 0.01], np.tile([0, 0, -1.0], (len(sample), 1)), multiple_hits=False)
        gaps = sample[:, 2].copy()
        if len(rays):
            gaps[rays] = sample[rays, 2] - np.asarray(hits).reshape(-1, 3)[:, 2]
        over_part = len(rays) / len(sample)
        # A chamfer at the foot: it rests on the first layers, nothing to hold up
        if float(np.median(gaps)) < 1.0:
            continue
        where = bbox(mesh.triangles[group].reshape(-1, 3))
        metrics = {
            "area_mm2": round(projected),
            "angle_from_flat_deg": round(angle),
            "flat_share": r2(flat_share),
            "height_mm": where["z"][0],
            "gap_below_mm": r1(np.median(gaps)),
            "over": "part" if over_part > 0.5 else "plate",
        }
        kind = "overhang"
        if flat_share > 0.7:
            kind = "ceiling"
            flats = mesh.triangles[group][flat].reshape(-1, 3)
            metrics["span_mm"] = r1(min(np.ptp(flats[:, 0]), np.ptp(flats[:, 1])))
            # A step of a chamfer or the elephant-foot trim, not something that hangs in the air
            if metrics["span_mm"] < 1.5:
                continue
        parts.append({"kind": kind, "metrics": metrics, "where": where, "_faces": np.asarray(group)})
        if len(parts) >= 12:
            break
    return parts


def section_polygons(mesh, axis, value):
    """The cross-section where coordinate `axis` = value, as shapely polygons with a function to bring 2-D points back"""
    normal = np.zeros(3)
    normal[axis] = 1
    origin = np.zeros(3)
    origin[axis] = value
    path = mesh.section(plane_origin=origin, plane_normal=normal)
    if path is None:
        return [], None
    try:
        planar, to_3d = path.to_2D()
    except Exception:  # noqa: BLE001 - a degenerate slice
        return [], None
    return list(planar.polygons_full), to_3d


def hole_parts(mesh):
    """Round openings: inner rings of cross-sections across each axis, followed through the slices"""
    found = []
    for axis in (2, 0, 1):
        lo, hi = mesh.bounds[0][axis], mesh.bounds[1][axis]
        for value in np.linspace(lo + 0.5, hi - 0.5, SECTIONS):
            polygons, to_3d = section_polygons(mesh, axis, value)
            for polygon in polygons:
                for ring in polygon.interiors:
                    from shapely.geometry import Polygon

                    hole = Polygon(ring)
                    if hole.area <= 0:
                        continue
                    diameter = 2 * math.sqrt(hole.area / math.pi)
                    if diameter > MAX_HOLE_MM or diameter < 0.8:
                        continue
                    roundness = 4 * math.pi * hole.area / max(hole.length ** 2, 1e-9)
                    centre = trimesh.transform_points([[*hole.centroid.coords[0], 0]], to_3d)[0]
                    found.append((axis, centre, diameter, roundness, value))
    # The same hole in neighbouring slices: one entry with how far it goes
    holes = []
    for axis, centre, diameter, roundness, value in found:
        others = [i for i in (0, 1, 2) if i != axis]
        for hole in holes:
            if hole["axis"] == axis and np.linalg.norm(hole["centre"][others] - centre[others]) < 1.0 and abs(hole["d"] - diameter) < 0.15 * diameter:
                hole["span"] = [min(hole["span"][0], value), max(hole["span"][1], value)]
                hole["round"] = min(hole["round"], roundness)
                break
        else:
            holes.append({"axis": axis, "centre": centre, "d": diameter, "round": roundness, "span": [value, value]})
    # Seen in one slice only: a dimple or a seam of the mesh, not a hole through anything
    holes = [h for h in holes if h["span"][1] > h["span"][0] and h["d"] >= 1.0]
    parts = []
    for hole in sorted(holes, key=lambda h: h["d"])[:12]:
        centre = hole["centre"]
        lo, hi = centre.copy(), centre.copy()
        lo[hole["axis"]], hi[hole["axis"]] = hole["span"]
        r = hole["d"] / 2
        others = [i for i in (0, 1, 2) if i != hole["axis"]]
        for i in others:
            lo[i] -= r
            hi[i] += r
        parts.append({
            "kind": "hole",
            "metrics": {
                "diameter_mm": r2(hole["d"]),
                "direction": "đứng" if hole["axis"] == 2 else "ngang",
                "length_mm": r1(hole["span"][1] - hole["span"][0]),
                "round": hole["round"] > 0.85,
            },
            "where": bbox([lo, hi]),
        })
    return parts


def pillar_parts(mesh):
    """Narrow columns: islands of horizontal slices under PILLAR_WIDTH_MM wide, stacked tall for their width"""
    narrow = []
    lo, hi = mesh.bounds[0][2], mesh.bounds[1][2]
    for z in np.linspace(lo + 0.3, hi - 0.3, SECTIONS * 2):
        polygons, to_3d = section_polygons(mesh, 2, z)
        for polygon in polygons:
            rect = polygon.minimum_rotated_rectangle
            xs, ys = rect.exterior.coords.xy
            sides = [math.dist((xs[i], ys[i]), (xs[i + 1], ys[i + 1])) for i in range(2)]
            width = min(sides)
            if width < PILLAR_WIDTH_MM:
                centre = trimesh.transform_points([[*polygon.centroid.coords[0], 0]], to_3d)[0]
                narrow.append((centre, width, z))
    columns = []
    for centre, width, z in narrow:
        for column in columns:
            if np.linalg.norm(column["centre"][:2] - centre[:2]) < 3.0:
                column["z"] = [min(column["z"][0], z), max(column["z"][1], z)]
                column["w"] = min(column["w"], width)
                break
        else:
            columns.append({"centre": centre, "w": width, "z": [z, z]})
    parts = []
    for column in columns:
        height = column["z"][1] - column["z"][0]
        if height < 10 or height < 3 * column["w"]:
            continue
        c, w = column["centre"], column["w"]
        parts.append({
            "kind": "pillar",
            "metrics": {"width_mm": r1(w), "height_mm": r1(height), "height_per_width": r1(height / max(w, 0.5))},
            "where": bbox([[c[0] - w, c[1] - w, column["z"][0]], [c[0] + w, c[1] + w, column["z"][1]]]),
        })
    return sorted(parts, key=lambda p: -p["metrics"]["height_per_width"])[:4]


def top_parts(mesh):
    nz = mesh.face_normals[:, 2]
    parts = []
    for group in face_groups(mesh, nz > 0.98):
        area = float(mesh.area_faces[group].sum())
        if area < 100:
            break
        where = bbox(mesh.triangles[group].reshape(-1, 3))
        parts.append({"kind": "top", "metrics": {"area_mm2": round(area), "height_mm": where["z"][1]}, "where": where, "_faces": np.asarray(group)})
        if len(parts) >= 3:
            break
    return parts


# The numbers that make two parts "the same" when a model repeats them (four wheels, six screw holes)
SAME_BY = {
    "thin_wall": ("thin_mm", "height_mm"), "thin_plate": ("thin_mm", "area_mm2"), "overhang": ("area_mm2", "angle_from_flat_deg", "height_mm"),
    "ceiling": ("area_mm2", "span_mm", "height_mm"), "hole": ("diameter_mm", "length_mm"), "pillar": ("width_mm", "height_mm"),
    "top": ("area_mm2", "height_mm"),
}


def alike(a, b):
    if a["kind"] != b["kind"] or a["kind"] not in SAME_BY:
        return False
    if a["metrics"].get("direction") != b["metrics"].get("direction"):
        return False
    return all(abs(a["metrics"][k] - b["metrics"][k]) <= 0.05 * max(abs(a["metrics"][k]), abs(b["metrics"][k]), 1) for k in SAME_BY[a["kind"]])


def group_repeats(parts):
    """Repeated parts as one, with how many there are and the box around them all"""
    groups = []
    for part in parts:
        for group in groups:
            if alike(group, part):
                group["count"] += 1
                for axis in "xyz":
                    group["where"][axis] = [min(group["where"][axis][0], part["where"][axis][0]), max(group["where"][axis][1], part["where"][axis][1])]
                if part.get("_faces") is not None:
                    group["_faces"] = np.concatenate([group["_faces"], part["_faces"]])
                group["_wheres"].append(part["where"])
                break
        else:
            groups.append({**part, "count": 1, "where": {k: list(v) for k, v in part["where"].items()}, "_wheres": [part["where"]]})
    return groups


def faces_in(mesh, where):
    lo = np.array([where["x"][0], where["y"][0], where["z"][0]]) - 0.3
    hi = np.array([where["x"][1], where["y"][1], where["z"][1]]) + 0.3
    centres = mesh.triangles_center
    return np.flatnonzero(np.all((centres >= lo) & (centres <= hi), axis=1))


# ---------- Run ----------

def analyse(path, target=None, views_dir=None):
    mesh = load_mesh(path)
    turned, orientation = orient(mesh, target)
    if turned is None:
        return {"orientation": orientation, "features": []}
    mesh = place(turned)

    base, on_bed = base_part(mesh)
    parts = ([base] if base else []) + thickness_parts(mesh) + down_parts(mesh, on_bed) + hole_parts(mesh) + pillar_parts(mesh) + top_parts(mesh)
    parts = group_repeats(parts)[:MAX_FEATURES]

    colours = np.tile(np.array(BASE_GREY, dtype=float), (len(mesh.faces), 1))
    features = []
    for i, part in enumerate(parts):
        name, rgb = PALETTE[i % len(PALETTE)]
        faces = part.pop("_faces", None)
        wheres = part.pop("_wheres")
        if faces is None:
            faces = np.concatenate([faces_in(mesh, where) for where in wheres])
        colours[faces] = rgb
        features.append({"id": f"F{i + 1}", **part, "colour": name})

    result = {
        "orientation": orientation,
        "size_mm": [r1(v) for v in mesh.extents],
        "volume_mm3": round(float(abs(mesh.volume))),
        "faces": len(mesh.faces),
        "features": features,
    }
    if views_dir:
        sys.path.insert(0, "/opt/cad")
        import build  # cad/build.py: the CAD worker's preview renderer

        views_dir = Path(views_dir)
        views_dir.mkdir(parents=True, exist_ok=True)
        build.render_preview(mesh.triangles.tolist(), mesh.extents, str(views_dir / "views.png"), views=SIX_VIEWS)
        build.render_preview(mesh.triangles.tolist(), mesh.extents, str(views_dir / "parts.png"), face_colours=colours, views=SIX_VIEWS)
        result["views"] = ["views.png", "parts.png"]
    return result


if __name__ == "__main__":
    # python analyze.py model.stl [target.json] [views_dir]
    target = json.loads(Path(sys.argv[2]).read_text()) if len(sys.argv) > 2 and sys.argv[2] != "-" else None
    print(json.dumps(analyse(sys.argv[1], target, sys.argv[3] if len(sys.argv) > 3 else None), ensure_ascii=False, indent=1))
