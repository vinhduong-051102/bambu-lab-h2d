"""
A figure from a picture (docs/cad.md, "Nhân vật"): Tencent's Hunyuan3D-2 turns the picture into a shape on the GPU,
then Claude fixes and paints it with the Blender tools (review.py). The GPU part runs here, one job at a time:

  queued → background (rembg) → [loading_views → viewing: MV-Adapter draws the other sides] → loading → shaping
  (Hunyuan3D-2mini from the picture, or Hunyuan3D-2mv from four sides) → repairing (Z up, millimetres, on the plate)

and leaves source/ (model.stl, preview.png, report.json: the figure as Hunyuan3D made it, which the dashboard shows
as "before"), sides.png (the sides it was shaped from) and, with colour, work/picture.npz (the picture's colours on
its faces, picture.py). review.start_finish() then hands it to Claude in the same job.

"Dựng nhiều góc" (multiview.py): the sides the user uploaded (views/left.png, back.png, right.png), or else those
MV-Adapter draws from the front picture.

generate(): MCP for Blender's generate_3d with its local Hunyuan3D-2 (the worker's POST /generate): one object
from a picture, or from an English prompt that HunyuanDiT draws first, as a GLB, on the same GPU queue.

status.json: "step", "progress" ({done, total, unit} within the step: download MB, denoising steps), "steps",
"notes" and "input": "image", "maker": "hunyuan", "views" (null, "drawn" or "uploaded") so the dashboard knows the
steps ahead.
"""

import fnmatch
import gc
import os
import queue
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import multiview
import review

JOBS_DIR = Path(os.environ.get("JOBS_DIR", "/jobs"))
SHAPE_REPO = os.environ.get("MESH_SHAPE_REPO", "tencent/Hunyuan3D-2mini")
SHAPE_SUBFOLDER = os.environ.get("MESH_SHAPE_SUBFOLDER", "hunyuan3d-dit-v2-mini-turbo")
IMAGE_REPO = os.environ.get("MESH_IMAGE_REPO", "Tencent-Hunyuan/HunyuanDiT-v1.1-Diffusers-Distilled")
IMAGE_SUFFIX = ", 3D render, clay figure, full body, centered, plain white background, best quality"
# HunyuanDiT's own negative prompt (it reads Chinese best): text, close-up, cropping, worst quality, extra or
# missing limbs, malformed hands and faces
IMAGE_NEGATIVE = (
    "文本,特写,裁剪,出框,最差质量,低质量,JPEG伪影,PGLY,重复,病态,残缺,多余的手指,变异的手,画得不好的手,画得不好的脸,"
    "变异,畸形,模糊,脱水,糟糕的解剖学,糟糕的比例,多余的肢体,克隆的脸,毁容,恶心的比例,畸形的肢体,缺失的手臂,缺失的腿,"
    "额外的手臂,额外的腿,融合的手指,手指太多,长脖子"
)
# What generate_3d gets: this tall, in millimetres (Claude scales it to the figure)
GENERATED_MM = 100.0
# "Dựng nhiều góc": Hunyuan3D-2 shaping from several views of the figure
MV_SHAPE_REPO = os.environ.get("MESH_MV_SHAPE_REPO", "tencent/Hunyuan3D-2mv")
MV_SHAPE_SUBFOLDER = os.environ.get("MESH_MV_SHAPE_SUBFOLDER", "hunyuan3d-dit-v2-mv-turbo")
# Models leave the GPU after this long without a job, so Studio and games get the memory back
IDLE_UNLOAD_S = int(os.environ.get("MESH_IDLE_UNLOAD_S", "600"))
# Faces kept from Hunyuan's mesh (it makes ~650k): enough detail for a figure, light enough for Claude's tools
MAX_FACES = int(os.environ.get("MESH_MAX_FACES", "200000"))
PREVIEW_FACES = 40000
SIDE_NAMES = {"left": "trái", "back": "sau", "right": "phải"}


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
            review.write_json(self.path, self.status)
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
pending = []  # queued and shaping job ids, in order
cancelled = set()
models = {"shape": None, "shape_mv": None, "views": None, "image": None, "rembg": None}
last_used = time.monotonic()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fmt(n):
    """1234567 → "1.234.567", as Vietnamese writes numbers"""
    return f"{n:,}".replace(",", ".")


