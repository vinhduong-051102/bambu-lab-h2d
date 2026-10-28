"""
The shared data of the engineering analyses: statuses, units, and the user's inputs (Material, PrintConfig,
FEAConfig) checked field by field. Nothing physical is defaulted silently: a value that is not given is missing, and
what depends on it is NOT_EVALUATED; a value the code chooses is listed as an assumption.

Lengths inside the analyses are millimetres (Blender's 1 unit = 1 mm), forces newtons, stresses MPa (N/mm²), so
E in MPa as well. Every result says its units.

A result (AnalysisResult) is:
  {"analysis_id", "kind", "model_id", "model_version", "status", "started_at", "finished_at", "duration_s",
   "engine": {name: version}, "inputs", "units", "checks": [Check], "data", "assumptions", "warnings",
   "missing", "files", "error"}
and a check {"id", "status", "title", "detail", "value", "limit", "unit", "where"}.
"""

import math

PASS, WARNING, FAIL, NOT_EVALUATED = "PASS", "WARNING", "FAIL", "NOT_EVALUATED"
STATUSES = (PASS, WARNING, FAIL, NOT_EVALUATED)
# The worst status wins; NOT_EVALUATED alone never makes a PASS
ORDER = {FAIL: 3, WARNING: 2, NOT_EVALUATED: 1, PASS: 0}

LENGTH_UNITS = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4}
UNITS = {"length": "mm", "area": "mm²", "volume": "mm³", "force": "N", "stress": "MPa", "modulus": "MPa",
         "angle": "deg", "mass": "g", "density": "g/cm³"}

ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-_"


class InputError(ValueError):
    """Wrong input: `errors` lists every problem as {"path", "message"}"""

    def __init__(self, errors):
        self.errors = list(errors)
        super().__init__("; ".join(f"{e['path']}: {e['message']}" for e in self.errors[:8]))


def check(cid, status, title, detail="", value=None, limit=None, unit=None, where=None):
    assert status in STATUSES
    out = {"id": cid, "status": status, "title": title, "detail": detail}
    for key, v in (("value", value), ("limit", limit), ("unit", unit), ("where", where)):
        if v is not None:
            out[key] = v
    return out


def overall(checks):
    """The status of a set of checks: the worst; PASS only when something was evaluated and nothing is worse"""
    if not checks:
        return NOT_EVALUATED
    worst = max(checks, key=lambda c: ORDER[c["status"]])["status"]
    if worst == NOT_EVALUATED and any(c["status"] == PASS for c in checks):
        return WARNING
    return worst


class Reader:
    """Collects errors while reading a user object"""

    def __init__(self):
        self.errors = []

    def error(self, path, message):
        self.errors.append({"path": path, "message": message})

    def number(self, obj, key, path, *, positive=False, minimum=None, maximum=None, required=False):
        value = obj.get(key) if isinstance(obj, dict) else None
        where = f"{path}.{key}"
        if value is None:
            if required:
                self.error(where, "Thiếu giá trị (bắt buộc).")
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            self.error(where, f"Phải là số hữu hạn, nhận {value!r}.")
            return None
        if positive and value <= 0:
            self.error(where, f"Phải lớn hơn 0, nhận {value}.")
            return None
        if minimum is not None and value < minimum:
            self.error(where, f"Phải ≥ {minimum}, nhận {value}.")
            return None
        if maximum is not None and value > maximum:
            self.error(where, f"Phải ≤ {maximum}, nhận {value}.")
            return None
        return float(value)

    def choice(self, obj, key, path, options, *, default=None):
        value = obj.get(key, default) if isinstance(obj, dict) else default
        if value is None:
            return None
        if value not in options:
            self.error(f"{path}.{key}", f"Phải là một trong {', '.join(map(str, options))}, nhận {value!r}.")
            return None
        return value

    def text(self, obj, key, path, *, limit=200):
        value = obj.get(key) if isinstance(obj, dict) else None
        if value is None:
            return None
        if not isinstance(value, str) or len(value) > limit:
            self.error(f"{path}.{key}", f"Phải là chuỗi ≤ {limit} ký tự.")
            return None
        return value

    def vector(self, obj, key, path, size=3, *, required=False, unit=False):
        value = obj.get(key) if isinstance(obj, dict) else None
        where = f"{path}.{key}"
        if value is None:
            if required:
                self.error(where, f"Thiếu vector {size} số.")
            return None
        if not isinstance(value, (list, tuple)) or len(value) != size or not all(
                isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value):
            self.error(where, f"Phải là mảng {size} số, nhận {value!r}.")
            return None
        out = [float(v) for v in value]
        if unit:
            norm = math.sqrt(sum(v * v for v in out))
            if norm < 1e-12:
                self.error(where, "Vector không được bằng 0.")
                return None
            out = [v / norm for v in out]
        return out

    def raise_if_any(self):
        if self.errors:
            raise InputError(self.errors)


