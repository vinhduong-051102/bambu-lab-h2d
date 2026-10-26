"""
Mesh worker (docs/cad.md, "Nhân vật"): organic models (characters, figures, decorations) with Tencent's
Hunyuan3D-2 on the GPU, made printable. Runs in the mesh3d container next to the gateway, which calls it over
HTTP. Jobs share CAD_JOBS_DIR with the CAD worker: the gateway writes job.json and, for a picture the user
uploaded, input.png; this worker writes concept.png, out/ (model.stl, preview.png, report.json) and status.json.

  GET  /health                 {"ok": true, "claude": <token set>, "running": [queued and running job ids],
                                "loaded": <shape model in GPU memory>}
  POST /jobs/<id>/generate     {"prompt", "height_mm", "base", "seed"}: queued; one job at a time on the GPU
  POST /jobs/<id>/fix          {"parent_id", "model"}: Claude reviews and fixes that figure in this job (review.py),
                               at once: it needs no GPU
  POST /jobs/<id>/cancel       Drops a queued job, or stops a running one at its next step (or a review)

A job without input.png starts from its prompt: Claude (claude -p) turns the user's words into an English
picture brief, HunyuanDiT draws it, and the shape comes from that picture.

status.json follows the job: "step" (queued, loading, prompting, loading_image, imaging, background, shaping,
repairing, loading_paint, painting, colouring, checking), "progress" ({done, total, unit} within the step: download MB, denoising steps), "steps"
(every step so far: {id, started_at, finished_at, detail}), "notes" ("• " lines: the picture brief, what the
repair changed) and "input" ("image" or "prompt", so the dashboard knows which steps are ahead).
"""

import fnmatch
import gc
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

JOBS_DIR = Path(os.environ.get("JOBS_DIR", "/jobs"))
PORT = int(os.environ.get("PORT", "8000"))
SHAPE_REPO = os.environ.get("MESH_SHAPE_REPO", "tencent/Hunyuan3D-2mini")
SHAPE_SUBFOLDER = os.environ.get("MESH_SHAPE_SUBFOLDER", "hunyuan3d-dit-v2-mini-turbo")
IMAGE_REPO = os.environ.get("MESH_IMAGE_REPO", "Tencent-Hunyuan/HunyuanDiT-v1.1-Diffusers-Distilled")
PROMPT_MODEL = os.environ.get("MESH_PROMPT_MODEL") or "claude-haiku-5-5"
# Models leave the GPU after this long without a job, so Studio and games get the memory back
IDLE_UNLOAD_S = int(os.environ.get("MESH_IDLE_UNLOAD_S", "600"))
# Faces kept from Hunyuan's mesh (it makes ~650k): enough detail for a figure, light enough for the slicer
MAX_FACES = int(os.environ.get("MESH_MAX_FACES", "200000"))
PREVIEW_FACES = 40000
PAINT_REPO = os.environ.get("MESH_PAINT_REPO", "tencent/Hunyuan3D-2")
PAINT_SUBFOLDER = os.environ.get("MESH_PAINT_SUBFOLDER", "hunyuan3d-paint-v2-0-turbo")
# Hunyuan3D-Paint unwraps UVs and renders every face from many views: it gets a lighter copy of the shape, whose
# colours then go onto the printable mesh
PAINT_FACES = 40000
JOB_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{5,63}$")

# The CAD worker's preview renderer, so both kinds of models look the same on the dashboard
sys.path.insert(0, os.environ.get("CAD_DIR", "/opt/cad"))

import review  # noqa: E402 - Claude's review of a finished figure

PROMPT_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "Tên ngắn của mô hình bằng tiếng Việt, vài từ"},
        "image_prompt": {"type": "string", "description": "The English picture brief, under 60 words"},
    },
    "required": ["title", "image_prompt"],
    "additionalProperties": False,
}

PROMPT_SYSTEM = """You write the picture brief for a text-to-image model whose picture is then turned into a 3D model
and printed in one colour on a 3D printer. From the user's request (often in Vietnamese), write one English brief,
under 60 words, for exactly one subject:
- the whole subject in view, centred, front three-quarter view, standing or sitting in a stable pose;
- a smooth clay or vinyl-figure look, solid compact forms, no thin loose parts (no wires, thin weapons, loose hair
  strands, fingers spread apart), no transparent or glowing parts;
- plain white background, soft even studio lighting, no ground, no shadow, no text, no frame.
Keep what the user asked for (character, clothes, props, expression, style). Also give a short Vietnamese title."""