# ---------- Models ----------

def shape_model(many=False):
    """Hunyuan3D-2mini from one picture, or (many) Hunyuan3D-2mv from several views; only one of them stays loaded"""
    key, repo, subfolder = ("shape_mv", MV_SHAPE_REPO, MV_SHAPE_SUBFOLDER) if many else ("shape", SHAPE_REPO, SHAPE_SUBFOLDER)
    if models[key] is None:
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

        free_gpu(keep={"rembg"})
        pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(repo, subfolder=subfolder, use_safetensors=True, device="cuda")
        if "turbo" in subfolder:
            pipe.enable_flashvdm()
        models[key] = pipe
    return models[key]


def views_model():
    """MV-Adapter: ~13.5 GB of GPU memory while it draws, so nothing else stays loaded but the background remover"""
    if models["views"] is None:
        free_gpu(keep={"rembg"})
        models["views"] = multiview.load()
    return models["views"]


def image_model():
    """HunyuanDiT, for generate_3d from a prompt: parts move to the GPU only while they run (its text encoders alone
    take ~6 GB in fp16)"""
    if models["image"] is None:
        import torch
        from diffusers import AutoPipelineForText2Image

        free_gpu(keep={"rembg", "shape"})
        pipe = AutoPipelineForText2Image.from_pretrained(
            IMAGE_REPO, torch_dtype=torch.float16, enable_pag=True, pag_applied_layers=["blocks.(16|17|18|19)"])
        pipe.enable_model_cpu_offload()
        models["image"] = pipe
    return models["image"]


def background_remover():
    if models["rembg"] is None:
        from hy3dgen.rembg import BackgroundRemover

        models["rembg"] = BackgroundRemover()
    return models["rembg"]


def free_gpu(keep=()):
    """Drops every model but those in `keep`, and gives their GPU memory back"""
    import torch

    dropped = False
    for key in models:
        if key not in keep and models[key] is not None:
            models[key] = None
            dropped = True
    if dropped:
        gc.collect()
        torch.cuda.empty_cache()


def loaded():
    return models["shape"] is not None or models["shape_mv"] is not None


def idle_unloader():
    while True:
        time.sleep(30)
        with lock:
            idle = not pending and time.monotonic() - last_used > IDLE_UNLOAD_S
        if idle and any(models[key] is not None for key in ("shape", "shape_mv", "views", "image")):
            free_gpu()
            print("[mesh-worker] models unloaded after idle", flush=True)


# ---------- One job ----------

def to_printable(mesh, height_mm, track):
    """Hunyuan's mesh (Y up, about 2 units tall) → millimetres, Z up, the front towards −Y, standing on Z = 0,
    repaired. The plinth, when asked for, is Claude's to add (it paints it and blends it in)."""
    import numpy as np
    import pymeshlab
    import trimesh

    # Y up → Z up; the subject's front, which faced the camera (+Z), then faces −Y like the preview's front view
    mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))

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
        track.note(f"Giảm {fmt(before)} → {fmt(ms.current_mesh().face_number())} mặt")
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
    mesh.apply_scale(height_mm / (hi[2] - lo[2]))
    lo, hi = mesh.bounds
    mesh.apply_translation([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]])
    return mesh


