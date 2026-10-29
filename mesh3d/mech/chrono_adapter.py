"""
The mechanical model → the mechanism format of sim/ (schema v1), which the existing Chrono pipeline runs (offline
runs, Blender playback, live sessions). Nothing about Chrono is redone here.

- Each rigid group is one body, in the assembly frame at t = 0 (position 0, no rotation), with the group's mass,
  centre of mass and inertia (world axes) given explicitly, and a mesh of its parts for Blender and the viewer
  (written under the sim worker's files/, the model's own geometry is not touched).
- Joints between groups map one to one. A revolute joint a gear turns on is written with its carrier as body_a, as
  sim's gear joint needs.
- Gear pairs become sim gear joints (ideal, or tooth contact with the data given); motors, rotational/linear motors
  on their joint; loads keep their type, on the body of their part.

CAPABILITIES says what each feature maps to; a model using something marked unsupported is refused before any run,
with the reason, rather than simulated without it.
"""

import numpy as np

from .kinematics import diag

CAPABILITIES = {
    "joint.fixed": ("supported", "Gộp các chi tiết thành một vật rắn"),
    "joint.revolute": ("supported", "ChLinkLockRevolute"),
    "joint.prismatic": ("supported", "ChLinkLockPrismatic"),
    "joint.cylindrical": ("supported", "ChLinkLockCylindrical"),
    "joint.spherical": ("supported", "ChLinkLockSpherical"),
    "joint.distance": ("supported", "ChLinkDistance"),
    "joint.planar": ("unsupported", "Chrono có ChLinkLockPlanar nhưng định dạng cơ cấu sim chưa nối: chưa mô phỏng được"),
    "gear.ideal": ("supported", "ChLinkLockGear (ràng buộc lý tưởng, không có răng)"),
    "gear.contact": ("supported", "Mô hình ăn khớp theo đường ăn khớp (khe hở, độ cứng, ma sát)"),
    "gear.internal_contact": ("unsupported", "Răng tiếp xúc cho cặp ăn khớp trong chưa có"),
    "belt": ("unsupported", "Chrono có ChLinkLockPulley nhưng chưa nối"),
    "motor.rotational": ("supported", "ChLinkMotorRotation{Angle,Speed,Torque}"),
    "motor.linear": ("supported", "ChLinkMotorLinear{Position,Speed,Force}"),
    "load.force": ("supported", "ChLoadBodyForce"),
    "load.torque": ("supported", "ChLoadBodyTorque"),
    "load.spring_damper": ("supported", "ChLinkTSDA"),
    "load.rotational_spring_damper": ("supported", "ChLinkRSDA"),
    "analysis.kinematic": ("supported", "Lời giải vị trí/vận tốc từ ràng buộc (mech/kinematics.py), không cần solver"),
    "analysis.rigid_body_dynamics": ("supported", "Chrono NSC/SMC"),
    "analysis.contact_dynamics": ("supported", "Chrono NSC/SMC, va chạm bằng bao lồi của lưới"),
    "analysis.flexible_body": ("unsupported", "Chưa có vật đàn hồi (FEA trong vòng lặp)"),
    "analysis.stress": ("separate", "FEA tĩnh một chi tiết: configure_fea_analysis (gmsh + CalculiX), không từ mô phỏng vật rắn"),
    "analysis.thermal_fluid": ("unsupported", "Không có"),
}

COLORS = {"ground": "#5A6270", "housing": "#5A6270", "frame": "#5A6270", "shaft": "#9AA5B1", "gear": "#E4572E",
          "crank": "#F3A712", "rod": "#29335C", "link": "#29335C", "slider": "#669BBC", "rocker": "#A8C686"}
# Parts whose role has no colour: one each, so neighbours stay apart in the viewer
PALETTE = ("#E4572E", "#3B82F6", "#10B981", "#8B5CF6", "#EC4899", "#14B8A6", "#F59E0B")


