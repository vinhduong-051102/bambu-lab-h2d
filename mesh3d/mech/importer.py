"""
An existing model → a draft mechanical model (workflow B).

The geometry comes from an engineering model (eng/: STL, OBJ, PLY, GLB/glTF with its node names and transforms,
3MF objects, .blend objects; STEP through the CAD container's /api/cad/convert first). Each component is a part with
its name and file ("imported_cad"); nothing is split further than the source splits it. What the geometry suggests
(eng/assembly.py: a hole and a shaft on one axis) becomes a hypothesis with its confidence, a joint only when the
user confirms it (`accept`) — a mesh alone does not say which part is the frame, what the parts are made of, or that
two touching parts move against each other. Those stay in `missing` until given.
"""

from eng import assembly as eng_assembly
from eng import store as eng_store


def draft_from_eng(body):
    """{"model": mech/1 draft, "hypotheses": [...], "source": {...}}. body: {"model_id", "version"?, "fixed"?: [part
    ids], "materials"?: {part id: material}, "accept"?: [hypothesis ids], "name"?}"""
    model = eng_store.load_model(body["model_id"], body.get("version"))
    base = f"eng/models/{model['model_id']}/v{model['version']}"
    fixed, materials = set(body.get("fixed") or []), body.get("materials") or {}
    parts = []
    for c in model["components"]:
        part = {"id": c["id"], "name": c["name"], "role": "frame" if c["id"] in fixed else "other",
                "fixed": c["id"] in fixed, "geometry_file": f"{base}/{c['file']}", "source": "imported_cad"}
        if c["id"] in materials:
            part["material"] = materials[c["id"]]
        parts.append(part)
    analysis = eng_assembly.analyze(model)
    hypotheses = []
    for k, s in enumerate(analysis["data"]["suggested_joints"], 1):
        hypotheses.append({"id": f"h{k}", "kind": "joint", "joint": {
            "id": f"{s['component_a']}_{s['component_b']}_{s['type']}", "type": s["type"], "part_a": s["component_a"],
            "part_b": s["component_b"], "position": s["position"], "axis": s["axis"], "source": "geometry",
            "confidence": "probable"}, "confidence": "probable", "reason": s["reason"]})
    for t in analysis["data"]["touching"]:
        pairs = [{h["joint"]["part_a"], h["joint"]["part_b"]} if h["kind"] == "joint" else set(h["parts"]) for h in hypotheses]
        if {t["a"], t["b"]} not in pairs:
            hypotheses.append({"id": f"h{len(hypotheses) + 1}", "kind": "contact", "parts": [t["a"], t["b"]],
                               "confidence": "unknown",
                               "reason": f"{t['a']} và {t['b']} chạm nhau ({t['gap']} mm) nhưng hình học không cho biết là khớp gì."})
    accepted = set(body.get("accept") or [])
    joints = [h["joint"] | {"confidence": "confirmed", "source": "user"} for h in hypotheses
              if h["id"] in accepted and h["kind"] == "joint"]
    draft = {"schema": "mech/1", "name": body.get("name") or model["name"], "units": {"length": "mm", "angle": "deg"},
             "parts": parts, "joints": joints, "gears": [], "motors": [], "loads": [],
             "simulation": body.get("simulation") or {}, "source": {"eng_model": model["model_id"], "version": model["version"]}}
    return {"model": draft, "hypotheses": hypotheses,
            "source": {"eng_model": model["model_id"], "version": model["version"],
                       "components": [{k: c[k] for k in ("id", "name", "source_label", "source_sha256")} for c in model["components"]],
                       "overlaps": analysis["data"]["overlaps"]},
            "to_confirm": [h for h in hypotheses if h["id"] not in accepted]}
