"""
Print layout of an assembly (build.py): each printed component turned to the face it prints best on, then packed
onto as many H2D plates as it takes.

- Orientation: of the faces of a part's convex hull (and the six axis directions), the one to lay it on is the one
  with the least overhang (faces facing down steeper than 45°, off the plate) for the most area on the plate; a part
  standing much taller than it is wide pays for it, and the part as modelled wins a tie. Then it turns about Z to
  the smallest footprint.
- Packing: footprints (rectangles, a gap apart, turned 90° when that fits better) go on the plate area both nozzles
  reach (H2D: X 25–325, Y 0–320 mm), biggest first, each where it leaves the shortest side free (MaxRects); a part
  that fits on no plate starts a new one, one larger than a plate gets a plate of its own and a warning.
- Plates sit where Bambu Studio puts them (plate n at its grid place, a fifth of a plate apart), so the 3MF that
  write_3mf makes opens with each part on its own plate.
"""

import math
import zipfile

import numpy as np

# H2D: the bed, and the part of it both nozzles reach (Bambu Studio's machine profile, extruder_printable_area)
BED = (350.0, 320.0)
REACH = ((25.0, 325.0), (0.0, 320.0))
MAX_HEIGHT = 320.0
MARGIN, GAP = 3.0, 4.0
# Studio's LOGICAL_PART_PLATE_GAP: plates are a fifth of a plate apart
PLATE_GAP = 1 / 5
# Downward faces steeper than this from vertical need support
OVERHANG = math.cos(math.radians(45))


def plate_origin(index, count):
    """Where Studio puts plate `index` (0-based) of `count`: in rows of ceil-ish √count, going towards −Y"""
    root = math.sqrt(count)
    columns = int(round(root)) + (1 if root > round(root) else 0)
    row, column = divmod(index, max(columns, 1))
    return np.array([column * BED[0] * (1 + PLATE_GAP), -row * BED[1] * (1 + PLATE_GAP), 0.0])


def rotation_to_down(n):
    """The rotation that turns direction n to −Z"""
    n = n / np.linalg.norm(n)
    target = np.array([0.0, 0.0, -1.0])
    v = np.cross(n, target)
    c = float(n @ target)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + k + k @ k * (1 / (1 + c))


def rotation_z(angle):
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])


def candidates(tris):
    """Directions to lay a part on: its hull's larger faces, and ±X, ±Y, ±Z"""
    from scipy.spatial import ConvexHull

    directions = [np.array(d, dtype=float) for d in
                  ([0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0])]
    points = np.unique(np.round(tris.reshape(-1, 3), 4), axis=0)
    try:
        hull = ConvexHull(points)
    except Exception:  # noqa: BLE001 - flat or degenerate: the axis directions only
        return directions
    # Hull facets are triangles: those of one face share its normal
    faces = {}
    for simplex, equation in zip(hull.simplices, hull.equations):
        a, b, c = points[simplex]
        key = tuple(np.round(equation[:3], 3))
        faces[key] = faces.get(key, 0.0) + np.linalg.norm(np.cross(b - a, c - a)) / 2
    for key, _ in sorted(faces.items(), key=lambda kv: -kv[1])[:12]:
        directions.append(np.array(key, dtype=float))
    return directions


def score(tris, rotation):
    """(score, measures) of the part lying turned by `rotation`: lower is better"""
    turned = tris @ rotation.T
    z = turned[:, :, 2]
    low = z.min()
    normals = np.cross(turned[:, 1] - turned[:, 0], turned[:, 2] - turned[:, 0])
    areas = np.linalg.norm(normals, axis=1) / 2
    nz = normals[:, 2] / np.maximum(areas * 2, 1e-12)
    on_plate = (z.max(axis=1) < low + 0.05) & (nz < -0.99)
    contact = float(areas[on_plate].sum())
    overhang = float(areas[(nz < -OVERHANG) & ~on_plate].sum())
    flat = turned.reshape(-1, 3)
    height = float(flat[:, 2].max() - low)
    width = float(min(np.ptp(flat[:, 0]), np.ptp(flat[:, 1])))
    total = float(areas.sum())
    # Tall and thin wobbles on the plate
    tall = max(0.0, height / max(width, 1e-6) - 3) * 0.05 * total
    return overhang - contact + tall, {"contact_mm2": round(contact, 1), "overhang_mm2": round(overhang, 1),
                                       "height_mm": round(height, 2)}


