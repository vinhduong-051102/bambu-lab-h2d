"""
The Blender a figure job works in (docs/cad.md, "Nhân vật"): Blender with its interface on a virtual display
(xvfb-run), so the MCP for Blender add-on (github.com/ahujasid/blender-mcp) can serve Claude: its server runs
commands on Blender's main loop, which `blender -b` does not have. review.py starts it:

  xvfb-run -a blender --factory-startup --python blender_session.py -- <port> <job dir>

It sets the scene up in millimetres (1 Blender unit = 1 mm, Z up, the front towards −Y, the plate at Z = 0),
loads the figure the job starts from (work/start.npz, which review.py writes from source/: "Figure", with its
filaments as materials F1…Fn, and the picture's colours as the face attribute "picture"), turns the add-on's local
Hunyuan3D-2 on (generate_3d → the mesh worker's POST /generate) and starts the add-on's server on <port>.
"""

import json
import os
import sys
from pathlib import Path

import addon_utils
import bpy
import numpy as np

ADDON = "blender_mcp"
args = sys.argv[sys.argv.index("--") + 1:]
PORT, JOB = int(args[0]), Path(args[1])


def srgb_to_linear(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def filament_material(slot, hex_, label=None):
    """Material F<slot>: one filament, in its colour in every shading the add-on's look uses"""
    name = f"F{slot}"
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    rgb = srgb_to_linear([int(hex_.lstrip("#")[i: i + 2], 16) / 255 for i in (0, 2, 4)])
    material.diffuse_color = (*rgb, 1.0)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.6
    material["filament"] = {"slot": slot, "hex": hex_.upper(), "label": label or ""}
    return material


def picture_material():
    """Shows the face attribute "picture" (the picture's colours) until the figure has filaments"""
    material = bpy.data.materials.new("Ảnh gốc")
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    attribute = nodes.new("ShaderNodeAttribute")
    attribute.attribute_name = "picture"
    attribute.attribute_type = "GEOMETRY"
    links.new(attribute.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
    return material


def load_figure():
    start = JOB / "work" / "start.npz"
    if not start.exists():
        return
    data = np.load(start)
    vertices, faces = data["vertices"], data["faces"]
    mesh = bpy.data.meshes.new("Figure")
    mesh.vertices.add(len(vertices))
    mesh.vertices.foreach_set("co", vertices.astype(np.float32).ravel())
    mesh.loops.add(faces.size)
    mesh.loops.foreach_set("vertex_index", faces.astype(np.int32).ravel())
    mesh.polygons.add(len(faces))
    mesh.polygons.foreach_set("loop_start", np.arange(0, faces.size, 3, dtype=np.int32))
    mesh.polygons.foreach_set("loop_total", np.full(len(faces), 3, dtype=np.int32))
    mesh.update()
    mesh.validate()
    figure = bpy.data.objects.new("Figure", mesh)
    bpy.context.scene.collection.objects.link(figure)

    palette = json.loads((JOB / "work" / "palette.json").read_text(encoding="utf-8")) \
        if (JOB / "work" / "palette.json").exists() else None
    if "labels" in data and palette:
        for entry in palette:
            mesh.materials.append(filament_material(entry["slot"], entry["hex"], entry.get("label")))
        mesh.polygons.foreach_set("material_index", np.clip(data["labels"], 0, len(palette) - 1).astype(np.int32))
    elif "picture" in data:
        colours = mesh.attributes.new("picture", "FLOAT_COLOR", "FACE")
        rgba = np.concatenate([srgb_to_linear(data["picture"] / 255), np.ones((len(faces), 1))], axis=1)
        colours.data.foreach_set("color", rgba.astype(np.float32).ravel())
        mesh.materials.append(picture_material())
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    bpy.context.view_layer.objects.active = figure
    figure.select_set(True)


def set_up_scene():
    scene = bpy.context.scene
    # The default cube goes; the camera and light stay for renders
    for name in ("Cube",):
        if name in bpy.data.objects:
            bpy.data.objects.remove(bpy.data.objects[name], do_unlink=True)
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 0.001
    scene.unit_settings.length_unit = "MILLIMETERS"
    for area in bpy.context.screen.areas if bpy.context.screen else []:
        if area.type == "VIEW_3D":
            space = area.spaces.active
            space.clip_start, space.clip_end = 0.1, 100000
            space.overlay.grid_scale = 0.001
            # Solid shading in each material's viewport colour: the filaments show without rendering materials,
            # which takes most of a minute on the virtual display's software OpenGL
            space.shading.color_type = "MATERIAL"
    load_figure()


def start_server():
    """The add-on with only what a figure needs: the local Hunyuan3D-2, no asset libraries, no telemetry"""
    addon_utils.enable(ADDON, default_set=True)
    scene = bpy.context.scene
    prefs = bpy.context.preferences.addons[ADDON].preferences
    if hasattr(prefs, "telemetry_consent"):
        prefs.telemetry_consent = False
    if hasattr(prefs, "hunyuan3d_api_url"):
        prefs.hunyuan3d_api_url = os.environ.get("BLENDERMCP_HUNYUAN3D_API_URL", "http://127.0.0.1:8000")
    for name, value in (("blendermcp_use_polyhaven", False), ("blendermcp_use_sketchfab", False),
                        ("blendermcp_use_polypizza", False), ("blendermcp_use_hyper3d", False),
                        ("blendermcp_use_meshy", False), ("blendermcp_use_hunyuan3d", True),
                        ("blendermcp_hunyuan3d_mode", "LOCAL_API"), ("blendermcp_port", PORT),
                        ("blendermcp_auto_start_server", True)):
        if hasattr(scene, name):
            setattr(scene, name, value)
    bpy.ops.blendermcp.start_server()


def startup():
    set_up_scene()
    start_server()
    print(f"[blender-session] ready on port {PORT} for {JOB}", flush=True)
    return None


# After the window and its context exist
bpy.app.timers.register(startup, first_interval=0.5)
