"""
The engineering pipeline against parts whose answers are known (eng/, docs/engineering-analysis.md). In the mesh
worker's Python, with FEA_PYTHON pointing at the gmsh + CalculiX environment for the FEA tests:

    cd /opt/mesh3d && ENG_DIR=/tmp/eng-test python -m unittest eng.tests.test_eng

- import: volumes, units (STL in metres, 3MF in inches with two objects), originals kept byte for byte
- validation: inverted normals, non-manifold edges and self-intersections FAIL; open edges only WARN; a clean box
  passes; two blocks overlapping by 500 mm³ are found with that volume
- assembly: a Ø8.4 hole and a Ø8.0 pin are found, coaxial, 0.4 mm clearance, a revolute joint suggested
- clearance: the fit after printing from the printer's tolerances, NOT_EVALUATED without them; a 2 mm plate's wall;
  gear backlash 2·Δa·tan 20° from the centre distance
- printability: a T's overhang area, a horizontal hole, no bed contact
- FEA: a cantilever's tip deflection (Timoshenko) and its stress at mid-span (M·c/I), mesh convergence, no safety
  factor without strengths
- motion: an arm turned by a motor hits a stop block at the angle geometry predicts
- report: eleven sections; nothing run is NOT_EVALUATED, never PASS
"""

import math
import os
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path

import numpy as np
import trimesh

TMP = Path(tempfile.mkdtemp(prefix="eng-test-"))
os.environ.setdefault("ENG_DIR", str(TMP / "eng"))
os.environ["JOBS_DIR"] = str(TMP / "jobs")

from eng import assembly, clearance, fea, geometry, printability, report, schema  # noqa: E402
from eng.store import ENG_DIR  # noqa: E402

IN = ENG_DIR / "uploads"
IN.mkdir(parents=True, exist_ok=True)


def save(mesh, name):
    path = IN / name
    mesh.export(path)
    return path


def model_of(*paths, **kw):
    return geometry.import_model([{"path": str(p), "label": p.name} for p in paths], **kw)


def statuses(result):
    return {c["id"]: c["status"] for c in result["checks"]}


def box(size, at=(0, 0, 0)):
    m = trimesh.creation.box(size)
    m.apply_translation(at)
    return m


def bracket_and_pin():
    block = box((30, 20, 10))
    hole = trimesh.creation.cylinder(4.2, 20, sections=96)
    bracket = trimesh.boolean.difference([block, hole], engine="manifold")
    pin = trimesh.creation.cylinder(4.0, 20, sections=96)
    return save(bracket, "bracket.stl"), save(pin, "pin.stl")


