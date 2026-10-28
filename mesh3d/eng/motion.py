"""
Step 5: motion of an assembly with Project Chrono, through the simulation package (sim/, docs/mechanical-simulation.md).

configure() turns the model into a mechanism: every component a rigid body whose frame is the assembly frame at
t = 0 (its mesh is already placed there), its mass properties from its closed mesh and the density the user gives
(or a mass), the joints the user confirmed (analyze_assembly) or gives here, and the motors, loads and simulation
settings in the mechanism format. It is stored as a sim mechanism. run() starts that mechanism in Chrono and
collects the result as an AnalysisResult; with `check_clearance`, the parts are then moved through the motion and
checked for collisions (clearance.motion_clearance).

Rigid bodies: a result here says nothing about bending or breaking (that is the FEA's job).
"""

import time
from pathlib import Path

from sim import runs as sim

from . import clearance, geometry, schema
from .assembly import assembly_file
from .schema import FAIL, NOT_EVALUATED, PASS, WARNING, check
from .store import EngError, now, read_json, write_json

RIGID_NOTE = ("Mô hình vật rắn: kết quả cho chuyển động, phản lực và mômen, không cho biết chi tiết có cong, võng hay gãy "
              "không; dùng FEA cho độ bền.")


def joint_to_sim(j):
    out = {"id": j["id"], "type": j["type"]}
    if j["type"] == "gear":
        out.update({k: j[k] for k in ("joint_a", "joint_b", "teeth_a", "teeth_b") if k in j})
        for k in ("internal", "model", "backlash", "friction", "mesh_stiffness_N_per_m", "young_modulus_Pa",
                  "pressure_angle", "damping_ratio"):
            if k in j:
                out[k] = j[k]
        return out
    out.update(body_a=j["component_a"], body_b=j["component_b"], position=j.get("position") or [0, 0, 0])
    if j.get("axis"):
        out["axis"] = j["axis"]
    if j.get("limits"):
        out["limits"] = j["limits"]
    return out


def configure(model, components=None, joints=None, actuators=None, forces=None, simulation=None,
              assumed_density_kg_m3=None, name=None):
    """A sim mechanism from the model. `components`: {component id: {"fixed"?, "density_kg_m3"? | "mass_kg"?,
    "collision"?, "material"?}}. `joints`: mechanism-format joints over component ids, else the confirmed ones."""
    components = components or {}
    ms = geometry.meshes(model)
    unknown = [c for c in components if c not in ms]
    if unknown:
        raise EngError(422, "BAD_COMPONENT", f"Không có chi tiết {unknown} (có: {list(ms)}).")
    assumptions, missing = [], []
    bodies = []
    for cid, mesh in ms.items():
        spec = components.get(cid, {})
        body = {"id": cid, "name": cid, "position": [0, 0, 0], "fixed": bool(spec.get("fixed", False)),
                "geometry": {"type": "mesh", "file": f"eng/models/{model['model_id']}/v{model['version']}/components/"
                                                      f"{cid}.ply"}}
        if not body["fixed"]:
            if not geometry.solid_ok(mesh):
                raise EngError(422, "NOT_SOLID", f"{cid}: lưới không kín, không tính được khối lượng và quán tính.")
            if spec.get("mass_kg") is not None:
                # A weighed part: its mass spread evenly through the mesh gives the centre of mass and inertia
                body["density"] = spec["mass_kg"] / (mesh.volume * 1e-9)
                assumptions.append({"path": f"components.{cid}.mass_kg",
                                    "message": "Trọng tâm và quán tính tính từ lưới với khối lượng cho, phân bố đều "
                                               "(infill thật làm quán tính khác đi)."})
            elif spec.get("density_kg_m3") is not None:
                body["density"] = spec["density_kg_m3"]
            elif assumed_density_kg_m3 is not None:
                body["density"] = assumed_density_kg_m3
                assumptions.append({"path": f"components.{cid}.density_kg_m3",
                                    "message": f"Khối lượng riêng GIẢ ĐỊNH {assumed_density_kg_m3:g} kg/m³, chi tiết đặc "
                                               "100 %: ảnh hưởng mômen động cơ, phản lực, gia tốc và dao động; chuyển "
                                               "động do động cơ góc/vị trí áp đặt thì không đổi."})
            else:
                missing.append(f"components.{cid}.density_kg_m3 (hoặc mass_kg), hoặc assumed_density_kg_m3")
        for key in ("collision", "material", "visual"):
            if key in spec:
                body[key] = spec[key]
        bodies.append(body)
    if missing:
        raise EngError(422, "MISSING_MASS", "Thiếu khối lượng: " + "; ".join(missing) +
                       ". Khối lượng chi tiết in phụ thuộc infill, không tự đoán.", missing)
    if joints is None:
        joints = read_json(assembly_file(model), {"joints": []})["joints"]
        if not joints:
            raise EngError(422, "NO_JOINTS", "Chưa có khớp: xác nhận khớp bằng analyze_assembly (joints) hoặc truyền "
                                             "joints ở đây.")
        joints = [joint_to_sim(j) for j in joints]
    mechanism = {"schema_version": 1, "name": name or f"{model['name']} v{model['version']}",
                 "units": {"length": "mm", "mass": "kg", "angle": "deg"}, "bodies": bodies, "joints": joints,
                 "actuators": actuators or [], "forces": forces or [], "simulation": simulation or {}}
    try:
        created = sim.create_mechanism(mechanism)
    except sim.SimError as err:
        raise EngError(err.status, err.code, err.message, err.details) from err
    record = {"mechanism_id": created["mechanism_id"], "model_id": model["model_id"],
              "model_version": model["version"], "assumptions": assumptions, "created_at": now()}
    folder = Path(model["_dir"]) / "motion"
    folder.mkdir(exist_ok=True)
    write_json(folder / f"{created['mechanism_id']}.json", record)
    return {**created, "assumptions": assumptions + created.get("validation", {}).get("assumptions", []),
            "note": RIGID_NOTE}


