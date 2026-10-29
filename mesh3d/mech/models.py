"""
Simulation as part of a 3D model's life (docs/model-simulation.md): the model the user made or imported is simulated
as it is, not redrawn as a separate mechanism.

A model is an engineering model (eng/: versions v1, v2… of its components, from a design job's components or from an
imported file). Its simulation setup is a mech design (designs/<id>/r<n>) that names the model and the version it was
set up for; each change of setup is a revision, each run belongs to the revision it ran.

  setup(body)   the model's current version (a design job: its components imported as a new version when they
                changed) → the design: created from the components, the job's declared `mechanism` and the joint
                hypotheses the geometry suggests (never accepted on their own); or, when the model changed since,
                a new revision with the setup carried over by component, validated again
  status(id)    the state, from the stored data: NOT_CONFIGURED, NEEDS_VALIDATION, INVALID, READY, RUNNING,
                COMPLETED, FAILED (a live session adds RUNNING/PAUSED in the gateway, which sees the live container)
"""

import os
import re
from pathlib import Path

from eng import geometry as eng_geometry
from eng import store as eng_store
from eng.store import EngError

from . import importer, model as mech_model, service
from .service import MechError
from .store_util import now, read_json, write_json

JOBS_DIR = Path(os.environ.get("JOBS_DIR", "/jobs"))
JOB_RE = re.compile(r"^[a-z0-9][a-z0-9-]{5,63}$")
MODEL_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,80}$")


def job_model_id(job_id):
    # The same model the dashboard's engineering check uses for a job (eng/service.job_model_id)
    return f"job-{job_id}"


def job_sources(job_id):
    """([{"path", "label"}], declared mechanism or None, how the job was split) of a finished design job"""
    out = JOBS_DIR / job_id / "out"
    assembly = read_json(out / "assembly.json")
    if assembly and assembly.get("components"):
        sources = [{"path": str(out / c["file"]), "label": Path(c["file"]).name} for c in assembly["components"]]
        if all(Path(s["path"]).is_file() for s in sources):
            return sources, assembly.get("mechanism"), assembly.get("from")
    stl = out / "model.stl"
    if not stl.is_file():
        raise MechError(404, "JOB_NOT_BUILT", f"Job {job_id} chưa có model.stl.")
    return [{"path": str(stl), "label": "model.stl"}], None, "single"


def current_version(model_id, sources=None, name=None):
    """The model's latest version; with sources, a new version first when they differ from it (by content)"""
    try:
        latest = eng_store.load_model(model_id)
    except EngError:
        latest = None
    if sources is None:
        if latest is None:
            raise MechError(404, "MODEL_NOT_FOUND", f"Không có mô hình {model_id}.")
        return latest
    wanted = sorted(eng_store.sha256(s["path"]) for s in sources)
    if latest is not None and sorted(c["source_sha256"] for c in latest["components"]) == wanted:
        return latest
    try:
        return eng_geometry.import_model(sources, name, model_id=model_id)
    except EngError as err:
        raise MechError(err.status, err.code, err.message) from err


def designs_of(model_id):
    """[(design id, latest revision, its input)] set up for this model, newest first"""
    out = []
    for d in sorted(service.ROOT.glob("d-*"), key=lambda p: p.name, reverse=True) if service.ROOT.exists() else []:
        try:
            folder, rev = service.design_dir(d.name)
        except MechError:
            continue
        model = read_json(folder / "input.json") or {}
        if (model.get("source") or {}).get("eng_model") == model_id:
            out.append((d.name, rev, model))
    return out


def by_label(eng_model):
    """{source file stem: component id}: a job's components are named by their files"""
    return {Path(str(c.get("source_label") or "")).stem: c["id"] for c in eng_model["components"]}


