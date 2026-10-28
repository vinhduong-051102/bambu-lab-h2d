# Engineering analysis of 3D-printed parts (Phân tích kỹ thuật)

Claude checks a technical part or assembly before it is printed: its geometry, its mesh, how its parts fit and move,
how it bears a load, and how it will print. Everything runs on this computer, in the mesh3d container, through the
`bambu-cad` MCP server. Each question goes to the engine that can answer it:

| Question | Engine | Where |
|---|---|---|
| Geometry, mesh defects, overlaps, holes and shafts, gaps, wall thickness | trimesh, manifold3d (booleans), pymeshlab (self-intersections) | `mesh3d/eng/geometry.py`, `assembly.py`, `clearance.py` |
| Motion: rigid bodies, joints, motors, contacts, reactions | Project Chrono 10 (PyChrono) | `mesh3d/sim/` through `mesh3d/eng/motion.py` |
| Stress, strain, displacement | gmsh 4.15 (second-order tetrahedra) + CalculiX 2.23 | `mesh3d/eng/fea.py`, `fea_run.py`, in `/opt/fea` |
| Printability | geometry rules against the declared print setup | `mesh3d/eng/printability.py` |
| Showing results | Blender 4.5 (headless, Workbench) | `mesh3d/eng/visualize.py`, `visualize_blender.py` |
| Report | Markdown + self-contained HTML | `mesh3d/eng/report.py` |

## Survey and choices (2026-10-28)

What the repository already had: the mesh3d worker (Hunyuan3D-2 on the GPU, Blender with MCP for Blender, Chrono in
its own environment `/opt/chrono`), trimesh, manifold3d and pymeshlab in the worker's Python, a print-feature
analysis for Studio (`analyze.py`), and the `bambu-cad` MCP server that only talks to the gateway.

- **FEM.** FreeCAD's FEM workbench drives gmsh (or Netgen) for the mesh and CalculiX for the solve. Here the pipeline
  already holds the geometry as a mesh and needs only the solve, so it drives the same two engines directly: a
  conda environment `/opt/fea` (calculix 2.23, gmsh 4.15.2, NumPy, SciPy), no FreeCAD document model or GUI. The
  input deck (`job.inp`) is a plain CalculiX/Abaqus file that FreeCAD or PrePoMax can open.
- **Separate environments.** Chrono (`/opt/chrono`) and FEA (`/opt/fea`) each have their own Python, run as
  subprocesses; nothing touches Hunyuan3D-2's PyTorch environment. The image grows by one layer (`/opt/fea`).
- **STEP.** The mesh container has no CAD kernel (OpenCascade is in the CAD container). STEP/IGES are refused with
  the reason; export STL or 3MF in mm, or use a CAD job's `out/model.stl`.
- **Live Blender scene.** MCP for Blender's scene lives inside a figure job. A scene is imported from a `.blend`
  file instead (every visible mesh object, modifiers applied, in its unit).

## Pipeline and tools

