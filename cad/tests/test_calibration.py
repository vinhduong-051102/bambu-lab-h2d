"""
The tolerance calibration print (calibration.py), in the cad image: it builds through build.py into a watertight
STL, and every hole, pin, slot and block is its nominal size to 0.01 mm, probed just inside and just outside each
edge of the exact (OpenCascade) geometry.

    cd /opt/cad && python -m unittest tests.test_calibration
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import calibration

HERE = Path(__file__).resolve().parent.parent
# How far either side of a nominal edge the probes go
EPS = 0.01


class CalibrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec = calibration.layout()
        model = calibration.calibration_plate()
        cls.parts = {child.label: child for child in model.children}

    def assert_material(self, part, point, inside):
        found = self.parts[part].is_inside(point, tolerance=1e-4)
        self.assertEqual(found, inside, f"{part} at {tuple(round(v, 3) for v in point)}: "
                                        f"{'expected material' if inside else 'expected empty'}")

    def test_parts(self):
        self.assertEqual(sorted(self.parts), ["fit_pin", "horizontal_holes", "plate", "xy_block"])
        for part in self.parts.values():
            self.assertEqual(len(part.solids()), 1)
            self.assertAlmostEqual(part.bounding_box().min.Z, 0, places=6)

    def test_holes(self):
        t = self.spec["params"]["plate_thickness"]
        self.assertEqual([h["diameter"] for h in self.spec["holes"]], [3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
        for hole in self.spec["holes"]:
            (x, y), r = hole["centre"], hole["diameter"] / 2
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                for z in (0.3, t / 2, t - 0.3):
                    self.assert_material("plate", (x + dx * (r - EPS), y + dy * (r - EPS), z), False)
                    self.assert_material("plate", (x + dx * (r + EPS), y + dy * (r + EPS), z), True)

    def test_pins(self):
        t = self.spec["params"]["plate_thickness"]
        for pin in self.spec["pins"]:
            (x, y), r, top = pin["centre"], pin["diameter"] / 2, t + pin["height"]
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                for z in (t + 0.5, t + pin["height"] / 2, top - 0.5):
                    self.assert_material("plate", (x + dx * (r - EPS), y + dy * (r - EPS), z), True)
                    self.assert_material("plate", (x + dx * (r + EPS), y + dy * (r + EPS), z), False)
            self.assert_material("plate", (x, y, top - EPS), True)
            self.assert_material("plate", (x, y, top + EPS), False)

    def test_slots(self):
        t = self.spec["params"]["plate_thickness"]
        self.assertEqual([round(s["width"], 3) for s in self.spec["slots"]], [6.2, 6.4, 6.6, 6.8, 7.0])
        for slot in self.spec["slots"]:
            x, half, length = slot["centre_x"], slot["width"] / 2, slot["length"]
            for y in (0.5, (length - half) / 2):
                for side in (1, -1):
                    self.assert_material("plate", (x + side * (half - EPS), y, t / 2), False)
                    self.assert_material("plate", (x + side * (half + EPS), y, t / 2), True)
            self.assert_material("plate", (x, length - EPS, t / 2), False)
            self.assert_material("plate", (x, length + EPS, t / 2), True)

    def test_plate_thickness(self):
        t = self.spec["params"]["plate_thickness"]
        # Between the first slot and the plate's left edge: plain plate
        x = self.spec["slots"][0]["centre_x"] - self.spec["slots"][0]["width"] / 2 - 1
        self.assert_material("plate", (x, 2, t - EPS), True)
        self.assert_material("plate", (x, 2, t + EPS), False)

    def test_xy_block(self):
        box = self.parts["xy_block"].bounding_box()
        for got, want in zip(box.size, (20, 20, 10)):
            self.assertAlmostEqual(got, want, delta=1e-6)
        self.assertAlmostEqual(self.parts["xy_block"].volume, 20 * 20 * 10, delta=1e-6)

    def test_fit_pin(self):
        pin = self.spec["fit_pin"]
        (x, y), r = pin["centre"], pin["diameter"] / 2
        self.assertEqual(pin["diameter"], 6)
        for dx, dy in ((1, 0), (0, 1)):
            self.assert_material("fit_pin", (x + dx * (r - EPS), y + dy * (r - EPS), pin["height"] / 2), True)
            self.assert_material("fit_pin", (x + dx * (r + EPS), y + dy * (r + EPS), pin["height"] / 2), False)
        self.assertAlmostEqual(self.parts["fit_pin"].bounding_box().size.Z, pin["height"], delta=1e-6)

    def test_horizontal_holes(self):
        cross = self.spec["cross"]
        _, cy, _ = cross["min"]
        self.assertEqual([h["diameter"] for h in cross["holes"]], [6, 10])
        for hole in cross["holes"]:
            (x, z), r = hole["centre_xz"], hole["diameter"] / 2
            for y in (cy + 0.5, cy + cross["size"][1] / 2, cy + cross["size"][1] - 0.5):
                for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    self.assert_material("horizontal_holes", (x + dx * (r - EPS), y, z + dz * (r - EPS)), False)
                    self.assert_material("horizontal_holes", (x + dx * (r + EPS), y, z + dz * (r + EPS)), True)

    def test_parameters(self):
        spec = calibration.layout(clearances=[0.15, 0.25], fit_pin_diameter=8)
        self.assertEqual([round(s["width"], 3) for s in spec["slots"]], [8.3, 8.5])
        with self.assertRaises(ValueError):
            calibration.layout(hole_size=3)


class CalibrationBuildTest(unittest.TestCase):
    def test_builds_a_watertight_stl(self):
        out = Path(tempfile.mkdtemp(prefix="calibration-"))
        done = subprocess.run([sys.executable, str(HERE / "build.py"), str(HERE / "calibration.py"), str(out)],
                              capture_output=True, text=True, timeout=300, check=False)
        report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(done.returncode, 0, report.get("error"))
        self.assertEqual(report["solids"], 4)
        self.assertTrue(report["mesh"]["watertight"], report["mesh"])
        self.assertEqual(report["warnings"], [])
        self.assertEqual(report["min_mm"][2], 0)
        self.assertTrue((out / "model.stl").stat().st_size > 0)

    def test_imports_from_a_job_model(self):
        """As a CAD job's model.py (or /api/cad/builds code) would use it"""
        job = Path(tempfile.mkdtemp(prefix="calibration-job-"))
        (job / "model.py").write_text("from calibration import calibration_plate\n"
                                      "result = calibration_plate(clearances=[0.2, 0.3])\n", encoding="utf-8")
        done = subprocess.run([sys.executable, str(HERE / "build.py"), "model.py"], cwd=job,
                              capture_output=True, text=True, timeout=300, check=False)
        report = json.loads((job / "out" / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(done.returncode, 0, report.get("error"))
        self.assertTrue(report["mesh"]["watertight"])


if __name__ == "__main__":
    unittest.main()
