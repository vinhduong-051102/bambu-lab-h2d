"""
The mesh objects of a .blend, for the engineering import (geometry.py runs it):

    blender -b <file.blend> --factory-startup --python blend_export.py -- <out folder>

Writes <out>/<n>.npz per mesh object (vertices in the world after modifiers, triangles) and <out>/objects.json:
each object's name and file, and the scene's unit scale (metres per Blender unit). The .blend is only read.
"""

import json
import sys
from pathlib import Path

import bpy
import numpy as np

out = Path(sys.argv[sys.argv.index("--") + 1])
out.mkdir(parents=True, exist_ok=True)
depsgraph = bpy.context.evaluated_depsgraph_get()
objects = []
for i, obj in enumerate(o for o in bpy.context.scene.objects if o.type == "MESH" and o.visible_get()):
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    verts = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
    mesh.vertices.foreach_get("co", verts)
    verts = verts.reshape(-1, 3)
    world = np.array(obj.matrix_world)
    verts = verts @ world[:3, :3].T + world[:3, 3]
    tris = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
    mesh.loop_triangles.foreach_get("vertices", tris)
    evaluated.to_mesh_clear()
    name = f"{i:03d}.npz"
    np.savez(out / name, vertices=verts, faces=tris.reshape(-1, 3))
    objects.append({"name": obj.name, "file": name})
scene = bpy.context.scene
(out / "objects.json").write_text(json.dumps({
    "objects": objects,
    "unit_system": scene.unit_settings.system,
    "scale_length": scene.unit_settings.scale_length,
}), encoding="utf-8")
