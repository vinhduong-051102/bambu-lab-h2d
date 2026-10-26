# Mesh worker for organic models (docs/cad.md): Tencent's Hunyuan3D-2 turns a picture into a shape, HunyuanDiT
# draws the picture from a brief Claude writes, the worker makes the mesh printable, and with colour on
# Hunyuan3D-Paint textures it. PyTorch 2.7 with CUDA 12.8 is the first build with kernels for RTX 50xx (Blackwell,
# sm_120); the devel image brings nvcc for the texture stage's rasterizer.
# Hunyuan3D-2 and HunyuanDiT are under Tencent's own licences, which restrict commercial use.
FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-devel

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates libgl1 libopengl0 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

# hy3dgen's own requirements minus the demo UI, plus HunyuanDiT's tokenizers and matplotlib for the preview.
# transformers 5 renamed the DINOv2 image encoder's weights, which Hunyuan3D-2's checkpoints no longer load into
RUN pip install --no-cache-dir diffusers einops opencv-python-headless "transformers>=4.48.0,<5" omegaconf \
      trimesh pymeshlab pygltflib xatlas accelerate rembg onnxruntime "numpy<2.3" sentencepiece protobuf matplotlib \
      pybind11 ninja rtree scipy
ARG HUNYUAN3D_REF=main
# Current diffusers only runs a pipeline's own code (Hunyuan3D-Paint's, from this clone) with trust_remote_code
RUN git clone https://github.com/Tencent/Hunyuan3D-2 /opt/hy3d \
 && cd /opt/hy3d && git checkout "${HUNYUAN3D_REF}" \
 && sed -i 's/custom_pipeline=custom_pipeline_path, torch_dtype=torch.float16)/custom_pipeline=custom_pipeline_path, torch_dtype=torch.float16, trust_remote_code=True)/' \
      hy3dgen/texgen/utils/multiview_utils.py \
 && grep -q trust_remote_code=True hy3dgen/texgen/utils/multiview_utils.py \
 && pip install --no-cache-dir --no-deps -e .

# The texture stage's native parts: a CUDA rasterizer and a C++ mesh painter. No GPU is visible while the image
# builds, so the architectures are named: RTX 30xx, 40xx and 50xx
ARG TORCH_CUDA_ARCH_LIST="8.6;8.9;12.0"
RUN cd /opt/hy3d/hy3dgen/texgen/custom_rasterizer \
 && TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST}" MAX_JOBS=4 pip install --no-cache-dir --no-build-isolation . \
 && cd ../differentiable_renderer \
 && pip install --no-cache-dir --no-build-isolation . \
 && cd / && python -c "import torch, custom_rasterizer, custom_rasterizer_kernel, mesh_processor; print('texture extensions ok')"

# Claude Code writes the picture brief from the user's words, and reviews and fixes finished figures (claude -p, on
# CLAUDE_CODE_OAUTH_TOKEN)
ARG CLAUDE_CODE_VERSION=stable
RUN export HOME=/tmp/claude-install \
 && curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}" \
 && install -m 755 "$(readlink -f "$HOME/.local/bin/claude")" /usr/local/bin/claude \
 && rm -rf "$HOME" \
 && claude --version

# Claude's review of a figure (meshkit.py): booleans (manifold3d), cross-sections (shapely) and flat caps
# (mapbox_earcut). A layer of its own, so adding it leaves the CUDA build above cached
RUN pip install --no-cache-dir manifold3d shapely mapbox_earcut

RUN useradd --create-home --uid 1000 mesh
USER mesh
# Model weights download here on first use (~40 GB): a volume (MESH_MODELS_DIR), so they survive rebuilds
ENV HOME=/home/mesh HF_HOME=/models U2NET_HOME=/models/u2net PYTHONUNBUFFERED=1 MPLBACKEND=Agg DISABLE_AUTOUPDATER=1
WORKDIR /opt/mesh3d
EXPOSE 8000
CMD ["python", "/opt/mesh3d/worker.py"]