IMAGE_SUFFIX = ", 3D render, clay figure, full body, centered, plain white background, best quality"
# HunyuanDiT's own negative prompt (it reads Chinese best): text, close-up, cropping, worst quality, extra or
# missing limbs, malformed hands and faces
IMAGE_NEGATIVE = (
    "文本,特写,裁剪,出框,最差质量,低质量,JPEG伪影,PGLY,重复,病态,残缺,多余的手指,变异的手,画得不好的手,画得不好的脸,"
    "变异,畸形,模糊,脱水,糟糕的解剖学,糟糕的比例,多余的肢体,克隆的脸,毁容,恶心的比例,畸形的肢体,缺失的手臂,缺失的腿,"
    "额外的手臂,额外的腿,融合的手指,手指太多,长脖子"
)


class Cancelled(Exception):
    pass


class Tracker:
    """A job's status.json as it goes: the current step and its progress, and every step so far with its times"""

    def __init__(self, job_id, status):
        self.job_id = job_id
        self.path = JOBS_DIR / job_id / "status.json"
        self.status = status
        status.setdefault("steps", [])
        status.setdefault("notes", [])
        self.written = 0.0

    def check(self):
        if self.job_id in cancelled:
            raise Cancelled()

    def step(self, name, detail=None, total=None, unit=None):
        self.check()
        self.close()
        self.status["steps"].append({"id": name, "started_at": now(), "finished_at": None, "detail": detail})
        self.status["step"] = name
        self.status["progress"] = {"done": 0, "total": total, "unit": unit} if total else None
        self.write(force=True)

    def progress(self, done, total=None, unit=None, detail=None):
        """Called from the models' own loops too: a cancelled job stops there, at its next denoising step"""
        self.check()
        progress = self.status.get("progress") or {}
        progress.update(done=done, total=total or progress.get("total"), unit=unit or progress.get("unit"))
        self.status["progress"] = progress
        if detail is not None:
            self.status["steps"][-1]["detail"] = detail
        self.write()

    def detail(self, text):
        self.status["steps"][-1]["detail"] = text
        self.write(force=True)

    def note(self, text):
        self.status["notes"].append(f"• {text}")
        self.write(force=True)

    def close(self):
        steps = self.status["steps"]
        if steps and steps[-1].get("finished_at") is None:
            steps[-1]["finished_at"] = now()
        self.status["progress"] = None

    def write(self, force=False):
        # Denoising callbacks come several times a second; the dashboard polls every few seconds
        if force or time.monotonic() - self.written > 0.5:
            write_json(self.path, self.status)
            self.written = time.monotonic()


def cache_dir(repo):
    return Path(os.environ.get("HF_HOME", "/models")) / "hub" / ("models--" + repo.replace("/", "--"))


class DownloadWatch:
    """While a model loads, shows how much of its weights has downloaded (only when it is downloading)"""

    def __init__(self, tracker, repo, patterns=None):
        self.tracker, self.repo, self.patterns = tracker, repo, patterns
        self.done = threading.Event()
        self.downloaded_mb = None

    def __enter__(self):
        threading.Thread(target=self.watch, daemon=True).start()
        return self

    def __exit__(self, exc_type, *_exc):
        self.done.set()
        # The finished step says what it did, not what it was doing
        if exc_type is None and self.downloaded_mb:
            self.tracker.detail(f"Đã tải {fmt(self.downloaded_mb)} MB (chỉ lần đầu) rồi nạp vào bộ nhớ")

    def watch(self):
        try:
            from huggingface_hub import HfApi

            siblings = HfApi().model_info(self.repo, files_metadata=True).siblings
        except Exception:  # noqa: BLE001 - offline or rate limited: no total to show progress against
            return
        # The weight files (LFS), by the sha256 the cache names their blobs after
        if self.patterns:
            # Only the parts of the repository the model downloads (Hunyuan3D-2 holds several models)
            siblings = [s for s in siblings if any(fnmatch.fnmatch(s.rfilename, p) for p in self.patterns)]
        files = {s.lfs.sha256: s.size for s in siblings if s.lfs and s.size}
        total = sum(files.values())
        blobs = cache_dir(self.repo) / "blobs"
        last = downloaded(blobs, files)
        if not total or last >= total:
            return  # nothing to download: the model only loads
        while not self.done.wait(2):
            have = downloaded(blobs, files)
            if have == last:
                continue
            last = have
            self.downloaded_mb = round(total / 1e6)
            try:
                self.tracker.progress(round(have / 1e6), round(total / 1e6), "MB",
                                      detail="Đang tải trọng số model lần đầu (chỉ một lần)")
            except Cancelled:
                return


