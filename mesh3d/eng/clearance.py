"""
Step 4: fits and clearances, in mm.

- Gaps between pairs of components (surface to surface).
- Hole/shaft fits from the coaxial pairs (assembly.py): the designed diametral clearance, and what is left once
  printed, from the printer's own tolerances (print.hole_shrink_mm, shaft_growth_mm). There is no built-in
  clearance for "a 3D printer": without the printer's numbers the printed fit is NOT_EVALUATED and a calibration
  print is asked for.
- Wall thickness: rays from the surface straight in (percentiles, thinnest spots) against walls × line width.
- Gear backlash from the centre distance of a declared gear pair (sim.schema.gear_mesh).
- Clearance over a motion: the components moved by a finished Chrono run, the smallest gap and any overlap at
  each sampled time.
"""

import math

import numpy as np
import trimesh

from . import assembly, geometry, schema
from .schema import FAIL, NOT_EVALUATED, PASS, WARNING, check
from .store import EngError

FIT_TYPES = ("running", "sliding", "press", "free")


def wall_thickness(mesh, samples=3000):
    """Thickness at surface samples: the ray straight in to the far side. None where it never hits (open mesh)"""
    points, faces = trimesh.sample.sample_surface(mesh, samples, seed=5)
    inward = -mesh.face_normals[faces]
    hits, rays, _ = mesh.ray.intersects_location(points + inward * 1e-4, inward, multiple_hits=False)
    depth = np.full(len(points), np.nan)
    if len(rays):
        depth[rays] = np.linalg.norm(np.asarray(hits).reshape(-1, 3) - points[rays], axis=1)
    return points, depth


def thickness_check(cid, mesh, print_config):
    points, depth = wall_thickness(mesh)
    found = ~np.isnan(depth)
    if not geometry.solid_ok(mesh) or found.sum() < 10:
        return check(f"{cid}.wall", NOT_EVALUATED, f"{cid}: độ dày thành",
                     "Không đo được: lưới không kín hoặc hướng mặt sai."), None
    d = depth[found]
    order = np.argsort(d)[:5]
    data = {"p1": round(float(np.percentile(d, 1)), 4), "p5": round(float(np.percentile(d, 5)), 4),
            "median": round(float(np.median(d)), 4), "min": round(float(d.min()), 4),
            "thinnest_at": np.round(points[found][order], 3).tolist()}
    lw = schema.line_width(print_config)
    walls = (print_config or {}).get("walls")
    if not lw:
        return check(f"{cid}.wall", NOT_EVALUATED, f"{cid}: độ dày thành",
                     f"Mỏng nhất ~{data['p1']} mm (phân vị 1 %). Chưa biết bề rộng đường đùn để so sánh "
                     "(print.nozzle_mm / line_width_mm).", data["p1"], unit="mm"), data
    # The 1st percentile: the very edge of a chamfer is not a wall
    thin = data["p1"]
    if thin < lw:
        status, limit = FAIL, lw
        detail = f"Chỗ mỏng ~{thin} mm < một đường đùn {lw:g} mm: không in được thành ở đó."
    elif walls and thin < 2 * walls * lw:
        status, limit = WARNING, 2 * walls * lw
        detail = (f"Chỗ mỏng ~{thin} mm < 2 × {walls:g} thành × {lw:g} mm: chỉ còn thành, không có infill; kiểm tra "
                  "độ bền ở đó.")
    else:
        status, limit = PASS, 2 * (walls or 1) * lw
        detail = f"Mỏng nhất ~{thin} mm (phân vị 1 %)."
    return check(f"{cid}.wall", status, f"{cid}: độ dày thành", detail, thin, round(limit, 4), "mm",
                 {"thinnest_at": data["thinnest_at"]}), data


