"""
Step 7: what may go wrong printing each component, for the print setup the user declares (print config):
overhangs needing support, bed contact, thin walls, small and horizontal holes, size against the build volume,
layer direction against the load (from an FEA result), and what still needs a calibration print. The material's
name alone predicts no strength: without measured data the strength assessment stays preliminary.
"""

import math

import numpy as np

from . import assembly, clearance, geometry, schema
from .schema import FAIL, NOT_EVALUATED, PASS, WARNING, check

DEFAULT_OVERHANG_DEG = 45.0
BED_BAND_MM = 0.3


def overhangs(mesh, direction, limit_deg, bed_band):
    """Faces facing down steeper than the limit (from the build plane), off the bed: their area and box"""
    d = np.asarray(direction, float)
    heights = mesh.triangles_center @ d
    floor = float((mesh.vertices @ d).min())
    down = mesh.face_normals @ d
    # A face whose normal is more than (90° - limit) from straight down needs support at limit = 45°
    steep = down < -math.cos(math.radians(limit_deg))
    off_bed = heights > floor + bed_band
    faces = np.nonzero(steep & off_bed)[0]
    on_bed = np.nonzero((down < -0.999) & ~off_bed)[0]
    area = float(mesh.area_faces[faces].sum())
    box = None
    if len(faces):
        pts = mesh.triangles[faces].reshape(-1, 3)
        box = {"min": pts.min(axis=0).round(2).tolist(), "max": pts.max(axis=0).round(2).tolist()}
    return area, box, float(mesh.area_faces[on_bed].sum()), faces


