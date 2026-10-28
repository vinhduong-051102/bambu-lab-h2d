"""
The orchestrator (sim/runs.py) end to end in the mesh3d container: a stored mechanism grown with add_part, a run
through Chrono's Python, its result files and summary, cancelling, and the Blender playback with its own check of
positions and turning direction.

    cd /opt/mesh3d && python -m unittest sim.tests.test_runs
"""

import json
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path

SIM_DIR = Path(tempfile.mkdtemp(prefix="sim-runs-test-"))
os.environ["SIM_DIR"] = str(SIM_DIR)
os.environ.setdefault("JOBS_DIR", str(SIM_DIR / "jobs"))

from sim import runs  # noqa: E402 - reads SIM_DIR when imported

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
HAVE_CHRONO = runs.ready()
HAVE_BLENDER = shutil.which(runs.BLENDER) is not None and shutil.which("xvfb-run") is not None
runs.start()


def example(name):
    return json.loads((EXAMPLES / f"{name}.json").read_text(encoding="utf-8"))


def wait(sim_id, timeout=120, playback=False):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = runs.status(sim_id)
        state = (status.get("playback") or {}).get("state") if playback else status["state"]
        if state in ("completed", "failed", "cancelled"):
            return status
        time.sleep(0.2)
    raise TimeoutError(sim_id)


class Mechanisms(unittest.TestCase):
    def test_grow_a_mechanism(self):
        m = example("motor_shaft")
        joints, actuators = m.pop("joints"), m.pop("actuators")
        created = runs.create_mechanism(m)
        mid = created["mechanism_id"]
        self.assertTrue(created["validation"]["valid"])
        for joint in joints:
            runs.add_part(mid, "joints", joint)
        result = runs.add_part(mid, "actuators", actuators[0])
        self.assertTrue(result["validation"]["valid"])
        self.assertEqual(len(runs.load_mechanism(mid)["joints"]), 2)

    def test_bad_part_is_refused_and_not_saved(self):
        mid = runs.create_mechanism(example("motor_shaft"))["mechanism_id"]
        with self.assertRaises(runs.SimError) as caught:
            runs.add_part(mid, "joints", {"id": "j9", "type": "revolute", "body_a": "base", "body_b": "ghost",
                                          "position": [0, 0, 0], "axis": [0, 0, 1]})
        self.assertEqual(caught.exception.status, 422)
        self.assertEqual(caught.exception.details[0]["path"], "joints[2].body_b")
        self.assertEqual(len(runs.load_mechanism(mid)["joints"]), 2)

    def test_duplicate_part(self):
        mid = runs.create_mechanism(example("motor_shaft"))["mechanism_id"]
        with self.assertRaises(runs.SimError) as caught:
            runs.add_part(mid, "joints", {**example("motor_shaft")["joints"][0]})
        self.assertEqual(caught.exception.status, 409)

    def test_files_stay_inside_the_data(self):
        for name in ("../etc/passwd", "jobs/../../etc/passwd.stl", "sim/runs/x/model.stl", "/etc/passwd"):
            with self.subTest(name), self.assertRaises(ValueError):
                runs.resolve_file(name)

    def test_invalid_mechanism_is_not_run(self):
        m = example("motor_shaft")
        del m["bodies"][1]["density"]
        with self.assertRaises(runs.SimError) as caught:
            runs.start_run(m)
        self.assertEqual(caught.exception.code, "INVALID_MECHANISM")
        self.assertTrue(any(e["path"] == "bodies[1].mass" for e in caught.exception.details))

    def test_garbage_is_a_validation_error(self):
        result = runs.validate({"schema_version": 1, "units": {"length": "mm"}, "bodies": [{"id": "a",
                                "position": "here"}]})
        self.assertFalse(result["valid"])


@unittest.skipUnless(HAVE_CHRONO, "Chrono's Python is not installed")
class Runs(unittest.TestCase):
    def test_run_and_results(self):
        started = runs.start_run(example("motor_shaft"))
        status = wait(started["sim_id"])
        self.assertEqual(status["state"], "completed", status)
        out = runs.results(started["sim_id"])
        folder = SIM_DIR / "runs" / started["sim_id"]
        for name in ("metadata.json", "body_transforms.csv", "joint_results.csv", "simulation.log", "summary.json",
                     "model.json", "mechanism.json"):
            self.assertTrue((folder / name).is_file(), name)
        summary = out["summary"]
        self.assertTrue(summary["checks_passed"], summary["checks"])
        self.assertAlmostEqual(summary["bodies"]["shaft"]["max_angular_speed_rad_s"], 6.2832, places=3)
        self.assertEqual(out["metadata"]["engine_version"], "10.0.0")
        self.assertTrue(out["metadata"]["assumptions"])

    def test_runs_do_not_share_folders(self):
        a = runs.start_run(example("gear_pair"))["sim_id"]
        b = runs.start_run(example("gear_pair"))["sim_id"]
        self.assertNotEqual(a, b)
        self.assertEqual(wait(a)["state"], "completed")
        self.assertEqual(wait(b)["state"], "completed")

    def test_cancel(self):
        m = example("motor_shaft")
        m["simulation"].update(duration=600, time_step=0.0005, output_interval=0.1)
        sim_id = runs.start_run(m)["sim_id"]
        deadline = time.monotonic() + 30
        while runs.status(sim_id)["state"] != "running" and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertTrue(runs.cancel(sim_id))
        self.assertEqual(wait(sim_id)["state"], "cancelled")

    def test_simulation_override(self):
        sim_id = runs.start_run(example("motor_shaft"), simulation={"duration": 0.5})["sim_id"]
        wait(sim_id)
        self.assertAlmostEqual(runs.results(sim_id)["summary"]["duration_s"], 0.5)


@unittest.skipUnless(HAVE_CHRONO and HAVE_BLENDER, "needs Chrono and Blender")
class Playback(unittest.TestCase):
    def test_playback_matches_chrono(self):
        # 30 fps puts frames between the 0.01/0.02 s samples, where angles past ±π must still interpolate right
        for name in ("motor_shaft", "gear_pair"):
            with self.subTest(name):
                sim_id = runs.start_run(example(name))["sim_id"]
                self.assertEqual(wait(sim_id)["state"], "completed")
                runs.start_playback(sim_id, {"render": False, "fps": 30})
                play = wait(sim_id, timeout=300, playback=True)["playback"]
                self.assertEqual(play["state"], "completed", play)
                check = play["check"]
                self.assertTrue(check["passed"], check)
                self.assertLess(check["max_position_error_mm"], 0.01)
                self.assertTrue(all(e < 0.1 for e in check["joint_angle_error_deg"].values()), check)
                self.assertTrue((SIM_DIR / "runs" / sim_id / "blender" / "playback.blend").is_file())


if __name__ == "__main__":
    unittest.main()
