"""
Step 1 and 2 of the engineering pipeline: import a model and check its geometry.

Import reads STL, OBJ, PLY, OFF, GLB/GLTF (trimesh), 3MF (every object and build item, in its declared unit) and
.blend (every visible mesh object, with modifiers, in the world, through Blender). STEP is refused with the reason:
the mesh worker has no CAD kernel. The given files are copied untouched; each component is stored as PLY in mm.

Units: 3MF and .blend say theirs. STL, OBJ, PLY carry none: the caller's `units`, else mm, listed as an assumption.

validate() separates what is certainly wrong for a printable solid (no faces, inverted normals, non-manifold edges,
self-intersections) from what the user has to confirm (open edges: a shell or surface may be meant; several bodies
in one component; degenerate or duplicate faces).
"""

import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import trimesh

from . import schema
from .schema import FAIL, NOT_EVALUATED, PASS, WARNING, check
from .store import EngError, copy_source, new_version_dir, now, sha256, write_json, BLENDER_CMD

MESH_SUFFIXES = (".stl", ".obj", ".ply", ".off", ".glb", ".gltf")
MAX_FACES = 2_000_000
THREEMF_UNITS = {"micron": 0.001, "millimeter": 1.0, "centimeter": 10.0, "inch": 25.4, "foot": 304.8, "meter": 1000.0}


# ---------- import ----------

def read_3mf(path):
    """[(name, vertices in the file's unit, faces, 4×4 build transform)], and the unit in mm. Components that refer
    to other objects are followed; each build item is one part."""
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".model")]
        if not names:
            raise EngError(422, "BAD_3MF", "File 3MF không có 3D/3dmodel.model.")
        text = {n: z.read(n).decode("utf-8", "replace") for n in names}
    root = next((n for n in names if n.lower().endswith("3dmodel.model")), names[0])
    unit_match = re.search(r'<model[^>]*\sunit="([a-z]+)"', text[root])
    unit = THREEMF_UNITS.get(unit_match.group(1) if unit_match else "millimeter", 1.0)
    objects = {}
    for body in text.values():
        for m in re.finditer(r'<object\b([^>]*)>(.*?)</object>', body, re.S):
            attrs, inner = m.group(1), m.group(2)
            oid = re.search(r'\sid="(\d+)"', attrs).group(1)
            name = (re.search(r'\sname="([^"]*)"', attrs) or [None, f"object {oid}"])[1]
            verts = np.array(re.findall(r'<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"', inner), dtype=float)
            tris = np.array(re.findall(r'<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"', inner), dtype=np.int64)
            parts = [(c.group(1), transform(c.group(2))) for c in
                     re.finditer(r'<component\s+[^>]*objectid="(\d+)"(?:[^>]*transform="([^"]*)")?', inner)]
            objects[oid] = {"name": name, "vertices": verts.reshape(-1, 3), "faces": tris.reshape(-1, 3),
                            "parts": parts}

    def flatten(oid, matrix, depth=0):
        if depth > 8 or oid not in objects:
            return []
        o = objects[oid]
        out = []
        if len(o["faces"]):
            out.append((o["vertices"], o["faces"], matrix))
        for child, m in o["parts"]:
            out += flatten(child, matrix @ m, depth + 1)
        return out

    items = re.findall(r'<item\s+[^>]*objectid="(\d+)"(?:[^>]*transform="([^"]*)")?', text[root])
    result = []
    for oid, tf in items or [(k, "") for k in objects]:
        pieces = flatten(oid, transform(tf))
        if not pieces:
            continue
        verts, faces, offset = [], [], 0
        for v, f, m in pieces:
            verts.append(v @ m[:3, :3].T + m[:3, 3])
            faces.append(f + offset)
            offset += len(v)
        result.append((objects[oid]["name"], np.vstack(verts), np.vstack(faces)))
    return result, unit


def transform(text):
    """A 3MF transform "m00 m01 m02 m10 … m32" (row vectors) as a 4×4 matrix for column vectors"""
    m = np.eye(4)
    if text:
        v = [float(x) for x in text.split()]
        if len(v) == 12:
            m[:3, :3] = np.array(v[:9]).reshape(3, 3).T
            m[:3, 3] = v[9:]
    return m