def fit_check(pair, fit_type, print_config):
    """A coaxial hole/shaft: designed clearance, and as printed with the printer's tolerances"""
    nominal = pair["diametral_clearance"]
    name = f"fit.{pair['hole']}.{pair['shaft']}"
    title = f"Lắp ghép {pair['hole']} / {pair['shaft']} (Ø{pair['hole_diameter']:.3f} / Ø{pair['shaft_diameter']:.3f})"
    p = print_config or {}
    shrink, growth = p.get("hole_shrink_mm"), p.get("shaft_growth_mm")
    if shrink is None or growth is None:
        return check(name, NOT_EVALUATED, title,
                     f"Khe hở thiết kế {nominal:.4g} mm (theo đường kính). Chưa biết lỗ in ra nhỏ đi và trục to ra bao "
                     "nhiêu trên máy in này (print.hole_shrink_mm, shaft_growth_mm): in mẫu hiệu chuẩn lỗ/trục cùng "
                     "vật liệu, hướng in và thông số in rồi nhập số đo.", nominal, unit="mm"), None
    printed = nominal - shrink - growth
    need = p.get("min_clearance_mm")
    info = {"nominal": nominal, "printed_estimate": round(printed, 4), "tolerance_source": p.get("tolerance_source")}
    if fit_type == "press":
        status = PASS if printed < 0 else FAIL
        detail = f"Lắp chặt: dự kiến sau in {printed:.4g} mm ({'chặt' if printed < 0 else 'lỏng'})."
        return check(name, status, title, detail, round(printed, 4), 0.0, "mm"), info
    if printed <= 0:
        return check(name, FAIL, title, f"Sau in dự kiến {printed:.4g} mm: kẹt (cần khe hở cho kiểu {fit_type})."
                     , round(printed, 4), need or 0.0, "mm"), info
    if need is None:
        return check(name, WARNING, title, f"Sau in dự kiến còn {printed:.4g} mm nhưng chưa có khe hở tối thiểu cho "
                                            "kiểu lắp này (print.min_clearance_mm).", round(printed, 4), unit="mm"), info
    status = PASS if printed >= need else FAIL
    if status == PASS and p.get("tolerance_source") in (None, "unknown"):
        status = WARNING
    detail = f"Sau in dự kiến {printed:.4g} mm, cần ≥ {need:g} mm."
    if p.get("tolerance_source") in (None, "unknown"):
        detail += " Sai số máy in chưa rõ nguồn: nên in mẫu hiệu chuẩn."
    return check(name, status, title, detail, round(printed, 4), need, "mm"), info


def gear_backlash(g, ms, print_config):
    """A declared gear pair: centre distance from the components' centres (perpendicular to the axis), the backlash
    it gives over the standard m(N_a + N_b)/2, less what the printer adds to each tooth"""
    from sim import schema as sim_schema

    a, b = ms.get(g.get("component_a")), ms.get(g.get("component_b"))
    if a is None or b is None:
        raise EngError(422, "BAD_GEAR", "gears[].component_a / component_b phải là chi tiết của mô hình.")
    axis = np.asarray(g.get("axis") or [0, 0, 1], float)
    axis /= np.linalg.norm(axis)
    ca = a.center_mass if geometry.solid_ok(a) else a.bounds.mean(axis=0)
    cb = b.center_mass if geometry.solid_ok(b) else b.bounds.mean(axis=0)
    d = cb - ca
    distance = float(np.linalg.norm(d - np.dot(d, axis) * axis))
    m, na, nb = float(g["module"]), int(g["teeth_a"]), int(g["teeth_b"])
    alpha = math.radians(float(g.get("pressure_angle_deg", 20)))
    standard = m * (na + nb) / 2
    name = f"gear.{g['component_a']}.{g['component_b']}"
    title = f"Ăn khớp {g['component_a']} / {g['component_b']} ({na}/{nb}, m{m:g})"
    if distance < standard - 1e-3:
        return check(name, FAIL, title, f"Khoảng cách tâm {distance:.4g} mm < {standard:.4g} mm: răng chồng nhau.",
                     round(distance, 4), standard, "mm"), None
    mesh = sim_schema.gear_mesh(na, nb, m / 1000, distance / 1000, alpha, 0.0)
    if mesh is None or mesh["contact_ratio"] < 1:
        return check(name, FAIL, title, f"Khoảng cách tâm {distance:.4g} mm quá lớn: hệ số trùng khớp < 1.",
                     round(distance, 4), standard, "mm"), None
    # Standard teeth at the working centre distance a': backlash on the working pitch circles 2·a'·(inv α_w − inv α)
    # (≈ 2·Δa·tan α for a small Δa)
    def inv(x):
        return math.tan(x) - x

    nominal = 2 * distance * (inv(mesh["working_pressure_angle"]) - inv(alpha))
    info = {"centre_distance": round(distance, 4), "standard_distance": standard,
            "contact_ratio": round(mesh["contact_ratio"], 4), "backlash_nominal": round(nominal, 4)}
    xy = (print_config or {}).get("xy_tolerance_mm")
    if xy is None:
        return check(name, NOT_EVALUATED, title,
                     f"Khe hở răng theo thiết kế {nominal:.3g} mm (từ khoảng cách tâm; răng mô hình coi là chuẩn), hệ "
                     f"số trùng khớp {mesh['contact_ratio']:.3f}. Chưa biết sai số XY của máy in "
                     "(print.xy_tolerance_mm) để biết còn lại bao nhiêu sau in.", round(nominal, 4), unit="mm"), info
    # Each flank may grow by the XY error: both gears, one flank each side of the gap
    printed = nominal - 2 * xy
    info["backlash_printed_estimate"] = round(printed, 4)
    status = FAIL if printed <= 0 else (WARNING if printed < 0.05 else PASS)
    return check(name, status, title, f"Khe hở răng dự kiến sau in {printed:.3g} mm (thiết kế {nominal:.3g} mm, sai số "
                                      f"XY ±{xy:g} mm mỗi bên).", round(printed, 4), 0.05, "mm"), info


