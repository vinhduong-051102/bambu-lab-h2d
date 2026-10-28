"""
CAD worker (docs/cad.md): runs inside the cad container, next to the gateway, which calls it over HTTP. Jobs live
in JOBS_DIR (shared with the gateway as CAD_JOBS_DIR), one folder per job: the gateway writes job.json and
request.md, this worker writes model.py (through Claude), out/ (through build.py) and status.json.

  GET  /health                 {"ok": true, "claude": <CLAUDE_CODE_OAUTH_TOKEN set>, "running": [job ids]}
  POST /jobs/<id>/generate     {"model": "claude-opus-5-5"}: Claude writes and builds model.py from request.md,
                               in the background; status.json follows its progress. 202, or 409 when running
  POST /jobs/<id>/build        Builds the job's model.py now and answers with build.py's report
  POST /jobs/<id>/cancel       Stops the job's Claude run
  POST /convert                {"file": "<path in JOBS_DIR>"} or {"data_base64", "filename", "job_id"?}, with
                               "tolerance_mm"? and "angular_tolerance_deg"?: each solid of a STEP/IGES file as an STL
                               in <job>/out/ (convert.py), answered with convert.json. The job is the folder the file
                               is in, else job_id, else a new one; the upload is kept as <job>/input/<filename>

status.json: {"state": "running" | "done" | "failed" | "cancelled", "step": "starting" | "reading" | "writing" |
"building" | "reviewing" | "finishing", "steps": [every step so far: {id, started_at, finished_at, detail}; a
build's detail is its outcome], "notes": ["• ..."], "builds": n, "started_at", "finished_at", "error", "result":
{summary, ...the output schema}, "report": <last out/report.json>}
"""

import base64
import binascii
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

JOBS_DIR = Path(os.environ.get("JOBS_DIR", "/jobs"))
HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8000"))
DEFAULT_MODEL = os.environ.get("CAD_AI_MODEL") or "claude-opus-5-5"
# A Claude run that goes on longer than this is stopped (it has its own limit of builds in prompt.md)
CLAUDE_TIMEOUT_S = int(os.environ.get("CAD_AI_TIMEOUT_S", "1200"))
BUILD_TIMEOUT_S = 180
MAX_TURNS = 60
CONVERT_TIMEOUT_S = 300
MAX_CONVERT_BYTES = 100 * 1024 * 1024
CONVERT_SUFFIXES = (".step", ".stp", ".iges", ".igs")
JOB_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{5,63}$")

RESULT_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "Tên ngắn của mô hình, vài từ"},
        "summary": {"type": "string", "description": "Mô hình gồm những gì, cách in (hướng đặt, có cần support)"},
        "assumptions": {"type": "array", "items": {"type": "string"},
                        "description": "Những điều yêu cầu không nói rõ mà bạn đã tự chọn"},
        "parameters": {
            "type": "array",
            "description": "Các biến kích thước ở đầu model.py mà người dùng có thể đổi",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "value": {"type": "number"}, "description": {"type": "string"}},
                "required": ["name", "value", "description"],
                "additionalProperties": False,
            },
        },
        "warnings": {"type": "array", "items": {"type": "string"},
                     "description": "Điều người dùng cần kiểm tra trước khi in"},
    },
    "required": ["title", "summary", "assumptions", "parameters", "warnings"],
    "additionalProperties": False,
}

lock = threading.Lock()
running = {}  # job id → Popen of its Claude run
converting = set()  # job ids with a STEP/IGES conversion under way
cancelled = set()  # job ids stopped from the dashboard, whose status says so already


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def job_dir(job_id):
    return JOBS_DIR / job_id


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, data):
    """Replaced whole, so the gateway never reads half a file"""
    part = path.with_name(path.name + ".part")
    part.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(part, path)


def run_build(directory):
    """build.py on the job's model.py; its report, or one saying why it did not run"""
    try:
        subprocess.run([sys.executable, str(HERE / "build.py"), "model.py"], cwd=directory,
                       capture_output=True, timeout=BUILD_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"Dựng mô hình quá {BUILD_TIMEOUT_S} giây."}
    return read_json(directory / "out" / "report.json") or {"ok": False, "error": "build.py không ghi report.json."}


