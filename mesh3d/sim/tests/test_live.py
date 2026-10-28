"""
The interactive session (sim/live.py) against results with an exact answer, and its HTTP API. Needs Chrono's Python:

    cd /opt/mesh3d && /opt/chrono/bin/python -m unittest sim.tests.test_live

Physics checks run paused, a fixed number of steps at a time ("step"), so they are exact and repeatable:
- a box dropped on the ground comes to rest on its largest face, its contacts carrying m·g (1 %)
- dragged by a point, the box holds that point at the pointer (1 mm), and falls back to rest when released
- a push F for T changes a free body's velocity by F·T/m (1 %); gravity changed while running stops its fall
- a motor's speed changed while running: the shaft turns at the new speed (1e-6 rad/s); disabled, it drives nothing
- reset restores the initial state exactly, or the one asked for (position, velocity, friction, gravity)
Pacing runs on the wall clock: a light mechanism keeps up with real time, gear teeth in contact (10 µs steps) do not
and say so; pause holds time still.
"""

import copy
import json
import math
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import numpy as np

SIM_DIR = Path(tempfile.mkdtemp(prefix="sim-live-test-"))
os.environ["SIM_DIR"] = str(SIM_DIR)

try:
    from sim import live
except ImportError:  # the worker's Python has no Chrono
    live = None

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
BOX = [40, 30, 20]  # mm
DENSITY = 1240
MASS = 0.04 * 0.03 * 0.02 * DENSITY


def drop(gravity=(0, 0, -9.81)):
    """A box held 150 mm above the ground, tilted, both colliding"""
    return {"schema_version": 1, "name": "Hộp rơi", "units": {"length": "mm", "mass": "kg"},
            "bodies": [{"id": "ground", "fixed": True, "geometry": {"type": "box", "size": [400, 400, 20]},
                        "position": [0, 0, -10], "collision": True, "material": {"friction": 0.5}},
                       {"id": "box", "geometry": {"type": "box", "size": BOX}, "density": DENSITY,
                        "position": [0, 0, 150], "orientation": {"euler_xyz": [20, 10, 0]}, "collision": True,
                        "material": {"friction": 0.5}}],
            "simulation": {"duration": 2, "time_step": 0.001, "gravity": list(gravity), "collision": {"enabled": True}}}


def floating():
    """A free 1 kg box in no gravity"""
    return {"schema_version": 1, "name": "Hộp trôi", "units": {"length": "mm", "mass": "kg"},
            "bodies": [{"id": "box", "geometry": {"type": "box", "size": [100, 100, 100]}, "mass": 1.0,
                        "position": [0, 0, 0]}],
            "simulation": {"duration": 1, "time_step": 0.001, "gravity": [0, 0, 0]}}


def example(name):
    return json.loads((EXAMPLES / f"{name}.json").read_text(encoding="utf-8"))


