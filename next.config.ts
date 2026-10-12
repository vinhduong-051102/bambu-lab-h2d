import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The dashboard script binds DOM listeners once per mount; strict mode's double mount
  // in development would register every control handler twice.
  reactStrictMode: false,
  // Pin the workspace root to this project (a stray lockfile in a parent directory confuses detection)
  turbopack: { root: process.cwd() },
  // Native/stream-heavy dependencies stay as plain Node requires in the server bundle
  serverExternalPackages: ['mqtt', 'pino', 'pino-pretty', '@ffmpeg-installer/ffmpeg'],
};

export default nextConfig;