def read_blend(path):
    """[(object name, vertices in Blender units, faces)] and mm per Blender unit, through Blender itself"""
    with tempfile.TemporaryDirectory() as tmp:
        cmd = [*BLENDER_CMD, "-b", str(path), "--factory-startup", "--python",
               str(Path(__file__).with_name("blend_export.py")), "--", tmp]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        info_path = Path(tmp) / "objects.json"
        if proc.returncode != 0 or not info_path.exists():
            raise EngError(422, "BLEND_EXPORT_FAILED", "Blender không đọc được file .blend: " +
                           (proc.stderr or proc.stdout)[-400:])
        info = json.loads(info_path.read_text())
        parts = []
        for o in info["objects"]:
            data = np.load(Path(tmp) / o["file"])
            parts.append((o["name"], data["vertices"], data["faces"]))
    scale = info["scale_length"] * 1000.0 if info.get("unit_system") != "NONE" else 1.0
    return parts, scale


def read_any(path):
    """[(name, vertices, faces)], mm per file unit (None when the format has no unit)"""
    suffix = path.suffix.lower()
    if suffix == ".3mf":
        return read_3mf(path)
    if suffix == ".blend":
        return read_blend(path)
    if suffix in (".step", ".stp", ".iges", ".igs"):
        raise EngError(415, "CAD_NOT_SUPPORTED",
                       "STEP/IGES cần nhân CAD (OpenCascade) mà container mesh không có. Xuất STL hoặc 3MF từ phần "
                       "mềm CAD (giữ đơn vị mm), hoặc dùng mô hình build123d của job CAD (out/model.stl).")
    if suffix not in MESH_SUFFIXES:
        raise EngError(415, "FORMAT_NOT_SUPPORTED", f"Không đọc được định dạng {suffix} (dùng STL, 3MF, OBJ, PLY, "
                                                    "GLB, .blend).")
    loaded = trimesh.load(path, process=True)
    if isinstance(loaded, trimesh.Scene):
        parts = []
        for node in loaded.graph.nodes_geometry:
            matrix, geom = loaded.graph[node]
            g = loaded.geometry[geom]
            if not isinstance(g, trimesh.Trimesh):
                continue
            g = g.copy()
            g.apply_transform(matrix)
            parts.append((str(node), np.asarray(g.vertices), np.asarray(g.faces)))
        return parts, None
    if not isinstance(loaded, trimesh.Trimesh):
        raise EngError(422, "NO_MESH", f"{path.name} không chứa lưới tam giác.")
    return [(path.stem, np.asarray(loaded.vertices), np.asarray(loaded.faces))], None


def import_model(sources, name=None, units=None, model_id=None, split_bodies=False):
    """Reads every source into one model (a new version when model_id is given): its components in mm. `sources` is
    [{"path": absolute path, "label": what the caller named it}]."""
    if not sources:
        raise EngError(400, "NO_SOURCES", "Cần ít nhất một file.")
    if units is not None and units not in schema.LENGTH_UNITS:
        raise EngError(400, "BAD_UNITS", f"units phải là một trong {', '.join(schema.LENGTH_UNITS)}.")
    model_id = model_id or schema_id()
    folder, version = new_version_dir(model_id)
    components, assumptions, warnings = [], [], []
    for src in sources:
        path = Path(src["path"])
        stored = copy_source(path, folder)
        parts, file_scale = read_any(path)
        if file_scale is None:
            scale = schema.LENGTH_UNITS[units or "mm"]
            if units is None:
                assumptions.append({"path": src["label"], "message": f"{path.suffix.upper()[1:]} không ghi đơn vị: "
                                                                      "coi là mm."})
        else:
            scale = file_scale
            if units is not None and abs(schema.LENGTH_UNITS[units] - file_scale) > 1e-9:
                warnings.append({"path": src["label"], "message": f"File ghi đơn vị riêng ({file_scale:g} mm/đơn vị), "
                                                                  f"khác units = {units}: dùng đơn vị của file."})
        if not parts:
            warnings.append({"path": src["label"], "message": "Không có lưới tam giác nào trong file."})
        for part_name, verts, faces in parts:
            # A single-mesh file is named after the file the user gave, not the stored copy (uploads get a prefix)
            if part_name == path.stem:
                part_name = Path(str(src["label"] or path.name)).stem
            if len(faces) > MAX_FACES:
                raise EngError(413, "TOO_LARGE", f"{part_name}: {len(faces)} mặt, quá {MAX_FACES}.")
            mesh = trimesh.Trimesh(np.asarray(verts, float) * scale, np.asarray(faces, np.int64), process=True)
            pieces = mesh.split(only_watertight=False) if split_bodies and mesh.body_count > 1 else [mesh]
            for k, piece in enumerate(pieces):
                cid = component_id(part_name if len(pieces) == 1 else f"{part_name}-{k + 1}", components)
                out = folder / "components" / f"{cid}.ply"
                piece.export(out)
                components.append({"id": cid, "name": part_name if len(pieces) == 1 else f"{part_name} ({k + 1})",
                                   "file": f"components/{cid}.ply", "source": stored.name, "source_label": src["label"],
                                   "source_sha256": sha256(stored), "scale_to_mm": scale,
                                   "faces": int(len(piece.faces)), "vertices": int(len(piece.vertices))})
    model = {"model_id": model_id, "version": version, "name": name or Path(sources[0]["path"]).stem,
             "units": "mm", "created_at": now(), "components": components, "assumptions": assumptions,
             "warnings": warnings}
    write_json(folder / "model.json", model)
    model["_dir"] = str(folder)
    return model


