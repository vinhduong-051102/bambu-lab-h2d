"""
Acceptance of a 3D model simulated in the dashboard's viewer (docs/model-simulation.md), against the running
containers (gateway, mesh3d, sim-live): the same requests the page makes. Models are imported as files (workflow B),
set up and edited through /api/mech, run in a live Chrono session; every check reads the solver's state.

    python mesh3d/mech/tests/live_check.py [gateway URL] [crank component STLs folder]

1  a block of known mass dropped on a plate: falls, comes to rest on it (contact), Reset puts it back
2  a disk on a bearing driven at 60 rpm: turns at the motor's law, the speed read back from the solver
3  crank-slider: the slider follows r cos θ + √(L² − r² sin² θ) for the crank angle the solver reports
4  a parameter changed: a new revision, validated; the old session and runs belong to the old one
5  a joint contradicting the motor: refused before any session, naming the part and joint
"""

import base64
import json
import math
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

GATEWAY = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
CRANK_DIR = Path(sys.argv[2]) if len(sys.argv) > 2 else None
results = []
opened = []  # live sessions this check opened, stopped at the end whatever happens


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(GATEWAY + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=600) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def ok(path, body=None, method="POST"):
    status, data = call(method, path, body)
    if status not in (200, 201) or not data.get("success"):
        raise AssertionError(f"{method} {path} → {status}: {data.get('message')} {data.get('details', '')}")
    return data


def check(name, passed, detail):
    results.append((name, passed, detail))
    print(f"{'PASS' if passed else 'FAIL'}  {name}: {detail}", flush=True)


def stl(triangles):
    out = bytearray(80) + struct.pack("<I", len(triangles))
    for tri in triangles:
        out += struct.pack("<12fH", 0, 0, 0, *[c for v in tri for c in v], 0)
    return bytes(out)


