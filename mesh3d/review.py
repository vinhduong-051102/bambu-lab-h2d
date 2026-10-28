"""
Claude making, fixing and finishing figures (docs/cad.md, "Nhân vật") in Blender. Each run gets its own Blender
with its interface on a virtual display (blender_session.py), and Claude works in it through MCP for Blender
(github.com/ahujasid/blender-mcp: execute_blender_code, generate_3d on the local Hunyuan3D-2, look,
get_scene_info) and the printing tools of figure_mcp.py (set_palette, paint_from_picture, check). When Claude is
done, the scene is exported (work/current.ply, each face's filament from its material) and saved
(out/scene.blend), and refine.py turns it into out/.

- start_create(): a new figure from the user's description and/or picture (input.png → concept.png). The worker
  writes request.md (what to make, the size, the plinth, the filaments) and work/choices.json (the filaments it
  may paint with); Claude (claude -p, create_prompt.md) models it from nothing.
- start(): a fix. The gateway writes job.json and request.md; the figure it revises goes into source/ and its
  picture to concept.png, then Claude (fix_prompt.md) fixes it.
- start_finish(): a figure Hunyuan3D-2 shaped from a picture (shape.py left it in source/, unpainted, with the
  picture's colours in work/picture.npz): Claude (finish_prompt.md) fixes it against the picture, adds the plinth
  and paints it, in the same job.

status.json: as the CAD worker's ("starting", "reading", "building", "reviewing", "finishing" steps, a build's
detail its outcome), with "input" ("fix", or "image"/"prompt" for a new figure), "maker" ("claude" when Claude
made it, "hunyuan" when Hunyuan3D shaped it and Claude finished it, after shape.py's steps) and "colour" when the
figure is painted.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

JOBS_DIR = Path(os.environ.get("JOBS_DIR", "/jobs"))
HERE = Path(__file__).resolve().parent
DEFAULT_MODEL = os.environ.get("CAD_AI_MODEL") or "claude-opus-5-5"
CLAUDE_TIMEOUT_S = int(os.environ.get("MESH_FIX_TIMEOUT_S", "1200"))
RUN_TIMEOUT_S = 300
MAX_TURNS = 100
# Claude's tools: a render or a check takes seconds to a minute, generate_3d up to a few minutes
MCP_TOOL_TIMEOUT_MS = 300000
BLENDER = os.environ.get("BLENDER", "blender")
# The MCP for Blender add-on (blender_mcp.py under scripts/addons), where the image put it
BLENDER_SCRIPTS = os.environ.get("BLENDER_MCP_SCRIPTS", "/opt/blender-mcp")
BLENDER_START_S = 120
# What Claude may use of MCP for Blender: no asset libraries (downloads), no telemetry switches
BLENDER_TOOLS = ("execute_blender_code", "look", "get_scene_info", "generate_3d", "get_addon_status")

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


def create_request(prompt, picture, params):
    """Claude's brief for a new figure: what the user asked for, the size and plinth, and the filaments it may use"""
    height = float(params.get("height_mm") or 80)
    colour = params.get("colour") or None
    lines = ["# Mô hình cần dựng", "", f"- Mô tả của người dùng: {prompt or '(không có, dựng theo ảnh)'}",
             "- Ảnh tham khảo: concept.png, dựng theo ảnh này" if picture else "- Không có ảnh: dựng theo mô tả",
             f"- Chiều cao nhân vật: {height:g} mm" + (", chưa tính đế" if params.get("base") else ""),
             f"- Đế tròn: {'có, dưới nhân vật, dính liền' if params.get('base') else 'không'}"]
    if not colour:
        lines.append("- In một màu: không cần set_palette hay material F<n>")
    elif colour.get("palette"):
        lines.append(f"- Tô màu bằng đúng {len(colour['palette'])} filament đang nạp trong AMS (đã đặt sẵn, không "
                     "set_palette): " + ", ".join(f"{i + 1}. {f.get('label') or f['hex']} {f['hex']}"
                                                  for i, f in enumerate(colour["palette"])))
    elif colour.get("snap"):
        lines.append(f"- Tô màu: tối đa {colour.get('count') or 4} filament, chọn bằng set_palette chỉ trong danh sách "
                     "này (theo hex), ưu tiên thứ tự trước:")
        lines += [f"  - {f['hex']} {f.get('label') or ''}".rstrip() for f in colour["snap"]]
    else:
        lines.append(f"- Tô màu: tối đa {colour.get('count') or 4} filament, tự chọn màu hợp với ảnh/mô tả bằng set_palette")
    return "\n".join(lines) + "\n"


