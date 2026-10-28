"""
Where the engineering analyses keep their data, under ENG_DIR (data/eng on the host):

  models/<model id>/v<n>/model.json         the model: name, units, components, where each came from
  models/<model id>/v<n>/source/<file>      the files as given, byte for byte (never changed)
  models/<model id>/v<n>/components/<id>.ply each component in millimetres, in the assembly's frame
  analyses/<analysis id>/result.json        one analysis (schema.new_result), its files and log beside it
  uploads/<name>                             files sent by the MCP server from the user's computer

A new import of the same model makes a new version; analyses name the version they ran on.
"""

import hashlib
import json
import os
import re
import secrets
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

ENG_DIR = Path(os.environ.get("ENG_DIR", "/eng"))
JOBS_DIR = Path(os.environ.get("JOBS_DIR", "/jobs"))
SIM_DIR = Path(os.environ.get("SIM_DIR", "/sim"))
BLENDER_CMD = [os.environ.get("BLENDER", "blender")]
ID_RE = re.compile(r"^[a-z][a-z0-9-]{5,63}$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.()+-]{0,120}$")


class EngError(Exception):
    """An error the routes answer with its HTTP status"""

    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix):
    return f"{prefix}-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{secrets.token_hex(2)}"


def write_json(path, data):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=plain), encoding="utf-8")
    tmp.replace(path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def plain(value):
    """NumPy numbers for json"""
    return value.item() if hasattr(value, "item") else str(value)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def resolve_input(name):
    """A file the worker may read: jobs/<job id>/…, sim/files/… or eng/uploads/…"""
    if not isinstance(name, str) or not name:
        raise EngError(400, "BAD_FILE", "Cần đường dẫn file.")
    name = name.replace("\\", "/").lstrip("/")
    head, _, rest = name.partition("/")
    roots = {"jobs": JOBS_DIR, "sim": SIM_DIR, "eng": ENG_DIR}
    if head not in roots or not rest or (head == "sim" and not rest.startswith("files/")) or (
            head == "eng" and not rest.startswith("uploads/")):
        raise EngError(400, "BAD_FILE", f"Đường dẫn {name!r} phải là jobs/<job id>/…, sim/files/… hoặc eng/uploads/….")
    root = roots[head].resolve()
    path = (root / rest).resolve()
    if root not in path.parents:
        raise EngError(400, "BAD_FILE", f"Đường dẫn {name!r} ra ngoài vùng dữ liệu cho phép.")
    if not path.is_file():
        raise EngError(404, "FILE_NOT_FOUND", f"Không có file {name!r}.")
    return path


def save_upload(filename, data):
    """Bytes sent by the MCP server: stored under uploads/ with a unique prefix; returns the eng/uploads/… name"""
    base = Path(str(filename or "")).name
    if not NAME_RE.match(base):
        raise EngError(400, "BAD_FILE", f"Tên file không hợp lệ: {filename!r}.")
    folder = ENG_DIR / "uploads"
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{secrets.token_hex(4)}-{base}"
    (folder / name).write_bytes(data)
    return f"eng/uploads/{name}"


def model_dir(model_id, version=None):
    if not ID_RE.match(model_id or ""):
        raise EngError(400, "BAD_ID", "Mã mô hình không hợp lệ.")
    root = ENG_DIR / "models" / model_id
    versions = sorted((int(p.name[1:]) for p in root.glob("v*") if p.name[1:].isdigit()), reverse=True)
    if not versions:
        raise EngError(404, "MODEL_NOT_FOUND", f"Không có mô hình {model_id}.")
    v = versions[0] if version is None else int(version)
    if v not in versions:
        raise EngError(404, "VERSION_NOT_FOUND", f"Mô hình {model_id} không có phiên bản {v} (có: {versions}).")
    return root / f"v{v}"


def new_version_dir(model_id):
    root = ENG_DIR / "models" / model_id
    root.mkdir(parents=True, exist_ok=True)
    versions = [int(p.name[1:]) for p in root.glob("v*") if p.name[1:].isdigit()]
    v = max(versions, default=0) + 1
    folder = root / f"v{v}"
    (folder / "source").mkdir(parents=True)
    (folder / "components").mkdir()
    return folder, v


def load_model(model_id, version=None):
    folder = model_dir(model_id, version)
    model = read_json(folder / "model.json")
    if model is None:
        raise EngError(500, "MODEL_BROKEN", f"model.json của {model_id} không đọc được.")
    model["_dir"] = str(folder)
    return model


def list_models(limit=50):
    out = []
    root = ENG_DIR / "models"
    for folder in sorted(root.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit] if root.exists() else []:
        try:
            m = load_model(folder.name)
        except EngError:
            continue
        out.append({k: m.get(k) for k in ("model_id", "version", "name", "created_at", "units")} |
                   {"components": len(m.get("components", []))})
    return out


def new_analysis(kind):
    analysis_id = new_id("a")
    folder = ENG_DIR / "analyses" / analysis_id
    folder.mkdir(parents=True)
    return analysis_id, folder


def analysis_dir(analysis_id):
    if not ID_RE.match(analysis_id or ""):
        raise EngError(400, "BAD_ID", "Mã phân tích không hợp lệ.")
    folder = ENG_DIR / "analyses" / analysis_id
    if not (folder / "result.json").is_file():
        raise EngError(404, "ANALYSIS_NOT_FOUND", f"Không có phân tích {analysis_id}.")
    return folder


def load_analysis(analysis_id):
    return read_json(analysis_dir(analysis_id) / "result.json")


def list_analyses(model_id=None, kind=None, limit=100):
    root = ENG_DIR / "analyses"
    out = []
    for folder in sorted(root.glob("a-*"), key=lambda p: p.name, reverse=True) if root.exists() else []:
        r = read_json(folder / "result.json")
        if not r or (model_id and r.get("model_id") != model_id) or (kind and r.get("kind") != kind):
            continue
        out.append({k: r.get(k) for k in ("analysis_id", "kind", "model_id", "model_version", "status", "state",
                                          "started_at", "finished_at")})
        if len(out) >= limit:
            break
    return out


def copy_source(path, folder):
    target = folder / "source" / Path(path).name
    if target.exists():
        target = folder / "source" / f"{secrets.token_hex(2)}-{Path(path).name}"
    shutil.copy2(path, target)
    return target