def downloaded(blobs, files):
    """Bytes of a model's weight files on disk: a finished blob counts whole, one being written by its
    .incomplete file, never more than the file's size. Partial files left by an interrupted download don't count
    twice, and other models' files not at all."""
    total = 0
    for sha, size in files.items():
        if (blobs / sha).exists():
            total += size
            continue
        partial = [p.stat().st_size for p in blobs.glob(f"{sha}*.incomplete")]
        total += min(size, max(partial, default=0))
    return total


lock = threading.Lock()
jobs = queue.Queue()
pending = []  # queued and running job ids, in order
cancelled = set()
models = {"shape": None, "image": None, "rembg": None, "paint": None}
last_used = time.monotonic()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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


# ---------- Models ----------

def shape_model():
    if models["shape"] is None:
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

        pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
            SHAPE_REPO, subfolder=SHAPE_SUBFOLDER, use_safetensors=True, device="cuda")
        if "turbo" in SHAPE_SUBFOLDER:
            pipe.enable_flashvdm()
        models["shape"] = pipe
    return models["shape"]


def image_model():
    if models["image"] is None:
        import torch
        from diffusers import AutoPipelineForText2Image

        pipe = AutoPipelineForText2Image.from_pretrained(
            IMAGE_REPO, torch_dtype=torch.float16, enable_pag=True, pag_applied_layers=["blocks.(16|17|18|19)"])
        # Parts move to the GPU only while they run: HunyuanDiT's text encoders alone take ~6 GB in fp16
        pipe.enable_model_cpu_offload()
        models["image"] = pipe
    return models["image"]


def paint_model():
    if models["paint"] is None:
        from hy3dgen.texgen import Hunyuan3DPaintPipeline

        models["paint"] = Hunyuan3DPaintPipeline.from_pretrained(PAINT_REPO, subfolder=PAINT_SUBFOLDER)
    return models["paint"]


def background_remover():
    if models["rembg"] is None:
        from hy3dgen.rembg import BackgroundRemover

        models["rembg"] = BackgroundRemover()
    return models["rembg"]


def unload_models():
    import torch

    for key in models:
        models[key] = None
    gc.collect()
    torch.cuda.empty_cache()


def idle_unloader():
    while True:
        time.sleep(30)
        with lock:
            idle = not pending and time.monotonic() - last_used > IDLE_UNLOAD_S
        if idle and (models["shape"] is not None or models["image"] is not None):
            unload_models()
            print("[mesh-worker] models unloaded after idle", flush=True)


# ---------- One job ----------

def write_prompt(text):
    """Claude's English picture brief and Vietnamese title for the user's request"""
    if not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        raise RuntimeError("Container mesh3d chưa có CLAUDE_CODE_OAUTH_TOKEN để viết prompt ảnh từ mô tả.")
    proc = subprocess.run(
        ["claude", "-p", "--model", PROMPT_MODEL, "--tools", "", "--setting-sources", "", "--no-session-persistence",
         "--system-prompt", PROMPT_SYSTEM, "--json-schema", json.dumps(PROMPT_SCHEMA), "--output-format", "json"],
        input=text, capture_output=True, text=True, encoding="utf-8", timeout=180, check=False)
    try:
        result = json.loads(proc.stdout)
    except ValueError:
        result = {}
    output = result.get("structured_output")
    if not output:
        detail = result.get("result") or proc.stderr.strip()[-400:] or f"mã {proc.returncode}"
        if "limit" in detail.lower():
            raise RuntimeError(f"Đã hết lượt dùng Claude của gói hiện tại, thử lại sau. ({detail})")
        raise RuntimeError(f"Claude không viết được prompt ảnh: {detail}")
    return output


def fmt(n):
    """1234567 → "1.234.567", as Vietnamese writes numbers"""
    return f"{n:,}".replace(",", ".")


