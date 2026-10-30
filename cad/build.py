"""
Build runner: python build.py <model.py> [out dir]

Runs a build123d model file (see guide.md: it assigns the finished solid to `result`), then writes to the out
dir (default: out/ next to the model): model.stl, model.step, preview.png (four views) and report.json, which
it also prints. Exits 1 when the model could not be built; report.json then says why.

An assembly keeps its parts: a model that assigns `components` ({name: solid}, in their assembled places), or whose
`result` holds several solids, also gets components/<name>.stl and assembly.json (each component's file, volume and
centre, and the model's `mechanism` dict when it has one: what moves, how, and what is fixed, for simulation). With
`components`, assembly.png shows them assembled: what is simulated, where preview.png shows the print layout; the
model's `assembly_steps` (the order a person puts the parts together) go in assembly.json too, for the assembly guide
the worker draws after the last build (assembly_guide.py).

With `components`, the print layout is made here, not by the model (print_layout.py): every component that is printed
lies on the face it prints best on, packed onto as many H2D plates as it takes. model.stl and model.step hold the
plates side by side, model.3mf the same with each part on its own plate for Bambu Studio, and report.json's
"print_layout" says which part is on which plate. Not printed: the components named in `not_printed`, and those
`mechanism` makes of metal (steel shafts, brass pins…), bought instead. With several plates, plates/plate-<n>.3mf
holds each plate on its own (what is sent to Studio). `print_layout = "manual"` keeps the model's
own `result` instead.
"""

import json
import math
import re
import runpy
import shutil
import struct
import sys
import time
import traceback
import zipfile
from pathlib import Path

# Build plate of the H2D for one part (mm), and how far below Z = 0 a part may start before it counts as
# not sitting on the plate
MAX_SIZE = (320.0, 320.0, 320.0)
PLATE_TOLERANCE = 0.05
# Previews draw at most this many triangles (every n-th one beyond it), so a detailed mesh renders in seconds
PREVIEW_TRIANGLES = 60000


def read_stl(path):
    """Binary STL → list of triangles, each three (x, y, z) tuples"""
    data = path.read_bytes()
    count = struct.unpack_from("<I", data, 80)[0]
    triangles = []
    for i in range(count):
        values = struct.unpack_from("<12f", data, 84 + i * 50)
        triangles.append((values[3:6], values[6:9], values[9:12]))
    return triangles


def mesh_check(triangles):
    """Watertight when every edge is shared by exactly two triangles"""
    edges = {}
    for tri in triangles:
        keys = [tuple(round(c, 4) for c in v) for v in tri]
        for a, b in ((0, 1), (1, 2), (2, 0)):
            edge = (keys[a], keys[b]) if keys[a] < keys[b] else (keys[b], keys[a])
            edges[edge] = edges.get(edge, 0) + 1
    open_edges = sum(1 for n in edges.values() if n == 1)
    bad_edges = sum(1 for n in edges.values() if n > 2)
    return {"triangles": len(triangles), "open_edges": open_edges, "non_manifold_edges": bad_edges,
            "watertight": open_edges == 0 and bad_edges == 0}


def feature_edges(tris, normals, limit=20000):
    """Segments where the surface turns by more than 30°, or ends: the outline a CAD view would draw"""
    import numpy as np

    faces = {}
    keys = np.round(tris, 4)
    for t in range(len(tris)):
        corners = [tuple(keys[t, i]) for i in range(3)]
        for a, b in ((0, 1), (1, 2), (2, 0)):
            edge = (corners[a], corners[b]) if corners[a] < corners[b] else (corners[b], corners[a])
            faces.setdefault(edge, []).append(t)
    sharp = math.cos(math.radians(30))
    segments = [edge for edge, ts in faces.items()
                if len(ts) != 2 or float(normals[ts[0]] @ normals[ts[1]]) < sharp]
    return segments[:limit]


# (title, elevation, azimuth, axis hidden because the view looks along it)
VIEWS = [("Isometric", 30, -60, None), ("Front (−Y)", 0, -90, "y"), ("Right (+X)", 0, 0, "x"), ("Top", 90, -90, "z")]


