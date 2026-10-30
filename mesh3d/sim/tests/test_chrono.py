"""
Chrono runs against results with an exact answer (sim/chrono_run.py). Needs Chrono's Python:

    cd /opt/mesh3d && /opt/chrono/bin/python -m unittest sim.tests.test_chrono

- the MVP: a motor turning a shaft at 360°/s turns it ω·t (1e-5 rad over 3 s), smoothly
- an ideal gear pair 20/40 turns at ω₂/ω₁ = -N₁/N₂ (1e-4), also on a carrier that itself turns (a gripper's
  fingers on a wrist), relative to that carrier
- a physical pendulum swings with T = 2π √(I_pivot / (m g d)) · (1 + θ₀²/16) (0.1 %)
- a free body falls z₀ - g t²/2, to within g·t·dt, the error halving with the step
- a mass on a spring along a prismatic joint oscillates at √(k/m) (0.2 %)
- gears with teeth in contact: frictionless, the motor needs T·N_a/N_b and the tooth force is T/r_bb (1 %); with
  friction the loss matches Ohlendorf's μ·H_v; the driven gear only moves once the backlash is taken up
- a ball dropped on a plate comes to rest with the contacts carrying m·g (1 %), with SMC and with NSC
"""

import csv
import json
import math
import tempfile
import unittest
from pathlib import Path

import numpy as np

from sim import schema
from sim.tests.test_schema import resting_ball

try:
    from sim import chrono_run
except ImportError:  # the worker's Python has no Chrono
    chrono_run = None

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


def simulate(mechanism):
    """Runs a mechanism; returns (engine.json, body rows, joint rows) with the CSVs as lists of dicts of floats"""
    folder = Path(tempfile.mkdtemp(prefix="sim-test-"))
    model = schema.normalise(mechanism)["model"]
    (folder / "model.json").write_text(json.dumps(model))
    engine = chrono_run.run(folder)

    def rows(name):
        with open(folder / name, newline="") as f:
            return [{k: (float(v) if v not in ("",) and k not in ("body", "item", "kind") else v)
                     for k, v in row.items()} for row in csv.DictReader(f)]

    return engine, rows("body_transforms.csv"), rows("joint_results.csv")


def example(name):
    return json.loads((EXAMPLES / f"{name}.json").read_text(encoding="utf-8"))


def series(rows, key, value, field="item"):
    picked = [r for r in rows if r[field] == key]
    return np.array([r["t"] for r in picked]), np.array([r[value] for r in picked])


