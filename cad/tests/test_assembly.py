"""
Assemblies keep their parts (build.py, guide.md "Assemblies that move"): a model's `components` and `mechanism`
become components/<name>.stl in their assembled places and assembly.json, which the dashboard simulates as is
(docs/model-simulation.md); a single part writes neither. assembly_guide.py then draws how to put them together.

    cd /opt/cad && python -m unittest tests.test_assembly
"""

import json
import re
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent

HINGE = """
from build123d import Box, Cylinder, Pos, Rot
base = Pos(0, 0, 5) * Box(60, 30, 10)
arm = Pos(40, 0, 15) * Box(60, 10, 6)
components = {"base": base, "arm": arm}
mechanism = {
    "parts": {"base": {"fixed": True, "role": "frame"}, "arm": {"role": "arm", "material": "pla"}},
    "joints": [{"id": "hinge", "type": "revolute", "part_a": "base", "part_b": "arm", "position": [15, 0, 12], "axis": [0, 0, 1]}],
    "motors": [{"id": "drive", "joint": "hinge", "speed_rpm": 30}],
}
result = [Pos(0, 0, 5) * Box(60, 30, 10), Pos(0, 40, 3) * Box(60, 10, 6)]
"""


def build(code):
    job = Path(tempfile.mkdtemp(prefix="assembly-job-"))
    (job / "model.py").write_text(code, encoding="utf-8")
    done = subprocess.run([sys.executable, str(HERE / "build.py"), "model.py"], cwd=job,
                          capture_output=True, text=True, timeout=300, check=False)
    return done, job / "out"


def guide(out):
    done = subprocess.run([sys.executable, str(HERE / "assembly_guide.py"), str(out)],
                          capture_output=True, text=True, timeout=300, check=False)
    return done, json.loads(done.stdout)


def stl_bounds(path):
    data = path.read_bytes()
    count = struct.unpack_from("<I", data, 80)[0]
    points = [struct.unpack_from("<3f", data, 84 + i * 50 + 12 + k * 12) for i in range(count) for k in range(3)]
    return [min(p[a] for p in points) for a in range(3)], [max(p[a] for p in points) for a in range(3)]


