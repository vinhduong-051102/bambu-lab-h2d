# CAD worker for "Thiết kế mô hình bằng AI" (docs/cad.md, docs/text-to-cad.md): text-to-cad's cadgen engine builds
# the build123d models, draws their previews (OCCT, on Xvfb) and exports them; Claude Code writes the models from a
# request (`claude -p`, signed in with the CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`) with text-to-cad's
# skills (./text-to-cad). The worker's scripts are mounted from ./cad at run time.
FROM python:3.13-slim

# Xvfb and Mesa: cadgen's snapshots draw through OCCT's OpenGL view, which on Linux needs an X display
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl bash git jq \
      libgl1 libglx-mesa0 libgl1-mesa-dri libegl1 libxrender1 libglib2.0-0 libfontconfig1 xvfb xauth \
 && rm -rf /var/lib/apt/lists/*

# cadgen brings build123d 0.13, OCP, bd_materials, ezdxf and lib3mf; the skills call `cadgen +<this version>`.
# trimesh and its extras: text-to-cad's dfam-check and dfm scripts
ARG CADGEN_VERSION=0.8.4
RUN pip install --no-cache-dir "cadgen==${CADGEN_VERSION}" matplotlib numpy trimesh rtree scipy networkx lxml

# Claude Code for every user (the worker runs as cad); updates come from rebuilding the image
ARG CLAUDE_CODE_VERSION=stable
RUN export HOME=/tmp/claude-install \
 && curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}" \
 && install -m 755 "$(readlink -f "$HOME/.local/bin/claude")" /usr/local/bin/claude \
 && rm -rf "$HOME" \
 && claude --version

# ffmpeg encodes the assembly guide's video (assembly_guide.py); its own layer, so the ones above stay cached
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# ngspice simulates the power side of a model's circuit, graphviz draws its wiring diagram (circuit.py,
# docs/cad.md "Mạch điện tử")
RUN apt-get update \
 && apt-get install -y --no-install-recommends ngspice graphviz \
 && rm -rf /var/lib/apt/lists/*

# The skills write `cadgen +0.8.4 ...`, the form the installer's proxy takes; the image has one cadgen, so the
# version argument is dropped
RUN mv /usr/local/bin/cadgen /usr/local/bin/cadgen-real \
 && printf '#!/bin/sh\ncase "$1" in +*) shift;; esac\nexec /usr/local/bin/cadgen-real "$@"\n' > /usr/local/bin/cadgen \
 && chmod 755 /usr/local/bin/cadgen

# Claude Code won't run its tools unattended as root; the worker and everything it starts run as cad
RUN useradd --create-home --uid 1000 cad
USER cad
# PYTHONPATH: the models import the worker's own libraries (electronics, calibration) in cadgen's engine workers,
# which start in the job's folder
ENV HOME=/home/cad PYTHONUNBUFFERED=1 MPLBACKEND=Agg DISABLE_AUTOUPDATER=1 DISPLAY=:99 \
    CADGEN_TELEMETRY=0 CADGEN_UPDATE_CHECK=0 PYTHONPATH=/opt/cad
RUN cadgen telemetry off
WORKDIR /opt/cad
EXPOSE 8000
CMD ["python", "/opt/cad/worker.py"]
