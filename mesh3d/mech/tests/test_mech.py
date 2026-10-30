"""
The mechanical model against mechanisms with known answers (docs/mechanical-model.md). In the mesh worker's Python;
the runs go through the real sim pipeline (Chrono's Python):

    cd /opt/mesh3d && python -m unittest mech.tests.test_mech

A  crank-slider (r 30, L 100): DOF 1 with 3 redundant equations, driven DOF 0; kinematic stroke 2r and position
   r·cos θ + √(L² − r² sin² θ) to 1e-9 mm; Chrono's slider within 0.1 mm of it, constraint drift under 1 µm
B  two-stage gearbox 20/40 · 18/45: rigid groups (gears keyed on shafts), DOF 1; 1500 → 750 → 300 rpm, same
   direction in and out; with 2 N·m on the output, motor 0.4 N·m and gear forces T/r: 20.0 N and 35.56 N (1 %)
C  an existing GLB assembly (named nodes, transforms): parts keep names and positions; the pin and its hole become a
   probable revolute, a joint only once accepted; the pendulum swings under gravity in Chrono
D  invalid: a shaft keyed to the housing and driven by a motor is named (parts, joints) and refused before any run;
   gears too far apart are found, a repair proposed, and approved into a new revision that validates
E  missing: no material, no motor law, no simulation settings: listed as missing, the run refused, nothing invented
F  a request in words → the specification an agent writes (fixture) → parts with geometry → assembly → validation
   → Chrono → per-part results → Blender playback checked against Chrono
"""

import copy
import json
import math
import os
import shutil
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="mech-test-"))
os.environ["SIM_DIR"] = str(TMP / "sim")
os.environ["ENG_DIR"] = str(TMP / "eng")

import numpy as np  # noqa: E402
import trimesh  # noqa: E402

from mech import kinematics as K  # noqa: E402
from mech import model as M  # noqa: E402
from mech import service  # noqa: E402
from sim import runs as sim  # noqa: E402

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
CHRONO = Path(os.environ.get("CHRONO_PYTHON", "/opt/chrono/bin/python")).exists()


def example(name):
    return json.loads((EXAMPLES / f"{name}.json").read_text(encoding="utf-8"))


def setUpModule():
    sim.start()


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


def codes(validation, severity=None):
    return {d["code"] for d in validation["diagnostics"] if severity is None or d["severity"] == severity}


class A_CrankSlider(unittest.TestCase):
    def test_dof_and_kinematics(self):
        asm = K.Assembly(M.normalise(example("crank_slider"))["model"])
        a = K.analyse(asm)
        self.assertEqual(a["dof"]["mobility"], 1)
        self.assertEqual(a["dof"]["redundant_equations"], 3)
        self.assertEqual(a["dof"]["driven"], 0)
        samples = K.sweep(asm, "drive", 2 * math.pi, 90)
        r, L = 30, 100
        for s in samples:
            th = s["motor"]
            want = r * math.cos(th) + math.sqrt(L * L - (r * math.sin(th)) ** 2) - (r + L)
            self.assertAlmostEqual(s["joints"]["slide"], want, delta=1e-9)
        stroke = max(s["joints"]["slide"] for s in samples) - min(s["joints"]["slide"] for s in samples)
        self.assertAlmostEqual(stroke, 2 * r, places=9)

    @unittest.skipUnless(CHRONO, "no Chrono")
    def test_simulation(self):
        v = service.create_design({"model": example("crank_slider")})
        self.assertEqual(v["status"], "warning")  # the redundant equations are named, not hidden
        r = service.simulate(v["design_id"], {"wait_s": 300})
        self.assertEqual(r["state"], "completed", r.get("error"))
        checks = {c["id"]: c for c in r["checks"]}
        self.assertEqual(checks["kinematics.slide"]["status"], "passed", checks["kinematics.slide"])
        self.assertEqual(checks["chrono.constraints"]["status"], "passed", checks["chrono.constraints"])
        self.assertAlmostEqual(r["joints"]["slide"]["stroke_mm_simulated"], 60, delta=0.05)
        self.assertAlmostEqual(r["parts"]["crank"]["steady_rpm"], 60, delta=0.6)
        self.assertEqual(r["status"], "passed")