@unittest.skipIf(live is None, "needs Chrono's Python (/opt/chrono/bin/python)")
class SessionTest(unittest.TestCase):
    def session(self, mechanism, paused=True):
        model, source, warnings, written = live.load_model({"mechanism": mechanism})
        session = live.Session(model, source, warnings, paused=paused, mechanism=written)
        self.addCleanup(setattr, session, "stopped", True)
        return session

    def act(self, session, **action):
        return session.submit(action)

    def pose(self, session, bid="box"):
        f = session.m.bodies[bid].GetFrameRefToAbs()
        return np.array([f.GetPos().x, f.GetPos().y, f.GetPos().z])

    def velocity(self, session, bid="box"):
        v = session.m.bodies[bid].GetFrameRefToAbs().GetPosDt()
        return np.array([v.x, v.y, v.z])

    def test_drop_comes_to_rest_on_the_ground(self):
        s = self.session(drop())
        self.act(s, action="select", body="box")
        self.act(s, action="step", count=1500)
        self.assertAlmostEqual(s.time(), 1.5, places=9)
        # Resting on its largest face (40 × 30): its centre half the 20 mm height above the ground
        self.assertAlmostEqual(self.pose(s)[2], 0.010, delta=0.0005)
        state = s.latest()["selected"]
        self.assertEqual(state["body"], "box")
        self.assertAlmostEqual(state["mass"], MASS, delta=MASS * 1e-9)
        self.assertLess(np.linalg.norm(state["velocity"]), 1e-3)
        weight = MASS * 9.81
        self.assertAlmostEqual(state["contact_force"][2], weight, delta=0.01 * weight)

    def test_drag_holds_the_point_then_release_falls(self):
        s = self.session(drop())
        self.act(s, action="step", count=1500)
        start = self.pose(s)
        target = start + [0.02, 0.0, 0.10]
        self.act(s, action="drag", body="box", point=start.tolist(), target=target.tolist())
        self.act(s, action="step", count=2500)
        # A critically damped 3 Hz spring that carries the weight: the grabbed point ends at the pointer
        grabbed = np.array(s.latest()["drag"]["point"])
        self.assertLess(np.linalg.norm(grabbed - target), 0.001)
        self.assertLess(np.linalg.norm(s.latest()["drag"]["force"]), 2 * MASS * 9.81)
        # The pointer moves on: the point follows
        target2 = target + [0.0, 0.05, 0.0]
        self.act(s, action="drag", body="box", target=target2.tolist())
        self.act(s, action="step", count=2500)
        self.assertLess(np.linalg.norm(np.array(s.latest()["drag"]["point"]) - target2), 0.001)
        self.act(s, action="release")
        self.assertIsNone(s.latest()["drag"])
        self.act(s, action="step", count=2000)
        self.assertAlmostEqual(self.pose(s)[2], 0.010, delta=0.0005)
        self.assertLess(np.linalg.norm(self.velocity(s)), 1e-3)

    def test_drag_force_is_limited(self):
        s = self.session(drop())
        self.act(s, action="step", count=1500)
        p = self.pose(s)
        self.act(s, action="drag", body="box", point=p.tolist(), target=(p + [0, 0, 100.0]).tolist())
        self.act(s, action="step", count=1)
        limit = max(live.DRAG_MIN_N, live.DRAG_MAX_G * MASS * 9.81)
        self.assertAlmostEqual(np.linalg.norm(s.latest()["drag"]["force"]), limit, delta=limit * 1e-9)

    def test_push_changes_velocity_by_impulse(self):
        s = self.session(floating())
        self.act(s, action="push", body="box", force=[2.0, 0.0, 0.0], duration=0.1)
        self.act(s, action="step", count=300)
        # Δv = F·T / m
        self.assertAlmostEqual(self.velocity(s)[0], 2.0 * 0.1 / 1.0, delta=0.002)
        self.assertLess(abs(self.velocity(s)[1]) + abs(self.velocity(s)[2]), 1e-9)

    def test_twist_spins(self):
        s = self.session(floating())
        self.act(s, action="twist", body="box", torque=[0.0, 0.0, 0.01], duration=0.1)
        self.act(s, action="step", count=200)
        # I_zz of a 1 kg 0.1 m cube = m a² / 6
        inertia = 1.0 * 0.1**2 / 6
        w = s.m.bodies["box"].GetAngVelParent().z
        self.assertAlmostEqual(w, 0.01 * 0.1 / inertia, delta=0.01 * 0.01 * 0.1 / inertia)

    def test_gravity_changed_while_running(self):
        s = self.session(floating())
        self.act(s, action="gravity", vector=[0, 0, -9.81])
        self.act(s, action="step", count=100)
        v = self.velocity(s)[2]
        self.assertAlmostEqual(v, -9.81 * 0.1, delta=0.01)
        self.act(s, action="gravity", vector=[0, 0, 0])
        self.act(s, action="step", count=100)
        self.assertAlmostEqual(self.velocity(s)[2], v, delta=1e-9)
        self.assertEqual(s.latest()["gravity"], [0, 0, 0])

    def test_motor_speed_changed_while_running(self):
        s = self.session(example("motor_shaft"))
        self.act(s, action="step", count=500)
        motor = s.latest()["motors"]["motor"]
        self.assertAlmostEqual(motor["rate"], 2 * math.pi, delta=1e-6)
        angle = motor["value"]
        self.act(s, action="motor", id="motor", value=4 * math.pi)
        self.act(s, action="step", count=500)
        motor = s.latest()["motors"]["motor"]
        self.assertAlmostEqual(motor["rate"], 4 * math.pi, delta=1e-6)
        self.assertAlmostEqual(motor["value"] - angle, 4 * math.pi * 0.5, delta=4 * math.pi * 0.001 * 2)
        # Off: it drives nothing, the shaft keeps its speed on a frictionless bearing
        self.act(s, action="motor", id="motor", enabled=False)
        self.act(s, action="step", count=200)
        motor = s.latest()["motors"]["motor"]
        self.assertFalse(motor["enabled"])
        w = s.m.bodies["shaft"].GetAngVelParent().z
        self.assertAlmostEqual(w, 4 * math.pi, delta=1e-3)
        self.act(s, action="motor", id="motor", enabled=True, value=0.0)
        self.act(s, action="step", count=50)
        self.assertAlmostEqual(s.m.bodies["shaft"].GetAngVelParent().z, 0.0, delta=1e-6)

    def test_drag_respects_joints(self):
        """Pulled sideways, a shaft on a bearing driven by a motor still only turns about its axis"""
        s = self.session(example("motor_shaft"))
        arm = s.m.bodies["arm"].GetFrameRefToAbs().GetPos()
        point = [arm.x, arm.y, arm.z]
        self.act(s, action="drag", body="arm", point=point, target=[point[0], point[1] + 0.05, point[2] + 0.05])
        self.act(s, action="step", count=300)
        shaft = self.pose(s, "shaft")
        self.assertLess(np.linalg.norm(shaft - [0, 0, 0.060]), 1e-6)
        self.assertAlmostEqual(s.latest()["motors"]["motor"]["rate"], 2 * math.pi, delta=1e-6)

    def test_reset_restores_the_start(self):
        s = self.session(drop())
        start = self.pose(s)
        self.act(s, action="step", count=700)
        self.act(s, action="reset")
        self.assertEqual(s.time(), 0.0)
        np.testing.assert_allclose(self.pose(s), start, atol=1e-12)
        self.act(s, action="step", count=1500)
        self.assertAlmostEqual(self.pose(s)[2], 0.010, delta=0.0005)

    def test_reset_with_other_initial_conditions(self):
        s = self.session(drop())
        self.act(s, action="reset", overrides={"position": {"box": [0.0, 0.0, 0.5]}, "velocity": {"box": [1.0, 0, 0]},
                                               "gravity": [0, 0, -1.62], "friction": {"box": 0.1}})
        np.testing.assert_allclose(self.pose(s), [0, 0, 0.5], atol=1e-12)
        self.act(s, action="step", count=100)
        # Moon gravity, thrown sideways at 1 m/s: z = z₀ - g t²/2, x = v t
        self.assertAlmostEqual(self.pose(s)[2], 0.5 - 1.62 * 0.1**2 / 2, delta=1.62 * 0.1 * 0.001)
        self.assertAlmostEqual(self.pose(s)[0], 0.1, delta=1e-9)
        self.assertEqual(s.specs["box"]["material"]["friction"], 0.1)
        # The overrides last for this reset only: the next plain reset is the mechanism's own start
        self.act(s, action="reset")
        self.assertAlmostEqual(self.pose(s)[2], 0.150, delta=1e-12)

    def test_refusals(self):
        s = self.session(example("motor_shaft"))
        cases = [({"action": "drag", "body": "base", "point": [0, 0, 0], "target": [0, 0, 1]}, "BODY_FIXED"),
                 ({"action": "teleport", "body": "arm", "position": [0, 0, 1]}, "BODY_HELD"),
                 ({"action": "motor", "id": "nope", "value": 1}, "MOTOR_NOT_FOUND"),
                 ({"action": "push", "body": "arm", "force": [1, 2]}, "BAD_ACTION"),
                 ({"action": "speed", "value": 0}, "BAD_ACTION"),
                 ({"action": "fly"}, "BAD_ACTION"),
                 ({"action": "reset", "overrides": {"position": {"arm": [0, 0, 1]}}}, "BODY_HELD")]
        for action, code in cases:
            with self.assertRaises(live.LiveError, msg=action) as caught:
                s.submit(action)
            self.assertEqual(caught.exception.code, code, action)

    def test_teleport_a_free_body(self):
        s = self.session(drop())
        self.act(s, action="step", count=100)
        self.act(s, action="teleport", body="box", position=[0.1, 0.1, 0.3])
        np.testing.assert_allclose(self.pose(s), [0.1, 0.1, 0.3], atol=1e-12)
        self.assertEqual(np.linalg.norm(self.velocity(s)), 0.0)

    def test_scene(self):
        s = self.session(example("motor_shaft"))
        scene = s.scene()
        self.assertEqual([b["id"] for b in scene["bodies"]], ["base", "shaft", "arm"])
        self.assertEqual(scene["bodies"][1]["geometry"]["type"], "cylinder")
        # The mechanism as written comes with the scene, to run it offline
        self.assertEqual(scene["mechanism"]["name"], example("motor_shaft")["name"])
        motor = scene["motors"][0]
        self.assertEqual((motor["mode"], motor["unit"]), ("speed", "rad/s"))
        # The bearing at z = 10 mm in the world, in the base's frame (whose origin is at z = 5 mm)
        np.testing.assert_allclose(scene["joints"][0]["point"], [0, 0, 0.005], atol=1e-12)
        self.assertTrue(scene["bodies"][2]["held"])


