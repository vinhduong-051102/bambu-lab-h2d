import { describe, it, expect } from 'vitest';
import { arrowLength, EXAMPLES, latestOnly, motorDisplay, pace, threeQuaternion, toSi } from '../src/ui/simLive';

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

  it('offers the drop as the first example', () => {
    expect(EXAMPLES[0].value).toBe('drop_box');
  });
});
