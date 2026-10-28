"""
The /eng routes of the mesh worker (worker.py), one function per MCP tool. Every analysis is kept as
analyses/<id>/result.json (the AnalysisResult of schema.py) with its inputs, engine versions, units, assumptions,
warnings, status and files; the slow ones (FEA) run in the background and are polled.
"""

import base64
import re
import time

from . import assembly, clearance, fea, geometry, motion, printability, report, schema, visualize
from .store import (EngError, analysis_dir, list_analyses, list_models, load_analysis, load_model, new_analysis,
                    now, resolve_input, save_upload, write_json)

FILE_TYPES = {".json": "application/json", ".md": "text/markdown; charset=utf-8", ".html": "text/html; charset=utf-8",
              ".png": "image/png", ".log": "text/plain; charset=utf-8", ".blend": "application/x-blender",
              ".inp": "text/plain; charset=utf-8", ".frd": "text/plain; charset=utf-8", ".npz": "application/octet-stream",
              ".ply": "application/octet-stream", ".stl": "model/stl", ".mp4": "video/mp4"}
MAX_UPLOAD = 200 * 1024 * 1024


def begin():
    """When an analysis started: (ISO time, monotonic clock)"""
    return now(), time.monotonic()


def finish(result, stamp):
    """Keeps a finished synchronous analysis as analyses/<id>/result.json"""
    analysis_id, folder = new_analysis(result["kind"])
    result.update(analysis_id=analysis_id, state="completed", started_at=stamp[0], finished_at=now(),
                  duration_s=round(time.monotonic() - stamp[1], 3))
    write_json(folder / "result.json", result)
    return result


def model_of(body):
    if not isinstance(body.get("model_id"), str):
        raise EngError(400, "NO_MODEL", "Cần model_id (từ inspect_3d_model).")
    return load_model(body["model_id"], body.get("version"))


def print_config(body):
    p, errors = schema.read_print_config(body.get("print"))
    if errors:
        raise EngError(422, "INVALID_PRINT", "Cấu hình in chưa hợp lệ.", errors)
    return p


def public(model):
    return {k: v for k, v in model.items() if not k.startswith("_")}


# ---------- tools ----------

def inspect_model(body):
    """inspect_3d_model: import files (or an existing model) and describe them"""
    stamp = begin()
    if body.get("sources"):
        sources = []
        for i, src in enumerate(body["sources"]):
            if not isinstance(src, dict):
                raise EngError(400, "BAD_SOURCE", f"sources[{i}] phải là object.")
            if src.get("data_base64"):
                data = base64.b64decode(src["data_base64"], validate=True)
                if len(data) > MAX_UPLOAD:
                    raise EngError(413, "TOO_LARGE", "File quá 200 MB.")
                name = save_upload(src.get("filename"), data)
                sources.append({"path": resolve_input(name), "label": src.get("filename")})
            else:
                sources.append({"path": resolve_input(src.get("file")), "label": src.get("file")})
        model = geometry.import_model(sources, body.get("name"), body.get("units"), body.get("model_id"),
                                      bool(body.get("split_bodies")))
    else:
        model = model_of(body)
    result = geometry.inspect(model)
    return {"model": public(model), "result": finish(result, stamp)}


def validate_mesh(body):
    stamp = begin()
    model = model_of(body)
    intents = body.get("intents") or {}
    if not isinstance(intents, dict) or any(v not in ("solid", "surface") for v in intents.values()):
        raise EngError(422, "BAD_INTENTS", 'intents: {chi tiết: "solid" | "surface"}.')
    return {"result": finish(geometry.validate(model, intents, print_config(body)), stamp)}


def analyze_assembly(body):
    stamp = begin()
    model = model_of(body)
    return {"result": finish(assembly.analyze(model, body.get("joints"), float(body.get("touch_mm", 0.05))), stamp)}


def check_clearance(body):
    stamp = begin()
    model = model_of(body)
    if body.get("sim_id"):
        from sim import runs as sim

        bodies = body.get("bodies") or {}
        folder = sim.run_dir(body["sim_id"])
        if not bodies:
            from .store import read_json

            bodies = {b["id"]: b["id"] for b in read_json(folder / "model.json", {}).get("bodies", [])
                      if b["id"] in {c["id"] for c in model["components"]}}
        result = clearance.motion_clearance(model, folder, bodies, int(body.get("frames", 60)), body.get("pairs"))
    else:
        result = clearance.analyze(model, print_config(body), body.get("fits"), body.get("gears"), body.get("pairs"),
                                   body.get("thickness", True) is not False)
    return {"result": finish(result, stamp)}


def configure_motion(body):
    model = model_of(body)
    return motion.configure(model, body.get("components"), body.get("joints"), body.get("actuators"),
                            body.get("forces"), body.get("simulation"), body.get("assumed_density_kg_m3"),
                            body.get("name"))