def schema_id():
    from .store import new_id

    return new_id("m")


def component_id(name, existing):
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "part"
    taken = {c["id"] for c in existing}
    cid, n = base, 2
    while cid in taken:
        cid, n = f"{base}-{n}", n + 1
    return cid


def load_component(model, cid):
    comp = next((c for c in model["components"] if c["id"] == cid), None)
    if comp is None:
        raise EngError(404, "COMPONENT_NOT_FOUND",
                       f"Không có chi tiết {cid!r} (có: {', '.join(c['id'] for c in model['components'])}).")
    return trimesh.load(Path(model["_dir"]) / comp["file"], force="mesh", process=False)


def meshes(model):
    return {c["id"]: load_component(model, c["id"]) for c in model["components"]}


# ---------- inspection ----------

def edge_counts(mesh):
    """How many faces share each undirected edge"""
    edges = np.sort(mesh.edges, axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    return counts


def solid_ok(mesh):
    """Volume and mass properties can be trusted: closed, consistently wound, outward"""
    return bool(mesh.is_watertight and mesh.is_winding_consistent and mesh.volume > 0)


def describe(mesh):
    lo, hi = mesh.bounds
    out = {"faces": int(len(mesh.faces)), "vertices": int(len(mesh.vertices)),
           "bounds_min": lo.round(4).tolist(), "bounds_max": hi.round(4).tolist(), "size": (hi - lo).round(4).tolist(),
           "surface_area": round(float(mesh.area), 4), "bodies": int(mesh.body_count),
           "watertight": bool(mesh.is_watertight), "winding_consistent": bool(mesh.is_winding_consistent),
           "edge_length_median": round(float(np.median(mesh.edges_unique_length)), 5) if len(mesh.faces) else None}
    if solid_ok(mesh):
        out.update(volume=round(float(mesh.volume), 4), center_of_mass=mesh.center_mass.round(4).tolist(),
                   # Per unit density (mm⁵): times the density in g/mm³ gives g·mm²
                   inertia_per_density=np.asarray(mesh.moment_inertia).round(4).tolist())
    else:
        out.update(volume=None, center_of_mass=None,
                   volume_note="Không tính thể tích: lưới không kín hoặc hướng mặt không nhất quán.")
    return out


def inspect(model):
    """Step 1: what each component is and how big; the whole assembly's box"""
    result = schema.new_result("inspect", model)
    ms = meshes(model)
    comps = {cid: describe(m) for cid, m in ms.items()}
    allpoints = np.vstack([m.bounds for m in ms.values()]) if ms else np.zeros((2, 3))
    result["data"] = {"name": model["name"], "units": "mm", "components": comps,
                      "assembly_bounds_min": allpoints.min(axis=0).round(4).tolist(),
                      "assembly_bounds_max": allpoints.max(axis=0).round(4).tolist(),
                      "assembly_size": (allpoints.max(axis=0) - allpoints.min(axis=0)).round(4).tolist(),
                      "sources": [{k: c[k] for k in ("id", "source", "source_label", "source_sha256", "scale_to_mm")}
                                  for c in model["components"]]}
    result["assumptions"] += model.get("assumptions", [])
    result["warnings"] += model.get("warnings", [])
    for cid, d in comps.items():
        result["checks"].append(check(f"{cid}.volume", PASS if d["volume"] is not None else NOT_EVALUATED,
                                      f"Thể tích {cid}", f"{d['volume']:.4g} mm³" if d["volume"] is not None
                                      else d["volume_note"], d["volume"], unit="mm³"))
    result["status"] = schema.overall(result["checks"])
    return result


# ---------- validation ----------

def self_intersections(mesh):
    """Faces that cut through other faces of the same mesh (MeshLab's filter), or None when it cannot tell"""
    try:
        import pymeshlab
    except ImportError:
        return None
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=np.asarray(mesh.vertices, float),
                               face_matrix=np.asarray(mesh.faces, np.int32)))
    ms.compute_selection_by_self_intersections_per_face()
    return int(ms.current_mesh().selected_face_number())


