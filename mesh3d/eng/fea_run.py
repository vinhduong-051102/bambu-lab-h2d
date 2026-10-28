"""
One linear static FEA, in the FEA environment's Python (/opt/fea: gmsh, CalculiX ccx, NumPy):

    /opt/fea/bin/python fea_run.py <folder>

Reads <folder>/fea.json (fea.py writes it) and, for each mesh size asked (the convergence study), in
<folder>/level<k>/:
  1. gmsh: the closed STL (mm) re-parametrised (classifySurfaces, createGeometry) and meshed into second-order
     tetrahedra (C3D10) of the given size
  2. job.inp for CalculiX: nodes, elements, material (E in MPa, ν), fixed nodes, consistent nodal forces (a uniform
     traction over the loaded faces of the 6-node surface triangles puts a third of each face's load on each mid-side
     node and none on the corners), *STATIC
  3. ccx job; job.frd parsed (displacements, nodal stresses)
  4. result.npz (nodes, displacement, von Mises, stress tensor) and level.json (maxima, robust stress)
Then <folder>/fea_out.json with every level, or the error. Progress lines "PROGRESS <0..1>" go to stdout.

Units: mm, N, MPa throughout.
"""

import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

CCX = os.environ.get("CCX", str(Path(sys.executable).parent / "ccx"))
# gmsh's 10-node tetrahedron numbers its last two edge nodes (2-3, 1-3) the other way from CalculiX's C3D10
GMSH_TO_CCX_TET10 = [0, 1, 2, 3, 4, 5, 6, 7, 9, 8]


def log(folder, text):
    with open(folder / "fea.log", "a", encoding="utf-8") as f:
        f.write(f"{time.strftime('%H:%M:%S')} {text}\n")


def mesh_volume(stl, size, out):
    """gmsh: nodes (n×3), C3D10 connectivity (CalculiX order, 0-based indices), surface tri6 (0-based)"""
    import gmsh

    gmsh.initialize(["-nt", str(os.cpu_count() or 4)])
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.merge(str(stl))
        # Faces meeting at more than 40° become separate surfaces; each is re-parametrised so it can be remeshed
        gmsh.model.mesh.classifySurfaces(math.radians(40), True, True, math.radians(180))
        gmsh.model.mesh.createGeometry()
        surfaces = [s[1] for s in gmsh.model.getEntities(2)]
        loop = gmsh.model.geo.addSurfaceLoop(surfaces)
        gmsh.model.geo.addVolume([loop])
        gmsh.model.geo.synchronize()
        gmsh.option.setNumber("Mesh.MeshSizeMax", size)
        gmsh.option.setNumber("Mesh.MeshSizeMin", size / 3)
        gmsh.option.setNumber("Mesh.ElementOrder", 2)
        gmsh.option.setNumber("Mesh.SecondOrderLinear", 0)
        gmsh.option.setNumber("Mesh.Optimize", 1)
        gmsh.model.mesh.generate(3)
        gmsh.write(str(out / "mesh.msh"))
        tags, coords, _ = gmsh.model.mesh.getNodes()
        index = {int(t): i for i, t in enumerate(tags)}
        nodes = coords.reshape(-1, 3)
        types, _, conn = gmsh.model.mesh.getElements(3)
        tets = None
        for t, c in zip(types, conn):
            if t == 11:  # 10-node tetrahedron
                tets = np.array([index[int(n)] for n in c]).reshape(-1, 10)[:, GMSH_TO_CCX_TET10]
        types, _, conn = gmsh.model.mesh.getElements(2)
        tris = None
        for t, c in zip(types, conn):
            if t == 9:  # 6-node triangle
                tris = np.array([index[int(n)] for n in c]).reshape(-1, 6)
        if tets is None or tris is None or not len(tets):
            raise RuntimeError("gmsh không tạo được lưới tứ diện bậc 2: kiểm tra STL kín và không tự cắt.")
        return nodes, tets, tris
    finally:
        gmsh.finalize()


def select(nodes, region):
    """Indices of the nodes a region selects: {"box": {"min", "max"}}, {"plane": {"axis", "value", "tolerance"}},
    {"sphere": {"center", "radius"}} (mm)"""
    if "box" in region:
        lo, hi = np.asarray(region["box"]["min"]), np.asarray(region["box"]["max"])
        mask = np.all((nodes >= lo) & (nodes <= hi), axis=1)
    elif "plane" in region:
        p = region["plane"]
        axis = "xyz".index(p["axis"])
        mask = np.abs(nodes[:, axis] - p["value"]) <= p.get("tolerance", 1e-3)
    else:
        s = region["sphere"]
        mask = np.linalg.norm(nodes - np.asarray(s["center"]), axis=1) <= s["radius"]
    return np.nonzero(mask)[0]