def colours(parts):
    """{part id: colour}: by role, fixed parts grey; a role's second part (two gears) and parts with no role colour
    take the palette, so parts that touch are told apart"""
    out, taken = {}, set()
    for k, part in enumerate(parts):
        role = COLORS.get(part["role"])
        if part["fixed"]:
            out[part["id"]] = COLORS["frame"]
        elif role and part["role"] not in taken:
            out[part["id"]] = role
        else:
            out[part["id"]] = PALETTE[k % len(PALETTE)]
        taken.add(part["role"])
    return out


def capability_check(model):
    """What the model uses that the solver cannot run: diagnostics, empty when all of it maps"""
    out = []
    for j in model["joints"]:
        state, why = CAPABILITIES.get(f"joint.{j['type']}", ("unsupported", "Không biết"))
        if state != "supported":
            out.append(diag("error", "UNSUPPORTED_JOINT", f"Khớp {j['id']} ({j['type']}): {why}.", [j["part_a"], j["part_b"]],
                            [j["id"]], "Thay bằng khớp được hỗ trợ (vd. hai khớp prismatic + một revolute)."))
    for g in model["gears"]:
        if g["model"] == "contact" and g["internal"]:
            out.append(diag("error", "UNSUPPORTED_GEAR", f"{g['id']}: {CAPABILITIES['gear.internal_contact'][1]}.",
                            [g["gear_a"], g["gear_b"]], [g["id"]], 'Dùng model "ideal".'))
    return out


