"""
The Mechanical Model Schema (mech/1): what a mechanism is before any solver sees it.

  {"schema": "mech/1", "name", "units": {"length": "mm", "mass": "kg", "angle": "deg"},
   "parts":  [{"id", "name", "role", "fixed", "shape" | "geometry_file", "position", "orientation", "material",
               "mass", "center_of_mass", "inertia", "source"}],
   "joints": [{"id", "type", "part_a", "part_b", "position", "axis", "limits"}],
   "gears":  [{"id", "gear_a", "gear_b", "internal", "model": "ideal" | "contact", …contact data}],
   "motors": [{"id", "joint", "mode", "law" | "speed_rpm"}],
   "loads":  [{"id", "type": "torque" | "force" | "spring_damper" | "rotational_spring_damper", …}],
   "simulation": {"duration", "time_step", "gravity", …}}

Lengths in the declared unit (mm by default), angles in degrees, masses in kg, densities kg/m³, forces N, torques N·m.
Positions and axes are in the assembly (world) frame at t = 0, Z up. A part's shape is drawn in its own frame, which
`position`/`orientation` place.

normalise() checks every field and returns the model in mm/kg/rad with, for every value that matters, where it came
from (PROVENANCE): a value nobody gave stays "unknown" and is listed in `missing`; nothing is filled in silently. A
material named from MATERIALS is "material_database" (a nominal handbook density, said so).
"""

import math
import re

import numpy as np

SCHEMA = "mech/1"
ID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$")
LENGTHS = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4}
PROVENANCE = ("user", "imported_cad", "geometry", "material_database", "solver", "assumption", "unknown")
ROLES = ("ground", "housing", "frame", "shaft", "gear", "pulley", "crank", "rod", "link", "slider", "rocker", "arm",
         "bearing", "pin", "motor", "load", "other")
JOINTS = ("fixed", "revolute", "prismatic", "cylindrical", "spherical", "planar", "distance")
MOTOR_MODES = {"revolute": ("speed", "angle", "torque"), "cylindrical": ("speed", "angle", "torque"),
               "prismatic": ("speed", "position", "force")}
LOADS = ("torque", "force", "spring_damper", "rotational_spring_damper")

# Nominal densities (kg/m³), for a material named without one: a handbook value, listed as such. Printed parts are
# lighter (infill): give their mass, or a density measured from a printed part.
MATERIALS = {
    "steel": 7850, "stainless_steel": 8000, "aluminium": 2700, "aluminum": 2700, "brass": 8500, "bronze": 8800,
    "cast_iron": 7200, "pla": 1240, "petg": 1270, "abs": 1040, "asa": 1070, "nylon": 1140, "pa": 1140,
    "polycarbonate": 1200, "pom": 1410, "tpu": 1210,
}


class ModelError(ValueError):
    """The model is not right: `errors` lists every problem as {"path", "message"}"""

    def __init__(self, errors):
        self.errors = list(errors)
        super().__init__("; ".join(f"{e['path']}: {e['message']}" for e in self.errors[:8]))


def valued(value, source, unit=None, note=None):
    """A value with where it came from"""
    out = {"value": value, "source": source}
    if unit:
        out["unit"] = unit
    if note:
        out["note"] = note
    return out


class Reader:
    def __init__(self):
        self.errors, self.missing, self.assumptions = [], [], []

    def error(self, path, message):
        self.errors.append({"path": path, "message": message})

    def need(self, path, message):
        """Data the model cannot do without, which only the user can give"""
        self.missing.append({"path": path, "message": message})

    def assume(self, path, message):
        self.assumptions.append({"path": path, "message": message})

    def number(self, obj, key, path, *, positive=False, minimum=None, required=False):
        v = obj.get(key) if isinstance(obj, dict) else None
        if v is None:
            if required:
                self.error(f"{path}.{key}", "Thiếu giá trị (bắt buộc).")
            return None
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            self.error(f"{path}.{key}", f"Phải là số, nhận {v!r}.")
            return None
        if positive and v <= 0:
            self.error(f"{path}.{key}", f"Phải lớn hơn 0, nhận {v}.")
            return None
        if minimum is not None and v < minimum:
            self.error(f"{path}.{key}", f"Phải ≥ {minimum}, nhận {v}.")
            return None
        return float(v)

    def vector(self, obj, key, path, n=3, *, required=False, unit=False):
        v = obj.get(key) if isinstance(obj, dict) else None
        if v is None:
            if required:
                self.error(f"{path}.{key}", f"Thiếu vector {n} số.")
            return None
        if not isinstance(v, (list, tuple)) or len(v) != n or not all(
                isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in v):
            self.error(f"{path}.{key}", f"Phải là mảng {n} số, nhận {v!r}.")
            return None
        out = np.array(v, float)
        if unit:
            norm = np.linalg.norm(out)
            if norm < 1e-12:
                self.error(f"{path}.{key}", "Trục không được là vector 0.")
                return None
            out = out / norm
        return out

    def ref(self, obj, key, path, known, what):
        v = obj.get(key) if isinstance(obj, dict) else None
        if v not in known:
            self.error(f"{path}.{key}", f"Không có {what} {v!r}" + (f" (có: {', '.join(sorted(known))})." if known else "."))
            return None
        return v