def orient(tris):
    """The best rotation for printing, turned about Z to the smallest footprint, with what it scores"""
    best, best_score, measures = np.eye(3), None, None
    for direction in candidates(tris):
        rotation = rotation_to_down(direction)
        value, what = score(tris, rotation)
        # The part as modelled wins a tie: its author may have meant it
        if np.allclose(rotation, np.eye(3)):
            value -= 1e-3 * abs(value) + 1e-6
        if best_score is None or value < best_score - 1e-6:
            best, best_score, measures = rotation, value, what
    flat = (tris.reshape(-1, 3) @ best.T)[:, :2]
    area = lambda a: float(np.prod(np.ptp(flat @ rotation_z(a)[:2, :2].T, axis=0)))  # noqa: E731
    angle = min((math.radians(d) for d in range(0, 180, 5)), key=area)
    return rotation_z(angle) @ best, measures


class MaxRects:
    """Free rectangles of one plate; a footprint goes where it leaves the shortest side free"""

    def __init__(self, width, height):
        self.free = [(0.0, 0.0, width, height)]

    def find(self, w, h):
        best = None
        for fx, fy, fw, fh in self.free:
            for rw, rh, turned in ((w, h, False), (h, w, True)):
                if rw <= fw + 1e-6 and rh <= fh + 1e-6:
                    fit = (min(fw - rw, fh - rh), max(fw - rw, fh - rh))
                    if best is None or fit < best[0]:
                        best = (fit, fx, fy, turned)
        return None if best is None else best[1:]

    def take(self, x, y, w, h):
        out = []
        for fx, fy, fw, fh in self.free:
            if x >= fx + fw or x + w <= fx or y >= fy + fh or y + h <= fy:
                out.append((fx, fy, fw, fh))
                continue
            if x > fx:
                out.append((fx, fy, x - fx, fh))
            if x + w < fx + fw:
                out.append((x + w, fy, fx + fw - x - w, fh))
            if y > fy:
                out.append((fx, fy, fw, y - fy))
            if y + h < fy + fh:
                out.append((fx, y + h, fw, fy + fh - y - h))
        # Drop the ones inside another
        self.free = [a for i, a in enumerate(out) if not any(
            j != i and a[0] >= b[0] - 1e-6 and a[1] >= b[1] - 1e-6 and a[0] + a[2] <= b[0] + b[2] + 1e-6
            and a[1] + a[3] <= b[1] + b[3] + 1e-6 and (a != b or j < i) for j, b in enumerate(out))]


