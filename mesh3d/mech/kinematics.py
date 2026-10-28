"""
The assembly engine: from the normalised mechanical model (model.py) to what a solver needs, and what can be
known before it runs.

1. Parts placed in the assembly frame; their meshes (shape or file) and mass properties with provenance.
2. Rigid groups: parts joined by fixed joints move as one body (a gear keyed on its shaft); every fixed part is in the
   ground group. A joint or a motor between two parts of one group is a conflict, named with the fixed joints that
   make the group.
3. Constraint equations of the joints (a revolute: 3 positions + 2 axis directions; prismatic: 2 + 3; …), gear pairs
   (N_a·dθ_a ± N_b·dθ_b = 0 about the carrier) and kinematic motors (angle/speed/position), as functions of a small
   motion q (6 per moving group: translation of its centre of mass, rotation vector). The Jacobian's rank, by SVD,
   gives the degrees of freedom exactly, where Grübler's count only estimates: the equations that add no rank are
   redundant (a planar linkage modelled with 3D revolutes), and a motor whose equation adds no rank drives a
   coordinate the joints already lock.
4. Velocities: the motors at their rates, the equations solved by least squares: how fast each part turns and
   moves (gear-train output speed, slider speed), and which motor moves which part.
5. Positions: the motor coordinate stepped and the equations solved by Newton's method at each step: the kinematic
   prediction (a slider's stroke over a crank turn) that the dynamics run is compared with.
6. Geometry checks: joint positions near both parts, revolute axes along a shaft's or gear's axis, gear centre
   distances, overlapping parts at t = 0.

Lengths mm, angles rad, masses kg, inertias kg·mm² (in the world frame at t = 0).
"""

import math

import numpy as np

from . import shapes
from .model import quat_to_matrix

ROW_TOL = 1e-8
GEOM_TOL_MM = 0.5


def skew(v):
    return np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])


def rot(v):
    """Rotation matrix of a rotation vector (Rodrigues)"""
    angle = float(np.linalg.norm(v))
    if angle < 1e-15:
        return np.eye(3) + skew(v)
    k = skew(np.asarray(v) / angle)
    return np.eye(3) + math.sin(angle) * k + (1 - math.cos(angle)) * k @ k


def basis(z):
    z = np.asarray(z, float) / np.linalg.norm(z)
    helper = np.array([1.0, 0, 0]) if abs(z[0]) < 0.9 else np.array([0, 1.0, 0])
    x = np.cross(helper, z)
    x /= np.linalg.norm(x)
    return x, np.cross(z, x), z


def diag(severity, code, message, parts=(), joints=(), suggestion=None):
    out = {"severity": severity, "code": code, "message": message, "parts": list(parts), "joints": list(joints)}
    if suggestion:
        out["suggestion"] = suggestion
    return out


# ---------- parts and rigid groups ----------

def place_parts(model, resolve_mesh=None):
    """Each part's world transform, mesh in the world, and mass properties with their provenance"""
    import trimesh

    placed = {}
    for p in model["parts"]:
        R, pos = quat_to_matrix(p["orientation"]), np.asarray(p["position"]["value"], float)
        mesh = None
        if p.get("shape"):
            mesh = shapes.build(p["shape"])
            T = np.eye(4)
            T[:3, :3], T[:3, 3] = R, pos
            mesh.apply_transform(T)
        elif p.get("geometry_path"):
            # Imported geometry is already where the assembly has it
            mesh = trimesh.load(p["geometry_path"], force="mesh", process=True)
        mass_info = {"mass": p.get("mass"), "center_of_mass": p.get("center_of_mass"), "inertia": p.get("inertia")}
        props = None
        if not p["fixed"]:
            density = (p.get("density") or {}).get("value")
            given_mass = (p.get("mass") or {}).get("value")
            if mesh is not None and (density or given_mass):
                props = shapes.mass_properties(mesh, density, given_mass)
            if props is not None:
                m, com, inertia = props
                if p.get("mass") is None:
                    mass_info["mass"] = {"value": round(m, 9), "source": "geometry", "unit": "kg",
                                         "note": f"thể tích × khối lượng riêng ({p['density']['source']})"}
                if p.get("center_of_mass") is None:
                    mass_info["center_of_mass"] = {"value": com.tolist(), "source": "geometry", "unit": "mm"}
                if p.get("inertia") is None:
                    mass_info["inertia"] = {"value": inertia.tolist(), "source": "geometry", "unit": "kg·mm²"}
            elif p.get("mass") is not None and p.get("center_of_mass") is not None and p.get("inertia") is not None:
                c = R @ np.asarray(p["center_of_mass"]["value"]) + pos
                I = R @ np.asarray(p["inertia"]["value"]) @ R.T
                props = (p["mass"]["value"], c, I)
        placed[p["id"]] = {"part": p, "R": R, "pos": pos, "mesh": mesh, "props": props, "mass_info": mass_info}
    return placed


