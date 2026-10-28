# Mesh worker (docs/cad.md, "Nhân vật"): Tencent's Hunyuan3D-2 turns a picture into a figure on the GPU (MV-Adapter
# draws its other sides for "Dựng nhiều góc"), then Claude fixes and paints it in Blender through MCP for Blender,
# or makes one from a description (generate_3d on the same Hunyuan3D-2, or Python); analyze.py measures the parts of
# Studio's models.
# PyTorch 2.7 with CUDA 12.8 is the first build with kernels for RTX 50xx (Blackwell, sm_120).
# Hunyuan3D-2 is under Tencent's own licence, which restricts commercial use.
FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-devel

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates libgl1 libopengl0 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

# hy3dgen's own requirements minus the demo UI and the texture stage, plus matplotlib for the preview.
# transformers 5 renamed the DINOv2 image encoder's weights, which Hunyuan3D-2's checkpoints no longer load into
RUN pip install --no-cache-dir diffusers einops opencv-python-headless "transformers>=4.48.0,<5" omegaconf \
      trimesh pymeshlab pygltflib xatlas accelerate rembg onnxruntime "numpy<2.3" sentencepiece protobuf matplotlib \
      pybind11 ninja rtree scipy
ARG HUNYUAN3D_REF=main
RUN git clone https://github.com/Tencent/Hunyuan3D-2 /opt/hy3d \
 && cd /opt/hy3d && git checkout "${HUNYUAN3D_REF}" \
 && pip install --no-cache-dir --no-deps -e .

# Claude Code fixes and paints the figures, and models those from a description (claude -p, on
# CLAUDE_CODE_OAUTH_TOKEN)
ARG CLAUDE_CODE_VERSION=stable
RUN export HOME=/tmp/claude-install \
 && curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}" \
 && install -m 755 "$(readlink -f "$HOME/.local/bin/claude")" /usr/local/bin/claude \
 && rm -rf "$HOME" \
 && claude --version

# The figure tools' mesh work (meshkit.py): booleans (manifold3d), cross-sections (shapely, networkx), flat caps
# (mapbox_earcut), voxel closing (scikit-image)
RUN pip install --no-cache-dir manifold3d shapely mapbox_earcut networkx scikit-image

# Blender, headless, with the X libraries it needs even in the background
ARG BLENDER_VERSION=4.5.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends xz-utils libxrender1 libxi6 libxkbcommon0 libsm6 libxfixes3 libxext6 \
      libx11-6 libxxf86vm1 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://download.blender.org/release/Blender${BLENDER_VERSION%.*}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /opt \
 && ln -s "/opt/blender-${BLENDER_VERSION}-linux-x64/blender" /usr/local/bin/blender \
 && blender -b --factory-startup --python-expr "import bpy; print('blender ok', bpy.app.version_string)"

# "Dựng nhiều góc" (multiview.py): MV-Adapter draws a figure's other sides from its picture for Hunyuan3D-2mv. Only
# its image → views code runs: the type-annotation packages it imports, not its texturing requirements
ARG MVADAPTER_REF=4277e00
RUN git clone https://github.com/huanngzh/MV-Adapter /opt/mvadapter \
 && cd /opt/mvadapter && git checkout "${MVADAPTER_REF}" \
 && pip install --no-cache-dir jaxtyping typeguard

# MCP for Blender (github.com/ahujasid/blender-mcp, MIT): the MCP server Claude works in Blender through, and its
# add-on, which serves it from inside Blender. The add-on's server runs on Blender's main loop, which only exists
# with the interface: Blender runs on a virtual display (Xvfb), drawing with Mesa's software OpenGL
ARG MCP_FOR_BLENDER_VERSION=2.2.4
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb xauth libgl1-mesa-dri libglx-mesa0 libegl1 libxkbcommon-x11-0 \
      libxcursor1 libxinerama1 libxrandr2 libdbus-1-3 \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir "mcp-for-blender==${MCP_FOR_BLENDER_VERSION}" \
 && mkdir -p /opt/blender-mcp/addons \
 && cp "$(python -c 'import blender_mcp, os; print(os.path.dirname(blender_mcp.__file__))')/bundled/addon.py" \
      /opt/blender-mcp/addons/blender_mcp.py \
 && mcp-for-blender --help > /dev/null

# Mechanism simulation (sim/, docs/mechanical-simulation.md): Project Chrono's Python in its own conda environment,
# /opt/chrono (Python 3.12), apart from the PyTorch above; the worker runs sim/chrono_run.py with it. CPU only
ARG MICROMAMBA_VERSION=2.10.0
ARG PYCHRONO_VERSION=10.0.0
RUN curl -fsSL "https://micro.mamba.pm/api/micromamba/linux-64/${MICROMAMBA_VERSION}" | tar -xj -C /usr/local bin/micromamba \
 && MAMBA_ROOT_PREFIX=/tmp/mamba micromamba create -y -p /opt/chrono -c projectchrono -c conda-forge \
      "projectchrono::pychrono=${PYCHRONO_VERSION}" python=3.12 \
 && rm -rf /tmp/mamba \
 && /opt/chrono/bin/python -c "import pychrono; pychrono.ChSystemNSC(); print('pychrono ok')"

RUN useradd --create-home --uid 1000 mesh
USER mesh
# Model weights download here on first use (~25 GB): a volume (MESH_MODELS_DIR), so they survive rebuilds
ENV HOME=/home/mesh HF_HOME=/models U2NET_HOME=/models/u2net PYTHONUNBUFFERED=1 MPLBACKEND=Agg DISABLE_AUTOUPDATER=1
WORKDIR /opt/mesh3d
EXPOSE 8000
CMD ["python", "/opt/mesh3d/worker.py"]