def new_job_id():
    """Like the gateway's newJobId: "20261023-091502-a1b2", sorting by creation time"""
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)


def convert_source(body):
    """(job id, the STEP/IGES file) for a /convert request, or raises ValueError with what is wrong. A file named
    by path must be in a job folder; an uploaded one is written to <job>/input/"""
    if body.get("file"):
        path = Path(str(body["file"]))
        path = (path if path.is_absolute() else JOBS_DIR / path).resolve()
        try:
            job_id = path.relative_to(JOBS_DIR.resolve()).parts[0]
        except (ValueError, IndexError):
            raise ValueError(f"file phải nằm trong {JOBS_DIR}.") from None
        if not JOB_ID_RE.match(job_id) or len(path.relative_to(JOBS_DIR.resolve()).parts) < 2:
            raise ValueError("file phải nằm trong thư mục của một job.")
        if not path.is_file():
            raise ValueError(f"Không có file {body['file']}.")
        if not path.name.lower().endswith(CONVERT_SUFFIXES):
            raise ValueError("Chỉ nhận file .step, .stp, .iges, .igs.")
        return job_id, path
    if not body.get("data_base64") or not body.get("filename"):
        raise ValueError('Cần "file" (đường dẫn trong thư mục jobs) hoặc "data_base64" cùng "filename".')
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(str(body["filename"])).name).lstrip(".") or "model"
    if not name.lower().endswith(CONVERT_SUFFIXES):
        raise ValueError("Chỉ nhận file .step, .stp, .iges, .igs.")
    try:
        data = base64.b64decode(str(body["data_base64"]), validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("data_base64 không phải base64 hợp lệ.") from None
    if not data:
        raise ValueError("File rỗng.")
    if len(data) > MAX_CONVERT_BYTES:
        raise ValueError(f"File lớn quá {MAX_CONVERT_BYTES // 1024 // 1024} MB.")
    job_id = str(body.get("job_id") or new_job_id())
    if not JOB_ID_RE.match(job_id):
        raise ValueError("job_id không hợp lệ.")
    inputs = job_dir(job_id) / "input"
    inputs.mkdir(parents=True, exist_ok=True)
    (inputs / name).write_bytes(data)
    return job_id, inputs / name


def run_convert(source, out, tolerance, angular):
    """convert.py on a STEP/IGES file in its own process (OpenCascade may crash on a broken file); its report"""
    out.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run([sys.executable, str(HERE / "convert.py"), str(source), str(out), repr(tolerance), repr(angular)],
                       capture_output=True, timeout=CONVERT_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"Chuyển đổi quá {CONVERT_TIMEOUT_S} giây."}
    return read_json(out / "convert.json") or {"ok": False, "error": "convert.py không ghi convert.json (có thể đã bị crash)."}


def tolerance_of(body, key, default, low, high):
    value = body.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise ValueError(f"{key} phải là số từ {low} đến {high}.")
    return float(value)


def step_of(tool_name, tool_input):
    """What a tool call means for the progress shown to the user: (step, detail), or (None, None)"""
    command = str(tool_input.get("command", ""))
    target = str(tool_input.get("file_path", ""))
    name = target.rsplit("/", 1)[-1]
    if tool_name == "Bash" and "build.py" in command:
        return "building", None
    if tool_name == "Read" and target.endswith(".png"):
        return "reviewing", f"Xem {name} (4 góc nhìn)"
    if tool_name == "Read" and name in ("guide.md", "request.md", "model.py"):
        return "reading", f"Đọc {name}"
    if tool_name == "Write" and target.endswith(".py"):
        return "writing", f"Viết {name}"
    if tool_name == "Edit" and target.endswith(".py"):
        return "writing", f"Sửa {name}"
    return None, None


def begin_step(status, step, detail=None):
    """Appends a step to status["steps"], closing the one before; a repeated step (two edits in a row) stays one,
    except builds, which each get their own line for their outcome"""
    steps = status.setdefault("steps", [])
    if steps and steps[-1]["id"] == step and step != "building":
        if detail:
            steps[-1]["detail"] = detail
        return steps[-1]
    if steps and steps[-1].get("finished_at") is None:
        steps[-1]["finished_at"] = now()
    entry = {"id": step, "started_at": now(), "finished_at": None, "detail": detail}
    steps.append(entry)
    status["step"] = step
    return entry


def build_outcome(content):
    """A build's tool result (build.py's JSON report) as one line: ✓ 60 × 40 × 20 mm, 1 cảnh báo / ✗ <error>"""
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    text = str(content or "")
    try:
        report = json.loads(text[text.find("{"): text.rfind("}") + 1])
    except ValueError:
        return None
    if not report.get("ok"):
        return f"✗ {report.get('error') or 'lỗi'}"[:240]
    size = " × ".join(f"{v:g}" for v in report.get("size_mm") or [])
    count = len(report.get("warnings") or [])
    watertight = (report.get("mesh") or {}).get("watertight")
    return f"✓ {size} mm" + ("" if watertight is not False else ", lưới hở") + (f", {count} cảnh báo" if count else "")


LIMIT_COOLDOWN_S = 3600
limited_at = {}  # token → time.monotonic() when it hit its usage limit, so the next runs start with the other one


def claude_tokens():
    """CLAUDE_CODE_OAUTH_TOKEN, then CLAUDE_CODE_OAUTH_TOKEN_FALLBACK (a second subscription); one that hit its
    usage limit within the hour goes last"""
    names = ("CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FALLBACK")
    tokens = list(dict.fromkeys(t for t in (os.environ.get(n, "").strip() for n in names) if t))
    return sorted(tokens, key=lambda t: t in limited_at and time.monotonic() - limited_at[t] < LIMIT_COOLDOWN_S)


def limit_hit(result, stderr):
    """Whether a failed run ran out of usage on its subscription"""
    return "limit" in ((result or {}).get("result") or stderr.strip()[-500:]).lower()


def claude_error(result, stderr):
    detail = (result or {}).get("result") or stderr.strip()[-500:] or "không có thông báo lỗi"
    lowered = detail.lower()
    if "401" in detail or "authenticat" in lowered or "oauth" in lowered or "token" in lowered:
        return f"CLAUDE_CODE_OAUTH_TOKEN không hợp lệ hoặc đã hết hạn: chạy lại claude setup-token. ({detail})"
    if "limit" in lowered:
        return f"Đã hết lượt dùng Claude của gói hiện tại, thử lại sau. ({detail})"
    return f"Claude không trả về kết quả hợp lệ: {detail}"


def generate(job_id, model, tokens=None):
    tokens = claude_tokens() if tokens is None else tokens
    directory = job_dir(job_id)
    status = {"state": "running", "step": "starting", "notes": [], "builds": 0, "model": model,
              "started_at": now(), "finished_at": None, "error": None, "result": None, "report": None,
              "steps": [], "progress": None}
    begin_step(status, "starting", f"Khởi động Claude Code ({model})")
    write_json(directory / "status.json", status)
    # Build tool calls by id, so their results land on the build's own line
    builds = {}

    command = [
        "claude", "-p",
        "--model", model,
        "--tools", "Bash,Read,Write,Edit",
        "--allowedTools", "Bash,Read,Write,Edit",
        "--setting-sources", "",
        "--no-session-persistence",
        "--max-turns", str(MAX_TURNS),
        "--append-system-prompt", (HERE / "prompt.md").read_text(encoding="utf-8"),
        "--json-schema", json.dumps(RESULT_SCHEMA),
        "--output-format", "stream-json", "--verbose",
    ]
    env = {**os.environ, "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "32000"}
    if tokens:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = tokens[0]
    stderr_path = directory / "claude.err"
    with open(stderr_path, "w", encoding="utf-8") as stderr_file:
        proc = subprocess.Popen(command, cwd=directory, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=stderr_file, text=True, encoding="utf-8", start_new_session=True)
    with lock:
        running[job_id] = proc
    proc.stdin.write("Làm theo yêu cầu trong request.md.\n")
    proc.stdin.close()
    timer = threading.Timer(CLAUDE_TIMEOUT_S, lambda: kill(proc))
    timer.start()

    result_line = None
    text = ""
    with open(directory / "claude.jsonl", "w", encoding="utf-8") as log:
        for line in proc.stdout:
            log.write(line)
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("type") == "result":
                result_line = event
            if event.get("type") == "user":
                changed = False
                for block in event.get("message", {}).get("content", []):
                    entry = builds.get(block.get("tool_use_id")) if isinstance(block, dict) else None
                    if entry is not None:
                        outcome = build_outcome(block.get("content"))
                        entry["detail"] = f"{entry['detail']}: {outcome}" if outcome else entry["detail"]
                        entry["finished_at"] = now()
                        changed = True
                if changed and job_id not in cancelled:
                    write_json(directory / "status.json", status)
                continue
            if event.get("type") != "assistant":
                continue
            changed = False
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "text":
                    text += block.get("text", "") + "\n"
                    notes = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("•")]
                    if notes != status["notes"]:
                        status["notes"] = notes[-30:]
                        changed = True
                elif block.get("type") == "tool_use":
                    step, detail = step_of(block.get("name"), block.get("input") or {})
                    if step:
                        status["builds"] += step == "building"
                        if step == "building":
                            detail = f"Lần dựng {status['builds']}"
                        entry = begin_step(status, step, detail)
                        if step == "building":
                            builds[block.get("id")] = entry
                        changed = True
            if changed and job_id not in cancelled:
                write_json(directory / "status.json", status)
    code = proc.wait()
    timer.cancel()
    # The job stays in `running` until its final status is written: the gateway shows a running job the
    # worker no longer lists as interrupted, and the last build below takes a few seconds
    with lock:
        was_cancelled = job_id in cancelled

    # Out of usage on this subscription: the job starts over on the next one
    if not was_cancelled and len(tokens) > 1 and not (result_line or {}).get("structured_output"):
        stderr = stderr_path.read_text(encoding="utf-8", errors="replace") if stderr_path.exists() else ""
        if limit_hit(result_line, stderr):
            limited_at[tokens[0]] = time.monotonic()
            return generate(job_id, model, tokens[1:])

    status["finished_at"] = now()
    status["report"] = read_json(directory / "out" / "report.json")
    if result_line:
        status["usage"] = {key: result_line.get(key) for key in ("num_turns", "duration_ms", "usage")}
    if was_cancelled:
        status.update(state="cancelled", error="Đã hủy.")
    elif code in (-signal.SIGKILL, -signal.SIGTERM) and not result_line:
        status.update(state="failed", error=f"Claude chạy quá {CLAUDE_TIMEOUT_S // 60} phút nên đã bị dừng.")
    elif not result_line or result_line.get("is_error") or not result_line.get("structured_output"):
        stderr = stderr_path.read_text(encoding="utf-8", errors="replace") if stderr_path.exists() else ""
        status.update(state="failed", error=claude_error(result_line, stderr))
    elif not (directory / "model.py").exists():
        status.update(state="failed", error="Claude không viết model.py.")
    else:
        # Built once more here, so the files and report always match the model.py that was kept
        begin_step(status, "finishing", "Dựng lại model.py cuối cùng, xuất STL, STEP và ảnh xem trước")
        write_json(directory / "status.json", status)
        report = run_build(directory)
        status.update(report=report, result=result_line["structured_output"],
                      state="done" if report.get("ok") else "failed",
                      error=None if report.get("ok") else f"model.py cuối cùng không dựng được: {report.get('error')}")
    steps = status.get("steps") or []
    if steps and steps[-1].get("finished_at") is None:
        steps[-1]["finished_at"] = now()
    with lock:
        # Cancelled during the last build
        if job_id in cancelled:
            status.update(state="cancelled", error="Đã hủy.")
        write_json(directory / "status.json", status)
        running.pop(job_id, None)
        cancelled.discard(job_id)


def kill(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[cad-worker] {self.address_string()} {fmt % args}\n")

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except ValueError:
            return {}

    def do_GET(self):
        if self.path == "/health":
            with lock:
                ids = list(running)
            return self.reply(200, {"ok": True, "claude": bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")),
                                    "running": ids})
        self.reply(404, {"ok": False, "error": "NOT_FOUND"})

    def do_POST(self):
        if self.path == "/convert":
            return self.convert(self.body())
        match = re.fullmatch(r"/jobs/([^/]+)/(generate|build|cancel)", self.path)
        if not match or not JOB_ID_RE.match(match.group(1)):
            return self.reply(404, {"ok": False, "error": "NOT_FOUND"})
        job_id, action = match.groups()
        directory = job_dir(job_id)
        if not directory.is_dir():
            return self.reply(404, {"ok": False, "error": "JOB_NOT_FOUND", "message": "Không có thư mục của job."})
        body = self.body()

        if action == "generate":
            if not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
                return self.reply(501, {"ok": False, "error": "AI_DISABLED",
                                        "message": "Container cad chưa có CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)."})
            if not (directory / "request.md").exists():
                return self.reply(400, {"ok": False, "error": "NO_REQUEST", "message": "Job chưa có request.md."})
            with lock:
                if job_id in running:
                    return self.reply(409, {"ok": False, "error": "JOB_RUNNING", "message": "Job đang chạy."})
            model = str(body.get("model") or DEFAULT_MODEL)
            threading.Thread(target=generate_safely, args=(job_id, model), daemon=True).start()
            return self.reply(202, {"ok": True})

        if action == "build":
            if not (directory / "model.py").exists():
                return self.reply(400, {"ok": False, "error": "NO_MODEL", "message": "Job chưa có model.py."})
            report = run_build(directory)
            status = {"state": "done" if report.get("ok") else "failed", "step": None, "notes": [], "builds": 1,
                      "started_at": now(), "finished_at": now(), "report": report, "result": None,
                      "error": None if report.get("ok") else report.get("error")}
            write_json(directory / "status.json", status)
            return self.reply(200, {"ok": True, "report": report})

        with lock:
            proc = running.get(job_id)
        if not proc:
            return self.reply(409, {"ok": False, "error": "JOB_NOT_RUNNING", "message": "Job không còn chạy."})
        with lock:
            cancelled.add(job_id)
        status = read_json(directory / "status.json", {})
        status.update(state="cancelled", error="Đã hủy.")
        write_json(directory / "status.json", status)
        kill(proc)
        return self.reply(200, {"ok": True})


    def convert(self, body):
        try:
            tolerance = tolerance_of(body, "tolerance_mm", 0.01, 0.0005, 1)
            angular = tolerance_of(body, "angular_tolerance_deg", 0.5, 0.05, 30)
            job_id, source = convert_source(body)
        except ValueError as err:
            return self.reply(400, {"ok": False, "error": "INVALID_CONVERT", "message": str(err)})
        with lock:
            if job_id in running or job_id in converting:
                return self.reply(409, {"ok": False, "error": "JOB_RUNNING", "message": "Job đang chạy."})
            converting.add(job_id)
        try:
            report = run_convert(source, job_dir(job_id) / "out", tolerance, angular)
        finally:
            with lock:
                converting.discard(job_id)
        report.pop("traceback", None)
        if not report.get("ok"):
            return self.reply(422, {"ok": False, "error": "CONVERT_FAILED", "job_id": job_id,
                                    "message": report.get("error") or "Không chuyển được file."})
        return self.reply(200, {**report, "job_id": job_id})


def generate_safely(job_id, model):
    try:
        generate(job_id, model)
    except Exception as err:  # noqa: BLE001 - whatever went wrong belongs in the job's status
        with lock:
            running.pop(job_id, None)
        status = read_json(job_dir(job_id) / "status.json", {})
        status.update(state="failed", error=f"Worker lỗi: {type(err).__name__}: {err}", finished_at=now())
        write_json(job_dir(job_id) / "status.json", status)


if __name__ == "__main__":
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[cad-worker] listening on :{PORT}, jobs in {JOBS_DIR}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