def rigid_groups(model):
    """{part id: group id}: fixed joints and fixed parts merged (union-find); the ground group is "ground" """
    parent = {p["id"]: p["id"] for p in model["parts"]}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    fixed = [p["id"] for p in model["parts"] if p["fixed"]]
    for a, b in zip(fixed, fixed[1:]):
        parent[find(a)] = find(b)
    for j in model["joints"]:
        if j["type"] == "fixed":
            parent[find(j["part_a"])] = find(j["part_b"])
    ground_root = find(fixed[0]) if fixed else None
    groups = {}
    for p in model["parts"]:
        root = find(p["id"])
        groups[p["id"]] = "ground" if root == ground_root else f"g:{root}"
    # Readable names, valid as sim body ids: a single part keeps its id; a rigid group is named after its main part
    # (a shaft before the gears keyed on it)
    members = {}
    for pid, g in groups.items():
        members.setdefault(g, []).append(pid)
    roles = {p["id"]: p["role"] for p in model["parts"]}
    order = ("shaft", "crank", "rocker", "link", "rod", "arm", "slider", "gear", "pulley")

    def main(ps):
        return sorted(ps, key=lambda p: (order.index(roles[p]) if roles[p] in order else len(order), p))[0]

    rename = {g: "ground" if g == "ground" else ps[0] if len(ps) == 1 else f"{main(ps)}_group" for g, ps in members.items()}
    return {pid: rename[g] for pid, g in groups.items()}, {rename[g]: ps for g, ps in members.items()}


def group_mass(placed, part_ids):
    """Mass, centre of mass and inertia (about it, world axes) of rigidly joined parts; None if any is unknown"""
    total, moment, items = 0.0, np.zeros(3), []
    for pid in part_ids:
        props = placed[pid]["props"]
        if props is None:
            return None
        m, c, I = props
        total += m
        moment += m * np.asarray(c)
        items.append((m, np.asarray(c), np.asarray(I)))
    com = moment / total
    inertia = np.zeros((3, 3))
    for m, c, I in items:
        d = c - com
        inertia += I + m * (np.dot(d, d) * np.eye(3) - np.outer(d, d))
    return total, com, inertia


# ---------- constraint equations ----------

