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

/** Spherical interpolation of unit quaternions (any order), the short way round */
export function slerp(a, b, f) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  if (dot > 0.9995) {
    const out = a.map((v, i) => v + (sign * b[i] - v) * f);
    const n = Math.hypot(...out) || 1;
    return out.map((v) => v / n);
  }
  const theta = Math.acos(Math.min(1, dot));
  const s = Math.sin(theta);
  const ka = Math.sin((1 - f) * theta) / s;
  const kb = (sign * Math.sin(f * theta)) / s;
  return a.map((v, i) => ka * v + kb * b[i]);
}

/** Two states' body poses, a fraction `f` of the way from `a` to `b` */
export function blendBodies(a, b, f) {
  const out = {};
  for (const [id, pb] of Object.entries(b)) {
    const pa = a[id];
    out[id] = pa ? { p: pa.p.map((v, i) => v + (pb.p[i] - v) * f), q: slerp(pa.q, pb.q, f) } : pb;
  }
  return out;
}

/**
 * Smooth drawing of a state stream. The session publishes at most 60 states a second, unevenly (the network bunches
 * them), while the browser draws at its own frame rate: drawing the latest state as it lands makes bodies jump and
 * stall. Instead the viewer draws a moment (`delay` s of wall time) behind the newest state, at simulation time
 * running at the pace the stream advances, each body interpolated between the two states around that time. Paused,
 * it settles on the newest state; going back in time (reset) starts over. Every pose drawn is still one Chrono gave,
 * or between two consecutive ones.
 *
 * `push(state, wallMs)` for each state received; `frame(wallMs)` once per drawn frame → the state to draw (the newer
 * of the two states, with `bodies` interpolated and `t` the time drawn), or null before any state.
 */
export function smoothPlayback(delay = 0.08) {
  let samples = []; // { state, wall } by simulation time, the last second or so
  let clock = null;
  let drawn = null;
  const newest = () => samples[samples.length - 1];

  /** Simulated seconds per wall second over the last half second of the stream */
  const rate = () => {
    const last = newest();
    const ref = samples.find((s) => s.wall >= last.wall - 500) ?? last;
    return last.wall > ref.wall ? Math.max(0, (last.state.t - ref.state.t) / ((last.wall - ref.wall) / 1000)) : 0;
  };

  return {
    push(state, wall) {
      const last = newest();
      if (last && state.t < last.state.t - 1e-9) {
        // Back in time: a reset (an action since, so a new seq) starts over; an older state arriving late is dropped
        if (!(state.seq > last.state.seq)) return;
        samples = [];
        clock = null;
      }
      if (last && samples.length && Math.abs(state.t - last.state.t) <= 1e-12) {
        // The same instant (paused, an action): what it shows now, but the stream's pace still counts from before
        samples[samples.length - 1] = { state, wall: last.wall };
      } else {
        samples.push({ state, wall });
      }
      while (samples.length > 2 && samples[1].state.t < state.t - 1) samples.shift();
    },
    frame(wall) {
      const last = newest();
      if (!last) return null;
      const dt = drawn === null ? 0 : Math.min(0.1, Math.max(0, (wall - drawn) / 1000));
      drawn = wall;
      const r = last.state.running ? rate() : 0;
      const latest = last.state.t;
      const target = latest - delay * r;
      if (clock === null || Math.abs(target - clock) > Math.max(0.25, r * 0.5)) {
        clock = target;
      } else {
        // At the stream's pace, eased towards `delay` behind it; paused, towards the newest state
        clock += dt * r;
        clock += (target - clock) * Math.min(1, dt * (last.state.running ? 4 : 15));
      }
      clock = Math.min(latest, Math.max(samples[0].state.t, clock));
      let i = samples.length - 1;
      while (i > 0 && samples[i - 1].state.t > clock) i--;
      const b = samples[i].state;
      const a = i > 0 ? samples[i - 1].state : b;
      const span = b.t - a.t;
      const f = span > 0 ? Math.min(1, Math.max(0, (clock - a.t) / span)) : 1;
      return { ...b, t: clock, bodies: f >= 1 ? b.bodies : blendBodies(a.bodies, b.bodies, f) };
    },
  };
}

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
