"""
The mechanism format (schema version 1) and its checks. A mechanism is JSON in the units it declares; normalise()
checks every field and returns the same mechanism in SI (m, kg, s, rad, quaternions w-x-y-z), with the mass
properties worked out and every assumption written down, for chrono_run.py. Nothing physical is made up: a dynamic
body without a mass or a density, a motor without its law or a spring without its stiffness is an error that says
which field is missing. What is derived (an inertia from the shape and a uniform density) or defaulted (gravity,
the solver) is listed under "assumptions".

The frames: Z up, as in Blender, so the world frame is the same in Blender and in Chrono and only lengths scale.
A body's own frame is the frame its geometry (and its Blender mesh) is drawn in; `position` and `orientation` place
that frame in the world at t = 0. Joint and actuator positions and axes are given in the world at t = 0.

Pure Python and NumPy, so the worker's Python and Chrono's both import it; meshes need trimesh (the worker's).
"""

import math
import re

import numpy as np

SCHEMA_VERSION = 1
ID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$")
LENGTHS = {"m": 1.0, "mm": 0.001}
MASSES = {"kg": 1.0, "g": 0.001}
ANGLES = {"rad": 1.0, "deg": math.pi / 180}

GEOMETRIES = ("box", "cylinder", "sphere", "gear", "mesh")
JOINTS = ("fixed", "revolute", "prismatic", "spherical", "cylindrical", "distance", "gear")
# Rotational motors move body_b about the axis relative to body_a; linear ones along it
ACTUATORS = {
    "rotational_motor": ("angle", "speed", "torque"),
    "linear_actuator": ("position", "speed", "force"),
}
FORCES = ("force", "torque", "spring_damper", "rotational_spring_damper")
LAWS = ("constant", "ramp", "sine", "table")
SOLVERS = ("default", "psor", "apgd", "barzilai_borwein", "minres")
INTEGRATORS = ("default", "euler_implicit_linearized", "euler_implicit_projected", "hht")
# Contacts: Chrono's NSC (complementarity, rigid) or SMC (penalty, Hertz: needs each material's Young's modulus and
# Poisson's ratio)
CONTACT_METHODS = ("nsc", "smc")
# A gear joint: an ideal constraint (exact ratio), or teeth in contact along the line of action (backlash, mesh
# stiffness, friction; see gear_mesh)
GEAR_MODELS = ("ideal", "contact")
# ISO 6336-1's single tooth stiffness c' of solid steel spur gears, 14 N/(mm·µm), in N/m per metre of face width,
# and the steel it is for: other materials scale it by their Young's modulus
TOOTH_STIFFNESS_STEEL = 14e9
E_STEEL = 206e9
# A contact gear's mesh period has to take at least this many time steps (its stiffness is applied each step)
STEPS_PER_MESH_PERIOD = 20
# A run is at most this many steps (a run takes minutes, not hours)
MAX_STEPS = 2_000_000
MAX_SAMPLES = 200_000


class MechanismError(ValueError):
    """The mechanism is not right: `errors` lists every problem as {"path", "message"}"""

    def __init__(self, errors, warnings=()):
        self.errors = list(errors)
        self.warnings = list(warnings)
        super().__init__("; ".join(f"{e['path']}: {e['message']}" for e in self.errors[:8]))


class Checker:
    """Collects errors, warnings and assumptions while a mechanism is read"""

    def __init__(self):
        self.errors, self.warnings, self.assumptions = [], [], []

    def error(self, path, message):
        self.errors.append({"path": path, "message": message})

    def warn(self, path, message):
        self.warnings.append({"path": path, "message": message})

    def assume(self, path, message):
        self.assumptions.append({"path": path, "message": message})

    def number(self, value, path, *, positive=False, minimum=None, required=True):
        if value is None:
            if required:
                self.error(path, "Thiếu giá trị (bắt buộc).")
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            self.error(path, f"Phải là số hữu hạn, nhận {value!r}.")
            return None
        if positive and value <= 0:
            self.error(path, f"Phải lớn hơn 0, nhận {value}.")
            return None
        if minimum is not None and value < minimum:
            self.error(path, f"Phải ≥ {minimum}, nhận {value}.")
            return None
        return float(value)

    def vector(self, value, path, size=3, *, required=True, unit=False):
        if value is None:
            if required:
                self.error(path, f"Thiếu vector {size} số (bắt buộc).")
            return None
        if not isinstance(value, (list, tuple)) or len(value) != size:
            self.error(path, f"Phải là mảng {size} số, nhận {value!r}.")
            return None
        numbers = [self.number(v, f"{path}[{i}]") for i, v in enumerate(value)]
        if any(n is None for n in numbers):
            return None
        out = np.array(numbers, float)
        if unit:
            length = np.linalg.norm(out)
            if length < 1e-12:
                self.error(path, "Trục không được là vector 0.")
                return None
            out = out / length
        return out

    def choice(self, value, path, options, *, required=True):
        if value is None:
            if required:
                self.error(path, f"Thiếu giá trị, một trong {', '.join(options)}.")
            return None
        if value not in options:
            self.error(path, f"Phải là một trong {', '.join(options)}, nhận {value!r}.")
            return None
        return value

    def obj(self, value, path, *, required=True):
        if value is None:
            if required:
                self.error(path, "Thiếu (bắt buộc).")
            return None
        if not isinstance(value, dict):
            self.error(path, f"Phải là object, nhận {type(value).__name__}.")
            return None
        return value


# ---------- rotations ----------

def quat_from_euler_xyz(angles):
    """Rotations about X, then Y, then Z (fixed axes), as Blender's XYZ Euler: quaternion w, x, y, z"""
    x, y, z = (a / 2 for a in angles)
    qx = np.array([math.cos(x), math.sin(x), 0, 0])
    qy = np.array([math.cos(y), 0, math.sin(y), 0])
    qz = np.array([math.cos(z), 0, 0, math.sin(z)])
    return quat_mul(qz, quat_mul(qy, qx))


def quat_mul(a, b):
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b
    return np.array([w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
                     w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
                     w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
                     w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2])


def quat_to_matrix(q):
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


def quat_z_to(axis):
    """A rotation taking +Z to `axis` (unit): Chrono's joints and motors act along their frame's Z"""
    z = np.array([0.0, 0.0, 1.0])
    d = float(np.dot(z, axis))
    if d > 1 - 1e-12:
        return np.array([1.0, 0, 0, 0])
    if d < -1 + 1e-12:
        return np.array([0.0, 1, 0, 0])
    c = np.cross(z, axis)
    q = np.array([1 + d, *c])
    return q / np.linalg.norm(q)