class Assembly:
    """The model as groups, the joints between them, and their constraint equations"""

    def __init__(self, model, resolve_mesh=None):
        self.model = model
        self.diagnostics = []
        self.placed = place_parts(model, resolve_mesh)
        self.group_of, self.members = rigid_groups(model)
        self.moving = [g for g in self.members if g != "ground"]
        self.index = {g: i for i, g in enumerate(self.moving)}
        self.mass = {g: group_mass(self.placed, ps) for g, ps in self.members.items() if g != "ground"}
        # Reference point of each group: its centre of mass, else the mean of its parts' positions
        self.center = {}
        for g, ps in self.members.items():
            m = self.mass.get(g)
            self.center[g] = m[1] if m else np.mean([self.placed[p]["pos"] for p in ps], axis=0)
        self.joints = []  # (joint, group a, group b)
        self.gear_joints = {}  # gear id → (revolute joint of gear a, of gear b) on their common carrier
        self.check_structure()

    # ----- structure -----
    def check_structure(self):
        m = self.model
        fixed_joints = {}
        for j in m["joints"]:
            if j["type"] == "fixed":
                fixed_joints.setdefault(self.group_of[j["part_a"]], []).append(j["id"])
        for j in m["joints"]:
            ga, gb = self.group_of[j["part_a"]], self.group_of[j["part_b"]]
            if j["type"] == "fixed":
                if self.placed[j["part_a"]]["part"]["fixed"] and self.placed[j["part_b"]]["part"]["fixed"]:
                    self.diagnostics.append(diag("info", "FIXED_BETWEEN_GROUND", f"Khớp fixed {j['id']} nối hai chi tiết đều cố định: không có tác dụng.", [j["part_a"], j["part_b"]], [j["id"]]))
                continue
            if ga == gb:
                via = fixed_joints.get(ga, [])
                self.diagnostics.append(diag(
                    "error", "JOINT_INSIDE_RIGID_GROUP",
                    f"Khớp {j['type']} {j['id']} nối {j['part_a']} và {j['part_b']}, nhưng hai chi tiết này đã bị gắn cứng "
                    f"với nhau ({'qua ' + ', '.join(via) if via else 'cùng cố định với nền'}): khớp không thể chuyển động.",
                    [j["part_a"], j["part_b"]], [j["id"], *via],
                    "Bỏ khớp fixed / bỏ cố định của một chi tiết, hoặc bỏ khớp này."))
                continue
            self.joints.append((j, ga, gb))
        joints = {j["id"]: j for j in m["joints"]}
        for mo in m["motors"]:
            j = joints.get(mo["joint"])
            if j and self.group_of[j["part_a"]] == self.group_of[j["part_b"]]:
                via = fixed_joints.get(self.group_of[j["part_a"]], [])
                self.diagnostics.append(diag(
                    "error", "MOTOR_ON_LOCKED_PAIR",
                    f"Động cơ {mo['id']} quay/đẩy khớp {j['id']} giữa {j['part_a']} và {j['part_b']}, nhưng hai chi tiết đã "
                    f"bị gắn cứng ({'qua ' + ', '.join(via) if via else 'đều cố định'}): động cơ không thể chạy.",
                    [j["part_a"], j["part_b"]], [j["id"], *via, mo["id"]],
                    "Bỏ khớp fixed (hoặc fixed: true) đang khóa chi tiết được động cơ dẫn động."))
        for g in self.moving:
            if self.mass.get(g) is None:
                unknown = [p for p in self.members[g] if self.placed[p]["props"] is None]
                self.diagnostics.append(diag(
                    "error", "MASS_UNKNOWN",
                    f"Chưa biết khối lượng/quán tính của {', '.join(unknown)}: cần mass, hoặc material/density cùng hình học kín.",
                    unknown, (), "Cho material (vd. \"steel\", \"pla\") hoặc density_kg_m3, hoặc mass + inertia."))

    # ----- frames -----
    def frame(self, j):
        if j["type"] == "distance":
            return {"pa": np.asarray(j["point_a"]), "pb": np.asarray(j["point_b"])}
        x, y, z = basis(j["axis"])
        return {"p": np.asarray(j["position"]), "x": x, "y": y, "z": z}

    def apply(self, q, poses=None):
        """World pose (R, c) of every group for a small motion q from `poses` (default: t = 0)"""
        poses = poses or {g: (np.eye(3), self.center[g]) for g in self.members}
        out = {}
        for g, (R, c) in poses.items():
            if g in self.index:
                i = 6 * self.index[g]
                out[g] = (rot(q[i + 3:i + 6]) @ R, c + q[i:i + 3])
            else:
                out[g] = (R, c)
        return out

    def world(self, poses, g, point, ref):
        """A point fixed to group g, given at t = 0 (ref poses), where it is now"""
        R0, c0 = ref[g]
        R, c = poses[g]
        return c + R @ (R0.T @ (np.asarray(point) - c0))

    def wdir(self, poses, g, d, ref):
        R0, _ = ref[g]
        R, _ = poses[g]
        return R @ (R0.T @ np.asarray(d))

    def joint_rows(self, j, ga, gb, poses, ref):
        """The joint's residuals at `poses` (frames fixed in their groups at `ref`)"""
        f = self.frame(j)
        t = j["type"]
        if t == "distance":
            a, b = self.world(poses, ga, f["pa"], ref), self.world(poses, gb, f["pb"], ref)
            return [np.linalg.norm(a - b) - np.linalg.norm(f["pa"] - f["pb"])]
        pa, pb = self.world(poses, ga, f["p"], ref), self.world(poses, gb, f["p"], ref)
        xa, ya, za = (self.wdir(poses, ga, f[k], ref) for k in ("x", "y", "z"))
        xb, yb, zb = (self.wdir(poses, gb, f[k], ref) for k in ("x", "y", "z"))
        d = pb - pa
        rows = []
        if t in ("revolute", "spherical", "fixed"):
            rows += list(d)
        if t in ("revolute", "cylindrical", "prismatic", "fixed", "planar"):
            rows += [float(np.dot(za, xb)), float(np.dot(za, yb))]
        if t in ("cylindrical", "prismatic"):
            rows += [float(np.dot(d, xa)), float(np.dot(d, ya))]
        if t in ("prismatic", "fixed"):
            rows += [float(np.dot(xa, yb))]
        if t == "planar":
            rows += [float(np.dot(d, za))]
        return rows

    def gear_rows(self, q):
        """N_a(dθ_a − dθ_c)·n + s·N_b(dθ_b − dθ_c)·n for every gear pair (linear in q)"""
        rows, info = [], []
        for g in self.model["gears"]:
            meta = self.gear_meta(g)
            if meta is None:
                continue
            ga, gb, gc, n, s = meta

            def rotv(grp):
                return q[6 * self.index[grp] + 3:6 * self.index[grp] + 6] if grp in self.index else np.zeros(3)

            na, nb = g["teeth_a"] or 1, g["teeth_b"] or 1
            rows.append(na * np.dot(rotv(ga) - rotv(gc), n) + s * nb * np.dot(rotv(gb) - rotv(gc), n))
            info.append(g["id"])
        return rows, info

    def gear_meta(self, g):
        """(group a, group b, carrier group, axis, sign) of a gear pair, or None (diagnosed)"""
        ga, gb = self.group_of.get(g["gear_a"]), self.group_of.get(g["gear_b"])
        carriers = {}
        for j, a, b in self.joints:
            if j["type"] not in ("revolute", "cylindrical"):
                continue
            for grp, other in ((a, b), (b, a)):
                if grp in (ga, gb):
                    carriers.setdefault(grp, []).append((other, np.asarray(j["axis"]), j["id"]))
        common = None
        for ca, na, ja in carriers.get(ga, []):
            for cb, nb, jb in carriers.get(gb, []):
                if ca == cb and abs(abs(np.dot(na, nb)) - 1) < 1e-6:
                    common = (ca, na, ja, jb)
        if common is None:
            return None
        self.gear_joints[g["id"]] = (common[2], common[3])
        return ga, gb, common[0], common[1], (-1 if g["internal"] else 1)

    def motor_rows(self, q, poses, ref, kinematic_only=True):
        rows, info = [], []
        joints = {j["id"]: (j, a, b) for j, a, b in self.joints}
        for mo in self.model["motors"]:
            if kinematic_only and mo.get("mode") in ("torque", "force"):
                continue
            if mo["joint"] not in joints:
                continue
            j, ga, gb = joints[mo["joint"]]
            n = np.asarray(j["axis"])

            def part(grp, k):
                return q[6 * self.index[grp] + k:6 * self.index[grp] + k + 3] if grp in self.index else np.zeros(3)

            if j["type"] in ("revolute", "cylindrical"):
                rows.append(float(np.dot(part(gb, 3) - part(ga, 3), n)))
            else:
                p = np.asarray(j["position"])
                pa, pb = self.world(poses, ga, p, ref), self.world(poses, gb, p, ref)
                rows.append(float(np.dot(pb - pa, n)))
            info.append(mo["id"])
        return rows, info

    # ----- Jacobians -----
    def jacobian(self, fn, poses=None, eps=1e-6):
        n = 6 * len(self.moving)
        ref = poses or self.apply(np.zeros(n))
        f0 = np.asarray(fn(np.zeros(n), ref), float)
        J = np.zeros((len(f0), n))
        for k in range(n):
            dq = np.zeros(n)
            dq[k] = eps
            J[:, k] = (np.asarray(fn(dq, ref), float) - np.asarray(fn(-dq, ref), float)) / (2 * eps)
        return J, f0

    def joint_system(self, ref):
        """Residual function of all joints and gears, and the owner of each row"""
        owners = []
        for j, a, b in self.joints:
            owners += [j["id"]] * len(self.joint_rows(j, a, b, ref, ref))
        gear_ids = self.gear_rows(np.zeros(6 * len(self.moving)))[1]
        owners += gear_ids

        def fn(q, poses_ref):
            poses = self.apply(q, poses_ref)
            rows = []
            for j, a, b in self.joints:
                rows += self.joint_rows(j, a, b, poses, ref)
            rows += self.gear_rows(q)[0]
            return rows
        return fn, owners


