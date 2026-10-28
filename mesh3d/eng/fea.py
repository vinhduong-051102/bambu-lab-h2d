"""
Step 6: linear static FEA of one component, through gmsh and CalculiX (fea_run.py in /opt/fea). The same two
engines FreeCAD's FEM workbench drives; called directly, without FreeCAD's GUI and document model, because the
pipeline already has the geometry as a mesh and only needs the solver.

configure(): checks a FEAConfig and stores it with the model version:
  {"component", "material": {young_modulus_MPa, poisson_ratio, strengths…}, "constraints": [{"region"}],
   "loads": [{"type": "force", "region", "vector" (N, total)} | {"type": "pressure", "region", "value" (MPa)}],
   "mesh_size_mm"?, "convergence": true, "required_safety_factor"?, "max_displacement_mm"?, "print"?}
Regions (mm, the model's frame): {"box": {"min", "max"}}, {"plane": {"axis", "value", "tolerance"}},
{"sphere": {"center", "radius"}}.
run(): queues the solve; the result says what was computed and, without the data for them, what was not.
"""

import os
import queue
import subprocess
import threading
import time
from pathlib import Path

import numpy as np

from . import geometry, schema
from .schema import FAIL, NOT_EVALUATED, PASS, WARNING, check
from .store import EngError, analysis_dir, new_analysis, new_id, now, read_json, write_json

FEA_PYTHON = os.environ.get("FEA_PYTHON", "/opt/fea/bin/python")
TIMEOUT_S = float(os.environ.get("FEA_TIMEOUT_S", "1800"))
MAX_NODES_HINT = 400_000
pending = queue.Queue()
running = {}
lock = threading.Lock()


def ready():
    return Path(FEA_PYTHON).exists()


def read_region(r, obj, path):
    if not isinstance(obj, dict) or len(obj) != 1 or next(iter(obj)) not in ("box", "plane", "sphere"):
        r.error(path, 'Cần đúng một trong {"box": {min, max}}, {"plane": {axis, value, tolerance}}, '
                      '{"sphere": {center, radius}} (mm).')
        return None
    kind, spec = next(iter(obj.items()))
    if kind == "box":
        lo, hi = r.vector(spec, "min", f"{path}.box", required=True), r.vector(spec, "max", f"{path}.box", required=True)
        if lo and hi and any(a > b for a, b in zip(lo, hi)):
            r.error(f"{path}.box", "min phải ≤ max.")
        return {"box": {"min": lo, "max": hi}}
    if kind == "plane":
        axis = r.choice(spec, "axis", f"{path}.plane", ("x", "y", "z"))
        value = r.number(spec, "value", f"{path}.plane", required=True)
        tol = r.number(spec, "tolerance", f"{path}.plane", positive=True) or 1e-3
        return {"plane": {"axis": axis, "value": value, "tolerance": tol}}
    centre = r.vector(spec, "center", f"{path}.sphere", required=True)
    radius = r.number(spec, "radius", f"{path}.sphere", positive=True, required=True)
    return {"sphere": {"center": centre, "radius": radius}}