def to_printable(mesh, height_mm, base, track):
    """Hunyuan's mesh (Y up, about 2 units tall) → millimetres, Z up, standing on Z = 0, repaired"""
    import numpy as np
    import pymeshlab
    import trimesh

    warnings = []
    # Y up → Z up; the subject's front, which faced the camera (+Z), then faces −Y like the preview's front view
    turn = trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0])
    mesh.apply_transform(turn)

    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(mesh.vertices, mesh.faces))
    track.detail("Gộp đỉnh trùng, bỏ mặt trùng và mặt suy biến")
    ms.meshing_remove_duplicate_vertices()
    ms.meshing_remove_duplicate_faces()
    ms.meshing_remove_null_faces()
    # Floating specks the model sometimes leaves around the subject
    track.detail("Bỏ các mảnh vụn trôi nổi quanh nhân vật")
    before = ms.current_mesh().face_number()
    ms.meshing_remove_connected_component_by_diameter(mincomponentdiag=pymeshlab.PercentageValue(5))
    specks = before - ms.current_mesh().face_number()
    if specks:
        track.note(f"Bỏ {fmt(specks)} mặt của mảnh vụn trôi nổi")
    if ms.current_mesh().face_number() > MAX_FACES:
        before = ms.current_mesh().face_number()
        track.detail(f"Giảm số mặt từ {fmt(before)} xuống {fmt(MAX_FACES)}")
        ms.meshing_decimation_quadric_edge_collapse(targetfacenum=MAX_FACES, preservenormal=True, planarquadric=True)
        track.note(f"Giảm {fmt(before)} → {fmt(ms.current_mesh().face_number())} mặt cho slicer nhẹ hơn")
    track.detail("Sửa cạnh và đỉnh lỗi (non-manifold), vá lỗ hở")
    ms.meshing_repair_non_manifold_edges()
    ms.meshing_repair_non_manifold_vertices()
    before = ms.current_mesh().face_number()
    ms.meshing_close_holes(maxholesize=200)
    patched = ms.current_mesh().face_number() - before
    if patched > 0:
        track.note(f"Vá lỗ hở bằng {fmt(patched)} mặt")
    ms.meshing_re_orient_faces_coherently()
    current = ms.current_mesh()
    mesh = trimesh.Trimesh(current.vertex_matrix(), current.face_matrix(), process=True)
    if mesh.is_watertight and mesh.volume < 0:
        mesh.invert()

    track.detail(f"Đưa về chiều cao {height_mm:g} mm, đặt sát mặt bàn in")
    lo, hi = mesh.bounds
    scale = height_mm / (hi[2] - lo[2])
    mesh.apply_scale(scale)
    lo, hi = mesh.bounds
    shift = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]]
    mesh.apply_translation(shift)
    plinth_faces = 0

    if base:
        # A round plinth under the figure, overlapping it by 0.6 mm: the slicer joins overlapping shells, so the
        # two need no boolean union (which Hunyuan's meshes, not always watertight, would break)
        lo, hi = mesh.bounds
        thickness = max(2.0, height_mm * 0.04)
        radius = max(hi[0] - lo[0], hi[1] - lo[1]) * 0.6
        plinth = trimesh.creation.cylinder(radius=radius, height=thickness, sections=96)
        plinth.apply_translation([0, 0, thickness / 2])
        mesh.apply_translation([0, 0, thickness - 0.6])
        shift[2] += thickness - 0.6
        plinth_faces = len(plinth.faces)
        mesh = trimesh.util.concatenate([plinth, mesh])
        track.note(f"Thêm đế tròn Ø{radius * 2:.0f} mm, dày {thickness:.1f} mm")
    else:
        # Without a plinth the figure stands on what touches the plate: warn when that is very little
        footprint = mesh.vertices[mesh.vertices[:, 2] < 0.5]
        if len(footprint) < 3 or np.ptp(footprint[:, 0]) * np.ptp(footprint[:, 1]) < (height_mm * 0.12) ** 2:
            warnings.append("Chỗ chạm bàn in rất nhỏ: nên thêm đế hoặc dùng brim/support để mô hình không đổ.")

    if height_mm < 40:
        warnings.append("Mô hình nhỏ (dưới 40 mm): chi tiết như ngón tay, tóc có thể mất khi in với đầu 0.4 mm.")
    # Raw (Hunyuan) coordinates → the printable mesh's, for the texture that was painted on the raw shape
    transform = trimesh.transformations.translation_matrix(shift) @ trimesh.transformations.scale_matrix(scale) @ turn
    return mesh, warnings, transform, plinth_faces