def read_material(obj, path="material"):
    """A material as the user knows it. Elastic constants (MPa) for FEA; strengths (MPa) for a safety factor. The
    name ("PLA") is a label only: no property is looked up from it. `source` says where the numbers come from
    (datasheet, test), `printed` whether they were measured on printed parts (layer bonding included)."""
    r = Reader()
    if obj is None:
        return None, []
    if not isinstance(obj, dict):
        return None, [{"path": path, "message": "Phải là object."}]
    m = {
        "name": r.text(obj, "name", path),
        "brand": r.text(obj, "brand", path),
        "young_modulus_MPa": r.number(obj, "young_modulus_MPa", path, positive=True),
        "poisson_ratio": r.number(obj, "poisson_ratio", path, minimum=0, maximum=0.499),
        "density_g_cm3": r.number(obj, "density_g_cm3", path, positive=True),
        "yield_strength_MPa": r.number(obj, "yield_strength_MPa", path, positive=True),
        "tensile_strength_MPa": r.number(obj, "tensile_strength_MPa", path, positive=True),
        # Across layers (Z for a part printed flat): usually far weaker than along them
        "interlayer_strength_MPa": r.number(obj, "interlayer_strength_MPa", path, positive=True),
        "source": r.choice(obj, "source", path, ("datasheet", "test", "literature", "unknown"), default="unknown"),
        "printed": bool(obj.get("printed", False)),
    }
    return m, r.errors


def read_print_config(obj, path="print"):
    """How the part is printed. Tolerances are the printer's, measured (a calibration print) or stated by the user:
    `hole_shrink_mm` is how much smaller a printed hole comes out on its diameter, `shaft_growth_mm` how much larger
    a printed shaft, `xy_tolerance_mm` the ± error on outer dimensions."""
    r = Reader()
    if obj is None:
        return None, []
    if not isinstance(obj, dict):
        return None, [{"path": path, "message": "Phải là object."}]
    p = {
        "printer": r.text(obj, "printer", path),
        "process": r.choice(obj, "process", path, ("fdm", "sla", "sls", "mjf"), default="fdm"),
        "filament": r.text(obj, "filament", path),
        "brand": r.text(obj, "brand", path),
        "nozzle_mm": r.number(obj, "nozzle_mm", path, positive=True, maximum=2),
        "line_width_mm": r.number(obj, "line_width_mm", path, positive=True, maximum=3),
        "layer_height_mm": r.number(obj, "layer_height_mm", path, positive=True, maximum=1),
        "walls": r.number(obj, "walls", path, minimum=1, maximum=20),
        "infill_percent": r.number(obj, "infill_percent", path, minimum=0, maximum=100),
        "infill_pattern": r.text(obj, "infill_pattern", path),
        "nozzle_temp_C": r.number(obj, "nozzle_temp_C", path, positive=True),
        "bed_temp_C": r.number(obj, "bed_temp_C", path, minimum=0),
        "build_direction": r.vector(obj, "build_direction", path, unit=True) or [0.0, 0.0, 1.0],
        "build_volume_mm": r.vector(obj, "build_volume_mm", path),
        "overhang_limit_deg": r.number(obj, "overhang_limit_deg", path, minimum=0, maximum=90),
        "xy_tolerance_mm": r.number(obj, "xy_tolerance_mm", path, minimum=0, maximum=2),
        "hole_shrink_mm": r.number(obj, "hole_shrink_mm", path, minimum=-2, maximum=2),
        "shaft_growth_mm": r.number(obj, "shaft_growth_mm", path, minimum=-2, maximum=2),
        "min_clearance_mm": r.number(obj, "min_clearance_mm", path, minimum=0, maximum=5),
        "tolerance_source": r.choice(obj, "tolerance_source", path, ("calibration", "user", "datasheet", "unknown"),
                                     default="unknown"),
        "service": r.text(obj, "service", path, limit=500),
    }
    p["build_direction_given"] = obj.get("build_direction") is not None
    return p, r.errors


def line_width(print_config):
    """The extrusion width, from the config: line_width_mm, else the nozzle (an assumption the caller lists)"""
    if not print_config:
        return None
    return print_config.get("line_width_mm") or print_config.get("nozzle_mm")


def new_result(kind, model=None, inputs=None):
    return {"kind": kind, "model_id": model and model["model_id"], "model_version": model and model["version"],
            "status": NOT_EVALUATED, "engine": {}, "inputs": inputs or {}, "units": dict(UNITS), "checks": [],
            "data": {}, "assumptions": [], "warnings": [], "missing": [], "files": {}, "error": None}
