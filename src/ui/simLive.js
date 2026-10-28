/**
 * Helpers for the interactive simulation viewer (SimLive): what the session server (mesh3d/sim/live.py) sends is SI,
 * the viewer draws in mm and shows values in the units people read. Plain JS so the tests import it without React
 * or three.js.
 */

/** A motor's SI unit (from the scene) as the unit shown, and the factor from SI to it */
export const MOTOR_DISPLAY = {
  rad: { unit: '°', scale: 180 / Math.PI },
  'rad/s': { unit: '°/s', scale: 180 / Math.PI },
  'N·m': { unit: 'N·m', scale: 1 },
  m: { unit: 'mm', scale: 1000 },
  'm/s': { unit: 'mm/s', scale: 1000 },
  N: { unit: 'N', scale: 1 },
};

export const motorDisplay = (unit) => MOTOR_DISPLAY[unit] ?? { unit, scale: 1 };

/** A value typed in the shown unit, back to SI for the session */
export const toSi = (value, unit) => value / motorDisplay(unit).scale;

/** How the session keeps up with the wall clock: real time, slowed down on purpose, or behind (it cannot keep up) */
export function pace(state) {
  if (!state) return { color: 'default', text: '–' };
  if (state.failed) return { color: 'error', text: 'Lỗi' };
  if (!state.running) return { color: 'default', text: 'Tạm dừng' };
  const rtf = Number(state.rtf) || 0;
  if (state.behind) return { color: 'warning', text: `Chậm hơn thời gian thực: ×${rtf.toFixed(2)}` };
  return { color: 'success', text: Math.abs(state.speed - 1) < 1e-9 ? `Thời gian thực ×${rtf.toFixed(2)}` : `×${rtf.toFixed(2)} (đặt ×${state.speed})` };
}

/** An arrow's length in mm for a vector: proportional up to `cap`, so a large force still fits the view */
export function arrowLength(size, perMm, cap = 150) {
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.min(cap, size / perMm);
}

export const norm = (v) => (Array.isArray(v) ? Math.hypot(...v) : 0);

/** A session state's quaternion [w, x, y, z] as three.js order [x, y, z, w] */
export const threeQuaternion = (q) => [q[1], q[2], q[3], q[0]];

/** Where a viewer's state stream lives, and its polling fallback */
export const liveUrl = (sessionId, rest = '') => `/api/sim/live/${encodeURIComponent(sessionId)}${rest}`;

/**
 * Sends at most one pointer target per frame interval, always the latest: dragging a body sends dozens of moves a
 * second, and a session only needs where the pointer is now. `send` returns a promise; while one is in flight the
 * next target waits, so requests never queue up behind a slow session.
 */
export function latestOnly(send) {
  let pending = null;
  let busy = false;
  const flush = async () => {
    if (busy || pending === null) return;
    const next = pending;
    pending = null;
    busy = true;
    try {
      await send(next);
    } finally {
      busy = false;
      flush();
    }
  };
  return (value) => {
    pending = value;
    flush();
  };
}

/** The example mechanisms (mesh3d/sim/examples) a session opens by name; the drop is the MVP: things fall, hit
 * the ground and can be dragged around */
export const EXAMPLES = [
  { value: 'drop_box', label: 'Hộp và bi rơi xuống nền (va chạm)' },
  { value: 'motor_shaft', label: 'Trục quay có động cơ' },
  { value: 'pendulum', label: 'Con lắc' },
  { value: 'gear_pair', label: 'Cặp bánh răng 20/40 (lý tưởng)' },
  { value: 'gear_contact', label: 'Cặp bánh răng răng tiếp xúc (chậm hơn thời gian thực)' },
];