def analyze(model, print_config=None, fits=None, gears=None, pairs=None, thickness=True):
    """Step 4. `fits`: [{"hole", "shaft", "type"}] naming coaxial features (assembly ids) and the fit wanted;
    without it every coaxial pair is checked as a running fit. `gears`: [{"component_a", "component_b", "teeth_a",
    "teeth_b", "module", "pressure_angle_deg"?, "axis"?}]. `pairs`: component pairs to measure the gap of (all
    by default, when the assembly is small)."""
    result = schema.new_result("clearance", model, {"print": print_config, "fits": fits, "gears": gears,
                                                    "pairs": pairs})
    ms = geometry.meshes(model)
    checks = result["checks"]
    data = result["data"]
    if not print_config:
        result["missing"].append("print: máy in, vật liệu, đầu phun, số thành và sai số lỗ/trục đo được")

    # Gaps between components
    ids = list(ms)
    wanted = pairs or [[a, b] for i, a in enumerate(ids) for b in ids[i + 1:]]
    if len(wanted) > 45:
        wanted = wanted[:45]
        result["warnings"].append({"path": "pairs", "message": "Quá nhiều cặp: chỉ đo 45 cặp đầu."})
    gaps = []
    for a, b in wanted:
        if a not in ms or b not in ms:
            raise EngError(422, "BAD_PAIR", f"Cặp {a!r}/{b!r}: không có chi tiết đó.")
        gap, pa, pb = assembly.min_distance(ms[a], ms[b])
        overlap = geometry.interference({a: ms[a], b: ms[b]})
        gaps.append({"a": a, "b": b, "gap": round(gap, 5), "at_a": np.round(pa, 3).tolist(),
                     "at_b": np.round(pb, 3).tolist(), "overlap_volume": overlap[0]["volume"] if overlap else 0.0})
    data["gaps"] = gaps

    # Fits
    features = assembly.all_features(ms)
    coaxial = {(p["hole"], p["shaft"]): p for p in assembly.coaxial_pairs(features)}
    data["features"] = [fj for fj, _ in features]
    requested = fits if fits is not None else [{"hole": h, "shaft": s, "type": "running"} for h, s in coaxial]
    if fits is None and coaxial:
        result["assumptions"].append({"path": "fits", "message": "Không khai báo kiểu lắp: coi mọi cặp lỗ/trục đồng "
                                                                 "trục là lắp quay (running)."})
    data["fits"] = []
    for i, f in enumerate(requested):
        pair = coaxial.get((f.get("hole"), f.get("shaft")))
        if pair is None:
            raise EngError(422, "BAD_FIT", f"fits[{i}]: không có cặp lỗ {f.get('hole')!r} / trục {f.get('shaft')!r} "
                                           f"đồng trục (có: {[list(k) for k in coaxial]}).")
        fit_type = f.get("type", "running")
        if fit_type not in FIT_TYPES:
            raise EngError(422, "BAD_FIT", f"fits[{i}].type phải là một trong {FIT_TYPES}.")
        c, info = fit_check(pair, fit_type, print_config)
        checks.append(c)
        data["fits"].append({"hole": pair["hole"], "shaft": pair["shaft"], "type": fit_type,
                             "diametral_clearance_nominal": pair["diametral_clearance"], **(info or {})})

    # Gears
    data["gears"] = []
    for g in gears or []:
        for key in ("teeth_a", "teeth_b", "module"):
            if not isinstance(g.get(key), (int, float)) or g[key] <= 0:
                raise EngError(422, "BAD_GEAR", f"gears[].{key} phải là số dương.")
        c, info = gear_backlash(g, ms, print_config)
        checks.append(c)
        data["gears"].append(info)

    # Walls
    if thickness:
        data["walls"] = {}
        for cid, mesh in ms.items():
            c, info = thickness_check(cid, mesh, print_config)
            checks.append(c)
            data["walls"][cid] = info
    if not checks:
        checks.append(check("clearance", NOT_EVALUATED, "Khe hở", "Không có cặp lắp ghép nào để kiểm tra."))
    result["status"] = schema.overall(checks)
    return result


