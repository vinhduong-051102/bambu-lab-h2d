"""
Colour for printed figures (docs/cad.md): Hunyuan3D-Paint's texture → one filament per face → a 3MF that Bambu
Studio opens with the faces already painted.

- face_colours(): the texture's colour under every face of the printable mesh (closest point on the textured mesh)
- quantize(): those colours down to the filaments: k-means in Lab, or the nearest of the colours loaded in the AMS
- clean_islands(): repaints faces that stand alone in another colour, which would only make purge towers busy
- write_3mf(): the mesh with Bambu's paint_color on every triangle
"""

import zipfile

import numpy as np

# ---------- Colour spaces: Lab distances match what the eye sees as different filaments ----------


def srgb_to_lab(rgb):
    """[n, 3] sRGB 0–255 → CIE Lab (D65)"""
    c = np.asarray(rgb, dtype=float) / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = c @ np.array([[0.4124, 0.2126, 0.0193], [0.3576, 0.7152, 0.1192], [0.1805, 0.0722, 0.9505]])
    xyz /= np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], axis=1)


def hex_to_rgb(value):
    value = value.lstrip("#")[:6]
    return [int(value[i: i + 2], 16) for i in (0, 2, 4)]


def rgb_to_hex(rgb):
    return "#" + "".join(f"{int(round(v)):02X}" for v in rgb)


# ---------- Texture → face colours ----------


def face_colours(mesh, textured):
    """sRGB [faces, 3] of `textured` (a trimesh with a UV texture, in the same place as `mesh`) at each face's
    centre of `mesh`"""
    import trimesh

    centres = mesh.triangles_center
    _closest, _dist, tri = trimesh.proximity.closest_point(textured, centres)
    corners = textured.triangles[tri]
    bary = trimesh.triangles.points_to_barycentric(corners, centres)
    uv = np.einsum("ij,ijk->ik", bary, textured.visual.uv[textured.faces[tri]])
    image = np.asarray(textured.visual.material.baseColorTexture.convert("RGB")
                       if hasattr(textured.visual.material, "baseColorTexture") and textured.visual.material.baseColorTexture is not None
                       else textured.visual.material.image.convert("RGB"))
    h, w = image.shape[:2]
    x = np.clip((uv[:, 0] % 1.0) * (w - 1), 0, w - 1).round().astype(int)
    y = np.clip((1 - uv[:, 1] % 1.0) * (h - 1), 0, h - 1).round().astype(int)
    return image[y, x].astype(float)


# ---------- Quantizing ----------


def kmeans(points, k, weights, iterations=25, seed=0):
    """Weighted k-means (k-means++ start) → labels, centres"""
    rng = np.random.default_rng(seed)
    p = weights / weights.sum()
    centres = [points[rng.choice(len(points), p=p)]]
    for _ in range(1, k):
        d = np.min(((points[:, None, :] - np.array(centres)[None]) ** 2).sum(-1), axis=1) * weights
        if d.sum() == 0:
            break
        centres.append(points[rng.choice(len(points), p=d / d.sum())])
    centres = np.array(centres)
    for _ in range(iterations):
        labels = np.argmin(((points[:, None, :] - centres[None]) ** 2).sum(-1), axis=1)
        moved = np.array([
            np.average(points[labels == i], axis=0, weights=weights[labels == i]) if np.any(labels == i) else centres[i]
            for i in range(len(centres))
        ])
        if np.allclose(moved, centres, atol=0.01):
            break
        centres = moved
    labels = np.argmin(((points[:, None, :] - centres[None]) ** 2).sum(-1), axis=1)
    return labels, centres


def quantize(colours, areas, count=4, palette=None):
    """
    Face colours → (labels, palette RGB). With `palette` (the AMS's colours, sRGB) every face takes the nearest
    one; else `count` colours are found by k-means, weighted by face area so big surfaces decide. Palette entries
    no face uses are kept: their index is the filament slot.
    """
    lab = srgb_to_lab(colours)
    if palette is not None:
        palette = np.asarray(palette, dtype=float)
        labels = np.argmin(((lab[:, None, :] - srgb_to_lab(palette)[None]) ** 2).sum(-1), axis=1)
        return labels, palette
    # k-means on a sample: the clusters settle long before every one of 200,000 faces counts
    rng = np.random.default_rng(0)
    sample = rng.choice(len(lab), size=min(len(lab), 30000), replace=False)
    _labels, centres = kmeans(lab[sample], max(1, min(count, len(lab))), areas[sample])
    labels = np.argmin(((lab[:, None, :] - centres[None]) ** 2).sum(-1), axis=1)
    rgb = np.array([colours[labels == i].mean(axis=0) if np.any(labels == i) else [128, 128, 128]
                    for i in range(len(centres))])
    # Most-used colour first: it becomes filament 1, the object's own
    order = np.argsort([-areas[labels == i].sum() for i in range(len(rgb))])
    remap = np.empty_like(order)
    remap[order] = np.arange(len(order))
    return remap[labels], rgb[order]