def orientation(c, value, path, angle):
    """{"quaternion": [w, x, y, z]} or {"euler_xyz": [x, y, z]} in the mechanism's angle unit; identity when absent"""
    if value is None:
        return np.array([1.0, 0, 0, 0])
    value = c.obj(value, path)
    if value is None:
        return None
    if "quaternion" in value:
        q = c.vector(value["quaternion"], f"{path}.quaternion", 4)
        if q is None:
            return None
        length = np.linalg.norm(q)
        if length < 1e-9:
            c.error(f"{path}.quaternion", "Quaternion bằng 0.")
            return None
        if abs(length - 1) > 1e-3:
            c.warn(f"{path}.quaternion", f"Quaternion không chuẩn hóa (độ dài {length:.4f}), đã chia cho độ dài.")
        return q / length
    if "euler_xyz" in value:
        e = c.vector(value["euler_xyz"], f"{path}.euler_xyz")
        return None if e is None else quat_from_euler_xyz(e * angle)
    c.error(path, 'Cần "quaternion" [w, x, y, z] hoặc "euler_xyz" [x, y, z].')
    return None


# ---------- mass properties ----------

def primitive_volume(g):
    if g["type"] == "box":
        return float(np.prod(g["size"]))
    if g["type"] == "sphere":
        return 4 / 3 * math.pi * g["radius"] ** 3
    # cylinder, gear (a gear as the cylinder of its pitch circle)
    return math.pi * g["radius"] ** 2 * g["length"]


def primitive_inertia(g, mass):
    """The inertia tensor about the centre of a uniform primitive centred on the body's origin"""
    if g["type"] == "box":
        x, y, z = g["size"]
        return np.diag([y * y + z * z, x * x + z * z, x * x + y * y]) * mass / 12
    if g["type"] == "sphere":
        return np.eye(3) * 0.4 * mass * g["radius"] ** 2
    r, h = g["radius"], g["length"]
    along, across = mass * r * r / 2, mass * (3 * r * r + h * h) / 12
    i = "xyz".index(g["axis"])
    diag = [across] * 3
    diag[i] = along
    return np.diag(diag)


def mesh_properties(path, scale):
    """Volume (m³), centroid (m) and the inertia per unit density (m⁵) of a closed mesh, in its own frame"""
    import trimesh

    mesh = trimesh.load(path, force="mesh", process=True)
    if not mesh.is_watertight:
        raise ValueError(f"Mesh {path} không kín (watertight): không tính được thể tích và quán tính.")
    mesh.apply_scale(scale)
    # trimesh: moment_inertia is about the centre of mass, for density 1
    return float(mesh.volume), np.asarray(mesh.center_mass, float), np.asarray(mesh.moment_inertia, float)


def check_inertia(c, tensor, path):
    if not np.allclose(tensor, tensor.T, atol=1e-12 + 1e-9 * np.abs(tensor).max()):
        c.error(path, "Tensor quán tính phải đối xứng.")
        return False
    principal = np.linalg.eigvalsh(tensor)
    if principal.min() <= 0:
        c.error(path, f"Tensor quán tính phải xác định dương (trị riêng {principal.tolist()}).")
        return False
    a, b, d = sorted(principal)
    if a + b < d * (1 - 1e-6):
        c.error(path, f"Mômen quán tính chính {a:.4g}, {b:.4g}, {d:.4g} vi phạm bất đẳng thức tam giác: "
                      "không vật thể nào có quán tính này.")
        return False
    return True


# ---------- the parts ----------

def read_geometry(c, g, path, L, resolve_file):
    g = c.obj(g, path)
    if g is None:
        return None
    kind = c.choice(g.get("type"), f"{path}.type", GEOMETRIES)
    out = {"type": kind}
    if kind == "box":
        size = c.vector(g.get("size"), f"{path}.size")
        if size is not None and (size <= 0).any():
            c.error(f"{path}.size", "Các cạnh phải lớn hơn 0.")
        out["size"] = None if size is None else (size * L).tolist()
    elif kind == "sphere":
        r = c.number(g.get("radius"), f"{path}.radius", positive=True)
        out["radius"] = r and r * L
    elif kind in ("cylinder", "gear"):
        out["axis"] = c.choice(g.get("axis", "z"), f"{path}.axis", ("x", "y", "z"))
        if kind == "gear":
            teeth = g.get("teeth")
            if not isinstance(teeth, int) or isinstance(teeth, bool) or teeth < 6:
                c.error(f"{path}.teeth", f"Số răng phải là số nguyên ≥ 6, nhận {teeth!r}.")
                teeth = None
            module = c.number(g.get("module"), f"{path}.module", positive=True)
            width = c.number(g.get("width"), f"{path}.width", positive=True)
            out.update(teeth=teeth, module=module and module * L, length=width and width * L)
            out["radius"] = teeth and module and teeth * module * L / 2
        else:
            r = c.number(g.get("radius"), f"{path}.radius", positive=True)
            h = c.number(g.get("length"), f"{path}.length", positive=True)
            out.update(radius=r and r * L, length=h and h * L)
    elif kind == "mesh":
        name = g.get("file")
        if not isinstance(name, str) or not name:
            c.error(f"{path}.file", "Cần đường dẫn file mesh (STL/OBJ/PLY) trong vùng dữ liệu của gateway.")
        else:
            try:
                out["file"] = resolve_file(name)
            except ValueError as err:
                c.error(f"{path}.file", str(err))
        out["unit_scale"] = L
    return out


def read_visual_parts(c, parts, path, resolve_file):
    """The components a body is drawn from, each its own mesh (in the body frame at t = 0, as mesh_file): a viewer
    shows and picks them one by one while the body moves as one"""
    if not isinstance(parts, list) or not parts:
        c.error(path, "Danh sách các chi tiết [{id, name, mesh_file, color}].")
        return []
    out = []
    for i, part in enumerate(parts):
        part = c.obj(part, f"{path}[{i}]")
        if part is None:
            continue
        pid = part.get("id")
        if not isinstance(pid, str) or not ID_RE.match(pid):
            c.error(f"{path}[{i}].id", "Mã chi tiết: chữ, số, _ . - (tối đa 64).")
            continue
        entry = {"id": pid, "name": str(part.get("name") or pid)}
        try:
            entry["mesh_file"] = resolve_file(str(part.get("mesh_file")))
        except ValueError as err:
            c.error(f"{path}[{i}].mesh_file", str(err))
            continue
        if part.get("color") is not None and re.fullmatch(r"#[0-9A-Fa-f]{6}", str(part["color"])):
            entry["color"] = str(part["color"])
        out.append(entry)
    return out


