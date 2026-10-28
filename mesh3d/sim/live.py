"""
Interactive simulation (docs/interactive-physics.md): a Chrono system kept alive and stepped against the wall clock
while a viewer watches and acts on it. The system is chrono_run.Model, the one offline runs use, so a mechanism
behaves the same in both; only how time advances and what the user may do differ. Runs in Chrono's Python:

    /opt/chrono/bin/python /opt/mesh3d/sim/live.py          (serves on PORT, default 8000)

  GET  /health                     {"ok", "sessions"}
  POST /live                       {"mechanism"} | {"mechanism_id"} | {"example"} (sim/examples/<name>.json) |
                                   {"sim_id"} (a run's model, as it ran), with
                                   "simulation"? overrides and "paused"?: starts a session → its scene and state
  GET  /live                       The sessions
  GET  /live/<id>                  The scene (bodies, geometry, joints, motors, springs) and the latest state
  GET  /live/<id>/state            The latest state
  GET  /live/<id>/stream?hz=30     Server-Sent Events: the state, at most hz times a second
  POST /live/<id>/actions          {"action", ...}: see ACTIONS
  POST /live/<id>/stop             Ends the session
  GET  /live/<id>/mesh/<body id>   The body's mesh file, for the viewer

Everything is SI, as the result files: m, kg, s, rad, N, N·m; positions and vectors in the world (Z up).

Time: the physics step is the mechanism's fixed time_step. Each frame (FRAME_S) the session steps until simulated
time catches up with wall time × speed, for at most STEP_BUDGET of the frame; what it could not do is dropped rather
than owed (so a slow mechanism never spirals), and the state says `behind` with the real-time factor it reached.
Only the physics thread touches Chrono: HTTP handlers queue actions, applied between steps.
"""

import copy
import json
import math
import os
import re
import secrets
import sys
import threading
import time
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import pychrono as ch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from sim import chrono_run as cr  # noqa: E402
from sim import runs, schema  # noqa: E402 - the same mechanisms, files and runs as the offline worker

PORT = int(os.environ.get("PORT", "8000"))
MAX_SESSIONS = int(os.environ.get("SIM_LIVE_MAX_SESSIONS", "2"))
# A session nobody streams or acts on for this long is stopped, so a closed tab frees the CPU
IDLE_S = float(os.environ.get("SIM_LIVE_IDLE_S", "600"))
FRAME_S = 1 / 120
STEP_BUDGET = 0.75
# A stall longer than this (the machine busy, a debugger) is not caught up
MAX_CATCH_UP_S = 0.1
# Recorded for the viewer's charts and the export: every RECORD_S of simulated time, the last RECORD_KEEP samples
RECORD_S = 0.02
RECORD_KEEP = 3000
ID_RE = re.compile(r"^l-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$")
EXAMPLES = Path(__file__).resolve().parent / "examples"

# Dragging: a hand pulling the grabbed point towards the pointer, a critically damped spring at DRAG_HZ that also
# carries the body's weight, never more than DRAG_MAX_G times that weight (or DRAG_MIN_N)
DRAG_HZ = 3.0
DRAG_MAX_G = 20.0
DRAG_MIN_N = 5.0


class LiveError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def vector(value, what, size=3):
    try:
        out = np.asarray(value, float).reshape(size)
    except (TypeError, ValueError):
        raise LiveError(400, "BAD_ACTION", f"{what} phải là mảng {size} số.") from None
    if not np.isfinite(out).all():
        raise LiveError(400, "BAD_ACTION", f"{what} phải là số hữu hạn.")
    return out


