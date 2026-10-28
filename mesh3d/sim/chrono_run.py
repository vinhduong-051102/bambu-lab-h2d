"""
One simulation in Project Chrono (PyChrono 10.0.0), run in Chrono's own Python (/opt/chrono, see the Dockerfile):

    /opt/chrono/bin/python /opt/mesh3d/sim/chrono_run.py <run folder>

Reads model.json (the SI mechanism schema.normalise() wrote) and writes, in that folder:
- body_transforms.csv: every output time, every body: its own frame (position, quaternion w-x-y-z), the velocity
  and acceleration of that frame's origin, and its angular velocity and acceleration, all in the world
- joint_results.csv: every output time, every joint, actuator and spring: its coordinate (angle or position, 0 at
  t = 0, angles continuous past ±π) and rate, the reaction force and torque on body_b in the joint's frame (Z = the joint axis), the motor torque/force
  or spring force, and the largest constraint violation
- contacts.csv (with collision on): every output time, every colliding body: the total contact force and torque on
  it in the world, and how many contacts the system has
- engine.json: the engine version, the assembly result, timings, the largest violation and the checks against
  theory (summary.json is built from it by runs.py)
- simulation.log

Progress goes to stdout as "PROGRESS <0..1>" lines; a run that fails exits non-zero with the reason in the log and
engine.json. Chrono's frame conventions used here (checked against 10.0.0): Initialize(body1, body2, frame) moves
body1 relative to body2 and acts along the frame's Z axis (revolute, prismatic, motors, RSDA); a ChBodyAuxRef's
own frame is its centre of mass, its "Ref" frame the frame its geometry is drawn in.
"""

import csv
import json
import logging
import math
import sys
import time
from pathlib import Path

import numpy as np
import pychrono as ch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from sim import schema  # noqa: E402 - the same laws and rotations the checks were written with

log = logging.getLogger("chrono_run")


def V(v):
    return ch.ChVector3d(float(v[0]), float(v[1]), float(v[2]))


def Q(q):
    return ch.ChQuaterniond(float(q[0]), float(q[1]), float(q[2]), float(q[3]))


def vec(v):
    return [v.x, v.y, v.z]


def quat(q):
    return [q.e0, q.e1, q.e2, q.e3]


def engine_version():
    try:
        from importlib.metadata import version

        return version("pychrono")
    except Exception:  # noqa: BLE001 - conda installs it without metadata
        meta = sorted(Path(sys.prefix, "conda-meta").glob("pychrono-*.json"))
        return json.loads(meta[-1].read_text())["version"] if meta else "unknown"


def function(law):
    """A schema law (SI) as a Chrono function of time"""
    kind = law["type"]
    if kind == "constant":
        return ch.ChFunctionConst(law["value"])
    if kind == "ramp":
        return ch.ChFunctionRamp(law["start"], law["slope"])
    if kind == "sine":
        # ChFunctionSine(amplitude, frequency in Hz, phase, shift): shift + A sin(2π f t + phase), checked
        return ch.ChFunctionSine(law["amplitude"], law["frequency_hz"], law["phase"], law["offset"])
    f = ch.ChFunctionInterp()
    for t, v in law["points"]:
        f.AddPoint(t, v)
    # Held at the last value after the last point, as schema.law_value
    f.SetExtrapolate(False)
    return f


def world_frame(position, axis):
    """A joint's frame in the world: at `position`, its Z along `axis`"""
    return ch.ChFramed(V(position), Q(schema.quat_z_to(np.asarray(axis, float))))


def com_frame(body):
    """A body's centre-of-mass frame in the world, as a plain frame"""
    frame = body.GetFrameCOMToAbs()
    return ch.ChFramed(frame.GetPos(), frame.GetRot())


