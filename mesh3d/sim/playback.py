"""
Plays a Chrono run back in Blender (runs.py starts it):

    xvfb-run -a blender -b --factory-startup --python playback.py -- <run folder>

Each body becomes the object "sim:<body id>": its Blender mesh (visual.mesh_file, or visual.blend_file with
visual.blender_object), else its geometry (box, cylinder, sphere, a toothed gear, a mesh file), else a small marker.
Its mesh is in the body's own frame, so the object's transform is the body's pose, keyframed every frame from
body_transforms.csv (positions interpolated, quaternions normalised-lerped between the samples). Blender's physics
is never run: the motion is Chrono's. Units: 1 Blender unit = 1 mm, Z up, as in the figure jobs.

Then it checks what it made: at frames spread over the run, every object's world matrix against the pose in the
CSV (position error in mm, rotation error in degrees), and for every revolute joint and rotational motor the angle
of body_b relative to body_a about the axis, measured on the Blender objects, against the joint's own coordinate in
joint_results.csv (this catches a wrong direction of rotation). blender/check.json holds the result.

Writes blender/playback.blend, and with options.render blender/playback.mp4 (Workbench) and frames/####.png for
the preview sheet.
"""

import csv
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

MM = 1000.0
COLOURS = ["#E4572E", "#29335C", "#F3A712", "#669BBC", "#A8C686", "#8D6A9F", "#D9A441", "#3C8DBC"]
MAX_FRAMES = 3000


def hex_rgba(value):
    value = value.lstrip("#")
    srgb = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*linear, 1.0)


def material(name, colour):
    mat = bpy.data.materials.new(name)
    rgba = hex_rgba(colour)
    mat.diffuse_color = rgba
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = rgba
    return mat


def mesh_object(name, verts, faces):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def axis_matrix(axis):
    """Rotation taking +Z to the geometry's axis (x, y or z)"""
    return {"z": Matrix.Identity(4), "x": Matrix.Rotation(math.pi / 2, 4, "Y"),
            "y": Matrix.Rotation(-math.pi / 2, 4, "X")}[axis]