def validate_component(cid, mesh, intent="solid", line_width=None):
    """The checks of one component. `intent` is "solid" (meant to print as a closed part) or "surface" (a shell or
    sheet on purpose: open edges are then expected)"""
    checks = []
    if len(mesh.faces) == 0:
        return [check(f"{cid}.empty", FAIL, f"{cid}: không có mặt nào", "Lưới rỗng.")]
    counts = edge_counts(mesh)
    open_edges, nonmanifold = int((counts == 1).sum()), int((counts > 2).sum())
    areas = mesh.area_faces
    degenerate = int((areas < 1e-10 * max(1.0, mesh.area)).sum())
    duplicate = int(len(mesh.faces) - len(np.unique(np.sort(mesh.faces, axis=1), axis=0)))

    checks.append(check(f"{cid}.nonmanifold", FAIL if nonmanifold else PASS, f"{cid}: cạnh không đa tạp",
                        f"{nonmanifold} cạnh dùng chung bởi hơn 2 mặt" if nonmanifold else "Mỗi cạnh có tối đa 2 mặt.",
                        nonmanifold, 0, "cạnh"))
    if open_edges:
        loops = len(mesh.outline().entities) if open_edges else 0
        status = WARNING if intent == "solid" else PASS
        detail = (f"{open_edges} cạnh hở ({loops} vòng biên). Nếu chi tiết là khối đặc thì đây là lỗ thủng và không "
                  "tính được thể tích; nếu là vỏ/mặt cố ý thì đặt intent = \"surface\"." if intent == "solid"
                  else f"{open_edges} cạnh hở ({loops} vòng biên), đúng với một mặt/vỏ.")
        checks.append(check(f"{cid}.open_edges", status, f"{cid}: cạnh hở", detail, open_edges, 0, "cạnh"))
    else:
        checks.append(check(f"{cid}.open_edges", PASS, f"{cid}: lưới kín", "Không có cạnh hở.", 0, 0, "cạnh"))
    if not mesh.is_winding_consistent:
        checks.append(check(f"{cid}.winding", FAIL if intent == "solid" else WARNING, f"{cid}: hướng mặt không nhất quán",
                            "Các mặt kề nhau xoay ngược chiều nhau: pháp tuyến bị đảo ở một số mặt."))
    elif mesh.is_watertight and mesh.volume < 0:
        checks.append(check(f"{cid}.inverted", FAIL, f"{cid}: pháp tuyến hướng vào trong",
                            f"Thể tích có dấu âm ({mesh.volume:.4g} mm³): mọi mặt bị đảo hướng.", float(mesh.volume)))
    else:
        checks.append(check(f"{cid}.normals", PASS, f"{cid}: hướng mặt", "Nhất quán" +
                            (", hướng ra ngoài." if mesh.is_watertight else ".")))
    crossing = self_intersections(mesh)
    if crossing is None:
        checks.append(check(f"{cid}.self_intersection", NOT_EVALUATED, f"{cid}: tự giao", "Không có pymeshlab."))
    else:
        checks.append(check(f"{cid}.self_intersection", FAIL if crossing else PASS, f"{cid}: mặt tự cắt nhau",
                            f"{crossing} mặt cắt xuyên qua mặt khác của chính nó" if crossing else "Không có.",
                            crossing, 0, "mặt"))
    if degenerate or duplicate:
        checks.append(check(f"{cid}.degenerate", WARNING, f"{cid}: mặt suy biến hoặc trùng",
                            f"{degenerate} mặt diện tích ~0, {duplicate} mặt trùng nhau.", degenerate + duplicate))
    if mesh.body_count > 1:
        checks.append(check(f"{cid}.bodies", WARNING, f"{cid}: {mesh.body_count} khối rời",
                            "Một chi tiết gồm nhiều khối tách rời: xác nhận đó là ý muốn, hoặc nhập với "
                            "split_bodies = true để tách thành các chi tiết.", int(mesh.body_count)))
    ok = solid_ok(mesh) and not crossing
    checks.append(check(f"{cid}.volume_reliable", PASS if ok else (NOT_EVALUATED if intent == "surface" else WARNING),
                        f"{cid}: thể tích và kích thước tin cậy",
                        f"Thể tích {mesh.volume:.4g} mm³ từ lưới kín, hướng đúng." if ok else
                        "Không tin cậy: lưới hở, đảo hướng hoặc tự cắt."))
    size = float(np.max(mesh.extents))
    if line_width:
        small = size < 2 * line_width
        checks.append(check(f"{cid}.tiny", FAIL if small else PASS, f"{cid}: kích thước so với đường đùn",
                            f"Cạnh lớn nhất {size:.3g} mm, đường đùn {line_width:g} mm.", round(size, 4),
                            2 * line_width, "mm"))
    else:
        checks.append(check(f"{cid}.tiny", NOT_EVALUATED, f"{cid}: kích thước so với đường đùn",
                            "Chưa biết đường kính đầu phun / bề rộng đường đùn (print.nozzle_mm)."))
    return checks