def rank(J):
    if J.size == 0:
        return 0
    s = np.linalg.svd(J, compute_uv=False)
    return int((s > ROW_TOL * max(1.0, s.max())).sum())


def analyse(asm):
    """DOF, redundancy, motor conflicts, motion paths, expected velocities: {"dof", "diagnostics", "velocities", …}"""
    out = {"groups": {g: asm.members[g] for g in asm.members}, "moving_groups": asm.moving}
    n = 6 * len(asm.moving)
    ref = asm.apply(np.zeros(n))
    if n == 0:
        out.update(dof={"coordinates": 0, "mobility": 0, "driven": 0, "redundant_equations": 0})
        return out
    fn, owners = asm.joint_system(ref)
    J, _ = asm.jacobian(fn, ref)
    r = rank(J)
    # Equations that add no rank, in model order: redundant
    redundant = {}
    acc = np.zeros((0, n))
    current = 0
    for k, row in enumerate(J):
        trial = np.vstack([acc, row])
        rk = rank(trial)
        if rk == current:
            redundant[owners[k]] = redundant.get(owners[k], 0) + 1
        else:
            acc, current = trial, rk
    mobility = n - r

    def motor_fn(q, poses_ref):
        return asm.motor_rows(q, asm.apply(q, poses_ref), ref)[0]
    M, _ = asm.jacobian(motor_fn, ref)
    motor_ids = asm.motor_rows(np.zeros(n), ref, ref)[1]
    full = np.vstack([J, M]) if len(M) else J
    driven = n - rank(full)
    out["dof"] = {"coordinates": n, "equations": int(J.shape[0]), "rank": r, "mobility": mobility,
                  "kinematic_motors": len(motor_ids), "driven": driven,
                  "redundant_equations": int(J.shape[0] - r), "redundant_by_joint": redundant}
    diags = asm.diagnostics
    if redundant:
        diags.append(diag("warning", "REDUNDANT_CONSTRAINTS",
                          f"{J.shape[0] - r} phương trình ràng buộc thừa ({', '.join(f'{k}: {v}' for k, v in redundant.items())}): "
                          "thường gặp ở cơ cấu phẳng mô hình bằng khớp không gian. Chuyển động vẫn xác định, nhưng phản lực "
                          "chia giữa các khớp không duy nhất.", (), list(redundant),
                          "Đổi một khớp revolute của vòng kín thành spherical/cylindrical nếu cần phản lực chính xác."))
    # Each motor must drive a coordinate the joints leave free
    for k, mid in enumerate(motor_ids):
        if rank(np.vstack([J, M[k]])) == r:
            diags.append(diag("error", "MOTOR_DRIVES_LOCKED_COORDINATE",
                              f"Động cơ {mid} dẫn một tọa độ mà các khớp đã khóa: không thể vừa giữ vừa quay/đẩy.",
                              (), [mid], "Kiểm tra khớp cố định, trục khớp, hoặc vị trí lắp."))
    if len(motor_ids) > 1 and rank(full) < r + len(motor_ids):
        diags.append(diag("error", "MOTORS_CONFLICT", "Các động cơ dẫn cùng một tọa độ hoặc tọa độ phụ thuộc nhau.",
                          (), motor_ids))
    has_free_drive = any(m.get("mode") in ("torque", "force") for m in asm.model["motors"]) or any(
        l.get("type") in ("spring_damper", "rotational_spring_damper", "force", "torque") for l in asm.model["loads"])
    if driven > 0:
        sev = "info" if has_free_drive or not motor_ids else "warning"
        diags.append(diag(sev, "UNDRIVEN_DOF",
                          f"Còn {driven} bậc tự do không do động cơ dẫn: các chi tiết đó chuyển động theo trọng lực/tải/quán tính.",
                          (), ()))
    if mobility == 0 and not motor_ids:
        diags.append(diag("warning", "NO_MOBILITY", "Cơ cấu không có bậc tự do: mọi chi tiết bị khóa.", (), ()))
    # Velocities with the motors at their rates
    out["velocities"] = velocities(asm, J, M, motor_ids, ref)
    return out


