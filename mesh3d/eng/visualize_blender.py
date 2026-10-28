"""
Shows engineering results in Blender (visualize.py prepares the meshes and runs it):

    xvfb-run -a blender -b --factory-startup --python visualize_blender.py -- <folder>

<folder>/scene.json lists PLY meshes (mm, colours per vertex already worked out: stress, overlap, thin walls) with a
name and an opacity, the title and the colour scale. Writes <folder>/result.blend and result.png (Workbench, vertex
colours, an isometric view). Nothing is computed here: Blender only shows what the solvers wrote.
"""

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

folder = Path(sys.argv[sys.argv.index("--") + 1])
scene_spec = json.loads((folder / "scene.json").read_text())
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 0.001
scene.unit_settings.length_unit = "MILLIMETERS"

objects = []
for item in scene_spec["objects"]:
    bpy.ops.wm.ply_import(filepath=str(folder / item["file"]))
    obj = bpy.context.selected_objects[0]
    obj.name = item["name"]
    if item.get("wire"):
        # Shown as its edges only: the outline of the part as given (undeformed, or around an overlap). Flat faces
        # are merged first, so the fans of thin triangles a boolean leaves do not show
        flat = obj.modifiers.new("flat", "DECIMATE")
        flat.decimate_type = "DISSOLVE"
        flat.angle_limit = math.radians(5)
        wire = obj.modifiers.new("wire", "WIREFRAME")
        wire.thickness = 0.15
        wire.use_replace = True
    objects.append(obj)

lo = Vector((min(v[i] for o in objects for v in o.bound_box) for i in range(3)))
hi = Vector((max(v[i] for o in objects for v in o.bound_box) for i in range(3)))
centre, size = (lo + hi) / 2, max((hi - lo).length, 1.0)
cam_data = bpy.data.cameras.new("cam")
cam_data.clip_end = size * 20
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
direction = Vector((1.0, -1.3, 0.9)).normalized()
cam.location = centre + direction * size * 2.1
cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
cam_data.lens = 45
scene.camera = cam

scene.render.engine = "BLENDER_WORKBENCH"
shading = scene.display.shading
shading.light = "STUDIO"
shading.color_type = "VERTEX"
scene.render.resolution_x, scene.render.resolution_y = scene_spec.get("width", 1200), scene_spec.get("height", 800)
scene.render.film_transparent = False
world = bpy.data.worlds.new("w")
# Workbench renders over the world colour
world.color = (0.85, 0.86, 0.88)
scene.world = world
scene.render.filepath = str(folder / "result.png")
bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(folder / "result.blend"))
print("VISUALIZE OK", len(objects), math.isfinite(size))