def figure_views(track, directory, image, seed, wanted, result):
    """The figure from four sides for Hunyuan3D-2mv ({"front", "left", "back", "right"}: background removed), or
    None to shape it from `image` alone: the sides uploaded with the picture (views/<side>.png), else when `wanted`
    the ones MV-Adapter draws from it. sides.png shows them on the dashboard."""
    uploaded = {side: directory / "views" / f"{side}.png" for side in multiview.SIDES}
    uploaded = {side: path for side, path in uploaded.items() if path.exists()}
    if not uploaded and not wanted:
        return None
    from PIL import Image

    views = {"front": image}
    if uploaded:
        track.step("background", detail=f"Tách nền ảnh các góc tải lên ({len(uploaded)} ảnh)")
        for side, path in uploaded.items():
            views[side] = background_remover()(Image.open(path).convert("RGB"))
        track.note("Dựng từ ảnh trước" + "".join(f", {SIDE_NAMES[side]}" for side in uploaded) + " bạn tải lên")
    else:
        if models["views"] is None:
            track.step("loading_views", detail="Nạp MV-Adapter (SDXL, vẽ các góc nhìn) vào GPU")
            with DownloadWatch(track, multiview.BASE_REPO, multiview.BASE_PATTERNS):
                views_model()
        track.step("viewing", detail="MV-Adapter vẽ nhân vật nhìn từ trái, sau, phải", total=multiview.STEPS, unit="bước")
        drawn = multiview.draw(views_model(), image, seed, lambda done: track.progress(done, multiview.STEPS))
        # MV-Adapter's own front is a copy of the picture; the picture itself is sharper
        track.detail("Vẽ xong 3 góc, tách nền")
        for side in multiview.SIDES:
            views[side] = background_remover()(drawn[side].convert("RGB"))
        # Hunyuan3D-2mv needs the room
        free_gpu(keep={"rembg"})
        track.note("MV-Adapter vẽ thêm mặt trái, sau, phải từ ảnh: Hunyuan3D-2mv dựng từ cả 4 góc")
        result["assumptions"].append("Mặt trái, sau và phải do MV-Adapter tự vẽ từ ảnh trước, có thể khác vật thật.")
    multiview.sheet(views).save(directory / "sides.png")
    return views


def run_job(job_id, params):
    """The GPU part of a figure from a picture; Claude takes over at the end"""
    global last_used
    import numpy as np
    import torch
    from PIL import Image

    directory = JOBS_DIR / job_id
    status = review.read_json(directory / "status.json", {})
    status.update(state="running", started_at=now())
    status.pop("queue_position", None)
    track = Tracker(job_id, status)
    with lock:
        last_used = time.monotonic()

    height_mm = float(params.get("height_mm") or 80)
    seed = int(params.get("seed") or 0)
    result = {"assumptions": []}

    image = Image.open(directory / "input.png")
    track.note(f"Ảnh tải lên: {image.width} × {image.height} px")
    track.step("background", detail="Tách nhân vật khỏi nền (rembg)")
    if image.mode != "RGBA" or np.asarray(image)[..., 3].min() == 255:
        image = background_remover()(image.convert("RGB"))
    else:
        track.detail("Ảnh đã có nền trong suốt: giữ nguyên")

    # "Dựng nhiều góc": the sides the user uploaded, or those MV-Adapter draws from the picture
    views = figure_views(track, directory, image, seed, bool(params.get("multiview")), result)
    many = views is not None
    shape_repo, shape_subfolder = (MV_SHAPE_REPO, MV_SHAPE_SUBFOLDER) if many else (SHAPE_REPO, SHAPE_SUBFOLDER)
    if models["shape_mv" if many else "shape"] is None:
        # The first job after start, an idle unload or a switch between one and many views: ~1–2 minutes
        track.step("loading", detail=f"Nạp {shape_repo.split('/')[-1]} ({shape_subfolder}) vào GPU")
        with DownloadWatch(track, shape_repo, [f"{shape_subfolder}/*"] if many else None):
            shape_model(many)

    steps = 5 if "turbo" in shape_subfolder else 30
    track.step("shaping", detail=f"Hunyuan3D-2 dựng trường thể tích từ {'4 góc' if many else 'ảnh'}", total=steps, unit="bước")

    def on_shape_step(step_idx, _t, _outputs):
        done = step_idx + 1
        # After the last denoising step the pipeline still turns the volume into a surface (marching cubes)
        track.progress(done, steps, detail="Đang trích bề mặt từ trường thể tích" if done >= steps else None)

    mesh = shape_model(many)(image=views or image, num_inference_steps=steps, octree_resolution=380, num_chunks=20000,
                             generator=torch.manual_seed(seed), callback=on_shape_step, callback_steps=1,
                             output_type="trimesh")[0]
    track.detail(f"{steps} bước khử nhiễu rồi trích bề mặt")
    track.note(f"Lưới thô: {fmt(len(mesh.faces))} mặt, {fmt(len(mesh.vertices))} đỉnh")

    track.step("repairing", detail="Xoay, sửa lưới và chỉnh kích thước")
    mesh = to_printable(mesh, height_mm, track)
    source = directory / "source"
    source.mkdir(exist_ok=True)
    mesh.export(source / "model.stl")
    review.write_json(source / "report.json", mesh_report(mesh, source))
    image.save(directory / "concept.png")
    colours = None
    if params.get("colour"):
        import picture

        track.detail("Lấy màu của ảnh cho từng mặt")
        (directory / "work").mkdir(exist_ok=True)
        rgb = picture.project(mesh, views or {"front": image}, directory / "work" / "picture.npz")
        colours = picture.dominant(mesh, rgb)
        track.note("Màu chính trong ảnh: " + ", ".join(f"{hex_} {share * 100:.0f}%" for hex_, share in colours))
    track.detail(f"Xoay đứng, sửa lưới, cao {height_mm:g} mm, đặt sát bàn in")
    track.check()
    track.close()
    review.write_json(directory / "status.json", status)
    with lock:
        last_used = time.monotonic()

    error = review.start_finish(job_id, {**params, "picture_colours": colours, "assumptions": result["assumptions"]},
                                str(params.get("model") or ""))
    if error:
        raise RuntimeError(error)
    # Cancelled while it was being handed over: Claude stops at once
    if job_id in cancelled:
        review.cancel(job_id)


