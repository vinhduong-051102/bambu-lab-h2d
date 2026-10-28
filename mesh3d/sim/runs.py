"""
The simulation orchestrator in the mesh worker (worker.py's /sim routes). Keeps, under SIM_DIR:

- mechanisms/<id>/mechanism.json: a mechanism as the agent wrote it (schema.py), changed by add_joint/add_actuator
- runs/<sim id>/: one folder per run, never reused: mechanism.json and model.json (the input and its SI form),
  status.json, metadata.json, body_transforms.csv, joint_results.csv, contacts.csv (with collision), simulation.log,
  engine.json, summary.json, and blender/ once it is played back

Runs go one at a time through a queue; each is chrono_run.py in Chrono's Python (/opt/chrono), a subprocess in its
own process group, killed on cancel or after SIM_TIMEOUT_S, so a run that hangs or crashes never takes the worker
down. Playback is Blender in the background (playback.py) on its own thread, one at a time too.
"""

import csv
import json
import os
import queue
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import numpy as np

from sim import schema

HERE = Path(__file__).resolve().parent
SIM_DIR = Path(os.environ.get("SIM_DIR", "/sim"))
JOBS_DIR = Path(os.environ.get("JOBS_DIR", "/jobs"))
CHRONO_PYTHON = os.environ.get("CHRONO_PYTHON", "/opt/chrono/bin/python")
BLENDER = os.environ.get("BLENDER", "blender")
TIMEOUT_S = float(os.environ.get("SIM_TIMEOUT_S", "900"))
PLAYBACK_TIMEOUT_S = float(os.environ.get("SIM_PLAYBACK_TIMEOUT_S", "900"))
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{5,63}$")
MESH_SUFFIXES = (".stl", ".obj", ".ply", ".glb")
# Files a run's folder serves, and their types
FILES = {
    "mechanism.json": "application/json", "model.json": "application/json", "status.json": "application/json",
    "metadata.json": "application/json", "summary.json": "application/json", "engine.json": "application/json",
    "body_transforms.csv": "text/csv", "joint_results.csv": "text/csv", "contacts.csv": "text/csv",
    "simulation.log": "text/plain",
    "blender/playback.blend": "application/x-blender", "blender/playback.mp4": "video/mp4",
    "blender/preview.png": "image/png", "blender/check.json": "application/json", "blender/blender.log": "text/plain",
}

lock = threading.Lock()
pending = queue.Queue()
running = {}  # sim id → Popen (simulation or playback)
cancelled = set()


class SimError(Exception):
    """An answer for the caller: HTTP status, code, message, and details (validation errors)"""

    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def new_id(prefix):
    return f"{prefix}-{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"