def quat_from_euler_xyz(angles):
    x, y, z = (a / 2 for a in angles)
    qx, qy, qz = (np.array([math.cos(x), math.sin(x), 0, 0]), np.array([math.cos(y), 0, math.sin(y), 0]),
                  np.array([math.cos(z), 0, 0, math.sin(z)]))
    return quat_mul(qz, quat_mul(qy, qx))


def quat_mul(a, b):
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b
    return np.array([w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
                     w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2])


def quat_to_matrix(q):
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


def read_orientation(r, part, path, angle):
    o = part.get("orientation")
    if o is None:
        return np.array([1.0, 0, 0, 0])
    if not isinstance(o, dict):
        r.error(f"{path}.orientation", 'Cần {"euler_xyz": [x, y, z]} hoặc {"quaternion": [w, x, y, z]}.')
        return np.array([1.0, 0, 0, 0])
    if "quaternion" in o:
        q = r.vector(o, "quaternion", f"{path}.orientation", 4)
        return np.array([1.0, 0, 0, 0]) if q is None or np.linalg.norm(q) < 1e-9 else q / np.linalg.norm(q)
    e = r.vector(o, "euler_xyz", f"{path}.orientation", required=True)
    return np.array([1.0, 0, 0, 0]) if e is None else quat_from_euler_xyz(e * angle)


def read_part(r, p, path, L, A, resolve_file):
    from . import shapes

    part = {"id": p.get("id"), "name": str(p.get("name") or p.get("id")), "fixed": bool(p.get("fixed", False))}
    part["role"] = p.get("role", "other")
    if part["role"] not in ROLES:
        r.error(f"{path}.role", f"role phải là một trong {', '.join(ROLES)}.")
    source = p.get("source", "user")
    if source not in PROVENANCE:
        r.error(f"{path}.source", f"source phải là một trong {', '.join(PROVENANCE)}.")
        source = "user"
    pos = r.vector(p, "position", path)
    part["position"] = valued(((pos if pos is not None else np.zeros(3)) * L).tolist(),
                              source if pos is not None else "assumption", "mm")
    if pos is None:
        r.assume(f"{path}.position", "Không cho vị trí: đặt ở gốc tọa độ.")
    part["orientation"] = read_orientation(r, p, path, A).tolist()
    # Geometry: a parametric shape, or a mesh file already in the assembly frame
    if p.get("shape") is not None:
        try:
            part["shape"] = shapes.read_shape(p["shape"], L)
        except ValueError as err:
            r.error(f"{path}.shape", str(err))
            part["shape"] = None
    elif p.get("geometry_file"):
        part["geometry_file"] = str(p["geometry_file"])
        try:
            part["geometry_path"] = resolve_file(part["geometry_file"]) if resolve_file else None
        except ValueError as err:
            r.error(f"{path}.geometry_file", str(err))
    else:
        part["shape"] = None
    # Mass: given, or density × the geometry's volume; never guessed
    material = p.get("material")
    density, density_source, note = None, None, None
    if isinstance(material, dict):
        density = r.number(material, "density_kg_m3", f"{path}.material", positive=True)
        density_source = material.get("source", "user")
        part["material"] = material.get("name") or "custom"
    elif isinstance(material, str):
        key = material.strip().lower().replace(" ", "_").replace("-", "_")
        part["material"] = material
        if key in MATERIALS:
            density, density_source = float(MATERIALS[key]), "material_database"
            note = "Khối lượng riêng danh nghĩa (sổ tay), vật liệu đặc 100 %"
        else:
            r.error(f"{path}.material", f"Không biết vật liệu {material!r}: cho {{\"density_kg_m3\": …}}.")
    else:
        part["material"] = None
    part["density"] = valued(density, density_source or "unknown", "kg/m³", note) if density else None
    mass = r.number(p, "mass", path, positive=True)
    part["mass"] = valued(mass, "user", "kg") if mass is not None else None
    com = r.vector(p, "center_of_mass", path)
    part["center_of_mass"] = valued((com * L).tolist(), "user", "mm") if com is not None else None
    inertia = p.get("inertia")
    part["inertia"] = None
    if isinstance(inertia, dict):
        keys = ("ixx", "iyy", "izz", "ixy", "ixz", "iyz")
        v = {k: r.number(inertia, k, f"{path}.inertia", required=k in keys[:3]) for k in keys}
        if all(v[k] is not None for k in keys[:3]):
            # kg·(declared length)² → kg·mm²
            part["inertia"] = valued([[v["ixx"], v["ixy"] or 0, v["ixz"] or 0], [v["ixy"] or 0, v["iyy"], v["iyz"] or 0],
                                      [v["ixz"] or 0, v["iyz"] or 0, v["izz"]]], "user", "kg·mm²")
            part["inertia"]["value"] = (np.array(part["inertia"]["value"]) * L * L).tolist()
    return part