def mesh_report(mesh, out):
    """source/: the figure as Hunyuan3D made it, its preview (the "before" on the dashboard) and its size"""
    import build  # cad/build.py
    import pymeshlab
    import refine
    import trimesh

    preview = mesh
    if len(mesh.faces) > PREVIEW_FACES:
        ms = pymeshlab.MeshSet()
        ms.add_mesh(pymeshlab.Mesh(mesh.vertices, mesh.faces))
        ms.meshing_decimation_quadric_edge_collapse(targetfacenum=PREVIEW_FACES)
        preview = trimesh.Trimesh(ms.current_mesh().vertex_matrix(), ms.current_mesh().face_matrix())
    build.render_preview(preview.triangles.tolist(), mesh.extents, out / "preview.png")
    check = refine.mesh_check(mesh)
    lo, hi = mesh.bounds
    return {
        "ok": True,
        "size_mm": [round(float(v), 2) for v in mesh.extents],
        "min_mm": [round(float(v), 2) for v in lo],
        "max_mm": [round(float(v), 2) for v in hi],
        "solids": int(mesh.body_count),
        "mesh": check,
        "warnings": [],
        "files": ["model.stl", "preview.png"],
        "palette": None,
    }


class Quiet:
    """A tracker for work that is no job's: generate_3d's"""

    def detail(self, _text):
        pass

    def note(self, _text):
        pass


def generate(body):
    """POST /generate, as MCP for Blender's local Hunyuan3D-2 calls it ({"image": base64} or {"text"},
    "octree_resolution", "num_inference_steps", "guidance_scale"): the object as GLB bytes, GENERATED_MM tall,
    standing on the ground, its front towards −Y once Blender has imported it. Runs on the GPU queue."""
    done, box = threading.Event(), {}

    def work():
        global last_used
        import base64
        import io

        import numpy as np
        import torch
        import trimesh
        from PIL import Image

        with lock:
            last_used = time.monotonic()
        if body.get("image"):
            image = Image.open(io.BytesIO(base64.b64decode(body["image"])))
        else:
            image = image_model()(prompt=str(body["text"]) + IMAGE_SUFFIX, negative_prompt=IMAGE_NEGATIVE,
                                  num_inference_steps=25, pag_scale=1.3, width=1024, height=1024,
                                  return_dict=False)[0][0]
            free_gpu(keep={"rembg", "shape"})
        if image.mode != "RGBA" or np.asarray(image)[..., 3].min() == 255:
            image = background_remover()(image.convert("RGB"))
        steps = 5 if "turbo" in SHAPE_SUBFOLDER else 30
        mesh = shape_model()(image=image, num_inference_steps=steps,
                             octree_resolution=int(body.get("octree_resolution") or 380), num_chunks=20000,
                             generator=torch.manual_seed(int(body.get("seed") or 0)), output_type="trimesh")[0]
        mesh = to_printable(mesh, GENERATED_MM, Quiet())
        # glTF is Y up: Blender's importer turns it back to Z up
        mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
        box["glb"] = mesh.export(file_type="glb")
        with lock:
            last_used = time.monotonic()

    jobs.put((None, {"work": work, "done": done, "box": box}))
    if not done.wait(900):
        raise RuntimeError("Hunyuan3D-2 không xong trong 15 phút")
    if "error" in box:
        raise RuntimeError(box["error"])
    return box["glb"]