class Model:
    """The Chrono system built from model.json, and what to record of it"""

    def __init__(self, model):
        self.model = model
        sim = model["simulation"]
        collision = sim["collision"]
        self.contacts = collision["enabled"]
        self.smc = self.contacts and collision["method"] == "smc"
        # SMC: contacts are stiff springs (Hertz, from each material's E and ν); NSC: rigid, complementarity
        self.system = ch.ChSystemSMC() if self.smc else ch.ChSystemNSC()
        self.system.SetGravitationalAcceleration(V(sim["gravity"]))
        self.keep = []  # Python owns these wrappers: kept alive for the run
        self.bodies, self.links, self.forces, self.meshes = {}, [], [], []
        if self.contacts:
            self.system.SetCollisionSystemType(ch.ChCollisionSystem.Type_BULLET)
            # Read when a shape is added: Chrono's defaults are for metre-sized bodies
            ch.ChCollisionModel.SetDefaultSuggestedEnvelope(collision["envelope"])
            ch.ChCollisionModel.SetDefaultSuggestedMargin(collision["margin"])
        self.solver(sim)
        for b in model["bodies"]:
            self.add_body(b)
        for j in model["joints"]:
            self.add_joint(j)
        for a in model["actuators"]:
            self.add_actuator(a)
        self.loads = ch.ChLoadContainer()
        self.system.Add(self.loads)
        for f in model["forces"]:
            self.add_force(f)

    def solver(self, sim):
        types = {"psor": ch.ChSolver.Type_PSOR, "apgd": ch.ChSolver.Type_APGD,
                 "barzilai_borwein": ch.ChSolver.Type_BARZILAIBORWEIN, "minres": ch.ChSolver.Type_MINRES}
        if sim["solver"] != "default":
            self.system.SetSolverType(types[sim["solver"]])
        steppers = {"euler_implicit_linearized": ch.ChTimestepper.Type_EULER_IMPLICIT_LINEARIZED,
                    "euler_implicit_projected": ch.ChTimestepper.Type_EULER_IMPLICIT_PROJECTED,
                    "hht": ch.ChTimestepper.Type_HHT}
        if sim["integrator"] != "default":
            self.system.SetTimestepperType(steppers[sim["integrator"]])
        iterative = self.system.GetSolver().AsIterative()
        if iterative is not None:
            if sim.get("max_iterations"):
                iterative.SetMaxIterations(int(sim["max_iterations"]))
            if sim.get("tolerance"):
                iterative.SetTolerance(sim["tolerance"])

    def add_body(self, b):
        body = ch.ChBodyAuxRef()
        body.SetName(b["id"])
        body.SetFrameRefToAbs(ch.ChFramed(V(b["position"]), Q(b["orientation"])))
        if b["fixed"]:
            body.SetFixed(True)
        else:
            body.SetMass(b["mass"])
            # The centre of mass in the body's own frame; its axes the body's, so the inertia is in them too
            body.SetFrameCOMToRef(ch.ChFramed(V(b["com"]), ch.QUNIT))
            inertia = b["inertia"]
            body.SetInertiaXX(V([inertia[0][0], inertia[1][1], inertia[2][2]]))
            body.SetInertiaXY(V([inertia[0][1], inertia[0][2], inertia[1][2]]))
        if self.contacts and b["collision"]:
            self.add_collision(body, b)
        self.system.Add(body)
        self.bodies[b["id"]] = body

    def add_collision(self, body, b):
        spec = b["material"]
        if self.smc:
            material = ch.ChContactMaterialSMC()
            material.SetYoungModulus(spec["young_modulus"])
            material.SetPoissonRatio(spec["poisson_ratio"])
        else:
            material = ch.ChContactMaterialNSC()
        material.SetFriction(spec["friction"])
        material.SetRestitution(spec["restitution"] or 0.0)
        g = b["geometry"]
        # Shapes in the body's own (Ref) frame
        if g["type"] == "box":
            shape, frame = ch.ChCollisionShapeBox(material, *g["size"]), ch.ChFramed()
        elif g["type"] == "sphere":
            shape, frame = ch.ChCollisionShapeSphere(material, g["radius"]), ch.ChFramed()
        elif g["type"] == "cylinder":
            # Chrono's cylinder lies along Z
            axis = {"x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1]}[g["axis"]]
            shape = ch.ChCollisionShapeCylinder(material, g["radius"], g["length"])
            frame = ch.ChFramed(ch.VNULL, Q(schema.quat_z_to(np.array(axis, float))))
        else:
            points = ch.vector_ChVector3d()
            for p in b["hull_points"]:
                points.push_back(V(p))
            shape, frame = ch.ChCollisionShapeConvexHull(material, points), ch.ChFramed()
        self.keep += [material, shape]
        body.AddCollisionShape(shape, frame)
        body.EnableCollision(True)

    def add_joint(self, j):
        kind = j["type"]
        if kind == "gear":
            return self.add_gear(j)
        b, a = self.bodies[j["body_b"]], self.bodies[j["body_a"]]
        if kind == "distance":
            link = ch.ChLinkDistance()
            link.Initialize(b, a, False, V(j["point_b"]), V(j["point_a"]), True)
        else:
            link = {"fixed": ch.ChLinkLockLock, "revolute": ch.ChLinkLockRevolute,
                    "prismatic": ch.ChLinkLockPrismatic, "spherical": ch.ChLinkLockSpherical,
                    "cylindrical": ch.ChLinkLockCylindrical}[kind]()
            link.Initialize(b, a, world_frame(j["position"], j["axis"]))
            limits = j.get("limits")
            if limits:
                limit = link.LimitRz() if kind == "revolute" else link.LimitZ()
                limit.SetActive(True)
                limit.SetMin(limits["min"])
                limit.SetMax(limits["max"])
        link.SetName(j["id"])
        self.system.Add(link)
        self.links.append((j, link))

    def add_gear(self, j):
        """A gear pair: teeth in contact (GearContact), or an ideal one"""
        if j.get("model") == "contact":
            joints = {x["id"]: x for x in self.model["joints"]}
            links = {item["id"]: link for item, link in self.links}
            mesh = GearContact(j, self.bodies, joints, links)
            self.meshes.append(mesh)
            self.links.append((j, mesh))
            return None
        return self.add_ideal_gear(j)

    def add_ideal_gear(self, j):
        """An ideal gear pair (ChLinkLockGear): no teeth, no backlash, no friction. Each shaft's frame sits on its gear
        at its revolute joint, Z along the first joint's axis; Chrono takes the radii from the distance between the
        shafts and the ratio N_a/N_b, and turns the gears opposite ways unless the pair is internal (epicyclic)"""
        joints = {x["id"]: x for x in self.model["joints"]}
        ja, jb = joints[j["joint_a"]], joints[j["joint_b"]]
        ga, gb = self.bodies[j["body_a"]], self.bodies[j["body_b"]]
        link = ch.ChLinkLockGear()
        link.Initialize(ga, gb, ch.ChFramed())
        axis = ja["axis"]
        # Shaft frames relative to each body's own (centre of mass) frame
        link.SetFrameShaft1(com_frame(ga).TransformParentToLocal(world_frame(ja["position"], axis)))
        link.SetFrameShaft2(com_frame(gb).TransformParentToLocal(world_frame(jb["position"], axis)))
        link.SetTransmissionRatio(j["teeth_a"] / j["teeth_b"])
        link.SetEpicyclic(j["internal"])
        link.SetEnforcePhase(True)
        link.SetName(j["id"])
        self.system.Add(link)
        self.links.append((j, link))

    def add_actuator(self, a):
        b, base = self.bodies[a["body_b"]], self.bodies[a["body_a"]]
        rotational = a["type"] == "rotational_motor"
        if rotational:
            motor = {"angle": ch.ChLinkMotorRotationAngle, "speed": ch.ChLinkMotorRotationSpeed,
                     "torque": ch.ChLinkMotorRotationTorque}[a["mode"]]()
        else:
            motor = {"position": ch.ChLinkMotorLinearPosition, "speed": ch.ChLinkMotorLinearSpeed,
                     "force": ch.ChLinkMotorLinearForce}[a["mode"]]()
        motor.Initialize(b, base, world_frame(a["position"], a["axis"]))
        if not a["guide_constraint"]:
            # A joint on the same pair already guides it: the motor only drives its own coordinate
            if rotational:
                motor.SetSpindleConstraint(ch.ChLinkMotorRotation.SpindleConstraint_FREE)
            else:
                motor.SetGuideConstraint(ch.ChLinkMotorLinear.GuideConstraint_FREE)
        motor.SetMotorFunction(function(a["law"]))
        motor.SetName(a["id"])
        self.system.Add(motor)
        self.links.append((a, motor))

    def add_force(self, f):
        kind = f["type"]
        if kind in ("force", "torque"):
            body = self.bodies[f["body"]]
            spec = next(b for b in self.model["bodies"] if b["id"] == f["body"])
            local = f["frame"] == "body"
            if kind == "force":
                # The point is in the body's own frame; Chrono wants it from the centre of mass
                point = np.asarray(f["point"]) - np.asarray(spec["com"] or [0, 0, 0])
                load = ch.ChLoadBodyForce(body, V(f["direction"]), local, V(point), True)
            else:
                load = ch.ChLoadBodyTorque(body, V(f["direction"]), local)
            # The vector is the unit direction; the law, its magnitude over time
            modulation = function(f["law"])
            load.SetModulationFunction(modulation)
            self.keep.append(modulation)
            self.loads.Add(load)
            self.forces.append((f, load))
            return
        b, a = self.bodies[f["body_b"]], self.bodies[f["body_a"]]
        if kind == "spring_damper":
            link = ch.ChLinkTSDA()
            link.Initialize(b, a, False, V(f["point_b"]), V(f["point_a"]))
            rest = f["rest_length"]
            if rest is None:
                rest = float(np.linalg.norm(np.subtract(f["point_b"], f["point_a"])))
            link.SetRestLength(rest)
        else:
            link = ch.ChLinkRSDA()
            link.Initialize(b, a, world_frame(f["position"], f["axis"]))
            link.SetRestAngle(f["rest_angle"])
        link.SetSpringCoefficient(f["stiffness"])
        link.SetDampingCoefficient(f["damping"])
        link.SetName(f["id"])
        self.system.Add(link)
        self.links.append((f, link))


class GearContact:
    """Two involute spur gears whose teeth push along the line of action (schema.gear_mesh): the standard lumped
    mesh model of gear dynamics. Each step, before Chrono integrates, it reads both gears' angles on their revolute
    joints and applies the tooth forces as a torque on each gear and the separating force at each bearing:
    - δ = r_ba·φ_a - r_bb·φ_b, the base-circle travel of a ahead of b (φ_b turning the opposite way, as meshing
      gears do), with the teeth centred in their backlash at t = 0
    - no force while |δ| < j_n/2 (the backlash along the line of action); beyond it each tooth pair in contact pushes
      k·(|δ| - j_n/2) + c·δ̇, the pairs spaced a base pitch apart on the stretch x_start…x_end, so the mesh
      stiffens where two pairs touch
    - Coulomb friction μ·F on each pair against its sliding speed ω_a·x - ω_b·(L - x) (zero at the pitch point),
      smoothed over 0.1 mm/s, as torques
    The drive flank carries the load when a leads (δ > 0), the coast flank when b does."""

    SLIP = 1e-4

    def __init__(self, j, bodies, joints, links):
        self.item, self.mesh = j, j["mesh"]
        ja, jb = joints[j["joint_a"]], joints[j["joint_b"]]
        self.axis = np.asarray(ja["axis"], float)
        # Each gear's angle about the axis, from its own revolute joint (whose axis may point the other way)
        self.joints = [(links[ja["id"]], float(np.sign(np.dot(ja["axis"], self.axis)))),
                       (links[jb["id"]], float(np.sign(np.dot(jb["axis"], self.axis))))]
        self.gears = [bodies[j["body_a"]], bodies[j["body_b"]]]
        # The bearing points in each gear's centre-of-mass frame, followed as the gears move
        self.centres = [com_frame(body).TransformPointParentToLocal(V(joint["position"]))
                        for body, joint in zip(self.gears, (ja, jb))]
        self.slots = [body.AddAccumulator() for body in self.gears]
        self.unwrapped = [0.0, 0.0]
        self.state = {"delta": 0.0, "rate": 0.0, "force": 0.0, "pairs": 0, "f_b": np.zeros(3), "t_b": 0.0}
        self.work = {"a": 0.0, "b": 0.0, "time_in_contact": 0.0, "drive": 0.0, "coast": 0.0}

    def angles(self):
        """(θ, ω) of both gears about the axis, relative to their carrier, θ continuous"""
        out = []
        for i, (link, sign) in enumerate(self.joints):
            raw = sign * link.GetRelAngleAxis().z
            prev = self.unwrapped[i]
            value = prev + (raw - prev + math.pi) % (2 * math.pi) - math.pi
            self.unwrapped[i] = value
            out.append((value, sign * link.GetRelativeAngVel().z))
        return out

    def apply(self, dt):
        m = self.mesh
        (theta_a, w_a), (theta_b, w_b) = self.angles()
        # φ_b: gear b's turning in the meshing sense (opposite to a)
        phi_a, phi_b, rate_a, rate_b = theta_a, -theta_b, w_a, -w_b
        delta = m["rb_a"] * phi_a - m["rb_b"] * phi_b
        rate = m["rb_a"] * rate_a - m["rb_b"] * rate_b
        side = 1.0 if delta >= 0 else -1.0
        squeeze = abs(delta) - m["backlash_normal"] / 2
        for body, slot in zip(self.gears, self.slots):
            body.EmptyAccumulator(slot)
        q_a = q_b = force = 0.0
        pairs = 0
        if squeeze > 0:
            # The pairs in contact: one at the pitch point at t = 0, then moving with gear a
            span, pitch = m["x_end"] - m["x_start"], m["base_pitch"]
            first = m["x_start"] + (m["x_pitch"] - m["x_start"] + side * m["rb_a"] * phi_a) % pitch
            per_pair = max(0.0, m["stiffness"] * squeeze + m["damping"] * rate * side)
            x = first
            while x <= m["x_start"] + span + 1e-15:
                pairs += 1
                slide = rate_a * x - rate_b * (m["length"] - x)
                friction = m["friction"] * per_pair * math.tanh(slide / self.SLIP)
                q_a -= friction * x
                q_b += friction * (m["length"] - x)
                x += pitch
            force = pairs * per_pair
            q_a -= side * force * m["rb_a"]
            q_b += side * force * m["rb_b"]
        # The separating force at the bearings: the normal force along the line of action, applied at the centres
        ca, cb = (com_frame(body).TransformPointLocalToParent(c) for body, c in zip(self.gears, self.centres))
        d = np.array(vec(cb)) - np.array(vec(ca))
        d -= np.dot(d, self.axis) * self.axis
        e = d / np.linalg.norm(d)
        p = np.cross(self.axis, e)
        alpha = m["working_pressure_angle"]
        f_b = force * (side * math.cos(alpha) * p + math.sin(alpha) * e)
        # Torques about the axis: θ_a = φ_a, θ_b = -φ_b
        t_a, t_b = q_a, -q_b
        if force > 0:
            self.gears[0].AccumulateForce(self.slots[0], V(-f_b), ca, False)
            self.gears[1].AccumulateForce(self.slots[1], V(f_b), cb, False)
        self.gears[0].AccumulateTorque(self.slots[0], V(t_a * self.axis), False)
        self.gears[1].AccumulateTorque(self.slots[1], V(t_b * self.axis), False)
        self.state = {"delta": delta, "rate": rate, "force": force, "pairs": pairs, "f_b": f_b, "t_b": t_b}
        # Power through the teeth: taken from a, given to b (their difference is lost to friction and damping)
        self.work["a"] += q_a * rate_a * dt
        self.work["b"] += q_b * rate_b * dt
        if force > 0:
            self.work["time_in_contact"] += dt
            self.work["drive" if side > 0 else "coast"] += dt


def violation(link):
    c = link.GetConstraintViolation()
    return max((abs(c[i]) for i in range(c.Size())), default=0.0)


def coordinate(item, link):
    """(value, rate, effort) of a joint, motor or spring: angle (rad) or position (m), its rate, and the motor's
    torque/force or the spring's force/torque; None where it has none"""
    kind = item["type"]
    if isinstance(link, GearContact):
        return link.state["delta"], link.state["rate"], link.state["force"]
    if kind in ("rotational_motor", "linear_actuator"):
        if kind == "rotational_motor":
            return link.GetMotorAngle(), link.GetMotorAngleDt(), link.GetMotorTorque()
        return link.GetMotorPos(), link.GetMotorPosDt(), link.GetMotorForce()
    if kind == "spring_damper":
        return link.GetLength(), link.GetVelocity(), link.GetForce()
    if kind == "rotational_spring_damper":
        return link.GetAngle(), link.GetVelocity(), link.GetTorque()
    if kind in ("revolute", "cylindrical"):
        # GetRelAngle() is unsigned; the angle-axis vector's Z (the joint axis) carries the sign, in (-π, π]
        return link.GetRelAngleAxis().z, link.GetRelativeAngVel().z, None
    if kind == "prismatic":
        return link.GetRelCoordsys().pos.z, link.GetRelCoordsysDt().pos.z, None
    return None, None, None


UNCONSTRAINED = ("spring_damper", "rotational_spring_damper")
ACTUATED = ("rotational_motor", "linear_actuator")
WRAPPED = ("revolute", "cylindrical", "rotational_spring_damper")
CONTACT_COLUMNS = ["t", "body", "fx", "fy", "fz", "tx", "ty", "tz", "contacts"]
BODY_COLUMNS = ["t", "body", "x", "y", "z", "qw", "qx", "qy", "qz", "vx", "vy", "vz", "wx", "wy", "wz",
                "ax", "ay", "az", "alpha_x", "alpha_y", "alpha_z"]
JOINT_COLUMNS = ["t", "item", "kind", "value", "rate", "effort", "fx", "fy", "fz", "tx", "ty", "tz", "violation"]


class Recorder:
    """Writes the CSV rows, keeps quaternions continuous in sign, checks every value is finite, and keeps what the
    theory checks need"""

    def __init__(self, folder, model):
        self.model = model
        self.body_file = open(folder / "body_transforms.csv", "w", newline="")
        self.joint_file = open(folder / "joint_results.csv", "w", newline="")
        self.body_csv, self.joint_csv = csv.writer(self.body_file), csv.writer(self.joint_file)
        self.body_csv.writerow(BODY_COLUMNS)
        self.joint_csv.writerow(JOINT_COLUMNS)
        self.last_q = {}
        self.unwrapped = {}
        self.max_violation = {"value": 0.0, "item": None, "t": 0.0}
        self.contact_file = None
        if model["simulation"]["collision"]["enabled"]:
            self.contact_file = open(folder / "contacts.csv", "w", newline="")
            self.contact_csv = csv.writer(self.contact_file)
            self.contact_csv.writerow(CONTACT_COLUMNS)
            self.colliding = [b["id"] for b in model["bodies"] if b["collision"]]
        self.contact_force = {}  # body id → [(t, force world)]
        self.series = {}  # item id → [(t, value, rate)]
        self.angular = {}  # body id → [(t, ω world)]
        self.last_speed = {}  # body id → its latest speed
        self.samples = 0

    def row(self, writer, values, what, t):
        for v in values:
            if isinstance(v, float) and not math.isfinite(v):
                raise FloatingPointError(f"{what}: giá trị không hữu hạn tại t = {t:.6g} s")
        writer.writerow([f"{v:.9g}" if isinstance(v, float) else ("" if v is None else v) for v in values])

    def record(self, m, t):
        self.samples += 1
        for bid, body in m.bodies.items():
            frame = body.GetFrameRefToAbs()
            q = np.array(quat(frame.GetRot()))
            if bid in self.last_q and np.dot(q, self.last_q[bid]) < 0:
                q = -q
            self.last_q[bid] = q
            w = vec(body.GetAngVelParent())
            self.angular.setdefault(bid, []).append((t, w))
            self.last_speed[bid] = float(np.linalg.norm(vec(frame.GetPosDt())))
            values = [t, bid, *vec(frame.GetPos()), *q.tolist(), *vec(frame.GetPosDt()), *w,
                      *vec(frame.GetPosDt2()), *vec(body.GetAngAccParent())]
            self.row(self.body_csv, values, f"body {bid}", t)
        if self.contact_file:
            count = m.system.GetNumContacts()
            for bid in self.colliding:
                body = m.bodies[bid]
                force = vec(body.GetContactForce())
                self.contact_force.setdefault(bid, []).append((t, force))
                self.row(self.contact_csv, [t, bid, *force, *vec(body.GetContactTorque()), count], f"contact {bid}", t)
        for item, link in m.links:
            value, rate, effort = coordinate(item, link)
            if value is not None and item["type"] in WRAPPED:
                # Chrono gives the angle in (-π, π]: kept continuous from sample to sample, as a motor's is
                previous = self.unwrapped.get(item["id"])
                if previous is not None:
                    value = previous + (value - previous + math.pi) % (2 * math.pi) - math.pi
                self.unwrapped[item["id"]] = value
            if isinstance(link, GearContact):
                # The tooth force on gear b (world) and its torque about the axis
                force, torque = link.state["f_b"].tolist(), (link.state["t_b"] * link.axis).tolist()
                worst = 0.0
            else:
                wrench = link.GetReaction1()
                force, torque = vec(wrench.force), vec(wrench.torque)
                worst = violation(link) if item["type"] not in UNCONSTRAINED else 0.0
            # Motors are checked against their law instead (their residual is the drift of the driven coordinate)
            if worst > self.max_violation["value"] and item["type"] not in ACTUATED:
                self.max_violation = {"value": worst, "item": item["id"], "t": t}
            if value is not None:
                self.series.setdefault(item["id"], []).append((t, value, rate))
            values = [t, item["id"], item["type"], value, rate, effort, *force, *torque, worst]
            self.row(self.joint_csv, values, f"{item['type']} {item['id']}", t)

    def close(self):
        self.body_file.close()
        self.joint_file.close()
        if self.contact_file:
            self.contact_file.close()


def theory_checks(model, rec, sim, meshes=None):
    """Results with an exact answer, compared: a motor follows its law (speed integrated to an angle or position,
    or the angle/position itself), and an ideal gear pair turns at -N_a/N_b (internal: +N_a/N_b). Tolerances are
    set from the time step: the motor laws are enforced at velocity level and integrated by the time stepper"""
    checks = []
    dt, duration = sim["time_step"], sim["duration"]
    for a in model["actuators"]:
        series = rec.series.get(a["id"])
        if not series or a["mode"] in ("torque", "force"):
            continue
        times = np.array([s[0] for s in series])
        values = np.array([s[1] for s in series])
        if a["mode"] == "speed":
            expected = np.array([schema.law_integral(a["law"], t) for t in times])
            # Velocity-level control drifts by at most about one step's travel per step
            peak = max(abs(schema.law_value(a["law"], t)) for t in times)
            tolerance = max(1e-6, peak * dt * 2)
            what = "góc quay" if a["type"] == "rotational_motor" else "vị trí"
        else:
            expected = np.array([schema.law_value(a["law"], t) for t in times])
            tolerance = 1e-6
            what = "góc đặt" if a["type"] == "rotational_motor" else "vị trí đặt"
        error = float(np.max(np.abs(values - expected)))
        checks.append({"id": f"{a['id']}.law", "kind": "motor_law", "item": a["id"],
                       "description": f"{what} của {a['id']} so với tích phân luật chuyển động (lý thuyết)",
                       "max_error": error, "tolerance": tolerance, "unit": "rad" if a["type"] == "rotational_motor"
                       else "m", "passed": error <= tolerance,
                       "final": {"simulated": float(values[-1]), "theory": float(expected[-1])}})
    joints = {j["id"]: j for j in model["joints"]}
    for j in model["joints"]:
        if j["type"] != "gear" or j.get("model") == "contact":
            continue
        axis = np.asarray(joints[j["joint_a"]]["axis"])
        wa = np.array([np.dot(w, axis) for _, w in rec.angular[j["body_a"]]])
        wb = np.array([np.dot(w, axis) for _, w in rec.angular[j["body_b"]]])
        carrier = np.array([np.dot(w, axis) for _, w in rec.angular[j["carrier"]]])
        ra, rb = wa - carrier, wb - carrier
        # Turning: above 0.1 % of the run's top speed (what is left of the assembly at t = 0 is not a ratio)
        moving = np.abs(ra) > max(1e-6, 1e-3 * float(np.max(np.abs(ra))))
        ratio = (-1 if not j["internal"] else 1) * j["teeth_a"] / j["teeth_b"]
        if not moving.any():
            checks.append({"id": f"{j['id']}.ratio", "kind": "gear_ratio", "item": j["id"], "passed": None,
                           "description": "Bánh răng không quay: không kiểm tra được tỉ số truyền"})
            continue
        measured = rb[moving] / ra[moving]
        error = float(np.max(np.abs(measured - ratio)))
        checks.append({"id": f"{j['id']}.ratio", "kind": "gear_ratio", "item": j["id"],
                       "description": f"ω_{j['body_b']}/ω_{j['body_a']} so với "
                                      f"{'-' if not j['internal'] else '+'}N_a/N_b = {ratio:.6g} (bánh răng lý tưởng)",
                       "expected": ratio, "measured_mean": float(measured.mean()), "max_error": error,
                       "tolerance": 1e-4 * max(1.0, abs(ratio)), "passed": error <= 1e-4 * max(1.0, abs(ratio))})
    _ = duration
    checks += gear_contact_checks(model, rec, meshes or [])
    checks += resting_checks(model, rec, sim)
    return checks


def gear_contact_checks(model, rec, meshes):
    """Teeth in contact: over the run the gears turn at -N_a/N_b give or take what the backlash and the teeth's
    deflection allow; and the power lost in the teeth matches Ohlendorf's μ·H_v when the run is mostly driving on
    one flank"""
    checks = []
    for mesh in meshes:
        j, m = mesh.item, mesh.mesh
        series = rec.series.get(j["id"], [])
        travel_a = abs(mesh.unwrapped[0])
        info = {"contact_ratio": m["contact_ratio"], "backlash_normal_m": m["backlash_normal"],
                "mesh_stiffness_N_per_m": m["stiffness"], "mesh_period_s": m["mesh_period"],
                "time_in_contact_s": mesh.work["time_in_contact"], "drive_s": mesh.work["drive"],
                "coast_s": mesh.work["coast"], "work_in_J": -mesh.work["a"], "work_out_J": mesh.work["b"]}
        if travel_a < 2 * math.pi / j["teeth_a"]:
            checks.append({"id": f"{j['id']}.ratio", "kind": "gear_ratio", "item": j["id"], "passed": None,
                           "description": "Bánh răng quay chưa qua một bước răng: không kiểm tra được tỉ số truyền",
                           **info})
            continue
        ratio = -j["teeth_a"] / j["teeth_b"]
        measured = mesh.unwrapped[1] / mesh.unwrapped[0]
        deltas = np.array([s[1] for s in series])
        # rb_a Δφ_a - rb_b Δφ_b = Δδ, and δ stays within the backlash plus the teeth's deflection
        slack = m["backlash_normal"] + 2 * max(0.0, float(np.max(np.abs(deltas))) - m["backlash_normal"] / 2)
        tolerance = slack / (m["rb_a"] * travel_a) * abs(ratio) + 1e-9
        checks.append({"id": f"{j['id']}.ratio", "kind": "gear_ratio", "item": j["id"],
                       "description": f"Góc quay {j['body_b']}/{j['body_a']} sau cả lần chạy so với -N_a/N_b = "
                                      f"{ratio:.6g} (răng tiếp xúc: sai lệch trong khe hở và độ võng răng)",
                       "expected": ratio, "measured": measured, "max_error": abs(measured - ratio),
                       "tolerance": tolerance, "passed": abs(measured - ratio) <= tolerance, **info})
        driving = mesh.work["drive"] >= 0.9 * mesh.work["time_in_contact"] > 0
        if j["friction"] > 0 and driving and mesh.work["a"] < 0:
            efficiency = mesh.work["b"] / -mesh.work["a"]
            expected = 1 - j["friction"] * m["loss_factor"]
            loss, expected_loss = 1 - efficiency, j["friction"] * m["loss_factor"]
            tolerance = 0.25 * expected_loss + 0.002
            checks.append({"id": f"{j['id']}.efficiency", "kind": "gear_efficiency", "item": j["id"],
                           "description": f"Hiệu suất ăn khớp {efficiency:.4f} so với 1 - μ·H_v = {expected:.4f} "
                                          "(Ohlendorf, ISO/TR 14179-2)",
                           "expected": expected, "measured": efficiency, "max_error": abs(loss - expected_loss),
                           "tolerance": tolerance, "passed": abs(loss - expected_loss) <= tolerance})
    return checks


def resting_checks(model, rec, sim):
    """A colliding body that only touches other bodies (no joint, motor or load of its own) and has come to rest:
    the contacts carry its weight, F = -m·g, over the last tenth of the run"""
    checks = []
    attached = set()
    for item in model["joints"] + model["actuators"] + model["forces"]:
        attached.update(item.get(k) for k in ("body_a", "body_b", "body"))
    gravity = np.asarray(sim["gravity"], float)
    for b in model["bodies"]:
        if b["fixed"] or not b["collision"] or b["id"] in attached or b["id"] not in rec.contact_force:
            continue
        samples = rec.contact_force[b["id"]]
        tail = samples[int(len(samples) * 0.9):] or samples[-1:]
        speeds = [np.linalg.norm(w) for _, w in rec.angular[b["id"]][-len(tail):]]
        if rec.last_speed.get(b["id"], 1.0) > 1e-3 or max(speeds) > 1e-2 or np.linalg.norm(gravity) == 0:
            continue
        force = np.mean([f for _, f in tail], axis=0)
        weight = -b["mass"] * gravity
        error = float(np.linalg.norm(force - weight))
        tolerance = 0.01 * float(np.linalg.norm(weight))
        checks.append({"id": f"{b['id']}.rest", "kind": "contact_equilibrium", "item": b["id"],
                       "description": f"{b['id']} nằm yên: lực tiếp xúc {np.round(force, 6).tolist()} N so với "
                                      f"trọng lượng -m·g = {np.round(weight, 6).tolist()} N",
                       "max_error": error, "tolerance": tolerance, "unit": "N", "passed": error <= tolerance})
    return checks


def run(folder):
    model = json.loads((folder / "model.json").read_text(encoding="utf-8"))
    sim = model["simulation"]
    out = {"engine": "Project Chrono (PyChrono)", "engine_version": engine_version(), "state": "running"}
    started = time.monotonic()
    m = Model(model)
    log.info("Chrono %s: %d body, %d khớp/động cơ/lò xo, %d tải", out["engine_version"], len(m.bodies),
             len(m.links), len(m.forces))

    # Assembly: the joints closed at t = 0 (positions, then velocities and accelerations)
    flag = m.system.DoAssembly(ch.FULL)
    names = {getattr(ch, n): n for n in dir(ch) if n.startswith("ExitFlag_")}
    out["assembly"] = names.get(flag, str(flag))
    worst = max(((violation(link), item["id"]) for item, link in m.links
                 if item["type"] not in UNCONSTRAINED + ACTUATED and not isinstance(link, GearContact)),
                default=(0.0, None))
    out["assembly_violation"] = {"value": worst[0], "item": worst[1]}
    log.info("Lắp ráp: %s, vi phạm ràng buộc lớn nhất %.3g (%s)", out["assembly"], *worst)
    if flag == ch.ExitFlag_NOT_CONVERGED or worst[0] > sim["constraint_tolerance"] * 1e3:
        raise RuntimeError(f"Không lắp ráp được cơ cấu ở t = 0 ({out['assembly']}, vi phạm {worst[0]:.3g} tại "
                           f"{worst[1]}): các khớp mâu thuẫn hoặc vị trí ban đầu sai quá xa.")

    rec = Recorder(folder, model)
    dt, duration, every = sim["time_step"], sim["duration"], sim["output_interval"]
    steps = int(round(duration / dt))
    record_every = max(1, int(round(every / dt)))
    try:
        for mesh in m.meshes:
            mesh.apply(0.0)
        rec.record(m, 0.0)
        for i in range(1, steps + 1):
            # Tooth forces from the state at the start of the step (hence the short steps schema asks for)
            for mesh in m.meshes:
                mesh.apply(dt)
            m.system.DoStepDynamics(dt)
            if i % record_every == 0 or i == steps:
                rec.record(m, m.system.GetChTime())
            if i % max(1, steps // 100) == 0:
                print(f"PROGRESS {i / steps:.3f}", flush=True)
    finally:
        rec.close()

    out.update(state="completed", steps=steps, samples=rec.samples, wall_time_s=time.monotonic() - started,
               max_violation=rec.max_violation, checks=theory_checks(model, rec, sim, m.meshes))
    if rec.max_violation["value"] > sim["constraint_tolerance"]:
        out["checks"].append({"id": "constraints", "kind": "constraint_violation", "passed": False,
                              "description": f"Vi phạm ràng buộc lớn nhất {rec.max_violation['value']:.3g} "
                                             f"({rec.max_violation['item']}, t = {rec.max_violation['t']:.4g} s) vượt "
                                             f"ngưỡng {sim['constraint_tolerance']:g}: ràng buộc thừa/mâu thuẫn, "
                                             "hoặc bước thời gian quá lớn"})
    else:
        out["checks"].append({"id": "constraints", "kind": "constraint_violation", "passed": True,
                              "description": f"Vi phạm ràng buộc lớn nhất {rec.max_violation['value']:.3g} ≤ "
                                             f"{sim['constraint_tolerance']:g}"})
    log.info("Xong %d bước trong %.1f s", steps, out["wall_time_s"])
    return out


def plain(value):
    """NumPy numbers and booleans for json"""
    return value.item() if hasattr(value, "item") else str(value)


def main():
    folder = Path(sys.argv[1]).resolve()
    logging.basicConfig(filename=folder / "simulation.log", level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    try:
        out = run(folder)
        code = 0
    except Exception as err:  # noqa: BLE001 - every failure is reported in engine.json
        log.exception("Mô phỏng lỗi")
        out = {"engine": "Project Chrono (PyChrono)", "engine_version": engine_version(), "state": "failed",
               "error": f"{type(err).__name__}: {err}"}
        code = 1
    (folder / "engine.json").write_text(json.dumps(out, ensure_ascii=False, indent=2, default=plain), encoding="utf-8")
    sys.exit(code)


if __name__ == "__main__":
    main()