def compile_model(asm, files_dir, files_prefix):
    """(sim mechanism, mapping): the model as sim's schema v1; meshes written to `files_dir`, named
    `files_prefix`/<group>.stl as sim resolves them"""
    import trimesh

    model = asm.model
    files_dir.mkdir(parents=True, exist_ok=True)
    bodies, mapping = [], {"parts": {}, "joints": {}, "gears": {}, "motors": {}, "loads": {}, "bodies": {}}
    colliding = False
    painted = colours(model["parts"])
    for g, parts in asm.members.items():
        meshes = [asm.placed[p]["mesh"] for p in parts if asm.placed[p]["mesh"] is not None]
        body = {"id": g, "name": " + ".join(asm.placed[p]["part"]["name"] for p in parts), "position": [0, 0, 0]}
        if meshes:
            path = files_dir / f"{g.replace('+', '_')}.stl"
            trimesh.util.concatenate(meshes).export(path)
            body["visual"] = {"mesh_file": f"{files_prefix}/{path.name}",
                              "color": painted[parts[0]], "parts": []}
            # Each part its own mesh too, so a viewer shows and picks the components the user made
            for p in parts:
                mesh = asm.placed[p]["mesh"]
                if mesh is not None:
                    part_path = files_dir / f"part_{p}.stl"
                    mesh.export(part_path)
                    body["visual"]["parts"].append({"id": p, "name": asm.placed[p]["part"]["name"],
                                                    "mesh_file": f"{files_prefix}/{part_path.name}",
                                                    "color": painted[p]})
        # Contact: the convex hull of the group's colliding parts, computed here (the live container has no trimesh)
        hits = [p for p in parts if asm.placed[p]["part"].get("collision") and asm.placed[p]["mesh"] is not None]
        if hits:
            colliding = True
            hull_path = files_dir / f"{g.replace('+', '_')}_collision.stl"
            hull = trimesh.util.concatenate([asm.placed[p]["mesh"] for p in hits]).convex_hull
            hull.export(hull_path)
            frictions = sorted({asm.placed[p]["part"]["friction"]["value"] for p in hits})
            body.update(collision=True, geometry={"type": "mesh", "file": f"{files_prefix}/{hull_path.name}"},
                        collision_hull=np.asarray(hull.vertices, float).tolist(),
                        material={"friction": frictions[0]})
            if len(frictions) > 1:
                mapping.setdefault("assumptions", []).append({
                    "path": f"bodies.{g}.material.friction",
                    "message": f"Các chi tiết của {g} có ma sát {frictions}: dùng {frictions[0]} (nhỏ nhất) cho cả nhóm."})
        if g == "ground":
            body["fixed"] = True
        else:
            m, com, inertia = asm.mass[g]
            body.update(mass=m, center_of_mass=np.asarray(com).tolist(),
                        inertia={"ixx": inertia[0][0], "iyy": inertia[1][1], "izz": inertia[2][2],
                                 "ixy": inertia[0][1], "ixz": inertia[0][2], "iyz": inertia[1][2]})
        bodies.append(body)
        mapping["bodies"][g] = parts
        for p in parts:
            mapping["parts"][p] = g
    gear_shafts = {jid for pair in asm.gear_joints.values() for jid in pair}
    carrier_of = {}
    for gid, (ja, jb) in asm.gear_joints.items():
        meta = asm.gear_meta(next(g for g in model["gears"] if g["id"] == gid))
        carrier_of[ja] = carrier_of[jb] = meta[2]
    joints = []
    for j, ga, gb in asm.joints:
        a, b = ga, gb
        if j["id"] in gear_shafts and a != carrier_of[j["id"]]:
            a, b = b, a  # sim's gear joint wants the carrier as body_a
        out = {"id": j["id"], "type": j["type"], "body_a": a, "body_b": b}
        if j["type"] == "distance":
            out.update(point_a=j["point_a"], point_b=j["point_b"])
        else:
            out.update(position=j["position"], axis=j["axis"])
        if j.get("limits"):
            out["limits"] = j["limits"]
        joints.append(out)
        mapping["joints"][j["id"]] = {"sim_joint": j["id"], "body_a": a, "body_b": b, "flipped": (a, b) != (ga, gb)}
    for g in model["gears"]:
        if g["id"] not in asm.gear_joints:
            continue
        ja, jb = asm.gear_joints[g["id"]]
        out = {"id": g["id"], "type": "gear", "joint_a": ja, "joint_b": jb, "teeth_a": g["teeth_a"], "teeth_b": g["teeth_b"],
               "internal": g["internal"], "model": g["model"]}
        for key in ("backlash", "friction", "mesh_stiffness_N_per_m", "young_modulus_Pa", "pressure_angle", "damping_ratio"):
            if key in g:
                out[key] = g[key]
        joints.append(out)
        mapping["gears"][g["id"]] = {"sim_joint": g["id"], "shaft_joints": [ja, jb]}
    jmap = {j["id"]: j for j in joints}
    actuators = []
    for mo in model["motors"]:
        j = jmap.get(mo["joint"])
        if j is None:
            continue
        rotational = j["type"] in ("revolute", "cylindrical")
        law = mo["law"]
        flipped = mapping["joints"][mo["joint"]]["flipped"]
        actuators.append({"id": mo["id"], "type": "rotational_motor" if rotational else "linear_actuator", "mode": mo["mode"],
                          # The motor moves the user's part_b relative to part_a: the joint's own direction
                          "body_a": j["body_b"] if flipped else j["body_a"], "body_b": j["body_a"] if flipped else j["body_b"],
                          "position": j["position"], "axis": j["axis"], "law": law})
        mapping["motors"][mo["id"]] = {"sim_actuator": mo["id"], "joint": mo["joint"]}
    forces = []
    for load in model["loads"]:
        out = {k: v for k, v in load.items() if k not in ("part", "part_a", "part_b")}
        if "part" in load:
            out["body"] = asm.group_of[load["part"]]
        if "part_a" in load:
            out["body_a"], out["body_b"] = asm.group_of[load["part_a"]], asm.group_of[load["part_b"]]
        forces.append(out)
        mapping["loads"][load["id"]] = {"sim_force": load["id"]}
    mechanism = {"schema_version": 1, "name": model["name"], "units": {"length": "mm", "mass": "kg", "angle": "deg"},
                 "bodies": bodies, "joints": joints, "actuators": actuators, "forces": forces,
                 "simulation": model["simulation"]}
    if colliding and "collision" not in model["simulation"]:
        mechanism["simulation"] = {**model["simulation"], "collision": {"enabled": True}}
    return mechanism, mapping