def read_body(c, b, path, units, resolve_file):
    L, M = units["L"], units["M"]
    body = {"id": b.get("id"), "name": str(b.get("name") or b.get("id") or "")}
    fixed = b.get("fixed", False)
    if not isinstance(fixed, bool):
        c.error(f"{path}.fixed", "Phải là true hoặc false.")
    body["fixed"] = bool(fixed)
    pos = c.vector(b.get("position"), f"{path}.position")
    body["position"] = None if pos is None else (pos * L).tolist()
    q = orientation(c, b.get("orientation"), f"{path}.orientation", units["A"])
    body["orientation"] = None if q is None else q.tolist()
    geometry = read_geometry(c, b.get("geometry"), f"{path}.geometry", L, resolve_file) \
        if b.get("geometry") is not None else None
    body["geometry"] = geometry
    visual = b.get("visual")
    if visual is not None:
        visual = c.obj(visual, f"{path}.visual")
        if visual is not None:
            out = {}
            if visual.get("mesh_file") is not None:
                try:
                    out["mesh_file"] = resolve_file(str(visual["mesh_file"]))
                except ValueError as err:
                    c.error(f"{path}.visual.mesh_file", str(err))
                out["unit_scale"] = L
            if visual.get("blender_object") is not None:
                out["blender_object"] = str(visual["blender_object"])
            if visual.get("color") is not None:
                if not re.fullmatch(r"#[0-9A-Fa-f]{6}", str(visual["color"])):
                    c.error(f"{path}.visual.color", "Màu dạng #RRGGBB.")
                out["color"] = str(visual["color"])
            if visual.get("parts") is not None:
                out["parts"] = read_visual_parts(c, visual["parts"], f"{path}.visual.parts", resolve_file)
                out["unit_scale"] = L
            body["visual"] = out
    if body["fixed"]:
        # A fixed body's mass never enters the dynamics: kept for the record when given
        body.update(mass=None, com=[0.0, 0.0, 0.0], inertia=None)
    else:
        read_mass(c, b, body, geometry, path, L, M)

    material = b.get("material")
    if material is not None:
        material = c.obj(material, f"{path}.material")
    body["material"] = None
    if material:
        mu = c.number(material.get("friction"), f"{path}.material.friction", minimum=0)
        e = c.number(material.get("restitution"), f"{path}.material.restitution", minimum=0, required=False)
        if e is not None and e > 1:
            c.error(f"{path}.material.restitution", "Hệ số phục hồi phải trong [0, 1].")
        body["material"] = {"friction": mu, "restitution": e,
                            "young_modulus": c.number(material.get("young_modulus_Pa"),
                                                      f"{path}.material.young_modulus_Pa", positive=True,
                                                      required=False),
                            "poisson_ratio": c.number(material.get("poisson_ratio"), f"{path}.material.poisson_ratio",
                                                      minimum=0, required=False)}
        if body["material"]["poisson_ratio"] is not None and body["material"]["poisson_ratio"] >= 0.5:
            c.error(f"{path}.material.poisson_ratio", "Hệ số Poisson phải trong [0, 0.5).")
    collide = b.get("collision", False)
    if not isinstance(collide, bool):
        c.error(f"{path}.collision", "Phải là true hoặc false.")
    body["collision"] = bool(collide)
    hull = b.get("collision_hull")
    if hull is not None:
        points = np.asarray(hull, float) if isinstance(hull, list) and hull else None
        if points is None or points.ndim != 2 or points.shape[1] != 3 or len(points) < 4 or not np.isfinite(points).all():
            c.error(f"{path}.collision_hull", "Bao lồi: ít nhất 4 điểm [x, y, z] trong khung của body.")
        else:
            body["hull_points"] = (points * L).tolist()
    if body["collision"]:
        if geometry is None:
            c.error(f"{path}.collision", "Va chạm cần geometry.")
        elif geometry.get("type") == "gear":
            c.error(f"{path}.collision", "Bánh răng không va chạm theo hình học ở đây: nối chúng bằng khớp gear, "
                                         'model "contact" cho răng tiếp xúc (khe hở, độ cứng, ma sát).')
        if not material or material.get("friction") is None:
            c.error(f"{path}.material.friction", "Body có va chạm cần hệ số ma sát (material.friction).")
        elif material.get("restitution") is None:
            body["material"]["restitution"] = 0.0
            c.assume(f"{path}.material.restitution", "Không cho hệ số phục hồi: dùng 0 (va chạm không nảy).")
    return body


def read_mass(c, b, body, geometry, path, L, M):
    """mass (or density × volume), centre of mass and inertia of a dynamic body, in SI, about its centre of mass"""
    mass = c.number(b.get("mass"), f"{path}.mass", positive=True, required=False)
    density = c.number(b.get("density"), f"{path}.density", positive=True, required=False)
    if mass is not None:
        mass *= M
    # density is always kg/m³
    if mass is None and density is None:
        c.error(f"{path}.mass", "Body động cần khối lượng (mass) hoặc khối lượng riêng (density, kg/m³) "
                                "cùng geometry. Không tự đoán khối lượng.")
    if mass is not None and density is not None:
        c.error(f"{path}.density", "Chỉ cho một trong mass và density.")

    volume = shape_com = unit_inertia = None
    # Everything given (a mech body: mass, centre and inertia of its parts): the mesh is only for contact and drawing
    given = mass is not None and b.get("center_of_mass") is not None and b.get("inertia") is not None
    if geometry and geometry.get("type") and all(v is not None for k, v in geometry.items() if k != "teeth"):
        if geometry["type"] == "mesh" and given:
            pass
        elif geometry["type"] == "mesh":
            if geometry.get("file"):
                try:
                    volume, shape_com, unit_inertia = mesh_properties(geometry["file"], geometry["unit_scale"])
                except Exception as err:  # noqa: BLE001 - an unreadable mesh is the user's error
                    c.error(f"{path}.geometry.file", str(err)[:300])
        else:
            volume, shape_com = primitive_volume(geometry), np.zeros(3)
    if mass is None and density is not None:
        if volume is None:
            c.error(f"{path}.density", "Tính khối lượng từ density cần geometry có thể tích.")
        else:
            mass = density * volume
            c.assume(f"{path}.mass", f"Khối lượng {mass:.6g} kg tính từ density {density:g} kg/m³ × thể tích "
                                     f"{volume:.6g} m³ (vật liệu đồng chất, đặc).")
    body["mass"] = mass

    com = b.get("center_of_mass")
    if com is not None:
        com = c.vector(com, f"{path}.center_of_mass")
        body["com"] = None if com is None else (com * L).tolist()
    elif shape_com is not None:
        body["com"] = shape_com.tolist()
        if geometry["type"] == "mesh":
            c.assume(f"{path}.center_of_mass", "Trọng tâm lấy từ mesh (vật liệu đồng chất).")
    else:
        body["com"] = None
        if mass is not None:
            c.error(f"{path}.center_of_mass", "Không có geometry để suy ra trọng tâm: cần center_of_mass.")

    inertia = b.get("inertia")
    body["inertia"] = None
    if inertia is not None:
        inertia = c.obj(inertia, f"{path}.inertia")
        if inertia is None:
            return
        keys = ("ixx", "iyy", "izz", "ixy", "ixz", "iyz")
        v = {k: c.number(inertia.get(k), f"{path}.inertia.{k}", required=k in keys[:3]) for k in keys}
        if any(v[k] is None for k in keys[:3]):
            return
        xy, xz, yz = (v[k] or 0.0 for k in keys[3:])
        # In the mechanism's mass·length², about the centre of mass, in the body's own axes
        tensor = np.array([[v["ixx"], xy, xz], [xy, v["iyy"], yz], [xz, yz, v["izz"]]]) * M * L * L
        if check_inertia(c, tensor, f"{path}.inertia"):
            body["inertia"] = tensor.tolist()
    elif mass is not None and geometry and volume is not None:
        if geometry["type"] == "mesh":
            tensor = unit_inertia * (mass / volume)
        else:
            tensor = primitive_inertia(geometry, mass)
        what = {"gear": "hình trụ đặc bằng vòng chia của bánh răng"}.get(geometry["type"], geometry["type"])
        c.assume(f"{path}.inertia", f"Tensor quán tính tính từ geometry ({what}), vật liệu đồng chất.")
        if com is not None and geometry["type"] != "mesh" and np.linalg.norm(com) > 0:
            c.warn(f"{path}.inertia", "center_of_mass lệch khỏi tâm hình nhưng quán tính tính quanh tâm hình: "
                                      "nên cho inertia.")
        body["inertia"] = tensor.tolist()
    elif mass is not None:
        c.error(f"{path}.inertia", "Cần tensor quán tính (inertia) hoặc geometry để tính nó. Không tự đoán.")