def declared(mechanism, names):
    """The job's `mechanism` (component names) as mech/1 parts, joints, gears, motors, loads, simulation"""
    if not isinstance(mechanism, dict):
        return {}

    def ref(name):
        return names.get(name, name)

    out = {"parts": {}, "joints": [], "gears": [], "motors": [], "loads": [], "simulation": mechanism.get("simulation") or {}}
    out["notes"] = []
    for name, spec in (mechanism.get("parts") or {}).items():
        if isinstance(spec, dict):
            out["parts"][ref(name)] = {k: v for k, v in spec.items() if k not in ("id", "shape", "geometry_file", "source")}
            role = spec.get("role")
            if role is not None and role not in mech_model.ROLES:
                out["parts"][ref(name)]["role"] = "other"
                out["notes"].append(f"{name}: vai trò {role!r} không có trong danh sách, đọc là other")
    for key, fields in (("joints", ("part_a", "part_b")), ("gears", ("gear_a", "gear_b")), ("motors", ()),
                        ("loads", ("part", "part_a", "part_b"))):
        for item in mechanism.get(key) or []:
            if isinstance(item, dict):
                item = dict(item)
                for f in fields:
                    if f in item:
                        item[f] = ref(item[f])
                if key == "joints":
                    item.update(confidence="declared", source="design")
                out[key].append(item)
    return out


def draft(eng_model, mechanism, body):
    """A first setup: every component a part, what the design declared, and the geometry's joint hypotheses"""
    made = importer.draft_from_eng({"model_id": eng_model["model_id"], "version": eng_model["version"],
                                    "name": body.get("name") or eng_model["name"], "fixed": body.get("fixed"),
                                    "materials": body.get("materials"), "accept": body.get("accept")})
    model = made["model"]
    d = declared(mechanism, by_label(eng_model))
    for part in model["parts"]:
        part.update(d.get("parts", {}).get(part["id"], {}))
        if part.get("fixed") and part.get("role") == "other":
            part["role"] = "frame"
    for key in ("joints", "gears", "motors", "loads"):
        model[key] = (d.get(key) or []) + [x for x in model[key] if x["id"] not in {y["id"] for y in d.get(key) or []}]
    if d.get("simulation"):
        model["simulation"] = {**d["simulation"], **model["simulation"]}
    if d.get("notes"):
        model["notes"] = d["notes"]
    declared_pairs = {frozenset((j["part_a"], j["part_b"])) for j in d.get("joints") or []}
    hypotheses = [h for h in made["hypotheses"]
                  if frozenset((h["joint"]["part_a"], h["joint"]["part_b"]) if h["kind"] == "joint" else h["parts"])
                  not in declared_pairs]
    return model, hypotheses


def carry_over(previous, eng_model):
    """The setup of an earlier version on the new one: parts kept by component id (their geometry now the new
    version's), new components added unset, removed ones dropped with whatever named them"""
    base = f"eng/models/{eng_model['model_id']}/v{eng_model['version']}"
    components = {c["id"]: c for c in eng_model["components"]}
    model = dict(previous)
    old = {p["id"]: p for p in previous.get("parts", [])}
    parts, dropped = [], [pid for pid in old if pid not in components]
    for cid, c in components.items():
        part = dict(old.get(cid) or {"id": cid, "name": c["name"], "role": "other", "fixed": False, "source": "imported_cad"})
        if part.get("geometry_file") or cid not in old:
            part["geometry_file"] = f"{base}/{c['file']}"
        parts.append(part)
    model["parts"] = parts
    gone = set(dropped)
    model["joints"] = [j for j in previous.get("joints", []) if not ({j.get("part_a"), j.get("part_b")} & gone)]
    kept_joints = {j["id"] for j in model["joints"]}
    model["gears"] = [g for g in previous.get("gears", []) if not ({g.get("gear_a"), g.get("gear_b")} & gone)]
    model["motors"] = [m for m in previous.get("motors", []) if m.get("joint") in kept_joints]
    model["loads"] = [x for x in previous.get("loads", []) if not ({x.get("part"), x.get("part_a"), x.get("part_b")} & gone)]
    model["source"] = {**(previous.get("source") or {}), "eng_model": eng_model["model_id"], "version": eng_model["version"]}
    added = [cid for cid in components if cid not in old]
    note = f"Mô hình đổi sang v{eng_model['version']}: mang cấu hình sang"
    if added:
        note += f"; chi tiết mới chưa cấu hình: {', '.join(added)}"
    if dropped:
        note += f"; bỏ chi tiết không còn: {', '.join(dropped)}"
    return model, note


