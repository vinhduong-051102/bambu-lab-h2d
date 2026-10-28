"""
A finished Chrono run read back in the model's terms: per part (through its rigid group), per joint, per gear pair
and per motor, with what kinematics predicted beside what the dynamics gave.

Checks (status passed / warning / failed / not_verified):
- the run's own checks (finite values, constraint violation, motor laws, gear ratios against theory)
- each moving part's steady speed (last quarter of the run) against the kinematic velocity solution
- a slider's position against the kinematic position solution at the same motor angle (linkages)
Forces are reactions of ideal joints (rigid bodies): what a joint or an ideal gear pair transmits, not a stress.
"""

import csv
import math
from pathlib import Path

import numpy as np


def check(cid, status, title, detail="", expected=None, simulated=None, tolerance=None, unit=None, refs=None):
    out = {"id": cid, "status": status, "title": title, "detail": detail}
    for k, v in (("expected", expected), ("simulated", simulated), ("tolerance", tolerance), ("unit", unit), ("refs", refs)):
        if v is not None:
            out[k] = v
    return out


def read_rows(path, key):
    out = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            out.setdefault(row[key], []).append(row)
    return out


def tail(rows, share=0.25):
    return rows[int(len(rows) * (1 - share)):] or rows[-1:]


def part_point(asm, pid):
    """The part's own point (mm, world, t = 0): its centre of mass, else its position"""
    placed = asm.placed[pid]
    return np.asarray(placed["props"][1] if placed["props"] else placed["pos"], float)


def part_motion(rows, point_mm):
    """How the part's point moved: a group's body frame sits at the world origin, so the frame's own path says nothing
    about a shaft turning in place. p = x + R c, v = v₀ + ω × R c (c in the body frame = the world at t = 0)"""
    c = point_mm / 1000
    pos, vel = [], []
    for r in rows:
        x = np.array([float(r[k]) for k in ("x", "y", "z")])
        w0, wx, wy, wz = (float(r[k]) for k in ("qw", "qx", "qy", "qz"))
        R = np.array([[1 - 2 * (wy * wy + wz * wz), 2 * (wx * wy - wz * w0), 2 * (wx * wz + wy * w0)],
                      [2 * (wx * wy + wz * w0), 1 - 2 * (wx * wx + wz * wz), 2 * (wy * wz - wx * w0)],
                      [2 * (wx * wz - wy * w0), 2 * (wy * wz + wx * w0), 1 - 2 * (wx * wx + wy * wy)]])
        rc = R @ c
        pos.append(x + rc)
        vel.append(np.array([float(r[k]) for k in ("vx", "vy", "vz")]) + np.cross([float(r[k]) for k in ("wx", "wy", "wz")], rc))
    pos, speed = np.array(pos) * 1000, np.linalg.norm(vel, axis=1) * 1000
    w = np.array([[float(r[k]) for k in ("wx", "wy", "wz")] for r in rows])
    return {"point_mm": [round(float(v), 6) for v in point_mm],
            "travel_mm": float(np.sum(np.linalg.norm(np.diff(pos, axis=0), axis=1))),
            "displacement_mm": float(np.linalg.norm(pos[-1] - pos[0])),
            "max_speed_mm_s": float(np.max(speed)), "steady_speed_mm_s": float(np.mean(speed[int(len(speed) * 0.75):])),
            "max_rpm": float(np.max(np.linalg.norm(w, axis=1)) * 60 / (2 * math.pi))}