def read_law(c, law, path, scale):
    """A value over time (s): {"type": "constant", "value"}, {"type": "ramp", "start", "slope"} (slope per s),
    {"type": "sine", "amplitude", "frequency_hz", "phase", "offset"}, {"type": "table", "points": [[t, v], ...]}
    (linear in between, held after the last point). Values in the quantity's unit, scaled by `scale` to SI."""
    law = c.obj(law, path)
    if law is None:
        return None
    kind = c.choice(law.get("type"), f"{path}.type", LAWS)
    if kind == "constant":
        v = c.number(law.get("value"), f"{path}.value")
        return v is not None and {"type": kind, "value": v * scale}
    if kind == "ramp":
        start = c.number(law.get("start", 0.0), f"{path}.start")
        slope = c.number(law.get("slope"), f"{path}.slope")
        return None if None in (start, slope) else {"type": kind, "start": start * scale, "slope": slope * scale}
    if kind == "sine":
        a = c.number(law.get("amplitude"), f"{path}.amplitude")
        f = c.number(law.get("frequency_hz"), f"{path}.frequency_hz", positive=True)
        # the phase is always in radians
        phase = c.number(law.get("phase", 0.0), f"{path}.phase")
        offset = c.number(law.get("offset", 0.0), f"{path}.offset")
        if None in (a, f, phase, offset):
            return None
        return {"type": kind, "amplitude": a * scale, "frequency_hz": f, "phase": phase, "offset": offset * scale}
    if kind == "table":
        points = law.get("points")
        if not isinstance(points, list) or len(points) < 2:
            c.error(f"{path}.points", "Cần ít nhất 2 điểm [t, giá trị].")
            return None
        rows = [c.vector(p, f"{path}.points[{i}]", 2) for i, p in enumerate(points)]
        if any(r is None for r in rows):
            return None
        times = [r[0] for r in rows]
        if any(b <= a for a, b in zip(times, times[1:])):
            c.error(f"{path}.points", "Thời gian các điểm phải tăng dần.")
            return None
        return {"type": kind, "points": [[float(t), float(v) * scale] for t, v in rows]}
    return None


def law_value(law, t):
    """The law at time t (SI), the same as chrono_run.py sets up in Chrono: for the theoretical checks"""
    kind = law["type"]
    if kind == "constant":
        return law["value"]
    if kind == "ramp":
        return law["start"] + law["slope"] * t
    if kind == "sine":
        return law["offset"] + law["amplitude"] * math.sin(2 * math.pi * law["frequency_hz"] * t + law["phase"])
    ts = [p[0] for p in law["points"]]
    vs = [p[1] for p in law["points"]]
    return float(np.interp(t, ts, vs))


def law_integral(law, t, steps=2000):
    """∫₀ᵗ law: a speed motor's angle or position at time t"""
    kind = law["type"]
    if kind == "constant":
        return law["value"] * t
    if kind == "ramp":
        return law["start"] * t + law["slope"] * t * t / 2
    if kind == "sine":
        w = 2 * math.pi * law["frequency_hz"]
        return law["offset"] * t + law["amplitude"] / w * (math.cos(law["phase"]) - math.cos(w * t + law["phase"]))
    grid = np.linspace(0, t, steps + 1)
    values = np.array([law_value(law, x) for x in grid])
    return float(np.sum((values[1:] + values[:-1]) / 2 * np.diff(grid))) if t > 0 else 0.0


def read_joint(c, j, path, bodies, joints_so_far, units):
    L, A = units["L"], units["A"]
    kind = c.choice(j.get("type"), f"{path}.type", JOINTS)
    joint = {"id": j.get("id"), "type": kind}
    if kind == "gear":
        return read_gear(c, j, joint, path, joints_so_far, units)
    a, b = refs(c, j, path, bodies)
    joint.update(body_a=a, body_b=b)
    if kind == "distance":
        pa = c.vector(j.get("point_a"), f"{path}.point_a")
        pb = c.vector(j.get("point_b"), f"{path}.point_b")
        joint.update(point_a=None if pa is None else (pa * L).tolist(), point_b=None if pb is None else (pb * L).tolist())
        return joint
    pos = c.vector(j.get("position"), f"{path}.position")
    joint["position"] = None if pos is None else (pos * L).tolist()
    if kind in ("revolute", "prismatic", "cylindrical"):
        axis = c.vector(j.get("axis"), f"{path}.axis", unit=True)
        joint["axis"] = None if axis is None else axis.tolist()
    elif j.get("axis") is not None:
        axis = c.vector(j.get("axis"), f"{path}.axis", unit=True)
        joint["axis"] = None if axis is None else axis.tolist()
    else:
        joint["axis"] = [0.0, 0.0, 1.0]
    limits = j.get("limits")
    if limits is not None:
        if kind not in ("revolute", "prismatic"):
            c.error(f"{path}.limits", "Giới hạn chỉ dùng cho khớp revolute (góc) hoặc prismatic (hành trình).")
        else:
            limits = c.obj(limits, f"{path}.limits")
            if limits:
                scale = A if kind == "revolute" else L
                lo = c.number(limits.get("min"), f"{path}.limits.min")
                hi = c.number(limits.get("max"), f"{path}.limits.max")
                if lo is not None and hi is not None:
                    if lo >= hi:
                        c.error(f"{path}.limits", "min phải nhỏ hơn max.")
                    elif not lo <= 0 <= hi:
                        c.error(f"{path}.limits", "Vị trí ban đầu (0) phải nằm trong [min, max].")
                    joint["limits"] = {"min": lo * scale, "max": hi * scale}
    return joint