def paint_figure(track, raw, image, mesh, transform, plinth_faces, colour):
    """Hunyuan3D-Paint's texture on a light copy of the raw shape, then each printable face's colour, cut down to
    the filaments: `colour` is {"count": 2–8} or {"palette": [{"hex", "label"}]} (the AMS). Returns (labels per
    face, palette sRGB, palette labels, face colours for the preview)."""
    import numpy as np
    import colors
    from hy3dgen.shapegen import FaceReducer

    if models["paint"] is None:
        track.step("loading_paint", detail="Nạp Hunyuan3D-Paint (model tô màu) vào bộ nhớ")
        # The paint pipeline only downloads its own two parts of the Hunyuan3D-2 repository
        with DownloadWatch(track, PAINT_REPO, ["hunyuan3d-delight-v2-0/*", f"{PAINT_SUBFOLDER}/*"]):
            paint_model()
    track.step("painting", detail=f"Hunyuan3D-Paint tô texture theo ảnh (lưới {fmt(PAINT_FACES)} mặt)")
    light = FaceReducer()(raw.copy(), max_facenum=PAINT_FACES)
    textured = paint_model()(light, image=image)
    textured.apply_transform(transform)

    track.step("colouring", detail="Lấy màu texture cho từng mặt, gom về số filament")
    figure = mesh.submesh([np.arange(plinth_faces, len(mesh.faces))], append=True) if plinth_faces else mesh
    rgb = colors.face_colours(figure, textured)
    palette_labels = None
    palette_origins = None
    if colour.get("palette"):
        entries = colour["palette"]
        palette = [colors.hex_to_rgb(e["hex"]) for e in entries]
        palette_labels = [e.get("label") or e["hex"] for e in entries]
        palette_origins = ["ams"] * len(entries)
        labels, palette = colors.quantize(rgb, figure.area_faces, palette=palette)
        track.note(f"Dùng {len(palette)} màu đang nạp trong AMS")
    else:
        labels, palette = colors.quantize(rgb, figure.area_faces, count=int(colour.get("count") or 4))
        if colour.get("snap"):
            # Filaments to choose from: Bambu's own colours, the user's, or (with tiers) what the AMS holds first,
            # then the user's, then Bambu's to buy
            choices = colour["snap"]
            tiers = [c["tier"] for c in choices] if all("tier" in c for c in choices) else None
            labels, palette, picked = colors.snap(labels, palette, figure.area_faces,
                                                  [colors.hex_to_rgb(c["hex"]) for c in choices], tiers=tiers)
            palette_labels = [choices[i]["label"] for i in picked]
            palette_origins = [choices[i].get("origin") for i in picked]
            track.note("Filament: " + ", ".join(palette_labels))
    labels = colors.clean_islands(figure, labels)
    # Each filament against the texture colour it stands for (area-weighted over its faces): how far off it prints
    sources = []
    for i in range(len(palette)):
        mine = labels == i
        sources.append(np.average(rgb[mine], axis=0, weights=figure.area_faces[mine]) if np.any(mine) else palette[i])
    deltas = np.sqrt(((colors.srgb_to_lab(np.asarray(sources)) - colors.srgb_to_lab(np.asarray(palette, dtype=float))) ** 2).sum(-1))
    if plinth_faces:
        # The plinth takes the figure's main colour, which is filament 1 unless the AMS decides
        main = np.bincount(labels, weights=figure.area_faces, minlength=len(palette)).argmax()
        labels = np.concatenate([np.full(plinth_faces, main), labels])
        rgb = np.concatenate([np.tile(palette[main], (plinth_faces, 1)), rgb])
    shares = np.bincount(labels, weights=mesh.area_faces, minlength=len(palette)) / mesh.area.sum()
    used = [i for i in range(len(palette)) if shares[i] > 0]
    track.note("Gom còn " + ", ".join(f"{colors.rgb_to_hex(palette[i])} {shares[i] * 100:.0f}%" for i in used))
    return labels, np.asarray(palette), palette_labels, shares, rgb, np.asarray(sources), deltas, palette_origins