def configure(model, cfg):
    """Checks the FEA setup against the model; stores it; returns it with its id, assumptions and missing data"""
    if not isinstance(cfg, dict):
        raise EngError(400, "BAD_CONFIG", "config phải là object.")
    r = schema.Reader()
    cid = cfg.get("component")
    mesh = geometry.load_component(model, cid) if isinstance(cid, str) else None
    if mesh is None:
        r.error("component", "Cần tên chi tiết (component).")
    material, errors = schema.read_material(cfg.get("material"))
    r.errors += errors
    if not material or material.get("young_modulus_MPa") is None or material.get("poisson_ratio") is None:
        r.error("material", "FEA cần material.young_modulus_MPa và material.poisson_ratio của vật liệu in (không suy "
                            "ra từ tên PLA/PETG/ABS).")
    constraints = [{"region": read_region(r, c.get("region") if isinstance(c, dict) else None, f"constraints[{i}].region")}
                   for i, c in enumerate(cfg.get("constraints") or [])]
    if not constraints:
        r.error("constraints", "Cần ít nhất một vùng ngàm (constraints[].region).")
    loads = []
    for i, load in enumerate(cfg.get("loads") or []):
        path = f"loads[{i}]"
        kind = r.choice(load, "type", path, ("force", "pressure"))
        entry = {"type": kind, "region": read_region(r, load.get("region"), f"{path}.region")}
        if kind == "force":
            entry["vector"] = r.vector(load, "vector", path, required=True)
        elif kind == "pressure":
            entry["value"] = r.number(load, "value", path, required=True)
        loads.append(entry)
    if not loads:
        r.error("loads", "Cần ít nhất một tải (loads[]). Tải trọng phải do người dùng cho, không tự đoán.")
    print_config, errors = schema.read_print_config(cfg.get("print"))
    r.errors += errors
    size = r.number(cfg, "mesh_size_mm", "", positive=True)
    req_sf = r.number(cfg, "required_safety_factor", "", minimum=1)
    max_disp = r.number(cfg, "max_displacement_mm", "", positive=True)
    r.raise_if_any()
    if not geometry.solid_ok(mesh):
        raise EngError(422, "NOT_SOLID", f"{cid}: lưới không kín hoặc hướng mặt sai: không chia lưới thể tích được. "
                                         "Chạy validate_mesh và sửa lưới trước.")
    assumptions = [{"path": "analysis", "message": "Tuyến tính đàn hồi, đẳng hướng, biến dạng nhỏ, tĩnh. Chi tiết in "
                                                   "FDM thực tế là dị hướng (yếu hơn theo phương xếp lớp) và phụ thuộc "
                                                   "infill/số thành: lưới coi chi tiết là đặc 100 %."}]
    if size is None:
        size = round(float(min(mesh.extents)) / 4, 3)
        assumptions.append({"path": "mesh_size_mm", "message": f"Kích thước phần tử {size:g} mm (¼ cạnh nhỏ nhất)."})
    convergence = cfg.get("convergence", True) is not False
    sizes = [size, round(size / 1.6, 4)] if convergence else [size]
    if mesh.volume / (sizes[-1] ** 3) * 1.5 > MAX_NODES_HINT:
        raise EngError(422, "MESH_TOO_FINE", f"Lưới h = {sizes[-1]:g} mm cho ~{mesh.volume / sizes[-1] ** 3 * 1.5:.0f} "
                                             "nút: tăng mesh_size_mm.")
    stored = {"config_id": new_id("f"), "model_id": model["model_id"], "model_version": model["version"],
              "component": cid, "material": material, "constraints": constraints, "loads": loads,
              "mesh_sizes_mm": sizes, "convergence": convergence, "required_safety_factor": req_sf,
              "max_displacement_mm": max_disp, "print": print_config, "assumptions": assumptions,
              "created_at": now()}
    folder = Path(model["_dir"]) / "fea"
    folder.mkdir(exist_ok=True)
    write_json(folder / f"{stored['config_id']}.json", stored)
    missing = []
    if material.get("yield_strength_MPa") is None and material.get("tensile_strength_MPa") is None:
        missing.append("material.yield_strength_MPa hoặc tensile_strength_MPa: không có thì không tính hệ số an toàn")
    if req_sf is None:
        missing.append("required_safety_factor: không có thì không kết luận đạt/không đạt về bền")
    if material.get("interlayer_strength_MPa") is None:
        missing.append("material.interlayer_strength_MPa: không có thì không đánh giá tách lớp")
    return {**stored, "missing": missing}


def load_config(model, config_id):
    cfg = read_json(Path(model["_dir"]) / "fea" / f"{config_id}.json")
    if cfg is None:
        raise EngError(404, "CONFIG_NOT_FOUND", f"Không có cấu hình FEA {config_id} cho {model['model_id']} "
                                                f"v{model['version']}.")
    return cfg