class Import(unittest.TestCase):
    def test_volume_and_original_kept(self):
        path = save(box((20, 10, 5)), "block.stl")
        model = model_of(path)
        info = geometry.inspect(model)["data"]["components"]["block"]
        self.assertAlmostEqual(info["volume"], 1000, places=6)
        self.assertEqual(info["size"], [20.0, 10.0, 5.0])
        stored = Path(model["_dir"]) / "source" / "block.stl"
        self.assertEqual(stored.read_bytes(), path.read_bytes())

    def test_units(self):
        path = save(box((0.02, 0.01, 0.005)), "metres.stl")
        model = model_of(path, units="m")
        self.assertAlmostEqual(geometry.inspect(model)["data"]["components"]["metres"]["volume"], 1000, places=4)
        # No unit given: mm, said so
        result = geometry.inspect(model_of(path))
        self.assertTrue(any("coi là mm" in a["message"] for a in result["assumptions"]))

    def test_3mf_objects_and_unit(self):
        a, b = box((1, 1, 1)), box((2, 1, 1))

        def obj(oid, m, name):
            v = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in m.vertices)
            t = "".join(f'<triangle v1="{i}" v2="{j}" v3="{k}"/>' for i, j, k in m.faces)
            return f'<object id="{oid}" name="{name}" type="model"><mesh><vertices>{v}</vertices><triangles>{t}' \
                   '</triangles></mesh></object>'

        xml = ('<?xml version="1.0"?><model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
               f'<resources>{obj(1, a, "cube")}{obj(2, b, "bar")}</resources><build><item objectid="1"/>'
               '<item objectid="2" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></build></model>')
        path = IN / "two.3mf"
        with zipfile.ZipFile(path, "w") as z:
            z.writestr("3D/3dmodel.model", xml)
        model = model_of(path)
        comps = geometry.inspect(model)["data"]["components"]
        self.assertEqual(sorted(comps), ["bar", "cube"])
        self.assertAlmostEqual(comps["cube"]["volume"], 25.4 ** 3, delta=0.01)
        self.assertAlmostEqual(comps["bar"]["bounds_min"][0], 4 * 25.4, places=4)

    def test_upload_keeps_the_users_name(self):
        from eng.store import resolve_input, save_upload

        name = save_upload("hinge arm.stl", trimesh.exchange.stl.export_stl(box((5, 5, 5))))
        model = geometry.import_model([{"path": str(resolve_input(name)), "label": "hinge arm.stl"}])
        self.assertEqual([c["id"] for c in model["components"]], ["hinge-arm"])

    def test_step_refused_with_reason(self):
        path = IN / "part.step"
        path.write_text("ISO-10303-21;")
        with self.assertRaises(Exception) as caught:
            model_of(path)
        self.assertIn("STEP", str(caught.exception))


class Validation(unittest.TestCase):
    def test_clean_box_passes(self):
        result = geometry.validate(model_of(save(box((10, 10, 10)), "clean.stl")))
        s = statuses(result)
        for key in ("clean.nonmanifold", "clean.open_edges", "clean.normals", "clean.self_intersection",
                    "clean.volume_reliable"):
            self.assertEqual(s[key], "PASS", key)
        # Without the printer, what depends on it is not evaluated, so the whole is not a plain PASS
        self.assertEqual(s["clean.tiny"], "NOT_EVALUATED")
        self.assertEqual(result["status"], "WARNING")

    def test_inverted(self):
        m = box((10, 10, 10))
        m.invert()
        self.assertEqual(statuses(geometry.validate(model_of(save(m, "inv.stl"))))["inv.inverted"], "FAIL")

    def test_open_is_a_warning_not_a_failure(self):
        m = box((10, 10, 10))
        m.update_faces(np.arange(len(m.faces)) > 1)
        s = statuses(geometry.validate(model_of(save(m, "open.stl"))))
        self.assertEqual(s["open.open_edges"], "WARNING")
        s = statuses(geometry.validate(model_of(save(m, "sheet.stl")), {"sheet": "surface"}))
        self.assertEqual(s["sheet.open_edges"], "PASS")

    def test_nonmanifold(self):
        m = box((10, 10, 10))
        v = np.vstack([m.vertices, [[0, 0, 30]]])
        e = m.edges_unique[0]
        f = np.vstack([m.faces, [[e[0], e[1], len(v) - 1]]])
        path = IN / "fin.ply"
        trimesh.Trimesh(v, f, process=False).export(path)
        self.assertEqual(statuses(geometry.validate(model_of(path)))["fin.nonmanifold"], "FAIL")

    def test_self_intersection(self):
        # Faces cutting through each other, not just meeting along coplanar faces
        a, b = box((10, 10, 10)), box((10, 10, 10), (5, 3, 2))
        merged = trimesh.util.concatenate([a, b])
        s = statuses(geometry.validate(model_of(save(merged, "cross.stl"))))
        self.assertEqual(s["cross.self_intersection"], "FAIL")
        self.assertEqual(s["cross.bodies"], "WARNING")

    def test_overlap_volume(self):
        a, b = save(box((10, 10, 10)), "a.stl"), save(box((10, 10, 10), (5, 0, 0)), "b.stl")
        result = geometry.validate(model_of(a, b))
        self.assertAlmostEqual(result["data"]["overlaps"][0]["volume"], 500, places=3)
        self.assertEqual(statuses(result)["overlap.a.b"], "FAIL")


