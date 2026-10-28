"""
Mesh toolkit for figures (docs/cad.md, "Nhân vật"): loading the figure a job starts from, and the repairs,
decimation and views the export (refine.py) uses. Older jobs' fix.py imported it: `from meshkit import *`.

Every function takes and returns a trimesh.Trimesh in millimetres, Z up, front facing −Y, standing on Z = 0, and
leaves its input alone. A region (box, ball) is a function of points → bool, so it picks vertices and faces alike.
"""

import re
import zipfile
from pathlib import Path

import numpy as np
import trimesh

# The figure as it was before this review, copied from the job it revises
SOURCE = Path("source")
# Faces a finished figure keeps at most (as the mesh worker makes them): enough detail, light for the slicer
MAX_FACES = 200000
# Cells in close_gaps()'s voxel grid at most
GRID_CELLS = 4e7

__all__ = [
    "load", "info", "solid_grid", "box", "ball", "everywhere", "smooth", "remove_bits", "fill_holes", "close_gaps", "repair",
    "cut_below", "place_on_plate", "scale_to_height", "plinth", "cylinder", "capsule", "sphere", "ellipsoid", "block",
    "cone", "union", "subtract", "decimate", "section", "thickness", "zoom", "SIX_VIEWS", "np", "trimesh",
]


# ---------- The figure ----------

def load():
    """The figure as it is now: the coloured 3MF's mesh when there is one (its faces in the order of their
    filaments), else the STL"""
    mesh, _labels = load_painted()
    return mesh


def load_painted():
    """(mesh, filament index per face or None)"""
    painted = SOURCE / "model.3mf"
    if painted.exists():
        return read_3mf(painted)
    # STL repeats every corner per triangle: merged, so the figure is one closed body again
    return trimesh.load(SOURCE / "model.stl", force="mesh", process=True), None


def read_3mf(path):
    """The one painted object colors.write_3mf writes: vertices, triangles and each triangle's filament"""
    import colors

    with zipfile.ZipFile(path) as z:
        model = z.read("3D/3dmodel.model").decode("utf-8")
    vertices = np.array(re.findall(r'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"', model), dtype=float)
    triangles = re.findall(r'<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"(?: paint_color="([^"]*)")?', model)
    faces = np.array([t[:3] for t in triangles], dtype=np.int64)
    states = {colors.paint_code(n): n - 1 for n in range(1, 33)}
    labels = np.array([states.get(t[3], 0) for t in triangles], dtype=int)
    return trimesh.Trimesh(vertices, faces, process=False), labels


def info(mesh):
    """Size, bounds, bodies, whether it is closed, volume, and what stands on the plate"""
    lo, hi = mesh.bounds
    foot = mesh.vertices[mesh.vertices[:, 2] < lo[2] + 0.5]
    return {
        "size_mm": [round(float(v), 2) for v in hi - lo],
        "min_mm": [round(float(v), 2) for v in lo],
        "max_mm": [round(float(v), 2) for v in hi],
        "faces": len(mesh.faces),
        "bodies": int(mesh.body_count),
        "watertight": bool(mesh.is_watertight),
        "volume_cm3": round(float(abs(mesh.volume)) / 1000, 3) if mesh.is_watertight else None,
        # What touches the plate (the lowest 0.5 mm): its extent in X and Y
        "footprint_mm": [round(float(np.ptp(foot[:, 0])), 1), round(float(np.ptp(foot[:, 1])), 1)] if len(foot) else [0, 0],
    }


# ---------- Regions ----------

def box(x=None, y=None, z=None):
    """Points inside a box: each axis (lo, hi) in mm, or None for no limit"""
    limits = [(-np.inf, np.inf) if a is None else a for a in (x, y, z)]

    def inside(points):
        points = np.asarray(points)
        return np.all([(points[:, i] >= lo) & (points[:, i] <= hi) for i, (lo, hi) in enumerate(limits)], axis=0)

    return inside


def ball(center, radius):
    """Points within `radius` mm of `center`"""
    center = np.asarray(center, dtype=float)
    return lambda points: np.linalg.norm(np.asarray(points) - center, axis=1) <= radius


def everywhere(points):
    return np.ones(len(points), dtype=bool)


# ---------- Cleaning up ----------