def read_joint(r, j, path, parts, L):
    joint = {"id": j.get("id"), "type": j.get("type")}
    if joint["type"] not in JOINTS:
        r.error(f"{path}.type", f"Loại khớp phải là một trong {', '.join(JOINTS)}.")
    joint["part_a"] = r.ref(j, "part_a", path, parts, "chi tiết")
    joint["part_b"] = r.ref(j, "part_b", path, parts, "chi tiết")
    if joint["part_a"] and joint["part_a"] == joint["part_b"]:
        r.error(path, "part_a và part_b phải khác nhau.")
    if joint["type"] == "distance":
        pa, pb = r.vector(j, "point_a", path, required=True), r.vector(j, "point_b", path, required=True)
        joint.update(point_a=None if pa is None else (pa * L).tolist(), point_b=None if pb is None else (pb * L).tolist())
        return joint
    pos = r.vector(j, "position", path, required=True)
    joint["position"] = None if pos is None else (pos * L).tolist()
    needs_axis = joint["type"] in ("revolute", "prismatic", "cylindrical", "planar")
    axis = r.vector(j, "axis", path, required=needs_axis, unit=True)
    joint["axis"] = (axis if axis is not None else np.array([0.0, 0, 1])).tolist()
    if j.get("limits") is not None:
        joint["limits"] = j["limits"]
    joint["source"] = j.get("source", "user")
    joint["confidence"] = j.get("confidence", "confirmed")
    return joint


def read_gear(r, g, path, parts_by_id):
    gear = {"id": g.get("id")}
    for side in ("a", "b"):
        pid = r.ref(g, f"gear_{side}", path, parts_by_id, "chi tiết")
        gear[f"gear_{side}"] = pid
        shape = (parts_by_id.get(pid) or {}).get("shape") or {}
        teeth = g.get(f"teeth_{side}") or (shape.get("teeth") if shape.get("type") == "gear" else None)
        if not isinstance(teeth, int) or teeth < 6:
            r.need(f"{path}.teeth_{side}", f"Cần số răng của {pid!r} (shape gear hoặc teeth_{side}).")
        gear[f"teeth_{side}"] = teeth
        gear[f"module_{side}"] = shape.get("module") if shape.get("type") == "gear" else None
    gear["internal"] = bool(g.get("internal", False))
    gear["model"] = g.get("model", "ideal")
    if gear["model"] not in ("ideal", "contact"):
        r.error(f"{path}.model", 'model phải là "ideal" hoặc "contact".')
    for key in ("backlash", "friction", "mesh_stiffness_N_per_m", "young_modulus_Pa", "pressure_angle", "damping_ratio"):
        if key in g:
            gear[key] = g[key]
    return gear