class Assembly(unittest.TestCase):
    def test_hole_and_pin(self):
        model = model_of(*bracket_and_pin())
        result = assembly.analyze(model)
        (pair,) = result["data"]["coaxial"]
        self.assertAlmostEqual(pair["hole_diameter"], 8.4, places=3)
        self.assertAlmostEqual(pair["shaft_diameter"], 8.0, places=3)
        self.assertAlmostEqual(pair["diametral_clearance"], 0.4, places=3)
        self.assertAlmostEqual(pair["engagement_length"], 10, places=3)
        (joint,) = result["data"]["suggested_joints"]
        self.assertEqual(joint["type"], "revolute")
        self.assertTrue(joint["needs_confirmation"])
        # Not confirmed: the joints check is not a pass
        self.assertEqual(statuses(result)["joints"], "NOT_EVALUATED")
        confirmed = assembly.analyze(model, [{"id": "hinge", "type": "revolute", "component_a": "bracket",
                                              "component_b": "pin", "axis": [0, 0, 1], "position": [0, 0, 0]}])
        self.assertEqual(statuses(confirmed)["joints"], "PASS")

    def test_flat_walls_are_not_cylinders(self):
        self.assertEqual(assembly.cylinders(box((10, 10, 10))), [])


class Clearance(unittest.TestCase):
    def test_fit_needs_printer_tolerances(self):
        model = model_of(*bracket_and_pin())
        s = statuses(clearance.analyze(model))
        self.assertEqual(s["fit.bracket.hole1.pin.shaft1"], "NOT_EVALUATED")
        p, _ = schema.read_print_config({"nozzle_mm": 0.4, "walls": 2, "hole_shrink_mm": 0.15, "shaft_growth_mm": 0.1,
                                         "min_clearance_mm": 0.2, "tolerance_source": "calibration"})
        result = clearance.analyze(model, p)
        (fit,) = result["data"]["fits"]
        self.assertAlmostEqual(fit["printed_estimate"], 0.4 - 0.25, places=3)
        self.assertEqual(statuses(result)["fit.bracket.hole1.pin.shaft1"], "FAIL")
        p["min_clearance_mm"] = 0.1
        self.assertEqual(statuses(clearance.analyze(model, p))["fit.bracket.hole1.pin.shaft1"], "PASS")
        gap = clearance.analyze(model, p)["data"]["gaps"][0]["gap"]
        self.assertAlmostEqual(gap, 0.2, delta=0.002)

    def test_wall_of_a_plate(self):
        model = model_of(save(box((40, 40, 2)), "plate.stl"))
        p, _ = schema.read_print_config({"nozzle_mm": 0.4, "walls": 3})
        result = clearance.analyze(model, p)
        self.assertAlmostEqual(result["data"]["walls"]["plate"]["p1"], 2.0, places=3)
        # 2 mm < 2 × 3 walls × 0.4 mm: walls only, no infill
        self.assertEqual(statuses(result)["plate.wall"], "WARNING")

    def test_gear_backlash_from_centre_distance(self):
        a = trimesh.creation.cylinder(20, 8, sections=64)
        b = trimesh.creation.cylinder(40, 8, sections=64)
        b.apply_translation((60.1, 0, 0))
        model = model_of(save(a, "g20.stl"), save(b, "g40.stl"))
        result = clearance.analyze(model, gears=[{"component_a": "g20", "component_b": "g40", "teeth_a": 20,
                                                  "teeth_b": 40, "module": 2}], thickness=False, pairs=[])
        (g,) = result["data"]["gears"]
        self.assertAlmostEqual(g["centre_distance"], 60.1, places=3)
        a20 = math.radians(20)
        aw = math.acos(60 * math.cos(a20) / 60.1)
        exact = 2 * 60.1 * ((math.tan(aw) - aw) - (math.tan(a20) - a20))
        self.assertAlmostEqual(g["backlash_nominal"], exact, delta=1e-4)
        self.assertAlmostEqual(exact / (2 * 0.1 * math.tan(a20)), 1, delta=0.02)
        self.assertEqual(statuses(result)["gear.g20.g40"], "NOT_EVALUATED")


