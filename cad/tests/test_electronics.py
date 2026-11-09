"""
Electronics in a model (electronics/, circuit.py, build.py; docs/cad.md "Mạch điện tử"): the catalogue holds together,
the circuit check finds what is wrong and ngspice's numbers match the arithmetic, and a model with a circuit builds
with its modules and wires off the print, its diagram drawn and a covered port reported.

    cd /opt/cad && python -m unittest tests.test_electronics
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import circuit as circuit_check  # noqa: E402
from electronics import catalog  # noqa: E402

EXAMPLE = (HERE / "examples" / "electronics_box.py").read_text(encoding="utf-8")


def errors(report, level="error"):
    return [e["text"] for e in report["erc"] if e["level"] == level]


def powered(extra_parts=None, extra_nets=None):
    """2S → switch → Mini-360 at 5 V → ESP32, plus what a test adds"""
    return {
        "parts": {"bat": "holder_18650_2s", "sw": "switch_mts102", "buck": "mini360", "mcu": "esp32_devkitc",
                  **(extra_parts or {})},
        "nets": {"VBAT": ["bat.+", "sw.COM"], "VSW": ["sw.NO", "buck.IN+"], "5V": ["buck.OUT+", "mcu.5V"],
                 "GND": ["bat.-", "buck.IN-", "buck.OUT-", "mcu.GND"], **(extra_nets or {})},
        "settings": {"buck.vout": 5.0},
    }


class Catalogue(unittest.TestCase):
    def test_every_module_is_complete(self):
        for key, spec in catalog.MODULES.items():
            with self.subTest(key):
                self.assertTrue(spec["pins"])
                for pin in spec["pins"]:
                    self.assertIn(catalog.base_pin(pin), spec["pin_types"], f"{key}.{pin} has no type")
                for port in spec["ports"].values():
                    self.assertAlmostEqual(sum(c * c for c in port["dir"]), 1.0)
                if spec["board"]:
                    length, width, _ = spec["board"]
                    for name, (x, y, _) in spec["pins"].items():
                        self.assertLessEqual(abs(x), length / 2, f"{key}.{name} off the board")
                        self.assertLessEqual(abs(y), width / 2, f"{key}.{name} off the board")
                load = spec.get("load")
                if load:
                    pins = load["pin"] if isinstance(load["pin"], list) else [load["pin"]]
                    self.assertTrue(set(pins) <= set(spec["pins"]))
                    self.assertLessEqual(load["avg"], load["peak"])


@unittest.skipUnless(shutil.which("ngspice"), "ngspice is in the cad image")
class Simulation(unittest.TestCase):
    def test_buck_and_battery_match_the_arithmetic(self):
        report = circuit_check.analyse(powered(), {})
        self.assertEqual(errors(report), [])
        avg = report["simulation"]["cases"]["avg"]
        self.assertAlmostEqual(avg["pins"]["mcu.5V"], 5.0, delta=0.1)
        # ESP32 80 mA through its LDO (+5 mA) at 5 V, through the buck at 90 %, from 2 × 3.7 V less the drops
        vin = avg["regulators"]["buck"]["vin"]
        expected = 5.0 * 0.085 / (0.9 * vin) + 0.002
        battery = report["simulation"]["battery"]["bat"]
        self.assertAlmostEqual(battery["current_a"], expected, delta=0.002)
        self.assertAlmostEqual(battery["hours"], 2.6 * 0.8 / battery["current_a"], delta=0.1)

    def test_a_5v_signal_into_a_3v3_pin(self):
        report = circuit_check.analyse(powered({"sonar": "hc_sr04"}, {
            "5V": ["buck.OUT+", "mcu.5V", "sonar.VCC"], "GND": ["bat.-", "buck.IN-", "buck.OUT-", "mcu.GND", "sonar.GND"],
            "ECHO": ["sonar.Echo", "mcu.GPIO19"], "TRIG": ["mcu.GPIO5", "sonar.Trig"]}), {})
        self.assertTrue(any("ECHO" in e and "3.6 V" in e for e in errors(report)), report["erc"])

    def test_a_charger_on_a_2s_pack_and_an_overloaded_converter(self):
        c = powered({"chg": "tp4056_usbc", "servo": "mg996r"}, {
            "VBAT": ["bat.+", "sw.COM", "chg.B+"], "GND": ["bat.-", "buck.IN-", "buck.OUT-", "mcu.GND", "chg.B-", "servo.GND"],
            "5V": ["buck.OUT+", "mcu.5V", "servo.V+"], "SERVO": ["mcu.GPIO18", "servo.SIG"]})
        report = circuit_check.analyse(c, {})
        found = errors(report) + errors(report, "warning")
        self.assertTrue(any(e.startswith("chg.B+") for e in found), found)
        self.assertTrue(any("buck" in e and "vượt" in e for e in found), found)

    def test_an_unpowered_module_and_a_gpio_led_too_bright(self):
        c = powered({"oled": "oled_096_i2c", "led": "led_5mm"}, {
            "SDA": ["mcu.GPIO21", "oled.SDA"], "LED": ["mcu.GPIO2", "led.A"],
            "GND": ["bat.-", "buck.IN-", "buck.OUT-", "mcu.GND", "led.K"]})
        c["settings"]["led.r"] = 22
        report = circuit_check.analyse(c, {})
        found = errors(report)
        self.assertTrue(any("oled" in e and "nguồn" in e for e in found), found)
        self.assertTrue(any("GPIO2" in e and "mA" in e for e in found), found)


class Structure(unittest.TestCase):
    def test_a_pin_in_two_nets_and_an_unknown_pin(self):
        with self.assertRaisesRegex(ValueError, "two nets"):
            circuit_check.check_structure(powered(extra_nets={"X": ["mcu.5V", "mcu.GPIO4"]}))
        with self.assertRaisesRegex(ValueError, "no pin"):
            circuit_check.check_structure(powered(extra_nets={"X": ["mcu.GPIO99", "mcu.GPIO4"]}))
        with self.assertRaisesRegex(ValueError, "No module"):
            circuit_check.check_structure({"parts": {"x": "flux_capacitor"}, "nets": {}})


def build(code, stale=()):
    """build.py on `code` in a job folder of its own, whose out/ already holds the files `stale` names"""
    job = Path(tempfile.mkdtemp(prefix="electronics-job-"))
    (job / "model.py").write_text(code, encoding="utf-8")
    (job / "out").mkdir()
    for name in stale:
        (job / "out" / name).write_bytes(b"from the build before")
    env = {**os.environ, "PYTHONPATH": str(HERE)}
    done = subprocess.run([sys.executable, str(HERE / "build.py"), "model.py"], cwd=job, env=env,
                          capture_output=True, text=True, timeout=600, check=False)
    return done, job / "out"


def glb_materials(path):
    """{(r, g, b) linear: (alphaMode, alpha)} of a GLB's materials"""
    data = path.read_bytes()
    gltf = json.loads(data[20:20 + struct.unpack("<I", data[12:16])[0]])
    return {tuple(round(c, 3) for c in m["pbrMetallicRoughness"]["baseColorFactor"][:3]):
            (m.get("alphaMode", "OPAQUE"), m["pbrMetallicRoughness"]["baseColorFactor"][3]) for m in gltf["materials"]}


