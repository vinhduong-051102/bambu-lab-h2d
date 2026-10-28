"""
Claude's printing tools for a figure (docs/cad.md, "Nhân vật"): an MCP server on stdio ("figure") next to MCP for
Blender ("blender", which Claude models with). Both work on the same Blender (blender_session.py): this one through
the add-on's socket, as the add-on's own server does.

  python figure_mcp.py <job dir> <port>

- set_palette: the filaments, as materials F1…Fn in Blender (checked against what the user allowed)
- paint_from_picture: each face of a figure shaped from a picture in the filament nearest the picture's colour
- check: exports what is in the scene (export_scene(): every visible mesh, curve or metaball, modifiers applied,
  each face's filament from its material) to work/current.ply, runs refine.py on it, and shows the report and the
  six sides. review.py exports the same way when Claude is done.
"""

import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, os.environ.get("CAD_DIR", "/opt/cad"))

import numpy as np  # noqa: E402

MAX_FILAMENTS = 8
EXPORT_S = 300


def log(*parts):
    print("[figure-mcp]", *parts, file=sys.stderr, flush=True)


def blender(port, code, timeout=EXPORT_S):
    """Runs Python in the job's Blender through the add-on's socket; what it printed"""
    with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
        sock.settimeout(timeout)
        sock.sendall(json.dumps({"type": "execute_code", "params": {"code": code}}).encode("utf-8"))
        buffer = b""
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                raise ConnectionError("Blender closed the connection")
            buffer += chunk
            try:
                reply = json.loads(buffer.decode("utf-8"))
                break
            except (ValueError, UnicodeDecodeError):
                continue
    if reply.get("status") == "error":
        raise RuntimeError(reply.get("message", "Blender error"))
    return (reply.get("result") or {}).get("result", "")


# Every visible object that has a surface, evaluated (modifiers applied), in world coordinates: its triangles, and
# each one's filament from its material's name (F<n>; anything else is filament 1)
EXPORT_CODE = r'''
import bpy, re, numpy as np
depsgraph = bpy.context.evaluated_depsgraph_get()
vertices, faces, filaments, offset, names = [], [], [], 0, []
for obj in bpy.context.scene.objects:
    if obj.type not in {"MESH", "CURVE", "SURFACE", "META", "FONT"} or not obj.visible_get():
        continue
    evaluated = obj.evaluated_get(depsgraph)
    try:
        mesh = evaluated.to_mesh()
    except RuntimeError:
        continue
    if mesh is None or not len(mesh.polygons):
        evaluated.to_mesh_clear()
        continue
    mesh.calc_loop_triangles()
    co = np.empty(len(mesh.vertices) * 3, np.float64)
    mesh.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    m = np.array(obj.matrix_world)
    co = co @ m[:3, :3].T + m[:3, 3]
    tri = np.empty(len(mesh.loop_triangles) * 3, np.int64)
    mesh.loop_triangles.foreach_get("vertices", tri)
    index = np.empty(len(mesh.loop_triangles), np.int64)
    mesh.loop_triangles.foreach_get("material_index", index)
    slots = []
    for slot in obj.material_slots:
        found = re.match(r"^F(\d+)$", slot.material.name) if slot.material else None
        slots.append(int(found.group(1)) if found else 1)
    slots = np.array(slots or [1])
    vertices.append(co)
    faces.append(tri.reshape(-1, 3) + offset)
    filaments.append(slots[np.clip(index, 0, len(slots) - 1)])
    offset += len(co)
    names.append(obj.name)
    evaluated.to_mesh_clear()
if vertices:
    np.savez(PATH, vertices=np.concatenate(vertices), faces=np.concatenate(faces), filaments=np.concatenate(filaments))
print(",".join(names))
'''


def export_scene(port, directory):
    """The scene as it is → work/current.ply and work/current.labels.npy (filament 0-based per face). Returns the
    names of the objects exported."""
    import trimesh

    work = Path(directory) / "work"
    work.mkdir(exist_ok=True)
    path = work / "export.npz"
    path.unlink(missing_ok=True)
    names = blender(port, f"PATH = {str(path.resolve())!r}\n" + EXPORT_CODE).strip()
    if not path.exists():
        raise ValueError("The scene has no visible object with a surface to print")
    data = np.load(path)
    mesh = trimesh.Trimesh(data["vertices"], data["faces"], process=False)
    filaments = data["filaments"]
    # Corners repeated per object and split normals merged, so touching parts make one closed skin per body
    mesh.merge_vertices()
    keep = mesh.nondegenerate_faces()
    mesh.update_faces(keep)
    mesh.remove_unreferenced_vertices()
    mesh.export(work / "current.ply")
    np.save(work / "current.labels.npy", (filaments[keep] - 1).astype(np.int32))
    return [n for n in names.split(",") if n]


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


# ---------- Tools ----------

TOOLS = {}


