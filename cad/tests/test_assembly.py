"""
Assemblies keep their parts (build.py, guide.md "Assemblies that move"): a model's `components` and `mechanism`
become components/<name>.stl in their assembled places and assembly.json, which the dashboard simulates as is
(docs/model-simulation.md); a single part writes neither.

    cd /opt/cad && python -m unittest tests.test_assembly
"""

import json
import struct
import subprocess
import sys
import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