def finish_request(prompt, params):
    """Claude's brief for a figure Hunyuan3D shaped from a picture: what to fix, the size and plinth, the colours"""
    height = float(params.get("height_mm") or 80)
    colour = params.get("colour") or None
    views = {"drawn": "4 góc (trái, sau, phải do MV-Adapter vẽ từ ảnh, xem sides.png)",
             "uploaded": "ảnh trước và các góc người dùng tải lên (sides.png)"}.get(params.get("views") or "", "một ảnh")
    lines = ["# Hoàn thiện mô hình Hunyuan3D-2 dựng từ ảnh", "",
             f"- Mô tả của người dùng: {prompt or '(không có)'}",
             "- Ảnh: concept.png (đã tách nền). Mô hình trong source/ do Hunyuan3D-2 dựng từ " + views
             + ": giữ hình dáng, tư thế và chi tiết của nó, chỉ sửa chỗ hỏng và chỗ sai rõ so với ảnh",
             f"- Chiều cao nhân vật: {height:g} mm" + (", chưa tính đế" if params.get("base") else "")
             + " (mô hình đã ở đúng chiều cao này)",
             "- Đế tròn: " + ("có, thêm sau khi sửa xong, dính liền với nhân vật" if params.get("base")
                              else "không: cần đứng vững, cut_below cho đế phẳng nếu cần")]
    if not colour:
        lines.append("- In một màu: không cần set_palette hay material F<n>")
    else:
        found = params.get("picture_colours") or []
        lines.append("- Tô màu: mỗi mặt của Figure mang màu của ảnh ở chỗ đó; set_palette rồi paint_from_picture cho mỗi "
                     "mặt filament gần màu đó nhất. Xem look (shading solid hiện màu filament) rồi sửa bằng material F<n> chỗ ra sai màu "
                     "(mắt, miệng, viền, bóng đổ)")
        if found:
            lines.append("- Màu chính trong ảnh theo diện tích: " + ", ".join(f"{hex_} {share * 100:.0f}%" for hex_, share in found))
        if colour.get("palette"):
            lines.append(f"- Filament: đúng {len(colour['palette'])} filament đang nạp trong AMS (đã đặt sẵn, không "
                         "set_palette): " + ", ".join(f"{i + 1}. {f.get('label') or f['hex']} {f['hex']}"
                                                      for i, f in enumerate(colour["palette"])))
        elif colour.get("snap"):
            lines.append(f"- Filament: tối đa {colour.get('count') or 4}, chọn bằng set_palette chỉ trong danh sách này "
                         "(theo hex), ưu tiên thứ tự trước, mỗi màu chính của ảnh một filament gần nó nhất:")
            lines += [f"  - {f['hex']} {f.get('label') or ''}".rstrip() for f in colour["snap"]]
        else:
            lines.append(f"- Filament: tối đa {colour.get('count') or 4}, chọn bằng set_palette theo các màu chính của ảnh")
    return "\n".join(lines) + "\n"


def start_finish(job_id, params, model):
    """Claude finishing a figure Hunyuan3D shaped (shape.py), in the background. Returns an error message, or None"""
    directory = JOBS_DIR / job_id
    with lock:
        if job_id in running:
            return "Job đang chạy."
        running[job_id] = None
    try:
        meta = read_json(directory / "job.json", {})
        prompt = str(params.get("prompt") or meta.get("prompt") or "").strip()
        (directory / "request.md").write_text(finish_request(prompt, params), encoding="utf-8")
        (directory / "work").mkdir(exist_ok=True)
        write_json(directory / "work" / "choices.json", params.get("colour") or {})
    except Exception as err:  # noqa: BLE001 - told to the user as it is
        with lock:
            running.pop(job_id, None)
        return f"Không chuẩn bị được job: {err}"
    threading.Thread(target=run_safely, args=(job_id, model or DEFAULT_MODEL, params, "finish"), daemon=True).start()
    return None


