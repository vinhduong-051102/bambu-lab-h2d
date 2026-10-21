# linuxserver/bambustudio with Bambu Studio rebuilt from source, patched with an "AI tối ưu" button
# left of "Slice plate" (ai-button.patch). Built by docker-compose.studio.yml; see docs/studio.md.
#
# The first build takes a long time (one to several hours: Studio's dependencies, then Studio) and
# needs ~10 GB of RAM for Docker and ~20 GB of disk. Changing only the patch reuses the dependency layer.

# Studio release to build; keep it at the version the base image ships so its runtime libraries match
ARG BAMBUSTUDIO_TAG=v02.08.04.57
ARG BASE_IMAGE=lscr.io/linuxserver/bambustudio:latest

FROM ubuntu:24.04 AS builder
ARG BAMBUSTUDIO_TAG
ENV DEBIAN_FRONTEND=noninteractive

# libgtk-3-dev up front: linux.d/debian starts with `dpkg -l libgtk* | grep gtk-3` under set -e,
# so BuildLinux.sh -u exits 1 silently on an image without GTK
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git sudo locales locales-all wget file \
      libgtk-3-dev \
 && rm -rf /var/lib/apt/lists/*
ENV LC_ALL=en_US.utf8

RUN git clone --depth 1 --branch "${BAMBUSTUDIO_TAG}" https://github.com/bambulab/BambuStudio.git /BambuStudio
WORKDIR /BambuStudio

# Build packages (apt), then the bundled dependencies (wxWidgets, Boost, OCCT, ...): the slow, cached part.
# -r skips the free RAM/disk check, which reads the whole VM and fails under Docker Desktop's defaults.
RUN ./BuildLinux.sh -u && rm -rf /var/lib/apt/lists/*
RUN ./BuildLinux.sh -dr

COPY ai-button.patch /tmp/ai-button.patch
RUN git apply /tmp/ai-button.patch
# Popups that stay on screen and swallow input on GTK: the parameter tooltip and popups that open a dialog
COPY popup-fixes.patch /tmp/popup-fixes.patch
RUN git apply /tmp/popup-fixes.patch

# Studio itself, then the same layout as the release AppImage that linuxserver extracts to /opt/bambustudio
# BuildLinux.sh only lays out build/package with -i, which also builds an AppImage; call the
# layout script directly instead, in its own layer so packaging changes don't recompile Studio
RUN ./BuildLinux.sh -sr
RUN cd build \
 && ./src/BuildLinuxImage.sh \
 && cd package \
 && sed -i -e 's#/usr#././#g' bin/bambu-studio \
 && mv bambu-studio AppRun \
 && chmod 755 AppRun  # the layout script only sets ug+x; Studio runs as the non-root abc user

FROM ${BASE_IMAGE}
RUN rm -rf /opt/bambustudio
COPY --from=builder /BambuStudio/build/package /opt/bambustudio
