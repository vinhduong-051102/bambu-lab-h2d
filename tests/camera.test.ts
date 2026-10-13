import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

const spawned: FakeProcess[] = [];

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new FakeProcess();
    spawned.push(proc);
    return proc;
  }),
}));

// The TLS 6000 diagnostic socket connects successfully but never yields frames
vi.mock('tls', () => ({
  default: {
    connect: vi.fn((_opts: unknown, onConnect: () => void) => {
      const socket = Object.assign(new EventEmitter(), {
        getPeerCertificate: () => ({ subject: { CN: 'TEST' } }),
        authorized: false,
        write: () => true,
        destroy: () => undefined,
      });
      setTimeout(onConnect, 0);
      return socket;
    }),
  },
}));

const { BambuCameraService } = await import('../src/bambu/BambuCameraService');

// Minimal JPEG: SOI, filler, EOI (> 100 bytes so it counts as a frame)
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200, 1), Buffer.from([0xff, 0xd9])]);

describe('BambuCameraService reconnect', () => {
  let camera: InstanceType<typeof BambuCameraService>;

  beforeEach(() => {
    vi.useFakeTimers();
    spawned.length = 0;
    camera = new BambuCameraService('192.0.2.1', 'code');
  });

  afterEach(() => {
    camera.stop();
    vi.useRealTimers();
  });

  it('is not "connected" through the TLS diagnostic socket alone', async () => {
    camera.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(camera.getStatus().connected).toBe(false);
  });

  it('reports a stream whose last frame is stale as disconnected', async () => {
    camera.start();
    spawned[0].stdout.emit('data', jpeg());
    expect(camera.getStatus().connected).toBe(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(camera.getStatus().connected).toBe(false);
    expect(camera.getStatus().fps).toBe(0);
  });

  it('resolves true once the new FFmpeg process delivers a frame, with fresh counters', async () => {
    camera.start();
    spawned[0].stdout.emit('data', jpeg());
    const result = camera.forceReconnect();
    expect(spawned[0].killed).toBe(true);
    expect(camera.getStatus().framesReceived).toBe(0);

    // Output flushed by the killed process must not count
    spawned[0].stdout.emit('data', jpeg());
    await vi.advanceTimersByTimeAsync(600);
    expect(spawned).toHaveLength(2);
    spawned[1].stdout.emit('data', jpeg());

    await expect(result).resolves.toBe(true);
    expect(camera.getStatus()).toMatchObject({ connected: true, framesReceived: 1 });
  });

  it('resolves false when no frame arrives in time, and shares one restart between callers', async () => {
    camera.start();
    const a = camera.forceReconnect(3000);
    const b = camera.forceReconnect(3000);
    expect(a).toBe(b);
    await vi.advanceTimersByTimeAsync(3100);
    await expect(a).resolves.toBe(false);
    expect(spawned).toHaveLength(2);
    expect(camera.getStatus().lastError).toContain('No camera frame');
  });

  it('restarts an FFmpeg process that stops producing frames', async () => {
    camera.start();
    spawned[0].stdout.emit('data', jpeg());
    await vi.advanceTimersByTimeAsync(26000);
    expect(spawned[0].killed).toBe(true);
    expect(spawned.length).toBeGreaterThanOrEqual(2);
  });
});