@unittest.skipIf(chrono_run is None, "PyChrono is not installed in this Python")
class TheoryChecks(unittest.TestCase):
    def test_motor_shaft(self):
        engine, bodies, joints = simulate(example("motor_shaft"))
        self.assertEqual(engine["state"], "completed")
        self.assertTrue(all(c["passed"] for c in engine["checks"]), engine["checks"])
        t, angle = series(joints, "motor", "value")
        np.testing.assert_allclose(angle, 2 * math.pi * t, atol=1e-5)
        # Continuity: every output interval the same turn, no jumps
        steps = np.diff(angle)
        np.testing.assert_allclose(steps, 2 * math.pi * 0.01, rtol=1e-3)
        # The bearing's own angle, kept continuous past ±π, agrees with the motor's
        _, bearing = series(joints, "bearing", "value")
        np.testing.assert_allclose(bearing, angle, atol=1e-5)
        # The arm, fixed on the shaft, turns about +Z counter-clockwise: at t = 0.25 s it points along +Y
        tq, qz = series(bodies, "arm", "qz", "body")
        _, qw = series(bodies, "arm", "qw", "body")
        i = int(np.argmin(np.abs(tq - 0.25)))
        self.assertAlmostEqual(2 * math.atan2(qz[i], qw[i]), math.pi / 2, places=4)
        _, y = series(bodies, "arm", "y", "body")
        self.assertAlmostEqual(y[i], 0.025, places=6)

    def test_gear_pair(self):
        engine, bodies, _ = simulate(example("gear_pair"))
        check = next(c for c in engine["checks"] if c["kind"] == "gear_ratio")
        self.assertTrue(check["passed"], check)
        _, wp = series(bodies, "pinion", "wz", "body")
        _, ww = series(bodies, "wheel", "wz", "body")
        moving = np.abs(wp) > 1e-3
        np.testing.assert_allclose(ww[moving] / wp[moving], -20 / 40, atol=1e-4)
        self.assertGreater(wp[-1], 0)
        self.assertLess(ww[-1], 0)

    def test_gear_pair_on_a_turning_carrier(self):
        # The frame holding both gears is no longer fixed: it turns about X (across the gears' axes) on a motor of
        # its own, as a wrist turns the gripper whose fingers mesh
        m = example("gear_pair")
        m["bodies"][0].update(fixed=False, density=1240)
        m["bodies"].insert(0, {"id": "ground", "fixed": True, "geometry": {"type": "box", "size": [10, 10, 10]},
                               "position": [30, 0, -40]})
        m["joints"].append({"id": "tilt", "type": "revolute", "body_a": "ground", "body_b": "frame",
                            "position": [30, 0, -10], "axis": [1, 0, 0]})
        m["actuators"].append({"id": "tilt_motor", "type": "rotational_motor", "mode": "speed", "body_a": "ground",
                               "body_b": "frame", "position": [30, 0, -10], "axis": [1, 0, 0],
                               "law": {"type": "constant", "value": 30}})
        m["simulation"]["duration"] = 2
        engine, _, joints = simulate(m)
        self.assertEqual(engine["state"], "completed", engine.get("error"))
        check = next(c for c in engine["checks"] if c["kind"] == "gear_ratio")
        self.assertTrue(check["passed"], check)
        # The bearings' own rates are relative to the frame: they keep -N₁/N₂ while the frame tilts, to 1 % of the
        # top speed (an iterative solver holds the pair), and exactly enough to end at the ratio
        _, rp = series(joints, "pinion_bearing", "rate")
        _, rw = series(joints, "wheel_bearing", "rate")
        self.assertLess(float(np.max(np.abs(rw + rp / 2))), 0.01 * float(np.max(np.abs(rp))))
        self.assertAlmostEqual(float(rw[-1] / rp[-1]), -0.5, delta=1e-3)
        self.assertLess(engine["assembly_violation"]["value"], 1e-6)

    def test_pendulum_period(self):
        m = example("pendulum")
        engine, _, joints = simulate(m)
        self.assertEqual(engine["state"], "completed")
        t, angle = series(joints, "pivot", "value")
        # A joint's coordinate counts from the pose at t = 0: the rod, let go at 5°, swings about -5°
        self.assertAlmostEqual(float(np.min(angle)), -2 * math.radians(5), delta=1e-3)
        angle = angle + math.radians(5)
        # Upward zero crossings of the swing, interpolated
        crossings = [t[i] - angle[i] * (t[i + 1] - t[i]) / (angle[i + 1] - angle[i])
                     for i in range(len(t) - 1) if angle[i] < 0 <= angle[i + 1]]
        self.assertGreaterEqual(len(crossings), 2)
        period = float(np.mean(np.diff(crossings)))
        rho, a, h, d, g = 2700, 0.01, 0.2, 0.1, 9.81
        mass = rho * a * a * h
        pivot_inertia = mass * (a * a + h * h) / 12 + mass * d * d
        theta = math.radians(5)
        theory = 2 * math.pi * math.sqrt(pivot_inertia / (mass * g * d)) * (1 + theta ** 2 / 16)
        self.assertAlmostEqual(period / theory, 1, delta=1e-3)
        # It keeps its amplitude: no solver damping to speak of over 3 s
        self.assertAlmostEqual(np.max(np.abs(angle[-200:])) / theta, 1, delta=0.01)

    def test_free_fall(self):
        def fall(dt):
            m = {"schema_version": 1, "units": {"length": "m"},
                 "bodies": [{"id": "ball", "geometry": {"type": "sphere", "radius": 0.01}, "mass": 0.2,
                             "position": [0, 0, 1]}],
                 "simulation": {"duration": 0.4, "time_step": dt, "output_interval": 0.01}}
            _, bodies, _ = simulate(m)
            t, z = series(bodies, "ball", "z", "body")
            return t, z - (1 - 9.81 * t * t / 2)

        t, error = fall(0.001)
        # The time stepper is first order: off z₀ - g t²/2 by at most g t dt, and half that with half the step
        self.assertTrue(np.all(np.abs(error) <= 9.81 * t * 0.001 + 1e-9))
        _, finer = fall(0.0005)
        self.assertAlmostEqual(np.max(np.abs(finer)) / np.max(np.abs(error)), 0.5, delta=0.05)

    def test_spring_mass(self):
        k, mass = 200.0, 0.5
        m = {"schema_version": 1, "units": {"length": "mm"},
             "bodies": [{"id": "wall", "fixed": True, "position": [0, 0, 0]},
                        {"id": "slider", "mass": mass, "center_of_mass": [0, 0, 0],
                         "inertia": {"ixx": 1e-4, "iyy": 1e-4, "izz": 1e-4}, "position": [10, 0, 0]}],
             "joints": [{"id": "rail", "type": "prismatic", "body_a": "wall", "body_b": "slider",
                         "position": [0, 0, 0], "axis": [1, 0, 0]}],
             "forces": [{"id": "spring", "type": "spring_damper", "body_a": "wall", "body_b": "slider",
                         "point_a": [-100, 0, 0], "point_b": [10, 0, 0], "stiffness_N_per_m": k,
                         "damping_Ns_per_m": 0, "rest_length": 100}],
             "simulation": {"duration": 2, "time_step": 0.0002, "output_interval": 0.001, "gravity": [0, 0, 0]}}
        engine, bodies, _ = simulate(m)
        self.assertEqual(engine["state"], "completed")
        t, x = series(bodies, "slider", "x", "body")
        crossings = [t[i] - x[i] * (t[i + 1] - t[i]) / (x[i + 1] - x[i])
                     for i in range(len(t) - 1) if x[i] > 0 >= x[i + 1]]
        period = float(np.mean(np.diff(crossings)))
        self.assertAlmostEqual(period / (2 * math.pi * math.sqrt(mass / k)), 1, delta=2e-3)

    def test_gear_contact_load(self):
        m = example("gear_contact")
        m["joints"][2]["friction"] = 0
        engine, _, joints = simulate(m)
        self.assertTrue(all(c["passed"] is not False for c in engine["checks"]), engine["checks"])
        load, rb_b = 0.2, 0.04 * math.cos(math.radians(20))
        t, torque = series(joints, "motor", "effort")
        _, force = series(joints, "mesh", "effort")
        steady = t > 0.5
        # Averaged over whole mesh cycles the stiffness ripple cancels: no friction, no loss
        self.assertAlmostEqual(float(np.mean(torque[steady])) / (load * 20 / 40), 1, delta=0.01)
        self.assertAlmostEqual(float(np.mean(force[steady])) / (load / rb_b), 1, delta=0.01)

    def test_gear_contact_friction(self):
        engine, _, _ = simulate(example("gear_contact"))
        check = next(c for c in engine["checks"] if c["kind"] == "gear_efficiency")
        self.assertTrue(check["passed"], check)
        self.assertLess(check["measured"], 1)

    def test_gear_backlash(self):
        m = example("gear_contact")
        m["joints"][2].update(backlash=0.4, friction=0)
        # The pinion turned slowly by angle, the wheel free and unloaded: it waits for the backlash
        m["forces"] = []
        m["actuators"][0].update(mode="angle", law={"type": "ramp", "start": 0, "slope": 20})
        m["simulation"].update(duration=0.2, output_interval=0.0005, gravity=[0, 0, 0])
        _, _, joints = simulate(m)
        _, angle = series(joints, "motor", "value")
        _, force = series(joints, "mesh", "effort")
        _, wheel = series(joints, "wheel_bearing", "value")
        first = int(np.argmax(force > 0))
        rb_a = 0.02 * math.cos(math.radians(20))
        expected = 0.4e-3 * math.cos(math.radians(20)) / 2 / rb_a
        self.assertAlmostEqual(angle[first], expected, delta=math.radians(20) * 0.0005 * 1.5)
        self.assertLess(float(np.max(np.abs(wheel[:first]))), 1e-6)

    def test_ball_rests_on_contacts(self):
        for method in ("smc", "nsc"):
            with self.subTest(method=method):
                engine, bodies, _ = simulate(resting_ball(method))
                check = next(c for c in engine["checks"] if c["kind"] == "contact_equilibrium")
                self.assertTrue(check["passed"], check)
                _, z = series(bodies, "ball", "z", "body")
                # On the plate's top (z = 0): within the margin, and for SMC the Hertz squeeze (about 1 µm here)
                self.assertAlmostEqual(z[-1], 0.010, delta=2e-4)

    def test_contradictory_joints_are_flagged(self):
        m = example("motor_shaft")
        # A second bearing for the shaft on a parallel axis 30 mm away: both hold at t = 0 (joints close where the
        # bodies are), but the shaft cannot turn about two axes, so the motor's law cannot be met
        m["joints"].append({"id": "bad", "type": "revolute", "body_a": "base", "body_b": "shaft",
                            "position": [30, 0, 60], "axis": [0, 0, 1]})
        result = schema.normalise(m)
        self.assertLess(result["model"]["dof_estimate"], 0)
        engine, _, _ = simulate(m)
        failed = [c["id"] for c in engine["checks"] if c["passed"] is False]
        self.assertTrue(failed, engine["checks"])


if __name__ == "__main__":
    unittest.main()
