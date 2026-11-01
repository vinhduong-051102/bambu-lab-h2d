"""
Models in text-to-cad's format (docs/text-to-cad.md, guide.md): build.py builds a file's `@model` with cadgen's
engine, takes an assembly's labelled children as its components, exports STEP and GLB through cadgen and draws the
preview with `cadgen snapshot`; drawing.py and dfam.py make the engineering drawing and the DfAM check of a built
model. The snapshot needs an X display (the worker starts Xvfb): without one, the preview falls back to matplotlib.

    cd /opt/cad && python -m unittest tests.test_text_to_cad
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent

PART = """
import build123d as bd
from cadgen import model

WIDTH, DEPTH, HEIGHT = 40.0, 20.0, 10.0


@model
def plate():
    body = bd.Box(WIDTH, DEPTH, HEIGHT, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    body -= bd.Cylinder(4, HEIGHT, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    body.label = "plate"
    body.color = "#4a6fa5"
    return body


@model
def plate_wide():
    body = bd.Box(80, DEPTH, HEIGHT, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    body.label = "plate_wide"
    return body


MODEL = "plate"

if __name__ == "__main__":
    plate()
"""

HINGE = """
import build123d as bd
from cadgen import model


def base_body():
    body = bd.Pos(0, 0, 5) * bd.Box(60, 30, 10)
    body.label = "base"
    body.color = "#888888"
    return body


def arm_body():
    body = bd.Pos(40, 0, 15) * bd.Box(60, 10, 6)
    body.label = "arm"
    body.color = "#4a6fa5"
    return body


@model
def hinge():
    return bd.Compound(children=[base_body(), arm_body()])


mechanism = {
    "parts": {"base": {"fixed": True, "role": "frame"}, "arm": {"role": "arm", "material": "pla"}},
    "joints": [{"id": "hinge", "type": "revolute", "part_a": "base", "part_b": "arm", "position": [15, 0, 12],
                "axis": [0, 0, 1]}],
}
"""


# A robot's way: links (sub-assemblies) each holding printed parts and a bought servo
LINKS = """
import build123d as bd
from cadgen import model


def part(label, box, at):
    body = bd.Pos(*at) * bd.Box(*box)
    body.label = label
    return body


@model
def arm():
    base = bd.Compound(children=[part("base_plate", (60, 60, 10), (0, 0, 5)),
                                 part("servo", (20, 40, 36), (0, 0, 28))], label="base")
    link = bd.Compound(children=[part("upper_arm", (80, 12, 6), (40, 0, 49)),
                                 part("upper_cover", (30, 12, 3), (40, 0, 53.5))], label="link")
    return bd.Compound(children=[base, link], label="robot")


print_parts = ["base_plate", "upper_arm", "upper_cover"]
"""


def run(script, *args, cwd):
    return subprocess.run([sys.executable, str(HERE / script), *args], cwd=cwd, capture_output=True, text=True,
                          timeout=600, check=False)


def build(code):
    job = Path(tempfile.mkdtemp(prefix="t2c-job-"))
    (job / "model.py").write_text(code, encoding="utf-8")
    done = run("build.py", "model.py", cwd=job)
    return done, job


class TextToCadTest(unittest.TestCase):
    def test_a_part_is_built_by_the_engine(self):
        done, job = build(PART)
        out = job / "out"
        report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(done.returncode, 0, report.get("error"))
        # The one MODEL names, not the last one defined
        self.assertEqual(report["size_mm"], [40.0, 20.0, 10.0])
        self.assertEqual(report["engine"]["format"], "model")
        self.assertTrue(report["engine"]["document"])
        self.assertTrue(report["mesh"]["watertight"])
        for name in ("model.stl", "model.step", "model.glb", "preview.png"):
            self.assertIn(name, report["files"])
            self.assertGreater((out / name).stat().st_size, 0, name)
        self.assertEqual((out / "model.glb").read_bytes()[:4], b"glTF")
        if Path(f"/tmp/.X11-unix/X{os.environ.get('DISPLAY', ':').lstrip(':')}").exists():
            self.assertEqual(report["engine"]["preview"], "cadgen")
        # Only the report on stdout: the worker reads it from there
        self.assertEqual(json.loads(done.stdout)["ok"], True)

    def test_an_unknown_model_name_is_an_error(self):
        done, job = build(PART.replace('MODEL = "plate"', 'MODEL = "lid"'))
        report = json.loads((job / "out" / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(done.returncode, 1)
        self.assertIn("lid", report["error"])

    def test_an_assembly_keeps_its_labelled_children_as_components(self):
        done, job = build(HINGE)
        out = job / "out"
        report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(done.returncode, 0, report.get("error"))
        self.assertEqual(sorted(report["components"]), ["arm", "base"])
        assembly = json.loads((out / "assembly.json").read_text(encoding="utf-8"))
        self.assertEqual(assembly["from"], "components")
        self.assertEqual(assembly["mechanism"]["joints"][0]["part_b"], "arm")
        # In their assembled places: the arm's centre where the model put it
        arm = next(c for c in assembly["components"] if c["name"] == "arm")
        self.assertEqual([round(v) for v in arm["center_mm"]], [40, 0, 15])
        # Laid out on the plate for printing, with the assembled picture beside it
        self.assertIn("print_layout", report)
        self.assertTrue((out / "assembly.png").exists())
        self.assertTrue((out / "model.3mf").exists())

    def test_an_assembly_of_links_prints_the_parts_it_names(self):
        done, job = build(LINKS)
        out = job / "out"
        report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(done.returncode, 0, report.get("error"))
        # The parts inside the links, not the links; the servo is bought
        self.assertEqual(sorted(report["components"]), ["base_plate", "upper_arm", "upper_cover"])
        assembly = json.loads((out / "assembly.json").read_text(encoding="utf-8"))
        cover = next(c for c in assembly["components"] if c["name"] == "upper_cover")
        self.assertEqual([round(v, 1) for v in cover["center_mm"]], [40.0, 0.0, 53.5])
        placed = {p for plate in report["print_layout"]["plates"] for p in plate["parts"]}
        self.assertEqual(placed, {"base_plate", "upper_arm", "upper_cover"})

    def test_print_parts_must_name_parts_of_the_model(self):
        done, job = build(LINKS.replace('"upper_cover"]', '"upper_cover", "lid"]'))
        report = json.loads((job / "out" / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(done.returncode, 1)
        self.assertIn("lid", report["error"])

    def test_drawing_and_dfam_of_a_built_model(self):
        done, job = build(PART)
        self.assertEqual(done.returncode, 0, done.stdout[-2000:])

        drawn = run("drawing.py", "model.py", "Tấm đế", cwd=job)
        drawing = json.loads(drawn.stdout.splitlines()[-1])
        self.assertTrue(drawing["ok"], drawing.get("error"))
        self.assertEqual(drawing["sheets"], 1)
        self.assertEqual((job / "out" / "drawing.pdf").read_bytes()[:5], b"%PDF-")

        checked = run("dfam.py", "out", cwd=job)
        dfam = json.loads(checked.stdout.splitlines()[-1])
        self.assertTrue(dfam["ok"], dfam.get("error"))
        titles = {f["title"]: f["status"] for f in dfam["findings"]}
        self.assertEqual(titles.get("Lưới kín"), "pass")
        # A 10 mm plate with an 8 mm hole: no wall near the 1.2 mm limit, nothing that needs supports
        self.assertTrue(any(status == "pass" and title.startswith("Thành dày") for title, status in titles.items()), titles)
        self.assertEqual(titles.get("Không cần support"), "pass")
        self.assertTrue((job / "out" / "dfam.json").exists())

    def test_an_assembly_draws_a_sheet_per_printed_part(self):
        done, job = build(HINGE)
        self.assertEqual(done.returncode, 0, done.stdout[-2000:])
        drawn = run("drawing.py", "model.py", cwd=job)
        drawing = json.loads(drawn.stdout.splitlines()[-1])
        self.assertTrue(drawing["ok"], drawing.get("error"))
        self.assertEqual(drawing["sheets"], 2)


if __name__ == "__main__":
    unittest.main()