def glb_parts(path):
    """Names of a GLB's nodes, less the scene's root (the model's name)"""
    data = path.read_bytes()
    gltf = json.loads(data[20:20 + struct.unpack("<I", data[12:16])[0]])
    roots = {gltf["nodes"][n].get("name") for scene in gltf["scenes"] for n in scene["nodes"]}
    return {node.get("name") for node in gltf["nodes"]} - roots - {None}


# The example's case, #4a6fa5, as the GLB's linear colour
CASE_RGB = (0.068, 0.159, 0.376)


@unittest.skipUnless(shutil.which("ngspice"), "the cad image")
class Model(unittest.TestCase):
    def test_the_example_builds_with_the_electronics_off_the_print(self):
        done, out = build(EXAMPLE)
        report = json.loads((out / "report.json").read_text())
        self.assertTrue(report["ok"], report.get("error"))
        self.assertEqual(report["warnings"], [])
        not_printed = report["print_layout"]["not_printed"]
        self.assertEqual(set(not_printed), {"bat", "mcu", "buck", "sw", "wire_VBAT", "wire_VSW", "wire_5V", "wire_GND"})
        self.assertEqual(set(report["print_layout"]["parts"]), {"case"})
        self.assertEqual(report["circuit"]["placed"], ["bat", "buck", "mcu", "sw"])
        saved = json.loads((out / "circuit.json").read_text())
        self.assertTrue(saved["simulation"]["ok"])
        self.assertTrue(all(w["length_mm"] > 0 for w in saved["wires"].values()))
        # For the dashboard's interactive diagram: where each part starts, its wired pins and what it is for
        self.assertEqual(set(saved["layout"]), {"bat", "mcu", "buck", "sw"})
        self.assertEqual(saved["parts"]["buck"]["pins"], ["IN+", "IN-", "OUT+", "OUT-"])
        self.assertIn("5 V", saved["parts"]["buck"]["role"])
        self.assertIn("schematic.svg", report["files"])
        # Drawn at its own size: a scaled drawing in an unscaled viewBox shows only its top-left part
        self.assertIn('transform="scale(1 1)', (out / "schematic.svg").read_text())
        self.assertTrue((out / "schematic.png").stat().st_size > 1000)
        # Shown see-through around its modules: the case in model.glb (and the CAD Viewer's document), the rest opaque
        materials = glb_materials(out / "model.glb")
        self.assertEqual(materials.pop(CASE_RGB), ("BLEND", 0.35))
        self.assertTrue(materials and all(mode == "OPAQUE" for mode, _ in materials.values()), materials)
        self.assertTrue(report["engine"]["document"])
        # Its two halves on their own, opaque, in documents of their own
        electronics = {"bat", "mcu", "buck", "sw", "wire_VBAT", "wire_VSW", "wire_5V", "wire_GND"}
        self.assertEqual(glb_parts(out / "electronics.glb"), electronics)
        self.assertEqual(glb_parts(out / "case.glb"), {"case"})
        for name in ("electronics", "case"):
            self.assertTrue(all(mode == "OPAQUE" for mode, _ in glb_materials(out / f"{name}.glb").values()))
            for ext in ("glb", "step", "png"):
                self.assertIn(f"{name}.{ext}", report["files"])
                self.assertTrue((out / f"{name}.{ext}").stat().st_size > 1000)
        self.assertNotIn(CASE_RGB, glb_materials(out / "electronics.glb"))
        views = report["engine"]["views"]
        self.assertEqual(set(views), {"all", "electronics", "case"})
        self.assertEqual(views["all"], report["engine"]["document"])
        self.assertEqual(len(set(views.values())), 3)

    def test_a_model_without_a_circuit_keeps_its_case_opaque(self):
        code = EXAMPLE.replace("circuit = {", "CIRCUIT = {").replace("wires(circuit,", "wires(CIRCUIT,")
        # The halves of a build before that had its circuit go
        done, out = build(code, stale=("electronics.glb", "case.png"))
        report = json.loads((out / "report.json").read_text())
        self.assertTrue(report["ok"], report.get("error"))
        self.assertNotIn("circuit", report)
        materials = glb_materials(out / "model.glb")
        self.assertEqual(materials[CASE_RGB], ("OPAQUE", 1.0))
        self.assertTrue(all(mode == "OPAQUE" for mode, _ in materials.values()), materials)
        # Nothing to split: no electronics or case of its own
        for name in ("electronics", "case"):
            self.assertFalse((out / f"{name}.glb").exists())
            self.assertFalse((out / f"{name}.png").exists())
        self.assertEqual(set(report["engine"]["views"]), {"all"})

    def test_a_covered_port_and_a_module_in_the_wall(self):
        code = EXAMPLE.replace('case -= port_cutout(mcu, "usb") + port_cutout(sw, "toggle")',
                               'case -= port_cutout(sw, "toggle")')
        code = code.replace("bd.Pos(30, 26, floor + LIFT)", "bd.Pos(42, 26, floor + LIFT)")
        done, out = build(code)
        report = json.loads((out / "report.json").read_text())
        self.assertTrue(report["ok"], report.get("error"))
        self.assertTrue(any("Cổng usb của mcu" in w for w in report["warnings"]), report["warnings"])
        self.assertTrue(any("Module buck lấn vào case" in w for w in report["warnings"]), report["warnings"])


if __name__ == "__main__":
    unittest.main()