def start_create(job_id, params, model):
    """Starts Claude making a new figure in the background (no source/: the tools start from nothing). Returns an
    error message, or None"""
    from PIL import Image

    directory = JOBS_DIR / job_id
    with lock:
        if job_id in running:
            return "Job đang chạy."
        running[job_id] = None
    try:
        picture = (directory / "input.png").exists()
        if picture:
            Image.open(directory / "input.png").save(directory / "concept.png")
        meta = read_json(directory / "job.json", {})
        prompt = str(params.get("prompt") or meta.get("prompt") or "").strip()
        (directory / "request.md").write_text(create_request(prompt, picture, params), encoding="utf-8")
        (directory / "work").mkdir(exist_ok=True)
        write_json(directory / "work" / "choices.json", params.get("colour") or {})
    except Exception as err:  # noqa: BLE001 - told to the user as it is
        with lock:
            running.pop(job_id, None)
        return f"Không chuẩn bị được job: {err}"
    threading.Thread(target=run_safely, args=(job_id, model or DEFAULT_MODEL, params, "create"), daemon=True).start()
    return None


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


class BlenderSession:
    """The job's Blender (blender_session.py) on a virtual display, its add-on serving on a free port"""

    def __init__(self, directory):
        import socket

        self.directory = directory
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        # Claude runs Python in this Blender: it gets no Claude token
        env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_CODE_OAUTH_TOKEN")}
        env.update(BLENDER_USER_SCRIPTS=BLENDER_SCRIPTS, BLENDERMCP_NO_UPDATE_CHECK="1",
                   BLENDERMCP_HUNYUAN3D_API_URL=f"http://127.0.0.1:{os.environ.get('PORT', '8000')}")
        self.log = open(directory / "work" / "blender.log", "w", encoding="utf-8")
        self.proc = subprocess.Popen(
            ["xvfb-run", "-a", "-s", "-screen 0 1600x1000x24", BLENDER, "--factory-startup",
             "--python", str(HERE / "blender_session.py"), "--", str(self.port), str(directory)],
            cwd=directory, env=env, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + BLENDER_START_S
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"Blender dừng khi khởi động (mã {self.proc.returncode}), xem work/blender.log")
            try:
                import figure_mcp

                figure_mcp.blender(self.port, "print('ok')", timeout=10)
                return
            except OSError:
                time.sleep(1)
        self.stop()
        raise RuntimeError(f"Blender không sẵn sàng sau {BLENDER_START_S} giây, xem work/blender.log")

    def export(self):
        """The scene → work/current.ply (and its filaments), and saved as out/scene.blend"""
        import figure_mcp

        names = figure_mcp.export_scene(self.port, self.directory)
        (self.directory / "out").mkdir(exist_ok=True)
        blend = (self.directory / "out" / "scene.blend").resolve()
        figure_mcp.blender(self.port, f"import bpy\nbpy.ops.wm.save_as_mainfile(filepath={str(blend)!r}, copy=True)")
        return names

    def stop(self):
        kill(self.proc)
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
        self.log.close()