def motor_rate(motor, rotational=True):
    """The motor's steady rate from its law: rad/s for a rotational motor (laws in deg), mm/s for a linear one; None
    for torque/force or a law without a steady value"""
    law = motor.get("law") or {}
    if motor.get("mode") not in ("speed", "angle", "position") or not law:
        return None
    if law.get("type") == "constant":
        v = law["value"]
    elif law.get("type") == "table":
        v = law["points"][-1][1]
    elif law.get("type") == "ramp":
        v = law.get("slope", 0)
    else:
        return None
    # Laws are in degrees for rotation and mm for translation
    return math.radians(v) if rotational else v


def velocities(asm, J, M, motor_ids, ref):
    """Each group's velocity for the motors at their rates (least squares): ω (rad/s) and the speed of its centre"""
    motors = {m["id"]: m for m in asm.model["motors"]}
    jtype = {j["id"]: j["type"] for j in asm.model["joints"]}
    rates = [motor_rate(motors[mid], jtype.get(motors[mid]["joint"]) in ("revolute", "cylindrical")) for mid in motor_ids]
    if not motor_ids or any(v is None for v in rates):
        return None
    A = np.vstack([J, M])
    b = np.concatenate([np.zeros(J.shape[0]), rates])
    v, *_ = np.linalg.lstsq(A, b, rcond=None)
    out = {}
    for g, i in asm.index.items():
        w, lin = v[6 * i + 3:6 * i + 6], v[6 * i:6 * i + 3]
        out[g] = {"omega_rad_s": w.tolist(), "omega_rpm": float(np.linalg.norm(w) * 60 / (2 * math.pi)),
                  "speed_mm_s": float(np.linalg.norm(lin)), "moved": bool(np.linalg.norm(w) > 1e-9 or np.linalg.norm(lin) > 1e-9)}
    return out


