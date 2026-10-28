"""
The picture's colours on a figure Hunyuan3D-2 shaped from it (docs/cad.md, "Tô màu"). Each view (the front
picture, and with "Dựng nhiều góc" the left, back and right ones) is laid over the printable mesh the way its
camera saw it: the figure's outline in the view fitted to the picture's. Every face takes the colour of the view
that faces it most squarely and sees it (a depth test hides what is behind); faces no view sees take the colour of
the nearest face that one does.

- project(): those colours, as face centres and sRGB, into work/picture.npz: blender_session.py shows them on the
  figure, and figure_mcp.py's paint_from_picture gives each face the filament nearest its colour
- dominant(): the picture's main colours by area, for Claude's brief
"""

import numpy as np

# The printable mesh: Z up, the subject's front towards −Y. Each view's camera as (looking along, image right)
CAMERAS = {
    "front": ((0, 1, 0), (1, 0, 0)),
    "back": ((0, -1, 0), (-1, 0, 0)),
    "+x": ((-1, 0, 0), (0, 1, 0)),
    "-x": ((1, 0, 0), (0, -1, 0)),
}
# The depth test's grid: the figure about this many cells tall
DEPTH_ROWS = 220
# Fitting a picture to the figure's outline: on a copy this many rows tall
FIT_ROWS = 200
# Faces turned further than this from a camera (cosine) take their colour from a view that faces them better
MIN_FACING = 0.15
# Faces no view sees take the colour of the nearest one seen at least this squarely
SQUARE_FACING = 0.5


def outline(points, right, rows, cols, fit):
    """The cells the figure covers in a view (rows × cols), its points placed with `fit`"""
    from scipy import ndimage

    r, c = place(points, right, fit)
    r, c = np.clip(r, 0, rows - 1), np.clip(c, 0, cols - 1)
    mask = np.zeros((rows, cols), bool)
    mask[r, c] = True
    return ndimage.binary_fill_holes(ndimage.binary_closing(mask, iterations=2))


def place(points, right, fit):
    """Points → (row, col) of a picture, by fit = (pixels per mm, centre u, centre z, centre col, centre row)"""
    scale, u0, z0, c0, r0 = fit
    u = points @ np.asarray(right, float)
    return (np.round(r0 - (points[:, 2] - z0) * scale).astype(int),
            np.round(c0 + (u - u0) * scale).astype(int))


def fitting(points, right, alpha, refine=True):
    """How a view's picture sits on the figure: its outline's height and centre on the figure's, then slid and
    scaled until the figure's outline covers the picture's best (the AI's shape is not exactly the picture's
    projection: wisps of smoke or a cloud widen one outline and not the other)"""
    rows, cols = np.nonzero(alpha)
    u = points @ np.asarray(right, float)
    z = points[:, 2]
    scale = (rows.max() - rows.min() + 1) / max(np.ptp(z), 1e-6)
    fit = [scale, (u.min() + u.max()) / 2, (z.min() + z.max()) / 2,
           (cols.min() + cols.max()) / 2, (rows.min() + rows.max()) / 2]
    if not refine:
        return tuple(fit)
    from PIL import Image

    # On a small copy: about FIT_ROWS rows
    k = FIT_ROWS / alpha.shape[0]
    small = np.asarray(Image.fromarray(alpha.astype(np.uint8) * 255).resize(
        (max(8, round(alpha.shape[1] * k)), FIT_ROWS), Image.NEAREST)) > 127
    sample = points[np.random.default_rng(1).choice(len(points), size=min(60000, len(points)), replace=False)]

    def overlap(f):
        shape = outline(sample, right, *small.shape, (f[0] * k, f[1], f[2], f[3] * k, f[4] * k))
        return (shape & small).sum() / max((shape | small).sum(), 1)

    best = overlap(fit)
    height = rows.max() - rows.min() + 1
    # Coordinate descent: the offsets in pixels, the scale in steps, finer each round
    for step in (0.08, 0.04, 0.02, 0.01):
        improved = True
        while improved:
            improved = False
            for i, delta in ((3, height * step), (3, -height * step), (4, height * step), (4, -height * step),
                             (0, fit[0] * step), (0, -fit[0] * step)):
                trial = list(fit)
                trial[i] += delta
                score = overlap(trial)
                if score > best + 1e-4:
                    fit, best, improved = trial, score, True
    return tuple(fit)


def side_camera(mesh, alpha):
    """Which side a side view shows (+x or -x): the camera whose outline of the figure matches the picture's (the two
    are mirror images, and a figure's profile is not symmetric front to back)"""
    small = shrink(alpha, DEPTH_ROWS)
    best, best_iou = "+x", -1.0
    for name in ("+x", "-x"):
        right = CAMERAS[name][1]
        fit = fitting(mesh.vertices, right, small, refine=False)
        shape = outline(mesh.vertices, right, *small.shape, fit)
        iou = (shape & small).sum() / max((shape | small).sum(), 1)
        if iou > best_iou:
            best, best_iou = name, iou
    return best