def run(model, mechanism_id, simulation=None, wait_s=120, check_clearance=True, frames=60):
    """Runs the mechanism in Chrono and turns its summary into checks; then the collision sweep"""
    record = read_json(Path(model["_dir"]) / "motion" / f"{mechanism_id}.json")
    if record is None:
        raise EngError(404, "MOTION_NOT_FOUND", f"{mechanism_id} không phải cấu hình chuyển động của {model['model_id']} "
                                                f"v{model['version']}.")
    try:
        started = sim.start_run(mechanism_id=mechanism_id, simulation=simulation)
    except sim.SimError as err:
        raise EngError(err.status, err.code, err.message, err.details) from err
    sim_id = started["sim_id"]
    deadline = time.monotonic() + wait_s
    status = sim.status(sim_id)
    while status["state"] in ("queued", "running") and time.monotonic() < deadline:
        time.sleep(0.5)
        status = sim.status(sim_id)
    result = schema.new_result("motion", model, {"mechanism_id": mechanism_id, "simulation": simulation})
    result.update(sim_id=sim_id, state=status["state"], assumptions=record["assumptions"] + status.get("assumptions", []),
                  warnings=status.get("warnings", []) + [{"path": "model", "message": RIGID_NOTE}])
    if status["state"] in ("queued", "running"):
        result["checks"].append(check("motion", NOT_EVALUATED, "Mô phỏng chuyển động",
                                      f"Đang chạy ({sim_id}); hỏi lại bằng run_motion_simulation với sim_id."))
        return result
    return collect(model, result, sim_id, check_clearance, frames)


def collect(model, result, sim_id, check_clearance=True, frames=60):
    status = sim.status(sim_id)
    result["state"] = status["state"]
    if status["state"] != "completed":
        result["error"] = status.get("error")
        result["checks"].append(check("motion", NOT_EVALUATED, "Mô phỏng chuyển động",
                                      f"Chrono không chạy xong ({status['state']}): {status.get('error')}"))
        result["status"] = NOT_EVALUATED
        return result
    res = sim.results(sim_id)
    summary = res["summary"]
    result["engine"] = {"chrono": summary.get("engine")}
    result["data"] = {"summary": summary, "files": res["files"]}
    for c in summary["checks"]:
        status_ = {True: PASS, False: FAIL, None: NOT_EVALUATED}[c.get("passed")]
        result["checks"].append(check(f"chrono.{c['id']}", status_, c.get("description", c["id"]),
                                      c.get("description", ""), c.get("max_error"), c.get("tolerance"), c.get("unit")))
    if check_clearance:
        folder = sim.run_dir(sim_id)
        model_json = read_json(folder / "model.json", {})
        moving = {b["id"]: b["id"] for b in model_json.get("bodies", [])}
        if len(moving) > 1:
            sweep = clearance.motion_clearance(model, folder, moving, frames)
            result["checks"] += sweep["checks"]
            result["data"]["motion_clearance"] = sweep["data"]
            result["assumptions"] += sweep["assumptions"]
    result["status"] = schema.overall(result["checks"])
    return result