def read_gear(c, j, joint, path, joints_so_far, units):
    """A gear pair: two revolute joints on the same carrier, about parallel axes. Ideal: the second gear turns at
    exactly -N_a/N_b (external) or +N_a/N_b (internal) times the first. Contact: teeth pushing along the line of
    action (read_gear_contact)"""
    by_id = {x["id"]: x for x in joints_so_far}
    shafts = []
    for side in ("a", "b"):
        ref = j.get(f"joint_{side}")
        other = by_id.get(ref)
        if other is None:
            c.error(f"{path}.joint_{side}", f"Không có khớp {ref!r} (khai báo khớp revolute trước khớp gear).")
        elif other["type"] != "revolute":
            c.error(f"{path}.joint_{side}", f"Khớp {ref!r} phải là revolute, đang là {other['type']}.")
        shafts.append(other)
        teeth = j.get(f"teeth_{side}")
        if not isinstance(teeth, int) or isinstance(teeth, bool) or teeth < 1:
            c.error(f"{path}.teeth_{side}", f"Số răng phải là số nguyên dương, nhận {teeth!r}.")
        joint[f"joint_{side}"], joint[f"teeth_{side}"] = ref, teeth
    internal = j.get("internal", False)
    if not isinstance(internal, bool):
        c.error(f"{path}.internal", "Phải là true hoặc false.")
    joint["internal"] = bool(internal)
    joint["model"] = c.choice(j.get("model", "ideal"), f"{path}.model", GEAR_MODELS)
    if joint["model"] == "contact":
        read_gear_contact(c, j, joint, path, units)
    ja, jb = shafts
    if ja and jb and ja.get("axis") and jb.get("axis"):
        if ja["body_a"] != jb["body_a"]:
            c.error(path, f"Hai trục bánh răng phải quay trên cùng một giá (body_a): {ja['body_a']!r} ≠ "
                          f"{jb['body_a']!r}.")
        if abs(abs(float(np.dot(ja["axis"], jb["axis"]))) - 1) > 1e-6:
            c.error(path, "Bánh răng trụ cần hai trục song song.")
        joint.update(body_a=ja["body_b"], body_b=jb["body_b"], carrier=ja["body_a"])
    return joint


def read_gear_contact(c, j, joint, path, units):
    """The data of teeth in contact, none of it guessed: the backlash as mounted (circumferential, on the pitch
    circle, both gears together), the tooth friction coefficient, and the mesh stiffness per tooth pair (N/m) or the
    gears' Young's modulus to have ISO 6336's estimate. The pressure angle and the mesh damping have defaults."""
    L, A = units["L"], units["A"]
    backlash = c.number(j.get("backlash"), f"{path}.backlash", minimum=0)
    joint["backlash"] = None if backlash is None else backlash * L
    joint["friction"] = c.number(j.get("friction"), f"{path}.friction", minimum=0)
    if j.get("pressure_angle") is None:
        joint["pressure_angle"] = math.radians(20)
        c.assume(f"{path}.pressure_angle", "Không cho góc áp lực: dùng 20° (răng thân khai tiêu chuẩn, hệ số "
                                           "chiều cao đầu răng 1, chân răng 1.25).")
    else:
        pa = c.number(j.get("pressure_angle"), f"{path}.pressure_angle", positive=True)
        joint["pressure_angle"] = pa and pa * A
        if joint["pressure_angle"] and not math.radians(10) <= joint["pressure_angle"] <= math.radians(35):
            c.error(f"{path}.pressure_angle", "Góc áp lực phải trong 10°…35°.")
    stiffness = c.number(j.get("mesh_stiffness_N_per_m"), f"{path}.mesh_stiffness_N_per_m", positive=True,
                         required=False)
    modulus = c.number(j.get("young_modulus_Pa"), f"{path}.young_modulus_Pa", positive=True, required=False)
    if stiffness is None and modulus is None:
        c.error(f"{path}.mesh_stiffness_N_per_m", "Răng tiếp xúc cần độ cứng ăn khớp mỗi cặp răng "
                                                  "(mesh_stiffness_N_per_m) hoặc mô đun Young của vật liệu bánh "
                                                  "răng (young_modulus_Pa). Không tự đoán.")
    joint["mesh_stiffness"], joint["young_modulus"] = stiffness, modulus
    if j.get("damping_ratio") is None:
        joint["damping_ratio"] = 0.1
        c.assume(f"{path}.damping_ratio", "Không cho damping_ratio: giảm chấn ăn khớp 0.1 (thường 0.03…0.17).")
    else:
        joint["damping_ratio"] = c.number(j.get("damping_ratio"), f"{path}.damping_ratio", minimum=0)
    if joint["internal"]:
        c.error(f"{path}.internal", 'Răng tiếp xúc (model "contact") chỉ có cho cặp ăn khớp ngoài.')


def gear_mesh(teeth_a, teeth_b, module, centre_distance, pressure_angle, backlash):
    """An external spur pair of standard involute gears (addendum m) at `centre_distance`, in SI: base radii, the
    working pressure angle, the line of action from T_a (where it touches gear a's base circle) to T_b, the stretch
    of it where teeth touch (x_start…x_end from T_a), the pitch point, the base pitch, the contact ratio and the
    backlash along the line of action. None when the gears cannot mesh there."""
    r_a, r_b = teeth_a * module / 2, teeth_b * module / 2
    rb_a, rb_b = r_a * math.cos(pressure_angle), r_b * math.cos(pressure_angle)
    if centre_distance <= rb_a + rb_b:
        return None
    working = math.acos((rb_a + rb_b) / centre_distance)
    length = centre_distance * math.sin(working)
    x_end = min(math.sqrt((r_a + module) ** 2 - rb_a ** 2), length)
    x_start = max(length - math.sqrt((r_b + module) ** 2 - rb_b ** 2), 0.0)
    base_pitch = math.pi * module * math.cos(pressure_angle)
    return {"rb_a": rb_a, "rb_b": rb_b, "working_pressure_angle": working, "length": length,
            "x_start": x_start, "x_end": x_end, "x_pitch": rb_a * math.tan(working), "base_pitch": base_pitch,
            "contact_ratio": (x_end - x_start) / base_pitch, "backlash_normal": backlash * math.cos(working)}


def friction_loss(mesh, teeth_a, teeth_b):
    """Ohlendorf's tooth loss factor H_v (ISO/TR 14179-2) of a spur pair: η ≈ 1 - μ·H_v, with the load shared
    evenly where two pairs touch"""
    u = teeth_b / teeth_a
    e1 = (mesh["x_end"] - mesh["x_pitch"]) / mesh["base_pitch"]
    e2 = (mesh["x_pitch"] - mesh["x_start"]) / mesh["base_pitch"]
    return math.pi * (u + 1) / (teeth_a * u) * (1 - mesh["contact_ratio"] + e1 * e1 + e2 * e2)


def axis_inertia(body, axis):
    """A body's moment of inertia about a world axis through its centre of mass"""
    rot = quat_to_matrix(body["orientation"])
    local = rot.T @ np.asarray(axis, float)
    return float(local @ np.asarray(body["inertia"]) @ local)


def refs(c, item, path, bodies):
    out = []
    for key in ("body_a", "body_b"):
        ref = item.get(key)
        if ref not in bodies:
            c.error(f"{path}.{key}", f"Không có body {ref!r}" + (f" (có: {', '.join(bodies)})." if bodies else "."))
        out.append(ref)
    if out[0] is not None and out[0] == out[1]:
        c.error(path, "body_a và body_b phải khác nhau.")
    return out


