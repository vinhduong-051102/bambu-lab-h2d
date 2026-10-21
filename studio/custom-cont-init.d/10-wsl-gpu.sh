#!/bin/sh
# Make the WSL2 D3D12 libraries (mounted at /usr/lib/wsl/lib) visible to every process.
# Studio's AppRun overwrites LD_LIBRARY_PATH, so the env var alone never reaches it, and Mesa's
# d3d12 driver then fails to load libd3d12.so and Studio crashes on start.
if [ -f /usr/lib/wsl/lib/libd3d12.so ]; then
  echo /usr/lib/wsl/lib > /etc/ld.so.conf.d/00-wsl.conf
  ldconfig
fi