@unittest.skipIf(live is None, "needs Chrono's Python (/opt/chrono/bin/python)")
class PacingTest(unittest.TestCase):
    def test_light_mechanism_keeps_real_time_and_pause_holds(self):
        model, source, warnings, _ = live.load_model({"mechanism": drop()})
        s = live.Session(model, source, warnings)
        self.addCleanup(setattr, s, "stopped", True)
        time.sleep(1.5)
        state = s.latest()
        self.assertAlmostEqual(state["rtf"], 1.0, delta=0.1)
        self.assertFalse(state["behind"])
        s.submit({"action": "pause"})
        t = s.time()
        time.sleep(0.3)
        self.assertEqual(s.time(), t)
        s.submit({"action": "speed", "value": 0.5})
        s.submit({"action": "resume"})
        time.sleep(1.5)
        self.assertAlmostEqual(s.latest()["rtf"], 0.5, delta=0.07)

    def test_slow_mechanism_says_it_is_behind(self):
        model, source, warnings, _ = live.load_model({"mechanism": example("gear_contact")})
        s = live.Session(model, source, warnings)
        self.addCleanup(setattr, s, "stopped", True)
        time.sleep(1.5)
        state = s.latest()
        self.assertTrue(state["behind"])
        self.assertLess(state["rtf"], 0.6)
        self.assertGreater(state["rtf"], 0.0)