def gpu_loop():
    while True:
        job_id, params = jobs.get()
        if job_id is None:
            # generate_3d's work, not a job's
            try:
                params["work"]()
            except Exception as err:  # noqa: BLE001 - told to the caller
                traceback.print_exc()
                params["box"]["error"] = f"{type(err).__name__}: {err}"
            finally:
                params["done"].set()
            continue
        directory = JOBS_DIR / job_id
        try:
            if job_id in cancelled:
                raise Cancelled()
            run_job(job_id, params)
        except Cancelled:
            status = review.read_json(directory / "status.json", {})
            status.update(state="cancelled", error="Đã hủy.", finished_at=now())
            review.write_json(directory / "status.json", status)
        except Exception as err:  # noqa: BLE001 - whatever went wrong belongs in the job's status
            traceback.print_exc()
            status = review.read_json(directory / "status.json", {})
            message = str(err) if isinstance(err, RuntimeError) else f"{type(err).__name__}: {err}"
            if "out of memory" in message.lower():
                message = "GPU hết bộ nhớ: đóng bớt ứng dụng dùng GPU (game, Studio) rồi thử lại."
            status.update(state="failed", error=message, finished_at=now())
            review.write_json(directory / "status.json", status)
        finally:
            # Only after the job is Claude's or its final status is written: the gateway shows a running job the
            # worker no longer lists as interrupted
            with lock:
                if job_id in pending:
                    pending.remove(job_id)
                cancelled.discard(job_id)


def queue_job(job_id, params):
    """Queues a figure from a picture; its position in the queue, or None when it is already there"""
    directory = JOBS_DIR / job_id
    with lock:
        if job_id in pending:
            return None
        pending.append(job_id)
        ahead = len(pending) - 1
    views = ("uploaded" if (directory / "views").is_dir() and any((directory / "views").iterdir())
             else "drawn" if params.get("multiview") else None)
    review.write_json(directory / "status.json", {
        "state": "running", "step": "queued", "notes": [], "builds": 0, "started_at": None,
        "finished_at": None, "error": None, "result": None, "report": None, "queue_position": ahead,
        "input": "image", "maker": "hunyuan", "views": views, "colour": bool(params.get("colour")),
        "model": str(params.get("model") or review.DEFAULT_MODEL), "progress": None,
        "steps": [{"id": "queued", "started_at": now(), "finished_at": None,
                   "detail": f"{ahead} mô hình đang chờ trước" if ahead else None}]})
    jobs.put((job_id, params))
    return ahead


def ids():
    with lock:
        return list(pending)


def cancel(job_id):
    """Drops a queued job, or stops a shaping one at its next step; False when it is not here"""
    with lock:
        if job_id not in pending:
            return False
        cancelled.add(job_id)
    status = review.read_json(JOBS_DIR / job_id / "status.json", {})
    status.update(state="cancelled", error="Đã hủy.")
    review.write_json(JOBS_DIR / job_id / "status.json", status)
    return True


def start():
    threading.Thread(target=gpu_loop, daemon=True).start()
    threading.Thread(target=idle_unloader, daemon=True).start()