def prism(name, outline, height, axis="z"):
    """A closed prism from a 2D outline (counter-clockwise, mm), centred on Z = 0, then turned onto `axis`"""
    n = len(outline)
    verts = [(x, y, -height / 2) for x, y in outline] + [(x, y, height / 2) for x, y in outline]
    faces = [list(range(n))[::-1], list(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    obj = mesh_object(name, verts, faces)
    obj.data.transform(axis_matrix(axis))
    return obj


def gear_outline(teeth, module, pressure_angle=math.radians(20), samples=6):
    """A standard spur gear's outline (20° involute flanks from the base or root circle to the tip circle r + m, the
    root circle r - 1.25 m between teeth), a tooth centred on +X, counter-clockwise: the profile the contact gears'
    line of action is worked out for (schema.gear_mesh)"""
    r = teeth * module / 2
    base, root, tip = r * math.cos(pressure_angle), r - 1.25 * module, r + module

    def involute(a):
        return math.tan(a) - a

    def half(rho):
        # Half the tooth's angular thickness at radius rho: half a pitch's worth at r, thinner towards the tip
        return math.pi / (2 * teeth) + involute(pressure_angle) - involute(math.acos(min(1.0, base / rho)))

    radii = list(np.linspace(max(base, root), tip, samples))
    flank = ([(root, half(radii[0]))] if root < base else []) + [(rho, half(rho)) for rho in radii]
    pitch = 2 * math.pi / teeth
    points = []
    for i in range(teeth):
        c = i * pitch
        side = [(rho, c - h) for rho, h in flank] + [(rho, c + h) for rho, h in reversed(flank)]
        points += [(rho * math.cos(a), rho * math.sin(a)) for rho, a in side]
    return points


def from_geometry(name, g):
    t = g["type"]
    if t == "box":
        x, y, z = (s * MM / 2 for s in g["size"])
        verts = [(sx * x, sy * y, sz * z) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
        faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        return mesh_object(name, verts, faces)
    if t == "cylinder":
        r = g["radius"] * MM
        circle = [(r * math.cos(a), r * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 48, endpoint=False)]
        return prism(name, circle, g["length"] * MM, g["axis"])
    if t == "gear":
        return prism(name, gear_outline(g["teeth"], g["module"] * MM), g["length"] * MM, g["axis"])
    if t == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(radius=g["radius"] * MM, segments=32, ring_count=16)
        obj = bpy.context.active_object
        obj.name = name
        return obj
    return import_mesh(name, g["file"], g["unit_scale"])


def import_mesh(name, path, unit_scale):
    """A mesh file in the body's own frame, in the mechanism's length unit, as one object in mm"""
    before = set(bpy.data.objects)
    suffix = Path(path).suffix.lower()
    if suffix == ".stl":
        bpy.ops.wm.stl_import(filepath=path, forward_axis="Y", up_axis="Z")
    elif suffix == ".obj":
        bpy.ops.wm.obj_import(filepath=path, forward_axis="Y", up_axis="Z")
    elif suffix == ".ply":
        bpy.ops.wm.ply_import(filepath=path, forward_axis="Y", up_axis="Z")
    else:
        bpy.ops.import_scene.gltf(filepath=path)
    return single(name, [o for o in bpy.data.objects if o not in before and o.type == "MESH"],
                  unit_scale * MM)


def single(name, objects, scale):
    """Joins imported objects into one, their transforms baked in and scaled to mm"""
    if not objects:
        raise RuntimeError(f"{name}: file không có mesh")
    for obj in objects:
        obj.data.transform(Matrix.Scale(scale, 4) @ obj.matrix_world)
        obj.matrix_world = Matrix.Identity(4)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    for o in list(bpy.data.objects):
        if o.type != "MESH" and o.name not in ("Camera", "Sun") and not o.name.startswith(("sim:", "joint:")):
            bpy.data.objects.remove(o)
    return obj


def from_blend(name, path, object_name, unit_scale):
    """An object of another .blend file (a figure job's scene.blend…), its mesh taken as drawn in the body frame"""
    with bpy.data.libraries.load(path, link=False) as (src, dst):
        if object_name not in src.objects:
            raise RuntimeError(f"{path} không có object {object_name!r}")
        dst.objects = [object_name]
    obj = dst.objects[0]
    bpy.context.scene.collection.objects.link(obj)
    obj.data = obj.data.copy()
    obj.data.transform(Matrix.Scale(unit_scale * MM, 4))
    obj.matrix_world = Matrix.Identity(4)
    obj.parent = None
    obj.name = name
    return obj


def body_object(body, index):
    name = f"sim:{body['id']}"
    visual = body.get("visual") or {}
    if visual.get("mesh_file"):
        obj = import_mesh(name, visual["mesh_file"], visual["unit_scale"])
    elif visual.get("blend_file") and visual.get("blender_object"):
        obj = from_blend(name, visual["blend_file"], visual["blender_object"], visual.get("unit_scale", 0.001))
    elif body.get("geometry"):
        obj = from_geometry(name, body["geometry"])
    else:
        obj = from_geometry(name, {"type": "sphere", "radius": 0.003})
    keep_materials = (visual.get("mesh_file") or visual.get("blend_file")) and obj.data.materials \
        and not visual.get("color")
    if not keep_materials:
        obj.data.materials.clear()
        obj.data.materials.append(material(f"{name}:colour", visual.get("color") or COLOURS[index % len(COLOURS)]))
    obj.rotation_mode = "QUATERNION"
    obj["sim_body"] = body["id"]
    return obj


# ---------- the motion ----------

def read_poses(folder):
    """body id → (times, positions in m, quaternions w-x-y-z)"""
    rows = {}
    with open(folder / "body_transforms.csv", newline="") as f:
        for row in csv.DictReader(f):
            rows.setdefault(row["body"], []).append(
                [float(row[k]) for k in ("t", "x", "y", "z", "qw", "qx", "qy", "qz")])
    out = {}
    for bid, values in rows.items():
        a = np.array(values)
        out[bid] = (a[:, 0], a[:, 1:4], a[:, 4:8])
    return out


def pose_at(track, t):
    times, pos, quat = track
    i = int(np.clip(np.searchsorted(times, t) - 1, 0, len(times) - 2)) if len(times) > 1 else 0
    if len(times) == 1:
        return pos[0], quat[0]
    u = float(np.clip((t - times[i]) / max(times[i + 1] - times[i], 1e-12), 0, 1))
    p = pos[i] * (1 - u) + pos[i + 1] * u
    q = quat[i] * (1 - u) + quat[i + 1] * u
    return p, q / np.linalg.norm(q)


def keyframe(obj, track, frames, fps, speed):
    for frame in frames:
        p, q = pose_at(track, (frame - 1) * speed / fps)
        obj.location = Vector(p * MM)
        obj.rotation_quaternion = Quaternion(q)
        obj.keyframe_insert("location", frame=frame)
        obj.keyframe_insert("rotation_quaternion", frame=frame)
    action = obj.animation_data.action if obj.animation_data else None
    for curve in fcurves(action):
        for key in curve.keyframe_points:
            key.interpolation = "LINEAR"


def fcurves(action):
    if action is None:
        return []
    if hasattr(action, "layers") and action.layers:
        return [c for layer in action.layers for strip in layer.strips for bag in strip.channelbags
                for c in bag.fcurves]
    return list(action.fcurves)


def joint_angles(folder):
    """item id → (times, values) of revolute joints and rotational motors, from joint_results.csv"""
    out = {}
    with open(folder / "joint_results.csv", newline="") as f:
        for row in csv.DictReader(f):
            if row["kind"] in ("revolute", "rotational_motor") and row["value"] != "":
                out.setdefault(row["item"], ([], []))
                out[row["item"]][0].append(float(row["t"]))
                out[row["item"]][1].append(float(row["value"]))
    return {k: (np.array(t), np.array(v)) for k, (t, v) in out.items()}


def signed_angle(rotation, axis):
    """The angle of a rotation matrix about a unit axis (radians, right-handed)"""
    r = np.asarray(rotation)
    sine = np.dot(axis, [r[2, 1] - r[1, 2], r[0, 2] - r[2, 0], r[1, 0] - r[0, 1]]) / 2
    cosine = (np.trace(r) - 1) / 2
    return math.atan2(sine, cosine)


def wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def check(model, objects, poses, folder, frames, fps, speed):
    """Blender's objects against Chrono's poses and joint coordinates, at up to 40 frames"""
    scene = bpy.context.scene
    picks = sorted(set(np.linspace(frames[0], frames[-1], min(40, len(frames))).round().astype(int).tolist()))
    angles = joint_angles(folder)
    items = [j for j in model["joints"] if j["type"] == "revolute"] + \
        [a for a in model["actuators"] if a["type"] == "rotational_motor"]
    pos_err, rot_err = 0.0, 0.0
    angle_err = {it["id"]: 0.0 for it in items if it["id"] in angles}
    first = {}
    for frame in picks:
        scene.frame_set(frame)
        t = (frame - 1) * speed / fps
        for bid, obj in objects.items():
            p, q = pose_at(poses[bid], t)
            m = obj.matrix_world
            pos_err = max(pos_err, (m.translation - Vector(p * MM)).length)
            dq = m.to_quaternion().rotation_difference(Quaternion(q))
            rot_err = max(rot_err, math.degrees(abs(wrap(dq.angle))))
        for it in items:
            if it["id"] not in angle_err:
                continue
            ra = np.array(objects[it["body_a"]].matrix_world.to_3x3())
            rb = np.array(objects[it["body_b"]].matrix_world.to_3x3())
            # body_b relative to body_a, the axis in body_a's frame (as Chrono measures it)
            rel = ra.T @ rb
            if frame == picks[0]:
                first[it["id"]] = (rel, ra.T @ np.asarray(it["axis"]))
            rel0, axis_a = first[it["id"]]
            measured = signed_angle(rel @ rel0.T, axis_a)
            times, values = angles[it["id"]]
            expected = float(np.interp(t, times, values)) - float(np.interp((picks[0] - 1) * speed / fps, times,
                                                                            values))
            angle_err[it["id"]] = max(angle_err[it["id"]], math.degrees(abs(wrap(measured - expected))))
    # Linear interpolation between samples is exact at the samples; in between a turning body may differ by
    # the chord of one output interval
    interval = model["simulation"]["output_interval"]
    tolerance_deg = max(0.05, max((np.max(np.abs(np.diff(v))) for _, v in angles.values() if len(v) > 1),
                                  default=0) * 180 / math.pi * 0.01 + 0.05)
    out = {"frames_checked": len(picks), "max_position_error_mm": pos_err, "max_rotation_error_deg": rot_err,
           "joint_angle_error_deg": angle_err, "output_interval_s": interval,
           "tolerance": {"position_mm": 0.01, "rotation_deg": 0.05, "joint_angle_deg": tolerance_deg}}
    out["passed"] = pos_err <= 0.01 and rot_err <= 0.05 and all(e <= tolerance_deg for e in angle_err.values())
    return out


# ---------- the scene ----------

def setup_scene(fps, last):
    scene = bpy.context.scene
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 0.001
    scene.unit_settings.length_unit = "MILLIMETERS"
    scene.render.fps = fps
    scene.frame_start, scene.frame_end = 1, last
    world = bpy.data.worlds.new("World") if scene.world is None else scene.world
    scene.world = world
    world.color = (0.18, 0.19, 0.21)
    return scene


def frame_camera(scene, objects, frames):
    """A camera from the front-right, above, that sees every body over the whole run"""
    points = []
    for frame in np.linspace(frames[0], frames[-1], min(12, len(frames))).round().astype(int):
        scene.frame_set(int(frame))
        for obj in objects.values():
            points += [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    pts = np.array([list(p) for p in points])
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    centre = (lo + hi) / 2
    radius = max(np.linalg.norm(hi - lo) / 2, 1.0)
    data = bpy.data.cameras.new("Camera")
    data.lens = 50
    data.clip_start, data.clip_end = radius * 0.01, radius * 100
    camera = bpy.data.objects.new("Camera", data)
    scene.collection.objects.link(camera)
    direction = Vector((1.0, -1.5, 0.9)).normalized()
    fov = 2 * math.atan(data.sensor_width / 2 / data.lens) * min(1, scene.render.resolution_y
                                                                 / scene.render.resolution_x)
    # The bounding sphere is generous for flat mechanisms: a little closer than it asks
    camera.location = Vector(centre) + direction * radius / math.sin(fov / 2) * 0.8
    camera.rotation_euler = (Vector(centre) - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = camera
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.rotation_euler = (0.7, 0.2, 0.6)
    scene.collection.objects.link(sun)


def joint_markers(model, objects):
    """An arrow along each joint's and motor's axis, carried by body_a: for the viewport, not rendered"""
    for item in model["joints"] + model["actuators"]:
        if not item.get("axis") or item.get("position") is None or item.get("body_a") not in objects:
            continue
        empty = bpy.data.objects.new(f"joint:{item['id']}", None)
        empty.empty_display_type = "SINGLE_ARROW"
        empty.empty_display_size = 20
        rot = Quaternion(Vector((0, 0, 1)).rotation_difference(Vector(item["axis"])))
        empty.matrix_world = Matrix.LocRotScale(Vector(item["position"]) * MM, rot, None)
        bpy.context.scene.collection.objects.link(empty)
        parent = objects[item["body_a"]]
        empty.parent = parent
        empty.matrix_parent_inverse = parent.matrix_world.inverted()
        empty.hide_render = True


def render(scene, out, frames, options):
    scene.render.engine = "BLENDER_WORKBENCH"
    # The colours as given, not AgX's filmic roll-off
    scene.view_settings.view_transform = "Standard"
    shading = scene.display.shading
    shading.light, shading.color_type = "STUDIO", "MATERIAL"
    shading.show_shadows, shading.show_cavity = True, True
    scene.render.resolution_x, scene.render.resolution_y = options["width"], options["height"]
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    # Stills for the preview sheet
    (out / "frames").mkdir(exist_ok=True)
    scene.render.image_settings.file_format = "PNG"
    stills = sorted(set(np.linspace(frames[0], frames[-1], 6).round().astype(int).tolist()))
    for frame in stills:
        scene.frame_set(frame)
        scene.render.filepath = str(out / "frames" / f"{frame:04d}.png")
        bpy.ops.render.render(write_still=True)
    # The animation
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "MEDIUM"
    scene.render.filepath = str(out / "playback_")
    bpy.ops.render.render(animation=True)
    made = sorted(out.glob("playback_*.mp4"))
    if made:
        made[-1].replace(out / "playback.mp4")
    return stills


def main():
    folder = Path(sys.argv[sys.argv.index("--") + 1])
    out = folder / "blender"
    options = json.loads((out / "options.json").read_text())
    model = json.loads((folder / "model.json").read_text(encoding="utf-8"))
    poses = read_poses(folder)
    fps, speed = options["fps"], options["speed"]
    duration = model["simulation"]["duration"]
    last = min(MAX_FRAMES, int(math.floor(duration / speed * fps + 1e-9)) + 1)
    frames = list(range(1, last + 1))
    scene = setup_scene(fps, last)
    scene.render.resolution_x, scene.render.resolution_y = options["width"], options["height"]

    objects = {}
    for i, body in enumerate(model["bodies"]):
        obj = body_object(body, i)
        keyframe(obj, poses[body["id"]], frames, fps, speed)
        objects[body["id"]] = obj
    scene.frame_set(1)
    joint_markers(model, objects)
    frame_camera(scene, objects, frames)

    result = check(model, objects, poses, folder, frames, fps, speed)
    result.update(frames=last, fps=fps, speed=speed, objects={bid: o.name for bid, o in objects.items()})
    scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "playback.blend"))
    if options["render"]:
        result["stills"] = render(scene, out, frames, options)
    (out / "check.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print("playback ok", json.dumps({k: result[k] for k in ("passed", "max_position_error_mm",
                                                            "max_rotation_error_deg")}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - Blender keeps running after a script error unless told to stop
        import traceback

        traceback.print_exc()
        sys.exit(1)