def setup(body):
    """The model's design, created or brought up to the model's version; its status"""
    job_id = body.get("job_id")
    mechanism = None
    if job_id is not None:
        if not JOB_RE.match(str(job_id)):
            raise MechError(400, "BAD_JOB", "Mã job không hợp lệ.")
        sources, mechanism, _ = job_sources(str(job_id))
        model_id = job_model_id(job_id)
        # Named as the dashboard shows the job: the title Claude gave it
        title = ((read_json(JOBS_DIR / str(job_id) / "status.json") or {}).get("result") or {}).get("title")
        body = {**body, "name": body.get("name") or title or str(job_id)}
        eng_model = current_version(model_id, sources, body["name"])
    else:
        model_id = str(body.get("model_id") or "")
        if not MODEL_RE.match(model_id):
            raise MechError(400, "NO_MODEL", "Cần job_id hoặc model_id (từ inspect_3d_model).")
        eng_model = current_version(model_id) if body.get("version") is None else eng_store.load_model(model_id, body["version"])
    found = designs_of(model_id)
    if not found:
        model, hypotheses = draft(eng_model, mechanism, body)
        if job_id is not None:
            model["source"]["job_id"] = str(job_id)
        note = f"Từ mô hình {model_id} v{eng_model['version']}"
        notes = model.pop("notes", None)
        if notes:
            note += "; " + "; ".join(notes)
        design_id, rev, folder = service.save_revision(model, None, note)
        write_json(folder / "hypotheses.json", hypotheses)
        service.validate_design(design_id, rev)
    else:
        design_id, rev, previous = found[0]
        if (previous.get("source") or {}).get("version") != eng_model["version"]:
            model, note = carry_over(previous, eng_model)
            _, new_rev, folder = service.save_revision(model, design_id, note, rev)
            hypotheses = read_json(service.design_dir(design_id, rev)[0] / "hypotheses.json") or []
            write_json(folder / "hypotheses.json", hypotheses)
            service.validate_design(design_id, new_rev)
    return status(model_id)