class B_Gearbox(unittest.TestCase):
    def test_groups_and_expected_speeds(self):
        v = service.create_design({"model": example("gearbox_two_stage")})
        self.assertEqual(v["status"], "passed", v["diagnostics"])
        self.assertEqual(sorted(v["groups"]["intermediate_shaft_group"]), ["g2", "g3", "intermediate_shaft"])
        self.assertEqual(v["dof"]["mobility"], 1)
        vel = v["velocities"]
        self.assertAlmostEqual(vel["intermediate_shaft_group"]["omega_rpm"], 750, places=6)
        self.assertAlmostEqual(vel["output_shaft_group"]["omega_rpm"], 300, places=6)
        # Two external stages: the output turns the way the input does
        self.assertGreater(vel["input_shaft_group"]["omega_rad_s"][2] * vel["output_shaft_group"]["omega_rad_s"][2], 0)
        masses = {p["id"]: p["mass"] for p in v["parts"]}
        self.assertEqual(masses["g1"]["source"], "geometry")

    @unittest.skipUnless(CHRONO, "no Chrono")
    def test_simulation(self):
        v = service.create_design({"model": example("gearbox_two_stage")})
        r = service.simulate(v["design_id"], {"wait_s": 300})
        self.assertEqual(r["state"], "completed", r.get("error"))
        failed = [c for c in r["checks"] if c["status"] == "failed"]
        self.assertFalse(failed, failed)
        self.assertAlmostEqual(r["parts"]["output_shaft"]["steady_rpm"], 300, delta=0.5)
        self.assertAlmostEqual(r["motors"]["motor"]["steady_effort"], 2 / 5, delta=0.004)
        # Ideal gears: tangential force = torque / pitch radius
        self.assertAlmostEqual(r["gears"]["stage2"]["steady_force_N"], 2 / 0.05625, delta=0.36)
        self.assertAlmostEqual(r["gears"]["stage1"]["steady_force_N"], 0.8 / 0.04, delta=0.2)
        # A shaft turning in place: its own centre does not move, whatever its body frame does
        self.assertLess(r["parts"]["intermediate_shaft"]["displacement_mm"], 0.01)
        self.assertLess(r["parts"]["intermediate_shaft"]["max_speed_mm_s"], 1)


