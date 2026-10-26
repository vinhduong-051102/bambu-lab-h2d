"""
Claude's review of a figure (docs/cad.md, "Claude review & sửa"), run by the mesh worker next to its GPU queue:
it needs no GPU, so it never waits behind a figure being made. The gateway makes the job folder (job.json and
request.md); start() copies the figure it revises into source/ and its picture to concept.png, then Claude
(claude -p, fix_prompt.md) writes fix.py with meshkit and runs refine.py until the figure is right. The last
fix.py is run once more, so out/ always matches it.

status.json: as the CAD worker's ("starting", "reading", "writing", "building", "reviewing", "finishing" steps,
a build's detail its outcome), with "input": "fix" and "colour" when the figure is painted.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

JOBS_DIR = Path(os.environ.get("JOBS_DIR", "/jobs"))
HERE = Path(__file__).resolve().parent
DEFAULT_MODEL = os.environ.get("CAD_AI_MODEL") or "claude-opus-5-5"
CLAUDE_TIMEOUT_S = int(os.environ.get("MESH_FIX_TIMEOUT_S", "1200"))
RUN_TIMEOUT_S = 300
MAX_TURNS = 60

RESULT_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "Tên ngắn của mô hình bằng tiếng Việt, vài từ"},
        "summary": {"type": "string", "description": "Đã sửa những gì, mô hình giờ ra sao, cách in (có cần support, brim)"},
        "issues": {
            "type": "array",
            "description": "Mọi lỗi tìm thấy, nặng nhất trước",
            "items": {
                "type": "object",
                "properties": {
                    "problem": {"type": "string", "description": "Lỗi gì, ở đâu"},
                    "fixed": {"type": "boolean"},
                    "how": {"type": "string", "description": "Đã sửa thế nào, hoặc vì sao chưa sửa được"},
                },
                "required": ["problem", "fixed", "how"],
                "additionalProperties": False,
            },
        },
        "warnings": {"type": "array", "items": {"type": "string"},
                     "description": "Điều người dùng cần kiểm tra trước khi in; khi nên tạo lại mô hình thì nói ở đây"},
    },
    "required": ["title", "summary", "issues", "warnings"],
    "additionalProperties": False,
}

lock = threading.Lock()
running = {}  # job id → Popen of its Claude run (None while it is being prepared)
cancelled = set()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, data):
    part = path.with_name(path.name + ".part")
    part.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(part, path)


def ids():
    with lock:
        return list(running)


def prepare(directory, parent):
    """The figure being revised into source/, its picture (as a real PNG, whatever was uploaded) to concept.png"""
    from PIL import Image

    source = directory / "source"
    source.mkdir(exist_ok=True)
    for name in ("model.stl", "model.3mf", "report.json", "preview.png"):
        if (parent / "out" / name).exists():
            shutil.copy2(parent / "out" / name, source / name)
    for name in ("concept.png", "input.png"):
        if (parent / name).exists():
            Image.open(parent / name).save(directory / "concept.png")
            break


def start(job_id, parent_id, model):
    """Starts the review in the background. Returns an error message, or None"""
    directory, parent = JOBS_DIR / job_id, JOBS_DIR / parent_id
    if not (parent / "out" / "model.stl").exists():
        return "Mô hình cần sửa chưa có model.stl."
    with lock:
        if job_id in running:
            return "Job đang chạy."
        running[job_id] = None
    try:
        prepare(directory, parent)
    except Exception as err:  # noqa: BLE001 - told to the user as it is
        with lock:
            running.pop(job_id, None)
        return f"Không chép được mô hình cần sửa: {err}"
    threading.Thread(target=run_safely, args=(job_id, model or DEFAULT_MODEL), daemon=True).start()
    return None


def cancel(job_id):
    """Stops a review; False when it is not running"""
    with lock:
        if job_id not in running:
            return False
        cancelled.add(job_id)
        proc = running[job_id]
    status = read_json(JOBS_DIR / job_id / "status.json", {})
    status.update(state="cancelled", error="Đã hủy.")
    write_json(JOBS_DIR / job_id / "status.json", status)
    if proc:
        kill(proc)
    return True


def kill(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass


def run_fix(directory):
    """refine.py on the job's fix.py; its report, or one saying why it did not run"""
    try:
        subprocess.run([sys.executable, str(HERE / "refine.py"), "fix.py"], cwd=directory, capture_output=True,
                       timeout=RUN_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"fix.py chạy quá {RUN_TIMEOUT_S} giây."}
    return read_json(directory / "out" / "report.json") or {"ok": False, "error": "refine.py không ghi report.json."}