def tool(description, properties, required=()):
    def register(fn):
        TOOLS[fn.__name__] = {"fn": fn, "description": description,
                              "schema": {"type": "object", "properties": properties, "required": list(required)}}
        return fn
    return register


class Job:
    def __init__(self, directory, port):
        self.directory, self.port = Path(directory), port
        self.work = self.directory / "work"
        # The filaments the figure may be painted in: {"count": n, "snap": [{hex, label, origin}]} (up to n of
        # these), {"palette": [{hex, label}]} (these, as loaded in the AMS) or {"count": n} (any n colours)
        self.choices = read_json(self.work / "choices.json") or {}

    @property
    def palette(self):
        return read_json(self.work / "palette.json")

    def save_palette(self, palette):
        (self.work / "palette.json").write_text(json.dumps(palette, ensure_ascii=False), encoding="utf-8")
        code = "\n".join(
            [MATERIAL_CODE] + [f"filament_material({p['slot']}, {p['hex']!r}, {p.get('label') or ''!r})" for p in palette])
        self.blender(code)

    def blender(self, code):
        return blender(self.port, code)


# The same materials blender_session.py makes: F<n> in the filament's colour, in every shading
MATERIAL_CODE = r'''
import bpy, numpy as np
def filament_material(slot, hex_, label):
    m = bpy.data.materials.get(f"F{slot}") or bpy.data.materials.new(f"F{slot}")
    c = np.array([int(hex_.lstrip("#")[i:i + 2], 16) / 255 for i in (0, 2, 4)])
    rgb = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m.diffuse_color = (*rgb, 1.0)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    m["filament"] = {"slot": slot, "hex": hex_.upper(), "label": label}
    return m
'''


@tool("Choose the filaments the figure is printed in, in order: they become the materials F1, F2, … in Blender "
      "(filament 1 is the main colour: a face with any other material prints in it). Give a face filament n by "
      "giving it material F<n>. Each {hex, label}. When the request lists filaments to choose from, only those, by "
      "their hex; at most as many as it allows. A figure shaped from a picture: one filament per main colour of "
      "the picture, then paint_from_picture.",
      {"filaments": {"type": "array", "items": {"type": "object"}}}, ["filaments"])
def set_palette(job, filaments):
    import colors

    if job.choices.get("palette"):
        raise ValueError("This figure is printed in the filaments loaded in the AMS, already set as F1…Fn")
    if not job.choices:
        raise ValueError("The user asked for one colour: no filaments to choose")
    allowed = {c["hex"].upper(): c for c in job.choices.get("snap") or []}
    limit = min(int(job.choices.get("count") or MAX_FILAMENTS), MAX_FILAMENTS)
    if not 1 <= len(filaments) <= limit:
        raise ValueError(f"Between 1 and {limit} filaments")
    palette = []
    for i, f in enumerate(filaments):
        hex_ = str(f.get("hex", "")).upper()
        if not hex_.startswith("#"):
            hex_ = "#" + hex_
        colors.hex_to_rgb(hex_)
        chosen = allowed.get(hex_)
        if allowed and not chosen:
            raise ValueError(f"{hex_} is not one of the filaments the user chose")
        entry = {"slot": i + 1, "hex": hex_, "label": (chosen or f).get("label") or f.get("label")}
        if chosen and chosen.get("origin"):
            entry["origin"] = chosen["origin"]
        palette.append(entry)
    job.save_palette(palette)
    return {"ok": True, "palette": palette,
            "next": "Assign F1…Fn as materials (obj.data.materials, polygon.material_index), or paint_from_picture"}


# The object's faces: centres in its own coordinates, for the picture's colours
CENTRES_CODE = r'''
import bpy, numpy as np
obj = bpy.data.objects[NAME]
mesh = obj.data
c = np.empty(len(mesh.polygons) * 3, np.float64)
mesh.polygons.foreach_get("center", c)
np.save(PATH, c.reshape(-1, 3))
print(len(mesh.polygons))
'''

ASSIGN_CODE = r'''
import bpy, numpy as np
obj = bpy.data.objects[NAME]
mesh = obj.data
mesh.materials.clear()
for slot in range(1, COUNT + 1):
    mesh.materials.append(bpy.data.materials[f"F{slot}"])
mesh.polygons.foreach_set("material_index", np.load(PATH).astype(np.int32))
mesh.update()
'''


@tool("Paint the figure Hunyuan3D shaped from the picture in the picture's colours: each face takes the filament "
      "nearest the picture's colour there (lightness counts less than hue, so a shaded sleeve keeps the sleeve's "
      "filament). Run it after set_palette and before moving, scaling or remeshing \"Figure\" (its faces are "
      "matched to the picture where they were), then look with shading \"material\" and fix what came out wrong "
      "by giving those faces another F<n> material. Replaces the object's materials.",
      {"object": {"type": "string", "description": "Default \"Figure\""}})