def smooth(mesh, region=everywhere, iterations=10, strength=0.5, max_move=1.0):
    """Taubin smoothing (keeps the volume) of the vertices in `region`, blended into the rest over one ring of
    neighbours: evens out noise, ragged folds and spikes without shrinking the figure. No vertex moves more than
    `max_move` mm, and bodies of few faces (a plinth, parts added with cylinder() and the like) stay as they are."""
    out = mesh.copy()
    # Shrink then swell, in pairs (trimesh subtracts nu itself)
    trimesh.smoothing.filter_taubin(out, lamb=strength, nu=strength + 0.03, iterations=2 * max(1, iterations // 2))
    weight = region(mesh.vertices).astype(float)
    body = trimesh.graph.connected_component_labels(mesh.face_adjacency, node_count=len(mesh.faces))
    low_poly = np.flatnonzero(np.bincount(body) < 2000)
    weight[mesh.faces[np.isin(body, low_poly)].ravel()] = 0
    if not weight.any():
        return mesh.copy()
    # Neighbours of the region move half as much, so no step shows at its edge
    edges = mesh.edges_unique
    ring = np.zeros(len(weight), dtype=bool)
    ring[edges[weight[edges[:, 0]] > 0, 1]] = True
    ring[edges[weight[edges[:, 1]] > 0, 0]] = True
    weight = np.maximum(weight, ring * 0.5)
    move = (out.vertices - mesh.vertices) * weight[:, None]
    length = np.linalg.norm(move, axis=1)
    move *= np.minimum(1.0, max_move / np.maximum(length, 1e-9))[:, None]
    out.vertices = mesh.vertices + move
    return out


def remove_bits(mesh, min_share=0.02):
    """Drops loose bodies smaller than `min_share` of the largest one (by bounding box diagonal): floating specks,
    shards next to the figure"""
    bodies = mesh.split(only_watertight=False)
    if len(bodies) < 2:
        return mesh.copy()
    sizes = np.array([np.linalg.norm(b.extents) for b in bodies])
    kept = [b for b, s in zip(bodies, sizes) if s >= sizes.max() * min_share]
    return trimesh.util.concatenate(kept)


def repair(mesh, max_hole_edges=1000):
    """Duplicate and degenerate faces out, non-manifold edges and vertices repaired, holes closed, normals out"""
    import pymeshlab

    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(mesh.vertices, mesh.faces))
    ms.meshing_remove_duplicate_vertices()
    ms.meshing_remove_duplicate_faces()
    ms.meshing_remove_null_faces()
    ms.meshing_repair_non_manifold_edges()
    ms.meshing_repair_non_manifold_vertices()
    ms.meshing_close_holes(maxholesize=max_hole_edges)
    ms.meshing_re_orient_faces_coherently()
    current = ms.current_mesh()
    out = trimesh.Trimesh(current.vertex_matrix(), current.face_matrix(), process=True)
    if out.is_watertight and out.volume < 0:
        out.invert()
    return out


def fill_holes(mesh, max_hole_edges=1000):
    return repair(mesh, max_hole_edges)


def solid_grid(mesh, pitch, pad=0):
    """The inside of the mesh as a boolean voxel grid, built from horizontal cross-sections (even-odd, so holes and
    islands inside them come out right); and the position of cell (0, 0, 0) in mm"""
    from skimage.draw import polygon as raster

    lo, hi = mesh.bounds
    shape = np.ceil((hi - lo) / pitch).astype(int) + 1
    heights = lo[2] + (np.arange(shape[2]) + 0.5) * pitch
    grid = np.zeros(shape + 2 * pad, dtype=bool)
    paths = mesh.section_multiplane(plane_origin=[0, 0, 0], plane_normal=[0, 0, 1], heights=heights)
    for k, path in enumerate(paths):
        if path is None:
            continue
        layer = np.zeros(shape[:2], dtype=bool)
        # The sections come back in the plane's own 2D frame: for a horizontal plane at the origin, plain X and Y
        to_3d = path.metadata.get("to_3D", np.eye(4))
        for ring in path.discrete:
            xy = trimesh.transform_points(np.column_stack([ring, np.zeros(len(ring))]), to_3d)[:, :2]
            rows, cols = raster((xy[:, 0] - lo[0]) / pitch, (xy[:, 1] - lo[1]) / pitch, shape[:2])
            layer[rows, cols] ^= True
        grid[pad: pad + shape[0], pad: pad + shape[1], pad + k] = layer
    return grid, lo + np.array([0, 0, 0.5 * pitch]) - pad * pitch


def close_gaps(mesh, gap=0.6, region=everywhere, pitch=None):
    """Fills cracks, slits, pits and holes narrower than about 2 × gap (mm), and bridges parts closer than that
    (fingers, hair strands, a ragged hem, a leg to its plinth), within `region`: a morphological closing on a voxel
    grid of `pitch` mm (default gap / 3, coarser for a large figure). Only the material it adds is meshed and joined
    to the figure, so the surface everywhere else keeps all its detail."""
    from scipy import ndimage
    from skimage import measure

    pitch = pitch or max(0.1, gap / 3, (np.prod(mesh.extents) / GRID_CELLS) ** (1 / 3))
    reach = max(1, int(round(gap / pitch)))
    grid, origin = solid_grid(mesh, pitch, pad=reach + 2)
    ball = np.linalg.norm(np.indices((2 * reach + 1,) * 3) - reach, axis=0) <= reach
    added = ndimage.binary_closing(grid, structure=ball) & ~grid
    if region is not everywhere:
        cells = np.argwhere(added)
        added[tuple(cells[~region(origin + cells * pitch)].T)] = False
    # Crumbs of a few cells are noise along the surface, not gaps
    labels, count = ndimage.label(added)
    if count:
        sizes = ndimage.sum(added, labels, np.arange(1, count + 1))
        added = np.isin(labels, np.flatnonzero(sizes >= 27) + 1)
    if not added.any():
        return mesh.copy()
    # Two cells into the figure (never out of it), so the filling still overlaps what it fills once smoothed
    added = ndimage.binary_dilation(added, iterations=2) & (grid | added)
    vertices, faces, _normals, _values = measure.marching_cubes(np.pad(added, 1).astype(np.float32), 0.5)
    patch = trimesh.Trimesh(origin + (vertices - 1) * pitch, faces, process=True)
    patch.fix_normals()
    # The grid's steps evened out
    trimesh.smoothing.filter_taubin(patch, lamb=0.5, nu=0.53, iterations=6)
    return union(mesh, *patch.split(only_watertight=False))


def decimate(mesh, faces=MAX_FACES):
    """Quadric edge collapse down to `faces`, keeping the shape"""
    import pymeshlab

    if len(mesh.faces) <= faces:
        return mesh.copy()
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(mesh.vertices, mesh.faces))
    ms.meshing_decimation_quadric_edge_collapse(targetfacenum=int(faces), preservenormal=True, planarquadric=True)
    current = ms.current_mesh()
    return trimesh.Trimesh(current.vertex_matrix(), current.face_matrix(), process=True)


