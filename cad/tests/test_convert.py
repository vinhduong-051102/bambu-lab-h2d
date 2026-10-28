"""
STEP/IGES to STL (convert.py) and the worker's POST /convert, in the cad image (build123d with OpenCascade):

    cd /opt/cad && python -m unittest discover -s tests -t .
"""

import base64
import json
import math
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

JOBS = Path(tempfile.mkdtemp(prefix="cad-convert-test-"))
os.environ["JOBS_DIR"] = str(JOBS)

import worker  # noqa: E402 - reads JOBS_DIR when imported
from build import mesh_check, read_stl  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
BOX = 20 * 10 * 5
CYLINDER = math.pi * 4**2 * 20


def two_solids():
    """A 20 × 10 × 5 box and a Ø8 × 20 cylinder beside it, named"""
    from build123d import Align, Box, Compound, Cylinder, Location

    box = Box(20, 10, 5, align=Align.MIN)
    box.label = "box"
    cylinder = Cylinder(4, 20, align=Align.MIN).moved(Location((40, 0, 0)))
    cylinder.label = "cylinder"
    parts = Compound(children=[box, cylinder])
    parts.label = "parts"
    return parts


def convert(source, out, *args):
    done = subprocess.run([sys.executable, str(HERE / "convert.py"), str(source), str(out), *map(str, args)],
                          capture_output=True, text=True, timeout=300, check=False)
    return done.returncode, json.loads((out / "convert.json").read_text(encoding="utf-8"))


class ConvertTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="convert-", dir=JOBS))

    def assert_two_solids(self, report):
        self.assertTrue(report["ok"], report.get("error"))
        self.assertEqual(len(report["solids"]), 2)
        box, cylinder = sorted(report["solids"], key=lambda s: s["volume_mm3"])
        self.assertAlmostEqual(box["volume_mm3"] / (BOX), 1, delta=0.001)
        self.assertAlmostEqual(cylinder["volume_mm3"] / (CYLINDER), 1, delta=0.001)
        for solid, size in ((box, [20, 10, 5]), (cylinder, [8, 8, 20])):
            for got, want in zip(solid["bbox"]["size"], size):
                self.assertAlmostEqual(got, want, delta=0.01)
            stl = self.dir / "out" / solid["file"]
            self.assertTrue(stl.is_file())
            mesh = mesh_check(read_stl(stl))
            self.assertTrue(mesh["watertight"])
            self.assertEqual(solid["mesh"]["triangles"], mesh["triangles"])
        self.assertEqual(box["faces"], 6)
        self.assertEqual(cylinder["faces"], 3)
        return box, cylinder

    def test_step_with_two_solids(self):
        from build123d import export_step

        source = self.dir / "parts.step"
        export_step(two_solids(), str(source))
        code, report = convert(source, self.dir / "out")
        self.assertEqual(code, 0)
        box, cylinder = self.assert_two_solids(report)
        self.assertEqual(report["units"], "millimetre")
        self.assertEqual((box["name"], cylinder["name"]), ("box", "cylinder"))
        self.assertEqual((box["file"], cylinder["file"]), ("01-box.stl", "02-cylinder.stl"))
        self.assertEqual((report["tolerance_mm"], report["angular_tolerance_deg"]), (0.01, 0.5))

    def test_step_in_inches_comes_out_in_mm(self):
        from OCP.Interface import Interface_Static
        from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

        # The same parts written in inches (20 mm as 0.787 in): read back in mm, the file's unit reported
        source = self.dir / "parts.stp"
        writer = STEPControl_Writer()
        Interface_Static.SetCVal_s("write.step.unit", "INCH")
        try:
            writer.Transfer(two_solids().wrapped, STEPControl_AsIs)
            writer.Write(str(source))
        finally:
            Interface_Static.SetCVal_s("write.step.unit", "MM")
        self.assertIn("CONVERSION_BASED_UNIT('INCH'", source.read_text())
        code, report = convert(source, self.dir / "out")
        self.assertEqual(code, 0)
        self.assert_two_solids(report)
        self.assertEqual(report["units"], "inch")

    def test_coarser_tolerance_makes_fewer_triangles(self):
        from build123d import export_step

        source = self.dir / "parts.step"
        export_step(two_solids(), str(source))
        _, fine = convert(source, self.dir / "out")
        _, coarse = convert(source, self.dir / "out", 0.1, 5)
        self.assertLess(coarse["solids"][1]["mesh"]["triangles"], fine["solids"][1]["mesh"]["triangles"])

    def test_iges_solids_and_units(self):
        from OCP.IGESControl import IGESControl_Writer

        source = self.dir / "parts.igs"
        writer = IGESControl_Writer("MM", 1)  # mode 1: BRep solids
        for solid in two_solids().solids():
            writer.AddShape(solid.wrapped)
        writer.ComputeModel()
        self.assertTrue(writer.Write(str(source)))
        code, report = convert(source, self.dir / "out")
        self.assertEqual(code, 0)
        self.assert_two_solids(report)
        self.assertEqual(report["units"], "millimetre")

    def test_iges_of_surfaces_is_sewn_into_a_solid(self):
        from build123d import Align, Box
        from OCP.IGESControl import IGESControl_Writer

        source = self.dir / "surfaces.iges"
        writer = IGESControl_Writer("MM", 0)  # mode 0: trimmed surfaces, no solid
        for face in Box(20, 10, 5, align=Align.MIN).faces():
            writer.AddShape(face.wrapped)
        writer.ComputeModel()
        self.assertTrue(writer.Write(str(source)))
        code, report = convert(source, self.dir / "out")
        self.assertEqual(code, 0, report.get("error"))
        self.assertEqual(len(report["solids"]), 1)
        self.assertAlmostEqual(report["solids"][0]["volume_mm3"] / BOX, 1, delta=0.001)
        self.assertTrue(report["solids"][0]["mesh"]["watertight"])
        self.assertTrue(any("khâu" in w for w in report["warnings"]))

    def test_broken_file_fails_without_stl(self):
        source = self.dir / "broken.step"
        source.write_text("ISO-10303-21;\nHEADER;\nthis is not a step file\n")
        code, report = convert(source, self.dir / "out")
        self.assertEqual(code, 1)
        self.assertFalse(report["ok"])
        self.assertIn("STEP", report["error"])
        self.assertEqual(list((self.dir / "out").glob("*.stl")), [])

    def test_a_new_conversion_replaces_the_last_ones_stls(self):
        from build123d import Box, export_step

        source = self.dir / "parts.step"
        export_step(two_solids(), str(source))
        convert(source, self.dir / "out")
        export_step(Box(5, 5, 5), str(source))
        _, report = convert(source, self.dir / "out")
        self.assertEqual(sorted(p.name for p in (self.dir / "out").glob("*.stl")), [report["solids"][0]["file"]])


class WorkerConvertTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = worker.ThreadingHTTPServer(("127.0.0.1", 0), worker.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/convert"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, body):
        request = urllib.request.Request(self.url, json.dumps(body).encode(), {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=300) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    def step_bytes(self):
        from build123d import export_step

        path = JOBS / "parts-upload.step"
        export_step(two_solids(), str(path))
        return path.read_bytes()

    def test_upload_makes_a_job_with_one_stl_per_solid(self):
        status, body = self.post({"data_base64": base64.b64encode(self.step_bytes()).decode(), "filename": "parts.step"})
        self.assertEqual(status, 200, body)
        self.assertTrue(worker.JOB_ID_RE.match(body["job_id"]))
        job = JOBS / body["job_id"]
        self.assertTrue((job / "input" / "parts.step").is_file())
        self.assertEqual(sorted(p.name for p in (job / "out").glob("*.stl")), ["01-box.stl", "02-cylinder.stl"])
        self.assertEqual(body["units"], "millimetre")
        self.assertNotIn("traceback", body)

    def test_file_in_a_job_folder(self):
        job = JOBS / "20261028-120000-abcd"
        job.mkdir(exist_ok=True)
        (job / "parts.step").write_bytes(self.step_bytes())
        status, body = self.post({"file": "20261028-120000-abcd/parts.step", "tolerance_mm": 0.05})
        self.assertEqual(status, 200, body)
        self.assertEqual((body["job_id"], len(body["solids"]), body["tolerance_mm"]), (job.name, 2, 0.05))

    def test_broken_upload_is_a_clear_error_without_stl(self):
        data = base64.b64encode(b"ISO-10303-21;\nnot really\n").decode()
        status, body = self.post({"data_base64": data, "filename": "broken.step", "job_id": "20261028-120001-dcba"})
        self.assertEqual((status, body["error"]), (422, "CONVERT_FAILED"))
        self.assertIn("STEP", body["message"])
        self.assertEqual(list((JOBS / "20261028-120001-dcba" / "out").glob("*.stl")), [])

    def test_bad_requests(self):
        for request, words in (
            ({}, "data_base64"),
            ({"file": "/etc/passwd"}, "nằm trong"),
            ({"file": "../outside.step"}, "nằm trong"),
            ({"data_base64": "aGVsbG8=", "filename": "model.stl"}, ".step"),
            ({"data_base64": "not base64!", "filename": "a.step"}, "base64"),
            ({"data_base64": "aGVsbG8=", "filename": "a.step", "tolerance_mm": 5}, "tolerance_mm"),
            ({"data_base64": "aGVsbG8=", "filename": "a.step", "job_id": "../x"}, "job_id"),
        ):
            status, body = self.post(request)
            self.assertEqual(status, 400, request)
            self.assertIn(words, body["message"], request)


if __name__ == "__main__":
    unittest.main()