def read_actuator(c, a, path, bodies, units):
    L, A = units["L"], units["A"]
    kind = c.choice(a.get("type"), f"{path}.type", tuple(ACTUATORS))
    act = {"id": a.get("id"), "type": kind}
    act["body_a"], act["body_b"] = refs(c, a, path, bodies)
    pos = c.vector(a.get("position"), f"{path}.position")
    axis = c.vector(a.get("axis"), f"{path}.axis", unit=True)
    act["position"] = None if pos is None else (pos * L).tolist()
    act["axis"] = None if axis is None else axis.tolist()
    if kind is None:
        return act
    mode = c.choice(a.get("mode"), f"{path}.mode", ACTUATORS[kind])
    act["mode"] = mode
    # Angle / length in the mechanism's units (per s for speeds); torque N·m, force N
    scale = {"angle": A, "speed": A if kind == "rotational_motor" else L, "position": L,
             "torque": 1.0, "force": 1.0}.get(mode, 1.0)
    act["law"] = read_law(c, a.get("law"), f"{path}.law", scale) or None
    guide = a.get("guide")
    act["guide"] = c.choice(guide, f"{path}.guide", ("auto", "joint", "free"), required=False) or "auto"
    return act


def read_force(c, f, path, bodies, units):
    L, A = units["L"], units["A"]
    kind = c.choice(f.get("type"), f"{path}.type", FORCES)
    out = {"id": f.get("id"), "type": kind}
    if kind in ("force", "torque"):
        ref = f.get("body")
        if ref not in bodies:
            c.error(f"{path}.body", f"Không có body {ref!r}.")
        out["body"] = ref
        unit = "N" if kind == "force" else "N·m"
        vec = c.vector(f.get("vector"), f"{path}.vector")
        if vec is not None and np.linalg.norm(vec) < 1e-15:
            c.error(f"{path}.vector", "Vector bằng 0.")
        out["direction"] = None if vec is None or np.linalg.norm(vec) < 1e-15 else (vec / np.linalg.norm(vec)).tolist()
        # The vector's length is the magnitude (N or N·m) unless a law gives it over time
        law = f.get("law")
        out["law"] = read_law(c, law, f"{path}.law", 1.0) if law is not None else (
            None if vec is None else {"type": "constant", "value": float(np.linalg.norm(vec))})
        out["frame"] = c.choice(f.get("frame", "world"), f"{path}.frame", ("world", "body"))
        if kind == "force":
            p = c.vector(f.get("point", [0, 0, 0]), f"{path}.point")
            out["point"] = None if p is None else (p * L).tolist()
        out["unit"] = unit
        return out
    out["body_a"], out["body_b"] = refs(c, f, path, bodies)
    if kind == "spring_damper":
        pa = c.vector(f.get("point_a"), f"{path}.point_a")
        pb = c.vector(f.get("point_b"), f"{path}.point_b")
        out.update(point_a=None if pa is None else (pa * L).tolist(), point_b=None if pb is None else (pb * L).tolist())
        out["stiffness"] = c.number(f.get("stiffness_N_per_m"), f"{path}.stiffness_N_per_m", minimum=0)
        out["damping"] = c.number(f.get("damping_Ns_per_m"), f"{path}.damping_Ns_per_m", minimum=0)
        rest = f.get("rest_length")
        if rest is None:
            out["rest_length"] = None
            c.assume(f"{path}.rest_length", "Không cho chiều dài tự do: lấy khoảng cách hai điểm lúc t = 0.")
        else:
            r = c.number(rest, f"{path}.rest_length", minimum=0)
            out["rest_length"] = r and r * L
        return out
    # rotational_spring_damper: about a revolute joint's axis
    pos = c.vector(f.get("position"), f"{path}.position")
    axis = c.vector(f.get("axis"), f"{path}.axis", unit=True)
    out.update(position=None if pos is None else (pos * L).tolist(), axis=None if axis is None else axis.tolist())
    out["stiffness"] = c.number(f.get("stiffness_Nm_per_rad"), f"{path}.stiffness_Nm_per_rad", minimum=0)
    out["damping"] = c.number(f.get("damping_Nms_per_rad"), f"{path}.damping_Nms_per_rad", minimum=0)
    rest = c.number(f.get("rest_angle", 0.0), f"{path}.rest_angle")
    out["rest_angle"] = rest and rest * A
    return out


def read_simulation(c, s, path, L):
    s = c.obj(s, path)
    if s is None:
        return None
    sim = {}
    sim["duration"] = c.number(s.get("duration"), f"{path}.duration", positive=True)
    sim["time_step"] = c.number(s.get("time_step"), f"{path}.time_step", positive=True)
    out = s.get("output_interval")
    sim["output_interval"] = c.number(out, f"{path}.output_interval", positive=True, required=False)
    if sim["duration"] and sim["time_step"]:
        if sim["time_step"] > sim["duration"]:
            c.error(f"{path}.time_step", "Bước thời gian lớn hơn thời gian mô phỏng.")
        elif sim["duration"] / sim["time_step"] > MAX_STEPS:
            c.error(f"{path}.time_step", f"Quá nhiều bước ({sim['duration'] / sim['time_step']:.0f} > {MAX_STEPS}).")
        if sim["output_interval"] is None:
            sim["output_interval"] = max(sim["time_step"], sim["duration"] / 500)
            c.assume(f"{path}.output_interval", f"Không cho output_interval: ghi mỗi {sim['output_interval']:.4g} s.")
        elif sim["output_interval"] < sim["time_step"] * (1 - 1e-9):
            c.error(f"{path}.output_interval", "output_interval phải ≥ time_step.")
        elif sim["duration"] / sim["output_interval"] > MAX_SAMPLES:
            c.error(f"{path}.output_interval", f"Quá nhiều mẫu ghi ra (> {MAX_SAMPLES}).")
    if "gravity" in s:
        g = c.vector(s["gravity"], f"{path}.gravity")
        sim["gravity"] = None if g is None else g.tolist()
    else:
        sim["gravity"] = [0.0, 0.0, -9.81]
        c.assume(f"{path}.gravity", "Không cho gravity: dùng [0, 0, -9.81] m/s² (Z hướng lên).")
    sim["solver"] = c.choice(s.get("solver", "default"), f"{path}.solver", SOLVERS)
    sim["integrator"] = c.choice(s.get("integrator", "default"), f"{path}.integrator", INTEGRATORS)
    sim["max_iterations"] = s.get("max_iterations")
    if sim["max_iterations"] is not None and (not isinstance(sim["max_iterations"], int) or sim["max_iterations"] < 1):
        c.error(f"{path}.max_iterations", "Phải là số nguyên dương.")
    sim["tolerance"] = c.number(s.get("tolerance"), f"{path}.tolerance", positive=True, required=False)
    collision = s.get("collision") or {}
    collision = c.obj(collision, f"{path}.collision") or {}
    enabled = collision.get("enabled", False)
    if not isinstance(enabled, bool):
        c.error(f"{path}.collision.enabled", "Phải là true hoặc false.")
    sim["collision"] = {"enabled": bool(enabled),
                        "method": c.choice(collision.get("method", "nsc"), f"{path}.collision.method", CONTACT_METHODS)}
    # Chrono's own defaults (30 mm envelope, 10 mm margin) are for metre-sized bodies
    for key, default in (("envelope", 0.0005), ("margin", 0.0001)):
        value = collision.get(key)
        if value is None:
            sim["collision"][key] = default
            if enabled:
                c.assume(f"{path}.collision.{key}", f"Không cho {key}: dùng {default * 1000:g} mm.")
        else:
            value = c.number(value, f"{path}.collision.{key}", positive=True)
            sim["collision"][key] = value and value * L
    sim["constraint_tolerance"] = c.number(s.get("constraint_tolerance", 1e-6), f"{path}.constraint_tolerance",
                                           positive=True)
    return sim