def plan(meshes):
    """{name: triangles (n, 3, 3) as assembled} → {"parts": {name: {matrix (4×4, assembled → plate), plate,
    footprint_mm, contact_mm2, overhang_mm2, height_mm}}, "plates": [{n, parts}], "warnings": [...]}"""
    usable = (REACH[0][1] - REACH[0][0] - 2 * MARGIN, REACH[1][1] - REACH[1][0] - 2 * MARGIN)
    turned = {}
    for name, tris in meshes.items():
        rotation, measures = orient(tris)
        points = tris.reshape(-1, 3) @ rotation.T
        low, high = points.min(axis=0), points.max(axis=0)
        turned[name] = {"rotation": rotation, "low": low, "size": high - low, **measures}

    plates, warnings, placed = [], [], {}
    for name in sorted(turned, key=lambda n: -max(turned[n]["size"][:2])):
        w, h = turned[name]["size"][:2] + GAP
        spot = None
        for k, plate in enumerate(plates):
            found = plate["rects"].find(w, h)
            if found:
                spot = (k, *found)
                break
        if spot is None:
            plates.append({"rects": MaxRects(usable[0] + GAP, usable[1] + GAP), "parts": []})
            found = plates[-1]["rects"].find(w, h)
            spot = (len(plates) - 1, *(found or (0.0, 0.0, False)))
            if not found:
                warnings.append(f"{name} ({turned[name]['size'][0]:.0f} × {turned[name]['size'][1]:.0f} mm) lớn hơn "
                                f"vùng in {usable[0]:.0f} × {usable[1]:.0f} mm: cần cắt nhỏ, nó nằm riêng một bàn.")
        k, x, y, quarter = spot
        if quarter:
            w, h = h, w
        plates[k]["rects"].take(x, y, w, h)
        plates[k]["parts"].append(name)
        placed[name] = (k, x, y, quarter)
        if turned[name]["size"][2] > MAX_HEIGHT:
            warnings.append(f"{name} cao {turned[name]['size'][2]:.0f} mm, quá {MAX_HEIGHT:.0f} mm của H2D.")

    parts = {}
    for name, (k, x, y, quarter) in placed.items():
        info = turned[name]
        rotation = (rotation_z(math.pi / 2) if quarter else np.eye(3)) @ info["rotation"]
        points = meshes[name].reshape(-1, 3) @ rotation.T
        low = points.min(axis=0)
        corner = np.array([REACH[0][0] + MARGIN + x, REACH[1][0] + MARGIN + y, 0.0]) + plate_origin(k, len(plates))
        matrix = np.eye(4)
        matrix[:3, :3] = rotation
        matrix[:3, 3] = corner - low
        size = points.max(axis=0) - low
        parts[name] = {"matrix": matrix, "plate": k + 1, "footprint_mm": [round(float(size[0]), 1), round(float(size[1]), 1)],
                       **{key: info[key] for key in ("contact_mm2", "overhang_mm2", "height_mm")}}
    return {"parts": parts, "plates": [{"n": k + 1, "parts": p["parts"]} for k, p in enumerate(plates)],
            "warnings": warnings}


def write_3mf(path, meshes, layout, title="model"):
    """One object per part, each on its plate (Bambu Studio's Metadata/model_settings.config), laid out as
    `layout` says; meshes {name: triangles as assembled}"""
    objects, items, settings = [], [], []
    for k, (name, part) in enumerate(layout["parts"].items(), 1):
        tris = meshes[name].reshape(-1, 3) @ part["matrix"][:3, :3].T + part["matrix"][:3, 3]
        vertices, index = np.unique(np.round(tris, 4), axis=0, return_inverse=True)
        faces = index.reshape(-1, 3)
        faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
        objects.append(
            f'<object id="{k}" type="model" name="{name}"><mesh><vertices>'
            + "".join(f'<vertex x="{x:.4f}" y="{y:.4f}" z="{z:.4f}"/>' for x, y, z in vertices)
            + "</vertices><triangles>"
            + "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in faces)
            + "</triangles></mesh></object>")
        items.append(f'<item objectid="{k}" printable="1"/>')
        settings.append((k, name, part["plate"]))
    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        f'<metadata name="Title">{title}</metadata><metadata name="Application">bambu-lab-h2d build.py</metadata>'
        f'<resources>{"".join(objects)}</resources><build>{"".join(items)}</build></model>')
    config = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>']
    for k, name, _ in settings:
        config.append(f'<object id="{k}"><metadata key="name" value="{name}"/><metadata key="extruder" value="1"/>'
                      f'<part id="1" subtype="normal_part"><metadata key="name" value="{name}"/></part></object>')
    for plate in layout["plates"]:
        config.append(f'<plate><metadata key="plater_id" value="{plate["n"]}"/><metadata key="plater_name" value=""/>'
                      '<metadata key="locked" value="false"/>')
        for k, name, on in settings:
            if on == plate["n"]:
                config.append(f'<model_instance><metadata key="object_id" value="{k}"/>'
                              '<metadata key="instance_id" value="0"/></model_instance>')
        config.append("</plate>")
    config.append("</config>")
    content_types = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
        '<Default Extension="config" ContentType="text/xml"/></Types>')
    rels = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
        'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model)
        z.writestr("Metadata/model_settings.config", "\n".join(config))
