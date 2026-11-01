import { describe, it, expect } from 'vitest';
import { arrowLength, latestOnly, motorDisplay, pace, slerp, smoothPlayback, threeQuaternion, toSi } from '../src/ui/simLive';

describe('Interactive simulation viewer helpers', () => {
  it('shows motors in the units people read, and sends SI back', () => {
    expect(motorDisplay('rad/s')).toMatchObject({ unit: '°/s' });
    expect(motorDisplay('rad/s').scale * Math.PI).toBeCloseTo(180);
    expect(toSi(360, 'rad/s')).toBeCloseTo(2 * Math.PI);
    expect(toSi(25, 'm')).toBeCloseTo(0.025);
    expect(toSi(0.5, 'N·m')).toBe(0.5);
    expect(motorDisplay('furlong')).toEqual({ unit: 'furlong', scale: 1 });
  });

  it('says whether the session keeps up with real time', () => {
    expect(pace({ running: true, behind: false, rtf: 1.0, speed: 1, failed: null }).text).toBe('Thời gian thực ×1.00');
    const slow = pace({ running: true, behind: true, rtf: 0.19, speed: 1, failed: null });
    expect(slow).toEqual({ color: 'warning', text: 'Chậm hơn thời gian thực: ×0.19' });
    expect(pace({ running: true, behind: false, rtf: 0.5, speed: 0.5, failed: null }).text).toBe('×0.50 (đặt ×0.5)');
    expect(pace({ running: false, behind: false, rtf: 0, speed: 1, failed: null }).text).toBe('Tạm dừng');
    expect(pace({ running: false, behind: false, rtf: 0, speed: 1, failed: 'NaN' }).color).toBe('error');
  });

  it('sizes arrows in proportion, up to a cap', () => {
    expect(arrowLength(2, 0.1)).toBe(20);
    expect(arrowLength(1000, 0.1)).toBe(150);
    expect(arrowLength(0, 0.1)).toBe(0);
    expect(arrowLength(Number.NaN, 0.1)).toBe(0);
  });

  it('interpolates rotations the short way round', () => {
    const half = slerp([1, 0, 0, 0], [Math.cos(Math.PI / 4), 0, 0, Math.sin(Math.PI / 4)], 0.5);
    expect(half[0]).toBeCloseTo(Math.cos(Math.PI / 8));
    expect(half[3]).toBeCloseTo(Math.sin(Math.PI / 8));
    // -q is the same rotation: still the short way
    const flipped = slerp([1, 0, 0, 0], [-Math.cos(Math.PI / 4), 0, 0, -Math.sin(Math.PI / 4)], 0.5);
    expect(Math.abs(flipped[0])).toBeCloseTo(Math.cos(Math.PI / 8));
    expect(Math.hypot(...flipped)).toBeCloseTo(1);
  });

  it('plays the state stream back smoothly, between the states received', () => {
    const at = (t: number, x: number, seq = 0, running = true) => ({ t, seq, running, bodies: { b: { p: [x, 0, 0], q: [1, 0, 0, 0] } } });
    const play = smoothPlayback(0.05);
    expect(play.frame(0)).toBeNull();
    // Real time, a state every 50 ms, x = t
    for (let k = 0; k <= 20; k++) play.push(at(k * 0.05, k * 0.05), k * 50);
    const drawn: number[] = [];
    for (let w = 1000; w <= 1050; w += 10) {
      const s = play.frame(w)!;
      drawn.push(s.bodies.b.p[0]);
      // Between two states, so x follows t
      expect(s.bodies.b.p[0]).toBeCloseTo(s.t);
      expect(s.t).toBeLessThanOrEqual(1);
    }
    // Moving on between frames, without waiting for the next state
    for (let k = 1; k < drawn.length; k++) expect(drawn[k]).toBeGreaterThan(drawn[k - 1]);
    // A late, older state is dropped; a reset (a new seq) starts over
    play.push(at(0.9, 99), 1060);
    expect(play.frame(1070)!.bodies.b.p[0]).toBeLessThan(1.01);
    play.push(at(0, 0, 1, false), 1080);
    expect(play.frame(1090)!.t).toBe(0);
  });

  it('settles on the newest state when paused', () => {
    const play = smoothPlayback(0.08);
    play.push({ t: 0.5, seq: 0, running: true, bodies: {} }, 0);
    play.push({ t: 0.6, seq: 1, running: false, bodies: {} }, 100);
    let t = 0;
    for (let w = 100; w <= 2000; w += 16) t = play.frame(w)!.t;
    expect(t).toBeCloseTo(0.6, 3);
  });

  it('reorders quaternions for three.js', () => {
    expect(threeQuaternion([1, 0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3, 1]);
  });

  it('sends only the latest pointer target while one is in flight', async () => {
    const sent: number[] = [];
    const releases: (() => void)[] = [];
    const send = latestOnly((v: number) => {
      sent.push(v);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    for (const v of [1, 2, 3, 4]) send(v);
    // 1 went at once; 2 and 3 were overtaken while it was in flight
    expect(sent).toEqual([1]);
    releases.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([1, 4]);
    releases.shift()!();
    await Promise.resolve();
    expect(sent).toEqual([1, 4]);
  });
});