def sweep(asm, motor_id, total, steps=72):
    """Positions over the motor's travel (rad or mm, from t = 0): the kinematic prediction. Returns the samples
    [{"motor": value, "joints": {joint id: coordinate}, "groups": {group: [x, y, z] centre}}] or raises ValueError
    when the equations cannot be solved (a linkage that cannot go further)"""
    n = 6 * len(asm.moving)
    ref = asm.apply(np.zeros(n))
    fn, _ = asm.joint_system(ref)
    joints = {j["id"]: (j, a, b) for j, a, b in asm.joints}
    motor = next(m for m in asm.model["motors"] if m["id"] == motor_id)
    mj, ma, mb = joints[motor["joint"]]
    poses = ref
    out = []
    step = total / steps
    for k in range(steps + 1):
        if k:
            # Newton: joint residuals (frames fixed in groups at t = 0) and the motor's increment this step
            q = np.zeros(n)
            for _ in range(30):
                cur = asm.apply(q, poses)
                rows = []
                for j, a, b in asm.joints:
                    rows += asm.joint_rows(j, a, b, cur, ref)
                rows += asm.gear_rows(q)[0]
                mrow = asm.motor_rows(q, cur, poses)
                rows.append(mrow[0][mrow[1].index(motor_id)] - step)
                r_vec = np.asarray(rows)
                if np.max(np.abs(r_vec)) < 1e-10:
                    break
                Jq = np.zeros((len(rows), n))
                for c in range(n):
                    dq = np.zeros(n)
                    dq[c] = 1e-7
                    cur2 = asm.apply(q + dq, poses)
                    rr = []
                    for j, a, b in asm.joints:
                        rr += asm.joint_rows(j, a, b, cur2, ref)
                    rr += asm.gear_rows(q + dq)[0]
                    mr = asm.motor_rows(q + dq, cur2, poses)
                    rr.append(mr[0][mr[1].index(motor_id)] - step)
                    Jq[:, c] = (np.asarray(rr) - r_vec) / 1e-7
                q = q - np.linalg.lstsq(Jq, r_vec, rcond=None)[0]
            if np.max(np.abs(r_vec)) > 1e-6:
                raise ValueError(f"Không giải được vị trí ở bước {k} (động cơ {motor_id} = {k * step:.4g}): cơ cấu kẹt hoặc vượt hành trình.")
            poses = asm.apply(q, poses)
        coords = {}
        for j, a, b in asm.joints:
            if j["type"] in ("prismatic", "cylindrical"):
                f = asm.frame(j)
                pa, pb = asm.world(poses, a, f["p"], ref), asm.world(poses, b, f["p"], ref)
                coords[j["id"]] = float(np.dot(pb - pa, asm.wdir(poses, a, f["z"], ref)))
        out.append({"motor": k * step, "joints": coords,
                    "groups": {g: poses[g][1].tolist() for g in asm.moving}})
    return out