def render_preview(triangles, size, path, face_colours=None, views=VIEWS):
    """Four views (isometric, front, right, top) in one PNG: shaded by light and by depth, outlined at sharp edges.
    face_colours (sRGB 0–255 per triangle) paints a coloured figure in its filaments instead of the usual blue.
    `views` replaces the four, in rows of two (three when there are more than four)."""
    import matplotlib.pyplot as plt
    import numpy as np
    from mpl_toolkits.mplot3d.art3d import Line3DCollection, Poly3DCollection

    tris = np.array(triangles, dtype=float)
    normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    lengths = np.linalg.norm(normals, axis=1)
    normals = normals / np.where(lengths == 0, 1, lengths)[:, None]
    edges = feature_edges(tris, normals) if len(tris) <= 4 * PREVIEW_TRIANGLES else []
    base = np.asarray(face_colours, dtype=float) / 255 if face_colours is not None else None
    if len(tris) > PREVIEW_TRIANGLES:
        step = math.ceil(len(tris) / PREVIEW_TRIANGLES)
        tris, normals = tris[::step], normals[::step]
        base = base[::step] if base is not None else None
    centroids = tris.mean(axis=1)
    lo, hi = tris.reshape(-1, 3).min(axis=0), tris.reshape(-1, 3).max(axis=0)
    centre = (lo + hi) / 2
    span = max(hi - lo) / 2 or 1

    columns = 3 if len(views) > 4 else 2
    rows = math.ceil(len(views) / columns)
    fig = plt.figure(figsize=(5 * columns, 5 * rows), dpi=90)
    fig.patch.set_facecolor("white")
    for i, (title, elev, azim, hidden) in enumerate(views):
        ax = fig.add_subplot(rows, columns, i + 1, projection="3d")
        ax.view_init(elev=elev, azim=azim)
        e, a = math.radians(elev), math.radians(azim)
        towards_viewer = np.array([math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)])
        # Light from the viewer's upper left, so faces read differently in every view
        le, la = math.radians(elev + 25), math.radians(azim - 30)
        light = np.array([math.cos(le) * math.cos(la), math.cos(le) * math.sin(la), math.sin(le)])
        shade = 0.4 + 0.6 * np.clip(normals @ light, 0, 1)
        # Nearer faces lighter, so a floor reads apart from the rim above it in a straight-on view
        depth = centroids @ towards_viewer
        near = (depth - depth.min()) / ((depth.max() - depth.min()) or 1)
        shade = shade * (0.6 + 0.4 * near)
        if base is not None:
            colours = np.clip(np.column_stack([base * (0.35 + 0.75 * shade)[:, None], np.ones(len(shade))]), 0, 1)
        else:
            colours = np.clip(np.column_stack([0.3 * shade + 0.05, 0.55 * shade + 0.1, 0.95 * shade, np.ones(len(shade))]), 0, 1)
        # Edges in the face colour hide the seams between triangles
        ax.add_collection3d(Poly3DCollection(tris, facecolors=colours, edgecolors=colours, linewidths=0.3))
        # A coloured figure's own boundaries between colours say enough; edges would cover them
        if edges and base is None:
            ax.add_collection3d(Line3DCollection(edges, colors="#0b1f3a", linewidths=0.6, alpha=0.8))
        for setter, c in zip((ax.set_xlim, ax.set_ylim, ax.set_zlim), centre):
            setter(c - span, c + span)
        ax.set_box_aspect((1, 1, 1))
        ax.set_proj_type("ortho")
        for name, axis in (("x", ax.xaxis), ("y", ax.yaxis), ("z", ax.zaxis)):
            if name == hidden:
                axis.set_ticklabels([])
                axis.set_label_text("")
            else:
                axis.set_label_text(name.upper())
        ax.tick_params(labelsize=7)
        ax.set_title(title, fontsize=11)
    fig.suptitle(f"{size[0]:.1f} × {size[1]:.1f} × {size[2]:.1f} mm", fontsize=13)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def as_shape(value, what):
    from build123d import Compound, Shape

    if isinstance(value, (list, tuple)):
        value = Compound(children=list(value))
    if not isinstance(value, Shape):
        # Builders (BuildPart) hold their part in .part
        value = getattr(value, "part", value)
    if not isinstance(value, Shape):
        raise ValueError(f"{what} is a {type(value).__name__}, not a build123d shape.")
    return value