class C_ImportedAssembly(unittest.TestCase):
    def test_glb_hinge(self):
        from eng import geometry

        # A bracket with a Ø8.4 hole along Y and an arm with a Ø8 pin in it, as two named nodes with transforms
        box = lambda lo, hi: trimesh.creation.box(bounds=[lo, hi])  # noqa: E731
        cyl = lambda r, a, b: trimesh.creation.cylinder(r, segment=[a, b], sections=96)  # noqa: E731
        bracket = trimesh.boolean.difference([trimesh.boolean.union([box((0, 0, 0), (40, 30, 5)), box((0, 0, 0), (40, 6, 35))], engine="manifold"),
                                              cyl(4.2, (20, -1, 25), (20, 7, 25))], engine="manifold")
        arm = trimesh.boolean.union([cyl(4.0, (0, -4, 0), (0, 12, 0)), box((0, 8, -3), (40, 12, 3))], engine="manifold")
        scene = trimesh.Scene()
        scene.add_geometry(bracket, node_name="Bracket", geom_name="bracket")
        # The arm is drawn about its pin; the node places it in the hole
        scene.add_geometry(arm, node_name="Arm", geom_name="arm", transform=trimesh.transformations.translation_matrix([20, 0, 25]))
        path = TMP / "hinge.glb"
        path.parent.mkdir(parents=True, exist_ok=True)
        scene.export(path)
        eng_model = geometry.import_model([{"path": str(path), "label": "hinge.glb"}], name="hinge")
        draft = service.import_model({"model_id": eng_model["model_id"], "create": False})
        names = {p["name"] for p in draft["model"]["parts"]}
        self.assertEqual(names, {"Bracket", "Arm"})
        (h,) = [x for x in draft["hypotheses"] if x["kind"] == "joint"]
        self.assertEqual(h["confidence"], "probable")
        self.assertEqual(h["joint"]["type"], "revolute")
        np.testing.assert_allclose(np.abs(h["joint"]["axis"]), [0, 1, 0], atol=1e-6)
        np.testing.assert_allclose(h["joint"]["position"], [20, 3, 25], atol=0.01)
        self.assertEqual(draft["model"]["joints"], [])  # nothing assumed without confirmation
        # Not enough to run yet: which part is fixed, what the arm is made of
        created = service.import_model({"model_id": eng_model["model_id"]})
        self.assertEqual(created["validation"]["status"], "failed")
        self.assertTrue(created["validation"]["missing"])
        # Confirmed: the bracket is the frame, the arm PLA, the hypothesis a joint
        ids = {p["name"]: p["id"] for p in draft["model"]["parts"]}
        confirmed = service.import_model({"model_id": eng_model["model_id"], "fixed": [ids["Bracket"]],
                                          "materials": {ids["Arm"]: "pla"}, "accept": [h["id"]],
                                          "simulation": {"duration": 0.5, "time_step": 0.001}})
        v = confirmed["validation"]
        self.assertNotEqual(v["status"], "failed", v["diagnostics"] + v["missing"])
        self.assertEqual(v["dof"]["mobility"], 1)
        arm_mass = next(p for p in v["parts"] if p["name"] == "Arm")["mass"]
        self.assertEqual(arm_mass["source"], "geometry")
        if CHRONO:
            r = service.simulate(confirmed["design_id"], {"wait_s": 120})
            self.assertEqual(r["state"], "completed", r.get("error"))
            # The arm swings: it starts level and falls under gravity
            self.assertGreater(r["parts"][ids["Arm"]]["max_rpm"], 10)


class D_Invalid(unittest.TestCase):
    def test_shaft_fixed_and_driven(self):
        m = example("gearbox_two_stage")
        m["joints"].append({"id": "weld", "type": "fixed", "part_a": "housing", "part_b": "input_shaft", "position": [0, 0, 0]})
        v = service.create_design({"model": m})
        self.assertEqual(v["status"], "failed")
        conflict = next(d for d in v["diagnostics"] if d["code"] == "MOTOR_ON_LOCKED_PAIR")
        self.assertIn("weld", conflict["joints"])
        self.assertIn("input_shaft", conflict["parts"])
        with self.assertRaises(service.MechError) as caught:
            service.simulate(v["design_id"], {"wait_s": 1})
        self.assertEqual(caught.exception.code, "NOT_VALID")
        # The repair: drop the weld, in a new revision, after approval
        proposals = service.propose(v["design_id"])["proposals"]
        fix = next(p for p in proposals if p["changes"] == {"remove": {"joints": ["weld"]}})
        with self.assertRaises(service.MechError):
            service.apply(v["design_id"], {"proposal_ids": [fix["id"]]})
        out = service.apply(v["design_id"], {"proposal_ids": [fix["id"]], "approved": True})
        self.assertEqual(out["before"]["status"], "failed")
        self.assertEqual(out["after"]["status"], "passed")
        self.assertEqual(out["revision"], v["revision"] + 1)

    def test_gears_too_far_apart(self):
        m = example("gearbox_two_stage")
        for part in m["parts"]:
            if part["id"] in ("output_shaft", "g4"):
                part["position"][0] += 3
        for j in m["joints"]:
            if j["id"] in ("bearing_out", "key_g4"):
                j["position"][0] += 3
        v = service.create_design({"model": m})
        bad = next(d for d in v["diagnostics"] if d["code"] == "GEAR_CENTER_DISTANCE")
        self.assertEqual(set(bad["parts"]), {"g3", "g4"})
        proposals = service.propose(v["design_id"])["proposals"]
        move = next(p for p in proposals if p["kind"] == "geometry")
        out = service.apply(v["design_id"], {"proposal_ids": [move["id"]], "approved": True})
        self.assertNotIn("GEAR_CENTER_DISTANCE", out["after"]["errors"])
        moved = next(p for p in out["validation"]["parts"] if p["id"] == "output_shaft")
        self.assertAlmostEqual(moved["position"]["value"][0], 138.75, places=6)

    def test_redundant_and_misaligned_named(self):
        m = example("crank_slider")
        m["joints"][0]["position"] = [5, 0, 0]  # the crank's pivot off its hole
        v = service.create_design({"model": m})
        self.assertIn("REDUNDANT_CONSTRAINTS", codes(v))
        # A pivot 5 mm off the crank's hole: the joint is not where the part turns
        bad = next(d for d in v["diagnostics"] if d["code"] == "JOINT_NOT_AT_HOLE")
        self.assertEqual(bad["parts"], ["crank"])
        self.assertEqual(bad["joints"], ["crank_pivot"])
        self.assertIn("5 mm", bad["message"])
        self.assertEqual(v["status"], "failed")
        # The example as given passes this check
        self.assertNotIn("JOINT_NOT_AT_HOLE", codes(service.create_design({"model": example("crank_slider")})))