def run_motion(body):
    stamp = begin()
    model = model_of(body)
    if body.get("sim_id"):
        result = schema.new_result("motion", model, {"sim_id": body["sim_id"]})
        result["warnings"].append({"path": "model", "message": motion.RIGID_NOTE})
        result = motion.collect(model, result, body["sim_id"], body.get("check_clearance", True) is not False,
                                int(body.get("frames", 60)))
    else:
        if not body.get("mechanism_id"):
            raise EngError(400, "NO_MECHANISM", "Cần mechanism_id (configure_motion_simulation) hoặc sim_id.")
        result = motion.run(model, body["mechanism_id"], body.get("simulation"),
                            float(min(max(body.get("wait_s", 120), 0), 600)),
                            body.get("check_clearance", True) is not False, int(body.get("frames", 60)))
    if result.get("state") in ("queued", "running"):
        return {"result": result}
    return {"result": finish(result, stamp)}


def configure_fea(body):
    return fea.configure(model_of(body), body.get("config"))


def run_fea(body):
    model = model_of(body)
    if not body.get("config_id"):
        raise EngError(400, "NO_CONFIG", "Cần config_id (configure_fea_analysis).")
    return fea.run(model, body["config_id"])


def analyze_printability(body):
    stamp = begin()
    model = model_of(body)
    fea_result = load_analysis(body["fea_analysis_id"]) if body.get("fea_analysis_id") else None
    return {"result": finish(printability.analyze(model, print_config(body), fea_result, body.get("intents")), stamp)}


def generate_report(body):
    model = model_of(body)
    result, text = report.build(model, body.get("analysis_ids"))
    return {"result": result, "markdown": text}


JOB_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{5,63}$")
SUMMARY_KEYS = ("analysis_id", "kind", "status", "checks", "assumptions", "missing", "warnings", "files", "data",
                "inputs")


def job_model_id(job_id):
    """The engineering model of a design job: one model per job, a new version per check"""
    return f"job-{job_id}"


def check_job(body):
    """The dashboard's "Kiểm tra kỹ thuật" on one finished design job: its model.stl imported as a new version of the
    job's model, then the checks that need no loads or joints (mesh, walls, printability) for the print setup given,
    the wall thickness in Blender, and the report. FEA and motion need the user's loads and joints: through MCP."""
    job_id = str(body.get("job_id") or "")
    if not JOB_ID_RE.match(job_id):
        raise EngError(400, "BAD_JOB", "Mã job không hợp lệ.")
    source = resolve_input(f"jobs/{job_id}/out/model.stl")
    pc = print_config(body)
    # split_bodies: each separate body of the STL its own part, so fits between them are checked too
    model = geometry.import_model([{"path": str(source), "label": "model.stl"}], body.get("name") or job_id,
                                  model_id=job_model_id(job_id), split_bodies=bool(body.get("split_bodies")))
    results = {}
    for kind, run in (("inspect", lambda: geometry.inspect(model)),
                      ("validate", lambda: geometry.validate(model, None, pc)),
                      ("clearance", lambda: clearance.analyze(model, pc, pairs=[])),
                      ("printability", lambda: printability.analyze(model, pc))):
        stamp = begin()
        results[kind] = finish(run(), stamp)
    if body.get("render", True) is not False:
        results["visualize"] = visualize.visualize(model, "thickness", print_config=pc)
    report_result, _ = report.build(model)
    return {"model": public(model), "report": report_result,
            "results": {k: {key: r.get(key) for key in SUMMARY_KEYS} for k, r in results.items()}}


def last_job_check(job_id):
    """The latest report of a job's checks, or None"""
    if not JOB_ID_RE.match(str(job_id or "")):
        raise EngError(400, "BAD_JOB", "Mã job không hợp lệ.")
    reports = list_analyses(job_model_id(job_id), "report", limit=1)
    if not reports:
        return {"report": None, "results": {}}
    rep = load_analysis(reports[0]["analysis_id"])
    results = {}
    for kind, ids in (rep.get("data") or {}).get("analyses", {}).items():
        r = load_analysis(ids[0]) if ids else None
        if r:
            results[kind] = {key: r.get(key) for key in SUMMARY_KEYS}
    return {"report": rep, "results": results}


def visualize_results(body):
    model = model_of(body)
    return {"result": visualize.visualize(model, body.get("mode"), body.get("analysis_id"), body.get("sim_id"),
                                          print_config(body), body.get("deformation_scale"))}


def get_analysis(analysis_id):
    return {"result": load_analysis(analysis_id)}


def analysis_file(analysis_id, name):
    folder = analysis_dir(analysis_id).resolve()
    path = (folder / name).resolve()
    if folder not in path.parents or not path.is_file():
        raise EngError(404, "FILE_NOT_FOUND", f"Không có file {name}.")
    return path, FILE_TYPES.get(path.suffix.lower(), "application/octet-stream")


def get_model(model_id, version=None):
    model = load_model(model_id, version)
    return {"model": public(model)}


def models():
    return {"models": list_models()}


def analyses(model_id=None, kind=None):
    return {"analyses": list_analyses(model_id, kind)}


def health():
    return {"fea": fea.ready()}


def start():
    fea.start()