def analyze(model, print_config=None, fea_result=None, intents=None):
    result = schema.new_result("printability", model, {"print": print_config,
                                                       "fea_analysis": fea_result and fea_result.get("analysis_id")})
    checks, data = result["checks"], {}
    p = print_config or {}
    if not print_config:
        result["missing"].append("print: máy in, đầu phun, chiều cao lớp, số thành, infill, hướng in, sai số đo được")
    if not p.get("build_direction_given"):
        result["assumptions"].append({"path": "print.build_direction", "message": "Coi hướng in là +Z của mô hình "
                                                                                    "(mặt dưới cùng nằm trên bàn)."})
    limit = p.get("overhang_limit_deg")
    if limit is None:
        limit = DEFAULT_OVERHANG_DEG
        result["assumptions"].append({"path": "print.overhang_limit_deg", "message": "Góc nhô tối đa không support "
                                                                                     "45° (quy tắc chung FDM, chưa "
                                                                                     "hiệu chuẩn cho máy/vật liệu này)."})
    lw = schema.line_width(p)
    direction = p.get("build_direction") or [0.0, 0.0, 1.0]
    for cid, mesh in geometry.meshes(model).items():
        info = {}
        if not geometry.solid_ok(mesh):
            checks.append(check(f"{cid}.solid", FAIL if (intents or {}).get(cid, "solid") == "solid" else WARNING,
                                f"{cid}: lưới in được", "Lưới không kín/đúng hướng: máy cắt lớp có thể in sai."))
        area, box, bed_area, _ = overhangs(mesh, direction, limit, p.get("layer_height_mm") or BED_BAND_MM)
        info.update(overhang_area_mm2=round(area, 2), overhang_box=box, bed_contact_mm2=round(bed_area, 2))
        checks.append(check(f"{cid}.overhang", WARNING if area > 1.0 else PASS, f"{cid}: phần nhô cần support",
                            f"{area:.0f} mm² mặt nhô quá {limit:g}° so với phương đứng" +
                            (f", trong vùng {box['min']}…{box['max']} mm." if box else ".") if area > 1.0 else
                            "Không có mặt nhô quá giới hạn.", round(area, 2), 0, "mm²", box))
        # The box of the part seen from above (along the build direction)
        u, v = assembly.plane_basis(np.asarray(direction, float))
        footprint = float(np.ptp(mesh.vertices @ u) * np.ptp(mesh.vertices @ v))
        if bed_area <= 0:
            checks.append(check(f"{cid}.bed", FAIL, f"{cid}: tiếp xúc bàn in",
                                "Không có mặt phẳng nào nằm trên bàn theo hướng in này: chi tiết đứng trên điểm/cạnh.",
                                0.0, unit="mm²"))
        else:
            ratio = bed_area / max(footprint, 1e-9)
            checks.append(check(f"{cid}.bed", WARNING if ratio < 0.05 else PASS, f"{cid}: tiếp xúc bàn in",
                                f"{bed_area:.0f} mm² trên bàn" + (" (nhỏ so với kích thước: dễ đổ/bong, cân nhắc brim)"
                                                                   if ratio < 0.05 else "") + ".",
                                round(bed_area, 2), unit="mm²"))
        # Walls
        c, walls = clearance.thickness_check(cid, mesh, p)
        checks.append(c)
        info["walls"] = walls
        # Holes
        holes = [f for f in assembly.cylinders(mesh) if f["kind"] == "hole"]
        info["holes"] = []
        for k, h in enumerate(holes, 1):
            dia = 2 * h["radius"]
            horizontal = abs(float(np.dot(h["axis"], direction))) < 0.5
            entry = {"id": f"{cid}.hole{k}", "diameter": round(dia, 3), "horizontal": horizontal}
            info["holes"].append(entry)
            if lw and dia < 2 * lw:
                checks.append(check(f"{cid}.hole{k}.size", FAIL, f"{cid}: lỗ Ø{dia:.2f} quá nhỏ",
                                    f"Nhỏ hơn 2 đường đùn ({2 * lw:g} mm): sẽ bị lấp.", round(dia, 3), 2 * lw, "mm"))
            if horizontal and dia > 6:
                checks.append(check(f"{cid}.hole{k}.horizontal", WARNING, f"{cid}: lỗ Ø{dia:.2f} nằm ngang",
                                    "Nửa trên của lỗ là mái nhô/cầu: lỗ ra méo hoặc võng; dùng lỗ giọt nước, support, "
                                    "hoặc khoan/doa lại.", round(dia, 3), unit="mm"))
            if p.get("hole_shrink_mm") is None:
                checks.append(check(f"{cid}.hole{k}.tolerance", NOT_EVALUATED, f"{cid}: kích thước lỗ Ø{dia:.2f} sau in",
                                    "Chưa biết lỗ in ra nhỏ đi bao nhiêu (print.hole_shrink_mm): cần mẫu hiệu chuẩn.",
                                    round(dia, 3), unit="mm"))
        # Build volume
        size = np.ptp(mesh.vertices, axis=0)
        if p.get("build_volume_mm"):
            fits = all(s <= v for s, v in zip(sorted(size), sorted(p["build_volume_mm"])))
            checks.append(check(f"{cid}.build_volume", PASS if fits else FAIL, f"{cid}: vừa bàn in",
                                f"{np.round(size, 1).tolist()} mm so với {p['build_volume_mm']} mm.",
                                np.round(size, 2).tolist(), p["build_volume_mm"], "mm"))
        data[cid] = info
    # Layers against the load
    if fea_result and fea_result.get("state") == "completed":
        snn = fea_result["data"].get("interlayer_tension_MPa")
        vm = fea_result["data"].get("robust_max_von_mises_MPa")
        comp = fea_result["data"].get("component")
        if snn is not None and vm:
            share = snn / vm
            checks.append(check(f"{comp}.layers", WARNING if share > 0.3 else PASS,
                                f"{comp}: hướng lớp so với tải",
                                f"Ứng suất kéo vuông góc với lớp ~{snn:.3g} MPa = {share * 100:.0f} % ứng suất lớn nhất: "
                                + ("tải kéo tách lớp, nên xoay hướng in để lớp chạy dọc theo ứng suất." if share > 0.3
                                   else "tải chủ yếu chạy dọc theo lớp."), round(share, 3), 0.3))
        else:
            checks.append(check(f"{comp}.layers", NOT_EVALUATED, f"{comp}: hướng lớp so với tải",
                                "FEA chưa có hướng in (print.build_direction) để tính ứng suất vuông góc lớp."))
    else:
        checks.append(check("layers", NOT_EVALUATED, "Hướng lớp so với tải", "Chưa có kết quả FEA (fea_analysis_id)."))
    # Strength from the material name only
    checks.append(check("strength_basis", NOT_EVALUATED if not fea_result else WARNING, "Độ bền chi tiết in",
                        "Không suy ra độ bền từ tên vật liệu. Độ bền in phụ thuộc hãng filament, nhiệt độ, chiều cao "
                        "lớp, số thành, infill và hướng in: chỉ là đánh giá sơ bộ cho đến khi có số đo trên mẫu in."))
    calibrate = [k for k, label in (("hole_shrink_mm", "lỗ/trục (độ co lỗ)"), ("shaft_growth_mm", "trục (độ nở)"),
                                    ("xy_tolerance_mm", "sai số XY"), ("min_clearance_mm", "khe hở lắp quay tối thiểu"),
                                    ("overhang_limit_deg", "góc nhô tối đa")) if p.get(k) is None]
    data["calibration_needed"] = calibrate
    for name in ("nozzle_mm", "layer_height_mm", "walls", "infill_percent", "filament", "nozzle_temp_C"):
        if p.get(name) is None:
            result["missing"].append(f"print.{name}")
    result["data"] = data
    result["status"] = schema.overall(checks)
    return result