def read_components(namespace, solids):
    """{name: shape} of an assembly: `components` as the model names them, else each solid of `result` when it has
    several (named by its label, or part_1, part_2…); {} for a single part"""
    given = namespace.get("components")
    if given is not None:
        if not isinstance(given, dict) or not given:
            raise ValueError("`components` must be a dict {name: solid}, the parts in their assembled places.")
        out = {}
        for name, value in given.items():
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_-]{0,47}", name):
                raise ValueError(f"Component name {name!r}: letters, digits, _ and - (at most 48).")
            out[name] = as_shape(value, f"components[{name!r}]")
            if not out[name].solids():
                raise ValueError(f"components[{name!r}] has no solids.")
        return out
    if len(solids) < 2:
        return {}
    out = {}
    for k, solid in enumerate(solids, 1):
        label = re.sub(r"[^A-Za-z0-9_-]", "_", str(getattr(solid, "label", "") or ""))[:48].strip("_")
        name = label if label and label not in out else f"part_{k}"
        out[name] = solid
    return out


def read_steps(steps, components):
    """`assembly_steps` as given, checked: [{"parts": [component names], "text"?: str, "direction"?: [x, y, z]}]"""
    if steps is None:
        return None
    if not isinstance(steps, list) or not all(isinstance(step, dict) for step in steps):
        raise ValueError('`assembly_steps` must be a list of {"parts": [...], "text": "...", "direction": [x, y, z]}.')
    seen = set()
    for k, step in enumerate(steps, 1):
        parts = step.get("parts")
        if not isinstance(parts, list) or not parts or not all(isinstance(p, str) for p in parts):
            raise ValueError(f"assembly_steps[{k - 1}]: \"parts\" must be a list of component names.")
        unknown = [p for p in parts if p not in components]
        if unknown:
            raise ValueError(f"assembly_steps[{k - 1}] names parts that are not components: {unknown}.")
        again = [p for p in parts if p in seen]
        if again:
            raise ValueError(f"assembly_steps[{k - 1}] puts on {again} a second time.")
        seen.update(parts)
        if "text" in step and not isinstance(step["text"], str):
            raise ValueError(f"assembly_steps[{k - 1}]: \"text\" must be a string.")
        direction = step.get("direction")
        if direction is not None and not (isinstance(direction, list) and len(direction) == 3
                                          and all(isinstance(c, (int, float)) for c in direction) and any(direction)):
            raise ValueError(f"assembly_steps[{k - 1}]: \"direction\" must be [x, y, z], not all 0.")
    return [{key: step[key] for key in ("parts", "text", "direction") if key in step} for step in steps]


def write_components(components, mechanism, out, from_solids, steps=None):
    """components/<name>.stl and assembly.json"""
    from build123d import export_stl

    folder = out / "components"
    folder.mkdir(exist_ok=True)
    listed = []
    for name, shape in components.items():
        export_stl(shape, str(folder / f"{name}.stl"), tolerance=0.01, angular_tolerance=0.1)
        c = shape.center()
        listed.append({"name": name, "file": f"components/{name}.stl", "volume_mm3": round(shape.volume, 3),
                       "center_mm": [round(c.X, 3), round(c.Y, 3), round(c.Z, 3)]})
    if mechanism is not None:
        if not isinstance(mechanism, dict):
            raise ValueError("`mechanism` must be a dict (see guide.md, Assemblies that move).")
        try:
            json.dumps(mechanism)
        except TypeError as err:
            raise ValueError(f"`mechanism` must hold only numbers, strings, lists and dicts: {err}") from None
        unknown = {ref for key in ("joints", "gears", "motors", "loads") for item in mechanism.get(key) or []
                   if isinstance(item, dict) for field in ("part_a", "part_b", "part", "gear_a", "gear_b")
                   for ref in [item.get(field)] if ref is not None and ref not in components}
        unknown |= {ref for ref in (mechanism.get("parts") or {}) if ref not in components}
        if unknown:
            raise ValueError(f"`mechanism` names parts that are not components: {sorted(unknown)}.")
    steps = read_steps(steps, components)
    (out / "assembly.json").write_text(json.dumps({
        "components": listed, "mechanism": mechanism, "steps": steps,
        "from": "solids of result" if from_solids else "components"}, indent=2, ensure_ascii=False))
    files = [entry["file"] for entry in listed] + ["assembly.json"]
    if not from_solids:
        # Assembled, unlike `result` (laid out to print): the model as the dashboard simulates it
        triangles = [t for entry in listed for t in read_stl(out / entry["file"])]
        lows = [min(v[a] for t in triangles for v in t) for a in range(3)]
        highs = [max(v[a] for t in triangles for v in t) for a in range(3)]
        render_preview(triangles, tuple(h - lo for h, lo in zip(highs, lows)), out / "assembly.png")
        files.append("assembly.png")
    return files


