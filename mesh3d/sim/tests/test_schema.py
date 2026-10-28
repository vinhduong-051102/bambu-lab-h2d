"""
The mechanism format's checks and conversions (sim/schema.py). Pure Python: runs in the worker's Python or Chrono's.

    cd /opt/mesh3d && python -m unittest sim.tests.test_schema
"""

import copy
import json
import math
import unittest
from pathlib import Path

import numpy as np

from sim import schema

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


def example(name):
    return json.loads((EXAMPLES / f"{name}.json").read_text(encoding="utf-8"))


def errors(mechanism):
    with unittest.TestCase().assertRaises(schema.MechanismError) as caught:
        schema.normalise(mechanism)
    return {e["path"]: e["message"] for e in caught.exception.errors}


def resting_ball(method):
    """A 20 mm steel ball dropped 1 mm onto a fixed plate"""
    material = {"friction": 0.3, "restitution": 0.1, "young_modulus_Pa": 2e11, "poisson_ratio": 0.3}
    return {"schema_version": 1, "units": {"length": "mm"},
            "bodies": [{"id": "plate", "fixed": True, "position": [0, 0, -5], "collision": True,
                        "geometry": {"type": "box", "size": [100, 100, 10]}, "material": material},
                       {"id": "ball", "position": [0, 0, 11], "density": 7800, "collision": True,
                        "geometry": {"type": "sphere", "radius": 10}, "material": material}],
            "simulation": {"duration": 0.5, "time_step": 2e-5 if method == "smc" else 1e-3,
                           "output_interval": 0.005, "collision": {"enabled": True, "method": method}}}


class Examples(unittest.TestCase):
    def test_examples_are_valid(self):
        for path in EXAMPLES.glob("*.json"):
            with self.subTest(path.name):
                result = schema.normalise(json.loads(path.read_text(encoding="utf-8")))
                # The pendulum swings freely; the contact gears' wheel turns only as the teeth push it
                free = {"pendulum": 1, "gear_contact": 1}
                self.assertEqual(result["model"]["dof_estimate"], free.get(path.stem, 0))

    def test_si_units(self):
        model = schema.normalise(example("motor_shaft"))["model"]
        shaft = next(b for b in model["bodies"] if b["id"] == "shaft")
        # 100 mm × Ø10 steel: m = ρ π r² h
        self.assertAlmostEqual(shaft["mass"], 7850 * math.pi * 0.005 ** 2 * 0.1, places=12)
        self.assertEqual(shaft["position"], [0, 0, 0.06])
        # Izz = m r² / 2 about the cylinder's axis
        self.assertAlmostEqual(shaft["inertia"][2][2], shaft["mass"] * 0.005 ** 2 / 2, places=15)
        motor = model["actuators"][0]
        self.assertAlmostEqual(motor["law"]["value"], 2 * math.pi)
        self.assertFalse(motor["guide_constraint"])

    def test_derived_values_are_assumptions(self):
        result = schema.normalise(example("motor_shaft"))
        paths = {a["path"] for a in result["assumptions"]}
        self.assertIn("bodies[1].mass", paths)
        self.assertIn("bodies[1].inertia", paths)

    def test_gear_ratio_inputs(self):
        model = schema.normalise(example("gear_pair"))["model"]
        gear = next(j for j in model["joints"] if j["type"] == "gear")
        self.assertEqual((gear["body_a"], gear["body_b"], gear["carrier"]), ("pinion", "wheel", "frame"))
        pinion = next(b for b in model["bodies"] if b["id"] == "pinion")
        self.assertAlmostEqual(pinion["geometry"]["radius"], 0.02)