# ---------- the whole mechanism ----------

def check_ids(c, items, path, seen):
    for i, item in enumerate(items):
        ident = item.get("id") if isinstance(item, dict) else None
        if not isinstance(ident, str) or not ID_RE.match(ident):
            c.error(f"{path}[{i}].id", f"Cần id gồm chữ, số, _ . - (tối đa 64 ký tự), nhận {ident!r}.")
        elif ident in seen:
            c.error(f"{path}[{i}].id", f"id {ident!r} bị trùng.")
        else:
            seen.add(ident)


def items(c, m, key):
    value = m.get(key, [])
    if not isinstance(value, list):
        c.error(key, "Phải là mảng.")
        return []
    good = []
    for i, item in enumerate(value):
        if isinstance(item, dict):
            good.append((i, item))
        else:
            c.error(f"{key}[{i}]", "Phải là object.")
    return good


def degrees_of_freedom(model):
    """Grübler's count: 6 per dynamic body, less what each joint, guiding motor and gear takes away. Redundant
    constraints make it too low, so it is a hint, not a proof"""
    removed = {"fixed": 6, "revolute": 5, "prismatic": 5, "spherical": 3, "cylindrical": 4, "distance": 1, "gear": 1}
    dof = 6 * sum(not b["fixed"] for b in model["bodies"])
    dof -= sum(removed[j["type"]] for j in model["joints"] if j.get("model") != "contact")
    for a in model["actuators"]:
        # A motor drives one coordinate; with no joint of its own it also guides like a revolute or prismatic
        dof -= 6 if a["guide_constraint"] else 1
    return dof


def check_gear_contact(c, model, k, j, ga, gb, distance, expected):
    """Teeth in contact: the line of action at the real centre distance, a contact ratio of at least 1, the mesh
    stiffness and damping, and a time step short enough for the mesh's own vibration. Writes j["mesh"] (SI)."""
    path = f"joints[{k}]"
    if None in (j.get("backlash"), j.get("friction"), j.get("pressure_angle"), j.get("damping_ratio")):
        return
    if distance < expected * (1 - 1e-6) - 1e-9:
        c.error(path, f"Khoảng cách tâm {distance * 1000:.4g} mm nhỏ hơn m(N_a + N_b)/2 = {expected * 1000:.4g} mm: "
                      "răng chồng lên nhau.")
        return
    mesh = gear_mesh(j["teeth_a"], j["teeth_b"], ga["module"], distance, j["pressure_angle"], j["backlash"])
    if mesh is None or mesh["contact_ratio"] < 1:
        c.error(path, f"Ở khoảng cách tâm {distance * 1000:.4g} mm hệ số trùng khớp "
                      f"{mesh['contact_ratio'] if mesh else 0:.3g} < 1: răng không ăn khớp liên tục.")
        return
    width = min(ga["length"], gb["length"])
    if j["mesh_stiffness"] is not None:
        stiffness = j["mesh_stiffness"]
    else:
        stiffness = TOOTH_STIFFNESS_STEEL * width * j["young_modulus"] / E_STEEL
        c.assume(f"{path}.mesh_stiffness_N_per_m",
                 f"Độ cứng mỗi cặp răng {stiffness:.4g} N/m ước từ ISO 6336 (c' = 14 N/(mm·µm) của thép × "
                 f"E {j['young_modulus']:.3g} Pa / 206 GPa × bề rộng {width * 1000:.4g} mm), không đổi dọc đường ăn "
                 "khớp.")
    bodies = {b["id"]: b for b in model["bodies"]}
    axis = next(x for x in model["joints"] if x["id"] == j["joint_a"])["axis"]
    if any(bodies[j[s]]["inertia"] is None for s in ("body_a", "body_b")):
        return
    ia, ib = (axis_inertia(bodies[j[s]], axis) for s in ("body_a", "body_b"))
    mass = 1 / (mesh["rb_a"] ** 2 / ia + mesh["rb_b"] ** 2 / ib)
    # The stiffest moment is when the most pairs touch
    omega = math.sqrt(math.ceil(mesh["contact_ratio"]) * stiffness / mass)
    period = 2 * math.pi / omega
    step = (model["simulation"] or {}).get("time_step")
    if step and step > period / STEPS_PER_MESH_PERIOD:
        c.error("simulation.time_step", f"Bánh răng tiếp xúc {j['id']!r} dao động ăn khớp chu kỳ {period:.3g} s: cần "
                                        f"time_step ≤ {period / STEPS_PER_MESH_PERIOD:.3g} s.")
    mesh.update(stiffness=stiffness, damping=2 * j["damping_ratio"] * math.sqrt(stiffness * mass),
                friction=j["friction"], mesh_mass=mass, mesh_period=period,
                loss_factor=friction_loss(mesh, j["teeth_a"], j["teeth_b"]))
    j["mesh"] = mesh
    c.assume(path, f"Răng tiếp xúc {j['id']}: lúc t = 0 răng nằm giữa khe hở và một cặp răng ở tâm ăn khớp; hệ số "
                   f"trùng khớp {mesh['contact_ratio']:.3f}. Lực pháp tuyến đi qua ổ trục; ma sát chỉ tạo mômen.")


def check_gear_mesh(c, model):
    """Two gear bodies on a gear joint: their module and teeth should agree with the joint and the centre distance"""
    bodies = {b["id"]: b for b in model["bodies"]}
    joints = {j["id"]: j for j in model["joints"]}
    for k, j in enumerate(model["joints"]):
        if j.get("type") != "gear" or not j.get("carrier"):
            continue
        ga, gb = (bodies.get(j[s]) and bodies[j[s]].get("geometry") for s in ("body_a", "body_b"))
        if not (ga and gb and ga["type"] == gb["type"] == "gear" and ga.get("radius") and gb.get("radius")):
            if j.get("model") == "contact":
                c.error(f"joints[{k}]", 'Răng tiếp xúc cần hai body có geometry "gear" (teeth, module, width).')
            continue
        for side, g in (("a", ga), ("b", gb)):
            if g["teeth"] != j[f"teeth_{side}"]:
                c.error(f"joints[{k}].teeth_{side}", f"Khác số răng của body {j['body_' + side]!r} ({g['teeth']}).")
        if abs(ga["module"] - gb["module"]) > 1e-12:
            c.error(f"joints[{k}]", "Hai bánh răng ăn khớp phải cùng module.")
        pa, pb = (np.asarray(joints[j[s]]["position"]) for s in ("joint_a", "joint_b"))
        axis = np.asarray(joints[j["joint_a"]]["axis"])
        d = pb - pa
        distance = float(np.linalg.norm(d - np.dot(d, axis) * axis))
        expected = abs(gb["radius"] + (-ga["radius"] if j["internal"] else ga["radius"]))
        if j.get("model") == "contact":
            check_gear_contact(c, model, k, j, ga, gb, distance, expected)
            continue
        if abs(distance - expected) > 1e-6 + 1e-3 * expected:
            c.error(f"joints[{k}]", f"Khoảng cách tâm {distance * 1000:.4g} mm khác m(N_a {'−' if j['internal'] else '+'}"
                                    f" N_b)/2 = {expected * 1000:.4g} mm: bánh răng không ăn khớp.")


