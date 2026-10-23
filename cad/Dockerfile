# CAD worker for "Thiết kế mô hình bằng AI" (docs/cad.md): build123d to turn Python into STL/STEP, matplotlib for
# the preview, and Claude Code to write the Python from a request (`claude -p`, signed in with the
# CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`). The worker's scripts are mounted from ./cad at run time.
FROM python:3.12-slim

# libgl1/libxrender1: OCP (build123d's OpenCascade binding) links against them even when nothing is drawn
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl bash git jq libgl1 libxrender1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

ARG BUILD123D_VERSION=0.13.0
RUN pip install --no-cache-dir "build123d==${BUILD123D_VERSION}" matplotlib numpy

# Claude Code for every user (the worker runs as cad); updates come from rebuilding the image
ARG CLAUDE_CODE_VERSION=stable
RUN export HOME=/tmp/claude-install \
 && curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}" \
 && install -m 755 "$(readlink -f "$HOME/.local/bin/claude")" /usr/local/bin/claude \
 && rm -rf "$HOME" \
 && claude --version

# Claude Code won't run its tools unattended as root; the worker and everything it starts run as cad
RUN useradd --create-home --uid 1000 cad
USER cad
ENV HOME=/home/cad PYTHONUNBUFFERED=1 MPLBACKEND=Agg DISABLE_AUTOUPDATER=1
WORKDIR /opt/cad
EXPOSE 8000
CMD ["python", "/opt/cad/worker.py"]