class Printability(unittest.TestCase):
    def test_overhang_and_horizontal_hole(self):
        stem = box((10, 10, 20), (0, 0, 10))
        top = box((40, 10, 5), (0, 0, 22.5))
        t = trimesh.boolean.union([stem, top], engine="manifold")
        hole = trimesh.creation.cylinder(4, 30, sections=64)
        hole.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))
        hole.apply_translation((0, 0, 8))
        t = trimesh.boolean.difference([t, hole], engine="manifold")
        p, _ = schema.read_print_config({"nozzle_mm": 0.4, "walls": 2, "layer_height_mm": 0.2,
                                         "overhang_limit_deg": 45})
        result = printability.analyze(model_of(save(t, "tee.stl")), p)
        info = result["data"]["tee"]
        # The two arms' undersides: 2 × 15 × 10 mm, plus the top half of the horizontal hole (~ Ø8 × 10 / √2 … )
        self.assertGreater(info["overhang_area_mm2"], 300)
        self.assertLess(info["overhang_area_mm2"], 300 + 8 * math.pi / 2 * 10)
        s = statuses(result)
        self.assertEqual(s["tee.overhang"], "WARNING")
        self.assertEqual(s["tee.hole1.horizontal"], "WARNING")
        self.assertEqual(s["layers"], "NOT_EVALUATED")

    def test_no_bed_contact(self):
        ball = trimesh.creation.icosphere(subdivisions=3, radius=10)
        s = statuses(printability.analyze(model_of(save(ball, "ball.stl"))))
        self.assertEqual(s["ball.bed"], "FAIL")