def number(value, what, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise LiveError(400, "BAD_ACTION", f"{what} phải là số từ {low:g} đến {high:g}.")
    return float(value)


class LiveModel(cr.Model):
    """chrono_run.Model, remembering each colliding body's contact material for the viewer"""

    def add_collision(self, body, b):
        super().add_collision(body, b)
        self.materials = getattr(self, "materials", {})
        self.materials[b["id"]] = self.keep[-2]


def load_model(request):
    """(SI model, where it came from, warnings, the mechanism as written or None) for a session: a mechanism (inline,
    stored or an example), normalised as runs are, or a run's model.json exactly as it ran"""
    simulation = request.get("simulation")
    if simulation is not None and not isinstance(simulation, dict):
        raise LiveError(400, "BAD_SIMULATION", "simulation phải là object.")
    if request.get("sim_id"):
        try:
            folder = runs.run_dir(str(request["sim_id"]))
        except runs.SimError as err:
            raise LiveError(err.status, err.code, err.message) from None
        model = runs.read_json(folder / "model.json")
        if model is None:
            raise LiveError(404, "SIM_NOT_FOUND", "Lần chạy không có model.json.")
        if simulation:
            model["simulation"].update({k: v for k, v in simulation.items() if k in ("time_step", "gravity")})
        return model, {"sim_id": request["sim_id"]}, [], runs.read_json(folder / "mechanism.json")
    mechanism, source = request.get("mechanism"), {}
    if mechanism is None and request.get("example"):
        name = str(request["example"])
        path = EXAMPLES / f"{name}.json"
        if not re.fullmatch(r"[a-z0-9_]{1,40}", name) or not path.is_file():
            raise LiveError(404, "EXAMPLE_NOT_FOUND", f"Không có ví dụ {name!r}: {', '.join(examples())}.")
        mechanism, source = json.loads(path.read_text(encoding="utf-8")), {"example": name}
    if mechanism is None and request.get("mechanism_id"):
        try:
            mechanism = runs.load_mechanism(str(request["mechanism_id"]))
        except runs.SimError as err:
            raise LiveError(err.status, err.code, err.message) from None
        source = {"mechanism_id": request["mechanism_id"]}
    if not isinstance(mechanism, dict):
        raise LiveError(400, "NO_MECHANISM", "Cần mechanism, mechanism_id, example hoặc sim_id.")
    if simulation:
        mechanism = {**mechanism, "simulation": {**(mechanism.get("simulation") or {}), **simulation}}
    try:
        result = runs.normalise(mechanism)
    except schema.MechanismError as err:
        raise LiveError(422, "INVALID_MECHANISM", f"Cơ cấu chưa hợp lệ: {err}") from None
    model = result["model"]
    if any(b.get("collision") and (b.get("geometry") or {}).get("type") == "mesh" for b in model["bodies"]):
        # Their convex hulls come from trimesh, which Chrono's Python does not have: the offline run computes them
        try:
            runs.prepare(model)
        except ImportError:
            raise LiveError(422, "MESH_COLLISION_NEEDS_RUN",
                            "Body va chạm dạng mesh cần bao lồi: chạy cơ cấu một lần (sim_run_simulation) rồi mở "
                            "phiên tương tác bằng sim_id của lần chạy đó.") from None
    return model, source, result["warnings"], mechanism


def examples():
    """The example mechanisms a session can open by name"""
    return sorted(p.stem for p in EXAMPLES.glob("*.json"))


def attached_bodies(model):
    """Bodies a joint, motor or spring holds: they cannot be teleported without breaking it"""
    out = set()
    for item in model["joints"] + model["actuators"] + model["forces"]:
        if item["type"] not in ("force", "torque"):
            out.update(item.get(k) for k in ("body_a", "body_b"))
    out.discard(None)
    return out


def apply_overrides(model, overrides):
    """Initial conditions changed for a reset: gravity, a body's friction, a free body's position or velocity"""
    if not isinstance(overrides, dict):
        raise LiveError(400, "BAD_ACTION", "overrides phải là object.")
    bodies = {b["id"]: b for b in model["bodies"]}
    held = attached_bodies(model)

    def body(bid, what):
        if bid not in bodies:
            raise LiveError(404, "BODY_NOT_FOUND", f"{what}: không có body {bid!r}.")
        return bodies[bid]

    if "gravity" in overrides:
        model["simulation"]["gravity"] = vector(overrides["gravity"], "overrides.gravity").tolist()
    for bid, mu in (overrides.get("friction") or {}).items():
        b = body(bid, "overrides.friction")
        if not b.get("collision"):
            raise LiveError(409, "NO_COLLISION", f"{bid} không có va chạm nên không có ma sát.")
        b["material"]["friction"] = number(mu, f"overrides.friction.{bid}", 0, 2)
    for bid, p in (overrides.get("position") or {}).items():
        b = body(bid, "overrides.position")
        if bid in held or b["fixed"]:
            raise LiveError(409, "BODY_HELD", f"{bid} cố định hoặc gắn với khớp/motor/lò xo: không đổi vị trí ban đầu được.")
        b["position"] = vector(p, f"overrides.position.{bid}").tolist()
    velocities = {}
    for bid, v in (overrides.get("velocity") or {}).items():
        b = body(bid, "overrides.velocity")
        if b["fixed"]:
            raise LiveError(409, "BODY_FIXED", f"{bid} cố định.")
        velocities[bid] = vector(v, f"overrides.velocity.{bid}")
    return velocities


class Session:
    """One live Chrono system and its physics thread"""

    def __init__(self, model, source, warnings, paused=False, mechanism=None):
        self.id = f"l-{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
        self.source, self.warnings, self.created_at = source, warnings, now()
        # As written, so the same mechanism can be run offline (POST /sim/runs) for its full results and video
        self.mechanism = mechanism
        self.initial = copy.deepcopy(model)
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.actions = deque()
        self.log = []  # every action applied, with the simulated time: what the user did, for the export
        self.seq = 0
        self.stopped = False
        self.touched = time.monotonic()
        self.speed = 1.0
        self.running = not paused
        self.build(copy.deepcopy(model))
        self.publish()
        self.thread = threading.Thread(target=self.loop, name=self.id, daemon=True)
        self.thread.start()

    # ---------- the system ----------

    def build(self, model, velocities=None):
        """(Re)builds the Chrono system from the SI model: the initial conditions, assembled"""
        self.model = model
        self.dt = model["simulation"]["time_step"]
        self.m = LiveModel(model)
        flag = self.m.system.DoAssembly(ch.FULL)
        if flag == ch.ExitFlag_NOT_CONVERGED:
            raise LiveError(422, "ASSEMBLY_FAILED", "Không lắp ráp được cơ cấu ở t = 0: các khớp mâu thuẫn hoặc vị trí ban đầu sai quá xa.")
        for bid, v in (velocities or {}).items():
            self.m.bodies[bid].SetPosDt(cr.V(v))
        self.specs = {b["id"]: b for b in model["bodies"]}
        self.held = attached_bodies(model)
        # One accumulator per moving body for what the user applies (GearContact has its own)
        self.slots = {bid: body.AddAccumulator() for bid, body in self.m.bodies.items() if not self.specs[bid]["fixed"]}
        self.links = {item["id"]: (item, link) for item, link in self.m.links}
        self.motors = {item["id"]: {"enabled": True, "setpoint": None, "drift_correction": True} for item, _ in self.m.links
                       if item["type"] in cr.ACTUATED}
        self.drag = None
        self.pushes = []  # {body, force, torque, point (COM frame), until}
        self.failed = None
        self.budget = 0.0
        self.rtf, self.behind = 0.0, False
        self.window = deque()  # (wall, simulated) over the last second, for the real-time factor
        self.selected = None
        self.samples = deque(maxlen=RECORD_KEEP)
        self.next_record = 0.0
        self.record()

    def time(self):
        return self.m.system.GetChTime()

    def step(self):
        """One physics step: the user's forces and the gear teeth from the state at its start, then Chrono"""
        t = self.time()
        for bid, slot in self.slots.items():
            self.m.bodies[bid].EmptyAccumulator(slot)
        if self.drag:
            self.apply_drag()
        # Half a step's margin: a push for T acts for exactly T / dt steps, whatever the rounding of t
        self.pushes = [p for p in self.pushes if p["until"] > t + self.dt / 2]
        for p in self.pushes:
            body, slot = self.m.bodies[p["body"]], self.slots[p["body"]]
            if p["force"] is not None:
                body.AccumulateForce(slot, cr.V(p["force"]), body.TransformPointLocalToParent(cr.V(p["point"])), False)
            if p["torque"] is not None:
                body.AccumulateTorque(slot, cr.V(p["torque"]), False)
        for mesh in self.m.meshes:
            mesh.apply(self.dt)
        # Chrono sums a body's forces (gravity, accumulators) when it updates, at the end of the step before: without
        # this the user's forces and a gravity just changed would act one step late (checked against 10.0.0)
        # Update() at the current time: Update(False) would be read as Update(time=0.0)
        self.m.system.Update()
        self.m.system.DoStepDynamics(self.dt)
        if self.time() >= self.next_record:
            self.record()

    def apply_drag(self):
        """The grabbed point pulled towards the target by a critically damped spring that also carries the body's
        weight, as a hand would: a finite force, so joints, motors and contacts still decide where the body goes"""
        d = self.drag
        body, slot = self.m.bodies[d["body"]], self.slots[d["body"]]
        mass = body.GetMass()
        omega = 2 * math.pi * DRAG_HZ
        point = np.array(cr.vec(body.TransformPointLocalToParent(cr.V(d["local"]))))
        speed = np.array(cr.vec(body.PointSpeedLocalToParent(cr.V(d["local"]))))
        gravity = np.array(cr.vec(self.m.system.GetGravitationalAcceleration()))
        force = mass * omega**2 * (d["target"] - point) - 2 * mass * omega * speed - mass * gravity
        limit = max(DRAG_MIN_N, DRAG_MAX_G * mass * max(float(np.linalg.norm(gravity)), 9.81))
        size = float(np.linalg.norm(force))
        if size > limit:
            force *= limit / size
        d["force"], d["point"] = force, point
        body.AccumulateForce(slot, cr.V(force), cr.V(point), False)

    def record(self):
        """A sample for the charts and the export: every body's pose and speed"""
        t = self.time()
        sample = {"t": t}
        for bid, body in self.m.bodies.items():
            f = body.GetFrameRefToAbs()
            sample[bid] = cr.vec(f.GetPos()) + cr.quat(f.GetRot()) + cr.vec(f.GetPosDt()) + cr.vec(body.GetAngVelParent())
        if not all(math.isfinite(v) for key, values in sample.items() if key != "t" for v in values):
            raise FloatingPointError(f"Giá trị không hữu hạn tại t = {t:.6g} s: cơ cấu mất ổn định (giảm time_step, "
                                     "kiểm tra khối lượng và độ cứng).")
        self.samples.append(sample)
        self.next_record = t + RECORD_S

    # ---------- the loop ----------

    def loop(self):
        last = time.monotonic()
        while not self.stopped:
            frame = time.monotonic()
            wall, last = frame - last, frame
            self.take_actions()
            simulated = 0.0
            if self.running and not self.failed:
                self.budget += min(wall, MAX_CATCH_UP_S) * self.speed
                wanted = int(self.budget / self.dt + 1e-9)
                done = 0
                deadline = frame + FRAME_S * STEP_BUDGET
                try:
                    while done < wanted and time.monotonic() < deadline:
                        self.step()
                        done += 1
                except Exception as err:  # noqa: BLE001 - an unstable system pauses with the reason
                    self.fail(err)
                simulated = done * self.dt
                self.budget -= simulated
                self.behind = done < wanted
                if self.behind:
                    # Not owed: the session runs as fast as it can, and says so
                    self.budget = 0.0
            self.window.append((frame, simulated))
            while self.window and frame - self.window[0][0] > 1.0:
                self.window.popleft()
            span = frame - self.window[0][0] if len(self.window) > 1 else 0
            self.rtf = sum(s for _, s in list(self.window)[1:]) / span if span > 0.2 else 0.0
            self.publish()
            if time.monotonic() - self.touched > IDLE_S:
                self.stopped = True
            time.sleep(max(0.0, FRAME_S - (time.monotonic() - frame)))
        with self.lock:
            self.changed.notify_all()

    def fail(self, err):
        self.failed = f"{type(err).__name__}: {err}" if not isinstance(err, FloatingPointError) else str(err)
        self.running = False

    def take_actions(self):
        while True:
            with self.lock:
                if not self.actions:
                    return
                action, done = self.actions.popleft()
            try:
                done["result"] = self.act(action)
            except LiveError as err:
                done["error"] = err
            except Exception as err:  # noqa: BLE001 - an action Chrono refuses is the caller's error
                done["error"] = LiveError(422, "ACTION_FAILED", f"{type(err).__name__}: {err}")
            done["event"].set()

    def submit(self, action):
        """Queues an action for the physics thread and waits for its answer"""
        if not isinstance(action, dict) or action.get("action") not in ACTIONS:
            raise LiveError(400, "BAD_ACTION", f"action phải là một trong: {', '.join(ACTIONS)}.")
        if self.stopped:
            raise LiveError(410, "SESSION_STOPPED", "Phiên đã dừng.")
        done = {"event": threading.Event()}
        with self.lock:
            self.actions.append((action, done))
        self.touched = time.monotonic()
        if not done["event"].wait(10):
            raise LiveError(504, "ACTION_TIMEOUT", "Phiên không trả lời kịp.")
        if "error" in done:
            raise done["error"]
        return done["result"]

    # ---------- what the user may do ----------

    def body(self, bid, moving=False):
        if bid not in self.m.bodies:
            raise LiveError(404, "BODY_NOT_FOUND", f"Không có body {bid!r}.")
        if moving and self.specs[bid]["fixed"]:
            raise LiveError(409, "BODY_FIXED", f"{bid} là body cố định.")
        return self.m.bodies[bid]

    def act(self, a):
        kind = a["action"]
        t = self.time()
        if kind != "drag" or not self.drag:
            # Every action but the pointer's moves while dragging, which would flood it
            self.log.append({"t": t, **{k: v for k, v in a.items()}})
        if kind == "pause":
            self.running = False
        elif kind == "resume":
            if self.failed:
                raise LiveError(409, "SESSION_FAILED", f"Mô phỏng đã lỗi: {self.failed}. Reset để chạy lại.")
            self.running, self.budget = True, 0.0
        elif kind == "step":
            if self.failed:
                raise LiveError(409, "SESSION_FAILED", f"Mô phỏng đã lỗi: {self.failed}. Reset để chạy lại.")
            count = int(number(a.get("count", 1), "count", 1, 100000))
            self.running = False
            try:
                for _ in range(count):
                    self.step()
            except Exception as err:  # noqa: BLE001
                self.fail(err)
        elif kind == "reset":
            model = copy.deepcopy(self.initial)
            velocities = apply_overrides(model, a.get("overrides") or {})
            paused = not self.running
            self.build(model, velocities)
            self.running = not paused and not a.get("paused", False)
        elif kind == "speed":
            self.speed = number(a.get("value"), "value", 0.01, 100)
        elif kind == "drag":
            body = self.body(a.get("body"), moving=True)
            target = vector(a.get("target"), "target")
            if not self.drag or self.drag["body"] != a["body"] or a.get("point") is not None:
                point = vector(a.get("point"), "point")
                local = cr.vec(body.TransformPointParentToLocal(cr.V(point)))
                self.drag = {"body": a["body"], "local": local, "target": target, "force": np.zeros(3), "point": point}
            self.drag["target"] = target
        elif kind == "release":
            self.drag = None
        elif kind in ("push", "twist"):
            body = self.body(a.get("body"), moving=True)
            duration = number(a.get("duration", 0.1), "duration", self.dt, 60)
            push = {"body": a["body"], "force": None, "torque": None, "point": [0.0, 0.0, 0.0], "until": t + duration}
            if kind == "push":
                push["force"] = vector(a.get("force"), "force").tolist()
                if a.get("point") is not None:
                    push["point"] = cr.vec(body.TransformPointParentToLocal(cr.V(vector(a["point"], "point"))))
            else:
                push["torque"] = vector(a.get("torque"), "torque").tolist()
            self.pushes.append(push)
        elif kind == "motor":
            item, link = self.links.get(a.get("id"), (None, None))
            if item is None or item["type"] not in cr.ACTUATED:
                raise LiveError(404, "MOTOR_NOT_FOUND", f"Không có motor {a.get('id')!r}.")
            state = self.motors[item["id"]]
            if "value" in a:
                state["setpoint"] = number(a["value"], "value", -1e6, 1e6)
                link.SetMotorFunction(ch.ChFunctionConst(state["setpoint"]))
            if "enabled" in a:
                enable = bool(a["enabled"])
                if enable and not state["enabled"] and item["mode"] == "speed":
                    # A speed motor keeps the angle (position) its law integrates to and pulls the body back to it;
                    # switched off, the body moved freely, so switched back on it would swing back. It drives the
                    # speed alone from now on (drift_correction false in its state).
                    drift = getattr(link, "AvoidAngleDrift", None) or getattr(link, "SetAvoidPositionDrift", None)
                    if drift:
                        drift(False)
                        state["drift_correction"] = False
                state["enabled"] = enable
                link.SetDisabled(not enable)
        elif kind == "gravity":
            self.m.system.SetGravitationalAcceleration(cr.V(vector(a.get("vector"), "vector")))
        elif kind == "spring":
            item, link = self.links.get(a.get("id"), (None, None))
            if item is None or item["type"] not in cr.UNCONSTRAINED:
                raise LiveError(404, "SPRING_NOT_FOUND", f"Không có lò xo {a.get('id')!r}.")
            if "stiffness" in a:
                link.SetSpringCoefficient(number(a["stiffness"], "stiffness", 0, 1e12))
            if "damping" in a:
                link.SetDampingCoefficient(number(a["damping"], "damping", 0, 1e12))
        elif kind == "teleport":
            body = self.body(a.get("body"), moving=True)
            if a["body"] in self.held:
                raise LiveError(409, "BODY_HELD", f"{a['body']} gắn với khớp, motor hoặc lò xo: teleport sẽ phá ràng "
                                                  "buộc. Dùng kéo (drag) hoặc reset với overrides.")
            frame = body.GetFrameRefToAbs()
            rotation = cr.Q(vector(a["orientation"], "orientation", 4)) if a.get("orientation") is not None else frame.GetRot()
            body.SetFrameRefToAbs(ch.ChFramed(cr.V(vector(a.get("position"), "position")), rotation))
            if not a.get("keep_velocity"):
                body.SetPosDt(ch.VNULL)
                body.SetAngVelParent(ch.VNULL)
        elif kind == "select":
            if a.get("body") is not None:
                self.body(a["body"])
            self.selected = a.get("body")
        self.seq += 1
        return {"t": self.time()}

    # ---------- what the viewer sees ----------

    def scene(self):
        """The bodies (geometry, colour, mass, mesh) and the joints, motors and springs, each joint in the frame of
        its body_a so the viewer can draw it moving with it"""
        bodies = []
        for b in self.model["bodies"]:
            g = dict(b.get("geometry") or {})
            visual = dict(b.get("visual") or {})
            mesh = visual.get("mesh_file") or (g.get("file") if g.get("type") == "mesh" else None)
            g.pop("file", None)
            bodies.append({"id": b["id"], "name": b.get("name") or b["id"], "fixed": b["fixed"], "geometry": g,
                           "color": visual.get("color"), "mass": b.get("mass"), "com": b.get("com"),
                           "collision": b.get("collision", False),
                           "friction": (b.get("material") or {}).get("friction"),
                           "mesh": {"url": f"mesh/{b['id']}", "unit_scale": visual.get("unit_scale") or g.get("unit_scale"),
                                    "format": Path(mesh).suffix.lower().lstrip(".")} if mesh else None,
                           "held": b["id"] in self.held})
        poses = {b["id"]: (np.asarray(b["position"], float), np.asarray(b["orientation"], float))
                 for b in self.model["bodies"]}

        def local(bid, point, axis=None):
            p, q = poses[bid]
            r = schema.quat_to_matrix(q)
            out = {"point": (r.T @ (np.asarray(point, float) - p)).tolist()}
            if axis is not None:
                out["axis"] = (r.T @ np.asarray(axis, float)).tolist()
            return out

        joints = [{"id": j["id"], "type": j["type"], "body_a": j.get("body_a"), "body_b": j.get("body_b"),
                   **(local(j["body_a"], j["position"], j["axis"]) if j.get("position") is not None and j.get("axis")
                      is not None else {})} for j in self.model["joints"]]
        motors = [{"id": a["id"], "type": a["type"], "mode": a["mode"], "body_a": a["body_a"], "body_b": a["body_b"],
                   "law": a["law"], "unit": MOTOR_UNITS[(a["type"], a["mode"])],
                   **local(a["body_a"], a["position"], a["axis"])} for a in self.model["actuators"]]
        springs = [{"id": f["id"], "type": f["type"], "body_a": f["body_a"], "body_b": f["body_b"],
                    "stiffness": f["stiffness"], "damping": f["damping"],
                    **({"point_a": local(f["body_a"], f["point_a"])["point"], "point_b": local(f["body_b"], f["point_b"])["point"]}
                       if f["type"] == "spring_damper" else {})}
                   for f in self.model["forces"] if f["type"] in cr.UNCONSTRAINED]
        sim = self.model["simulation"]
        return {"session_id": self.id, "name": self.model.get("name"), "source": self.source,
                "created_at": self.created_at, "time_step": self.dt, "gravity": sim["gravity"],
                "collision": sim["collision"], "bodies": bodies, "joints": joints, "motors": motors, "springs": springs,
                "warnings": self.warnings, "assumptions": self.model.get("assumptions", []),
                "mechanism": self.mechanism,
                "drag": {"stiffness_hz": DRAG_HZ, "max_weight_multiple": DRAG_MAX_G, "min_force_N": DRAG_MIN_N}}

    def publish(self):
        """The state the viewer draws, built in the physics thread"""
        system = self.m.system
        bodies = {}
        for bid, body in self.m.bodies.items():
            f = body.GetFrameRefToAbs()
            bodies[bid] = {"p": cr.vec(f.GetPos()), "q": cr.quat(f.GetRot())}
        state = {"session_id": self.id, "seq": self.seq, "t": self.time(), "running": self.running,
                 "failed": self.failed, "speed": self.speed, "rtf": self.rtf, "behind": self.behind,
                 "contacts": system.GetNumContacts(), "gravity": cr.vec(system.GetGravitationalAcceleration()),
                 "bodies": bodies, "motors": {}, "drag": None, "selected": None}
        for mid, (item, link) in self.links.items():
            if item["type"] in cr.ACTUATED:
                value, rate, effort = cr.coordinate(item, link)
                state["motors"][mid] = {"value": value, "rate": rate, "effort": effort, **self.motors[mid]}
        if self.drag:
            state["drag"] = {"body": self.drag["body"], "point": list(map(float, self.drag["point"])),
                             "target": list(map(float, self.drag["target"])), "force": list(map(float, self.drag["force"]))}
        if self.selected in self.m.bodies:
            body = self.m.bodies[self.selected]
            spec = self.specs[self.selected]
            applied = np.zeros(3)
            if self.drag and self.drag["body"] == self.selected:
                applied += self.drag["force"]
            for p in self.pushes:
                if p["body"] == self.selected and p["force"] is not None:
                    applied += p["force"]
            frame = body.GetFrameRefToAbs()
            state["selected"] = {
                "body": self.selected, "mass": None if spec["fixed"] else body.GetMass(), "fixed": spec["fixed"],
                "position": cr.vec(frame.GetPos()), "velocity": cr.vec(frame.GetPosDt()),
                "acceleration": cr.vec(frame.GetPosDt2()), "angular_velocity": cr.vec(body.GetAngVelParent()),
                "contact_force": cr.vec(body.GetContactForce()) if spec.get("collision") else None,
                "applied_force": applied.tolist(), "weight": None if spec["fixed"] else
                (body.GetMass() * np.array(state["gravity"])).tolist()}
        with self.lock:
            self.state = state
            self.state_seq = getattr(self, "state_seq", 0) + 1
            self.changed.notify_all()

    def latest(self):
        with self.lock:
            return self.state


MOTOR_UNITS = {("rotational_motor", "angle"): "rad", ("rotational_motor", "speed"): "rad/s",
               ("rotational_motor", "torque"): "N·m", ("linear_actuator", "position"): "m",
               ("linear_actuator", "speed"): "m/s", ("linear_actuator", "force"): "N"}
ACTIONS = ("pause", "resume", "step", "reset", "speed", "drag", "release", "push", "twist", "motor", "gravity",
           "spring", "teleport", "select")


sessions = {}
sessions_lock = threading.Lock()


def start_session(request):
    with sessions_lock:
        for sid in [sid for sid, s in sessions.items() if s.stopped]:
            sessions.pop(sid)
        if len(sessions) >= MAX_SESSIONS:
            raise LiveError(409, "TOO_MANY_SESSIONS", f"Đã có {len(sessions)} phiên tương tác; dừng một phiên trước "
                                                      f"(tối đa {MAX_SESSIONS}).")
    model, source, warnings, mechanism = load_model(request if isinstance(request, dict) else {})
    session = Session(model, source, warnings, paused=bool(request.get("paused")), mechanism=mechanism)
    with sessions_lock:
        sessions[session.id] = session
    return session


def get_session(sid):
    with sessions_lock:
        session = sessions.get(sid)
    if session is None or not ID_RE.match(sid):
        raise LiveError(404, "SESSION_NOT_FOUND", f"Không có phiên tương tác {sid}.")
    return session


def stop_session(sid):
    session = get_session(sid)
    session.stopped = True
    session.thread.join(2)
    with sessions_lock:
        sessions.pop(sid, None)


def plain(value):
    return value.item() if hasattr(value, "item") else str(value)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Headers and body go out as separate writes: with Nagle on, a kept-alive connection (the gateway's) waits ~40 ms
    # for the delayed ACK of the first before sending the second
    disable_nagle_algorithm = True

    def log_message(self, fmt, *args):
        if "/stream" not in self.path:
            sys.stderr.write(f"[sim-live] {fmt % args}\n")

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False, default=plain).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(length)) if length else {}
        except ValueError:
            raise LiveError(400, "BAD_JSON", "Body không phải JSON.") from None

    def handle_errors(self, fn):
        try:
            fn()
        except LiveError as err:
            self.reply(err.status, {"ok": False, "error": err.code, "message": err.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as err:  # noqa: BLE001 - the server stays up
            self.reply(500, {"ok": False, "error": "LIVE_ERROR", "message": f"{type(err).__name__}: {err}"})

    def do_GET(self):
        self.handle_errors(self.get)

    def do_POST(self):
        self.handle_errors(self.post)

    def get(self):
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["health"]:
            with sessions_lock:
                count = sum(1 for s in sessions.values() if not s.stopped)
            return self.reply(200, {"ok": True, "sessions": count, "engine_version": cr.engine_version()})
        if parts == ["live"]:
            with sessions_lock:
                listed = [{"session_id": s.id, "name": s.model.get("name"), "source": s.source, "created_at": s.created_at,
                           "t": s.latest()["t"], "running": s.running} for s in sessions.values() if not s.stopped]
            return self.reply(200, {"ok": True, "sessions": listed, "examples": examples()})
        if len(parts) >= 2 and parts[0] == "live":
            session = get_session(parts[1])
            rest = parts[2:]
            if not rest:
                return self.reply(200, {"ok": True, "scene": session.scene(), "state": session.latest()})
            if rest == ["state"]:
                return self.reply(200, {"ok": True, "state": session.latest()})
            if rest == ["stream"]:
                hz = parse_qs(url.query).get("hz", ["30"])[0]
                return self.stream(session, min(60.0, max(1.0, float(hz) if re.fullmatch(r"[0-9.]+", hz) else 30.0)))
            if len(rest) == 2 and rest[0] == "mesh":
                return self.mesh(session, rest[1])
        raise LiveError(404, "NOT_FOUND", f"Không có GET {url.path}.")

    def post(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["live"]:
            session = start_session(body)
            return self.reply(201, {"ok": True, "session_id": session.id, "scene": session.scene(),
                                    "state": session.latest()})
        if len(parts) == 3 and parts[0] == "live":
            session = get_session(parts[1])
            if parts[2] == "actions":
                result = session.submit(body)
                return self.reply(200, {"ok": True, **result, "state": session.latest()})
            if parts[2] == "stop":
                stop_session(parts[1])
                return self.reply(200, {"ok": True})
        raise LiveError(404, "NOT_FOUND", f"Không có POST {self.path}.")

    def stream(self, session, hz):
        """Server-Sent Events: the latest state whenever there is a new one, at most hz times a second"""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        seen = -1
        interval = 1 / hz
        while not session.stopped:
            started = time.monotonic()
            with session.lock:
                session.changed.wait_for(lambda: session.state_seq != seen or session.stopped, timeout=15)
                state, seen = session.state, session.state_seq
            session.touched = time.monotonic()
            self.wfile.write(b"data: " + json.dumps(state, default=plain, separators=(",", ":")).encode() + b"\n\n")
            self.wfile.flush()
            time.sleep(max(0.0, interval - (time.monotonic() - started)))
        self.wfile.write(b"event: end\ndata: {}\n\n")
        self.wfile.flush()

    def mesh(self, session, bid):
        spec = session.specs.get(bid)
        if spec is None:
            raise LiveError(404, "BODY_NOT_FOUND", f"Không có body {bid!r}.")
        visual, g = spec.get("visual") or {}, spec.get("geometry") or {}
        path = visual.get("mesh_file") or (g.get("file") if g.get("type") == "mesh" else None)
        if not path or not Path(path).is_file():
            raise LiveError(404, "NO_MESH", f"{bid} không có file mesh.")
        data = Path(path).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"[sim-live] Chrono {cr.engine_version()}, listening on :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
