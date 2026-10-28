"""
STEP/IGES to STL: python convert.py <file.step|.stp|.iges|.igs> <out dir> [linear tolerance mm] [angular tolerance °]

Reads the file with OpenCascade (in mm, whatever unit it was written in), and writes each solid to its own STL in the
out dir, with convert.json, which it also prints: {ok, source, units, tolerance_mm, angular_tolerance_deg, solids:
[{name, file, volume_mm3, bbox: {min, max, size}, faces, mesh: {triangles, watertight, ...}}], warnings}. Exits 1
when the file could not be read or holds no solid; convert.json then says why, and no STL is left behind.

A file of surfaces only (common in IGES) is sewn: every closed shell becomes a solid.
"""

import json
import math
import re
import sys
import time
import traceback
from pathlib import Path

from build import mesh_check, read_stl

DEFAULT_TOLERANCE_MM = 0.01
DEFAULT_ANGULAR_DEG = 0.5
STEP_SUFFIXES = (".step", ".stp")
IGES_SUFFIXES = (".iges", ".igs")
# Gaps between surfaces this small are closed when a file of surfaces is sewn into solids (mm)
SEW_TOLERANCE_MM = 0.01


def length_units(names):
    """OpenCascade's unit names ("millimetre", "inch") once each, in the order found"""
    return list(dict.fromkeys(n.strip().lower() for n in names if n.strip()))


def read_step(path):
    """(shapes as (name, shape), units of the file)"""
    from build123d import import_step
    from OCP.IFSelect import IFSelect_ReturnStatus
    from OCP.OCP.collections import Sequence_TCollection_AsciiString
    from OCP.STEPControl import STEPControl_Reader

    # Parsed once here for its status and units: import_step answers an unreadable file with an empty compound
    reader = STEPControl_Reader()
    if reader.ReadFile(str(path)) != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise ValueError("Không đọc được file STEP: file hỏng hoặc không đúng định dạng ISO-10303-21.")
    lengths, angles, solid_angles = (Sequence_TCollection_AsciiString() for _ in range(3))
    reader.FileUnits(lengths, angles, solid_angles)
    units = length_units(lengths.Value(i + 1).ToCString() for i in range(lengths.Length()))
    return labelled_solids(import_step(str(path))), units


IGES_UNITS = {1: "inch", 2: "millimetre", 3: None, 4: "foot", 5: "mile", 6: "metre", 7: "kilometre", 8: "mil",
              9: "micron", 10: "centimetre", 11: "microinch"}


def read_iges(path):
    from build123d import Compound
    from OCP.IFSelect import IFSelect_ReturnStatus
    from OCP.IGESControl import IGESControl_Reader

    reader = IGESControl_Reader()
    if reader.ReadFile(str(path)) != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise ValueError("Không đọc được file IGES: file hỏng hoặc không đúng định dạng.")
    reader.TransferRoots()
    shape = reader.OneShape()
    section = reader.IGESModel().GlobalSection()
    # Flag 3 means the unit is spelled out in the file
    unit = IGES_UNITS.get(section.UnitFlag()) or section.UnitName().ToCString().strip().lower()
    if shape.IsNull():
        return [], [unit] if unit else []
    return [("", s) for s in Compound(shape).solids()] or [("", Compound(shape))], [unit] if unit else []


def labelled_solids(shape, name=""):
    """Every solid in an imported assembly with the name of the nearest part or assembly that has one"""
    from build123d import Solid

    name = shape.label or name
    if isinstance(shape, Solid):
        return [(name, shape)]
    if shape.children:
        return [found for child in shape.children for found in labelled_solids(child, name)]
    # A part that is a compound of bodies, or of surfaces only (sewn into solids later)
    solids = shape.solids()
    return [(name, s) for s in solids] if solids else [(name, shape)]


def sewn_solids(shape):
    """Closed shells sewn from a shape's faces, each made a solid; open ones are dropped"""
    from build123d import Compound, Solid
    from OCP.BRep import BRep_Tool
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing

    sewing = BRepBuilderAPI_Sewing(SEW_TOLERANCE_MM)
    for face in shape.faces():
        sewing.Add(face.wrapped)
    sewing.Perform()
    sewn = sewing.SewedShape()
    shells = Compound(sewn).shells() if not sewn.IsNull() else []
    return [Solid(shell) for shell in shells if BRep_Tool.IsClosed_s(shell.wrapped)]