METALS = ("steel", "stainless", "aluminium", "aluminum", "brass", "bronze", "copper", "iron", "metal")


def bought(namespace, components):
    """{name: why} of the components that are not printed"""
    named = namespace.get("not_printed") or []
    if not isinstance(named, (list, tuple)) or not all(isinstance(n, str) for n in named):
        raise ValueError("`not_printed` must be a list of component names.")
    unknown = [n for n in named if n not in components]
    if unknown:
        raise ValueError(f"`not_printed` names parts that are not components: {unknown}.")
    out = {n: "not_printed" for n in named}
    parts = (namespace.get("mechanism") or {}).get("parts") or {}
    for name, part in parts.items():
        material = str((part or {}).get("material") or "").lower() if isinstance(part, dict) else ""
        if name in components and name not in out and any(m in material for m in METALS):
            out[name] = material
    return out


def lay_out(namespace, components, out):
    """The printed components on their plates: (the layout as one shape, report["print_layout"])"""
    import numpy as np
    from build123d import Compound, Location
    from OCP.gp import gp_Trsf

    import print_layout

    skipped = bought(namespace, components)
    printed = [n for n in components if n not in skipped]
    if not printed:
        raise ValueError("Every component is `not_printed` or metal: there is nothing to print.")
    meshes = {n: np.array(read_stl(out / "components" / f"{n}.stl"), dtype=float) for n in printed}
    layout = print_layout.plan(meshes)
    placed = []
    for name in printed:
        m = layout["parts"][name]["matrix"]
        trsf = gp_Trsf()
        trsf.SetValues(*m[0, :4], *m[1, :4], *m[2, :4])
        placed.append(components[name].moved(Location(trsf)))
    print_layout.write_3mf(out / "model.3mf", meshes, layout, title=Path(out).parent.name)
    # Several plates: one 3MF each as well, since Studio drops the plates of a 3MF it did not write
    plate_files = (print_layout.write_plates(out / "plates", meshes, layout, title=Path(out).parent.name)
                   if len(layout["plates"]) > 1 else [])
    report = {
        "plates": layout["plates"],
        "plate_files": [f"plates/{name}" for name in plate_files],
        "parts": {n: {k: v for k, v in p.items() if k != "matrix"} for n, p in layout["parts"].items()},
        "not_printed": skipped,
        "warnings": layout["warnings"],
    }
    return Compound(children=placed), report