def run(model, config_id):
    """Queues a solve; returns the analysis id at once"""
    if not ready():
        raise EngError(503, "FEA_NOT_INSTALLED", f"Chưa có môi trường FEA ({FEA_PYTHON}): rebuild image mesh3d "
                                                 "(docs/engineering-analysis.md).")
    cfg = load_config(model, config_id)
    analysis_id, folder = new_analysis("fea")
    mesh = geometry.load_component(model, cfg["component"])
    mesh.export(folder / "part.stl")
    write_json(folder / "fea.json", {"mesh_sizes_mm": cfg["mesh_sizes_mm"], "constraints": cfg["constraints"],
                                     "loads": cfg["loads"], "timeout_s": TIMEOUT_S,
                                     "material": {"E": cfg["material"]["young_modulus_MPa"],
                                                  "nu": cfg["material"]["poisson_ratio"]}})
    result = schema.new_result("fea", model, {"config": cfg})
    result.update(analysis_id=analysis_id, state="queued", started_at=now(), finished_at=None,
                  assumptions=list(cfg["assumptions"]))
    write_json(folder / "result.json", result)
    pending.put(analysis_id)
    return {"analysis_id": analysis_id, "state": "queued", "queue_position": pending.qsize() - 1}


def execute(analysis_id):
    folder = analysis_dir(analysis_id)
    result = read_json(folder / "result.json")
    result["state"] = "running"
    write_json(folder / "result.json", result)
    started = time.monotonic()
    proc = subprocess.Popen([FEA_PYTHON, str(Path(__file__).with_name("fea_run.py")), str(folder)], cwd=folder,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    running[analysis_id] = proc
    try:
        output, _ = proc.communicate(timeout=TIMEOUT_S * 2)
    except subprocess.TimeoutExpired:
        proc.kill()
        output = "timeout"
    finally:
        running.pop(analysis_id, None)
    (folder / "solver_stdout.log").write_text(output or "")
    out = read_json(folder / "fea_out.json", {"state": "failed", "error": f"fea_run.py dừng (mã {proc.returncode})."})
    result = read_json(folder / "result.json")
    result.update(finished_at=now(), duration_s=round(time.monotonic() - started, 2), engine=out.get("engine", {}),
                  files={"fea.log": "fea.log", "solver_stdout.log": "solver_stdout.log"})
    if out.get("state") != "completed":
        # No numbers when the solver failed
        result.update(state="failed", status=NOT_EVALUATED, error=out.get("error"),
                      checks=[check("solver", NOT_EVALUATED, "FEA không chạy xong", out.get("error") or "")])
    else:
        result["state"] = "completed"
        evaluate(result, out["levels"], result["inputs"]["config"])
        last = len(out["levels"]) - 1
        result["files"].update({"result.npz": f"level{last}/result.npz", "job.inp": f"level{last}/job.inp",
                                "job.frd": f"level{last}/job.frd", "ccx.log": f"level{last}/ccx.log"})
    write_json(folder / "result.json", result)


def interlayer_stress(folder, level, direction, near):
    """Largest robust normal stress across the layers (tension positive), σ_dd = dᵀσd"""
    data = np.load(folder / f"level{level}" / "result.npz")
    s = data["stress"]
    d = np.asarray(direction, float)
    sxx, syy, szz, sxy, syz, szx = s.T
    snn = (d[0] ** 2 * sxx + d[1] ** 2 * syy + d[2] ** 2 * szz + 2 * d[0] * d[1] * sxy + 2 * d[1] * d[2] * syz +
           2 * d[2] * d[0] * szx)
    keep = ~data["near_bc"] if near else np.ones(len(snn), bool)
    return float(snn[keep].max()) if keep.any() else None


def caveats(status, detail, printed_data, stress_converged):
    """A strength PASS stays a WARNING when the strength is not from printed specimens or the stress did not
    converge"""
    if status != PASS:
        return status, detail
    if not printed_data:
        status = WARNING
        detail += (" Số bền không phải đo trên mẫu in (source = test, printed = true): độ bền thật của chi tiết in "
                   "thường thấp hơn số liệu nhà sản xuất, nhất là giữa các lớp.")
    if not stress_converged:
        status = WARNING
        detail += " Ứng suất chưa hội tụ theo lưới: hệ số này chưa đáng tin."
    return status, detail


def evaluate(result, levels, cfg):
    checks = result["checks"]
    final = levels[-1]
    material = cfg["material"]
    result["data"] = {"levels": levels, "component": cfg["component"],
                      "max_displacement_mm": final["max_displacement_mm"],
                      "max_von_mises_MPa": final["max_von_mises_MPa"],
                      "robust_max_von_mises_MPa": final["robust_max_von_mises_MPa"]}
    # The loads went in as asked
    asked = sum((np.asarray(l["vector"]) for l in cfg["loads"] if l["type"] == "force"), np.zeros(3))
    applied = sum((np.asarray(a["total_N"]) for a in final["loads"] if cfg["loads"][a["index"]]["type"] == "force"),
                  np.zeros(3))
    err = float(np.linalg.norm(applied - asked))
    checks.append(check("loads", PASS if err <= 1e-6 * max(1.0, np.linalg.norm(asked)) else FAIL,
                        "Tải đưa vào lưới", f"Tổng lực đặt {np.round(applied, 6).tolist()} N so với yêu cầu "
                                            f"{np.round(asked, 6).tolist()} N.", err, unit="N"))
    # Convergence
    if len(levels) > 1:
        a, b = levels[-2], levels[-1]
        du = abs(b["max_displacement_mm"] - a["max_displacement_mm"]) / max(b["max_displacement_mm"], 1e-12)
        ds = (abs(b["robust_max_von_mises_MPa"] - a["robust_max_von_mises_MPa"]) / max(b["robust_max_von_mises_MPa"], 1e-12)
              if a["robust_max_von_mises_MPa"] and b["robust_max_von_mises_MPa"] else None)
        ok = du < 0.02 and (ds is None or ds < 0.05)
        stress_converged = ds is not None and ds < 0.05
        detail = (f"h {a['mesh_size_mm']:g} → {b['mesh_size_mm']:g} mm: chuyển vị lớn nhất đổi {du * 100:.2f} %, "
                  f"ứng suất (ngoài vùng biên) đổi {'—' if ds is None else f'{ds * 100:.2f} %'}")
        if ds is not None and ds >= 0.05:
            # A peak that keeps rising as elements shrink sits on a singularity (a sharp inside corner), not on a stress
            detail += (f". Đỉnh ở {np.round(b['robust_max_at'], 2).tolist()} mm tăng theo độ mịn lưới: nếu đó là góc "
                       "lõm sắc thì ứng suất ở đó là điểm kỳ dị số học, không hội tụ; thêm bo góc đúng như sẽ in, "
                       "hoặc đánh giá ứng suất cách góc một khoảng")
        elif du >= 0.02:
            detail += ": cần lưới mịn hơn"
        checks.append(check("convergence", PASS if ok else WARNING, "Hội tụ lưới", detail + ".", round(du, 5), 0.02,
                            where={"stress_peak_at": b["robust_max_at"]}))
    else:
        stress_converged = False
        checks.append(check("convergence", NOT_EVALUATED, "Hội tụ lưới", "Chỉ chạy một kích thước lưới."))
    # Singular peaks at the idealised supports and load patches
    peak, robust = final["max_von_mises_MPa"], final["robust_max_von_mises_MPa"]
    if robust and peak > 1.5 * robust:
        checks.append(check("singularity", WARNING, "Đỉnh ứng suất ở vùng ngàm/đặt tải",
                            f"Đỉnh {peak:.4g} MPa tại {np.round(final['max_von_mises_at'], 2).tolist()} lớn hơn nhiều so "
                            f"với {robust:.4g} MPa ở phần còn lại: thường là điểm kỳ dị do ngàm tuyệt đối/góc sắc, không "
                            "phải ứng suất thật. Dùng giá trị ngoài vùng biên, hoặc mô hình hóa vùng ngàm thật hơn.",
                            round(peak, 4)))
    # Displacement limit
    if cfg.get("max_displacement_mm"):
        lim = cfg["max_displacement_mm"]
        checks.append(check("displacement", PASS if final["max_displacement_mm"] <= lim else FAIL, "Chuyển vị lớn nhất",
                            f"{final['max_displacement_mm']:.4g} mm, giới hạn {lim:g} mm.",
                            round(final["max_displacement_mm"], 5), lim, "mm"))
    else:
        checks.append(check("displacement", NOT_EVALUATED, "Chuyển vị lớn nhất",
                            f"{final['max_displacement_mm']:.4g} mm; chưa có giới hạn cho phép (max_displacement_mm).",
                            round(final["max_displacement_mm"], 5), unit="mm"))
    # Strength
    strength = material.get("yield_strength_MPa") or material.get("tensile_strength_MPa")
    printed_data = material.get("printed") and material.get("source") == "test"
    if not strength or not robust:
        checks.append(check("strength", NOT_EVALUATED, "Hệ số an toàn",
                            "Thiếu giới hạn bền của vật liệu in (yield/tensile_strength_MPa)." if not strength else
                            "Không có ứng suất ngoài vùng biên để so sánh."))
    else:
        sf = strength / robust
        req = cfg.get("required_safety_factor")
        if req is None:
            status, detail = WARNING, f"Hệ số an toàn ~{sf:.3g} (bền {strength:g} MPa / {robust:.4g} MPa) nhưng chưa có " \
                                      "hệ số yêu cầu (required_safety_factor)."
        else:
            status = PASS if sf >= req else FAIL
            detail = f"Hệ số an toàn ~{sf:.3g} so với yêu cầu {req:g} (von Mises ngoài vùng biên)."
        status, detail = caveats(status, detail, printed_data, stress_converged)
        checks.append(check("strength", status, "Hệ số an toàn", detail, round(sf, 4), req))
    # Across the layers
    p = cfg.get("print") or {}
    if material.get("interlayer_strength_MPa") and p.get("build_direction_given"):
        snn = interlayer_stress(Path(analysis_dir(result["analysis_id"])), len(levels) - 1, p["build_direction"], True)
        sf = material["interlayer_strength_MPa"] / snn if snn and snn > 0 else None
        req = cfg.get("required_safety_factor")
        status = NOT_EVALUATED if sf is None else (FAIL if req and sf < req else (PASS if req else WARNING))
        detail = (f"Ứng suất kéo lớn nhất theo hướng in ~{snn:.4g} MPa, bền liên lớp "
                  f"{material['interlayer_strength_MPa']:g} MPa → hệ số ~{sf:.3g}." if sf else
                  "Không có ứng suất kéo theo hướng in.")
        if sf is not None:
            status, detail = caveats(status, detail, printed_data, stress_converged)
        checks.append(check("interlayer", status, "Kéo tách lớp (theo hướng in)", detail,
                            None if sf is None else round(sf, 4), req))
        result["data"]["interlayer_tension_MPa"] = snn
    else:
        checks.append(check("interlayer", NOT_EVALUATED, "Kéo tách lớp (theo hướng in)",
                            "Cần material.interlayer_strength_MPa và print.build_direction."))
    result["status"] = schema.overall(checks)


def worker_loop():
    while True:
        analysis_id = pending.get()
        try:
            execute(analysis_id)
        except Exception as err:  # noqa: BLE001 - the queue keeps going
            try:
                folder = analysis_dir(analysis_id)
                result = read_json(folder / "result.json")
                result.update(state="failed", status=NOT_EVALUATED, error=str(err)[:500], finished_at=now())
                write_json(folder / "result.json", result)
            except Exception:  # noqa: BLE001
                pass


def start():
    threading.Thread(target=worker_loop, daemon=True, name="fea").start()