@unittest.skipUnless(fea.ready(), "no FEA environment (FEA_PYTHON)")
class Structure(unittest.TestCase):
    def test_cantilever(self):
        beam = box((100, 10, 10), (50, 0, 0))
        model = model_of(save(beam, "beam.stl"))
        E, nu, F = 3500.0, 0.35, 10.0
        cfg = fea.configure(model, {
            "component": "beam", "material": {"name": "test", "young_modulus_MPa": E, "poisson_ratio": nu},
            "constraints": [{"region": {"plane": {"axis": "x", "value": 0}}}],
            "loads": [{"type": "force", "region": {"plane": {"axis": "x", "value": 100}}, "vector": [0, 0, -F]}],
            "mesh_size_mm": 4})
        run = fea.run(model, cfg["config_id"])
        fea.execute(fea.pending.get())
        from eng.store import load_analysis

        result = load_analysis(run["analysis_id"])
        self.assertEqual(result["state"], "completed", result.get("error"))
        I, A, G = 10 * 10 ** 3 / 12, 100.0, E / (2 * (1 + nu))
        # Timoshenko: bending + shear (κ = 5/6); the full clamped face is slightly stiffer still
        theory = F * 100 ** 3 / (3 * E * I) + F * 100 / (5 / 6 * G * A)
        self.assertAlmostEqual(result["data"]["max_displacement_mm"] / theory, 1, delta=0.02)
        # Mid-span bending stress M·c/I, on the top and bottom faces
        data = np.load(Path(ENG_DIR) / "analyses" / run["analysis_id"] / "level1" / "result.npz")
        nodes, vm = data["nodes"], data["von_mises"]
        mid = (np.abs(nodes[:, 0] - 50) < 1.5) & (np.abs(np.abs(nodes[:, 2]) - 5) < 1e-6) & (np.abs(nodes[:, 1]) < 3)
        self.assertAlmostEqual(float(np.median(vm[mid])) / (F * 50 * 5 / I), 1, delta=0.05)
        s = statuses(result)
        self.assertEqual(s["loads"], "PASS")
        self.assertEqual(s["convergence"], "PASS")
        self.assertEqual(s["strength"], "NOT_EVALUATED")
        self.assertEqual(s["displacement"], "NOT_EVALUATED")

    def test_inside_corner_and_datasheet_strength(self):
        from eng.store import load_analysis

        # An L: the wall meets the base at a sharp inside corner, where the stress is singular
        ell = trimesh.boolean.union([box((40, 30, 5), (20, 15, 2.5)), box((40, 6, 35), (20, 3, 17.5))], engine="manifold")
        model = model_of(save(ell, "ell.stl"))
        cfg = fea.configure(model, {
            "component": "ell", "mesh_size_mm": 3, "required_safety_factor": 2,
            "material": {"young_modulus_MPa": 3500, "poisson_ratio": 0.35, "tensile_strength_MPa": 50,
                         "interlayer_strength_MPa": 20, "source": "datasheet"},
            "print": {"build_direction": [0, 0, 1]},
            "constraints": [{"region": {"plane": {"axis": "z", "value": 0}}}],
            "loads": [{"type": "force", "region": {"plane": {"axis": "z", "value": 35}}, "vector": [0, 50, 0]}]})
        run = fea.run(model, cfg["config_id"])
        fea.execute(fea.pending.get())
        result = load_analysis(run["analysis_id"])
        checks = {c["id"]: c for c in result["checks"]}
        # The wall bends: the peak sits on the inside corner (y = 6, z = 5) and grows with the mesh
        self.assertEqual(checks["convergence"]["status"], "WARNING")
        self.assertIn("góc lõm", checks["convergence"]["detail"])
        peak = checks["convergence"]["where"]["stress_peak_at"]
        # Within one element (h = 3 / 1.6 mm) of the corner
        self.assertAlmostEqual(peak[1], 6, delta=1.9)
        self.assertAlmostEqual(peak[2], 5, delta=1.9)
        # Datasheet strengths and an unconverged stress: factors above 2 still are not a PASS
        self.assertEqual(checks["strength"]["status"], "WARNING")
        self.assertEqual(checks["interlayer"]["status"], "WARNING")
        self.assertGreater(checks["strength"]["value"], 2)

    def test_material_is_required(self):
        model = model_of(save(box((10, 10, 10)), "cube.stl"))
        with self.assertRaises(schema.InputError) as caught:
            fea.configure(model, {"component": "cube", "material": {"name": "PLA"},
                                  "constraints": [{"region": {"plane": {"axis": "z", "value": -5}}}],
                                  "loads": [{"type": "force", "region": {"plane": {"axis": "z", "value": 5}},
                                             "vector": [0, 0, -1]}]})
        self.assertIn("material", str(caught.exception))


