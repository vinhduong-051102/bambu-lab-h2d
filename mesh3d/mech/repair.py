"""
Repairs: from a validation's diagnostics, what could change and how, never applied without the user's approval.

Each proposal: {"id", "kind": "assembly" | "geometry" | "simulation" | "data", "summary", "reason", "refs",
"changes"}. `changes` is a patch for merge() (a new revision), or None when only the user has what is needed (a
mass, a motor speed). service.apply() takes approved proposals into a new revision and validates it again, so the
before and after can be compared; MAX_ROUNDS repair revisions per design, then the user has to look.
"""

import copy

import numpy as np

from .model import LENGTHS

MAX_ROUNDS = 5
KEYS = ("parts", "joints", "gears", "motors", "loads")


def merge(model, changes):
    """A copy of `model` with `changes`: items upserted by id per list, {"remove": {list: [ids]}}, and simulation,
    units, name merged"""
    out = copy.deepcopy(model)
    for key in KEYS:
        items = out.setdefault(key, [])
        for change in changes.get(key) or []:
            current = next((i for i in items if i.get("id") == change.get("id")), None)
            if current is None:
                items.append(copy.deepcopy(change))
            else:
                current.update(copy.deepcopy(change))
    for key, ids in (changes.get("remove") or {}).items():
        if key in KEYS:
            out[key] = [i for i in out.get(key, []) if i.get("id") not in set(ids)]
    if isinstance(changes.get("simulation"), dict):
        out["simulation"] = {**(out.get("simulation") or {}), **changes["simulation"]}
    for key in ("name", "units"):
        if key in changes:
            out[key] = changes[key]
    return out


def proposals(model, validation):
    out = []
    L = LENGTHS.get((model.get("units") or {}).get("length", "mm"), 1.0)
    parts = {p["id"]: p for p in model.get("parts", [])}
    joints = {j["id"]: j for j in model.get("joints", [])}
    placed = {p["id"]: p for p in validation.get("parts", [])}
    groups = validation.get("groups", {})

    def add(kind, summary, reason, changes, refs):
        # Two diagnostics of one locked loop propose the same change: keep the first
        if changes is not None and any(p["changes"] == changes for p in out):
            return
        out.append({"id": f"p{len(out) + 1}", "kind": kind, "summary": summary, "reason": reason, "changes": changes,
                    "refs": refs})

    for d in validation.get("diagnostics", []):
        code, refs = d["code"], d["parts"] + d["joints"]
        if code in ("JOINT_INSIDE_RIGID_GROUP", "MOTOR_ON_LOCKED_PAIR"):
            fixed = [j for j in d["joints"] if joints.get(j, {}).get("type") == "fixed"]
            for jid in fixed:
                add("assembly", f"Bỏ khớp fixed {jid}", d["message"], {"remove": {"joints": [jid]}}, refs)
            if not fixed:
                for pid in d["parts"]:
                    if parts.get(pid, {}).get("fixed") and parts[pid].get("role") not in ("ground", "housing", "frame"):
                        add("assembly", f"Bỏ cố định {pid} (fixed: false)", d["message"],
                            {"parts": [{"id": pid, "fixed": False}]}, refs)
        elif code == "GEAR_CENTER_DISTANCE":
            gear = next((g for g in model.get("gears", []) if g["id"] in d["joints"]), None)
            if gear and gear["gear_a"] in placed and gear["gear_b"] in placed:
                pa, pb = (np.asarray(placed[p]["position"]["value"], float) for p in (gear["gear_a"], gear["gear_b"]))
                ga_shape, gb_shape = parts[gear["gear_a"]].get("shape", {}), parts[gear["gear_b"]].get("shape", {})
                want = (ga_shape.get("teeth", 0) * ga_shape.get("module", 0) + gb_shape.get("teeth", 0) * gb_shape.get("module", 0)) / 2 * L
                axis = np.asarray(next((j["axis"] for j in model["joints"] if gear["gear_b"] in (j["part_a"], j["part_b"]) and j["type"] == "revolute"), [0, 0, 1]), float)
                axis /= np.linalg.norm(axis)
                d_vec = pb - pa
                d_vec -= np.dot(d_vec, axis) * axis
                dist = np.linalg.norm(d_vec)
                if dist > 1e-9 and want > 0:
                    shift_mm = d_vec / dist * (want - dist)
                    group = placed[gear["gear_b"]]["group"]
                    moved = groups.get(group, [gear["gear_b"]])
                    shift = shift_mm / L
                    changes = {"parts": [{"id": p, "position": (np.asarray(parts[p].get("position", [0, 0, 0]), float) + shift).round(6).tolist()}
                                         for p in moved if not parts[p].get("fixed")],
                               "joints": [{"id": j["id"], "position": (np.asarray(j["position"], float) + shift).round(6).tolist()}
                                          for j in model["joints"] if j.get("position") is not None
                                          and {j["part_a"], j["part_b"]} & set(moved) and j["type"] != "fixed"
                                          and not ({j["part_a"], j["part_b"]} <= set(moved))]}
                    add("geometry", f"Dời {', '.join(moved)} {np.linalg.norm(shift_mm):.4g} mm để khoảng cách tâm {gear['id']} = {want:.4g} mm",
                        d["message"], changes, refs)
        elif code == "AXIS_MISALIGNED":
            jid = d["joints"][0]
            pid = d["parts"][0]
            if jid in joints and pid in placed:
                pos = (np.asarray(placed[pid]["position"]["value"], float) / L).round(6).tolist()
                add("assembly", f"Đặt khớp {jid} lên tâm {pid}", d["message"], {"joints": [{"id": jid, "position": pos}]}, refs)
        elif code in ("MASS_UNKNOWN",):
            add("data", f"Cho vật liệu hoặc khối lượng của {', '.join(d['parts'])}", d["message"], None, refs)
        elif code == "UNSUPPORTED_JOINT":
            add("assembly", d.get("suggestion") or "Thay khớp không được hỗ trợ", d["message"], None, refs)
        elif code == "REDUNDANT_CONSTRAINTS":
            add("simulation", "Giữ nguyên: ràng buộc thừa nhất quán, Chrono chạy được; phản lực trong vòng kín không duy nhất",
                d["message"], None, refs)
    for m in validation.get("missing", []):
        add("data", f"Cần {m['path']}", m["message"], None, [m["path"]])
    return out