def status(model_id):
    """What the model's simulation is, read from what is stored: never from what a page last showed"""
    if not MODEL_RE.match(str(model_id)):
        raise MechError(400, "NO_MODEL", "Mã mô hình không hợp lệ.")
    try:
        eng_model = eng_store.load_model(model_id)
    except EngError:
        eng_model = None
    found = designs_of(model_id)
    out = {"model_id": model_id, "model_version": eng_model and eng_model["version"],
           "components": [{k: c.get(k) for k in ("id", "name", "source_label")} for c in eng_model["components"]] if eng_model else [],
           "design_id": None, "revision": None, "state": "NOT_CONFIGURED", "checked_at": now()}
    if not found:
        out["reason"] = "Chưa chuẩn bị mô phỏng cho mô hình này."
        return out
    design_id, rev, model = found[0]
    folder, _ = service.design_dir(design_id, rev)
    validation = read_json(folder / "validation.json")
    out.update(design_id=design_id, revision=rev, design_version=(model.get("source") or {}).get("version"),
               hypotheses=read_json(folder / "hypotheses.json") or [], validation=validation)
    runs = []
    for r in sorted(service.ROOT.joinpath(design_id).glob("r*/runs/*.json")):
        record = read_json(r) or {}
        runs.append({"sim_id": r.stem, "revision": record.get("revision"), "state": record.get("state"),
                     "current": record.get("revision") == rev, "started_at": record.get("started_at")})
    for r in runs:
        if r["state"] in ("queued", "running"):
            # The run's own status, as the sim worker keeps it
            try:
                r["state"] = service.run_status(r["sim_id"])["state"]
            except service.sim.SimError:
                r["state"] = "failed"
    out["runs"] = runs
    if eng_model and out["design_version"] != eng_model["version"]:
        out["state"] = "NEEDS_VALIDATION"
        out["reason"] = (f"Mô hình đã đổi (v{out['design_version']} → v{eng_model['version']}): cập nhật cấu hình "
                         "và kiểm tra lại trước khi mô phỏng. Kết quả cũ thuộc bản trước.")
        return out
    if validation is None:
        out["state"], out["reason"] = "NEEDS_VALIDATION", f"Bản r{rev} chưa được kiểm tra."
        return out
    if validation["status"] == "failed":
        errors = [d for d in validation["diagnostics"] if d["severity"] == "error"]
        out["state"] = "INVALID"
        out["reason"] = "; ".join([d["message"] for d in errors[:3]] + [m["message"] for m in validation["missing"][:3]])
        return out
    current = [r for r in runs if r["current"]]
    last = current[-1] if current else None
    if last and last["state"] in ("queued", "running"):
        out["state"] = "RUNNING"
    elif last and last["state"] == "completed":
        out["state"] = "COMPLETED"
    elif last and last["state"] in ("failed", "cancelled"):
        out["state"] = "FAILED"
    else:
        out["state"] = "READY"
    out["last_run"] = last
    return out


def viewer(design_id, revision=None):
    """What the 3D viewer needs to simulate a design revision live: the compiled mechanism (refused when the
    revision does not validate), which body each part moves with, and each part's own data"""
    folder, rev = service.design_dir(design_id, revision)
    validation = service.validate_design(design_id, rev)
    if validation["status"] == "failed":
        raise MechError(422, "NOT_VALID", "Mô hình chưa chạy được: sửa các lỗi hoặc cho thêm dữ liệu còn thiếu.",
                        {"diagnostics": [d for d in validation["diagnostics"] if d["severity"] == "error"],
                         "missing": validation["missing"]})
    norm, asm, analysis, _, _ = service.build(read_json(folder / "input.json"))
    files_rel = f"files/mech/{design_id}/r{rev}"
    mechanism, mapping = service.chrono_adapter.compile_model(asm, service.SIM_DIR / files_rel, f"sim/{files_rel}")
    model = norm["model"]
    parts = {}
    for row in validation["parts"]:
        placed = asm.placed[row["id"]]
        point = placed["props"][1] if placed["props"] else placed["pos"]
        parts[row["id"]] = {**row, "body": mapping["parts"][row["id"]], "point_mm": [float(v) for v in point],
                            "joints": [j["id"] for j in model["joints"] if row["id"] in (j["part_a"], j["part_b"])],
                            "expected": (analysis.get("velocities") or {}).get(mapping["parts"][row["id"]])}
    joints = [{"id": j["id"], "type": j["type"], "part_a": j["part_a"], "part_b": j["part_b"],
               "position": j.get("position"), "axis": j.get("axis"),
               "dof": {"fixed": 0, "revolute": 1, "prismatic": 1, "cylindrical": 2, "spherical": 3,
                       "planar": 3, "distance": 5}.get(j["type"]),
               "diagnostics": [d["code"] for d in validation["diagnostics"] if j["id"] in (d.get("joints") or [])]}
              for j in model["joints"]]
    return {"design_id": design_id, "revision": rev, "mechanism": mechanism, "mapping": mapping, "parts": parts,
            "joints": joints, "validation": {k: validation[k] for k in ("status", "dof", "diagnostics", "missing", "assumptions")},
            "origin": {"design_id": design_id, "revision": str(rev)}}
