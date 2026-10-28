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
                                    "loaded": shape.loaded()})
        self.reply(404, {"ok": False, "error": "NOT_FOUND"})

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
    print(f"[mesh-worker] listening on :{PORT}, jobs in {JOBS_DIR}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