def shrink(alpha, rows):
    """A mask cut to its outline (with a margin) and scaled to about `rows` rows"""
    from PIL import Image

    ys, xs = np.nonzero(alpha)
    pad = max(2, (ys.max() - ys.min()) // 20)
    crop = alpha[max(0, ys.min() - pad): ys.max() + pad + 1, max(0, xs.min() - pad): xs.max() + pad + 1]
    scale = rows / crop.shape[0]
    size = (max(8, round(crop.shape[1] * scale)), rows)
    return np.asarray(Image.fromarray(crop.astype(np.uint8) * 255).resize(size, Image.NEAREST)) > 127


def project(mesh, views, path):
    """The colours `views` ({"front", optionally "left", "back", "right"}: RGBA PIL images, background removed) give
    the faces of `mesh`, saved to `path`. Returns the colour of every face (sRGB, n × 3)."""
    from PIL import ImageFilter
    from scipy import ndimage
    from scipy.spatial import cKDTree

    centres, normals = mesh.triangles_center, mesh.face_normals
    height = float(np.ptp(mesh.vertices[:, 2]))
    best = np.full(len(centres), MIN_FACING)
    rgb = np.zeros((len(centres), 3))
    seen = np.zeros(len(centres), bool)

    cameras = {"front": "front", "back": "back"}
    sides = [tag for tag in ("left", "right") if tag in views]
    if sides:
        first = side_camera(mesh, np.asarray(views[sides[0]].convert("RGBA"))[..., 3] > 127)
        cameras[sides[0]] = first
        if len(sides) > 1:
            cameras[sides[1]] = "-x" if first == "+x" else "+x"

    for tag, image in views.items():
        forward, right = (np.asarray(v, float) for v in CAMERAS[cameras[tag]])
        rgba = np.asarray(image.convert("RGBA"))
        alpha = rgba[..., 3] > 127
        if alpha.sum() < 100:
            continue
        # Colours a little blurred, so one stray pixel does not decide a face
        colour = np.asarray(image.convert("RGB").filter(ImageFilter.BoxBlur(1)), dtype=float)
        fit = fitting(mesh.vertices, right, alpha)
        r, c = place(centres, right, fit)
        inside = (r >= 0) & (r < alpha.shape[0]) & (c >= 0) & (c < alpha.shape[1])
        # Not the picture's outermost pixels: a drawing's outline is dark, and the outlines of the figure and the
        # picture never match to the pixel
        rows = np.nonzero(alpha.any(axis=1))[0]
        core = ndimage.binary_erosion(alpha, iterations=max(2, int(np.ptp(rows) / 120)))
        on_figure = np.zeros(len(centres), bool)
        on_figure[inside] = core[r[inside], c[inside]]

        # The depth test, on a coarse grid: a face is seen when nothing nearer the camera covers its cell
        coarse = DEPTH_ROWS / max(np.ptp(r[inside]) if inside.any() else 1, 1)
        cells = (np.round(r * coarse).astype(int), np.round(c * coarse).astype(int))
        depth = centres @ forward
        lo_r, lo_c = cells[0].min(), cells[1].min()
        grid = np.full((cells[0].max() - lo_r + 1, cells[1].max() - lo_c + 1), np.inf)
        np.minimum.at(grid, (cells[0] - lo_r, cells[1] - lo_c), depth)
        visible = depth <= grid[cells[0] - lo_r, cells[1] - lo_c] + height * 0.02

        facing = normals @ -forward
        take = on_figure & visible & (facing > best)
        best[take] = facing[take]
        rgb[take] = colour[r[take], c[take]]
        seen |= take

    if not seen.any():
        raise ValueError("No view of the picture lines up with the figure")
    if not seen.all():
        # From the nearest face a view saw squarely: grazing faces at the edge of a view carry its outline
        square = seen & (best >= SQUARE_FACING) if np.count_nonzero(seen & (best >= SQUARE_FACING)) else seen
        _distance, nearest = cKDTree(centres[square]).query(centres[~seen])
        rgb[~seen] = rgb[square][nearest]
    # How far a face may have moved from where the picture was laid on (paint_from_picture reports those further)
    reach = max(1.5, height * 0.04)
    np.savez_compressed(path, points=centres.astype(np.float32), rgb=rgb.astype(np.uint8), reach=reach)
    return rgb


def dominant(mesh, rgb, count=6):
    """The main colours of the figure's faces by area: [(hex, share)], largest first, those under 2 % left out"""
    import colors
    from scipy.cluster.vq import kmeans2

    rng = np.random.default_rng(1)
    weights = mesh.area_faces / mesh.area_faces.sum()
    pick = rng.choice(len(rgb), size=min(20000, len(rgb)), p=weights)
    lab = colors.srgb_to_lab(rgb[pick])
    centres, assigned = kmeans2(lab, min(count, len(np.unique(rgb[pick], axis=0))), minit="++", seed=1)
    out = []
    for k in range(len(centres)):
        mine = assigned == k
        if mine.mean() >= 0.02:
            out.append((colors.rgb_to_hex(np.median(rgb[pick][mine], axis=0)), float(mine.mean())))
    return sorted(out, key=lambda entry: -entry[1])
