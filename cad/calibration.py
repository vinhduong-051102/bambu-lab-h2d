"""
Tolerance calibration print (docs/cad.md, "Hiệu chuẩn dung sai"): measured with calipers, it gives the printer's real
hole_shrink_mm, shaft_growth_mm, xy_tolerance_mm and min_clearance_mm for fit analysis.

Four bodies, all on Z = 0, printed without supports:
  - the plate: a row of vertical holes Ø3…Ø12 mm, a row of pins of the same diameters, and a row of U-slots open
    at the front edge, each the loose pin's diameter plus 2 × a clearance of 0.1…0.5 mm; every feature has its
    number engraved behind it (towards +Y)
  - the loose pin (Ø6 by default), tried in each slot
  - a 20 × 20 × 10 block, measured in X, Y and Z
  - a block with horizontal holes Ø6 and Ø10 along Y, for how holes printed on their side come out

From a CAD job's model.py (build.py runs it from /opt/cad, so the module imports) or the API's /api/cad/builds:

    from calibration import calibration_plate
    result = calibration_plate()                          # the defaults
    result = calibration_plate(clearances=[0.15, 0.2, 0.25, 0.3])

Built on its own: python /opt/cad/build.py /opt/cad/calibration.py <out dir>
"""

import os

DEFAULTS = {
    "hole_diameters": [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    # Radial gap per side between the loose pin and a slot: the slot is pin + 2 × clearance wide
    "clearances": [0.1, 0.2, 0.3, 0.4, 0.5],
    "fit_pin_diameter": 6.0,
    "fit_pin_height": 12.0,
    "plate_thickness": 4.0,
    "pin_height": 10.0,
    # From the front edge to the end of a slot's round end
    "slot_length": 12.0,
    "block_size": (20.0, 20.0, 10.0),
    "horizontal_holes": [6, 10],
    # Material between neighbouring features, and around the plate's edge
    "gap": 5.0,
    "margin": 6.0,
    # Engraved numbers: font size (digits come out ~0.73 of it tall) and depth
    "label_size": 7.0,
    "label_depth": 0.6,
}

# Space between the parts placed beside the plate
SPACING = 8.0
LABEL_FONT = "DejaVuSans-Bold.ttf"


def font_path():
    """A bold sans font that the cad image has (matplotlib's): build123d's default Arial isn't installed"""
    try:
        import matplotlib

        path = os.path.join(matplotlib.get_data_path(), "fonts", "ttf", LABEL_FONT)
        return path if os.path.exists(path) else None
    except ImportError:
        return None


def label_text(value):
    return f"{value:g}" if value >= 1 else f"{value:.1f}"


def layout(**overrides):
    """Where every feature goes, in mm: the plate's size, and for each hole, pin, slot, block and the loose pin
    its centre and nominal size. The geometry is built from this, and tests measure against it."""
    p = {**DEFAULTS, **overrides}
    unknown = set(overrides) - set(DEFAULTS)
    if unknown:
        raise ValueError(f"Unknown calibration parameters: {', '.join(sorted(unknown))}")
    diameters = [float(d) for d in p["hole_diameters"]]
    gap, margin, label = p["gap"], p["margin"], p["label_size"]

    xs, x = [], margin
    for i, d in enumerate(diameters):
        x += d / 2 if i == 0 else (diameters[i - 1] + d) / 2 + gap
        xs.append(x)
    largest = max(diameters)
    slot_widths = [p["fit_pin_diameter"] + 2 * c for c in p["clearances"]]
    slot_pitch = max(slot_widths) + gap * 2

    # Rows from the front edge (Y = 0): slots, their numbers, holes, their numbers, pins, their numbers
    slot_label_y = p["slot_length"] + gap / 2 + label / 2
    hole_y = slot_label_y + label / 2 + gap + largest / 2
    hole_label_y = hole_y + largest / 2 + gap / 2 + label / 2
    pin_y = hole_label_y + label / 2 + gap + largest / 2
    pin_label_y = pin_y + largest / 2 + gap / 2 + label / 2
    depth = pin_label_y + label / 2 + margin / 2
    width = max(xs[-1] + diameters[-1] / 2 + margin, margin * 2 + slot_pitch * len(slot_widths))

    side_x = width + SPACING
    bx, by, bz = p["block_size"]
    holes_h = [float(d) for d in p["horizontal_holes"]]
    cross_wall = 3.0
    cross_height = max(holes_h) + 2 * cross_wall
    cross_xs, cx = [], side_x + gap
    for i, d in enumerate(holes_h):
        cx += d / 2 if i == 0 else (holes_h[i - 1] + d) / 2 + gap
        cross_xs.append(cx)
    cross_width = cross_xs[-1] + holes_h[-1] / 2 + gap - side_x
    cross_y = by + SPACING

    return {
        "params": p,
        "plate": {"min": (0.0, 0.0, 0.0), "size": (width, depth, p["plate_thickness"])},
        "holes": [{"diameter": d, "centre": (x, hole_y), "label": label_text(d), "label_at": (x, hole_label_y)}
                  for d, x in zip(diameters, xs)],
        "pins": [{"diameter": d, "centre": (x, pin_y), "height": p["pin_height"], "label": label_text(d),
                  "label_at": (x, pin_label_y)} for d, x in zip(diameters, xs)],
        "slots": [{"clearance": c, "width": w, "centre_x": margin + slot_pitch * (i + 0.5),
                   "length": p["slot_length"], "label": label_text(c),
                   "label_at": (margin + slot_pitch * (i + 0.5), slot_label_y)}
                  for i, (c, w) in enumerate(zip(p["clearances"], slot_widths))],
        "block": {"min": (side_x, 0.0, 0.0), "size": (bx, by, bz)},
        "cross": {"min": (side_x, cross_y, 0.0), "size": (cross_width, 10.0, cross_height),
                  "holes": [{"diameter": d, "centre_xz": (x, cross_height / 2), "label": label_text(d)}
                            for d, x in zip(holes_h, cross_xs)]},
        "fit_pin": {"diameter": p["fit_pin_diameter"], "height": p["fit_pin_height"],
                    "centre": (side_x + p["fit_pin_diameter"] / 2 + 2,
                               cross_y + 10.0 + SPACING + p["fit_pin_diameter"] / 2)},
    }


def engrave(part, texts, top_z, size, depth):
    """Cuts each (text, (x, y)) into the face at top_z"""
    from build123d import Align, Location, Text, extrude

    font = font_path()
    for text, (x, y) in texts:
        kwargs = {"font_path": font} if font else {}
        letters = Text(text, font_size=size, align=(Align.CENTER, Align.CENTER), **kwargs)
        part -= extrude(letters, amount=depth + 0.1).moved(Location((x, y, top_z - depth)))
    return part


def calibration_plate(**overrides):
    """The four bodies as one Compound, each a labelled child: plate, fit_pin, xy_block, horizontal_holes"""
    from build123d import Align, Axis, Box, Compound, Cylinder, Location, Pos, Rot

    spec = layout(**overrides)
    p = spec["params"]
    t = p["plate_thickness"]
    width, depth, _ = spec["plate"]["size"]
    low = (Align.MIN, Align.MIN, Align.MIN)

    plate = Box(width, depth, t, align=low)
    for hole in spec["holes"]:
        x, y = hole["centre"]
        plate -= Pos(x, y, -1) * Cylinder(hole["diameter"] / 2, t + 2, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for slot in spec["slots"]:
        w, x, length = slot["width"], slot["centre_x"], slot["length"]
        # Straight from beyond the front edge to the round end's centre, then the round end
        plate -= Pos(x, -1, -1) * Box(w, length - w / 2 + 1, t + 2, align=(Align.CENTER, Align.MIN, Align.MIN))
        plate -= Pos(x, length - w / 2, -1) * Cylinder(w / 2, t + 2, align=(Align.CENTER, Align.CENTER, Align.MIN))
    plate = engrave(plate, [(f["label"], f["label_at"]) for f in spec["holes"] + spec["pins"] + spec["slots"]],
                    t, p["label_size"], p["label_depth"])
    for pin in spec["pins"]:
        x, y = pin["centre"]
        # Down into the plate a little, so pin and plate fuse into one solid
        plate += Pos(x, y, t - 0.5) * Cylinder(pin["diameter"] / 2, pin["height"] + 0.5,
                                               align=(Align.CENTER, Align.CENTER, Align.MIN))
    plate.label = "plate"

    fit = spec["fit_pin"]
    fit_pin = Pos(*fit["centre"], 0) * Cylinder(fit["diameter"] / 2, fit["height"],
                                                 align=(Align.CENTER, Align.CENTER, Align.MIN))
    fit_pin.label = "fit_pin"

    block = Pos(*spec["block"]["min"]) * Box(*spec["block"]["size"], align=low)
    block.label = "xy_block"

    cross_spec = spec["cross"]
    cx, cy, _ = cross_spec["min"]
    sx, sy, sz = cross_spec["size"]
    cross = Pos(cx, cy, 0) * Box(sx, sy, sz, align=low)
    for hole in cross_spec["holes"]:
        x, z = hole["centre_xz"]
        cross -= Location((x, cy - 1, z)) * Rot(-90, 0, 0) * Cylinder(
            hole["diameter"] / 2, sy + 2, align=(Align.CENTER, Align.CENTER, Align.MIN))
    cross = engrave(cross, [(h["label"], (h["centre_xz"][0], cy + sy / 2)) for h in cross_spec["holes"]],
                    sz, p["label_size"], p["label_depth"])
    cross.label = "horizontal_holes"

    parts = []
    for part in (plate, fit_pin, block, cross):
        # Booleans can leave a Compound of one solid: keep the solid with its name
        solid = part.solids().sort_by(Axis.Z)[0] if len(part.solids()) == 1 else part
        solid.label = part.label
        parts.append(solid)
    result = Compound(children=parts)
    result.label = "calibration"
    return result


if __name__ in ("__main__", "__model__"):
    result = calibration_plate()
