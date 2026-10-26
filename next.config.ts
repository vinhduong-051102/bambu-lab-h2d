import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Pin the workspace root to this project (a stray lockfile in a parent directory confuses detection)
  turbopack: { root: process.cwd() },
  // Native/stream-heavy dependencies stay as plain Node requires in the server bundle
  serverExternalPackages: ['mqtt', 'pino', 'pino-pretty', '@ffmpeg-installer/ffmpeg'],
};

export default nextConfig;
