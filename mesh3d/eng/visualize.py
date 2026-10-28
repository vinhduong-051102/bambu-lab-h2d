"""
Results in Blender: the numbers are the solvers'; this only colours meshes with them and has Blender render the
scene (visualize_blender.py), saving a .blend to open and a PNG with its colour scale.

- fea: a finished FEA, von Mises (MPa) on the deformed component (displacement scaled up, the factor printed), the
  undeformed part translucent
- interference: the components translucent, their overlaps in red
- thickness: each component coloured by wall thickness (mm), red under the limit
- motion: a finished Chrono run played back (the simulation's own Blender playback)
"""

import subprocess
from pathlib import Path

import numpy as np
import trimesh

from . import clearance, geometry, schema
from .schema import PASS, WARNING, check
from .store import EngError, analysis_dir, new_analysis, now, read_json, write_json, BLENDER_CMD

GREY = np.array([170, 175, 185, 255])
# The thickness view measures this many faces, give or take: enough to show a thin plate, quick to render
THICKNESS_FACES = 60000


def refine(mesh, budget):
    """A copy whose long triangles are split until it has about `budget` faces: each round halves the edges of the
    longest ones (CAD exports have slivers hundreds of mm long; splitting them all to one size would run out of
    memory)"""
    v, f = np.asarray(mesh.vertices), np.asarray(mesh.faces)
    for _ in range(16):
        tri = v[f]
        longest = np.max(np.linalg.norm(tri - np.roll(tri, 1, axis=1), axis=2), axis=1)
        room = (budget - len(f)) // 3  # a split face becomes four
        if room <= 0:
            break
        order = np.argsort(longest)[::-1][:room]
        # Only faces clearly longer than the typical one
        pick = order[longest[order] > 2 * np.median(longest)]
        if not len(pick):
            break
        v, f = trimesh.remesh.subdivide(v, f, face_index=pick)
    return trimesh.Trimesh(v, f, process=False)


def ramp(values, lo, hi):
    """Blue → cyan → green → yellow → red, as RGBA 0-255"""
    t = np.clip((np.asarray(values, float) - lo) / max(hi - lo, 1e-12), 0, 1)
    stops = np.array([[38, 70, 200], [30, 170, 220], [60, 190, 80], [245, 200, 40], [220, 40, 40]], float)
    x = t * (len(stops) - 1)
    i = np.minimum(x.astype(int), len(stops) - 2)
    f = (x - i)[:, None]
    rgb = stops[i] * (1 - f) + stops[i + 1] * f
    return np.column_stack([rgb, np.full(len(t), 255)]).astype(np.uint8)