def snap(labels, palette, areas, choices, tiers=None, close=6.0, slack=3.0):
    """
    Moves each palette colour to the nearest of `choices` (sRGB, e.g. one Bambu material's colours): colours that
    land on the same choice merge. Returns (labels, palette, indices into `choices`), most-used colour first.

    With `tiers` (one number per choice, lower first), a colour takes the nearest choice of the first tier whose
    nearest is within `close` (Lab ΔE) or no more than `slack` worse than the nearest of all: what is loaded or
    owned before what would have to be bought, even when no choice is close (a loaded black over Bambu's own).
    """
    distance = np.sqrt(((srgb_to_lab(palette)[:, None, :] - srgb_to_lab(choices)[None]) ** 2).sum(-1))
    if tiers is None:
        picks = np.argmin(distance, axis=1)
    else:
        tiers = np.asarray(tiers)
        order = sorted(set(tiers.tolist()))
        picks = []
        for row in distance:
            good_enough = max(close, row.min() + slack)
            for tier in order:
                mine = np.where(tiers == tier)[0]
                best = mine[np.argmin(row[mine])]
                if row[best] <= good_enough:
                    picks.append(best)
                    break
        picks = np.array(picks)
    kept = []
    for pick in picks:
        if pick not in kept:
            kept.append(int(pick))
    labels = np.array([kept.index(int(picks[label])) for label in range(len(palette))])[labels]
    order = np.argsort([-areas[labels == i].sum() for i in range(len(kept))])
    remap = np.empty_like(order)
    remap[order] = np.arange(len(order))
    kept = [kept[i] for i in order]
    return remap[labels], np.asarray(choices, dtype=float)[kept], kept


def clean_islands(mesh, labels, passes=3, min_share=0.5):
    """Majority vote over each face's neighbours, a few times: specks and one-face fringes take the colour around
    them, as a printer couldn't show them anyway"""
    adjacency = mesh.face_adjacency
    labels = labels.copy()
    count = int(labels.max()) + 1
    for _ in range(passes):
        votes = np.zeros((len(labels), count))
        np.add.at(votes, (adjacency[:, 0], labels[adjacency[:, 1]]), 1)
        np.add.at(votes, (adjacency[:, 1], labels[adjacency[:, 0]]), 1)
        total = votes.sum(axis=1)
        best = votes.argmax(axis=1)
        own = votes[np.arange(len(labels)), labels]
        flip = (own == 0) | ((best != labels) & (votes[np.arange(len(labels)), best] >= min_share * total) & (own < total * 0.34))
        labels = np.where(flip & (total > 0), best, labels)
    return labels


# ---------- Bambu 3MF ----------


def paint_code(state):
    """Bambu/Prusa TriangleSelector code for a whole triangle in filament `state` (1-based): its bits, written as
    hex nibbles in reverse. 1 → "4", 2 → "8", 3 → "0C", 4 → "1C" … 18 → "FC\""""
    if state < 3:
        return "%X" % (state << 2)
    return "%XC" % (state - 3)


def write_3mf(path, mesh, labels, palette, name="figure"):
    """The mesh as one object whose triangles carry paint_color (filament label + 1). Bambu Studio maps paint
    state n to its filament n, so the filaments to load are `palette` in order."""
    vertices = "".join(f'<vertex x="{x:.4f}" y="{y:.4f}" z="{z:.4f}"/>' for x, y, z in mesh.vertices)
    codes = [paint_code(int(label) + 1) for label in labels]
    triangles = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}" paint_color="{code}"/>'
                        for (a, b, c), code in zip(mesh.faces, codes))
    colours = " ".join(rgb_to_hex(rgb) for rgb in palette)
    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        f'<metadata name="Title">{name}</metadata>'
        f'<metadata name="Description">Filaments in order: {colours}</metadata>'
        f'<resources><object id="1" type="model" name="{name}"><mesh><vertices>{vertices}</vertices>'
        f'<triangles>{triangles}</triangles></mesh></object></resources>'
        '<build><item objectid="1"/></build></model>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
        'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model)