def start_scene(directory, mode):
    """work/start.npz, what blender_session.py loads: the figure in source/ with its filaments (a fix) or with the
    picture's colours (a figure Hunyuan3D shaped); nothing for a new figure"""
    import numpy as np

    work = directory / "work"
    work.mkdir(exist_ok=True)
    if mode == "create" or not (directory / "source").is_dir():
        return
    sys.path.insert(0, str(HERE))
    import meshkit

    meshkit.SOURCE = directory / "source"
    mesh, labels = meshkit.load_painted()
    data = {"vertices": mesh.vertices, "faces": mesh.faces}
    palette = (read_json(directory / "source" / "report.json") or {}).get("palette")
    if labels is not None and palette:
        data["labels"] = labels
        write_json(work / "palette.json", [{k: p.get(k) for k in ("slot", "hex", "label", "origin") if p.get(k) is not None}
                                           for p in palette])
    elif (work / "picture.npz").exists():
        from scipy.spatial import cKDTree

        picture = np.load(work / "picture.npz")
        data["picture"] = picture["rgb"][cKDTree(picture["points"]).query(mesh.triangles_center)[1]]
    if mode == "finish" and (read_json(work / "choices.json") or {}).get("palette"):
        # The AMS's filaments in Studio's order: filament n of the 3MF is tray n
        write_json(work / "palette.json", [{"slot": i + 1, "hex": f["hex"].upper(), "label": f.get("label"), "origin": "ams"}
                                           for i, f in enumerate(read_json(work / "choices.json")["palette"])])
    np.savez(work / "start.npz", **data)


def run_fix(directory):
    """refine.py on the figure exported from Blender; its report, or one saying why it did not run"""
    try:
        subprocess.run([sys.executable, str(HERE / "refine.py"), "work/current.ply"], cwd=directory, capture_output=True,
                       timeout=RUN_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"fix.py chạy quá {RUN_TIMEOUT_S} giây."}
    return read_json(directory / "out" / "report.json") or {"ok": False, "error": "refine.py không ghi report.json."}


# Claude's tool calls, as the progress shows them
EDIT_STEPS = {"mcp__blender__execute_blender_code": "Chạy code Blender",
              "mcp__blender__generate_3d": "Hunyuan3D-2 dựng hình (generate_3d)",
              "mcp__figure__set_palette": "Chọn filament", "mcp__figure__paint_from_picture": "Tô màu theo ảnh",
              "mcp__figure__check": "Kiểm tra in"}
MEASURE_STEPS = {"mcp__blender__get_scene_info": "Xem thông tin cảnh", "mcp__blender__get_addon_status": "Kiểm tra Blender"}


def step_of(tool_name, tool_input):
    """What a tool call means for the progress shown to the user: (step, detail), or (None, None)"""
    target = str(tool_input.get("file_path", ""))
    name = target.rsplit("/", 1)[-1]
    if tool_name in EDIT_STEPS:
        detail = EDIT_STEPS[tool_name]
        if tool_name.endswith("execute_blender_code"):
            # The code's first comment says what it does
            first = next((ln.strip("# ").strip() for ln in str(tool_input.get("code") or "").splitlines()
                          if ln.strip().startswith("#")), "")
            detail += f": {first[:120]}" if first else ""
        elif tool_name.endswith("generate_3d") and (tool_input.get("prompt") or tool_input.get("image")):
            detail += f": {str(tool_input.get('prompt') or Path(str(tool_input.get('image'))).name)[:120]}"
        return "building", detail
    if tool_name == "mcp__blender__look":
        return "reviewing", "Xem mô hình (Blender" + (f", {tool_input['mode']}" if tool_input.get("mode") else "") + ")"
    if tool_name in MEASURE_STEPS:
        return "reviewing", MEASURE_STEPS[tool_name]
    if tool_name == "Read" and target.endswith(".png"):
        detail = {"concept.png": "Xem ảnh gốc", "sides.png": "Xem ảnh các góc", "views.png": "Xem mô hình từ 6 phía",
                  "preview.png": "Xem ảnh xem trước"}.get(name, f"Xem cận cảnh {name}")
        return "reviewing", detail
    if tool_name == "Read" and name in ("figure_guide.md", "request.md", "report.json"):
        return "reading", f"Đọc {name}"
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
    if text.startswith(("Error", "Rejected")):
        return f"✗ {text.splitlines()[0][:200]}"
    start = text.rfind('{\n  "ok"')
    try:
        report = json.loads(text[start: text.rfind("}") + 1]) if start >= 0 else None
    except ValueError:
        report = None
    if not report:
        return None
    if not report.get("ok"):
        return f"✗ {report.get('error') or 'lỗi'}"[:240]
    if not report.get("size_mm"):
        # A tool's answer that is not a print check (set_palette, paint_from_picture)
        return "✓"
    size = " × ".join(f"{v:g}" for v in report.get("size_mm") or [])
    count = len(report.get("warnings") or [])
    watertight = (report.get("mesh") or {}).get("watertight")
    solids = report.get("solids")
    return (f"✓ {size} mm" + (f", {solids} khối" if solids and solids > 1 else "")
            + ("" if watertight is not False else ", lưới hở") + (f", {count} cảnh báo" if count else ""))


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