# ---------- Placing ----------

def cut_below(mesh, z):
    """Everything under height `z` cut away, the cut capped flat (a flat sole or underside to stand on)"""
    out = mesh.slice_plane([0, 0, z], [0, 0, 1], cap=True)
    return out if out is not None and len(out.faces) else mesh.copy()


def place_on_plate(mesh, centre=True):
    """Lowest point to Z = 0, and with `centre` the X/Y middle of the bounds to the plate's origin"""
    out = mesh.copy()
    lo, hi = out.bounds
    out.apply_translation([-(lo[0] + hi[0]) / 2 if centre else 0, -(lo[1] + hi[1]) / 2 if centre else 0, -lo[2]])
    return out


def scale_to_height(mesh, height_mm):
    """Uniformly scaled to `height_mm` tall, then placed on the plate"""
    out = mesh.copy()
    out.apply_scale(height_mm / out.extents[2])
    return place_on_plate(out)


def plinth(mesh, radius=None, thickness=None, overlap=0.6):
    """A round plinth under the figure (centred under its bounds), the figure lowered `overlap` mm into it. Default
    radius: 0.6 × the figure's larger X/Y extent; thickness: 4 % of its height, at least 2 mm"""
    lo, hi = mesh.bounds
    radius = radius or max(hi[0] - lo[0], hi[1] - lo[1]) * 0.6
    thickness = thickness or max(2.0, (hi[2] - lo[2]) * 0.04)
    disc = trimesh.creation.cylinder(radius=radius, height=thickness, sections=96)
    disc.apply_translation([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, thickness / 2])
    figure = mesh.copy()
    figure.apply_translation([0, 0, thickness - overlap - lo[2]])
    return union(disc, figure)


# ---------- New parts (mm) ----------

def cylinder(a, b, radius, sections=48):
    """A cylinder from point a to point b"""
    return trimesh.creation.cylinder(radius=radius, segment=[a, b], sections=sections)


def capsule(a, b, radius):
    """A cylinder with round ends from a to b: limbs, ankles, a support rod"""
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    length = float(np.linalg.norm(b - a))
    part = trimesh.creation.capsule(height=max(length, 1e-3), radius=radius, count=[24, 24])
    # trimesh's capsule runs along Z from 0 to its height
    part.apply_transform(trimesh.geometry.align_vectors([0, 0, 1], (b - a) / (length or 1)))
    part.apply_translation(a)
    return part


def sphere(center, radius):
    part = trimesh.creation.icosphere(subdivisions=3, radius=radius)
    part.apply_translation(center)
    return part


def ellipsoid(center, radii):
    """A sphere stretched to `radii` (x, y, z): a foot, a hand, a boot toe"""
    part = trimesh.creation.icosphere(subdivisions=3, radius=1.0)
    part.apply_scale(radii)
    part.apply_translation(center)
    return part


def block(lo, hi):
    """A box between two corners"""
    lo, hi = np.asarray(lo, dtype=float), np.asarray(hi, dtype=float)
    return trimesh.creation.box(extents=hi - lo, transform=trimesh.transformations.translation_matrix((lo + hi) / 2))