def paint_from_picture(job, object="Figure"):
    import colors
    from scipy.spatial import cKDTree

    if not (job.work / "picture.npz").exists():
        raise ValueError("This figure was not shaped from a picture with colour")
    palette = job.palette
    if not palette:
        raise ValueError("No filaments yet: set_palette first")
    tmp = Path(tempfile.mkdtemp(dir=job.work))
    centres_path, labels_path = tmp / "centres.npy", tmp / "labels.npy"
    job.blender(f"NAME = {object!r}\nPATH = {str(centres_path.resolve())!r}\n" + CENTRES_CODE)
    centres = np.load(centres_path)
    data = np.load(job.work / "picture.npz")
    distance, nearest = cKDTree(data["points"]).query(centres)
    palette_rgb = np.array([colors.hex_to_rgb(p["hex"]) for p in palette], float)
    labels = colors.nearest_filament(data["rgb"][nearest].astype(float), palette_rgb)
    # Specks of shading: each face takes the filament most of its nearest faces have
    _d, around = cKDTree(centres).query(centres, k=min(9, len(centres)))
    votes = np.zeros((len(centres), len(palette)))
    np.add.at(votes, (np.repeat(np.arange(len(centres)), around.shape[1]), labels[around].ravel()), 1)
    labels = votes.argmax(axis=1)
    np.save(labels_path, labels)
    job.blender(f"NAME = {object!r}\nPATH = {str(labels_path.resolve())!r}\nCOUNT = {len(palette)}\n" + ASSIGN_CODE)
    shares = np.bincount(labels, minlength=len(palette)) / len(labels)
    far = float(np.mean(distance > float(data["reach"])))
    return {"ok": True, "faces": int(len(labels)),
            "share": {f"F{p['slot']} {p.get('label') or p['hex']}": round(float(s), 3) for p, s in zip(palette, shares)},
            "faces_far_from_the_picture_shape": round(far, 3)}


def image_content(path):
    return {"type": "image", "data": base64.b64encode(Path(path).read_bytes()).decode(), "mimeType": "image/png"}


@tool("The print check: exports everything visible in the scene as the final export will (modifiers applied, "
      "each face's filament from its F<n> material), runs the print runner on it and shows its six sides in the "
      "figure's filaments. Its report has what matters for printing: size, loose bits, not watertight, not on the "
      "plate, little touching the plate. Use it before you finish, and act on its warnings.", {})
def check(job):
    names = export_scene(job.port, job.directory)
    process = subprocess.run([sys.executable, str(HERE / "refine.py"), "work/current.ply"], cwd=job.directory,
                             capture_output=True, text=True, timeout=EXPORT_S)
    report = read_json(job.directory / "out" / "report.json") or {"ok": False, "error": process.stderr[-2000:]}
    report.pop("palette", None)
    report["objects_exported"] = names
    content = [{"type": "text", "text": json.dumps(report, indent=2, ensure_ascii=False)}]
    if (job.directory / "out" / "views.png").exists():
        content.append(image_content(job.directory / "out" / "views.png"))
    return content


def call(job, name, args):
    entry = TOOLS.get(name)
    if entry is None:
        raise ValueError(f"Unknown tool {name}")
    started = time.monotonic()
    result = entry["fn"](job, **args)
    if isinstance(result, list):
        return result
    result["seconds"] = round(time.monotonic() - started, 1)
    return [{"type": "text", "text": json.dumps(result, indent=2, ensure_ascii=False)}]


# ---------- MCP over stdio ----------

def serve(job):
    protocol = sys.stdout
    # Anything else printed goes to stderr: stdout carries only the protocol
    sys.stdout = sys.stderr

    def send(message):
        protocol.write(json.dumps(message, ensure_ascii=False) + "\n")
        protocol.flush()

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        method, ident = message.get("method"), message.get("id")
        params = message.get("params") or {}
        if ident is None:
            continue  # notifications: initialized, cancelled
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": ident, "result": {
                "protocolVersion": params.get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "figure", "version": "1.0"}}})
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": ident, "result": {"tools": [
                {"name": name, "description": entry["description"], "inputSchema": entry["schema"]}
                for name, entry in TOOLS.items()]}})
        elif method == "tools/call":
            try:
                content = call(job, params.get("name"), params.get("arguments") or {})
                send({"jsonrpc": "2.0", "id": ident, "result": {"content": content}})
            except Exception as err:  # noqa: BLE001 - Claude reads what went wrong and tries otherwise
                log(traceback.format_exc())
                send({"jsonrpc": "2.0", "id": ident, "result": {
                    "content": [{"type": "text", "text": f"{type(err).__name__}: {err}"}], "isError": True}})
        elif method == "ping":
            send({"jsonrpc": "2.0", "id": ident, "result": {}})
        else:
            send({"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": f"Unknown method {method}"}})


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    serve(Job(sys.argv[1], int(sys.argv[2])))


if __name__ == "__main__":
    main()
