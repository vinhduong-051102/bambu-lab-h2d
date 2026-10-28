"""
The /mech routes of the mesh worker: designs as numbered revisions, their validation, simulation through the
existing sim pipeline, results, imports from the engineering models, and repairs.

  SIM_DIR/mech/designs/<design id>/r<n>/input.json        the model as given (never changed: a change is a revision)
                                       /model.json        normalised, with provenance
                                       /validation.json   diagnostics, DOF, motion, missing data, status
                                       /runs/<sim id>.json  mapping and per-part results of each run
  SIM_DIR/files/mech/<design id>/r<n>/<group>.stl          the meshes the Chrono and Blender sides read
"""

import math
import os
import re
import secrets
import time
from pathlib import Path

from sim import runs as sim

from . import chrono_adapter, kinematics, model as mech_model, repair, results
from .store_util import now, read_json, write_json

SIM_DIR = Path(os.environ.get("SIM_DIR", "/sim"))
ROOT = SIM_DIR / "mech" / "designs"
ID_RE = re.compile(r"^d-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$")
STATUS_ORDER = {"failed": 3, "warning": 2, "not_verified": 1, "passed": 0}


class MechError(Exception):
    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def resolve_file(name):
    """A geometry file a part refers to: an engineering model's component (eng/models/…), a job's file (jobs/…) or
    sim/files/…"""
    name = str(name).replace("\\", "/").lstrip("/")
    roots = {"eng": Path(os.environ.get("ENG_DIR", "/eng")), "jobs": Path(os.environ.get("JOBS_DIR", "/jobs")), "sim": SIM_DIR}
    head, _, rest = name.partition("/")
    if head not in roots or not rest:
        raise ValueError(f"Đường dẫn {name!r} phải bắt đầu bằng eng/models/…, jobs/… hoặc sim/files/….")
    root = roots[head].resolve()
    path = (root / rest).resolve()
    if root not in path.parents or not path.is_file():
        raise ValueError(f"Không có file {name!r}.")
    return str(path)


def design_dir(design_id, revision=None):
    if not ID_RE.match(design_id or ""):
        raise MechError(400, "BAD_ID", "Mã thiết kế không hợp lệ.")
    root = ROOT / design_id
    revs = sorted((int(p.name[1:]) for p in root.glob("r*") if p.name[1:].isdigit()))
    if not revs:
        raise MechError(404, "DESIGN_NOT_FOUND", f"Không có thiết kế {design_id}.")
    rev = revs[-1] if revision is None else int(revision)
    if rev not in revs:
        raise MechError(404, "REVISION_NOT_FOUND", f"{design_id} không có bản r{rev} (có: {revs}).")
    return root / f"r{rev}", rev


def save_revision(model_input, design_id=None, note=None, parent=None):
    design_id = design_id or f"d-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{secrets.token_hex(2)}"
    root = ROOT / design_id
    root.mkdir(parents=True, exist_ok=True)
    revs = [int(p.name[1:]) for p in root.glob("r*") if p.name[1:].isdigit()]
    rev = max(revs, default=0) + 1
    folder = root / f"r{rev}"
    folder.mkdir()
    write_json(folder / "input.json", model_input)
    write_json(folder / "revision.json", {"design_id": design_id, "revision": rev, "created_at": now(), "note": note,
                                          "parent_revision": parent})
    return design_id, rev, folder


def overall(diags, missing):
    if missing or any(d["severity"] == "error" for d in diags):
        return "failed"
    if any(d["severity"] == "warning" for d in diags):
        return "warning"
    return "passed"


def build(model_input):
    """(normalised result, Assembly, analysis, diagnostics, missing) of a model, or MechError on a malformed one"""
    try:
        norm = mech_model.normalise(model_input, resolve_file)
    except mech_model.ModelError as err:
        raise MechError(422, "INVALID_MODEL", f"Mô hình chưa đúng: {err}", err.errors) from err
    model = norm["model"]
    asm = kinematics.Assembly(model)
    diags = chrono_adapter.capability_check(model)
    analysis = kinematics.analyse(asm)
    diags = diags + asm.diagnostics + kinematics.geometry_checks(asm)
    return norm, asm, analysis, diags, norm["missing"]


def part_table(asm):
    out = []
    for pid, info in asm.placed.items():
        p = info["part"]
        out.append({"id": pid, "name": p["name"], "role": p["role"], "fixed": p["fixed"], "group": asm.group_of[pid],
                    "geometry": p.get("shape") or {"file": p.get("geometry_file")}, "material": p.get("material"),
                    "density": p.get("density"), "position": p["position"], "orientation": p["orientation"],
                    **{k: v for k, v in info["mass_info"].items()}})
    return out