def figure_parameters(params, shaped=False):
    """What "Tạo lại" on the dashboard reads back: the height, the plinth and the colours; for a figure Hunyuan3D
    shaped, the seed and whether it was shaped from several sides too"""
    colour = params.get("colour") or {}
    colours = len(colour["palette"]) if colour.get("palette") else int(colour.get("count") or 0)
    out = [
        {"name": "height_mm", "value": float(params.get("height_mm") or 80), "description": "Chiều cao nhân vật, chưa tính đế (mm)"},
        {"name": "base", "value": int(bool(params.get("base"))), "description": "Có đế tròn (1) hay không (0)"},
        {"name": "colours", "value": colours, "description": "Số màu (0: không tô màu)"},
    ]
    if shaped:
        out += [{"name": "seed", "value": int(params.get("seed") or 0), "description": "Số ngẫu nhiên của Hunyuan3D: đổi để ra hình khác"},
                {"name": "multiview", "value": int(bool(params.get("multiview"))), "description": "Dựng từ nhiều góc nhìn (1) hay một ảnh (0)"}]
    return out


def run(job_id, model, params=None, tokens=None, mode="fix", session=None):
    """Claude in the job's Blender on job `job_id`: fixing the figure in source/ ("fix"), making a new one from
    `params` ("create"), or finishing the one Hunyuan3D shaped there from its picture ("finish")"""
    tokens = claude_tokens() if tokens is None else tokens
    directory = JOBS_DIR / job_id
    creating, finishing = mode == "create", mode == "finish"
    if session is None:
        if finishing:
            # After shape.py's steps, in the same status
            status = read_json(directory / "status.json", {})
            status.update(state="running", model=model, error=None, result=None, report=None, progress=None)
            status.setdefault("steps", [])
            status.setdefault("builds", 0)
        else:
            status = {"state": "running", "step": "opening",
                      "input": ("image" if (directory / "input.png").exists() else "prompt") if creating else "fix",
                      # Made by Claude in Blender, not by a picture-to-shape model: no steps known ahead
                      "maker": "claude",
                      "colour": bool(params.get("colour")) if creating else (directory / "source" / "model.3mf").exists(),
                      "notes": [], "builds": 0, "model": model,
                      "started_at": now(), "finished_at": None, "error": None, "result": None, "report": None,
                      "steps": [], "progress": None}
        begin_step(status, "opening", "Blender với MCP for Blender, trên màn hình ảo")
        write_json(directory / "status.json", status)
        start_scene(directory, mode)
        session = BlenderSession(directory)
        try:
            return run(job_id, model, params, tokens, mode, session)
        finally:
            session.stop()
    # As the steps before left it: Blender's start, shape.py's, an attempt on the other subscription
    status = read_json(directory / "status.json", {})
    # Claude's "• " lines come after those of the steps before it
    earlier_notes = list(status.get("notes") or [])
    begin_step(status, "starting", f"Khởi động Claude Code ({model})")
    write_json(directory / "status.json", status)
    runs = {}  # tool calls by id, so their results land on the step's own line

    # MCP for Blender and the printing tools, both on the job's Blender
    mcp = {"mcpServers": {
        "blender": {"command": "mcp-for-blender", "args": ["--host", "127.0.0.1", "--port", str(session.port)],
                    "env": {"DISABLE_TELEMETRY": "true", "BLENDERMCP_NO_UPDATE_CHECK": "1"}},
        "figure": {"command": sys.executable, "args": [str(HERE / "figure_mcp.py"), str(directory), str(session.port)],
                   "env": {"PYTHONPATH": os.pathsep.join([str(HERE), os.environ.get("CAD_DIR", "/opt/cad")])}}}}
    allowed = ["Read", "mcp__figure"] + [f"mcp__blender__{name}" for name in BLENDER_TOOLS]
    command = [
        "claude", "-p",
        "--model", model,
        # Reading files, and working in Blender through its tools
        "--tools", "Read",
        "--mcp-config", json.dumps(mcp),
        "--strict-mcp-config",
        "--allowedTools", ",".join(allowed),
        "--disallowedTools", ",".join(f"mcp__blender__{name}" for name in (
            "search_assets", "import_asset", "disable_telemetry", "record_trajectory_feedback", "search_mentions",
            "open_viewport", "viewport_latest", "viewport_capture", "viewport_pick")),
        "--setting-sources", "",
        "--no-session-persistence",
        "--max-turns", str(MAX_TURNS),
        "--append-system-prompt", (HERE / f"{mode}_prompt.md").read_text(encoding="utf-8"),
        "--json-schema", json.dumps(RESULT_SCHEMA),
        "--output-format", "stream-json", "--verbose",
    ]
    env = {**os.environ, "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "32000", "MCP_TOOL_TIMEOUT": str(MCP_TOOL_TIMEOUT_MS)}
    if tokens:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = tokens[0]
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
                        notes = earlier_notes + notes[-30:]
                        if notes != status["notes"]:
                            status["notes"] = notes
                            changed = True
                    elif block.get("type") == "tool_use":
                        step, detail = step_of(block.get("name"), block.get("input") or {})
                        if step:
                            if step == "building":
                                status["builds"] += 1
                                detail = f"Bước {status['builds']}: {detail}"
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

    # Out of usage on this subscription: the job starts over on the next one
    if not was_cancelled and len(tokens) > 1 and not (result_line or {}).get("structured_output"):
        stderr = stderr_path.read_text(encoding="utf-8", errors="replace") if stderr_path.exists() else ""
        if limit_hit(result_line, stderr):
            limited_at[tokens[0]] = time.monotonic()
            return run(job_id, model, params, tokens[1:], mode, session)

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
    else:
        begin_step(status, "finishing", "Xuất STL" + (", 3MF" if status["colour"] else "")
                   + " và ảnh xem trước")
        write_json(directory / "status.json", status)
        try:
            session.export()
            report = run_fix(directory)
        except Exception as err:  # noqa: BLE001 - an empty scene is the run's outcome, not a crash
            report = {"ok": False, "error": ("Claude chưa dựng được gì: " if creating else "") + str(err)}
        output = result_line["structured_output"]
        status.update(report=report, state="done" if report.get("ok") else "failed",
                      result={**output, "assumptions": list((params or {}).get("assumptions") or []),
                              "parameters": figure_parameters(params, finishing) if params is not None else []},
                      error=None if report.get("ok") else f"Không xuất được mô hình: {report.get('error')}")
    steps = status.get("steps") or []
    if steps and steps[-1].get("finished_at") is None:
        steps[-1]["finished_at"] = now()
    with lock:
        if job_id in cancelled:
            status.update(state="cancelled", error="Đã hủy.")
        write_json(directory / "status.json", status)
        running.pop(job_id, None)
        cancelled.discard(job_id)


def run_safely(job_id, model, params=None, mode="fix"):
    try:
        run(job_id, model, params, mode=mode)
    except Exception as err:  # noqa: BLE001 - whatever went wrong belongs in the job's status
        status = read_json(JOBS_DIR / job_id / "status.json", {})
        status.update(state="failed", error=f"Worker lỗi: {type(err).__name__}: {err}", finished_at=now())
        write_json(JOBS_DIR / job_id / "status.json", status)
    finally:
        with lock:
            running.pop(job_id, None)
            cancelled.discard(job_id)