def poses(folder, body):
    """[(t, 4×4 world transform of the body's own frame in mm)] from a Chrono run's body_transforms.csv"""
    import csv

    out = []
    with open(folder / "body_transforms.csv", newline="") as f:
        for row in csv.DictReader(f):
            if row["body"] != body:
                continue
            q = [float(row[k]) for k in ("qw", "qx", "qy", "qz")]
            m = trimesh.transformations.quaternion_matrix(q)
            m[:3, 3] = [float(row[k]) * 1000 for k in ("x", "y", "z")]
            out.append((float(row["t"]), m))
    return out


def motion_clearance(model, sim_folder, bodies, frames=60, pairs=None):
    """Step 4 over a motion: each mapped component moves with its Chrono body (its mesh is in the assembly frame
    at t = 0, so it moves by T(t)·T(0)⁻¹). Smallest gap per pair over the sampled times, and the times they
    overlap."""
    result = schema.new_result("motion_clearance", model, {"sim_id": sim_folder.name, "bodies": bodies,
                                                           "frames": frames})
    ms = geometry.meshes(model)
    tracks = {}
    for cid, body in bodies.items():
        if cid not in ms:
            raise EngError(422, "BAD_BODY_MAP", f"bodies: không có chi tiết {cid!r}.")
        track = poses(sim_folder, body)
        if not track:
            raise EngError(422, "BAD_BODY_MAP", f"bodies: mô phỏng không có body {body!r}.")
        tracks[cid] = track
    n = min(len(t) for t in tracks.values())
    picks = np.unique(np.linspace(0, n - 1, min(frames, n)).astype(int))
    ids = list(tracks)
    wanted = pairs or [[a, b] for i, a in enumerate(ids) for b in ids[i + 1:]]
    worst = {f"{a}/{b}": {"min_gap": math.inf, "at_t": None, "overlap_times": []} for a, b in wanted}
    for k in picks:
        moved = {}
        for cid in {c for pair in wanted for c in pair}:
            t0 = tracks[cid][0][1]
            tk = tracks[cid][k][1]
            m = ms[cid].copy()
            m.apply_transform(tk @ np.linalg.inv(t0))
            moved[cid] = m
        t = tracks[ids[0]][k][0]
        for a, b in wanted:
            entry = worst[f"{a}/{b}"]
            over = geometry.interference({a: moved[a], b: moved[b]})
            if over and over[0]["volume"]:
                entry["overlap_times"].append(round(t, 5))
                entry["min_gap"] = min(entry["min_gap"], 0.0)
                continue
            gap, _, _ = assembly.min_distance(moved[a], moved[b], samples=2000)
            if gap < entry["min_gap"]:
                entry["min_gap"], entry["at_t"] = gap, round(t, 5)
    for key, e in worst.items():
        if e["overlap_times"]:
            result["checks"].append(check(f"motion.{key}", FAIL, f"Va chạm khi chuyển động {key}",
                                          f"Chồng lên nhau tại {len(e['overlap_times'])} thời điểm, đầu tiên t = "
                                          f"{e['overlap_times'][0]} s.", 0.0, unit="mm"))
        else:
            result["checks"].append(check(f"motion.{key}", PASS if e["min_gap"] > 0 else WARNING,
                                          f"Khe hở khi chuyển động {key}",
                                          f"Nhỏ nhất {e['min_gap']:.4g} mm tại t = {e['at_t']} s (trên {len(picks)} "
                                          "thời điểm lấy mẫu; giữa các mẫu có thể nhỏ hơn).",
                                          round(e["min_gap"], 5), unit="mm"))
        e["min_gap"] = None if e["min_gap"] == math.inf else round(e["min_gap"], 5)
    result["data"] = {"pairs": worst, "frames_sampled": int(len(picks))}
    result["assumptions"].append({"path": "frames", "message": f"Kiểm tra tại {len(picks)} thời điểm cách đều; va "
                                                               "chạm ngắn giữa hai mẫu có thể bị bỏ sót."})
    result["status"] = schema.overall(result["checks"])
    return result