def validate_design(design_id, revision=None):
    folder, rev = design_dir(design_id, revision)
    norm, asm, analysis, diags, missing = build(read_json(folder / "input.json"))
    validation = {"design_id": design_id, "revision": rev, "validated_at": now(), "status": overall(diags, missing),
                  "diagnostics": diags, "missing": missing, "assumptions": norm["assumptions"], "parts": part_table(asm),
                  "groups": analysis["groups"], "dof": analysis["dof"], "velocities": analysis.get("velocities"),
                  "capabilities": {k: v[0] for k, v in chrono_adapter.CAPABILITIES.items()}}
    write_json(folder / "model.json", norm["model"])
    write_json(folder / "validation.json", validation)
    return validation


def create_design(body):
    if not isinstance(body.get("model"), dict):
        raise MechError(400, "NO_MODEL", "Cần model (mech/1).")
    design_id, rev, _ = save_revision(body["model"], body.get("design_id"), body.get("note"))
    try:
        return validate_design(design_id, rev)
    except MechError as err:
        if err.code == "INVALID_MODEL":
            write_json(ROOT / design_id / f"r{rev}" / "validation.json", {"design_id": design_id, "revision": rev,
                                                                           "status": "failed", "errors": err.details})
        raise


def update_design(design_id, body):
    """A new revision: the latest input with parts/joints/gears/motors/loads/simulation replaced or merged by id"""
    folder, rev = design_dir(design_id)
    current = read_json(folder / "input.json")
    patched = repair.merge(current, body.get("changes") or {})
    new_id, new_rev, _ = save_revision(patched, design_id, body.get("note") or "Sửa bằng tay", rev)
    return validate_design(new_id, new_rev)


def get_design(design_id, revision=None):
    folder, rev = design_dir(design_id, revision)
    revs = sorted(int(p.name[1:]) for p in (ROOT / design_id).glob("r*") if p.name[1:].isdigit())
    runs = sorted(p.stem for p in (folder / "runs").glob("*.json")) if (folder / "runs").exists() else []
    return {"design_id": design_id, "revision": rev, "revisions": revs, "input": read_json(folder / "input.json"),
            "validation": read_json(folder / "validation.json"), "revision_info": read_json(folder / "revision.json"),
            "runs": runs}


def list_designs(limit=50):
    out = []
    for d in sorted(ROOT.glob("d-*"), key=lambda p: p.name, reverse=True)[:limit] if ROOT.exists() else []:
        try:
            folder, rev = design_dir(d.name)
        except MechError:
            continue
        v = read_json(folder / "validation.json") or {}
        out.append({"design_id": d.name, "revision": rev, "name": (read_json(folder / "input.json") or {}).get("name"),
                    "status": v.get("status")})
    return out


def simulate(design_id, body):
    """Validates, compiles for Chrono, runs (waiting up to wait_s), and reads the results per part"""
    folder, rev = design_dir(design_id, body.get("revision"))
    validation = validate_design(design_id, rev)
    if validation["status"] == "failed":
        raise MechError(422, "NOT_VALID", "Mô hình chưa chạy được: sửa các lỗi hoặc cho thêm dữ liệu còn thiếu.",
                        {"diagnostics": [d for d in validation["diagnostics"] if d["severity"] == "error"],
                         "missing": validation["missing"]})
    norm, asm, analysis, _, _ = build(read_json(folder / "input.json"))
    files_rel = f"files/mech/{design_id}/r{rev}"
    mechanism, mapping = chrono_adapter.compile_model(asm, SIM_DIR / files_rel, f"sim/{files_rel}")
    if body.get("simulation"):
        mechanism["simulation"] = {**mechanism["simulation"], **body["simulation"]}
    mapping["assumptions"] = []
    # Consistent redundant constraints (a planar loop of 3D joints) make the constraint matrix singular: MINRES
    # solves such systems where the default iterative solver leaves microns of drift (crank-slider: 6.6 µm → 0.1 µm)
    if analysis["dof"].get("redundant_equations") and "solver" not in mechanism["simulation"]:
        mechanism["simulation"].update(solver="minres", max_iterations=mechanism["simulation"].get("max_iterations", 300))
        mapping["assumptions"].append({"path": "simulation.solver", "message": f"{analysis['dof']['redundant_equations']} "
                                       "phương trình ràng buộc thừa: dùng bộ giải MINRES (hệ suy biến)."})
    # The kinematic prediction for a linkage driven by one rotary motor: positions over one turn
    sweep_data = None
    rotary = [m for m in norm["model"]["motors"] if m.get("mode") in ("speed", "angle")]
    has_slider = any(j["type"] in ("prismatic", "cylindrical") for j, _, _ in asm.joints)
    if len(rotary) == 1 and has_slider and analysis["dof"]["driven"] == 0:
        try:
            sweep_data = {"motor": rotary[0]["id"], "samples": kinematics.sweep(asm, rotary[0]["id"], 2 * math.pi, 120)}
        except ValueError as err:
            validation["diagnostics"].append(kinematics.diag("warning", "KINEMATIC_SWEEP_FAILED", str(err)))
    try:
        started = sim.start_run(mechanism=mechanism)
    except sim.SimError as err:
        raise MechError(err.status, err.code, f"sim từ chối cơ cấu đã dịch: {err.message}", err.details) from err
    record = {"design_id": design_id, "revision": rev, "sim_id": started["sim_id"], "mapping": mapping,
              "mechanism": mechanism, "sweep": sweep_data, "started_at": now(), "state": "queued"}
    (folder / "runs").mkdir(exist_ok=True)
    write_json(folder / "runs" / f"{started['sim_id']}.json", record)
    deadline = time.monotonic() + float(min(max(body.get("wait_s", 120), 0), 600))
    while time.monotonic() < deadline and sim.status(started["sim_id"])["state"] in ("queued", "running"):
        time.sleep(0.5)
    return run_results(design_id, started["sim_id"], rev)


