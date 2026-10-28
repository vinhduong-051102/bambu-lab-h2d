"""
Mesh worker (docs/cad.md, "Nhân vật"): organic models (characters, figures, decorations), Claude's fixes of them,
and the parts of a model for Studio's "AI tối ưu". Runs in the mesh3d container next to the gateway, which calls
it over HTTP. Jobs share CAD_JOBS_DIR with the CAD worker: the gateway writes job.json and, for a picture the user
uploaded, input.png (and views/left.png, back.png, right.png when the user has the other sides too).

- From a picture: Hunyuan3D-2 shapes it on the GPU (shape.py, one job at a time; "Dựng nhiều góc" from four
  sides), then Claude fixes and paints it with the Blender tools in the same job (review.py).
- From a description alone: Claude models it in Blender from nothing (review.py).

They write concept.png, sides.png, source/ (the shape as Hunyuan3D made it), request.md, work/, fix.py, out/
(model.stl, model.3mf, preview.png, views.png, report.json) and status.json.

  GET  /health                 {"ok": true, "claude": <token set>, "running": [queued and running job ids],
                                "loaded": <a shape model in GPU memory>}
  POST /jobs/<id>/generate     {"prompt", "height_mm", "base", "colour", "model", "seed", "multiview"}: with a
                               picture queued for the GPU, without one Claude starts at once
  POST /jobs/<id>/fix          {"parent_id", "model"}: Claude reviews and fixes that figure in this job
  POST /jobs/<id>/cancel       Drops a queued job, or stops a running one
  POST /analyze                {file, key, target}: the parts of a model in Studio's import folder (analyze.py)
  POST /generate               {"image": base64} or {"text"}: one object from Hunyuan3D-2 as GLB bytes, for MCP for
                               Blender's generate_3d (its local Hunyuan3D API) in the jobs' Blender

Mechanism simulation (sim/, docs/mechanical-simulation.md): Project Chrono in its own Python, played back in Blender
  POST /sim/mechanisms                  {"mechanism", "mechanism_id"?}: stores (or replaces) a mechanism → its id and
                                        validation
  GET  /sim/mechanisms[/<id>]           The stored mechanisms, or one with its validation
  POST /sim/mechanisms/<id>/joints      {"joint"} · /actuators {"actuator"} · /forces {"force"}: adds one part
  POST /sim/validate                    {"mechanism"} or {"mechanism_id"}: errors, warnings, assumptions
  POST /sim/runs                        {"mechanism_id"} or {"mechanism"}, "simulation"?: queues a run → its sim_id
  GET  /sim/runs[/<id>]                 The runs, or one run's state and progress
  GET  /sim/runs/<id>/results           summary.json, metadata.json and the files
  POST /sim/runs/<id>/cancel · /play    Stops a run (or its playback) · Blender playback {"render", "fps", "speed",
                                        "width", "height"}
  GET  /sim/runs/<id>/files/<name>      A result file (CSV, JSON, log, .blend, MP4, PNG)
  GET  /sim/guide                       The mechanism format and rules, for the agent (sim/guide.md)

Engineering analysis of printed parts (eng/, docs/engineering-analysis.md): one POST per MCP tool, JSON in and out
  POST /eng/inspect · /validate · /assembly · /clearance · /motion/configure · /motion/run · /fea/configure ·
       /fea/run · /printability · /report · /visualize
  GET  /eng/models[/<id>] · /eng/analyses[?model_id=&kind=] · /eng/analyses/<id> · /eng/analyses/<id>/files/<path>
"""

import json
import os
import re
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

JOBS_DIR = Path(os.environ.get("JOBS_DIR", "/jobs"))
PORT = int(os.environ.get("PORT", "8000"))
JOB_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{5,63}$")
# "Thành phần của mẫu" (analyze.py): models from Studio's import folder, renders into the gateway's analyses folder
IMPORTS_DIR = Path(os.environ.get("IMPORTS_DIR", "/imports"))
ANALYSES_DIR = Path(os.environ.get("ANALYSES_DIR", "/analyses"))
ANALYSIS_KEY_RE = re.compile(r"^[a-f0-9]{16,64}$")
# Measuring is CPU work: two at a time at most
analysing = threading.Semaphore(2)

# The CAD worker's preview renderer, so both kinds of models look the same on the dashboard
sys.path.insert(0, os.environ.get("CAD_DIR", "/opt/cad"))

import analyze  # noqa: E402 - the parts of a model, for Studio's "AI tối ưu"
import review  # noqa: E402 - Claude making and fixing figures
import shape  # noqa: E402 - Hunyuan3D-2 shaping figures from pictures
from sim import runs as sim  # noqa: E402 - mechanism simulation with Project Chrono
from eng import service as eng  # noqa: E402 - engineering analysis of printed parts
from eng.schema import InputError  # noqa: E402
from eng.store import EngError  # noqa: E402

ENG_POST = {"inspect": eng.inspect_model, "validate": eng.validate_mesh, "assembly": eng.analyze_assembly,
            "clearance": eng.check_clearance, "motion/configure": eng.configure_motion, "motion/run": eng.run_motion,
            "fea/configure": eng.configure_fea, "fea/run": eng.run_fea, "printability": eng.analyze_printability,
            "report": eng.generate_report, "visualize": eng.visualize_results}


