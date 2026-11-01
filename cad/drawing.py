"""
Engineering drawing of a built job: python drawing.py <model.py> [title]

text-to-cad's engineering-drawing (cadgen.eng_drawing) made without Claude: an A3 sheet in third angle with the
top, front and right views, an isometric, hidden lines and centre marks, and each view's overall dimensions,
measured from the model's geometry. An assembly gets a sheet per printed component (at most MAX_SHEETS). Writes
out/drawing.pdf next to the model and prints {"ok", "file", "sheets", "notices"} (or {"ok": false, "error"}).

Feature dimensions, tolerances and hole callouts need someone who knows what the part is for: ask Claude for a
drawing in the request (the skill writes its own <name>_drawing.py into out/exports/).
"""

import contextlib
import io
import json
import os
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# Fewer on a retry of a drawing that ran out of time (DRAWING_MAX_SHEETS)
MAX_SHEETS = int(os.environ.get("DRAWING_MAX_SHEETS") or 12)
# ISO 5455 reduction scales, tried in turn until every sheet's views fit its A3 frame
SCALES = (1.0, 0.5, 0.2, 0.1, 0.05)


def sheets_of(model, title):
    """(name, shape) for each sheet: the part, or each printed component of an assembly"""
    import build

    namespace, document = build.load(model)
    shape = document.shape if document is not None else namespace.get("result")
    components = namespace.get("components")
    if components is None and document is not None:
        components = build.assembly_children(shape) or None
    if isinstance(components, dict) and components:
        skipped = build.bought(namespace, components)
        named = [(name, build.as_shape(part, name)) for name, part in components.items() if name not in skipped]
        return named[:MAX_SHEETS], len(named) > MAX_SHEETS
    if shape is None:
        raise ValueError("model.py defines no @model (and assigns no `result`).")
    if isinstance(shape, (list, tuple)):
        from build123d import Compound

        shape = Compound(children=list(shape))
    return [(title, build.as_shape(shape, "the model"))], False


def draw(model, out, title):
    parts, cut = sheets_of(model, title)
    for scale in SCALES:
        try:
            return render(model, out, parts, scale), cut
        except ValueError as err:
            # cadgen refuses views that run off the frame, naming a scale that fits
            if "runs off the frame" not in str(err) or scale == SCALES[-1]:
                raise
    raise AssertionError("unreachable")


def render(model, out, parts, scale):
    from cadgen.eng_drawing import Sheet, eng_drawing

    def drawing():
        sheets = []
        for k, (name, part) in enumerate(parts, 1):
            sheet = Sheet("A3", scale=scale, title=name.upper()[:60], part_number=f"{Path(model).parent.name}-{k:02d}",
                          material="PLA (FDM)", units="mm", notes=["3D PRINTED ON BAMBU LAB H2D.",
                                                                   "DIMENSIONS AS MODELLED, BEFORE PRINT SHRINKAGE."])
            top, front, right, _iso = sheet.three_views(part, iso=True)
            top.overall()
            front.overall()
            sheets.append(sheet)
        return sheets

    drawing.__name__ = "drawing"
    eng_drawing(out=str(out))(drawing)()
    return len(parts)


def main():
    model = Path(sys.argv[1]).resolve()
    title = sys.argv[2] if len(sys.argv) > 2 else model.parent.name
    out = model.parent / "out" / "drawing.pdf"
    out.parent.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("MPLCONFIGDIR", str(model.parent / "tmp" / "mpl"))
    said = io.StringIO()
    try:
        with contextlib.redirect_stdout(said), contextlib.redirect_stderr(said):
            sheets, cut = draw(model, out, title)
        notices = [line.strip() for line in said.getvalue().splitlines()
                   if line.strip() and not line.startswith(("built ", "took ", "  ", "wrote "))]
        if cut:
            notices.append(f"Chỉ vẽ {MAX_SHEETS} chi tiết đầu tiên.")
        report = {"ok": True, "file": "drawing.pdf", "sheets": sheets, "notices": notices[-20:]}
    except Exception as err:  # noqa: BLE001 - what went wrong is the answer
        report = {"ok": False, "error": f"{type(err).__name__}: {err}",
                  "traceback": "".join(traceback.format_exception(err))[-3000:]}
    print(json.dumps(report, ensure_ascii=False))
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