def file_name(index, name):
    clean = re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_")[:40]
    return f"{index:02d}-{clean or 'solid'}.stl"


def convert(source, out, tolerance, angular_deg):
    from build123d import export_stl

    suffix = source.suffix.lower()
    if suffix in STEP_SUFFIXES:
        found, units = read_step(source)
    elif suffix in IGES_SUFFIXES:
        found, units = read_iges(source)
    else:
        raise ValueError(f"Chỉ nhận .step, .stp, .iges, .igs (không nhận {suffix or 'file không đuôi'}).")

    warnings = []
    solids = []
    for name, shape in found:
        if shape.solids():
            solids.extend((name, s) for s in shape.solids())
            continue
        sewn = sewn_solids(shape)
        if shape.faces() and sewn:
            warnings.append(f"{name or 'Một phần'} chỉ có bề mặt: đã khâu thành {len(sewn)} khối kín.")
        elif shape.faces():
            warnings.append(f"{name or 'Một phần'} chỉ có bề mặt hở, không khâu được thành khối: bỏ qua.")
        solids.extend((name, s) for s in sewn)
    if not solids:
        raise ValueError("File không có khối đặc (solid) nào để xuất STL.")
    if len(units) > 1:
        warnings.append(f"File dùng nhiều đơn vị ({', '.join(units)}); tất cả đã được đổi sang mm.")

    results, written = [], []
    try:
        for index, (name, solid) in enumerate(solids, start=1):
            target = out / file_name(index, name)
            export_stl(solid, str(target), tolerance=tolerance, angular_tolerance=math.radians(angular_deg))
            written.append(target)
            box = solid.bounding_box()
            mesh = mesh_check(read_stl(target))
            if not mesh["watertight"]:
                warnings.append(f"{target.name}: lưới STL không kín ({mesh['open_edges']} cạnh hở).")
            valid = solid.is_valid() if callable(solid.is_valid) else solid.is_valid
            if not valid:
                warnings.append(f"{target.name}: OpenCascade báo khối không hợp lệ (mặt tự cắt hoặc hỏng).")
            results.append({
                "name": name or f"solid {index}",
                "file": target.name,
                "volume_mm3": round(solid.volume, 4),
                "bbox": {"min": [round(v, 4) for v in box.min], "max": [round(v, 4) for v in box.max],
                         "size": [round(v, 4) for v in box.size]},
                "faces": len(solid.faces()),
                "mesh": mesh,
            })
    except Exception:
        for path in written:
            path.unlink(missing_ok=True)
        raise
    return {"units": units[0] if len(units) == 1 else (units or None), "solids": results, "warnings": warnings}


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    source, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    tolerance = float(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_TOLERANCE_MM
    angular = float(sys.argv[4]) if len(sys.argv) > 4 else DEFAULT_ANGULAR_DEG
    out.mkdir(parents=True, exist_ok=True)
    # The STLs of a conversion before this one into the same folder go: the report lists exactly what is there
    previous = json.loads((out / "convert.json").read_text(encoding="utf-8")) if (out / "convert.json").exists() else {}
    for solid in previous.get("solids") or []:
        (out / Path(solid.get("file", "")).name).unlink(missing_ok=True)
    (out / "convert.json").unlink(missing_ok=True)

    started = time.monotonic()
    report = {"source": source.name, "tolerance_mm": tolerance, "angular_tolerance_deg": angular}
    try:
        report = {"ok": True, **report, **convert(source, out, tolerance, angular)}
    except Exception as err:  # noqa: BLE001 - a broken file's error is what the report is for
        report = {"ok": False, **report, "error": f"{type(err).__name__}: {err}" if not isinstance(err, ValueError)
                  else str(err), "traceback": traceback.format_exc()[-4000:]}
    report["seconds"] = round(time.monotonic() - started, 1)
    (out / "convert.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