class Errors(unittest.TestCase):
    def test_missing_mass_is_an_error_not_a_guess(self):
        m = example("motor_shaft")
        del m["bodies"][1]["density"]
        found = errors(m)
        self.assertIn("bodies[1].mass", found)
        self.assertIn("Không tự đoán", found["bodies[1].mass"])

    def test_unknown_body(self):
        m = example("motor_shaft")
        m["joints"][0]["body_b"] = "nope"
        self.assertIn("joints[0].body_b", errors(m))

    def test_duplicate_ids(self):
        m = example("motor_shaft")
        m["joints"][1]["id"] = "bearing"
        self.assertIn("joints[1].id", errors(m))

    def test_zero_axis(self):
        m = example("motor_shaft")
        m["joints"][0]["axis"] = [0, 0, 0]
        self.assertIn("joints[0].axis", errors(m))

    def test_impossible_inertia(self):
        m = example("motor_shaft")
        m["bodies"][1].pop("density")
        m["bodies"][1].update(mass=0.1, inertia={"ixx": 1e-6, "iyy": 1e-6, "izz": 5e-6})
        self.assertIn("bất đẳng thức tam giác", errors(m)["bodies[1].inertia"])

    def test_explicit_inertia_in_declared_units(self):
        m = example("motor_shaft")
        m["bodies"][1].pop("density")
        m["bodies"][1].update(mass=100, inertia={"ixx": 2, "iyy": 2, "izz": 1}, center_of_mass=[0, 0, 0])
        m["units"]["mass"] = "g"
        body = schema.normalise(m)["model"]["bodies"][1]
        self.assertAlmostEqual(body["mass"], 0.1)
        # g·mm² → kg·m²
        self.assertAlmostEqual(body["inertia"][2][2], 1e-9)

    def test_motor_axis_must_match_joint(self):
        m = example("motor_shaft")
        m["actuators"][0]["axis"] = [1, 0, 0]
        self.assertIn("actuators[0].axis", errors(m))

    def test_gears_must_mesh(self):
        m = example("gear_pair")
        m["bodies"][2]["position"] = [61, 0, 0]
        m["joints"][1]["position"] = [61, 0, 0]
        self.assertIn("không ăn khớp", errors(m)["joints[2]"])

    def test_gear_needs_revolute_joints(self):
        m = example("gear_pair")
        m["joints"][2]["joint_a"] = "missing"
        self.assertIn("joints[2].joint_a", errors(m))

    def test_motor_law_required(self):
        m = example("motor_shaft")
        del m["actuators"][0]["law"]
        self.assertIn("actuators[0].law", errors(m))

    def test_too_many_steps(self):
        m = example("motor_shaft")
        m["simulation"]["time_step"] = 1e-9
        self.assertIn("simulation.time_step", errors(m))

    def test_units_required(self):
        m = example("motor_shaft")
        del m["units"]
        self.assertIn("units", errors(m))

    def test_collision_needs_friction(self):
        m = example("motor_shaft")
        m["bodies"][1]["collision"] = True
        self.assertIn("bodies[1].material.friction", errors(m))

    def test_gear_contact_needs_its_data(self):
        m = example("gear_contact")
        joint = m["joints"][2]
        for key in ("backlash", "friction", "young_modulus_Pa"):
            del joint[key]
        found = errors(m)
        for path in ("joints[2].backlash", "joints[2].friction", "joints[2].mesh_stiffness_N_per_m"):
            self.assertIn(path, found)

    def test_gear_contact_time_step(self):
        m = example("gear_contact")
        m["simulation"]["time_step"] = 0.001
        self.assertIn("cần time_step ≤", errors(m)["simulation.time_step"])

    def test_gear_contact_too_far_apart(self):
        m = example("gear_contact")
        m["bodies"][2]["position"][0] = 66
        m["joints"][1]["position"][0] = 66
        self.assertIn("hệ số trùng khớp", errors(m)["joints[2]"])

    def test_gear_contact_needs_gear_bodies(self):
        m = example("gear_contact")
        m["bodies"][1]["geometry"] = {"type": "cylinder", "radius": 20, "length": 10}
        self.assertIn("joints[2]", errors(m))

    def test_smc_needs_elastic_data(self):
        m = resting_ball("smc")
        del m["bodies"][1]["material"]["young_modulus_Pa"]
        self.assertIn("bodies[1].material.young_modulus_Pa", errors(m))

    def test_all_errors_at_once(self):
        m = example("motor_shaft")
        del m["bodies"][1]["density"]
        m["joints"][0]["body_b"] = "nope"
        m["simulation"]["duration"] = -1
        self.assertGreaterEqual(len(errors(m)), 3)


