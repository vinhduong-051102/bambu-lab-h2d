"""
Colour for printed figures (docs/cad.md): one filament per face → a 3MF that Bambu Studio opens with the faces
already painted.

- srgb_to_lab(), nearest_filament(): which filament a colour of the picture prints as
- write_3mf(): the mesh with Bambu's paint_color on every triangle
"""

import zipfile

import numpy as np

# ---------- Filaments ----------


def hex_to_rgb(value):
    value = value.lstrip("#")[:6]
    return [int(value[i: i + 2], 16) for i in (0, 2, 4)]


def rgb_to_hex(rgb):
    return "#" + "".join(f"{int(round(v)):02X}" for v in rgb)


def srgb_to_lab(rgb):
    """sRGB 0–255 (…, 3) → CIELAB (D65), where distances are about how different colours look"""
    c = np.asarray(rgb, dtype=float) / 255
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = c @ np.array([[0.4124, 0.2126, 0.0193], [0.3576, 0.7152, 0.1192], [0.1805, 0.0722, 0.9505]])
    xyz /= np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def nearest_filament(rgb, palette, lightness=0.6):
    """The palette entry (index) nearest each colour. Lightness counts less than hue: the picture's shading makes a
    shaded sleeve darker, not another filament"""
    lab, pal = srgb_to_lab(rgb), srgb_to_lab(palette)
    weight = np.array([lightness, 1.0, 1.0])
    return np.argmin((((lab[:, None, :] - pal[None, :, :]) * weight) ** 2).sum(-1), axis=1)


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