def build(model, out):
    from build123d import Compound, Shape, export_step, export_stl

    namespace = runpy.run_path(str(model), run_name="__model__")
    shape = namespace.get("result")
    layout = None
    if isinstance(namespace.get("components"), dict) and namespace.get("print_layout") != "manual":
        # Laid out for printing from the components, whatever `result` holds
        components = read_components(namespace, [])
        assembly_files = write_components(components, namespace.get("mechanism"), out, False,
                                          namespace.get("assembly_steps"))
        shape, layout = lay_out(namespace, components, out)
    elif shape is None and isinstance(namespace.get("components"), dict):
        # An assembly with no separate print layout: printed as it stands
        shape = list(namespace["components"].values())
    if shape is None:
        raise ValueError("The model file does not assign the finished part to `result`.")
    if isinstance(shape, (list, tuple)):
        shape = Compound(children=list(shape))
    if not isinstance(shape, Shape):
        # Builders (BuildPart) hold their part in .part
        shape = getattr(shape, "part", shape)
    if not isinstance(shape, Shape):
        raise ValueError(f"`result` is a {type(shape).__name__}, not a build123d shape.")
    solids = shape.solids()
    if not solids:
        raise ValueError("`result` has no solids: it must be a 3D part, not a sketch, face or wire.")

    box = shape.bounding_box()
    size = (box.size.X, box.size.Y, box.size.Z)
    volume = sum(s.volume for s in solids)
    warnings = list(layout["warnings"]) if layout else []
    # A layout's plates lie side by side, each within the plate
    if not layout and any(s > m for s, m in zip(size, MAX_SIZE)):
        warnings.append(f"Larger than the H2D's {MAX_SIZE[0]:.0f} × {MAX_SIZE[1]:.0f} × {MAX_SIZE[2]:.0f} mm.")
    if abs(box.min.Z) > PLATE_TOLERANCE:
        warnings.append(f"The lowest point is at Z = {box.min.Z:.2f} mm, not on the build plate (Z = 0).")
    # A property since build123d 0.10, a method before
    valid = shape.is_valid() if callable(shape.is_valid) else shape.is_valid
    if not valid:
        warnings.append("OpenCascade reports the shape as invalid (self-intersecting or broken faces).")
    if volume <= 0:
        warnings.append("The solids have no volume.")

    stl, step, preview = out / "model.stl", out / "model.step", out / "preview.png"
    export_stl(shape, str(stl), tolerance=0.01, angular_tolerance=0.1)
    export_step(shape, str(step))
    triangles = read_stl(stl)
    mesh = mesh_check(triangles)
    if not mesh["watertight"]:
        warnings.append(f"The STL mesh is not watertight ({mesh['open_edges']} open, "
                        f"{mesh['non_manifold_edges']} non-manifold edges).")
    render_preview(triangles, size, preview)
    files = ["model.stl", "model.step", "preview.png"]
    if layout:
        files += ["model.3mf"] + layout["plate_files"] + assembly_files
        if namespace.get("result") is not None:
            warnings.append("`result` is ignored: the print layout is made from `components` "
                            '(print_layout = "manual" keeps it).')
    else:
        components = read_components(namespace, solids)
        if components:
            files += write_components(components, namespace.get("mechanism"), out, namespace.get("components") is None,
                                      namespace.get("assembly_steps"))
        elif namespace.get("mechanism") is not None:
            warnings.append("`mechanism` is ignored: a single part has nothing to move against (give `components`).")

    return {
        "size_mm": [round(v, 2) for v in size],
        "min_mm": [round(box.min.X, 2), round(box.min.Y, 2), round(box.min.Z, 2)],
        "max_mm": [round(box.max.X, 2), round(box.max.Y, 2), round(box.max.Z, 2)],
        "volume_cm3": round(volume / 1000, 3),
        "solids": len(solids),
        "mesh": mesh,
        "warnings": warnings,
        "components": list(components),
        "files": files,
        **({"print_layout": layout} if layout else {}),
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    model = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else model.parent / "out"
    out.mkdir(parents=True, exist_ok=True)
    for stale in ("model.stl", "model.step", "preview.png", "report.json", "assembly.json", "assembly.png"):
        (out / stale).unlink(missing_ok=True)
    # A print layout's 3MF, not a coloured figure's (mesh3d writes those)
    if (out / "model.3mf").exists() and b"build.py" in zipfile.ZipFile(out / "model.3mf").read("3D/3dmodel.model")[:600]:
        (out / "model.3mf").unlink()
    for stale in (out / "components").glob("*.stl") if (out / "components").is_dir() else []:
        stale.unlink()
    # The assembly guide is of the model built before; the worker draws it again after the last build
    shutil.rmtree(out / "guide", ignore_errors=True)
    shutil.rmtree(out / "plates", ignore_errors=True)

    started = time.monotonic()
    try:
        report = {"ok": True, **build(model, out)}
    except Exception as err:  # noqa: BLE001 - the model's own errors are what the report is for
        lines = traceback.format_exception(err)
        # The runner's frames say nothing about the model; keep the ones from the model file onwards
        start = next((i for i, line in enumerate(lines) if str(model) in line), 0)
        report = {"ok": False, "error": f"{type(err).__name__}: {err}", "traceback": "".join(lines[start:])[-4000:]}
    report["seconds"] = round(time.monotonic() - started, 1)
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(report, indent=2, ensure_ascii=False))
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