def run_job(job_id, params):
    global last_used
    import numpy as np
    import torch
    from PIL import Image

    directory = JOBS_DIR / job_id
    status = read_json(directory / "status.json", {})
    status.update(state="running", started_at=now())
    status.pop("queue_position", None)
    track = Tracker(job_id, status)
    with lock:
        last_used = time.monotonic()

    meta = read_json(directory / "job.json", {})
    prompt = (params.get("prompt") or meta.get("prompt") or "").strip()
    height_mm = float(params.get("height_mm") or 80)
    seed = int(params.get("seed") or 0)
    result = {"title": meta.get("title") or "", "summary": "", "assumptions": [], "parameters": [], "warnings": []}

    if models["shape"] is None:
        # The first job after start or an idle unload: ~2 minutes, shown as its own step
        track.step("loading", detail=f"Nạp {SHAPE_REPO.split('/')[-1]} ({SHAPE_SUBFOLDER}) vào GPU")
        with DownloadWatch(track, SHAPE_REPO):
            shape_model()

    input_path = directory / "input.png"
    if input_path.exists():
        image = Image.open(input_path)
        track.note(f"Ảnh tải lên: {image.width} × {image.height} px")
        result["summary"] = "Dựng từ ảnh bạn tải lên bằng Hunyuan3D-2."
    else:
        track.step("prompting", detail=f"{PROMPT_MODEL} viết prompt ảnh tiếng Anh từ mô tả")
        brief = write_prompt(prompt)
        result["title"] = brief["title"]
        track.note(f"Prompt ảnh: {brief['image_prompt']}")
        if models["image"] is None:
            track.step("loading_image", detail="Nạp HunyuanDiT (model vẽ ảnh) vào bộ nhớ")
            with DownloadWatch(track, IMAGE_REPO):
                image_model()
        steps = 25
        track.step("imaging", detail="HunyuanDiT vẽ ảnh 1024 × 1024", total=steps, unit="bước")

        def on_image_step(_pipe, i, _t, kwargs):
            track.progress(i + 1, steps)
            return kwargs

        generator = torch.Generator(device="cpu").manual_seed(seed)
        image = image_model()(
            prompt=brief["image_prompt"] + IMAGE_SUFFIX, negative_prompt=IMAGE_NEGATIVE, num_inference_steps=steps,
            pag_scale=1.3, width=1024, height=1024, generator=generator, callback_on_step_end=on_image_step,
            return_dict=False)[0][0]
        image.save(directory / "concept.png")
        result["summary"] = "Claude viết prompt ảnh, HunyuanDiT vẽ ảnh, Hunyuan3D-2 dựng hình 3D từ ảnh đó."
        result["assumptions"].append(f"Prompt ảnh: {brief['image_prompt']}")

    track.step("background", detail="Tách nhân vật khỏi nền (rembg)")
    if image.mode != "RGBA" or np.asarray(image)[..., 3].min() == 255:
        image = background_remover()(image.convert("RGB"))
    else:
        track.detail("Ảnh đã có nền trong suốt: giữ nguyên")
    if not input_path.exists():
        image.save(directory / "concept.png")

    steps = 5 if "turbo" in SHAPE_SUBFOLDER else 30
    track.step("shaping", detail="Hunyuan3D-2 dựng trường thể tích từ ảnh", total=steps, unit="bước")

    def on_shape_step(step_idx, _t, _outputs):
        done = step_idx + 1
        # After the last denoising step the pipeline still turns the volume into a surface (marching cubes)
        track.progress(done, steps, detail="Đang trích bề mặt từ trường thể tích" if done >= steps else None)

    mesh = shape_model()(image=image, num_inference_steps=steps, octree_resolution=380, num_chunks=20000,
                         generator=torch.manual_seed(seed), callback=on_shape_step, callback_steps=1,
                         output_type="trimesh")[0]
    track.detail(f"{steps} bước khử nhiễu rồi trích bề mặt")
    track.note(f"Lưới thô: {fmt(len(mesh.faces))} mặt, {fmt(len(mesh.vertices))} đỉnh")
    raw = mesh.copy()
    colour = params.get("colour") or None

    track.step("repairing", detail="Xoay, sửa lưới và chỉnh kích thước")
    mesh, warnings, transform, plinth_faces = to_printable(mesh, height_mm, bool(params.get("base")), track)
    track.detail(f"Xoay đứng, sửa lưới, cao {height_mm:g} mm, đặt sát bàn in" + (", thêm đế" if params.get("base") else ""))
    out = directory / "out"
    out.mkdir(exist_ok=True)
    mesh.export(out / "model.stl")
    painted = None
    if colour:
        import colors

        labels, palette, palette_labels, shares, face_rgb, sources, deltas, origins = paint_figure(
            track, raw, image, mesh, transform, plinth_faces, colour)
        name = result["title"] or prompt[:60] or "figure"
        colors.write_3mf(out / "model.3mf", mesh, labels, palette, name=name)
        painted = {
            "face_rgb": palette[labels],
            "request": colour.get("request"),
            "palette": [{"slot": i + 1, "hex": colors.rgb_to_hex(rgb), "label": palette_labels[i] if palette_labels else None,
                         "share": round(float(shares[i]), 4), "source_hex": colors.rgb_to_hex(sources[i]),
                         "delta_e": round(float(deltas[i]), 1),
                         # Where the filament comes from: ams (loaded), custom (the user's), bambu (to buy)
                         "origin": origins[i] if origins else None} for i, rgb in enumerate(palette)],
        }
        # A filament far from the colour it stands for (ΔE over 12 is plainly another colour) on a visible share
        for i, entry in enumerate(painted["palette"]):
            if entry["delta_e"] > 12 and entry["share"] >= 0.01:
                warnings.append(f"Màu {entry['source_hex']} của mô hình không có trong bộ màu đã chọn: in bằng "
                                f"{entry['label'] or entry['hex']} sẽ lệch rõ (ΔE {entry['delta_e']:.0f}). "
                                "Xem gợi ý trộn màu, hoặc chọn bộ màu rộng hơn.")
        materials = {e.get("material") for e in (colour.get("palette") or []) if e.get("material")}
        if len(materials) > 1:
            warnings.append(f"Các khay AMS đang dùng nhiều loại nhựa ({', '.join(sorted(materials))}): in chung một mô hình "
                            "thường bám lớp kém, nên dùng cùng một loại.")
    track.step("checking", detail="Kiểm tra lưới kín và vẽ ảnh xem trước")
    report = mesh_report(mesh, warnings, out, painted)
    write_json(out / "report.json", report)
    track.note("Lưới kín, in được" if report["mesh"]["watertight"] else "Lưới còn lỗi: gateway sửa thêm khi gửi sang Studio")

    result["title"] = result["title"] or prompt[:60] or "Mô hình từ ảnh"
    # "Tạo lại" on the dashboard reads height_mm and base back from here
    base = bool(params.get("base"))
    result["parameters"] = [
        {"name": "height_mm", "value": height_mm, "description": "Chiều cao nhân vật, chưa tính đế (mm)"},
        {"name": "base", "value": int(base), "description": "Có đế tròn (1) hay không (0)"},
        {"name": "seed", "value": seed, "description": "Số ngẫu nhiên: đổi để ra hình khác"},
        {"name": "colours", "value": len(colour["palette"]) if colour and colour.get("palette") else int((colour or {}).get("count") or 0),
         "description": "Số màu (0: không tô màu)"},
    ]
    track.check()
    track.close()
    status.update(state="done", step=None, finished_at=now(), result=result, report=report, error=None)
    write_json(directory / "status.json", status)
    with lock:
        last_used = time.monotonic()