def write_json(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def resolve_file(name):
    """A mesh named by the agent, inside the data the worker can read: "jobs/<job id>/<path>" (a model job's files,
    e.g. jobs/<id>/out/model.stl) or "sim/files/<path>"; nothing outside them"""
    name = name.replace("\\", "/").lstrip("/")
    roots = {"jobs": JOBS_DIR, "sim": SIM_DIR}
    head, _, rest = name.partition("/")
    if head not in roots or not rest:
        raise ValueError(f"Đường dẫn {name!r} phải bắt đầu bằng jobs/<job id>/… hoặc sim/files/….")
    root = roots[head].resolve()
    path = (root / rest).resolve()
    if root not in path.parents or (head == "sim" and not rest.startswith("files/")):
        raise ValueError(f"Đường dẫn {name!r} ra ngoài vùng dữ liệu cho phép.")
    if path.suffix.lower() not in MESH_SUFFIXES:
        raise ValueError(f"File mesh phải là {', '.join(MESH_SUFFIXES)}: {name!r}.")
    if not path.is_file():
        raise ValueError(f"Không có file {name!r}.")
    return str(path)


def normalise(mechanism):
    """schema.normalise with this worker's files; a shape it cannot read at all (a list where an object belongs…)
    is a MechanismError too"""
    try:
        return schema.normalise(mechanism, resolve_file)
    except schema.MechanismError:
        raise
    except (TypeError, KeyError, AttributeError, IndexError, ValueError) as err:
        raise schema.MechanismError([{"path": "$", "message": f"Không đọc được cấu trúc cơ cấu: {err}"}]) from err


def validate(mechanism):
    """{"valid", "errors", "warnings", "assumptions", "dof_estimate"}: never raises for a bad mechanism"""
    try:
        result = normalise(mechanism)
    except schema.MechanismError as err:
        return {"valid": False, "errors": err.errors, "warnings": err.warnings, "assumptions": []}
    return {"valid": True, "errors": [], "warnings": result["warnings"], "assumptions": result["assumptions"],
            "dof_estimate": result["model"]["dof_estimate"]}


# ---------- mechanisms ----------

def mechanism_dir(mechanism_id):
    if not ID_RE.match(mechanism_id or ""):
        raise SimError(400, "BAD_ID", "Mã cơ cấu không hợp lệ.")
    return SIM_DIR / "mechanisms" / mechanism_id


def load_mechanism(mechanism_id):
    data = read_json(mechanism_dir(mechanism_id) / "mechanism.json")
    if data is None:
        raise SimError(404, "MECHANISM_NOT_FOUND", f"Không có cơ cấu {mechanism_id}.")
    return data


def create_mechanism(mechanism, mechanism_id=None):
    """Stores a mechanism (a new one, or replaces `mechanism_id`), even an incomplete one: joints and motors can be
    added after. Returns its id and how it validates."""
    if not isinstance(mechanism, dict):
        raise SimError(400, "BAD_MECHANISM", "mechanism phải là object JSON (schema_version 1).")
    if mechanism_id:
        load_mechanism(mechanism_id)
    else:
        mechanism_id = new_id("m")
    folder = mechanism_dir(mechanism_id)
    folder.mkdir(parents=True, exist_ok=True)
    write_json(folder / "mechanism.json", mechanism)
    return {"mechanism_id": mechanism_id, "validation": validate(mechanism)}


def add_part(mechanism_id, key, part):
    """Adds a joint, actuator or force to a stored mechanism. Refused, and the mechanism left as it was, when the
    part itself has an error (a missing body, a bad axis…); other problems of the mechanism are reported."""
    if not isinstance(part, dict):
        raise SimError(400, "BAD_PART", "Phần thêm vào phải là object JSON.")
    with lock:
        mechanism = load_mechanism(mechanism_id)
        parts = mechanism.setdefault(key, [])
        if not isinstance(parts, list):
            raise SimError(422, "BAD_MECHANISM", f"{key} của cơ cấu không phải mảng.")
        if any(isinstance(p, dict) and p.get("id") == part.get("id") for p in parts):
            raise SimError(409, "DUPLICATE_ID", f"Đã có {key} với id {part.get('id')!r}.")
        parts.append(part)
        result = validate(mechanism)
        prefix = f"{key}[{len(parts) - 1}]"
        own = [e for e in result["errors"] if e["path"] == prefix or e["path"].startswith(prefix + ".")
               or e["path"].startswith(f"{key}[{part.get('id')}]")]
        if own:
            raise SimError(422, "INVALID_PART", "Không thêm được: " + "; ".join(e["message"] for e in own), own)
        write_json(mechanism_dir(mechanism_id) / "mechanism.json", mechanism)
    return {"mechanism_id": mechanism_id, "added": part.get("id"), "validation": result}


def list_mechanisms(limit=50):
    folder = SIM_DIR / "mechanisms"
    out = []
    for d in sorted(folder.glob("*/mechanism.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]:
        m = read_json(d) or {}
        out.append({"mechanism_id": d.parent.name, "name": m.get("name"),
                    "bodies": len(m.get("bodies") or []), "joints": len(m.get("joints") or []),
                    "actuators": len(m.get("actuators") or [])})
    return out


# ---------- runs ----------

def run_dir(sim_id):
    if not ID_RE.match(sim_id or ""):
        raise SimError(400, "BAD_ID", "Mã mô phỏng không hợp lệ.")
    folder = SIM_DIR / "runs" / sim_id
    if not (folder / "status.json").is_file():
        raise SimError(404, "SIM_NOT_FOUND", f"Không có mô phỏng {sim_id}.")
    return folder


def set_status(folder, **changes):
    with lock:
        status = read_json(folder / "status.json", {})
        status.update(changes, updated_at=now())
        write_json(folder / "status.json", status)
        return status


def prepare(model):
    """What chrono_run.py needs that its Python cannot work out: the convex hulls of colliding meshes"""
    for body in model["bodies"]:
        g = body.get("geometry") or {}
        if body.get("collision") and g.get("type") == "mesh":
            import trimesh

            mesh = trimesh.load(g["file"], force="mesh")
            mesh.apply_scale(g["unit_scale"])
            body["hull_points"] = np.asarray(mesh.convex_hull.vertices, float).tolist()
            model["assumptions"].append({"path": f"bodies[{body['id']}].collision",
                                         "message": "Va chạm của mesh dùng bao lồi (convex hull) của nó."})
    return model


def start_run(mechanism=None, mechanism_id=None, simulation=None):
    """Checks the mechanism and queues a run: its id, or SimError with every problem"""
    if mechanism is None:
        if not mechanism_id:
            raise SimError(400, "NO_MECHANISM", "Cần mechanism_id hoặc mechanism.")
        mechanism = load_mechanism(mechanism_id)
    if not isinstance(mechanism, dict):
        raise SimError(400, "BAD_MECHANISM", "mechanism phải là object JSON.")
    if simulation is not None:
        if not isinstance(simulation, dict):
            raise SimError(400, "BAD_SIMULATION", "simulation phải là object.")
        # Overrides for this run only (duration, time step…), on top of the mechanism's own
        mechanism = {**mechanism, "simulation": {**(mechanism.get("simulation") or {}), **simulation}}
    try:
        result = normalise(mechanism)
    except schema.MechanismError as err:
        raise SimError(422, "INVALID_MECHANISM", f"Cơ cấu chưa hợp lệ: {err}", err.errors) from err
    model = prepare(result["model"])

    sim_id = new_id("s")
    folder = SIM_DIR / "runs" / sim_id
    folder.mkdir(parents=True)
    write_json(folder / "mechanism.json", mechanism)
    write_json(folder / "model.json", model)
    write_json(folder / "status.json", {
        "sim_id": sim_id, "mechanism_id": mechanism_id, "name": model["name"], "state": "queued", "progress": 0.0,
        "created_at": now(), "warnings": result["warnings"], "assumptions": result["assumptions"]})
    pending.put(sim_id)
    return {"sim_id": sim_id, "state": "queued", "queue_position": pending.qsize() - 1,
            "warnings": result["warnings"], "assumptions": result["assumptions"]}


def kill(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)


def watch(proc, sim_id, timeout, on_line=None):
    """Waits for a child, reading its stdout; kills it on timeout. Returns (exit code, timed out)"""
    timed_out = threading.Event()

    def expire():
        timed_out.set()
        kill(proc)

    timer = threading.Timer(timeout, expire)
    timer.start()
    try:
        for line in proc.stdout:
            if on_line:
                on_line(line.strip())
        return proc.wait(), timed_out.is_set()
    finally:
        timer.cancel()
        proc.stdout.close()
        running.pop(sim_id, None)


def execute(sim_id):
    folder = SIM_DIR / "runs" / sim_id
    if sim_id in cancelled:
        set_status(folder, state="cancelled", finished_at=now())
        return
    started = time.monotonic()
    set_status(folder, state="running", started_at=now())
    proc = subprocess.Popen([CHRONO_PYTHON, str(HERE / "chrono_run.py"), str(folder)], cwd=folder,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    running[sim_id] = proc
    last = [0.0]

    def progress(line):
        if line.startswith("PROGRESS "):
            value = float(line.split()[1])
            if value - last[0] >= 0.02 or value >= 1:
                last[0] = value
                set_status(folder, progress=round(value, 3))
        elif line:
            with open(folder / "simulation.log", "a", encoding="utf-8") as log:
                log.write(f"[chrono stdout] {line}\n")

    code, timed_out = watch(proc, sim_id, TIMEOUT_S, progress)
    engine = read_json(folder / "engine.json", {})
    if sim_id in cancelled:
        state, error = "cancelled", "Đã hủy."
    elif timed_out:
        state, error = "failed", f"Quá thời gian ({TIMEOUT_S:.0f} s): đã dừng mô phỏng."
    elif code != 0 or engine.get("state") != "completed":
        state, error = "failed", engine.get("error") or f"Chrono dừng với mã {code}, xem simulation.log."
    else:
        state, error = "completed", None
    try:
        summary = summarise(folder, engine, state, error) if state == "completed" else None
    except Exception as err:  # noqa: BLE001 - a broken result file fails the run, not the worker
        state, error, summary = "failed", f"Không đọc được kết quả: {err}", None
    checks_failed = [c["id"] for c in (summary or {}).get("checks", []) if c.get("passed") is False]
    metadata(folder, engine, state, error, time.monotonic() - started)
    set_status(folder, state=state, error=error, progress=1.0 if state == "completed" else None,
               finished_at=now(), checks_failed=checks_failed)


def metadata(folder, engine, state, error, wall):
    model = read_json(folder / "model.json", {})
    write_json(folder / "metadata.json", {
        "sim_id": folder.name, "name": model.get("name"), "state": state, "error": error,
        "engine": engine.get("engine", "Project Chrono (PyChrono)"), "engine_version": engine.get("engine_version"),
        "python": CHRONO_PYTHON, "schema_version": model.get("schema_version"),
        "units_in_mechanism": model.get("units_in"),
        "units_in_files": {"length": "m", "mass": "kg", "time": "s", "angle": "rad", "force": "N", "torque": "N·m",
                           "quaternion": "w, x, y, z", "frame": "world, Z up (Blender's axes)"},
        "simulation": model.get("simulation"), "assumptions": model.get("assumptions"),
        "warnings": model.get("warnings"), "assembly": engine.get("assembly"),
        "assembly_violation": engine.get("assembly_violation"), "steps": engine.get("steps"),
        "samples": engine.get("samples"), "engine_wall_time_s": engine.get("wall_time_s"), "wall_time_s": wall,
        "result_kind": result_kind(model, "en"), "written_at": now()})


def result_kind(model, language):
    """What the numbers are: simulated, with ideal joints, and the gears and contacts as modelled"""
    gears = [j for j in model.get("joints", []) if j.get("type") == "gear"]
    contact = any(j.get("model") == "contact" for j in gears)
    ideal = any(j.get("model", "ideal") == "ideal" for j in gears)
    collision = (model.get("simulation") or {}).get("collision") or {}
    if language == "en":
        parts = ["simulated (Project Chrono multibody), not measured; ideal joints"]
        if ideal:
            parts.append("ideal gear constraints")
        if contact:
            parts.append("gear teeth in contact along the line of action (backlash, mesh stiffness, friction)")
        if collision.get("enabled"):
            parts.append(f"{collision.get('method', 'nsc').upper()} contacts")
        return "; ".join(parts)
    parts = ["Kết quả mô phỏng (Chrono), không phải số đo thực tế; khớp lý tưởng"]
    if ideal:
        parts.append("bánh răng lý tưởng")
    if contact:
        parts.append("răng tiếp xúc theo đường ăn khớp (khe hở, độ cứng răng, ma sát)")
    if collision.get("enabled"):
        parts.append(f"va chạm {collision.get('method', 'nsc').upper()}")
    return "; ".join(parts)


def summarise(folder, engine, state, error):
    """summary.json: per body how far and how fast it moved, per joint its coordinate range and the largest
    reactions, and the checks (finite values, constraint violation, theory)"""
    model = read_json(folder / "model.json", {})
    bodies, joints = {}, {}
    with open(folder / "body_transforms.csv", newline="") as f:
        for row in csv.DictReader(f):
            b = bodies.setdefault(row["body"], {"p": [], "v": [], "w": [], "t": []})
            b["t"].append(float(row["t"]))
            b["p"].append([float(row[k]) for k in ("x", "y", "z")])
            b["v"].append([float(row[k]) for k in ("vx", "vy", "vz")])
            b["w"].append([float(row[k]) for k in ("wx", "wy", "wz")])
    with open(folder / "joint_results.csv", newline="") as f:
        for row in csv.DictReader(f):
            j = joints.setdefault(row["item"], {"kind": row["kind"], "value": [], "rate": [], "effort": [],
                                                "f": [], "tq": []})
            for key in ("value", "rate", "effort"):
                if row[key] != "":
                    j[key].append(float(row[key]))
            j["f"].append(np.linalg.norm([float(row[k]) for k in ("fx", "fy", "fz")]))
            j["tq"].append(np.linalg.norm([float(row[k]) for k in ("tx", "ty", "tz")]))

    def span(values):
        return None if not values else {"min": float(np.min(values)), "max": float(np.max(values)),
                                        "final": float(values[-1])}

    body_out = {}
    for bid, b in bodies.items():
        p = np.array(b["p"])
        body_out[bid] = {"travel_m": float(np.max(np.linalg.norm(p - p[0], axis=1))),
                         "final_position_m": p[-1].tolist(),
                         "max_speed_m_s": float(np.max(np.linalg.norm(b["v"], axis=1))),
                         "max_angular_speed_rad_s": float(np.max(np.linalg.norm(b["w"], axis=1)))}
    joint_out = {}
    for jid, j in joints.items():
        joint_out[jid] = {"kind": j["kind"], "value": span(j["value"]), "rate": span(j["rate"]),
                          "effort": span(j["effort"]), "max_reaction_force_N": float(np.max(j["f"])),
                          "max_reaction_torque_Nm": float(np.max(j["tq"]))}
    checks = [{"id": "finite", "kind": "finite", "passed": True,
               "description": "Mọi giá trị ghi ra đều hữu hạn (chrono_run.py dừng ngay khi gặp NaN/vô cùng)"}]
    checks += engine.get("checks", [])
    summary = {"sim_id": folder.name, "name": model.get("name"), "state": state, "error": error,
               "duration_s": model.get("simulation", {}).get("duration"), "samples": engine.get("samples"),
               "engine": f"{engine.get('engine')} {engine.get('engine_version')}",
               "result_kind": result_kind(model, "vi"),
               "bodies": body_out, "joints": joint_out, "checks": checks,
               "checks_passed": all(c.get("passed") is not False for c in checks),
               "assumptions": model.get("assumptions", []), "warnings": model.get("warnings", [])}
    write_json(folder / "summary.json", summary)
    return summary


def status(sim_id):
    folder = run_dir(sim_id)
    out = read_json(folder / "status.json", {})
    play = read_json(folder / "blender" / "status.json")
    if play:
        out["playback"] = play
    return out


def results(sim_id):
    folder = run_dir(sim_id)
    current = status(sim_id)
    if current.get("state") != "completed":
        raise SimError(409, "SIM_NOT_COMPLETED", f"Mô phỏng đang ở trạng thái {current.get('state')}"
                       + (f": {current.get('error')}" if current.get("error") else "."), current)
    files = {name: f"files/{name}" for name in FILES if (folder / name).is_file()}
    return {"sim_id": sim_id, "state": "completed", "summary": read_json(folder / "summary.json"),
            "metadata": read_json(folder / "metadata.json"), "playback": current.get("playback"), "files": files}


def list_runs(limit=30):
    out = []
    for path in sorted((SIM_DIR / "runs").glob("*/status.json"), key=lambda p: p.parent.name, reverse=True)[:limit]:
        s = read_json(path, {})
        out.append({k: s.get(k) for k in ("sim_id", "name", "state", "progress", "created_at", "checks_failed")})
    return out


def cancel(sim_id):
    folder = run_dir(sim_id)
    state = read_json(folder / "status.json", {}).get("state")
    if state not in ("queued", "running"):
        play = running.get(f"{sim_id}:play")
        if play:
            kill(play)
            return True
        return False
    cancelled.add(sim_id)
    proc = running.get(sim_id)
    if proc:
        kill(proc)
    return True


def file_path(sim_id, name):
    folder = run_dir(sim_id)
    if name not in FILES and not re.fullmatch(r"blender/frames/\d{4}\.png", name):
        raise SimError(404, "FILE_NOT_FOUND", f"Không có file {name}.")
    path = folder / name
    if not path.is_file():
        raise SimError(404, "FILE_NOT_FOUND", f"Chưa có {name}.")
    return path, FILES.get(name, "image/png")


# ---------- playback in Blender ----------

def start_playback(sim_id, options):
    """Blender (playback.py) builds the scene from the run and renders it, in the background"""
    folder = run_dir(sim_id)
    if read_json(folder / "status.json", {}).get("state") != "completed":
        raise SimError(409, "SIM_NOT_COMPLETED", "Chỉ phát lại được mô phỏng đã chạy xong.")
    if f"{sim_id}:play" in running:
        raise SimError(409, "PLAYBACK_RUNNING", "Blender đang dựng lần phát lại này.")
    options = options if isinstance(options, dict) else {}
    clean = {"render": bool(options.get("render", True)),
             "fps": int(min(max(int(options.get("fps") or 30), 10), 60)),
             "width": int(min(max(int(options.get("width") or 960), 320), 1920)),
             "height": int(min(max(int(options.get("height") or 540), 240), 1080)),
             "speed": float(min(max(float(options.get("speed") or 1.0), 0.05), 20.0))}
    out = folder / "blender"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir()
    write_json(out / "options.json", clean)
    write_json(out / "status.json", {"state": "queued", "options": clean, "created_at": now()})
    threading.Thread(target=playback, args=(sim_id, folder), daemon=True).start()
    return {"sim_id": sim_id, "playback": "queued", "options": clean}


playing = threading.Semaphore(1)


def playback(sim_id, folder):
    out = folder / "blender"
    key = f"{sim_id}:play"
    with playing:
        write_json(out / "status.json", {**read_json(out / "status.json", {}), "state": "running", "started_at": now()})
        env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_CODE_OAUTH_TOKEN")}
        with open(out / "blender.log", "w", encoding="utf-8") as log:
            # A virtual display: Workbench renders through OpenGL (Mesa)
            proc = subprocess.Popen(
                ["xvfb-run", "-a", "-s", "-screen 0 1280x800x24", BLENDER, "-b", "--factory-startup",
                 "--python", str(HERE / "playback.py"), "--", str(folder)],
                cwd=out, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                start_new_session=True)
            running[key] = proc
            code, timed_out = watch(proc, key, PLAYBACK_TIMEOUT_S, lambda line: log.write(line + "\n"))
        check = read_json(out / "check.json")
        state = "completed" if code == 0 and check else "failed"
        if state == "completed" and (out / "frames").is_dir():
            try:
                preview_sheet(out)
            except Exception as err:  # noqa: BLE001 - the video and .blend are still there
                check["preview_error"] = str(err)[:200]
        error = None
        if timed_out:
            error = f"Blender quá thời gian ({PLAYBACK_TIMEOUT_S:.0f} s)."
        elif state == "failed":
            error = f"Blender dừng với mã {code}, xem blender/blender.log."
        files = {name: f"files/{name}" for name in FILES if name.startswith("blender/") and (folder / name).is_file()}
        write_json(out / "status.json", {**read_json(out / "status.json", {}), "state": state, "error": error,
                                         "finished_at": now(), "check": check, "files": files})


def preview_sheet(out):
    """blender/preview.png: the rendered stills side by side (3 × 2), the time of each in its corner"""
    from PIL import Image, ImageDraw

    stills = sorted((out / "frames").glob("*.png"))[:6]
    if not stills:
        return
    images = [Image.open(p).convert("RGB") for p in stills]
    w, h = images[0].size
    scale = min(1.0, 640 / w)
    w, h = int(w * scale), int(h * scale)
    cols = 3 if len(images) > 2 else len(images)
    rows = (len(images) + cols - 1) // cols
    sheet = Image.new("RGB", (w * cols, h * rows), (20, 22, 26))
    options = read_json(out / "options.json", {})
    for i, (path, image) in enumerate(zip(stills, images)):
        x, y = (i % cols) * w, (i // cols) * h
        sheet.paste(image.resize((w, h)), (x, y))
        seconds = (int(path.stem) - 1) * options.get("speed", 1.0) / options.get("fps", 30)
        ImageDraw.Draw(sheet).text((x + 8, y + 6), f"t = {seconds:.2f} s", fill=(255, 255, 255))
    sheet.save(out / "preview.png")


# ---------- the queue ----------

def worker_loop():
    while True:
        sim_id = pending.get()
        try:
            execute(sim_id)
        except Exception as err:  # noqa: BLE001 - one broken run must not stop the queue
            import traceback

            traceback.print_exc()
            try:
                set_status(SIM_DIR / "runs" / sim_id, state="failed", error=str(err)[:500], finished_at=now())
            except OSError:
                pass


def start():
    """Creates the folders, marks runs a restart interrupted, and starts the queue"""
    for sub in ("mechanisms", "runs", "files"):
        (SIM_DIR / sub).mkdir(parents=True, exist_ok=True)
    for path in (SIM_DIR / "runs").glob("*/status.json"):
        s = read_json(path, {})
        if s.get("state") in ("queued", "running"):
            s.update(state="failed", error="Worker khởi động lại khi đang chạy.", updated_at=now())
            write_json(path, s)
    threading.Thread(target=worker_loop, daemon=True).start()


def ready():
    return Path(CHRONO_PYTHON).is_file()


if __name__ == "__main__":
    # Checks a mechanism file: python -m sim.runs mechanism.json
    print(json.dumps(validate(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))), ensure_ascii=False,
                     indent=2))