def claude_ready():
    return bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"))


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[mesh-worker] {self.address_string()} {fmt % args}\n")

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(length)) if length else {}
        except ValueError:
            return {}

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True, "claude": claude_ready(), "running": shape.ids() + review.ids(),
                                    "loaded": shape.loaded(), "chrono": sim.ready(), "fea": eng.health()["fea"]})
        if self.path.startswith("/sim/"):
            return self.simulation("GET")
        if self.path.startswith("/eng/"):
            return self.engineering("GET")
        self.reply(404, {"ok": False, "error": "NOT_FOUND"})

    def engineering(self, method):
        """The /eng routes: EngError and InputError answer with their status, other errors are the worker's (500)"""
        from urllib.parse import parse_qs, urlsplit

        url = urlsplit(self.path)
        route, query = url.path[len("/eng/"):].strip("/"), {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if method == "POST":
                handler = ENG_POST.get(route)
                if handler is None:
                    raise EngError(404, "NOT_FOUND", f"Không có POST /eng/{route}.")
                return self.reply(200, {"ok": True, **handler(self.body())})
            parts = route.split("/")
            if parts == ["models"]:
                return self.reply(200, {"ok": True, **eng.models()})
            if len(parts) == 2 and parts[0] == "models":
                return self.reply(200, {"ok": True, **eng.get_model(parts[1], query.get("version"))})
            if parts == ["analyses"]:
                return self.reply(200, {"ok": True, **eng.analyses(query.get("model_id"), query.get("kind"))})
            if len(parts) == 2 and parts[0] == "analyses":
                return self.reply(200, {"ok": True, **eng.get_analysis(parts[1])})
            if len(parts) >= 4 and parts[0] == "analyses" and parts[2] == "files":
                return self.send_file(*eng.analysis_file(parts[1], "/".join(parts[3:])))
            raise EngError(404, "NOT_FOUND", f"Không có GET /eng/{route}.")
        except EngError as err:
            return self.reply(err.status, {"ok": False, "error": err.code, "message": err.message,
                                           **({"details": err.details} if err.details is not None else {})})
        except InputError as err:
            return self.reply(422, {"ok": False, "error": "INVALID_INPUT", "message": str(err), "details": err.errors})
        except Exception as err:  # noqa: BLE001 - the worker keeps serving; no result is made up
            traceback.print_exc()
            return self.reply(500, {"ok": False, "error": "ENG_ERROR", "message": f"{type(err).__name__}: {str(err)[:500]}"})

    def simulation(self, method):
        """The /sim routes: SimError answers with its status, other errors are the worker's (500)"""
        path = self.path.split("?", 1)[0]
        try:
            if method == "GET" and path == "/sim/guide":
                return self.send_file(Path(__file__).resolve().parent / "sim" / "guide.md", "text/markdown; charset=utf-8")
            if method == "GET":
                match = re.fullmatch(r"/sim/runs/([^/]+)/files/(.+)", path)
                if match:
                    return self.send_file(*sim.file_path(*match.groups()))
            status, body = self.sim_route(method, path)
        except sim.SimError as err:
            return self.reply(err.status, {"ok": False, "error": err.code, "message": err.message,
                                           **({"details": err.details} if err.details is not None else {})})
        except Exception as err:  # noqa: BLE001 - the worker keeps serving
            traceback.print_exc()
            return self.reply(500, {"ok": False, "error": "SIM_ERROR", "message": str(err)[:500]})
        self.reply(status, {"ok": True, **body})

    def sim_route(self, method, path):
        parts = path.strip("/").split("/")[1:]
        body = self.body() if method == "POST" else {}
        if method == "GET":
            if parts == ["mechanisms"]:
                return 200, {"mechanisms": sim.list_mechanisms()}
            if len(parts) == 2 and parts[0] == "mechanisms":
                mechanism = sim.load_mechanism(parts[1])
                return 200, {"mechanism_id": parts[1], "mechanism": mechanism, "validation": sim.validate(mechanism)}
            if parts == ["runs"]:
                return 200, {"runs": sim.list_runs()}
            if len(parts) == 2 and parts[0] == "runs":
                return 200, {"status": sim.status(parts[1])}
            if len(parts) == 3 and parts[0] == "runs" and parts[2] == "results":
                return 200, sim.results(parts[1])
        else:
            if parts == ["mechanisms"]:
                return 201, sim.create_mechanism(body.get("mechanism"), body.get("mechanism_id"))
            if len(parts) == 3 and parts[0] == "mechanisms" and parts[2] in ("joints", "actuators", "forces"):
                key = {"joints": "joint", "actuators": "actuator", "forces": "force"}[parts[2]]
                return 201, sim.add_part(parts[1], parts[2], body.get(key))
            if parts == ["validate"]:
                mechanism = body.get("mechanism")
                if mechanism is None:
                    mechanism = sim.load_mechanism(str(body.get("mechanism_id") or ""))
                return 200, {"validation": sim.validate(mechanism)}
            if parts == ["runs"]:
                return 202, sim.start_run(body.get("mechanism"), body.get("mechanism_id"), body.get("simulation"))
            if len(parts) == 3 and parts[0] == "runs" and parts[2] == "cancel":
                if not sim.cancel(parts[1]):
                    raise sim.SimError(409, "SIM_NOT_RUNNING", "Mô phỏng không còn chạy.")
                return 200, {}
            if len(parts) == 3 and parts[0] == "runs" and parts[2] == "play":
                return 202, sim.start_playback(parts[1], body)
        raise sim.SimError(404, "NOT_FOUND", f"Không có {method} {path}.")

    def send_file(self, path, content_type):
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def analyse(self):
        """POST /analyze {file, key, target}: the parts of /imports/<file> placed as Studio's `target` describes it"""
        body = self.body()
        name = str(body.get("file") or "")
        key = str(body.get("key") or "")
        if not ANALYSIS_KEY_RE.match(key) or not name or Path(name).name != name or name.startswith("."):
            return self.reply(400, {"ok": False, "error": "BAD_REQUEST", "message": "Tên file hoặc khóa không hợp lệ."})
        path = IMPORTS_DIR / name
        if not path.is_file():
            return self.reply(404, {"ok": False, "error": "FILE_NOT_FOUND", "message": f"Không có /imports/{name}."})
        with analysing:
            try:
                result = analyze.analyse(path, body.get("target"), ANALYSES_DIR / key)
            except Exception as err:  # noqa: BLE001 - a broken mesh is the caller's answer, not a crash
                traceback.print_exc()
                return self.reply(422, {"ok": False, "error": "ANALYSIS_FAILED", "message": str(err)[:500]})
        self.reply(200, {"ok": True, **result})

    def generate(self):
        body = self.body()
        if not body.get("image") and not str(body.get("text") or "").strip():
            return self.reply(400, {"ok": False, "error": "NO_INPUT", "message": "Prompt or image is required"})
        try:
            glb = shape.generate(body)
        except Exception as err:  # noqa: BLE001 - the add-on shows the message to Claude
            traceback.print_exc()
            return self.reply(500, {"ok": False, "error": "GENERATION_FAILED", "message": str(err)[:500]})
        self.send_response(200)
        self.send_header("Content-Type", "model/gltf-binary")
        self.send_header("Content-Length", str(len(glb)))
        self.end_headers()
        self.wfile.write(glb)

    def do_POST(self):
        if self.path.startswith("/sim/"):
            return self.simulation("POST")
        if self.path.startswith("/eng/"):
            return self.engineering("POST")
        if self.path == "/analyze":
            return self.analyse()
        if self.path == "/generate":
            return self.generate()
        match = re.fullmatch(r"/jobs/([^/]+)/(generate|fix|cancel)", self.path)
        if not match or not JOB_ID_RE.match(match.group(1)):
            return self.reply(404, {"ok": False, "error": "NOT_FOUND"})
        job_id, action = match.groups()
        directory = JOBS_DIR / job_id
        if not directory.is_dir():
            return self.reply(404, {"ok": False, "error": "JOB_NOT_FOUND", "message": "Không có thư mục của job."})
        body = self.body()

        if action in ("generate", "fix") and not claude_ready():
            return self.reply(501, {"ok": False, "error": "AI_DISABLED",
                                    "message": "Container mesh3d chưa có CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)."})

        if action == "generate":
            if (directory / "input.png").exists():
                ahead = shape.queue_job(job_id, body)
                if ahead is None:
                    return self.reply(409, {"ok": False, "error": "JOB_RUNNING", "message": "Job đang chạy."})
                return self.reply(202, {"ok": True, "queue_position": ahead})
            if not str(body.get("prompt") or "").strip():
                return self.reply(400, {"ok": False, "error": "NO_INPUT", "message": "Cần ảnh hoặc mô tả."})
            error = review.start_create(job_id, body, str(body.get("model") or ""))
            if error:
                return self.reply(409, {"ok": False, "error": "JOB_RUNNING", "message": error})
            return self.reply(202, {"ok": True})

        if action == "fix":
            parent_id = str(body.get("parent_id") or "")
            if not JOB_ID_RE.match(parent_id) or not (JOBS_DIR / parent_id).is_dir():
                return self.reply(404, {"ok": False, "error": "JOB_NOT_FOUND", "message": "Không có mô hình cần sửa."})
            error = review.start(job_id, parent_id, str(body.get("model") or ""))
            if error:
                return self.reply(409, {"ok": False, "error": "FIX_NOT_STARTED", "message": error})
            return self.reply(202, {"ok": True})

        if review.cancel(job_id) or shape.cancel(job_id):
            return self.reply(200, {"ok": True})
        return self.reply(409, {"ok": False, "error": "JOB_NOT_RUNNING", "message": "Job không còn chạy."})


if __name__ == "__main__":
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    shape.start()
    sim.start()
    eng.start()
    print(f"[mesh-worker] listening on :{PORT}, jobs in {JOBS_DIR}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