def step_of(tool_name, tool_input):
    """What a tool call means for the progress shown to the user: (step, detail), or (None, None)"""
    command = str(tool_input.get("command", ""))
    target = str(tool_input.get("file_path", ""))
    name = target.rsplit("/", 1)[-1]
    if tool_name == "Bash" and "refine.py" in command:
        return "building", None
    if tool_name == "Read" and target.endswith(".png"):
        detail = {"concept.png": "Xem ảnh gốc", "views.png": "Xem mô hình từ 6 phía",
                  "preview.png": "Xem ảnh xem trước"}.get(name, f"Xem cận cảnh {name}")
        return "reviewing", detail
    if tool_name == "Read" and name in ("fix_guide.md", "request.md", "fix.py", "report.json"):
        return "reading", f"Đọc {name}"
    if tool_name in ("Write", "Edit") and target.endswith(".py"):
        return "writing", f"{'Viết' if tool_name == 'Write' else 'Sửa'} {name}"
    return None, None


def begin_step(status, step, detail=None):
    """As the CAD worker's: a repeated step stays one line, except runs, which each get their outcome"""
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


def run_outcome(content):
    """A run's tool result (whatever fix.py printed, then the runner's JSON report) as one line"""
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    text = str(content or "")
    start = text.rfind('{\n  "ok"')
    try:
        report = json.loads(text[start: text.rfind("}") + 1]) if start >= 0 else None
    except ValueError:
        report = None
    if not report:
        return None
    if not report.get("ok"):
        return f"✗ {report.get('error') or 'lỗi'}"[:240]
    size = " × ".join(f"{v:g}" for v in report.get("size_mm") or [])
    count = len(report.get("warnings") or [])
    watertight = (report.get("mesh") or {}).get("watertight")
    solids = report.get("solids")
    return (f"✓ {size} mm" + (f", {solids} khối" if solids and solids > 1 else "")
            + ("" if watertight is not False else ", lưới hở") + (f", {count} cảnh báo" if count else ""))


def claude_error(result, stderr):
    detail = (result or {}).get("result") or stderr.strip()[-500:] or "không có thông báo lỗi"
    lowered = detail.lower()
    if "401" in detail or "authenticat" in lowered or "oauth" in lowered or "token" in lowered:
        return f"CLAUDE_CODE_OAUTH_TOKEN không hợp lệ hoặc đã hết hạn: chạy lại claude setup-token. ({detail})"
    if "limit" in lowered:
        return f"Đã hết lượt dùng Claude của gói hiện tại, thử lại sau. ({detail})"
    return f"Claude không trả về kết quả hợp lệ: {detail}"