def interference(meshes_by_id, tolerance_volume=1e-3):
    """Pairs whose solids overlap (manifold boolean, volume in mm³), and pairs whose boxes overlap but solids could
    not be intersected (not closed)"""
    ids = list(meshes_by_id)
    found = []
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            ma, mb = meshes_by_id[a], meshes_by_id[b]
            lo = np.maximum(ma.bounds[0], mb.bounds[0])
            hi = np.minimum(ma.bounds[1], mb.bounds[1])
            if np.any(lo > hi):
                continue
            if not (solid_ok(ma) and solid_ok(mb)):
                found.append({"a": a, "b": b, "volume": None, "note": "Hộp bao chồng nhau nhưng một chi tiết không kín: "
                                                                        "không tính được phần giao."})
                continue
            inter = trimesh.boolean.intersection([ma, mb], engine="manifold")
            vol = float(inter.volume) if inter is not None and len(inter.faces) else 0.0
            if vol > tolerance_volume:
                found.append({"a": a, "b": b, "volume": round(vol, 4), "bounds_min": inter.bounds[0].round(3).tolist(),
                              "bounds_max": inter.bounds[1].round(3).tolist()})
    return found


def validate(model, intents=None, print_config=None):
    """Step 2 for every component, and the overlaps between components"""
    result = schema.new_result("validate", model, {"intents": intents or {}, "print": print_config})
    intents = intents or {}
    lw = schema.line_width(print_config)
    if print_config and not print_config.get("line_width_mm") and print_config.get("nozzle_mm"):
        result["assumptions"].append({"path": "print.line_width_mm", "message": "Bề rộng đường đùn lấy bằng đường "
                                                                                 "kính đầu phun."})
    ms = meshes(model)
    for cid, mesh in ms.items():
        intent = intents.get(cid, "solid")
        if cid not in intents:
            result["assumptions"].append({"path": f"intents.{cid}", "message": "Coi là khối đặc để in (solid)."})
        result["checks"] += validate_component(cid, mesh, intent, lw)
    if len(ms) > 1:
        overlaps = interference(ms)
        for o in overlaps:
            if o["volume"] is None:
                result["checks"].append(check(f"overlap.{o['a']}.{o['b']}", NOT_EVALUATED,
                                              f"Giao nhau {o['a']} / {o['b']}", o["note"]))
            else:
                result["checks"].append(check(f"overlap.{o['a']}.{o['b']}", FAIL, f"Giao nhau {o['a']} / {o['b']}",
                                              f"Hai chi tiết chồng lên nhau {o['volume']:.4g} mm³.", o["volume"], 0,
                                              "mm³", {"min": o["bounds_min"], "max": o["bounds_max"]}))
        if not overlaps:
            result["checks"].append(check("overlap", PASS, "Giao nhau giữa các chi tiết",
                                          "Không có cặp chi tiết nào chồng lên nhau."))
        result["data"]["overlaps"] = overlaps
    result["status"] = schema.overall(result["checks"])
    return result
