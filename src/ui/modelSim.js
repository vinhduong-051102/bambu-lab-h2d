/**
 * A 3D model's own simulation (docs/model-simulation.md): its states as the dashboard names them, and where one of
 * its components is and how fast it moves, from the pose of the body it moves with (a live session's state).
 */

export const MODEL_SIM_STATES = {
  NOT_CONFIGURED: { color: 'default', text: 'Chưa cấu hình' },
  NEEDS_VALIDATION: { color: 'warning', text: 'Cần kiểm tra lại' },
  INVALID: { color: 'error', text: 'Chưa hợp lệ' },
  READY: { color: 'success', text: 'Sẵn sàng' },
  RUNNING: { color: 'processing', text: 'Đang chạy' },
  PAUSED: { color: 'gold', text: 'Tạm dừng' },
  COMPLETED: { color: 'success', text: 'Đã chạy xong' },
  FAILED: { color: 'error', text: 'Chạy lỗi' },
};

/** States in which the current revision may be opened in the viewer */
export const CAN_SIMULATE = new Set(['READY', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED']);

/** v rotated by the unit quaternion q = [w, x, y, z] (Chrono's order) */
export function rotate(q, v) {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;
  // t = 2 (q_xyz × v); v' = v + w t + q_xyz × t
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

const conjugate = (q) => [q[0], -q[1], -q[2], -q[3]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * A component's point (its centre of mass, mm, world at t = 0) now: where it is, how far it moved, how fast.
 * initial/pose: the body's {p (m), q} at t = 0 and now; velocity (m/s) and angularVelocity (rad/s) of the body's
 * frame origin, world, when the session reports them (the selected body) — else speed is null.
 */
export function partMotion(pointMm, initial, pose, velocity, angularVelocity) {
  const c0 = pointMm.map((v) => v / 1000);
  const local = rotate(conjugate(initial.q), c0.map((v, i) => v - initial.p[i]));
  const arm = rotate(pose.q, local);
  const now = pose.p.map((v, i) => v + arm[i]);
  const out = {
    position_mm: now.map((v) => v * 1000),
    displacement_mm: Math.hypot(...now.map((v, i) => (v - c0[i]) * 1000)),
    speed_mm_s: null,
    rpm: null,
  };
  if (velocity && angularVelocity) {
    const turn = cross(angularVelocity, arm);
    out.speed_mm_s = Math.hypot(...velocity.map((v, i) => (v + turn[i]) * 1000));
    out.rpm = (Math.hypot(...angularVelocity) * 60) / (2 * Math.PI);
  }
  return out;
}
