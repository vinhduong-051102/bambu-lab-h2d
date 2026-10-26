"""
Runner for Claude's review of a figure (docs/cad.md, "Claude review & sửa"): python refine.py fix.py

Runs fix.py (it edits the figure with meshkit and assigns the finished mesh to `result`), then writes to out/:
model.stl, model.3mf (when the figure was coloured: every face keeps the filament of the source face under it),
preview.png (the dashboard's four views), views.png (six sides, for the review) and report.json, which it also
prints. Exits 1 when fix.py fails; report.json then says why.
"""

import json
import os
import runpy
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, os.environ.get("CAD_DIR", "/opt/cad"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import trimesh  # noqa: E402

import meshkit  # noqa: E402

MAX_SIZE = 320.0
PLATE_TOLERANCE = 0.05
PREVIEW_FACES = 40000


def nearest_faces(source, mesh, samples=600000):
    """For every face of `mesh`, the source face nearest its centre, and how far that is (mm). Measured to points
    spread evenly over the source surface, so a large flat face (a plinth's top) counts as near all over."""
    from scipy.spatial import cKDTree

    points, faces = trimesh.sample.sample_surface(source, samples, seed=1)
    points = np.vstack([points, source.triangles_center])
    faces = np.concatenate([faces, np.arange(len(source.faces))])
    distance, index = cKDTree(points).query(mesh.triangles_center)
    return faces[index], distance


def carry_colours(source, labels, mesh, paints):
    """Each face takes the filament of the source face under it. Faces far from the old surface are new (a foot,
    a plinth) and take the main filament, unless fix.py's `paints` ([(region, filament 1…n)]) says otherwise."""
    import colors

    index, distance = nearest_faces(source, mesh)
    out = labels[index]
    main = np.bincount(labels, weights=source.area_faces).argmax()
    # Further than this from the old surface is new; close_gaps() and smooth() move it less
    new = distance > 1.0
    out[new] = main
    out = colors.clean_islands(mesh, out, passes=1)
    for region, slot in paints:
        out[region(mesh.triangles_center)] = int(slot) - 1
    return out, int(new.sum())


def mesh_check(mesh):
    """Watertight when every edge is shared by exactly two faces (by vertex index: build.mesh_check's rounded
    coordinates would count two bodies touching at a point as broken)"""
    _edges, counts = np.unique(mesh.edges_sorted, axis=0, return_counts=True)
    open_edges, bad_edges = int(np.sum(counts == 1)), int(np.sum(counts > 2))
    return {"triangles": len(mesh.faces), "open_edges": open_edges, "non_manifold_edges": bad_edges,
            "watertight": open_edges == 0 and bad_edges == 0}


def light_copy(mesh, face_rgb):
    """At most PREVIEW_FACES faces for drawing, with the colour of the nearest printable face"""
    if len(mesh.faces) <= PREVIEW_FACES:
        return mesh, face_rgb
    preview = meshkit.decimate(mesh, PREVIEW_FACES)
    if face_rgb is None:
        return preview, None
    index, _ = nearest_faces(mesh, preview)
    return preview, face_rgb[index]


def bodies_report(mesh):
    """Loose parts: bodies far smaller than the largest (specks, shards) are likely mistakes"""
    bodies = mesh.split(only_watertight=False)
    sizes = sorted((float(np.linalg.norm(b.extents)) for b in bodies), reverse=True)
    small = [s for s in sizes if s < sizes[0] * 0.05] if sizes else []
    return len(bodies), small


def build(fix, out):
    import build as cad_build  # cad/build.py
    import colors

    namespace = runpy.run_path(str(fix), run_name="__fix__")
    mesh = namespace.get("result")
    if isinstance(mesh, (list, tuple)):
        mesh = trimesh.util.concatenate(list(mesh))
    if not isinstance(mesh, trimesh.Trimesh):
        raise ValueError(f"fix.py must assign the finished trimesh.Trimesh to `result` (got {type(mesh).__name__}).")
    if not len(mesh.faces):
        raise ValueError("`result` has no faces.")
    warnings = []
    if len(mesh.faces) > meshkit.MAX_FACES * 1.5:
        before = len(mesh.faces)
        # Collapsing edges can pinch the surface: repaired after
        mesh = meshkit.repair(meshkit.decimate(mesh, meshkit.MAX_FACES))
        warnings.append(f"Reduced from {before} to {len(mesh.faces)} faces for the slicer.")

    source, labels = meshkit.load_painted()
    source_report = json.loads((meshkit.SOURCE / "report.json").read_text(encoding="utf-8")) \
        if (meshkit.SOURCE / "report.json").exists() else {}
    lo, hi = mesh.bounds
    size = hi - lo
    if np.any(size > MAX_SIZE):
        warnings.append(f"Larger than the H2D's {MAX_SIZE:.0f} mm build volume.")
    if abs(lo[2]) > PLATE_TOLERANCE:
        warnings.append(f"The lowest point is at Z = {lo[2]:.2f} mm, not on the plate: end with place_on_plate().")
    count, small = bodies_report(mesh)
    if small:
        warnings.append(f"{len(small)} loose bit(s) much smaller than the figure: remove_bits() drops them.")
    foot = mesh.vertices[mesh.vertices[:, 2] < lo[2] + 0.5]
    if len(foot) < 3 or np.ptp(foot[:, 0]) * np.ptp(foot[:, 1]) < (size[2] * 0.12) ** 2:
        warnings.append("Very little touches the plate: it may topple or come loose; a plinth or a flat sole helps.")

    out.mkdir(parents=True, exist_ok=True)
    mesh.export(out / "model.stl")
    face_rgb = None
    palette = None
    new_faces = 0
    if labels is not None and source_report.get("palette"):
        palette = [dict(p) for p in source_report["palette"]]
        rgb = np.array([colors.hex_to_rgb(p["hex"]) for p in palette], dtype=float)
        mesh_labels, new_faces = carry_colours(source, labels, mesh, namespace.get("paints") or [])
        mesh_labels = np.clip(mesh_labels, 0, len(palette) - 1)
        colors.write_3mf(out / "model.3mf", mesh, mesh_labels, rgb, name=namespace.get("title") or "figure")
        shares = np.bincount(mesh_labels, weights=mesh.area_faces, minlength=len(palette)) / mesh.area.sum()
        for entry, share in zip(palette, shares):
            entry["share"] = round(float(share), 4)
            entry.pop("mix", None)
        face_rgb = rgb[mesh_labels]

    check = mesh_check(mesh)
    if not check["watertight"]:
        warnings.append(f"Not watertight ({check['open_edges']} open, {check['non_manifold_edges']} non-manifold "
                        "edges): repair() closes it.")
    preview, preview_rgb = light_copy(mesh, face_rgb)
    cad_build.render_preview(preview.triangles.tolist(), size, out / "preview.png", preview_rgb)
    cad_build.render_preview(preview.triangles.tolist(), size, out / "views.png", preview_rgb, views=meshkit.SIX_VIEWS)

    before = meshkit.info(source)
    return {
        "size_mm": [round(float(v), 2) for v in size],
        "min_mm": [round(float(v), 2) for v in lo],
        "max_mm": [round(float(v), 2) for v in hi],
        "volume_cm3": round(float(abs(mesh.volume)) / 1000, 3) if check["watertight"] else None,
        "solids": count,
        "mesh": check,
        "warnings": warnings,
        "files": ["model.stl", "preview.png", "views.png"] + (["model.3mf"] if palette else []),
        "palette": palette,
        "colour_request": source_report.get("colour_request"),
        # What fix.py changed, against the figure it started from
        "changes": {
            "faces": [before["faces"], len(mesh.faces)],
            "size_mm": [before["size_mm"], [round(float(v), 2) for v in size]],
            "volume_cm3": [before["volume_cm3"], round(float(abs(mesh.volume)) / 1000, 3) if check["watertight"] else None],
            "new_faces_main_colour": new_faces if palette else None,
        },
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    fix = Path(sys.argv[1]).resolve()
    out = fix.parent / "out"
    for stale in ("model.stl", "model.3mf", "preview.png", "views.png", "report.json"):
        (out / stale).unlink(missing_ok=True)
    started = time.monotonic()
    try:
        report = {"ok": True, **build(fix, out)}
    except Exception as err:  # noqa: BLE001 - fix.py's own errors are what the report is for
        lines = traceback.format_exception(err)
        start = next((i for i, line in enumerate(lines) if str(fix) in line), 0)
        report = {"ok": False, "error": f"{type(err).__name__}: {err}", "traceback": "".join(lines[start:])[-4000:]}
    report["seconds"] = round(time.monotonic() - started, 1)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "palette"}, indent=2, ensure_ascii=False))
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