def run_results(design_id, sim_id, revision=None):
    folder, rev = design_dir(design_id, revision)
    record = read_json(folder / "runs" / f"{sim_id}.json")
    if record is None:
        # The run may belong to another revision
        for rf in (ROOT / design_id).glob("r*/runs/*.json"):
            if rf.stem == sim_id:
                record, folder = read_json(rf), rf.parent.parent
                break
    if record is None:
        raise MechError(404, "RUN_NOT_FOUND", f"Không có lần chạy {sim_id} của {design_id}.")
    status = sim.status(sim_id)
    out = {"design_id": design_id, "revision": record["revision"], "sim_id": sim_id, "state": status["state"],
           "mapping": record["mapping"], "error": status.get("error")}
    if status["state"] != "completed":
        return out
    if record.get("results"):
        return {**out, **record["results"]}
    norm, asm, analysis, _, _ = build(read_json(folder / "input.json"))
    summary = sim.results(sim_id)["summary"]
    res = results.collect(asm, analysis, record["mapping"], sim.run_dir(sim_id), summary, record.get("sweep"))
    res["sim_files"] = {k: f"/api/sim/runs/{sim_id}/{v}" for k, v in sim.results(sim_id)["files"].items()}
    record["results"], record["state"] = res, "completed"
    write_json(folder / "runs" / f"{sim_id}.json", record)
    return {**out, **res}


def propose(design_id, revision=None):
    folder, rev = design_dir(design_id, revision)
    validation = read_json(folder / "validation.json") or validate_design(design_id, rev)
    return {"design_id": design_id, "revision": rev,
            "proposals": repair.proposals(read_json(folder / "input.json"), validation)}


def apply(design_id, body):
    """A new revision with the proposals the user approved; at most repair.MAX_ROUNDS repair revisions per design"""
    folder, rev = design_dir(design_id)
    if not body.get("approved"):
        raise MechError(400, "NOT_APPROVED", "Sửa thiết kế cần người dùng duyệt (approved: true).")
    rounds = sum(1 for p in (ROOT / design_id).glob("r*/revision.json") if ((read_json(p) or {}).get("note") or "").startswith("Sửa tự động"))
    if rounds >= repair.MAX_ROUNDS:
        raise MechError(409, "REPAIR_LIMIT", f"Đã sửa tự động {rounds} lần: dừng lại, cần người dùng xem lại thiết kế.")
    validation = read_json(folder / "validation.json") or validate_design(design_id, rev)
    current = read_json(folder / "input.json")
    available = {p["id"]: p for p in repair.proposals(current, validation)}
    picked = [available[i] for i in body.get("proposal_ids") or [] if i in available]
    if not picked:
        raise MechError(422, "NO_PROPOSAL", f"Không có đề xuất nào trong {body.get('proposal_ids')} (có: {list(available)}).")
    patched = current
    for p in picked:
        if p.get("changes") is None:
            raise MechError(422, "NEEDS_USER", f"Đề xuất {p['id']} cần dữ liệu từ người dùng: {p['summary']}")
        patched = repair.merge(patched, p["changes"])
    _, new_rev, _ = save_revision(patched, design_id, "Sửa tự động: " + "; ".join(p["summary"] for p in picked), rev)
    after = validate_design(design_id, new_rev)
    return {"design_id": design_id, "from_revision": rev, "revision": new_rev, "applied": [p["id"] for p in picked],
            "before": {"status": validation["status"], "errors": [d["code"] for d in validation["diagnostics"] if d["severity"] == "error"]},
            "after": {"status": after["status"], "errors": [d["code"] for d in after["diagnostics"] if d["severity"] == "error"]},
            "validation": after}


def import_model(body):
    from . import importer

    draft = importer.draft_from_eng(body)
    if body.get("create", True):
        design_id, rev, _ = save_revision(draft["model"], None, "Nhập từ mô hình có sẵn")
        validation = validate_design(design_id, rev)
        return {**draft, "design_id": design_id, "revision": rev, "validation": validation}
    return draft


def capabilities():
    return {"capabilities": {k: {"state": v[0], "detail": v[1]} for k, v in chrono_adapter.CAPABILITIES.items()}}