def mesh_report(mesh, warnings, out, painted=None):
    import build  # cad/build.py

    triangles = mesh.triangles.tolist()
    check = build.mesh_check(triangles)
    if not check["watertight"]:
        warnings.append(f"Lưới chưa kín hẳn ({check['open_edges']} cạnh hở, {check['non_manifold_edges']} cạnh lỗi): "
                        "gateway sẽ sửa thêm khi gửi sang Studio.")
    preview = mesh
    if len(mesh.faces) > PREVIEW_FACES:
        import pymeshlab
        import trimesh

        ms = pymeshlab.MeshSet()
        ms.add_mesh(pymeshlab.Mesh(mesh.vertices, mesh.faces))
        ms.meshing_decimation_quadric_edge_collapse(targetfacenum=PREVIEW_FACES)
        preview = trimesh.Trimesh(ms.current_mesh().vertex_matrix(), ms.current_mesh().face_matrix())
    preview_rgb = None
    if painted is not None:
        import trimesh

        # The lighter preview mesh takes the filament of the printable face nearest each of its faces
        _closest, _dist, tri = trimesh.proximity.closest_point(mesh, preview.triangles_center)
        preview_rgb = painted["face_rgb"][tri]
    size = mesh.extents
    build.render_preview(preview.triangles.tolist(), size, out / "preview.png", preview_rgb)
    lo, hi = mesh.bounds
    return {
        "ok": True,
        "size_mm": [round(float(v), 2) for v in size],
        "min_mm": [round(float(v), 2) for v in lo],
        "max_mm": [round(float(v), 2) for v in hi],
        "volume_cm3": round(float(abs(mesh.volume)) / 1000, 3) if check["watertight"] else None,
        "solids": int(mesh.body_count),
        "mesh": check,
        "warnings": warnings,
        "files": ["model.stl", "preview.png"] + (["model.3mf"] if painted else []),
        "palette": painted["palette"] if painted else None,
        "colour_request": painted.get("request") if painted else None,
    }