def cone(a, b, radius_a, radius_b, sections=48):
    """A truncated cone from a (radius_a) to b (radius_b)"""
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    length = float(np.linalg.norm(b - a))
    angles = np.linspace(0, 2 * np.pi, sections, endpoint=False)
    ring = np.column_stack([np.cos(angles), np.sin(angles), np.zeros(sections)])
    vertices = np.vstack([ring * [radius_a, radius_a, 0], ring * [radius_b, radius_b, 0] + [0, 0, length]])
    hull = trimesh.Trimesh(vertices).convex_hull
    hull.apply_transform(trimesh.geometry.align_vectors([0, 0, 1], (b - a) / (length or 1)))
    hull.apply_translation(a)
    return hull


def union(*meshes):
    """One solid (manifold3d) of the closed meshes; one that is not closed is only put with it, overlapping: the
    slicer joins overlapping shells, so they still print as one"""
    meshes = [m for m in meshes if m is not None and len(m.faces)]
    closed = [m for m in meshes if m.is_watertight]
    rest = [m for m in meshes if not m.is_watertight]
    if len(closed) > 1:
        try:
            closed = [trimesh.boolean.union(closed, engine="manifold")]
        except Exception:  # noqa: BLE001 - manifold3d missing or refusing the input: overlap instead
            pass
    parts = closed + rest
    return parts[0].copy() if len(parts) == 1 else trimesh.util.concatenate(parts)


def subtract(mesh, cutter):
    """`mesh` with `cutter` taken out (both must be closed)"""
    return trimesh.boolean.difference([mesh, cutter], engine="manifold")


# ---------- Measuring and looking ----------

def section(mesh, z):
    """The cross-section at height z: each separate part (two legs, a tail) with its centre, size and area, largest
    first. Where a new part (a foot, a support) has to meet the figure."""
    path = mesh.section(plane_origin=[0, 0, z], plane_normal=[0, 0, 1])
    if path is None:
        return {"z": z, "parts": []}
    planar, to_3d = path.to_2D()
    parts = []
    for polygon in sorted(planar.polygons_full, key=lambda p: -p.area):
        x0, y0, x1, y1 = polygon.bounds
        corners = trimesh.transform_points([[x0, y0, 0], [x1, y1, 0], [*polygon.centroid.coords[0], 0]], to_3d)
        size = np.abs(corners[1] - corners[0])
        parts.append({"center": [round(float(c), 1) for c in corners[2][:2]],
                      "size_mm": [round(float(size[0]), 1), round(float(size[1]), 1)],
                      "area_mm2": round(float(polygon.area), 1)})
    return {"z": z, "parts": parts}


def thickness(mesh, region=everywhere, samples=2000):
    """Wall thickness at random points of the surface in `region` (ray from each point straight in, to the other
    side): percentiles in mm, and where the thinnest are. Under ~1 mm breaks or does not print with a 0.4 mm
    nozzle."""
    points, faces = trimesh.sample.sample_surface(mesh, samples * 3, seed=1)
    keep = region(points)
    points, faces = points[keep][:samples], faces[keep][:samples]
    if not len(points):
        return {"samples": 0}
    inward = -mesh.face_normals[faces]
    hits, rays, _ = mesh.ray.intersects_location(points + inward * 0.01, inward, multiple_hits=False)
    depth = np.full(len(points), np.nan)
    depth[rays] = np.linalg.norm(hits - points[rays], axis=1)
    found = ~np.isnan(depth)
    if not found.any():
        return {"samples": 0}
    order = np.argsort(depth[found])[:5]
    return {
        "samples": int(found.sum()),
        "p5_mm": round(float(np.percentile(depth[found], 5)), 2),
        "median_mm": round(float(np.median(depth[found])), 2),
        "under_1mm_share": round(float(np.mean(depth[found] < 1.0)), 3),
        "thinnest_at": [[round(float(c), 1) for c in p] for p in points[found][order]],
    }


def zoom(mesh, region, path, views=None):
    """Only the faces in `region`, from six sides (or `views`, see build.VIEWS): a close look at feet, hands, a
    face. Written to `path` (a PNG to Read)."""
    import build  # cad/build.py

    part = mesh.submesh([np.flatnonzero(region(mesh.triangles_center))], append=True)
    if not len(part.faces):
        raise ValueError("zoom: no faces in that region")
    build.render_preview(part.triangles.tolist(), part.extents, str(path), views=views or SIX_VIEWS)


# The six sides Claude reviews a figure from (title, elevation, azimuth, axis looked along)
SIX_VIEWS = [
    ("Front (−Y)", 0, -90, "y"), ("Back (+Y)", 0, 90, "y"), ("Left (−X)", 0, 180, "x"),
    ("Right (+X)", 0, 0, "x"), ("Isometric front", 25, -60, None), ("Isometric back", 25, 120, None),
]