class E_Missing(unittest.TestCase):
    def test_nothing_invented(self):
        m = example("gearbox_two_stage")
        for part in m["parts"]:
            part.pop("material", None)
        m["motors"][0] = {"id": "motor", "joint": "bearing_in", "mode": "speed"}
        del m["simulation"]
        v = service.create_design({"model": m})
        self.assertEqual(v["status"], "failed")
        self.assertIn("MASS_UNKNOWN", codes(v, "error"))
        paths = {x["path"] for x in v["missing"]}
        self.assertIn("motors[0].law", paths)
        # Solver settings left out are a stated default, not physical data to ask for
        self.assertNotIn("simulation", paths)
        self.assertIn("simulation.time_step", {a["path"] for a in v["assumptions"]})
        shaft = next(p for p in v["parts"] if p["id"] == "input_shaft")
        self.assertIsNone(shaft["mass"])
        with self.assertRaises(service.MechError):
            service.simulate(v["design_id"], {"wait_s": 1})
        # What the user is asked for
        asks = [p for p in service.propose(v["design_id"])["proposals"] if p["kind"] == "data"]
        self.assertTrue(any("motors[0].law" in p["summary"] for p in asks))


class F_EndToEnd(unittest.TestCase):
    @unittest.skipUnless(CHRONO, "no Chrono")
    def test_request_to_results(self):
        # What an agent writes from the request in the brief (its words kept in "request")
        spec = example("gearbox_two_stage")
        self.assertIn("1500 RPM", spec["request"])
        v = service.create_design({"model": spec})
        part_ids = {p["id"] for p in v["parts"]}
        self.assertEqual(part_ids, {"housing", "input_shaft", "intermediate_shaft", "output_shaft", "g1", "g2", "g3", "g4"})
        # Each part its own geometry, written for the solver and the viewer
        r = service.simulate(v["design_id"], {"wait_s": 300})
        self.assertEqual(r["state"], "completed")
        meshes = list((TMP / "sim" / "files" / "mech" / v["design_id"]).rglob("*.stl"))
        self.assertEqual(len([m for m in meshes if not m.name.startswith("part_")]), 4)  # ground + three shaft groups
        self.assertEqual({m.stem[5:] for m in meshes if m.name.startswith("part_")}, part_ids)  # and one per part
        self.assertAlmostEqual(r["parts"]["g4"]["steady_rpm"], 300, delta=0.5)
        # Blender plays it back and checks itself against Chrono
        sim.start_playback(r["sim_id"], {"render": False})
        import time

        for _ in range(240):
            play = sim.status(r["sim_id"]).get("playback") or {}
            if play.get("state") in ("completed", "failed"):
                break
            time.sleep(1)
        self.assertEqual(play.get("state"), "completed", play.get("error"))
        self.assertTrue(play["check"]["passed"], play["check"])


if __name__ == "__main__":
    unittest.main()