# ---------- geometry checks ----------

def geometry_checks(asm):
    """Joints near both parts, revolute axes along shafts and gears, gear centre distances, overlaps at t = 0"""
    import trimesh

    diags = []
    for j in asm.model["joints"]:
        if j["type"] == "distance" or j.get("position") is None:
            continue
        p = np.asarray(j["position"])
        for pid in (j["part_a"], j["part_b"]):
            mesh = asm.placed[pid]["mesh"]
            if mesh is None or asm.placed[pid]["part"]["role"] in ("ground", "housing", "frame"):
                continue
            # The joint point on or inside the part, or within its hole: up to the part's own radius away
            d = float(trimesh.proximity.closest_point(mesh, [p])[1][0])
            if d > max(GEOM_TOL_MM, 0.5 * float(min(mesh.extents))):
                diags.append(diag("warning", "JOINT_AWAY_FROM_PART",
                                  f"Khớp {j['id']} ở cách {pid} {d:.3g} mm: kiểm tra vị trí khớp.", [pid], [j["id"]]))
        if j["type"] in ("revolute", "cylindrical"):
            n = np.asarray(j["axis"])
            for pid in (j["part_a"], j["part_b"]):
                part = asm.placed[pid]
                shape = part["part"].get("shape") or {}
                if shape.get("type") == "link" and shape.get("hole_diameter"):
                    # A link turns about one of its holes: the joint must be on a hole's axis
                    local = part["R"].T @ (p - part["pos"])
                    off = min(math.hypot(local[0] - x, local[1]) for x in (0.0, shape["length"]))
                    axis_ok = abs(abs(float(np.dot(part["R"] @ shapes.AXES["z"], n))) - 1) < 1e-4
                    if off > 0.1 or not axis_ok:
                        diags.append(diag("error", "JOINT_NOT_AT_HOLE",
                                          f"Khớp {j['id']} cách tâm lỗ gần nhất của {pid} {off:.3g} mm"
                                          + ("" if axis_ok else ", trục không song song trục lỗ") + ".",
                                          [pid], [j["id"]], "Đặt khớp đúng tâm lỗ của thanh."))
                if shape.get("type") in ("shaft", "gear"):
                    sa = part["R"] @ shapes.AXES[shape["axis"]]
                    angle = math.degrees(math.acos(min(1.0, abs(float(np.dot(sa, n))))))
                    offset = float(np.linalg.norm(np.cross(part["pos"] - p, n)))
                    if angle > 0.5 or offset > GEOM_TOL_MM:
                        diags.append(diag("error", "AXIS_MISALIGNED",
                                          f"Trục khớp {j['id']} lệch trục {pid} {angle:.2g}° và {offset:.3g} mm.",
                                          [pid], [j["id"]], "Đặt vị trí/trục khớp đúng tâm và trục của chi tiết."))
    for g in asm.model["gears"]:
        pa, pb = asm.placed.get(g["gear_a"]), asm.placed.get(g["gear_b"])
        sa, sb = (pa or {}).get("part", {}).get("shape") or {}, (pb or {}).get("part", {}).get("shape") or {}
        meta = asm.gear_meta(g)
        if meta is None:
            diags.append(diag("error", "GEAR_NO_COMMON_CARRIER",
                              f"Cặp bánh răng {g['id']}: hai bánh không cùng quay (revolute) trên một chi tiết đỡ chung với trục song song.",
                              [g["gear_a"], g["gear_b"]], [g["id"]], "Thêm khớp revolute của mỗi trục với vỏ/khung."))
            continue
        if sa.get("type") == "gear" and sb.get("type") == "gear":
            if abs(sa["module"] - sb["module"]) > 1e-9:
                diags.append(diag("error", "GEAR_MODULE_MISMATCH", f"{g['id']}: module {sa['module']} ≠ {sb['module']}.",
                                  [g["gear_a"], g["gear_b"]], [g["id"]]))
            n = meta[3]
            d = pb["pos"] - pa["pos"]
            dist = float(np.linalg.norm(d - np.dot(d, n) * n))
            want = abs(sb["pitch_radius"] + (-1 if g["internal"] else 1) * sa["pitch_radius"])
            if abs(dist - want) > 1e-3 + 1e-3 * want:
                diags.append(diag("error", "GEAR_CENTER_DISTANCE",
                                  f"{g['id']}: khoảng cách tâm {dist:.4g} mm ≠ m(z1 ± z2)/2 = {want:.4g} mm: không ăn khớp.",
                                  [g["gear_a"], g["gear_b"]], [g["id"]], f"Dời trục để khoảng cách tâm là {want:.4g} mm."))
            else:
                diags.append(diag("info", "GEAR_MESH_OK",
                                  f"{g['id']}: module {sa['module']:g}, {sa['teeth']}/{sb['teeth']} răng, khoảng cách tâm {dist:.4g} mm, tỉ số {sb['teeth'] / sa['teeth']:.4g}.",
                                  [g["gear_a"], g["gear_b"]], [g["id"]]))
    # Overlaps between parts of different groups that are not joined to each other (a pin in its hole is joined)
    joined = {frozenset((asm.group_of[j["part_a"]], asm.group_of[j["part_b"]])) for j in asm.model["joints"]}
    joined |= {frozenset((asm.group_of[g["gear_a"]], asm.group_of[g["gear_b"]])) for g in asm.model["gears"]}
    ids = [p for p in asm.placed if asm.placed[p]["mesh"] is not None]
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            ga, gb = asm.group_of[a], asm.group_of[b]
            if ga == gb or frozenset((ga, gb)) in joined:
                continue
            ma, mb = asm.placed[a]["mesh"], asm.placed[b]["mesh"]
            if np.any(np.maximum(ma.bounds[0], mb.bounds[0]) > np.minimum(ma.bounds[1], mb.bounds[1])):
                continue
            if not (ma.is_watertight and mb.is_watertight):
                continue
            inter = trimesh.boolean.intersection([ma, mb], engine="manifold")
            vol = float(inter.volume) if len(inter.faces) else 0.0
            if vol > 1.0:
                diags.append(diag("error", "PARTS_OVERLAP", f"{a} và {b} chồng lên nhau {vol:.4g} mm³ lúc t = 0.", [a, b], (),
                                  "Dời một chi tiết hoặc kiểm tra kích thước."))
    return diags