| Step | MCP tool | What it does |
|---|---|---|
| 1. Import | `inspect_3d_model` | Reads STL, 3MF (all objects and build transforms, its unit), OBJ, PLY, GLB, .blend. Copies the files untouched (SHA-256 kept), stores each component as PLY in mm, a new version per import. Reports boxes, sizes, area, volume and mass properties (only for closed, outward meshes), units. |
| 2. Geometry | `validate_mesh` | FAIL (certain, for a solid): no faces, non-manifold edges, inverted or inconsistent normals, self-intersections, components overlapping (volume). WARNING (to confirm): open edges (set `intents` to `"surface"` for a shell), several bodies, degenerate/duplicate faces. NOT_EVALUATED: size against the extrusion width without a print setup. |
| 3. Assembly | `analyze_assembly` | Cylindrical holes and shafts fitted on the mesh (residual, angle covered, normal direction checked), coaxial pairs (offset, angle, engagement), touching pairs, overlaps, **suggested** joints. Joints are used only once the user confirms them (`joints`). |
| 4. Fits | `check_clearance` | Gaps between parts; hole/shaft fits as designed and as printed from `hole_shrink_mm`/`shaft_growth_mm` (NOT_EVALUATED without them); wall thickness (rays) against walls × line width; gear backlash 2a′(inv α_w − inv α) from the centre distance; with `sim_id`, collisions through a motion. |
| 5. Motion | `configure_motion_simulation`, `run_motion_simulation` | Components as rigid bodies in Chrono with mass properties from their meshes and a density or mass from the user (an assumed density only when the user accepts it, listed with its effect), the confirmed joints, motors, loads. Results: the Chrono checks against theory, joint ranges and reactions, and a collision sweep. Rigid bodies: no conclusion about bending or breaking. |
| 6. Structure | `configure_fea_analysis`, `run_fea_analysis` | Linear static FEA of one component: C3D10 mesh, E and ν required, fixed regions and loads from the user (box/plane/sphere regions), loads as consistent nodal forces, two element sizes for convergence. Reports the peak von Mises and the one away from supports and load patches (idealised boundary conditions make singular peaks), a safety factor only with a strength and a required factor, tension across layers with the interlayer strength and build direction. |
| 7. Printability | `analyze_printability` | Overhangs needing support (area, box), bed contact, thin walls, holes too small or horizontal, build volume, layers against the FEA stress, what needs a calibration print. No strength from a material name. |
| Show | `visualize_results_in_blender` | `fea` (von Mises on the deformed solver surface, scale bar), `interference` (overlaps red), `thickness`, `motion` (the simulation's playback video). PNG + `.blend`. |
| Report | `generate_engineering_report` | The eleven sections, each PASS / WARNING / FAIL / NOT_EVALUATED, assumptions and missing data, recommendations from the failed and warned checks, limits. `report.md`, `report.html`. |

**Statuses.** PASS meets a stated criterion; WARNING needs checking; FAIL breaks a stated criterion;
NOT_EVALUATED lacks data or was not run. A set of checks is PASS only when everything was evaluated and passed:
nothing found is not a pass.

**Results.** Every analysis is `data/eng/analyses/<id>/result.json`: model id and version, start and end time,
engine versions, inputs, units (mm, N, MPa), checks, data, assumptions, warnings, missing data, state, error and
files (FEA: `job.inp`, `job.frd`, `ccx.log`, `result.npz`; renders: `result.png`, `result.blend`). A failed solver
gives NOT_EVALUATED and its error, never numbers.

### Data the user gives (never guessed)

- `print`: printer, process, filament and brand, nozzle, line width, layer height, walls, infill, temperatures,
  build direction and volume, overhang limit, and the tolerances measured on this printer: `xy_tolerance_mm`,
  `hole_shrink_mm`, `shaft_growth_mm`, `min_clearance_mm`, `tolerance_source` (`calibration` for a test print).
- `material` (FEA): `young_modulus_MPa`, `poisson_ratio`; for strength `yield_strength_MPa` or
  `tensile_strength_MPa`, `interlayer_strength_MPa`; `source` and `printed` (numbers measured on printed specimens).
  Datasheet numbers of moulded specimens overstate printed strength: a safety factor from them stays a WARNING.
- Loads, supports, required safety factor, allowed displacement, masses or densities.

## Dashboard: "Kiểm tra kỹ thuật"

Every finished model in **✨ Thiết kế AI** has a **🔬 Kiểm tra kỹ thuật** button (`src/ui/cad/EngCheck.tsx`). It
asks for the print setup (printer, filament, nozzle, layer height, walls, infill, overhang limit, and the tolerances
measured with the calibration print; empty means unknown, remembered in this browser) and runs `POST /api/eng/check`
on the job's `out/model.stl`: a new version of the model `job-<job id>`, the mesh checks, wall thickness,
printability, a Blender render of the walls, and the report. The dialog lists the checks worst first, the report's
sections, what data is still missing, and links the HTML report and the `.blend`; opening it again shows the latest
check (`GET /api/eng/checks/<job id>`). About 20 s for a 15-part CAD model or a 250k-face figure. Strength (FEA)
and motion need loads, supports and joints, so they stay with Claude through MCP.

Ray casting (wall thickness, overhangs) uses Embree (`embreex` in the image): on a 250k-face figure the walls take
0.5 s instead of 104 s. The thickness render measures at most 60 000 faces and gives the rest their nearest measured
value, so a dense mesh cannot exhaust memory (one ray per face of that figure without Embree reached 18 GB).

## Setup

```
docker compose -f docker-compose.mesh3d.yml up -d
```

The image needs the `/opt/fea` layer. BuildKit's cache did not hold the earlier layers here, and rebuilding them
re-downloads Blender, MV-Adapter and Chrono and may pick newer unpinned packages; the classic builder reuses the
image's own layers, so only the FEA layer is new:

```
DOCKER_BUILDKIT=0 docker build -t bambu-lab-h2d/mesh3d:latest mesh3d
```

`docker-compose.mesh3d.yml` mounts `./data/eng` at `/eng` and sets `ENG_DIR` and `FEA_PYTHON`. The worker's
`/health` says `"fea": true`. The gateway passes `/api/eng/*` through (rebuild it after pulling this change).

## Tests

```
# The pipeline against parts with known answers (worker Python; Chrono and FEA environments used when present)
docker exec -w /opt/mesh3d bambu-mesh3d python -m unittest eng.tests.test_eng
# Gateway routes
npx vitest run tests/eng.test.ts
```

| Test | Reference |
|---|---|
| Volumes and units | 20×10×5 box = 1000 mm³; the same box in metres with `units: "m"`; a 3MF in inches with two objects and a build transform |
| Mesh errors | inverted box FAIL, a fin (3 faces on an edge) FAIL, two boxes cutting each other FAIL (self-intersection), a box with two faces removed WARNING (PASS as a surface), a clean box PASS |
| Overlap | two 10 mm cubes offset 5 mm: 500 mm³ |
| Assembly | a Ø8.4 hole in a bracket and a Ø8.0 pin: found, coaxial, clearance 0.4, engagement 10 mm, revolute suggested; flat walls are not cylinders |
| Fit | printed clearance 0.4 − 0.15 − 0.10 = 0.15 mm: FAIL against 0.2, PASS against 0.1; NOT_EVALUATED without tolerances; gap 0.2 mm |
| Wall | a 2 mm plate measures 2.0 mm; WARNING under 2 × 3 walls × 0.4 mm |
| Gear backlash | centre distance 60.1 for 20/40 m2: 2a′(inv α_w − inv 20°), within 2 % of 2·Δa·tan 20° |
| Printability | a T: arm undersides 300 mm² + the top of a horizontal Ø8 hole; horizontal hole WARNING; a sphere has no bed contact (FAIL) |
| FEA | cantilever 100×10×10, E 3500 MPa, 10 N: tip deflection within 2 % of Timoshenko (1.142 against 1.152 mm), mid-span stress within 5 % of M·c/I = 3 MPa, convergence PASS; strength NOT_EVALUATED without strengths; configuration refused without E and ν |
| Motion | an arm at 90°/s meets a stop when √(3² + 27²)·sin(atan2(27, 3) − θ) = 3, θ = 77.3°: first collision sample at 0.86 s |
| Inside corner | an L-bracket (wall on a base) pushed sideways: the stress peak sits on the inside corner and rises 20 % with a finer mesh, so convergence WARNs and names it; datasheet strengths keep the safety factors at WARNING |
| Upload names | a file uploaded as `hinge arm.stl` becomes component `hinge-arm`, not the stored copy's name |
| Blender | the thickness view colours a 1 mm plate warm and a 5 mm wall blue, face by face; PNG and .blend written |
| Report | eleven sections; FEM and motion NOT_EVALUATED when not run; the report is not PASS |

**End to end through MCP (2026-10-28).** An L-bracket with a Ø8.4 hole and an arm with a Ø8 pin, sent as STL files
from this computer through `bambu-cad` → gateway → mesh worker:
- import: volumes 12 867.7 mm³ (hand count 13 200 − π·4.2²·6 = 12 867.5) and 1 877.1 mm³;
- assembly: hole/pin coaxial, clearance 0.4 mm, engagement 6 mm (the wall), revolute suggested, then confirmed;
- fit: 0.4 − 0.15 − 0.10 = 0.15 mm after printing, FAIL against 0.2 mm;
- motion (90°/s about the pin): the arm's underside meets the base plate's edge (x = 40, z = 5) when
  (20 + 3 sin θ) tan θ + 3 cos θ = 20, θ = 38.8°, t = 0.431 s; first collision sample 0.44 s;
- FEA (50 N sideways at the wall top): 0.232 mm, between the hand bounds 0.18 (wall alone, 30 mm) and 0.28 mm
  (35 mm); root stress 6.9–8.6 MPa against M·c/I = 6.25–7.3 MPa; the peak on the inside corner grows with the
  mesh (WARNING);
- printability: overhang of the horizontal hole's top, the arm's tiny bed contact, layers in tension under the
  wall's bending (71 % of the peak stress);
- render and report written; the report is FAIL (fit, collision), never PASS.

## Limits

- Geometry is measured on triangles: as precise as the mesh. Cylinders are found on faceted surfaces; small fillets
  and partial arcs (under 200°) are not taken as bearings.
- Joints come from the user; suggestions only point at coaxial holes and shafts.
- Motion: ideal rigid bodies and joints; collisions with meshes in Chrono use convex hulls; the collision sweep checks
  sampled times only.
- FEA: linear, isotropic, small strains, static, solid part. Printed parts are anisotropic and depend on walls and
  infill. Regions select surface nodes; a clamp is perfectly rigid.
- Printability: geometric rules; real tolerances need a calibration print on the same printer, material and settings.
