"""
"Dựng nhiều góc" (docs/cad.md): the figure seen from four sides, for Hunyuan3D-2mv, which shapes it from all of
them instead of guessing the back from one picture. The sides come from the user (views/left.png, back.png,
right.png next to input.png), or MV-Adapter draws them from the front picture (image → multiview on SDXL,
github.com/huanngzh/MV-Adapter, checked out in the image at MVADAPTER_DIR).

MV-Adapter needs ~13.5 GB of GPU memory while it draws: the worker unloads every other model first, and this one
again before Hunyuan3D-2mv loads.
"""

import os
import sys
from unittest import mock

MVADAPTER_DIR = os.environ.get("MVADAPTER_DIR", "/opt/mvadapter")
BASE_REPO = os.environ.get("MESH_VIEWS_BASE_REPO", "stabilityai/stable-diffusion-xl-base-1.0")
VAE_REPO = "madebyollin/sdxl-vae-fp16-fix"
ADAPTER_REPO = "huanngzh/mv-adapter"
ADAPTER_WEIGHTS = "mvadapter_i2mv_sdxl.safetensors"
SIZE = 768
STEPS = int(os.environ.get("MESH_VIEWS_STEPS", "30"))
# Hunyuan3D-2mv's views by MV-Adapter's camera azimuth: the subject turning clockwise seen from above
AZIMUTHS = {"front": 0, "left": 90, "back": 180, "right": 270}
SIDES = ("left", "back", "right")
# The SDXL weights load() downloads the first time (~6.5 GB of its ~9.5 GB), for the worker's download progress
BASE_PATTERNS = ["*.fp16.safetensors"]


def load():
    """MV-Adapter on SDXL in fp16, on the GPU"""
    import torch
    from diffusers import AutoencoderKL

    # The rendering and texturing libraries MV-Adapter imports at module level; drawing views never calls them
    for name in ("nvdiffrast", "nvdiffrast.torch", "cvcuda", "open3d"):
        sys.modules.setdefault(name, mock.MagicMock(name=name))
    if MVADAPTER_DIR not in sys.path:
        sys.path.insert(0, MVADAPTER_DIR)
    from mvadapter.pipelines.pipeline_mvadapter_i2mv_sdxl import MVAdapterI2MVSDXLPipeline
    from mvadapter.schedulers.scheduling_shift_snr import ShiftSNRScheduler

    pipe = MVAdapterI2MVSDXLPipeline.from_pretrained(
        BASE_REPO, variant="fp16", torch_dtype=torch.float16,
        vae=AutoencoderKL.from_pretrained(VAE_REPO, torch_dtype=torch.float16))
    pipe.scheduler = ShiftSNRScheduler.from_scheduler(pipe.scheduler, shift_mode="interpolated", shift_scale=8.0)
    pipe.init_custom_adapter(num_views=len(AZIMUTHS))
    pipe.load_custom_adapter(ADAPTER_REPO, weight_name=ADAPTER_WEIGHTS)
    pipe.to(device="cuda", dtype=torch.float16)
    pipe.cond_encoder.to(device="cuda", dtype=torch.float16)
    pipe.enable_vae_slicing()
    return pipe


def reference(image):
    """The figure (RGBA, background removed) centred on grey at 90 % of the frame, as MV-Adapter was trained"""
    import numpy as np
    from PIL import Image

    rgba = np.asarray(image.convert("RGBA"))
    ys, xs = np.where(rgba[..., 3] > 0)
    crop = rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = crop.shape[:2]
    scale = SIZE * 0.9 / max(h, w)
    crop = np.asarray(Image.fromarray(crop).resize((max(1, int(w * scale)), max(1, int(h * scale)))))
    canvas = np.zeros((SIZE, SIZE, 4), np.uint8)
    top, left = (SIZE - crop.shape[0]) // 2, (SIZE - crop.shape[1]) // 2
    canvas[top:top + crop.shape[0], left:left + crop.shape[1]] = crop
    f = canvas.astype(np.float32) / 255
    return Image.fromarray((np.clip(f[..., :3] * f[..., 3:] + (1 - f[..., 3:]) * 0.5, 0, 1) * 255).astype(np.uint8))


def draw(pipe, image, seed, on_step):
    """The four views of `image` ({"front", "left", "back", "right"}: RGB on grey); on_step(done) per step"""
    import torch
    from mvadapter.utils.geometry import get_plucker_embeds_from_cameras_ortho
    from mvadapter.utils.mesh_utils import get_orthogonal_camera

    count = len(AZIMUTHS)
    cameras = get_orthogonal_camera(
        elevation_deg=[0] * count, distance=[1.8] * count, left=-0.55, right=0.55, bottom=-0.55, top=0.55,
        azimuth_deg=[a - 90 for a in AZIMUTHS.values()], device="cuda")
    control = ((get_plucker_embeds_from_cameras_ortho(cameras.c2w, [1.1] * count, SIZE) + 1) / 2).clamp(0, 1)

    def step_end(_pipe, i, _t, kwargs):
        on_step(i + 1)
        return kwargs

    images = pipe(
        "high quality", height=SIZE, width=SIZE, num_inference_steps=STEPS, guidance_scale=3.0,
        num_images_per_prompt=count, control_image=control, control_conditioning_scale=1.0,
        reference_image=reference(image), reference_conditioning_scale=1.0,
        negative_prompt="watermark, ugly, deformed, noisy, blurry, low contrast",
        generator=torch.Generator(device="cuda").manual_seed(seed), callback_on_step_end=step_end).images
    return dict(zip(AZIMUTHS, images))


def sheet(views):
    """The views side by side (front, left, back, right) for the dashboard"""
    from PIL import Image

    tiles = [views[tag].convert("RGB").resize((384, 384)) for tag in AZIMUTHS if tag in views]
    out = Image.new("RGB", (384 * len(tiles), 384), (128, 128, 128))
    for i, tile in enumerate(tiles):
        out.paste(tile, (384 * i, 0))
    return out