class Motion(unittest.TestCase):
    @unittest.skipUnless(Path(os.environ.get("CHRONO_PYTHON", "/opt/chrono/bin/python")).exists(), "no Chrono")
    def test_arm_hits_stop(self):
        from eng import motion
        from sim import runs as sim

        sim.start()
        base = box((20, 20, 10), (0, 0, -5))
        # The arm: x from -3 to 40, y from -3 to 3, turning counter-clockwise about Z at 90°/s
        arm = trimesh.boolean.union([box((40, 6, 4), (20, 0, 2.5)), box((6, 6, 4), (0, 0, 2.5))], engine="manifold")
        # A stop at x -3…3, y 27…33: the arm's leading side (y' = 3) reaches its corner (3, 27) when
        # √(3² + 27²)·sin(atan2(27, 3) − θ) = 3, θ = 77.3°, t = 0.859 s
        stop = box((6, 6, 4), (0, 30, 2.5))
        model = model_of(save(base, "base.stl"), save(arm, "arm.stl"), save(stop, "stop.stl"))
        cfg = motion.configure(model, components={"base": {"fixed": True}, "stop": {"fixed": True},
                                                  "arm": {"density_kg_m3": 1240}},
                               joints=[{"id": "pivot", "type": "revolute", "body_a": "base", "body_b": "arm",
                                        "position": [0, 0, 0], "axis": [0, 0, 1]}],
                               actuators=[{"id": "drive", "type": "rotational_motor", "mode": "speed", "body_a": "base",
                                           "body_b": "arm", "position": [0, 0, 0], "axis": [0, 0, 1],
                                           "law": {"type": "constant", "value": 90}}],
                               simulation={"duration": 1.0, "time_step": 0.001, "output_interval": 0.01,
                                           "gravity": [0, 0, 0]})
        result = motion.run(model, cfg["mechanism_id"], wait_s=120, frames=101)
        s = statuses(result)
        self.assertEqual(s["motion.arm/stop"], "FAIL")
        first = result["data"]["motion_clearance"]["pairs"]["arm/stop"]["overlap_times"][0]
        r = math.hypot(3, 27)
        theta = math.atan2(27, 3) - math.asin(3 / r)
        # Sampled every 0.01 s: the first sample after contact
        self.assertGreaterEqual(first, math.degrees(theta) / 90)
        self.assertLess(first, math.degrees(theta) / 90 + 0.02)
        self.assertEqual(s["motion.base/stop"], "PASS")


@unittest.skipUnless(shutil.which(os.environ.get("BLENDER", "blender")), "no Blender")
class Visual(unittest.TestCase):
    def test_thickness_colours_the_thin_plate(self):
        from eng import visualize

        part = trimesh.boolean.union([box((40, 30, 1), (20, 15, 0.5)), box((5, 30, 12), (2.5, 15, 6))], engine="manifold")
        model = model_of(save(part, "ribbed.stl"))
        p, _ = schema.read_print_config({"nozzle_mm": 0.4, "walls": 2})
        result = visualize.visualize(model, "thickness", print_config=p)
        folder = ENG_DIR / "analyses" / result["analysis_id"]
        self.assertTrue((folder / "result.png").stat().st_size > 10000)
        self.assertTrue((folder / "result.blend").exists())
        coloured = trimesh.load(folder / "ribbed.ply", process=False)
        # The plate's upper face: facing up, 1 mm high, away from the wall
        up = coloured.face_normals[:, 2] > 0.99
        on_plate = up & (coloured.triangles_center[:, 0] > 10) & (np.abs(coloured.triangles_center[:, 2] - 1) < 1e-6)
        # 1 mm thick on a 4.8 mm scale: warm (red > blue) on the plate, blue on the 5 mm wall's side
        rgb = coloured.visual.vertex_colors.reshape(-1, 3, 4)[:, 0, :3].astype(int)
        self.assertTrue(np.all(rgb[on_plate, 0] > rgb[on_plate, 2]))
        wall_side = (coloured.face_normals[:, 0] > 0.99) & (np.abs(coloured.triangles_center[:, 0] - 5) < 1e-6)
        self.assertTrue(np.all(rgb[wall_side, 2] > rgb[wall_side, 0]))