def gpu_loop():
    while True:
        job_id, params = jobs.get()
        directory = JOBS_DIR / job_id
        try:
            if job_id in cancelled:
                raise Cancelled()
            run_job(job_id, params)
        except Cancelled:
            status = read_json(directory / "status.json", {})
            status.update(state="cancelled", error="Đã hủy.", finished_at=now())
            write_json(directory / "status.json", status)
            continue
        except Exception as err:  # noqa: BLE001 - whatever went wrong belongs in the job's status
            traceback.print_exc()
            status = read_json(directory / "status.json", {})
            message = str(err) if isinstance(err, RuntimeError) else f"{type(err).__name__}: {err}"
            if "out of memory" in message.lower():
                message = "GPU hết bộ nhớ: đóng bớt ứng dụng dùng GPU (game, Studio) rồi thử lại."
            status.update(state="failed", error=message, finished_at=now())
            write_json(directory / "status.json", status)
            continue
        finally:
            # Only after the final status is written: the gateway shows a running job the worker no longer
            # lists as interrupted
            with lock:
                if job_id in pending:
                    pending.remove(job_id)
                cancelled.discard(job_id)


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
            with lock:
                ids = list(pending)
            return self.reply(200, {"ok": True, "claude": bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")),
                                    "running": ids + review.ids(), "loaded": models["shape"] is not None})
        self.reply(404, {"ok": False, "error": "NOT_FOUND"})

    def do_POST(self):
        match = re.fullmatch(r"/jobs/([^/]+)/(generate|fix|cancel)", self.path)
        if not match or not JOB_ID_RE.match(match.group(1)):
            return self.reply(404, {"ok": False, "error": "NOT_FOUND"})
        job_id, action = match.groups()
        directory = JOBS_DIR / job_id
        if not directory.is_dir():
            return self.reply(404, {"ok": False, "error": "JOB_NOT_FOUND", "message": "Không có thư mục của job."})
        body = self.body()

        if action == "generate":
            if not (directory / "input.png").exists() and not str(body.get("prompt") or "").strip():
                return self.reply(400, {"ok": False, "error": "NO_INPUT", "message": "Cần ảnh hoặc mô tả."})
            with lock:
                if job_id in pending:
                    return self.reply(409, {"ok": False, "error": "JOB_RUNNING", "message": "Job đang chạy."})
                pending.append(job_id)
                ahead = len(pending) - 1
            write_json(directory / "status.json", {
                "state": "running", "step": "queued", "notes": [], "builds": 0, "started_at": None,
                "finished_at": None, "error": None, "result": None, "report": None, "queue_position": ahead,
                "input": "image" if (directory / "input.png").exists() else "prompt", "progress": None,
                "colour": bool(body.get("colour")),
                "steps": [{"id": "queued", "started_at": now(), "finished_at": None,
                           "detail": f"{ahead} mô hình đang chờ trước" if ahead else None}]})
            jobs.put((job_id, body))
            return self.reply(202, {"ok": True, "queue_position": ahead})

        if action == "fix":
            if not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
                return self.reply(501, {"ok": False, "error": "AI_DISABLED",
                                        "message": "Container mesh3d chưa có CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)."})
            parent_id = str(body.get("parent_id") or "")
            if not JOB_ID_RE.match(parent_id) or not (JOBS_DIR / parent_id).is_dir():
                return self.reply(404, {"ok": False, "error": "JOB_NOT_FOUND", "message": "Không có mô hình cần sửa."})
            error = review.start(job_id, parent_id, str(body.get("model") or ""))
            if error:
                return self.reply(409, {"ok": False, "error": "FIX_NOT_STARTED", "message": error})
            return self.reply(202, {"ok": True})

        if review.cancel(job_id):
            return self.reply(200, {"ok": True})
        with lock:
            if job_id not in pending:
                return self.reply(409, {"ok": False, "error": "JOB_NOT_RUNNING", "message": "Job không còn chạy."})
            cancelled.add(job_id)
        status = read_json(directory / "status.json", {})
        status.update(state="cancelled", error="Đã hủy.")
        write_json(directory / "status.json", status)
        return self.reply(200, {"ok": True})


if __name__ == "__main__":
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=gpu_loop, daemon=True).start()
    threading.Thread(target=idle_unloader, daemon=True).start()
    print(f"[mesh-worker] listening on :{PORT}, jobs in {JOBS_DIR}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
