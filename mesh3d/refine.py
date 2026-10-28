"""
The export of a figure (docs/cad.md, "Nhân vật"): what Claude left in Blender, exported by figure_mcp.py to
work/current.ply with each face's filament in work/current.labels.npy and the filaments in work/palette.json.

  python refine.py work/current.ply        (in the job folder)

writes to out/: model.stl, model.3mf (when the figure is painted: every triangle in its filament), preview.png (the
dashboard's four views), views.png (six sides, for Claude's check) and report.json (size, watertight, bodies, the
print warnings, the filaments and their shares), which it also prints. Exits 1 when the export fails; report.json
then says why.
"""

import json
import os
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


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def mesh_check(mesh):
    """Watertight when every edge is shared by exactly two faces (by vertex index: build.mesh_check's rounded
    coordinates would count two bodies touching at a point as broken)"""
    _edges, counts = np.unique(mesh.edges_sorted, axis=0, return_counts=True)
    open_edges, bad_edges = int(np.sum(counts == 1)), int(np.sum(counts > 2))
    return {"triangles": len(mesh.faces), "open_edges": open_edges, "non_manifold_edges": bad_edges,
            "watertight": open_edges == 0 and bad_edges == 0}


def nearest(mesh, other):
    """For every face of `other`, the face of `mesh` nearest its centre"""
    from scipy.spatial import cKDTree

    return cKDTree(mesh.triangles_center).query(other.triangles_center)[1]


def light_copy(mesh, face_rgb):
    """At most PREVIEW_FACES faces for drawing, with the colour of the nearest printable face"""
    if len(mesh.faces) <= PREVIEW_FACES:
        return mesh, face_rgb
    preview = meshkit.decimate(mesh, PREVIEW_FACES)
    return preview, None if face_rgb is None else face_rgb[nearest(mesh, preview)]


def bodies_report(mesh):
    """Loose parts: bodies far smaller than the largest (specks, shards) are likely mistakes"""
    bodies = mesh.split(only_watertight=False)
    sizes = sorted((float(np.linalg.norm(b.extents)) for b in bodies), reverse=True)
    small = [s for s in sizes if s < sizes[0] * 0.05] if sizes else []
    return len(bodies), small


def build(path, out):
    import build as cad_build  # cad/build.py
    import colors

    # Loaded as written, so the faces stay in the order of their filaments
    mesh = trimesh.load(path, force="mesh", process=False)
    if not len(mesh.faces):
        raise ValueError("The export has no faces.")
    labels_file = path.with_suffix(".labels.npy")
    labels = np.load(labels_file) if labels_file.exists() else None
    palette = read_json(path.parent / "palette.json")
    choices = read_json(path.parent / "choices.json") or {}
    warnings = []
    if len(mesh.faces) > meshkit.MAX_FACES * 1.5:
        before, original = len(mesh.faces), mesh
        # Collapsing edges can pinch the surface: repaired after
        mesh = meshkit.repair(meshkit.decimate(mesh, meshkit.MAX_FACES))
        warnings.append(f"Reduced from {before} to {len(mesh.faces)} faces for the slicer.")
        if labels is not None:
            labels = labels[nearest(original, mesh)]

    lo, hi = mesh.bounds
    size = hi - lo
    if np.any(size > MAX_SIZE):
        warnings.append(f"Larger than the H2D's {MAX_SIZE:.0f} mm build volume.")
    if abs(lo[2]) > PLATE_TOLERANCE:
        warnings.append(f"The lowest point is at Z = {lo[2]:.2f} mm, not on the plate: move it so it rests at Z = 0.")
    count, small = bodies_report(mesh)
    if small:
        warnings.append(f"{len(small)} loose bit(s) much smaller than the figure: delete or join them.")
    foot = mesh.vertices[mesh.vertices[:, 2] < lo[2] + 0.5]
    if len(foot) < 3 or np.ptp(foot[:, 0]) * np.ptp(foot[:, 1]) < (size[2] * 0.12) ** 2:
        warnings.append("Very little touches the plate: it may topple or come loose; a plinth or a flat sole helps.")

    out.mkdir(parents=True, exist_ok=True)
    mesh.export(out / "model.stl")
    face_rgb = None
    if palette and labels is not None:
        palette = [dict(p) for p in palette]
        rgb = np.array([colors.hex_to_rgb(p["hex"]) for p in palette], dtype=float)
        labels = np.clip(labels, 0, len(palette) - 1)
        colors.write_3mf(out / "model.3mf", mesh, labels, rgb, name="figure")
        shares = np.bincount(labels, weights=mesh.area_faces, minlength=len(palette)) / mesh.area.sum()
        for entry, share in zip(palette, shares):
            entry["share"] = round(float(share), 4)
        face_rgb = rgb[labels]
    else:
        palette = None

    check = mesh_check(mesh)
    if not check["watertight"]:
        warnings.append(f"Not watertight ({check['open_edges']} open, {check['non_manifold_edges']} non-manifold "
                        "edges): a voxel remesh, or joining the parts, closes it.")
    preview, preview_rgb = light_copy(mesh, face_rgb)
    cad_build.render_preview(preview.triangles.tolist(), size, out / "preview.png", preview_rgb)
    cad_build.render_preview(preview.triangles.tolist(), size, out / "views.png", preview_rgb, views=meshkit.SIX_VIEWS)
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
        # How the user asked for the colours, which "Tạo lại" on the dashboard asks again
        "colour_request": choices.get("request")
        or (read_json(path.parent.parent / "source" / "report.json") or {}).get("colour_request"),
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    path = Path(sys.argv[1]).resolve()
    out = Path.cwd() / "out"
    for stale in ("model.stl", "model.3mf", "preview.png", "views.png", "report.json"):
        (out / stale).unlink(missing_ok=True)
    started = time.monotonic()
    try:
        report = {"ok": True, **build(path, out)}
    except Exception as err:  # noqa: BLE001 - what went wrong is what the report is for
        report = {"ok": False, "error": f"{type(err).__name__}: {err}",
                  "traceback": "".join(traceback.format_exception(err))[-4000:]}
    report["seconds"] = round(time.monotonic() - started, 1)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "palette"}, indent=2, ensure_ascii=False))
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