def box(centre, size):
    cx, cy, cz = centre
    hx, hy, hz = (s / 2 for s in size)
    v = [(cx + sx * hx, cy + sy * hy, cz + sz * hz) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return stl([t for a, b, c, d in quads for t in ((v[a], v[b], v[c]), (v[a], v[c], v[d]))])


def disk(centre, radius, height, n=48):
    cx, cy, cz = centre
    ring = [(cx + radius * math.cos(2 * math.pi * k / n), cy + radius * math.sin(2 * math.pi * k / n)) for k in range(n)]
    lo, hi, tris = cz - height / 2, cz + height / 2, []
    for k in range(n):
        (x0, y0), (x1, y1) = ring[k], ring[(k + 1) % n]
        tris += [((cx, cy, lo), (x1, y1, lo), (x0, y0, lo)), ((cx, cy, hi), (x0, y0, hi), (x1, y1, hi)),
                 ((x0, y0, lo), (x1, y1, lo), (x1, y1, hi)), ((x0, y0, lo), (x1, y1, hi), (x0, y0, hi))]
    return stl(tris)


def import_model(name, files):
    sources = [{"filename": f, "data_base64": base64.b64encode(data).decode()} for f, data in files.items()]
    return ok("/api/eng/inspect", {"sources": sources, "name": name})["model"]


def setup(model_id, changes):
    status = ok("/api/mech/models/setup", {"model_id": model_id})
    ok(f"/api/mech/designs/{status['design_id']}", {"changes": changes, "note": "live_check"})
    return ok(f"/api/mech/models/{model_id}", method="GET")


def open_live(design_id, body):
    live = ok(f"/api/mech/designs/{design_id}/live", body)
    opened.append(live["session_id"])
    return live


def act(session, action):
    return ok(f"/api/sim/live/{session}/actions", action)["state"]


def state(session):
    return ok(f"/api/sim/live/{session}/state", method="GET")["state"]


def wait_until(session, t):
    while True:
        s = state(session)
        if s["t"] >= t or s.get("failed"):
            return s
        time.sleep(0.1)


def test_drop():
    model = import_model("drop", {"plate.stl": box((0, 0, -5), (200, 200, 10)), "block.stl": box((0, 0, 30), (20, 20, 20))})
    first = ok("/api/mech/models/setup", {"model_id": model["model_id"]})
    check("1 nothing invented", first["state"] == "INVALID",
          f"{first['state']}: {first.get('reason', '')[:90]}")
    s = setup(model["model_id"], {
        "parts": [{"id": "plate", "fixed": True, "collision": True, "friction": 0.5},
                  {"id": "block", "mass": 0.1, "collision": True, "friction": 0.5}],
        "simulation": {"duration": 2, "time_step": 0.001, "gravity": [0, 0, -9.81]}})
    check("1 ready", s["state"] == "READY", f"{s['state']} r{s['revision']} {s.get('reason') or ''}")
    live = open_live(s["design_id"], {"revision": s["revision"], "paused": True})
    session = live["session_id"]
    start = state(session)
    act(session, {"action": "resume"})
    falling = wait_until(session, 0.15)
    rest = wait_until(session, 1.5)
    act(session, {"action": "select", "body": "block"})
    sel = state(session)["selected"]
    z0, z1, z2 = (x["bodies"]["block"]["p"][2] * 1000 for x in (start, falling, rest))
    # Free fall for 0.15 s: ½ g t² = 110 mm unless it landed (20 mm down): it must have gone down
    check("1 falls under gravity", z1 < z0 - 5, f"z {z0:.2f} → {z1:.2f} mm at t {falling['t']:.3f} s")
    check("1 rests on the plate", abs(z2 + 20) < 2.0 and rest["contacts"] > 0 and math.hypot(*sel["velocity"]) < 0.01,
          f"block moved {z2:.2f} mm (expected −20: bottom on the plate top), contacts {rest['contacts']}, "
          f"speed {math.hypot(*sel['velocity']) * 1000:.2f} mm/s")
    # Back to the start and held there (a plain reset rewinds and keeps running, as the viewer's button does)
    reset = act(session, {"action": "reset", "paused": True})
    check("1 reset", reset["t"] == 0 and not reset["running"] and abs(reset["bodies"]["block"]["p"][2]) < 1e-9,
          f"t {reset['t']}, block z {reset['bodies']['block']['p'][2] * 1000:.3f} mm")
    ok(f"/api/sim/live/{session}/stop", {})


def test_rotation():
    model = import_model("spin", {"frame.stl": box((0, 0, -5), (120, 120, 10)), "disk.stl": disk((0, 0, 5), 40, 10)})
    s = setup(model["model_id"], {
        "parts": [{"id": "frame", "fixed": True}, {"id": "disk", "material": "pla"}],
        "joints": [{"id": "bearing", "type": "revolute", "part_a": "frame", "part_b": "disk", "position": [0, 0, 0], "axis": [0, 0, 1]}],
        "motors": [{"id": "motor", "joint": "bearing", "speed_rpm": 60, "ramp_s": 0.2}],
        "simulation": {"duration": 2, "time_step": 0.001}})
    check("2 ready", s["state"] == "READY", f"{s['state']} {s.get('reason') or ''}")
    live = open_live(s["design_id"], {"revision": s["revision"]})
    session = live["session_id"]
    act(session, {"action": "select", "body": "disk"})
    later = wait_until(session, 1.0)
    rate = later["motors"]["motor"]["rate"]
    omega = later["selected"]["angular_velocity"][2]
    check("2 turns at the motor law", abs(rate - 2 * math.pi) < 1e-3 and abs(omega - 2 * math.pi) < 1e-3,
          f"motor {rate * 60 / (2 * math.pi):.4f} rpm, disk {omega * 60 / (2 * math.pi):.4f} rpm (law: 60) at t {later['t']:.2f} s")
    status = ok(f"/api/mech/models/{model['model_id']}", method="GET")
    check("2 state from the session", status["state"] == "RUNNING" and status["live"]["session_id"] == session,
          f"{status['state']}, live {status['live']}")
    act(session, {"action": "pause"})
    status = ok(f"/api/mech/models/{model['model_id']}", method="GET")
    check("2 paused", status["state"] == "PAUSED", status["state"])
    ok(f"/api/sim/live/{session}/stop", {})


def test_crank_slider():
    if CRANK_DIR is None:
        check("3 crank-slider", False, "no component folder given")
        return
    files = {p.name: p.read_bytes() for p in sorted(CRANK_DIR.glob("*.stl"))}
    model = import_model("crank_slider", files)
    r, L = 30.0, 100.0
    joints = [
        {"id": "crank_pivot", "type": "revolute", "part_a": "base", "part_b": "crank", "position": [0, 0, -3], "axis": [0, 0, 1]},
        {"id": "crank_pin", "type": "revolute", "part_a": "crank", "part_b": "rod", "position": [r, 0, 3], "axis": [0, 0, 1]},
        {"id": "wrist_pin", "type": "revolute", "part_a": "rod", "part_b": "slider", "position": [r + L, 0, 9], "axis": [0, 0, 1]},
        {"id": "slide", "type": "prismatic", "part_a": "base", "part_b": "slider", "position": [r + L, 0, 12], "axis": [1, 0, 0]}]
    s = setup(model["model_id"], {
        "parts": [{"id": "base", "fixed": True, "role": "frame"}, {"id": "crank", "material": "pla"},
                  {"id": "rod", "material": "pla"}, {"id": "slider", "material": "pla"}],
        "joints": joints, "motors": [{"id": "drive", "joint": "crank_pivot", "speed_rpm": 60, "ramp_s": 0.25}],
        "simulation": {"duration": 2, "time_step": 0.0005}})
    dof = s["validation"]["dof"]
    check("3 ready, one DOF driven", s["state"] == "READY" and dof["mobility"] == 1 and dof["driven"] == 0,
          f"{s['state']}, mobility {dof['mobility']}, undriven {dof['driven']}, redundant {dof.get('redundant_equations')}")
    live = open_live(s["design_id"], {"revision": s["revision"]})
    session = live["session_id"]
    parts = {b["id"]: [p["id"] for p in b.get("parts", [])] for b in live["scene"]["bodies"]}
    check("3 each component drawn on its body", parts == {"ground": ["base"], "crank": ["crank"], "rod": ["rod"], "slider": ["slider"]}, str(parts))
    worst, side, samples = 0.0, 0.0, 0
    until = time.time() + 2.5
    while time.time() < until:
        st = state(session)
        theta = st["motors"]["drive"]["value"]
        x = st["bodies"]["slider"]["p"]
        expected = r * math.cos(theta) + math.sqrt(L * L - (r * math.sin(theta)) ** 2) - (r + L)
        worst = max(worst, abs(x[0] * 1000 - expected))
        side = max(side, abs(x[1] * 1000), abs(x[2] * 1000))
        samples += 1
        time.sleep(0.05)
    check("3 slider follows the crank", worst < 0.1 and samples > 20,
          f"{samples} states up to t {st['t']:.2f} s (crank {math.degrees(theta):.0f}°): worst error {worst:.4f} mm, off-axis {side:.5f} mm")
    return model, s, session


def test_edit_and_invalid(model, s, session):
    design = s["design_id"]
    run = ok(f"/api/mech/designs/{design}/simulate", {"revision": s["revision"], "wait_s": 300})
    check("4 recorded run", run["state"] == "completed" and run["status"] == "passed",
          f"{run['sim_id']} r{run['revision']}: {run['state']}, {run.get('status')}")
    edited = ok(f"/api/mech/designs/{design}", {"changes": {"motors": [{"id": "drive", "speed_rpm": 30}]}, "note": "chậm lại"})
    status = ok(f"/api/mech/models/{model['model_id']}", method="GET")
    old_runs = [(x["revision"], x["current"]) for x in status["runs"]]
    check("4 new revision, validated", edited["revision"] == s["revision"] + 1 and status["state"] == "READY",
          f"r{s['revision']} → r{edited['revision']} ({edited['status']}), state {status['state']}")
    check("4 old results stay with their revision", old_runs == [(s["revision"], False)] and status["live"] is None
          and status.get("live_stale", [{}])[0].get("revision") == s["revision"],
          f"runs {old_runs}, live {status['live']}, stale sessions {status.get('live_stale')}")
    ok(f"/api/sim/live/{session}/stop", {})
    bad = ok(f"/api/mech/designs/{design}", {"changes": {"joints": [
        {"id": "weld", "type": "fixed", "part_a": "base", "part_b": "crank", "position": [0, 0, -3]}]}, "note": "khớp mâu thuẫn"})
    code, refused = call("POST", f"/api/mech/designs/{design}/live", {})
    named = [(d["code"], d.get("parts"), d.get("joints")) for d in (refused.get("details") or {}).get("diagnostics", [])]
    sessions = ok("/api/sim/live", method="GET")["sessions"]
    check("5 contradiction refused", bad["status"] == "failed" and code == 422 and not any(
        x["source"].get("design_id") == design for x in sessions), f"HTTP {code}: {named}")
    check("5 names the part and joint", any("crank" in (p or []) for _, p, _ in named) and any("weld" in (j or []) for _, _, j in named), str(named))
    state_now = ok(f"/api/mech/models/{model['model_id']}", method="GET")
    check("5 state INVALID", state_now["state"] == "INVALID", f"{state_now['state']}: {state_now.get('reason', '')[:120]}")


if __name__ == "__main__":
    for test in (test_drop, test_rotation):
        try:
            test()
        except Exception as err:  # noqa: BLE001 - report and go on
            check(test.__name__, False, f"{type(err).__name__}: {err}")
    try:
        found = test_crank_slider()
        if found:
            test_edit_and_invalid(*found)
    except Exception as err:  # noqa: BLE001
        check("3–5", False, f"{type(err).__name__}: {err}")
    for session in opened:
        call("POST", f"/api/sim/live/{session}/stop", {})
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)