FONTS = ["/opt/fea/fonts/DejaVuSans.ttf", "/opt/chrono/fonts/DejaVuSans.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]


def font(size):
    from PIL import ImageFont

    for path in FONTS:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def colorbar(png, lo, hi, unit, title, note="", reverse=False):
    """A colour scale on the render: red at the top; `reverse` labels it from hi at the bottom to lo at the top (red =
    small, for thickness)"""
    from PIL import Image, ImageDraw

    img = Image.open(png).convert("RGB")
    draw = ImageDraw.Draw(img)
    small, big = font(14), font(18)
    w, h = img.size
    x0, y0, bw, bh = w - 90, 60, 24, h - 160
    bar = ramp(np.linspace(hi, lo, bh), lo, hi)
    for k in range(bh):
        draw.line([(x0, y0 + k), (x0 + bw, y0 + k)], fill=tuple(int(c) for c in bar[k][:3]))
    draw.rectangle([x0, y0, x0 + bw, y0 + bh], outline=(40, 40, 40))
    for frac in (0, 0.25, 0.5, 0.75, 1):
        y = y0 + int((1 - frac) * bh)
        value = hi - frac * (hi - lo) if reverse else lo + frac * (hi - lo)
        draw.text((x0 - 8, y), f"{value:.4g}", fill=(20, 20, 20), font=small, anchor="rm")
    draw.text((x0 - 10, y0 - 30), unit, fill=(20, 20, 20), font=small)
    draw.text((20, 16), title, fill=(20, 20, 20), font=big)
    if note:
        draw.text((20, h - 32), note, fill=(60, 60, 60), font=small)
    img.save(png)


def render(folder, objects, title):
    write_json(folder / "scene.json", {"objects": objects, "title": title, "width": 1200, "height": 800})
    cmd = ["xvfb-run", "-a", "-s", "-screen 0 1280x800x24", *BLENDER_CMD, "-b", "--factory-startup", "--python",
           str(Path(__file__).with_name("visualize_blender.py")), "--", str(folder)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    (folder / "blender.log").write_text(proc.stdout[-20000:] + proc.stderr[-20000:])
    if proc.returncode != 0 or not (folder / "result.png").exists():
        raise EngError(500, "BLENDER_FAILED", "Blender không dựng được hình (xem blender.log của phân tích).")


def export(mesh, colors, path):
    m = trimesh.Trimesh(mesh.vertices, mesh.faces, vertex_colors=colors, process=False)
    m.export(path)


def visualize(model, mode, analysis_id=None, sim_id=None, print_config=None, deformation_scale=None):
    out_id, folder = new_analysis("visualize")
    result = schema.new_result("visualize", model, {"mode": mode, "analysis_id": analysis_id, "sim_id": sim_id})
    result.update(analysis_id=out_id, started_at=now())
    objects = []
    if mode == "fea":
        fea = read_json(analysis_dir(analysis_id) / "result.json")
        if not fea or fea.get("kind") != "fea" or fea.get("state") != "completed":
            raise EngError(422, "FEA_NOT_READY", "Cần một phân tích FEA đã chạy xong (analysis_id).")
        last = len(fea["data"]["levels"]) - 1
        data = np.load(analysis_dir(analysis_id) / f"level{last}" / "result.npz")
        mesh = geometry.load_component(model, fea["data"]["component"])
        # The solver's own surface: every node carries its stress and displacement
        nodes, tris = data["nodes"], data["triangles"]
        used = np.unique(tris)
        remap = np.full(len(nodes), -1)
        remap[used] = np.arange(len(used))
        surface = trimesh.Trimesh(nodes[used], remap[tris], process=False)
        vm, u = data["von_mises"][used], data["displacement"][used]
        hi = float(fea["data"]["robust_max_von_mises_MPa"] or vm.max())
        umax = float(np.linalg.norm(u, axis=1).max())
        scale = deformation_scale or (0.08 * float(max(mesh.extents)) / umax if umax > 0 else 1.0)
        deformed = trimesh.Trimesh(surface.vertices + u * scale, surface.faces, process=False)
        export(deformed, ramp(vm, 0, hi), folder / "deformed.ply")
        export(mesh, np.tile(GREY, (len(mesh.vertices), 1)), folder / "original.ply")
        objects = [{"file": "deformed.ply", "name": "von Mises (deformed)"},
                   {"file": "original.ply", "name": "undeformed", "wire": True}]
        title = f"von Mises (MPa), biến dạng ×{scale:.3g}"
        render(folder, objects, title)
        colorbar(folder / "result.png", 0, hi, "MPa", f"{model['name']}: {title}",
                 f"Thang tới {hi:.4g} MPa (ngoài vùng ngàm/đặt tải); đỉnh {fea['data']['max_von_mises_MPa']:.4g} MPa. "
                 f"Chuyển vị lớn nhất {umax:.4g} mm.")
        result["data"] = {"scale": scale, "stress_max_shown_MPa": hi, "max_displacement_mm": umax}
    elif mode == "interference":
        ms = geometry.meshes(model)
        overlaps = geometry.interference(ms)
        for cid, mesh in ms.items():
            export(mesh, np.tile(GREY, (len(mesh.vertices), 1)), folder / f"{cid}.ply")
            objects.append({"file": f"{cid}.ply", "name": cid, "wire": True})
        for k, o in enumerate(overlaps):
            if o["volume"]:
                inter = trimesh.boolean.intersection([ms[o["a"]], ms[o["b"]]], engine="manifold")
                export(inter, np.tile([220, 30, 30, 255], (len(inter.vertices), 1)), folder / f"overlap{k}.ply")
                objects.append({"file": f"overlap{k}.ply", "name": f"overlap {o['a']}/{o['b']}"})
        render(folder, objects, "Giao nhau")
        result["data"] = {"overlaps": overlaps}
    elif mode == "thickness":
        lw = schema.line_width(print_config)
        limit = 2 * (print_config or {}).get("walls", 1) * lw if lw else None
        top = 0
        for cid, mesh in geometry.meshes(model).items():
            # Each face of a finer copy measured by its own ray straight in, and coloured whole (its own vertices),
            # so a thin plate is not tinted by a thick neighbour sharing its corners
            fine = refine(mesh, THICKNESS_FACES)
            # A dense mesh (a 250k-face figure) is measured on THICKNESS_FACES of its faces, the rest taking their
            # nearest measured neighbour's value: one ray per face would take minutes and gigabytes without Embree
            measured = np.arange(len(fine.faces))
            if len(measured) > THICKNESS_FACES:
                measured = np.random.default_rng(7).choice(measured, THICKNESS_FACES, replace=False)
            starts, inward = fine.triangles_center[measured], -fine.face_normals[measured]
            hits, rays, _ = mesh.ray.intersects_location(starts + inward * 1e-4, inward, multiple_hits=False)
            depth = np.full(len(measured), np.nan)
            if len(rays):
                depth[rays] = np.linalg.norm(np.asarray(hits).reshape(-1, 3) - starts[rays], axis=1)
            d = np.full(len(fine.faces), np.nan)
            d[measured] = depth
            if len(measured) < len(fine.faces):
                from scipy.spatial import cKDTree

                _, near = cKDTree(starts).query(fine.triangles_center)
                d = depth[near]
            found = d[~np.isnan(d)]
            top = max(top, float(np.percentile(found, 95)) if len(found) else 0)
            hi = limit * 3 if limit else top
            d = np.where(np.isnan(d), hi, d)
            colors = np.repeat(ramp(hi - d, 0, hi), 3, axis=0)
            flat = trimesh.Trimesh(fine.triangles.reshape(-1, 3), np.arange(len(fine.faces) * 3).reshape(-1, 3),
                                   process=False)
            export(flat, colors, folder / f"{cid}.ply")
            objects.append({"file": f"{cid}.ply", "name": cid})
        render(folder, objects, "Độ dày thành (mm)")
        hi = limit * 3 if limit else top
        colorbar(folder / "result.png", 0, hi, "mm", f"{model['name']}: độ dày thành, đỏ = mỏng", reverse=True,
                 note=f"Đỏ = 0 mm, xanh = ≥ {hi:.3g} mm" + (f"; giới hạn {limit:g} mm" if limit else ""))
    elif mode == "motion":
        from sim import runs as sim

        try:
            play = sim.start_playback(sim_id, {"render": True})
        except sim.SimError as err:
            raise EngError(err.status, err.code, err.message) from err
        result.update(status=WARNING, data={"sim_id": sim_id, "playback": play},
                      checks=[check("playback", WARNING, "Phát lại chuyển động trong Blender",
                                    "Đang dựng trong nền: theo dõi bằng sim_get_simulation_status; video ở "
                                    "/api/sim/runs/<sim id>/files/blender/playback.mp4.")])
        write_json(folder / "result.json", result)
        return result
    else:
        raise EngError(400, "BAD_MODE", "mode phải là fea, interference, thickness hoặc motion.")
    result["files"] = {"result.png": "result.png", "result.blend": "result.blend", "blender.log": "blender.log"}
    result["checks"].append(check("render", PASS, "Hình kết quả trong Blender", "result.png, result.blend"))
    result.update(status=PASS, state="completed", finished_at=now(), engine={"blender": blender_version()})
    write_json(folder / "result.json", result)
    return result


def blender_version():
    try:
        out = subprocess.run([*BLENDER_CMD, "--version"], capture_output=True, text=True, timeout=60).stdout
        return out.splitlines()[0].replace("Blender", "").strip()
    except Exception:  # noqa: BLE001
        return "unknown"