class JobCheck(unittest.TestCase):
    def test_design_job_check(self):
        from eng import service

        # A design job's out/model.stl: a plate with a 1 mm fin
        out = Path(os.environ["JOBS_DIR"]) / "20261028-120000-ab12" / "out"
        out.mkdir(parents=True)
        part = trimesh.boolean.union([box((40, 30, 4), (20, 15, 2)), box((1, 30, 10), (20, 15, 9))], engine="manifold")
        part.export(out / "model.stl")
        body = {"job_id": "20261028-120000-ab12", "print": {"nozzle_mm": 0.4, "walls": 2}, "render": False}
        first = service.check_job(body)
        self.assertEqual(first["model"]["model_id"], "job-20261028-120000-ab12")
        self.assertEqual(sorted(first["results"]), ["clearance", "inspect", "printability", "validate"])
        # The 1 mm fin: wider than a 0.4 mm line, thinner than 2 × 2 walls × 0.4 mm: walls only, no infill
        walls = next(c for c in first["results"]["clearance"]["checks"] if c["id"] == "model.wall")
        self.assertEqual(walls["status"], "WARNING")
        self.assertAlmostEqual(walls["value"], 1.0, delta=0.01)
        # FEA and motion were not run: never a pass
        sections = {s["title"][:2]: s["status"] for s in first["report"]["data"]["sections"]}
        self.assertEqual(sections["6."], "NOT_EVALUATED")
        self.assertEqual(sections["7."], "NOT_EVALUATED")
        # Each check is a new version of the job's model; the latest is read back
        second = service.check_job(body)
        self.assertEqual(second["model"]["version"], first["model"]["version"] + 1)
        last = service.last_job_check("20261028-120000-ab12")
        self.assertEqual(last["report"]["analysis_id"], second["report"]["analysis_id"])
        self.assertEqual(sorted(last["results"]), ["clearance", "inspect", "printability", "validate"])
        self.assertEqual(service.last_job_check("20261028-120000-ffff")["report"], None)
        # The print setup the check used comes back with it (the Studio reminder shows it)
        self.assertEqual(last["results"]["printability"]["inputs"]["print"]["walls"], 2)

    def test_split_bodies_checks_the_fit_between_them(self):
        from eng import service

        # One STL with a bracket and a pin in its hole: as one part there is no fit; split, the 0.4 mm one is found
        out = Path(os.environ["JOBS_DIR"]) / "20261028-120000-cd34" / "out"
        out.mkdir(parents=True)
        bracket = trimesh.boolean.difference([box((30, 20, 10)), trimesh.creation.cylinder(4.2, 20, sections=96)],
                                             engine="manifold")
        pin = trimesh.creation.cylinder(4.0, 20, sections=96)
        trimesh.util.concatenate([bracket, pin]).export(out / "model.stl")
        body = {"job_id": "20261028-120000-cd34", "print": {"nozzle_mm": 0.4}, "render": False}
        whole = service.check_job(body)
        self.assertFalse([c for c in whole["results"]["clearance"]["checks"] if c["id"].startswith("fit.")])
        split = service.check_job({**body, "split_bodies": True})
        self.assertEqual(len(split["model"]["components"]), 2)
        (fit,) = [c for c in split["results"]["clearance"]["checks"] if c["id"].startswith("fit.")]
        self.assertEqual(fit["status"], "NOT_EVALUATED")
        self.assertAlmostEqual(fit["value"], 0.4, places=3)
        with self.assertRaises(Exception):
            service.check_job({"job_id": "../etc"})


class Report(unittest.TestCase):
    def test_sections_and_not_evaluated(self):
        from eng import service

        model = model_of(save(box((10, 10, 10)), "rep.stl"))
        service.finish(geometry.inspect(model), service.begin())
        result, text = report.build(model)
        for k in range(1, 12):
            self.assertIn(f"## {k}.", text)
        sections = {s["title"]: s["status"] for s in result["data"]["sections"]}
        self.assertEqual(sections["7. Phân tích độ bền (FEM)"], "NOT_EVALUATED")
        self.assertEqual(sections["6. Mô phỏng chuyển động"], "NOT_EVALUATED")
        self.assertNotEqual(result["status"], "PASS")
        html = (ENG_DIR / "analyses" / result["analysis_id"] / "report.html").read_text(encoding="utf-8")
        self.assertIn("<table>", html)


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