class AssemblyTest(unittest.TestCase):
    def test_components_and_mechanism(self):
        done, out = build(HINGE)
        report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(done.returncode, 0, report.get("error"))
        self.assertEqual(report["components"], ["base", "arm"])
        assembly = json.loads((out / "assembly.json").read_text(encoding="utf-8"))
        self.assertEqual([c["file"] for c in assembly["components"]], ["components/base.stl", "components/arm.stl"])
        self.assertEqual(assembly["mechanism"]["joints"][0]["part_b"], "arm")
        self.assertEqual(assembly["from"], "components")
        # In the assembled place, not the print layout: the arm above the base, x 10–70 mm, z 12–18 mm
        low, high = stl_bounds(out / "components" / "arm.stl")
        for got, want in zip(low + high, [10, -5, 12, 70, 5, 18]):
            self.assertAlmostEqual(got, want, places=3)
        # The print layout is still what model.stl holds; assembly.png draws the assembled one
        self.assertEqual(report["solids"], 2)
        self.assertIn("assembly.png", report["files"])
        self.assertTrue((out / "assembly.png").stat().st_size > 0)

    def test_mechanism_naming_no_component_fails(self):
        done, out = build(HINGE.replace('"part_b": "arm"', '"part_b": "lid"'))
        report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(done.returncode, 1)
        self.assertIn("'lid'", report["error"])

    def test_single_part_writes_no_assembly(self):
        done, out = build("from build123d import Box\nresult = Box(20, 20, 20)\n")
        self.assertEqual(done.returncode, 0)
        self.assertFalse((out / "assembly.json").exists())
        self.assertFalse((out / "assembly.png").exists())
        self.assertEqual(json.loads((out / "report.json").read_text(encoding="utf-8"))["components"], [])

    def test_guide_from_mechanism(self):
        _, out = build(HINGE)
        done, result = guide(out)
        self.assertEqual(done.returncode, 0, result.get("error"))
        steps = result["steps"]
        self.assertEqual([s["parts"] for s in steps], [["base"], ["arm"]])
        self.assertEqual(result["order"], "mechanism")
        # The arm turns about Z on the base, so it goes on along Z
        self.assertEqual(steps[1]["onto"], "base")
        self.assertEqual(steps[1]["joints"], [{"id": "hinge", "type": "revolute", "part": "arm"}])
        self.assertEqual([abs(c) for c in steps[1]["moves_along"]["arm"]], [0, 0, 1])
        # From above, as the arm sits above the base, down onto it
        self.assertEqual(steps[1]["moves_along"]["arm"][2], -1)
        self.assertIn("Lồng arm vào base", steps[1]["text"])
        for name in ("step-01.png", "step-02.png", "done.png"):
            self.assertTrue((out / "guide" / name).stat().st_size > 0)
        if result["video"]:
            self.assertGreater((out / "guide" / "assembly.mp4").stat().st_size, 0)
            self.assertGreater(result["video_seconds"], 2)
        else:
            self.assertIn("ffmpeg", result["video_error"])
        # A build of the model again clears the guide of the one before
        build_again = subprocess.run([sys.executable, str(HERE / "build.py"), "model.py"], cwd=out.parent,
                                     capture_output=True, text=True, timeout=300, check=False)
        self.assertEqual(build_again.returncode, 0)
        self.assertFalse((out / "guide").exists())

    def test_guide_from_the_models_steps(self):
        code = HINGE + 'assembly_steps = [{"parts": ["arm"], "text": "Đặt tay lên trước.", "direction": [0, 0, -1]}]\n'
        _, out = build(code)
        self.assertEqual(json.loads((out / "assembly.json").read_text(encoding="utf-8"))["steps"][0]["parts"], ["arm"])
        done, result = guide(out)
        self.assertEqual(done.returncode, 0, result.get("error"))
        self.assertEqual(result["order"], "model")
        self.assertEqual([s["parts"] for s in result["steps"]], [["arm"], ["base"]])
        self.assertEqual(result["steps"][0]["text"], "Đặt tay lên trước.")
        self.assertEqual(result["steps"][0]["moves_along"]["arm"], [0, 0, -1])

    def test_bad_steps_fail_the_build(self):
        done, out = build(HINGE + 'assembly_steps = [{"parts": ["lid"]}]\n')
        self.assertEqual(done.returncode, 1)
        self.assertIn("'lid'", json.loads((out / "report.json").read_text(encoding="utf-8"))["error"])

    def test_no_guide_for_a_print_layout(self):
        _, out = build("from build123d import Box, Pos\nresult = [Box(10, 10, 10), Pos(30, 0, 0) * Box(10, 10, 10)]\n")
        done, result = guide(out)
        self.assertEqual(done.returncode, 1)
        self.assertIn("components", result["error"])


    def test_print_layout_turns_and_packs_parts(self):
        # A plate standing on its edge lies down; six 200 mm plates need several H2D plates; the steel pin is bought
        code = (
            "from build123d import Box, Cylinder, Pos\n"
            "components = {f'panel_{k}': Pos(0, 0, 100 + 300 * k) * Box(4, 200, 200) for k in range(6)}\n"
            "components['pin'] = Pos(500, 0, 0) * Cylinder(2, 40)\n"
            "components['knob'] = Pos(600, 0, 0) * Box(10, 10, 10)\n"
            "not_printed = ['knob']\n"
            "mechanism = {'parts': {'panel_0': {'fixed': True}, 'pin': {'material': 'steel'}}}\n"
            "result = Box(1, 1, 1)\n"
        )
        done, out = build(code)
        report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(done.returncode, 0, report.get("error"))
        layout = report["print_layout"]
        self.assertEqual(layout["not_printed"], {"knob": "not_printed", "pin": "steel"})
        self.assertGreaterEqual(len(layout["plates"]), 2)
        self.assertEqual(sorted(n for p in layout["plates"] for n in p["parts"]), [f"panel_{k}" for k in range(6)])
        for part in layout["parts"].values():
            self.assertAlmostEqual(part["height_mm"], 4, places=2)
        self.assertTrue(any("`result` is ignored" in w for w in report["warnings"]))
        # Each part of the 3MF on its plate, for Bambu Studio
        with zipfile.ZipFile(out / "model.3mf") as z:
            config = z.read("Metadata/model_settings.config").decode()
        self.assertEqual(config.count("<plate>"), len(layout["plates"]))
        self.assertEqual(config.count("<model_instance>"), 6)
        # And each plate on its own, its parts within that plate (what Studio is sent)
        self.assertEqual(layout["plate_files"], [f"plates/plate-{p['n']}.3mf" for p in layout["plates"]])
        for plate, file in zip(layout["plates"], layout["plate_files"]):
            with zipfile.ZipFile(out / file) as z:
                model = z.read("3D/3dmodel.model").decode()
            xs = [float(v) for v in re.findall(r'x="([-\d.]+)"', model)]
            ys = [float(v) for v in re.findall(r'y="([-\d.]+)"', model)]
            self.assertEqual(model.count("<object "), len(plate["parts"]))
            self.assertGreaterEqual(min(xs), 25 - 1e-6)
            self.assertLessEqual(max(xs), 325 + 1e-6)
            self.assertGreaterEqual(min(ys), -1e-6)
            self.assertLessEqual(max(ys), 320 + 1e-6)
        # Every part within the plate both nozzles reach, at its plate's place
        self.assertEqual(report["solids"], 6)
        self.assertAlmostEqual(report["min_mm"][2], 0, places=2)

    def test_manual_print_layout_keeps_result(self):
        done, out = build(HINGE + 'print_layout = "manual"\n')
        report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(done.returncode, 0, report.get("error"))
        self.assertNotIn("print_layout", report)
        self.assertFalse((out / "model.3mf").exists())
        self.assertEqual(report["max_mm"][1], 45)

    def test_nothing_to_print_fails(self):
        done, out = build(HINGE + 'not_printed = ["base", "arm"]\n')
        self.assertEqual(done.returncode, 1)
        self.assertIn("nothing to print", json.loads((out / "report.json").read_text(encoding="utf-8"))["error"])


if __name__ == "__main__":
    unittest.main()