def check_contacts(c, model):
    """Bodies that collide: SMC needs each one's Young's modulus and Poisson's ratio; collision has to be on"""
    sim = model["simulation"] or {}
    collision = sim.get("collision") or {}
    for i, b in enumerate(model["bodies"]):
        if not b["collision"]:
            continue
        if not collision.get("enabled"):
            c.warn(f"bodies[{i}].collision", "Body có collision nhưng simulation.collision.enabled = false: không "
                                             "tính va chạm.")
        elif collision.get("method") == "smc" and b["material"]:
            for key, unit in (("young_modulus", "_Pa"), ("poisson_ratio", "")):
                if b["material"].get(key) is None:
                    c.error(f"bodies[{i}].material.{key}{unit}", "Va chạm SMC cần mô đun Young (young_modulus_Pa) "
                                                                 "và hệ số Poisson (poisson_ratio) của vật liệu.")
    if collision.get("enabled") and collision.get("method") == "smc" and (sim.get("time_step") or 0) > 1e-4:
        c.warn("simulation.time_step", "Va chạm SMC (lò xo phạt) thường cần time_step ≤ 1e-4 s; bước lớn hơn có thể "
                                       "làm vật nảy hoặc xuyên vào nhau.")


def normalise(mechanism, resolve_file=None):
    """The mechanism in SI, ready for chrono_run.py: {"model", "warnings", "assumptions"}. Raises MechanismError
    listing every problem."""
    resolve_file = resolve_file or (lambda name: (_ for _ in ()).throw(ValueError("Không dùng được file ở đây.")))
    c = Checker()
    m = c.obj(mechanism, "$")
    if m is None:
        raise MechanismError(c.errors)
    if m.get("schema_version") != SCHEMA_VERSION:
        c.error("schema_version", f"Cần schema_version = {SCHEMA_VERSION}, nhận {m.get('schema_version')!r}.")
    units = c.obj(m.get("units"), "units") or {}
    lu = c.choice(units.get("length"), "units.length", tuple(LENGTHS))
    mu = c.choice(units.get("mass", "kg"), "units.mass", tuple(MASSES))
    au = c.choice(units.get("angle", "deg"), "units.angle", tuple(ANGLES))
    if units and "angle" not in units:
        c.assume("units.angle", "Không cho đơn vị góc: dùng độ (deg).")
    if c.errors:
        raise MechanismError(c.errors)
    U = {"L": LENGTHS[lu], "M": MASSES[mu], "A": ANGLES[au]}

    seen = set()
    raw = {key: items(c, m, key) for key in ("bodies", "joints", "actuators", "forces")}
    for key in raw:
        check_ids(c, [x for _, x in raw[key]], key, seen)
    if not raw["bodies"]:
        c.error("bodies", "Cần ít nhất một body.")
    bodies = {b.get("id"): b for _, b in raw["bodies"] if isinstance(b.get("id"), str)}

    model = {"schema_version": SCHEMA_VERSION, "name": str(m.get("name") or "Cơ cấu"),
             "units_in": {"length": lu, "mass": mu, "angle": au}}
    model["bodies"] = [read_body(c, b, f"bodies[{i}]", U, resolve_file) for i, b in raw["bodies"]]
    model["joints"] = []
    for i, j in raw["joints"]:
        model["joints"].append(read_joint(c, j, f"joints[{i}]", bodies, model["joints"], U))
    model["actuators"] = [read_actuator(c, a, f"actuators[{i}]", bodies, U) for i, a in raw["actuators"]]
    model["forces"] = [read_force(c, f, f"forces[{i}]", bodies, U) for i, f in raw["forces"]]
    model["simulation"] = read_simulation(c, m.get("simulation"), "simulation", U["L"])

    if not any(b["fixed"] for b in model["bodies"]):
        c.warn("bodies", "Không có body cố định: cả cơ cấu sẽ rơi tự do theo trọng lực.")
    dynamic = {b["id"] for b in model["bodies"] if not b["fixed"]}
    pairs = {}
    for j in model["joints"]:
        if j.get("type") != "gear":
            pairs.setdefault(frozenset((j.get("body_a"), j.get("body_b"))), []).append(j)
        if {j.get("body_a"), j.get("body_b")} and not ({j.get("body_a"), j.get("body_b")} & dynamic) \
                and j.get("type") != "gear":
            c.warn(f"joints[{j['id']}]", "Khớp nối hai body cố định: không có tác dụng.")
    for k, a in enumerate(model["actuators"]):
        # A motor on a pair a revolute/prismatic joint already guides only drives; otherwise it guides too
        on_pair = pairs.get(frozenset((a.get("body_a"), a.get("body_b"))), [])
        wanted = "revolute" if a.get("type") == "rotational_motor" else "prismatic"
        guide = a["guide"]
        if guide == "auto":
            guide = "free" if any(j["type"] in (wanted, "cylindrical") for j in on_pair) else "joint"
        a["guide_constraint"] = guide == "joint"
        if guide == "joint" and any(j["type"] in (wanted, "cylindrical") for j in on_pair):
            c.warn(f"actuators[{k}].guide", "Động cơ vừa dẫn hướng vừa có khớp cùng cặp body: ràng buộc thừa.")
        for j in on_pair:
            if j.get("axis") and a.get("axis") and abs(abs(float(np.dot(j["axis"], a["axis"]))) - 1) > 1e-6 \
                    and j["type"] in (wanted, "cylindrical"):
                c.error(f"actuators[{k}].axis", f"Trục động cơ không song song với trục khớp {j['id']!r}.")
            if j["type"] == "fixed":
                c.error(f"actuators[{k}]", f"Động cơ giữa hai body đã bị khớp fixed {j['id']!r} khóa cứng.")

    check_gear_mesh(c, model)
    check_contacts(c, model)
    if c.errors:
        raise MechanismError(c.errors, c.warnings)
    dof = degrees_of_freedom(model)
    model["dof_estimate"] = dof
    if dof < 0:
        c.warn("joints", f"Bậc tự do ước tính {dof} < 0: có ràng buộc thừa hoặc mâu thuẫn; Chrono sẽ kiểm tra khi "
                         "lắp ráp.")
    model["assumptions"], model["warnings"] = c.assumptions, c.warnings
    return {"model": model, "warnings": c.warnings, "assumptions": c.assumptions}
