"""
A 3D model simulated as it is (docs/model-simulation.md): a design job's components and declared mechanism, or an
imported model, set up as a versioned design, its state read from what is stored, and compiled for the live viewer.
In the mesh worker's Python (the live run itself is checked against the running containers by live_check.py):

    cd /opt/mesh3d && python -m unittest mech.tests.test_model_sim

Workflow A  a job's assembly.json (components + mechanism) → parts named by component, declared joints and motor,
            READY; the viewer's mechanism has one mesh per part and passes sim's own schema
Workflow B  a single mesh is one part: nothing claimed about its pieces, no joint
Test 4      the model changes → NEEDS_VALIDATION, setup carries the configuration to a new revision; a parameter
            change is another revision; earlier runs stay with their revision, not shown as current
Test 5      a joint that contradicts the motor (the crank welded to the frame and driven) → INVALID, the viewer
            refuses with the parts and joints at fault
Contact     a block on a plate with collision and friction: the hull travels with the mechanism, collision on
"""

import copy
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="model-sim-test-"))
os.environ["SIM_DIR"] = str(TMP / "sim")
os.environ["ENG_DIR"] = str(TMP / "eng")
os.environ["JOBS_DIR"] = str(TMP / "jobs")

import trimesh  # noqa: E402

from mech import models, service  # noqa: E402
from mech.service import MechError  # noqa: E402
from sim import runs as sim  # noqa: E402

CHRONO = Path(os.environ.get("CHRONO_PYTHON", "/opt/chrono/bin/python")).exists()
R, L, T = 30.0, 100.0, 6.0

# The crank-slider as cad/build.py writes it for mech/examples/crank_slider_cad.py: one STL per component, in place
PARTS = {
    "base": ([50, 0, -10], [200, 60, 8]),
    "crank": ([R / 2, 0, 0], [R + 12, 12, T]),
    "rod": ([R + L / 2, 0, T], [L + 12, 12, T]),
    "slider": ([R + L, 0, 2 * T], [24, 20, T]),
}
MECHANISM = {
    "parts": {"base": {"fixed": True, "role": "frame"}, "crank": {"role": "crank", "material": "pla"},
              "rod": {"role": "rod", "material": "pla"}, "slider": {"role": "slider", "material": "pla"}},
    "joints": [
        {"id": "crank_pivot", "type": "revolute", "part_a": "base", "part_b": "crank", "position": [0, 0, -3], "axis": [0, 0, 1]},
        {"id": "crank_pin", "type": "revolute", "part_a": "crank", "part_b": "rod", "position": [R, 0, 3], "axis": [0, 0, 1]},
        {"id": "wrist_pin", "type": "revolute", "part_a": "rod", "part_b": "slider", "position": [R + L, 0, 9], "axis": [0, 0, 1]},
        {"id": "slide", "type": "prismatic", "part_a": "base", "part_b": "slider", "position": [R + L, 0, 12], "axis": [1, 0, 0]},
    ],
    "motors": [{"id": "drive", "joint": "crank_pivot", "speed_rpm": 60, "ramp_s": 0.25}],
    "simulation": {"duration": 1, "time_step": 0.0005},
}


def setUpModule():
    sim.start()


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


def make_job(job_id, parts=PARTS, mechanism=MECHANISM, single=False):
    out = TMP / "jobs" / job_id / "out"
    (out / "components").mkdir(parents=True, exist_ok=True)
    meshes = {name: trimesh.creation.box(extents=size, transform=trimesh.transformations.translation_matrix(centre))
              for name, (centre, size) in parts.items()}
    trimesh.util.concatenate(list(meshes.values())).export(out / "model.stl")
    if single:
        (out / "assembly.json").unlink(missing_ok=True)
        return
    for name, mesh in meshes.items():
        mesh.export(out / "components" / f"{name}.stl")
    (out / "assembly.json").write_text(json.dumps({
        "components": [{"name": n, "file": f"components/{n}.stl"} for n in parts], "mechanism": mechanism}))


def codes(validation, severity=None):
    return {d["code"] for d in validation["diagnostics"] if severity is None or d["severity"] == severity}


class A_AiCreatedModel(unittest.TestCase):
    def test_job_components_become_the_simulated_model(self):
        make_job("job-crank-a1")
        before = models.status("job-job-crank-a1")
        self.assertEqual(before["state"], "NOT_CONFIGURED")
        s = models.setup({"job_id": "job-crank-a1"})
        self.assertEqual(s["state"], "READY", s.get("reason"))
        self.assertEqual({c["id"] for c in s["components"]}, set(PARTS))
        self.assertEqual(s["validation"]["dof"]["mobility"], 1)
        self.assertEqual(s["validation"]["dof"]["driven"], 0)
        self.assertNotIn("JOINT_AWAY_FROM_PART", codes(s["validation"]))
        design = service.get_design(s["design_id"])["input"]
        # Declared by the design, not guessed: marked so
        self.assertTrue(all(j["source"] == "design" for j in design["joints"]))
        self.assertTrue(all(p["source"] == "imported_cad" for p in design["parts"]))
        v = models.viewer(s["design_id"])
        bodies = {b["id"]: b for b in v["mechanism"]["bodies"]}
        self.assertEqual({p["id"] for b in bodies.values() for p in b["visual"]["parts"]}, set(PARTS))
        self.assertEqual(v["parts"]["slider"]["body"], "slider")
        self.assertEqual(set(v["parts"]["rod"]["joints"]), {"crank_pin", "wrist_pin"})
        self.assertEqual({j["id"]: j["dof"] for j in v["joints"]}["slide"], 1)
        self.assertEqual(v["origin"], {"design_id": s["design_id"], "revision": "1"})
        # What the live container will read: sim's own schema accepts it, parts and all
        normalised = sim.normalise(v["mechanism"])["model"]
        self.assertEqual(len(normalised["bodies"][1]["visual"]["parts"]), 1)
        # Setting up again with nothing changed adds nothing
        self.assertEqual(models.setup({"job_id": "job-crank-a1"})["revision"], 1)

    def test_single_mesh_claims_no_parts(self):
        make_job("job-lump-a2", single=True)
        s = models.setup({"job_id": "job-lump-a2"})
        self.assertEqual(len(s["components"]), 1)
        design = service.get_design(s["design_id"])["input"]
        self.assertEqual(design["joints"], [])
        # Nothing fixed, no mass: says so rather than running
        self.assertEqual(s["state"], "INVALID")
        self.assertTrue(s["validation"]["missing"])