def run(job_id, model):
    directory = JOBS_DIR / job_id
    status = {"state": "running", "step": "starting", "input": "fix",
              "colour": (directory / "source" / "model.3mf").exists(), "notes": [], "builds": 0, "model": model,
              "started_at": now(), "finished_at": None, "error": None, "result": None, "report": None, "steps": [],
              "progress": None}
    begin_step(status, "starting", f"Khởi động Claude Code ({model})")
    write_json(directory / "status.json", status)
    runs = {}  # refine.py tool calls by id, so their results land on the run's own line

    command = [
        "claude", "-p",
        "--model", model,
        "--tools", "Bash,Read,Write,Edit",
        "--allowedTools", "Bash,Read,Write,Edit",
        "--setting-sources", "",
        "--no-session-persistence",
        "--max-turns", str(MAX_TURNS),
        "--append-system-prompt", (HERE / "fix_prompt.md").read_text(encoding="utf-8"),
        "--json-schema", json.dumps(RESULT_SCHEMA),
        "--output-format", "stream-json", "--verbose",
    ]
    env = {**os.environ, "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "32000",
           # fix.py imports meshkit from wherever Claude runs it
           "PYTHONPATH": os.pathsep.join([str(HERE), os.environ.get("CAD_DIR", "/opt/cad")])}
    stderr_path = directory / "claude.err"
    with lock:
        if job_id in cancelled:
            return
        with open(stderr_path, "w", encoding="utf-8") as stderr_file:
            proc = subprocess.Popen(command, cwd=directory, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=stderr_file, text=True, encoding="utf-8", start_new_session=True)
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
            changed = False
            if event.get("type") == "user":
                for block in event.get("message", {}).get("content", []):
                    entry = runs.get(block.get("tool_use_id")) if isinstance(block, dict) else None
                    if entry is not None:
                        outcome = run_outcome(block.get("content"))
                        entry["detail"] = f"{entry['detail']}: {outcome}" if outcome else entry["detail"]
                        entry["finished_at"] = now()
                        changed = True
            elif event.get("type") == "assistant":
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
                            if step == "building":
                                status["builds"] += 1
                                detail = f"Lần chạy {status['builds']}"
                            entry = begin_step(status, step, detail)
                            if step == "building":
                                runs[block.get("id")] = entry
                            changed = True
            if changed and job_id not in cancelled:
                write_json(directory / "status.json", status)
    code = proc.wait()
    timer.cancel()
    with lock:
        was_cancelled = job_id in cancelled

    status["finished_at"] = now()
    if result_line:
        status["usage"] = {key: result_line.get(key) for key in ("num_turns", "duration_ms", "usage")}
    if was_cancelled:
        status.update(state="cancelled", error="Đã hủy.")
    elif code in (-signal.SIGKILL, -signal.SIGTERM) and not result_line:
        status.update(state="failed", error=f"Claude chạy quá {CLAUDE_TIMEOUT_S // 60} phút nên đã bị dừng.")
    elif not result_line or result_line.get("is_error") or not result_line.get("structured_output"):
        stderr = stderr_path.read_text(encoding="utf-8", errors="replace") if stderr_path.exists() else ""
        status.update(state="failed", error=claude_error(result_line, stderr))
    elif not (directory / "fix.py").exists():
        status.update(state="failed", error="Claude không viết fix.py.")
    else:
        begin_step(status, "finishing", "Chạy lại fix.py cuối cùng, xuất STL" + (", 3MF" if status["colour"] else "")
                   + " và ảnh xem trước")
        write_json(directory / "status.json", status)
        report = run_fix(directory)
        output = result_line["structured_output"]
        status.update(report=report, state="done" if report.get("ok") else "failed",
                      result={**output, "assumptions": [], "parameters": []},
                      error=None if report.get("ok") else f"fix.py cuối cùng không chạy được: {report.get('error')}")
    steps = status.get("steps") or []
    if steps and steps[-1].get("finished_at") is None:
        steps[-1]["finished_at"] = now()
    with lock:
        if job_id in cancelled:
            status.update(state="cancelled", error="Đã hủy.")
        write_json(directory / "status.json", status)
        running.pop(job_id, None)
        cancelled.discard(job_id)


def run_safely(job_id, model):
    try:
        run(job_id, model)
    except Exception as err:  # noqa: BLE001 - whatever went wrong belongs in the job's status
        status = read_json(JOBS_DIR / job_id / "status.json", {})
        status.update(state="failed", error=f"Worker lỗi: {type(err).__name__}: {err}", finished_at=now())
        write_json(JOBS_DIR / job_id / "status.json", status)
    finally:
        with lock:
            running.pop(job_id, None)
            cancelled.discard(job_id)