@unittest.skipIf(live is None, "needs Chrono's Python (/opt/chrono/bin/python)")
class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), live.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        for sid in list(live.sessions):
            live.stop_session(sid)
        cls.server.shutdown()
        cls.server.server_close()

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data, {"Content-Type": "application/json"}, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    def test_session_over_http(self):
        status, body = self.call("POST", "/live", {"mechanism": drop(), "paused": True})
        self.assertEqual(status, 201, body)
        sid = body["session_id"]
        self.assertEqual(body["scene"]["bodies"][1]["id"], "box")
        self.assertFalse(body["state"]["running"])
        status, body = self.call("POST", f"/live/{sid}/actions", {"action": "step", "count": 10})
        self.assertEqual(status, 200, body)
        self.assertAlmostEqual(body["t"], 0.01, places=9)
        status, body = self.call("POST", f"/live/{sid}/actions", {"action": "drag", "body": "ground", "point": [0, 0, 0],
                                                                  "target": [0, 0, 1]})
        self.assertEqual((status, body["error"]), (409, "BODY_FIXED"))
        # The stream: a state as an SSE event
        with urllib.request.urlopen(f"{self.base}/live/{sid}/stream?hz=20", timeout=10) as res:
            self.assertEqual(res.headers["Content-Type"], "text/event-stream")
            line = res.readline()
            self.assertTrue(line.startswith(b"data: "))
            state = json.loads(line[6:])
            self.assertEqual(state["session_id"], sid)
            self.assertIn("box", state["bodies"])
        status, body = self.call("GET", "/live")
        self.assertIn(sid, [s["session_id"] for s in body["sessions"]])
        self.assertEqual(self.call("POST", f"/live/{sid}/stop", {})[0], 200)
        self.assertEqual(self.call("GET", f"/live/{sid}")[0], 404)

    def test_from_a_run(self):
        """A run's model.json, exactly as it ran, opens as a session"""
        from sim import schema

        folder = SIM_DIR / "runs" / "s-20261029-090000-abcd"
        folder.mkdir(parents=True)
        (folder / "model.json").write_text(json.dumps(schema.normalise(drop())["model"]))
        (folder / "status.json").write_text(json.dumps({"state": "completed"}))
        status, body = self.call("POST", "/live", {"sim_id": folder.name, "paused": True})
        self.assertEqual(status, 201, body)
        self.assertEqual(body["scene"]["source"], {"sim_id": folder.name})
        self.call("POST", f"/live/{body['session_id']}/stop", {})

    def test_from_an_example(self):
        status, body = self.call("POST", "/live", {"example": "drop_box", "paused": True})
        self.assertEqual(status, 201, body)
        self.assertEqual([b["id"] for b in body["scene"]["bodies"]], ["ground", "box", "ball"])
        self.call("POST", f"/live/{body['session_id']}/stop", {})
        self.assertIn("drop_box", self.call("GET", "/live")[1]["examples"])
        self.assertEqual(self.call("POST", "/live", {"example": "../etc"})[1]["error"], "EXAMPLE_NOT_FOUND")

    def test_bad_requests(self):
        self.assertEqual(self.call("POST", "/live", {})[1]["error"], "NO_MECHANISM")
        broken = copy.deepcopy(drop())
        del broken["bodies"][1]["density"]
        self.assertEqual(self.call("POST", "/live", {"mechanism": broken})[1]["error"], "INVALID_MECHANISM")
        self.assertEqual(self.call("GET", "/live/l-20261029-000000-0000")[0], 404)
        self.assertEqual(self.call("POST", "/live", {"sim_id": "s-20991231-000000-ffff"})[0], 404)


if __name__ == "__main__":
    unittest.main()