class B_ModelChanges(unittest.TestCase):
    @unittest.skipUnless(CHRONO, "no Chrono")
    def test_revisions_keep_their_runs(self):
        make_job("job-crank-b1")
        s = models.setup({"job_id": "job-crank-b1"})
        design_id = s["design_id"]
        run = service.simulate(design_id, {"wait_s": 300})
        self.assertEqual(run["state"], "completed", run.get("error"))
        self.assertEqual(models.status("job-job-crank-b1")["state"], "COMPLETED")
        # The model is rebuilt with a longer slider block: a new version of the model
        parts = copy.deepcopy(PARTS)
        parts["slider"] = ([R + L, 0, 2 * T], [30, 20, T])
        make_job("job-crank-b1", parts)
        models.current_version("job-job-crank-b1", models.job_sources("job-crank-b1")[0])
        changed = models.status("job-job-crank-b1")
        self.assertEqual(changed["state"], "NEEDS_VALIDATION")
        self.assertIn("v1 → v2", changed["reason"])
        s2 = models.setup({"job_id": "job-crank-b1"})
        self.assertEqual((s2["revision"], s2["design_version"], s2["state"]), (2, 2, "READY"))
        self.assertEqual([(r["revision"], r["current"]) for r in s2["runs"]], [(1, False)])
        # One value changed, nothing rewritten: another revision, validated again
        v3 = service.update_design(design_id, {"changes": {"motors": [{"id": "drive", "speed_rpm": 30}]}, "note": "chậm lại"})
        self.assertEqual(v3["revision"], 3)
        s3 = models.status("job-job-crank-b1")
        self.assertEqual((s3["revision"], s3["state"]), (3, "READY"))
        self.assertTrue(all(not r["current"] for r in s3["runs"]))
        self.assertEqual(models.viewer(design_id)["origin"]["revision"], "3")


class C_Invalid(unittest.TestCase):
    def test_contradicting_joint_is_refused(self):
        mechanism = copy.deepcopy(MECHANISM)
        mechanism["joints"].append({"id": "weld", "type": "fixed", "part_a": "base", "part_b": "crank", "position": [0, 0, -3]})
        make_job("job-crank-c1", mechanism=mechanism)
        s = models.setup({"job_id": "job-crank-c1"})
        self.assertEqual(s["state"], "INVALID")
        with self.assertRaises(MechError) as caught:
            models.viewer(s["design_id"])
        self.assertEqual((caught.exception.status, caught.exception.code), (422, "NOT_VALID"))
        errors = caught.exception.details["diagnostics"]
        at_fault = {(d["code"], tuple(sorted(d.get("parts") or [])), tuple(sorted(d.get("joints") or []))) for d in errors}
        self.assertTrue(any(code == "MOTOR_ON_LOCKED_PAIR" and "crank" in parts for code, parts, _ in at_fault), at_fault)
        self.assertTrue(any("weld" in joints for _, _, joints in at_fault), at_fault)


class D_Contact(unittest.TestCase):
    def test_block_on_plate_brings_its_hull(self):
        parts = {"plate": ([0, 0, -5], [200, 200, 10]), "block": ([0, 0, 30], [20, 20, 20])}
        mechanism = {"parts": {"plate": {"fixed": True, "collision": True, "friction": 0.4},
                               "block": {"mass": 0.1, "collision": True, "friction": 0.4}},
                     "simulation": {"duration": 1, "time_step": 0.001}}
        make_job("job-drop-d1", parts, mechanism)
        s = models.setup({"job_id": "job-drop-d1"})
        self.assertEqual(s["state"], "READY", s.get("reason"))
        mech = models.viewer(s["design_id"])["mechanism"]
        self.assertTrue(mech["simulation"]["collision"]["enabled"])
        block = next(b for b in mech["bodies"] if b["id"] == "block")
        self.assertTrue(block["collision"])
        self.assertGreaterEqual(len(block["collision_hull"]), 8)
        self.assertEqual(block["material"]["friction"], 0.4)
        self.assertAlmostEqual(block["mass"], 0.1)
        normalised = sim.normalise(mech)["model"]
        # The hull came with the body: the live container (no trimesh) needs nothing else
        self.assertTrue(next(b for b in normalised["bodies"] if b["id"] == "block")["hull_points"])

    def test_collision_without_friction_is_asked(self):
        parts = {"plate": ([0, 0, -5], [200, 200, 10]), "block": ([0, 0, 30], [20, 20, 20])}
        mechanism = {"parts": {"plate": {"fixed": True, "collision": True, "friction": 0.4},
                               "block": {"mass": 0.1, "collision": True}},
                     "simulation": {"duration": 1, "time_step": 0.001}}
        make_job("job-drop-d2", parts, mechanism)
        s = models.setup({"job_id": "job-drop-d2"})
        self.assertEqual(s["state"], "INVALID")
        self.assertTrue(any("friction" in m["path"] for m in s["validation"]["missing"]))


if __name__ == "__main__":
    unittest.main()
