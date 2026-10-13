# Headless Bambu Studio for gateway-side slicing (see slice.py and docs/slicing.md).
# Build: docker build -t bambu-h2d-slicer:02.08.02.61 slicer/
FROM ubuntu:22.04

ARG BAMBU_STUDIO_URL=https://github.com/bambulab/BambuStudio/releases/download/v02.08.02.61/BambuStudio_ubuntu22.04-v02.08.02.61-20260820225108.AppImage
ARG BAMBU_STUDIO_SHA256=69426a59682574591590f51c913d3889baa19252d1c8e9fcae2497eb0ed6bf92

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 \
      libgl1 libegl1 libosmesa6 libx11-6 libcairo2 libdbus-1-3 libdrm2 libfontconfig1 \
      libgtk-3-0 libgdk-pixbuf-2.0-0 libglib2.0-0 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
      libjavascriptcoregtk-4.1-0 libwebkit2gtk-4.1-0 libpango-1.0-0 libpangocairo-1.0-0 \
      libwayland-client0 libwayland-server0 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/BambuStudio.AppImage "$BAMBU_STUDIO_URL" \
 && echo "$BAMBU_STUDIO_SHA256  /tmp/BambuStudio.AppImage" | sha256sum -c - \
 && chmod +x /tmp/BambuStudio.AppImage \
 && cd /opt && /tmp/BambuStudio.AppImage --appimage-extract > /dev/null \
 && mv /opt/squashfs-root /opt/bambu-studio \
 && chmod -R a+rX /opt/bambu-studio \
 && rm /tmp/BambuStudio.AppImage

COPY slice.py /usr/local/bin/slice.py

ENV HOME=/tmp
ENTRYPOINT ["python3", "/usr/local/bin/slice.py"]