def tri_area(p):
    return 0.5 * np.linalg.norm(np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), axis=1)


def nodal_loads(nodes, tris, surface_nodes, loads):
    """{node: force vector}: each load's total force spread as a uniform traction over the surface triangles whose
    six nodes are all in its region (consistent loads of a 6-node triangle: a third on each mid-side node)"""
    forces = {}
    applied = []
    for i, load in enumerate(loads):
        region = set(select(nodes, load["region"]).tolist()) & surface_nodes
        faces = np.array([t for t in tris if all(int(n) in region for n in t)])
        if not len(faces):
            raise RuntimeError(f"loads[{i}]: vùng đặt tải không chứa trọn mặt tam giác nào của bề mặt lưới.")
        areas = tri_area(nodes[faces[:, :3]])
        area = float(areas.sum())
        if load["type"] == "force":
            traction = np.asarray(load["vector"], float) / area
            per_face = [traction * a for a in areas]
        else:  # pressure (MPa) pushing into the surface
            per_face = []
            for f, a in zip(faces, areas):
                p = nodes[f[:3]]
                n = np.cross(p[1] - p[0], p[2] - p[0])
                n /= np.linalg.norm(n)
                per_face.append(-load["value"] * a * n)
        total = np.zeros(3)
        for f, fv in zip(faces, per_face):
            for n in f[3:]:
                forces[int(n)] = forces.get(int(n), np.zeros(3)) + fv / 3
            total += fv
        applied.append({"index": i, "faces": int(len(faces)), "area_mm2": area, "total_N": total.tolist()})
    return forces, applied


def write_inp(path, nodes, tets, fixed, forces, material):
    with open(path, "w") as f:
        f.write("*HEADING\nbambu-lab-h2d engineering FEA (mm, N, MPa)\n*NODE, NSET=NALL\n")
        for i, (x, y, z) in enumerate(nodes, 1):
            f.write(f"{i}, {x:.9g}, {y:.9g}, {z:.9g}\n")
        f.write("*ELEMENT, TYPE=C3D10, ELSET=EALL\n")
        for i, e in enumerate(tets, 1):
            f.write(f"{i}, " + ", ".join(str(int(n) + 1) for n in e) + "\n")
        f.write("*NSET, NSET=FIXED\n")
        for k in range(0, len(fixed), 12):
            f.write(", ".join(str(int(n) + 1) for n in fixed[k:k + 12]) + "\n")
        f.write(f"*MATERIAL, NAME=M\n*ELASTIC\n{material['E']:.9g}, {material['nu']:.9g}\n")
        f.write("*SOLID SECTION, ELSET=EALL, MATERIAL=M\n")
        f.write("*STEP\n*STATIC\n*BOUNDARY\nFIXED, 1, 3, 0.\n*CLOAD\n")
        for n, v in forces.items():
            for dof in range(3):
                if abs(v[dof]) > 0:
                    f.write(f"{n + 1}, {dof + 1}, {v[dof]:.9g}\n")
        f.write("*NODE FILE\nU\n*EL FILE\nS\n*END STEP\n")


def read_frd(path, count):
    """Nodal blocks of a CalculiX .frd (ASCII): {"DISP": n×3, "STRESS": n×6}"""
    out = {}
    block, values = None, None
    with open(path) as f:
        for line in f:
            if line.startswith(" -4"):
                name = line[5:13].strip()
                block = name if name in ("DISP", "STRESS") else None
                if block:
                    values = np.zeros((count, 3 if block == "DISP" else 6))
            elif block and line.startswith(" -1"):
                node = int(line[3:13])
                data = [float(line[13 + 12 * k:25 + 12 * k]) for k in range(values.shape[1])]
                values[node - 1] = data
            elif block and line.startswith(" -3"):
                out[block] = values
                block = None
    if "DISP" not in out or "STRESS" not in out:
        raise RuntimeError("Không đọc được chuyển vị/ứng suất trong job.frd.")
    return out


def von_mises(s):
    sxx, syy, szz, sxy, syz, szx = s.T
    return np.sqrt(0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) + 3 * (sxy ** 2 + syz ** 2 + szx ** 2))


