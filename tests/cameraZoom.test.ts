import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initCameraZoom } from '../src/ui/cameraZoom.js';

// Minimal stand-ins for the DOM pieces cameraZoom touches (the test environment is node)
class FakeElement extends EventTarget {
  clientWidth = 800;
  clientHeight = 450;
  disabled = false;
  textContent = '';
  style: Record<string, string> = {};
  private classes = new Set<string>();
  classList = {
    toggle: (c: string, on: boolean) => (on ? this.classes.add(c) : this.classes.delete(c)),
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  closest() {
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  setPointerCapture() {}
}

function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, props);
  target.dispatchEvent(event);
  return event;
}

/** Parses "translate(xpx, ypx) scale(s)" */
function transform(img: FakeElement) {
  const m = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.]+)\)/.exec(img.style.transform ?? '');
  return m ? { tx: Number(m[1]), ty: Number(m[2]), scale: Number(m[3]) } : { tx: 0, ty: 0, scale: 1 };
}

describe('camera digital zoom', () => {
  let viewport: FakeElement;
  let img: FakeElement;
  let zoomIn: FakeElement;
  let zoomOut: FakeElement;
  let reset: FakeElement;
  let level: FakeElement;
  let dispose: () => void;

  beforeEach(() => {
    (globalThis as any).window = new EventTarget();
    [viewport, img, zoomIn, zoomOut, reset, level] = Array.from({ length: 6 }, () => new FakeElement());
    dispose = initCameraZoom({ viewport, img, zoomInBtn: zoomIn, zoomOutBtn: zoomOut, resetBtn: reset, levelLabel: level });
  });

  afterEach(() => {
    dispose();
    delete (globalThis as any).window;
  });

  it('starts at 1× with zoom-out and reset disabled', () => {
    expect(img.style.transform ?? '').toBe('');
    expect(level.textContent).toBe('1.0×');
    expect(zoomOut.disabled).toBe(true);
    expect(reset.disabled).toBe(true);
  });

  it('zooms toward the cursor on wheel and blocks page scroll', () => {
    const event = fire(viewport, 'wheel', { deltaY: -400, clientX: 200, clientY: 100 });
    expect(event.defaultPrevented).toBe(true);
    const t = transform(img);
    expect(t.scale).toBeGreaterThan(1);
    // The image point under the cursor stays under the cursor
    expect(200 - t.tx).toBeCloseTo(200 * t.scale);
    expect(100 - t.ty).toBeCloseTo(100 * t.scale);
    expect(viewport.classList.contains('is-zoomed')).toBe(true);
  });

  it('clamps to 1×–6× and buttons step around the centre', () => {
    for (let i = 0; i < 10; i++) fire(zoomIn, 'click');
    expect(transform(img).scale).toBe(6);
    expect(zoomIn.disabled).toBe(true);
    fire(reset, 'click');
    expect(img.style.transform).toBe('');
    fire(zoomIn, 'click');
    const t = transform(img);
    expect(t.scale).toBe(1.5);
    expect(t.tx).toBeCloseTo(-200);
    expect(t.ty).toBeCloseTo(-112.5);
  });

  it('pans by dragging but never past the image edges', () => {
    fire(zoomIn, 'click'); // 1.5×, centred at (-200, -112.5)
    fire(viewport, 'pointerdown', { pointerId: 1, clientX: 400, clientY: 200 });
    fire(viewport, 'pointermove', { pointerId: 1, clientX: 450, clientY: 230 });
    expect(transform(img)).toMatchObject({ tx: -150, ty: -82.5 });
    fire(viewport, 'pointermove', { pointerId: 1, clientX: 2000, clientY: 2000 });
    expect(transform(img)).toMatchObject({ tx: 0, ty: 0 });
    fire(viewport, 'pointerup', { pointerId: 1 });
    expect(viewport.classList.contains('is-dragging')).toBe(false);
  });

  it('pinch zooms with two pointers', () => {
    fire(viewport, 'pointerdown', { pointerId: 1, clientX: 300, clientY: 200 });
    fire(viewport, 'pointerdown', { pointerId: 2, clientX: 500, clientY: 200 });
    fire(viewport, 'pointermove', { pointerId: 2, clientX: 700, clientY: 200 });
    expect(transform(img).scale).toBeCloseTo(2);
  });

  it('double-click toggles between 1× and 2.5×', () => {
    fire(viewport, 'dblclick', { clientX: 400, clientY: 225 });
    expect(transform(img).scale).toBe(2.5);
    fire(viewport, 'dblclick', { clientX: 400, clientY: 225 });
    expect(img.style.transform).toBe('');
  });

  it('supports keyboard shortcuts when the viewport has focus', () => {
    fire(viewport, 'keydown', { key: '+' });
    expect(transform(img).scale).toBe(1.5);
    fire(viewport, 'keydown', { key: 'Escape' });
    expect(img.style.transform).toBe('');
  });
});