class Maths(unittest.TestCase):
    def test_euler_matches_rotation_order(self):
        q = schema.quat_from_euler_xyz([math.pi / 2, 0, math.pi / 2])
        r = schema.quat_to_matrix(q)
        # X then Z (fixed axes): +Y → +Z (about X) → +Z stays
        np.testing.assert_allclose(r @ [0, 1, 0], [0, 0, 1], atol=1e-12)
        np.testing.assert_allclose(r @ [1, 0, 0], [0, 1, 0], atol=1e-12)

    def test_quat_z_to(self):
        for axis in ([1, 0, 0], [0, -1, 0], [0, 0, -1], [1, 1, 1]):
            a = np.array(axis, float) / np.linalg.norm(axis)
            np.testing.assert_allclose(schema.quat_to_matrix(schema.quat_z_to(a)) @ [0, 0, 1], a, atol=1e-12)

    def test_law_integrals(self):
        ramp = {"type": "ramp", "start": 1.0, "slope": 2.0}
        self.assertAlmostEqual(schema.law_integral(ramp, 3), 3 + 9)
        sine = {"type": "sine", "amplitude": 2.0, "frequency_hz": 0.5, "phase": 0.3, "offset": 1.0}
        table = {"type": "table", "points": [[t, schema.law_value(sine, t)] for t in np.linspace(0, 2, 2001)]}
        self.assertAlmostEqual(schema.law_integral(sine, 2), schema.law_integral(table, 2), places=5)

    def test_gear_mesh_geometry(self):
        # 20/40 teeth, module 2, 20°, standard centre distance: contact ratio 1.635, line of action 60·sin 20°
        mesh = schema.gear_mesh(20, 40, 0.002, 0.06, math.radians(20), 0.0002)
        self.assertAlmostEqual(mesh["contact_ratio"], 1.635, places=3)
        self.assertAlmostEqual(mesh["length"], 0.06 * math.sin(math.radians(20)), places=12)
        self.assertAlmostEqual(mesh["working_pressure_angle"], math.radians(20), places=12)
        self.assertAlmostEqual(mesh["backlash_normal"], 0.0002 * math.cos(math.radians(20)), places=12)
        # Pulled apart, the gears work at a larger pressure angle and overlap less
        wider = schema.gear_mesh(20, 40, 0.002, 0.0605, math.radians(20), 0.0)
        self.assertGreater(wider["working_pressure_angle"], mesh["working_pressure_angle"])
        self.assertLess(wider["contact_ratio"], mesh["contact_ratio"])
        self.assertIsNone(schema.gear_mesh(20, 40, 0.002, 0.05, math.radians(20), 0.0))

    def test_gear_contact_model(self):
        model = schema.normalise(example("gear_contact"))["model"]
        joint = model["joints"][2]
        self.assertEqual(joint["model"], "contact")
        # ISO 6336: 14 N/(mm·µm) × 3.5/206 for PLA × 10 mm
        self.assertAlmostEqual(joint["mesh"]["stiffness"], 14e9 * 0.01 * 3.5e9 / 206e9, places=3)

    def test_dof(self):
        m = copy.deepcopy(example("motor_shaft"))
        m["actuators"][0]["guide"] = "joint"
        model = schema.normalise(m)["model"]
        self.assertLess(model["dof_estimate"], 0)


if __name__ == "__main__":
    unittest.main()