def level(folder, config, size, k):
    out = folder / f"level{k}"
    out.mkdir(exist_ok=True)
    started = time.monotonic()
    nodes, tets, tris = mesh_volume(folder / "part.stl", size, out)
    log(folder, f"level {k}: h = {size:g} mm, {len(nodes)} nút, {len(tets)} phần tử C3D10")
    surface = set(np.unique(tris).tolist())
    fixed = sorted(set().union(*[set(select(nodes, c["region"]).tolist()) for c in config["constraints"]]) & surface)
    if len(fixed) < 3:
        raise RuntimeError("Vùng ngàm chọn được ít hơn 3 nút bề mặt: mở rộng vùng (region) của constraints.")
    forces, applied = nodal_loads(nodes, tris, surface, config["loads"])
    write_inp(out / "job.inp", nodes, tets, fixed, forces, config["material"])
    env = {**os.environ, "OMP_NUM_THREADS": str(os.cpu_count() or 4), "CCX_NPROC_EQUATION_SOLVER": str(os.cpu_count() or 4)}
    proc = subprocess.run([CCX, "-i", "job"], cwd=out, capture_output=True, text=True, env=env,
                          timeout=config.get("timeout_s", 1200))
    (out / "ccx.log").write_text(proc.stdout + proc.stderr)
    if proc.returncode != 0 or "*ERROR" in proc.stdout or not (out / "job.frd").exists():
        tail = "\n".join(l for l in (proc.stdout + proc.stderr).splitlines() if "ERROR" in l)[-600:]
        raise RuntimeError(f"CalculiX lỗi (mã {proc.returncode}): {tail or 'xem ccx.log'}")
    res = read_frd(out / "job.frd", len(nodes))
    u, s = res["DISP"], res["STRESS"]
    vm = von_mises(s)
    disp = np.linalg.norm(u, axis=1)
    # Stresses next to the supports and load patches are inflated by the idealised boundary conditions (a perfectly
    # rigid clamp makes a singular corner): the "robust" maximum leaves out nodes within `exclude` of them
    special = np.zeros(len(nodes), bool)
    special[fixed] = True
    special[list(forces)] = True
    exclude = config.get("singularity_exclusion_mm") or 2 * size
    from scipy.spatial import cKDTree

    near = cKDTree(nodes[special]).query(nodes, distance_upper_bound=exclude)[0] < exclude
    robust = vm[~near]
    i_max, i_vm = int(np.argmax(disp)), int(np.argmax(vm))
    i_rob = int(np.flatnonzero(~near)[np.argmax(robust)]) if len(robust) else None
    np.savez_compressed(out / "result.npz", nodes=nodes, displacement=u, von_mises=vm, stress=s,
                        surface=np.array(sorted(surface)), triangles=tris[:, :3], fixed=np.array(fixed),
                        loaded=np.array(sorted(forces)),
                        near_bc=near)
    reaction = -sum(np.asarray(a["total_N"]) for a in applied)
    info = {"level": k, "mesh_size_mm": size, "nodes": int(len(nodes)), "elements": int(len(tets)),
            "element_type": "C3D10", "fixed_nodes": len(fixed), "loads": applied,
            "max_displacement_mm": float(disp[i_max]), "max_displacement_at": nodes[i_max].tolist(),
            "max_von_mises_MPa": float(vm[i_vm]), "max_von_mises_at": nodes[i_vm].tolist(),
            "robust_max_von_mises_MPa": float(robust.max()) if len(robust) else None,
            "robust_max_at": nodes[i_rob].tolist() if i_rob is not None else None,
            "singularity_exclusion_mm": exclude, "expected_reaction_N": reaction.tolist(),
            "wall_time_s": time.monotonic() - started}
    (out / "level.json").write_text(json.dumps(info, indent=2))
    return info


def main():
    folder = Path(sys.argv[1]).resolve()
    config = json.loads((folder / "fea.json").read_text())
    out = {"state": "running", "levels": []}
    try:
        import gmsh

        out["engine"] = {"gmsh": gmsh.__version__, "calculix": ccx_version()}
        sizes = config["mesh_sizes_mm"]
        for k, size in enumerate(sizes):
            out["levels"].append(level(folder, config, size, k))
            print(f"PROGRESS {(k + 1) / len(sizes):.3f}", flush=True)
        out["state"] = "completed"
        code = 0
    except Exception as err:  # noqa: BLE001 - every failure is reported, nothing is made up
        import traceback

        log(folder, traceback.format_exc())
        out.update(state="failed", error=f"{type(err).__name__}: {err}")
        code = 1
    (folder / "fea_out.json").write_text(json.dumps(out, indent=2))
    sys.exit(code)


def ccx_version():
    try:
        text = subprocess.run([CCX, "-v"], capture_output=True, text=True, timeout=30).stdout
        return text.strip().split()[-1] if text.strip() else "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


if __name__ == "__main__":
    main()