def read_motor(r, m, path, joints_by_id, A):
    motor = {"id": m.get("id")}
    jid = r.ref(m, "joint", path, joints_by_id, "khớp")
    motor["joint"] = jid
    jtype = (joints_by_id.get(jid) or {}).get("type")
    modes = MOTOR_MODES.get(jtype)
    if jid and not modes:
        r.error(f"{path}.joint", f"Động cơ chỉ đặt trên khớp revolute, cylindrical hoặc prismatic; {jid!r} là {jtype}.")
        return motor
    if m.get("speed_rpm") is not None and jtype in ("revolute", "cylindrical"):
        rpm = r.number(m, "speed_rpm", path)
        motor.update(mode="speed", law={"type": "constant", "value": rpm * 6.0} if rpm is not None else None,
                     given={"speed_rpm": rpm})
        if m.get("ramp_s"):
            # Ramp up from rest over ramp_s seconds, then hold: a motor does not start at full speed
            ramp = r.number(m, "ramp_s", path, positive=True)
            if ramp and rpm is not None:
                motor["law"] = {"type": "table", "points": [[0, 0], [ramp, rpm * 6.0], [1e6, rpm * 6.0]]}
        motor["law_unit"] = "deg/s"
        return motor
    motor["mode"] = m.get("mode")
    if modes and motor["mode"] not in modes:
        r.error(f"{path}.mode", f"mode của động cơ trên khớp {jtype} phải là một trong {', '.join(modes)}.")
    if not isinstance(m.get("law"), dict):
        r.need(f"{path}.law", "Cần quy luật của động cơ (tốc độ, góc, mômen…) hoặc speed_rpm. Không tự đoán.")
        motor["law"] = None
    else:
        motor["law"] = m["law"]
    return motor


def normalise(model, resolve_file=None):
    """The model checked, in mm/kg/rad with provenance: {"model", "missing", "assumptions", "warnings"}. Raises
    ModelError listing every structural problem; missing physical data is listed, not invented."""
    r = Reader()
    if not isinstance(model, dict):
        raise ModelError([{"path": "$", "message": "Mô hình phải là object JSON."}])
    if model.get("schema", SCHEMA) != SCHEMA:
        r.error("schema", f"Cần schema {SCHEMA!r}.")
    units = model.get("units") or {}
    lu = units.get("length", "mm")
    if lu not in LENGTHS:
        r.error("units.length", f"Đơn vị dài phải là một trong {', '.join(LENGTHS)}.")
        lu = "mm"
    au = units.get("angle", "deg")
    L, A = LENGTHS[lu], (math.pi / 180 if au == "deg" else 1.0)
    out = {"schema": SCHEMA, "name": str(model.get("name") or "Cơ cấu"), "units_in": {"length": lu, "angle": au},
           "description": model.get("description"), "request": model.get("request")}

    ids = set()
    for key in ("parts", "joints", "gears", "motors", "loads"):
        for i, item in enumerate(model.get(key) or []):
            ident = item.get("id") if isinstance(item, dict) else None
            if not isinstance(ident, str) or not ID_RE.match(ident):
                r.error(f"{key}[{i}].id", f"Cần id: chữ, số, _ . - (nhận {ident!r}).")
            elif ident in ids:
                r.error(f"{key}[{i}].id", f"id {ident!r} bị trùng.")
            ids.add(ident)
    if not model.get("parts"):
        r.error("parts", "Cần ít nhất một chi tiết.")
    out["parts"] = [read_part(r, p, f"parts[{i}]", L, A, resolve_file) for i, p in enumerate(model.get("parts") or [])]
    parts_by_id = {p["id"]: p for p in out["parts"]}
    out["joints"] = [read_joint(r, j, f"joints[{i}]", parts_by_id, L) for i, j in enumerate(model.get("joints") or [])]
    joints_by_id = {j["id"]: j for j in out["joints"]}
    out["gears"] = [read_gear(r, g, f"gears[{i}]", parts_by_id) for i, g in enumerate(model.get("gears") or [])]
    out["motors"] = [read_motor(r, m, f"motors[{i}]", joints_by_id, A) for i, m in enumerate(model.get("motors") or [])]
    out["loads"] = []
    for i, load in enumerate(model.get("loads") or []):
        path = f"loads[{i}]"
        if load.get("type") not in LOADS:
            r.error(f"{path}.type", f"Tải phải là một trong {', '.join(LOADS)}.")
            continue
        for key in ("part", "part_a", "part_b"):
            if key in load:
                r.ref(load, key, path, parts_by_id, "chi tiết")
        out["loads"].append(dict(load))
    sim = model.get("simulation")
    if not isinstance(sim, dict) or sim.get("duration") is None or sim.get("time_step") is None:
        r.need("simulation", "Cần simulation.duration và simulation.time_step (s) để chạy mô phỏng.")
    out["simulation"] = sim if isinstance(sim, dict) else {}
    if not any(p["fixed"] for p in out["parts"]):
        r.need("parts", "Không có chi tiết cố định (fixed): chi tiết nào gắn với nền/khung?")
    if r.errors:
        raise ModelError(r.errors)
    return {"model": out, "missing": r.missing, "assumptions": r.assumptions}