def collect(asm, analysis, mapping, run_folder, summary, sweep_data=None):
    """{"parts", "joints", "gears", "motors", "checks", "status"} for a completed run"""
    folder = Path(run_folder)
    bodies = read_rows(folder / "body_transforms.csv", "body")
    items = read_rows(folder / "joint_results.csv", "item")
    checks = []
    for c in summary.get("checks", []):
        status = {True: "passed", False: "failed", None: "not_verified"}[c.get("passed")]
        checks.append(check(f"chrono.{c['id']}", status, c.get("description", c["id"]), c.get("description", ""),
                            c.get("expected"), c.get("measured", c.get("measured_mean")), c.get("tolerance"), c.get("unit"),
                            [c["item"]] if c.get("item") else None))
    expected = analysis.get("velocities") or {}
    spinning = {g for j, a, b in asm.joints if j["type"] in ("revolute", "cylindrical") and "ground" in (a, b)
                for g in (a, b) if g != "ground"}
    parts = {}
    for pid, group in mapping["parts"].items():
        rows = bodies.get(group, [])
        entry = {"group": group, "fixed": group == "ground"}
        if rows and group != "ground":
            entry.update(part_motion(rows, part_point(asm, pid)))
            w = np.array([[float(r[k]) for k in ("wx", "wy", "wz")] for r in tail(rows)])
            entry["steady_rpm"] = float(np.mean(np.linalg.norm(w, axis=1)) * 60 / (2 * math.pi))
            exp = expected.get(group)
            if exp:
                entry["expected_rpm"] = exp["omega_rpm"]
                # A part turning on a fixed axis (a shaft, a gear) keeps one speed under a steady motor: compare it. A
                # linkage's speeds vary over a turn; its parts are checked by position below
                if group in spinning and exp["omega_rpm"] > 1e-6:
                    err = abs(entry["steady_rpm"] - exp["omega_rpm"])
                    tol = max(0.01 * exp["omega_rpm"], 0.05)
                    checks.append(check(f"speed.{pid}", "passed" if err <= tol else "failed",
                                        f"Tốc độ quay {pid}", f"Mô phỏng {entry['steady_rpm']:.4g} vòng/phút, động học dự đoán "
                                        f"{exp['omega_rpm']:.4g} vòng/phút.", round(exp["omega_rpm"], 6),
                                        round(entry["steady_rpm"], 6), round(tol, 6), "vòng/phút", [pid]))
        parts[pid] = entry
    joints = {}
    for jid, info in mapping["joints"].items():
        rows = items.get(info["sim_joint"], [])
        s = summary["joints"].get(info["sim_joint"], {})
        joints[jid] = {"type": s.get("kind"), "value_range": s.get("value"), "max_reaction_force_N": s.get("max_reaction_force_N"),
                       "max_reaction_torque_Nm": s.get("max_reaction_torque_Nm"), "samples": len(rows)}
    gears = {}
    for gid, info in mapping["gears"].items():
        rows = items.get(info["sim_joint"], [])
        f = [np.linalg.norm([float(r[k]) for k in ("fx", "fy", "fz")]) for r in tail(rows)] if rows else []
        gears[gid] = {"steady_force_N": float(np.mean(f)) if f else None,
                      "max_force_N": summary["joints"].get(info["sim_joint"], {}).get("max_reaction_force_N"),
                      "note": "Phản lực của ràng buộc bánh răng lý tưởng (không phải ứng suất răng)"}
    motors = {}
    for mid, info in mapping["motors"].items():
        rows = items.get(info["sim_actuator"], [])
        effort = [float(r["effort"]) for r in tail(rows) if r["effort"] != ""]
        motors[mid] = {"steady_effort": float(np.mean(effort)) if effort else None,
                       "unit": "N·m" if rows and rows[0]["kind"] == "rotational_motor" else "N",
                       "range": summary["joints"].get(info["sim_actuator"], {}).get("effort")}
    # Linkages: slider positions against the kinematic solution at the same motor angle
    if sweep_data:
        motor_id, samples = sweep_data["motor"], sweep_data["samples"]
        span = samples[-1]["motor"]
        mrows = items.get(mapping["motors"][motor_id]["sim_actuator"], [])
        for jid in samples[0]["joints"]:
            jrows = items.get(mapping["joints"][jid]["sim_joint"], [])
            if not jrows or not mrows:
                continue
            angles = np.array([s["motor"] for s in samples])
            pred = np.array([s["joints"][jid] for s in samples])  # mm
            errs = []
            for mr, jr in zip(mrows, jrows):
                a = float(mr["value"]) % span
                sim_mm = float(jr["value"]) * 1000
                errs.append(abs(sim_mm - float(np.interp(a, angles, pred))))
            err = max(errs)
            checks.append(check(f"kinematics.{jid}", "passed" if err <= 0.1 else "failed", f"Vị trí {jid} theo góc động cơ",
                                f"Lệch lớn nhất {err:.3g} mm so với lời giải động học (hành trình {np.ptp(pred):.4g} mm).",
                                round(float(np.ptp(pred)), 6), None, 0.1, "mm", [jid, motor_id]))
            joints[jid]["stroke_mm_kinematic"] = float(np.ptp(pred))
            joints[jid]["stroke_mm_simulated"] = float(np.ptp([float(r["value"]) * 1000 for r in jrows]))
    worst = "passed"
    for c in checks:
        if c["status"] == "failed":
            worst = "failed"
        elif c["status"] in ("warning", "not_verified") and worst == "passed":
            worst = "warning"
    return {"parts": parts, "joints": joints, "gears": gears, "motors": motors, "checks": checks, "status": worst,
            "analysis_kind": "rigid_body_dynamics",
            "note": "Mô phỏng vật rắn: chuyển động, vận tốc, phản lực; không có ứng suất/biến dạng (dùng FEA cho từng chi tiết)."}
