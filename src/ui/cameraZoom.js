/**
 * Digital zoom & pan for the camera feed (the printer camera has no optical zoom).
 * Wheel / pinch zoom toward the pointer, drag to pan, double-click toggles, buttons for + / − / reset.
 * The image is scaled with a CSS transform, so the MJPEG stream keeps playing underneath.
 */
const MIN_SCALE = 1;
const MAX_SCALE = 6;
const BUTTON_STEP = 1.5;
const DOUBLE_CLICK_SCALE = 2.5;

export function initCameraZoom({ viewport, img, zoomInBtn, zoomOutBtn, resetBtn, levelLabel }) {
  if (!viewport || !img) return () => {};

  let scale = 1;
  let tx = 0;
  let ty = 0;
  const pointers = new Map();
  let pinch = null; // { distance, scale, mid } at pinch start
  let drag = null; // { x, y, tx, ty } at drag start

  function clampPan() {
    // Keep the scaled image covering the viewport: no empty bands at the edges
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    tx = Math.min(0, Math.max(w - w * scale, tx));
    ty = Math.min(0, Math.max(h - h * scale, ty));
  }

  function apply() {
    clampPan();
    img.style.transform = scale === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    viewport.classList.toggle('is-zoomed', scale > 1);
    if (levelLabel) levelLabel.textContent = `${scale.toFixed(1)}×`;
    if (zoomOutBtn) zoomOutBtn.disabled = scale <= MIN_SCALE;
    if (zoomInBtn) zoomInBtn.disabled = scale >= MAX_SCALE;
    if (resetBtn) resetBtn.disabled = scale === 1;
  }

  /** Zoom to `next`, keeping the image point under (px, py) — viewport coordinates — fixed */
  function zoomAt(next, px, py) {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (clamped === scale) return;
    const ratio = clamped / scale;
    tx = px - (px - tx) * ratio;
    ty = py - (py - ty) * ratio;
    scale = clamped;
    if (scale === 1) {
      tx = 0;
      ty = 0;
    }
    apply();
  }

  const center = () => [viewport.clientWidth / 2, viewport.clientHeight / 2];
  const localPoint = (e) => {
    const rect = viewport.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  function onWheel(e) {
    e.preventDefault();
    const [px, py] = localPoint(e);
    // Trackpads send small deltas, mouse wheels ~100 per notch: scale smoothly with the delta
    zoomAt(scale * Math.exp(-e.deltaY * 0.0015), px, py);
  }

  function onDoubleClick(e) {
    if (e.target.closest('button')) return;
    const [px, py] = localPoint(e);
    zoomAt(scale > 1 ? 1 : DOUBLE_CLICK_SCALE, px, py);
  }

  function pinchState() {
    const [a, b] = [...pointers.values()];
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      mid: [(a.x + b.x) / 2, (a.y + b.y) / 2],
    };
  }

  function onPointerDown(e) {
    // Let clicks on the overlay controls through
    if (e.target.closest('button')) return;
    pointers.set(e.pointerId, { x: localPoint(e)[0], y: localPoint(e)[1] });
    viewport.setPointerCapture?.(e.pointerId);

    if (pointers.size === 2) {
      drag = null;
      pinch = { ...pinchState(), scale };
    } else if (pointers.size === 1 && scale > 1) {
      const p = pointers.get(e.pointerId);
      drag = { x: p.x, y: p.y, tx, ty };
      viewport.classList.add('is-dragging');
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const [x, y] = localPoint(e);
    pointers.set(e.pointerId, { x, y });

    if (pinch && pointers.size === 2) {
      const now = pinchState();
      zoomAt(pinch.scale * (now.distance / pinch.distance), now.mid[0], now.mid[1]);
    } else if (drag) {
      tx = drag.tx + (x - drag.x);
      ty = drag.ty + (y - drag.y);
      apply();
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      drag = null;
      viewport.classList.remove('is-dragging');
    }
  }

  function onKeyDown(e) {
    if (e.key === '+' || e.key === '=') zoomAt(scale * BUTTON_STEP, ...center());
    else if (e.key === '-' || e.key === '_') zoomAt(scale / BUTTON_STEP, ...center());
    else if (e.key === '0' || e.key === 'Escape') zoomAt(1, 0, 0);
    else return;
    e.preventDefault();
  }

  const onZoomIn = () => zoomAt(scale * BUTTON_STEP, ...center());
  const onZoomOut = () => zoomAt(scale / BUTTON_STEP, ...center());
  const onReset = () => zoomAt(1, 0, 0);
  const onResize = () => apply();

  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('dblclick', onDoubleClick);
  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerUp);
  viewport.addEventListener('pointercancel', onPointerUp);
  viewport.addEventListener('keydown', onKeyDown);
  zoomInBtn?.addEventListener('click', onZoomIn);
  zoomOutBtn?.addEventListener('click', onZoomOut);
  resetBtn?.addEventListener('click', onReset);
  window.addEventListener('resize', onResize);
  apply();

  return () => {
    viewport.removeEventListener('wheel', onWheel);
    viewport.removeEventListener('dblclick', onDoubleClick);
    viewport.removeEventListener('pointerdown', onPointerDown);
    viewport.removeEventListener('pointermove', onPointerMove);
    viewport.removeEventListener('pointerup', onPointerUp);
    viewport.removeEventListener('pointercancel', onPointerUp);
    viewport.removeEventListener('keydown', onKeyDown);
    zoomInBtn?.removeEventListener('click', onZoomIn);
    zoomOutBtn?.removeEventListener('click', onZoomOut);
    resetBtn?.removeEventListener('click', onReset);
    window.removeEventListener('resize', onResize);
    img.style.transform = '';
  };
}
