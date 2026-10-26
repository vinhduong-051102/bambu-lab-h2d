# Reviewing and fixing an AI-made figure

The figure came from Hunyuan3D-2: a picture (uploaded, or drawn by an AI) turned into a mesh, then made
printable by the mesh worker: Z up, the subject's front facing −Y, scaled to the height asked for (the plinth not
counted), centred on the plate at Z = 0, often standing in a round plinth that overlaps it by 0.6 mm. Sizes are
in millimetres. It prints on a Bambu Lab H2D with a 0.4 mm nozzle, usually in PLA.

## What usually goes wrong

Look for these, worst first:

1. **It cannot stand or stick.** Feet cut off at the ankle or tapering to points (the picture's feet were hidden,
   blurred, or floating), a figure that leans past its footprint, very little touching the plate or the plinth.
   `section(m, z)` just above the plate or plinth shows how much stands there; `info(m)["footprint_mm"]`.
2. **Parts that break off or float.** Loose bodies (`report.json` warns), a hand or weapon joined by a sliver,
   parts under ~1 mm thick (`thickness()`), long thin spikes of hair.
3. **Rough, crumpled surfaces.** Glow, aura, motion lines, smoke, sparkles or a busy background in the picture
   become crumpled noise, pits and ragged sheets on the mesh; in `views.png` they show as dark speckles and
   crease lines. Usually on clothes, hair and hands.
4. **Holes, slits and cracks** between parts that should be one (arm to body, hair to head, fingers), or pits in
   the surface.
5. **Wrong against the picture.** A missing limb, a face that came out flat, the back side guessed badly. Small
   things can be modelled back with primitives; large ones cannot: say so, a new figure from another picture or
   seed is the better way.

Do not "fix" what is meant to be there: a pose with one foot raised, a cape, a sword the user wants. Keep the
height, the pose and the proportions.

## meshkit

`from meshkit import *` gives the functions below, `np` and `trimesh`. Every function returns a new
`trimesh.Trimesh` (mm) and leaves its input alone. A region is `box(x=(lo, hi), y=…, z=…)` (any axis left out is
unlimited), `ball(center, radius)` or `everywhere`; it applies to vertices and faces alike.

| | |
| --- | --- |
| `load()` | The figure as it is now |
| `info(m)` | size, bounds, faces, bodies, watertight, volume, footprint on the plate |
| `section(m, z)` | The cross-section at height z: each part (two legs…) with `center` [x, y], `size_mm`, `area_mm2` |
| `thickness(m, region)` | Wall thickness percentiles in a region, share under 1 mm, where the thinnest are |
| `zoom(m, region, "out/zoom_x.png")` | Six views of only the faces in a region: then Read the PNG |
| `smooth(m, region, iterations=10, strength=0.5, max_move=1.0)` | Taubin smoothing (keeps volume) in a region, faded out at its edge. Light noise: 10–20 iterations; crumpled clothes and aura: 30–60 with `max_move=1.5`. Never moves the plinth or added primitives |
| `close_gaps(m, gap=0.6, region)` | Fills slits, pits and holes narrower than about 2 × gap and bridges parts closer than that; only adds material, the surface elsewhere keeps its detail. 0.4–0.6 for cracks, 1.0–1.5 for ragged folds and crumpled areas (then smooth the region) |
| `remove_bits(m, min_share=0.02)` | Drops loose bodies smaller than 2 % of the largest |
| `repair(m)` / `fill_holes(m)` | Removes broken faces, closes open holes, orients normals |
| `union(*meshes)` | One solid from overlapping closed meshes (manifold3d) |
| `subtract(m, cutter)` | Cuts a closed shape out |
| `cylinder(a, b, r)`, `capsule(a, b, r)`, `cone(a, b, ra, rb)`, `sphere(c, r)`, `ellipsoid(c, (rx, ry, rz))`, `block(lo, hi)` | Primitives, points as [x, y, z] |
| `cut_below(m, z)` | Cuts everything below z away and caps it flat: a flat sole to stand on |
| `plinth(m, radius=None, thickness=None)` | Adds a round plinth under a figure that has none |
| `place_on_plate(m)` | Lowest point to Z = 0, centred: end with it whenever the shape moved down or up |
| `scale_to_height(m, h)` | Uniform scale to h mm tall, on the plate |
| `decimate(m, faces)` | Fewer faces; the runner does this itself above 300 000 |

The figure keeps its filaments: every face takes the colour of the old face under it, and new material (a foot,
a filled gap more than 1 mm from the old surface) takes the main colour. To paint new parts another filament,
set `paints = [(region, n)]` in fix.py (n is filament n of `report.json` → `palette`, from 1).

## Recipes

Feet cut off at the ankles, standing in a plinth:

```python
from meshkit import *
m = load()
legs = section(m, 6)["parts"][:2]          # just above the plinth top; check the z against views.png
print(legs)
# A boot or foot under each leg: front of the foot towards −Y, sunk into the plinth so they join
feet = [ellipsoid([p["center"][0], p["center"][1] - 2, 5], (4.5, 7.5, 3)) for p in legs]
m = union(m, *feet)
m = close_gaps(m, gap=0.6, region=box(z=(0, 15)))   # blends leg into foot
result = place_on_plate(m)
```

Crumpled, aura-ridden trousers and hair:

```python
m = close_gaps(m, gap=1.2, region=box(z=(4, 48)))
m = smooth(m, box(z=(4, 48)), iterations=40, max_move=1.5)
m = smooth(m, box(z=(62, 90)), iterations=20)
```

A hand joined by a sliver: `union(m, capsule(wrist, forearm, 1.5))`. A figure that leans: a `capsule` support
from the plate or plinth to its lowest overhang, or `plinth(m)` when it has none. Loose specks: `remove_bits(m)`.

## The runner

`python /opt/mesh3d/refine.py fix.py` runs fix.py (it must assign `result`), then writes `out/model.stl`,
`out/model.3mf` (when coloured), `out/preview.png` (four views, for the dashboard), `out/views.png` (six sides,
for you) and `out/report.json`, which it also prints: size, bodies (`solids`), mesh check, warnings, and
`changes` against the figure it started from. One run takes 15–40 s. Warnings to act on: loose bits, not
watertight, not on the plate, very little touching the plate. Anything you `print()` in fix.py comes first.

In `views.png` dark speckles and crease lines mean a rough, crumpled surface; a figure's own colours show when it
is coloured. Compare the six sides with the picture: the back is the model's guess, so judge it only as
printable and plausible.
