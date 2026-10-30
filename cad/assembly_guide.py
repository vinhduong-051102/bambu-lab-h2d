"""
Assembly guide: python assembly_guide.py <out dir>

For a model built from `components` (assembly.json, build.py), writes <out>/guide/: guide.json (the steps: which
parts go on, onto which part, along which direction, and what to do in Vietnamese), step-01.png… (each step drawn:
what is already in place in grey, the parts going on in orange where they start, an arrow to where they go) and
assembly.mp4 (the parts going on one by one, then a turn round the finished model). Prints guide.json; exits 1 when
there is no guide to make.

The order is the model's own `assembly_steps` when it gives them (build.py keeps them in assembly.json as "steps"),
the parts it leaves out after them; otherwise it is worked out from `mechanism`: the fixed parts first, then each part
after the one it is jointed to. Parts that turn or slide on one axis go on along it, the farthest in first; a part
fixed to another goes in along the axis its own parts turn about (a shaft), else away from the part it is fixed to.
Nothing checks that a part's way in is clear: it is the order a person would try, not a proven one.
"""

import json
import math
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from build import read_stl

GUIDE_DIR = "guide"
WIDTH, HEIGHT, HEADER = 960, 720, 92
# Drawn this many times larger, then scaled down: PIL fills polygons without anti-aliasing
SUPERSAMPLE = 2
FPS = 24
# Frames of each step: still with its arrow, moving in, still in place; then the turn round the finished model
HOLD_BEFORE, MOVE, HOLD_AFTER, TURN = 12, 18, 8, 72
ELEVATION, AZIMUTH = 28, -55
PLACED, MOVING, BACKGROUND, ARROW, INK = (178, 188, 204), (240, 128, 32), (255, 255, 255), (28, 64, 120), (20, 28, 40)
AXIS_JOINTS = ("revolute", "cylindrical", "prismatic")
DOING = {
    "revolute": "Lồng {part} vào {onto}; nó quay quanh trục {axis}.",
    "cylindrical": "Lồng {part} vào {onto}; nó trượt và quay dọc trục {axis}.",
    "prismatic": "Lắp {part} vào rãnh trên {onto}; nó trượt dọc trục {axis}.",
    "spherical": "Lắp {part} vào khớp cầu trên {onto}.",
    "fixed": "Gắn chặt {part} vào {onto}.",
}


def unit(v):
    v = np.asarray(v, dtype=float)
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else None


def axis_name(v, signed=False):
    """"X" (or "+X"/"−X" when signed) along an axis of the model, else the vector itself"""
    k = int(np.argmax(np.abs(v)))
    if abs(v[k]) > 0.98:
        return ("+" if v[k] > 0 else "−") * signed + "XYZ"[k]
    return "(" + ", ".join(f"{c:.2f}" for c in v) + ")"


def joint_axis(joint):
    axis = joint.get("axis")
    return unit(axis) if isinstance(axis, list) and len(axis) == 3 else None


class Guide:
    def __init__(self, out):
        assembly = json.loads((out / "assembly.json").read_text(encoding="utf-8"))
        if assembly.get("from") != "components":
            raise ValueError("Chỉ mô hình khai báo `components` (các chi tiết ở vị trí đã lắp) mới có hướng dẫn lắp.")
        self.names = [c["name"] for c in assembly["components"]]
        self.meshes = {c["name"]: np.array(read_stl(out / c["file"]), dtype=float) for c in assembly["components"]}
        self.volumes = {c["name"]: c.get("volume_mm3") or 0 for c in assembly["components"]}
        self.centres = {name: mesh.reshape(-1, 3).mean(axis=0) for name, mesh in self.meshes.items()}
        mechanism = assembly.get("mechanism") or {}
        self.parts = mechanism.get("parts") or {}
        self.joints = [j for j in mechanism.get("joints") or [] if isinstance(j, dict)
                       and j.get("part_a") in self.meshes and j.get("part_b") in self.meshes]
        everything = np.concatenate([m.reshape(-1, 3) for m in self.meshes.values()])
        self.size = float(max(everything.max(axis=0) - everything.min(axis=0)))
        self.given = assembly.get("steps") or []

    def partner(self, name, placed):
        """(the placed part `name` is jointed to, the joint), the first such joint as declared"""
        for joint in self.joints:
            for me, other in (("part_a", "part_b"), ("part_b", "part_a")):
                if joint[me] == name and joint[other] in placed:
                    return joint[other], joint
        return None, None

    def way_in(self, name, onto, joint, sign=None):
        """The direction `name` starts out in from its place: the way it moves in is the opposite"""
        axis = joint_axis(joint) if joint and joint.get("type") in AXIS_JOINTS else None
        if axis is None:
            # A shaft goes in along the axis its own parts turn about
            axis = next((joint_axis(j) for j in self.joints if j.get("type") in AXIS_JOINTS and joint_axis(j) is not None
                         and name in (j["part_a"], j["part_b"]) and onto not in (j["part_a"], j["part_b"])), None)
        away = self.centres[name] - (self.centres[onto] if onto else np.mean(list(self.centres.values()), axis=0))
        if axis is not None:
            return axis * (sign or (1.0 if away @ axis >= -1e-6 else -1.0))
        if np.linalg.norm(away) < 1e-6:
            return np.array([0.0, 0.0, 1.0])
        k = int(np.argmax(np.abs(away)))
        d = np.zeros(3)
        d[k] = 1.0 if away[k] > 0 else -1.0
        return d

    def order(self):
        """[{"parts": [...], "text"?, "direction"?}] in assembly order"""
        steps = [{"parts": [p for p in step["parts"] if p in self.meshes], **{k: step[k] for k in ("text", "direction") if k in step}}
                 for step in self.given]
        steps = [step for step in steps if step["parts"]]
        placed = [p for step in steps for p in step["parts"]]
        if not placed:
            fixed = [n for n in self.names if (self.parts.get(n) or {}).get("fixed")]
            placed = fixed or [max(self.names, key=lambda n: self.volumes[n])]
            steps.append({"parts": list(placed), "base": True})
        while len(placed) < len(self.names):
            for parent in placed:
                kids = []
                for joint in self.joints:
                    for me, other in (("part_a", "part_b"), ("part_b", "part_a")):
                        if joint[me] == parent and joint[other] not in placed and all(joint[other] != k for k, _ in kids):
                            kids.append((joint[other], joint))
                if kids:
                    break
            else:
                # Jointed to nothing placed: next as declared, at its place
                kids = [(next(n for n in self.names if n not in placed), None)]
                parent = None
            for name, joint, direction in self.siblings(parent, kids):
                steps.append({"parts": [name], "direction": (-direction).tolist()})
                placed.append(name)
        return steps

    def siblings(self, parent, kids):
        """The kids of one part in the order they go on: those on one axis from the far end in, all along it from
        the same side; others as declared"""
        groups = {}
        for i, (name, joint) in enumerate(kids):
            axis = joint_axis(joint) if joint and joint.get("type") in AXIS_JOINTS else None
            key = tuple(np.round(axis * np.sign(axis[np.argmax(np.abs(axis))]), 3)) if axis is not None else i
            groups.setdefault(key, []).append((name, joint))
        out = []
        for key, members in groups.items():
            if isinstance(key, int):
                name, joint = members[0]
                out.append((name, joint, self.way_in(name, parent, joint)))
                continue
            axis = np.array(key)
            spread = sum((self.centres[n] - self.centres[parent]) @ axis for n, _ in members)
            sign = 1.0 if spread >= -1e-6 else -1.0
            members.sort(key=lambda m: self.centres[m[0]] @ (axis * sign))
            out += [(name, joint, axis * sign) for name, joint in members]
        return out

    def plan(self):
        """The steps with, for each part going on, where it starts (its way in times how far) and the words"""
        steps, placed = [], []
        for k, step in enumerate(self.order(), 1):
            moves, texts = {}, []
            points = np.concatenate([self.meshes[p].reshape(-1, 3) for p in placed]) if placed else None
            for name in step["parts"]:
                onto, joint = self.partner(name, placed)
                if step.get("base"):
                    continue
                # Given as the way the parts move; they start the other way from their place
                d = -unit(step["direction"]) if step.get("direction") else None
                d = d if d is not None else self.way_in(name, onto, joint)
                gap = 0.08 * self.size + 5
                reach = (points @ d).max() - (self.meshes[name].reshape(-1, 3) @ d).min() + gap if points is not None else gap
                moves[name] = {"onto": onto, "joint": joint, "direction": d, "distance": max(gap, float(reach))}
                way = f" Đưa vào theo hướng {axis_name(-d, signed=True)}."
                if joint:
                    axis = joint_axis(joint)
                    texts.append(DOING.get(joint.get("type"), "Lắp {part} vào {onto}.").format(
                        part=name, onto=onto, axis=axis_name(axis) if axis is not None else "?") + way)
                else:
                    texts.append(f"Đặt {name} vào vị trí của nó (không nối khớp với chi tiết nào đã lắp).{way}")
            if step.get("base"):
                texts = [f"Đặt {', '.join(step['parts'])} làm khung, đứng yên; các chi tiết khác lắp lên đó."]
            steps.append({
                "n": k, "parts": step["parts"], "text": step.get("text") or " ".join(texts), "given": "text" in step,
                "onto": next((m["onto"] for m in moves.values() if m["onto"]), None),
                "joints": [{"id": m["joint"].get("id"), "type": m["joint"].get("type"), "part": name}
                           for name, m in moves.items() if m["joint"]],
                "moves": moves, "image": f"step-{k:02d}.png"})
            placed += step["parts"]
        return steps


class Camera:
    def __init__(self, elevation, azimuth):
        self.elevation, self.azimuth = elevation, azimuth
        e, a = math.radians(elevation), math.radians(azimuth)
        self.towards = np.array([math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)])
        self.right = unit(np.cross([0.0, 0.0, 1.0], self.towards))
        self.up = np.cross(self.towards, self.right)
        # From the viewer's upper left
        self.light = unit(self.towards + 0.7 * self.up - 0.5 * self.right)

    def flat(self, points):
        return np.stack([points @ self.right, points @ self.up], axis=-1)


class Frame:
    """Where the model goes on the picture: every point given fits below the header"""

    def __init__(self, camera, points, fixed_span=None):
        flat = camera.flat(points)
        lo, hi = flat.min(axis=0), flat.max(axis=0)
        span = fixed_span if fixed_span is not None else np.maximum(hi - lo, 1e-6)
        self.scale = min(0.92 * WIDTH / span[0], 0.9 * (HEIGHT - HEADER) / span[1]) * SUPERSAMPLE
        self.middle = (lo + hi) / 2
        self.target = np.array([WIDTH / 2, HEADER + (HEIGHT - HEADER) / 2]) * SUPERSAMPLE

    def place(self, flat):
        return np.stack([self.target[0] + (flat[..., 0] - self.middle[0]) * self.scale,
                         self.target[1] - (flat[..., 1] - self.middle[1]) * self.scale], axis=-1)


def coverage(camera, meshes, size=(240, 180)):
    """Pixels each mesh shows from this camera, at a small size, nearer faces drawn over farther ones"""
    tris = np.concatenate(meshes)
    owner = np.concatenate([np.full(len(m), k) for k, m in enumerate(meshes)])
    flat = camera.flat(tris)
    lo, hi = flat.reshape(-1, 2).min(axis=0), flat.reshape(-1, 2).max(axis=0)
    scale = min((size[0] - 4) / max(hi[0] - lo[0], 1e-6), (size[1] - 4) / max(hi[1] - lo[1], 1e-6))
    corners = 2 + (flat - lo) * scale
    corners[..., 1] = size[1] - corners[..., 1]
    image = Image.new("I", size, 0)
    pen = ImageDraw.Draw(image)
    for i in np.argsort(tris.mean(axis=1) @ camera.towards):
        pen.polygon([tuple(p) for p in corners[i]], fill=int(owner[i]) + 1)
    return np.bincount(np.asarray(image).ravel(), minlength=len(meshes) + 1)[1:]


def best_camera(guide, base):
    """The view, of a few from above, that shows most of the parts that go onto the base: a housing's wall towards
    the viewer would hide everything inside it"""
    inside = [guide.meshes[n] for n in guide.names if n not in base]
    if not inside:
        return Camera(ELEVATION, AZIMUTH)
    walls = [guide.meshes[n] for n in base]
    best, score = None, -1.0
    for elevation in (ELEVATION, 55):
        for azimuth in range(AZIMUTH, AZIMUTH + 360, 45):
            camera = Camera(elevation, azimuth)
            shown = coverage(camera, walls + inside)[len(walls):].sum() / max(coverage(camera, inside).sum(), 1)
            # A little for the usual view, so a symmetric model keeps it
            shown += 0.02 * (elevation == ELEVATION and azimuth == AZIMUTH)
            if shown > score:
                best, score = camera, shown
    return best


def font(size, bold=False):
    import matplotlib

    path = Path(matplotlib.get_data_path()) / "fonts" / "ttf" / ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")
    try:
        return ImageFont.truetype(str(path), size)
    except OSError:
        return ImageFont.load_default()


TITLE, BODY = font(24, bold=True), font(17)


def wrap(draw, text, face, width):
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=face) <= width or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + [line] if line else lines


def draw(camera, frame, pieces, title, text, arrows=()):
    """One picture: pieces [(triangles, colour)], shaded by light, far faces first; arrows [(from, to)] in mm"""
    tris = np.concatenate([t for t, _ in pieces])
    colour = np.concatenate([np.tile(np.array(c, dtype=float), (len(t), 1)) for t, c in pieces])
    normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    normals /= np.maximum(np.linalg.norm(normals, axis=1), 1e-12)[:, None]
    normals *= np.where(normals @ camera.towards < 0, -1, 1)[:, None]
    shade = 0.5 + 0.5 * np.clip(normals @ camera.light, 0, 1)
    fills = np.clip(colour * shade[:, None], 0, 255).astype(int)
    corners = frame.place(camera.flat(tris))
    depth = (tris.mean(axis=1) @ camera.towards)

    image = Image.new("RGB", (WIDTH * SUPERSAMPLE, HEIGHT * SUPERSAMPLE), BACKGROUND)
    pen = ImageDraw.Draw(image)
    for i in np.argsort(depth):
        fill = tuple(fills[i])
        pen.polygon([tuple(p) for p in corners[i]], fill=fill, outline=fill)
    for start, end in arrows:
        a, b = frame.place(camera.flat(np.array([start, end])))
        length = np.linalg.norm(b - a)
        if length < 12 * SUPERSAMPLE:
            continue
        along = (b - a) / length
        dash = 10 * SUPERSAMPLE
        for s in np.arange(0, length - dash, 2 * dash):
            pen.line([tuple(a + along * s), tuple(a + along * min(s + dash, length))], fill=ARROW, width=3 * SUPERSAMPLE)
        side = np.array([-along[1], along[0]])
        head = 16 * SUPERSAMPLE
        pen.polygon([tuple(b), tuple(b - along * head + side * head * 0.5), tuple(b - along * head - side * head * 0.5)],
                    fill=ARROW)
    image = image.resize((WIDTH, HEIGHT), Image.LANCZOS)

    pen = ImageDraw.Draw(image)
    pen.text((24, 14), title, font=TITLE, fill=INK)
    for k, line in enumerate(wrap(pen, text, BODY, WIDTH - 48)[:3]):
        pen.text((24, 46 + 21 * k), line, font=BODY, fill=INK)
    return image


def ease(t):
    return t * t * (3 - 2 * t)


class Video:
    """assembly.mp4 through ffmpeg, frames written as they are drawn; does nothing without ffmpeg"""

    def __init__(self, path):
        self.path, self.frames, self.proc = path, 0, None
        if shutil.which("ffmpeg"):
            self.proc = subprocess.Popen(
                ["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}",
                 "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                 "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path)],
                stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    def add(self, image, times=1):
        self.frames += times
        if self.proc:
            data = image.tobytes()
            for _ in range(times):
                self.proc.stdin.write(data)

    def close(self):
        if not self.proc:
            return "Không có ffmpeg nên không làm được video."
        self.proc.stdin.close()
        error = self.proc.stderr.read().decode("utf-8", "replace")
        return None if self.proc.wait() == 0 else f"ffmpeg: {error.strip()[-300:]}"


def make(out):
    started = time.monotonic()
    guide = Guide(out)
    steps = guide.plan()
    folder = out / GUIDE_DIR
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir()

    camera = best_camera(guide, steps[0]["parts"])
    # One framing for every step, so the model stays put while parts come in from wherever they start
    points = [m.reshape(-1, 3) for m in guide.meshes.values()]
    points += [guide.meshes[name].reshape(-1, 3) + move["direction"] * move["distance"]
               for step in steps for name, move in step["moves"].items()]
    frame = Frame(camera, np.concatenate(points))
    video = Video(folder / "assembly.mp4")
    total = len(steps)
    placed = []
    for step in steps:
        title = f"Bước {step['n']}/{total}"
        moves = step["moves"]

        def picture(t, arrows):
            pieces = [(guide.meshes[p], PLACED) for p in placed]
            pieces += [(guide.meshes[p] + (moves[p]["direction"] * moves[p]["distance"] * (1 - t) if p in moves else 0), MOVING)
                       for p in step["parts"]]
            lines = [(guide.centres[p] + moves[p]["direction"] * moves[p]["distance"] * (1 - t),
                      guide.centres[p] + moves[p]["direction"] * min(moves[p]["distance"] * (1 - t), 0.25 * moves[p]["distance"]))
                     for p in moves] if arrows else []
            return draw(camera, frame, pieces, title, step["text"], lines)

        start = picture(0, arrows=True)
        start.save(folder / step["image"])
        video.add(start, HOLD_BEFORE if moves else HOLD_BEFORE + MOVE)
        if moves:
            for k in range(1, MOVE + 1):
                video.add(picture(ease(k / MOVE), arrows=False))
            video.add(picture(1, arrows=False), HOLD_AFTER)
        placed += step["parts"]

    # The finished model, turned round once
    everything = np.concatenate([m.reshape(-1, 3) for m in guide.meshes.values()])
    centre = everything.mean(axis=0)
    radius = float(np.linalg.norm(everything - centre, axis=1).max())
    for k in range(TURN):
        turning = Camera(camera.elevation, camera.azimuth + 360 * k / TURN)
        ring = Frame(turning, np.array([centre]), fixed_span=np.array([2 * radius, 2 * radius]))
        image = draw(turning, ring, [(guide.meshes[p], PLACED) for p in guide.names], "Hoàn thành",
                     f"{len(guide.names)} chi tiết đã lắp xong.")
        if k == 0:
            image.save(folder / "done.png")
        video.add(image)
    video_error = video.close()

    result = {
        "ok": True,
        "order": "model" if guide.given else "mechanism",
        "steps": [{key: value for key, value in step.items() if key != "moves"} | {
            "moves_along": {name: [round(float(-c), 4) + 0.0 for c in m["direction"]] for name, m in step["moves"].items()},
            "distance_mm": {name: round(m["distance"], 1) for name, m in step["moves"].items()}} for step in steps],
        "video": None if video_error else "assembly.mp4",
        "video_error": video_error,
        "video_seconds": round(video.frames / FPS, 1),
        "done_image": "done.png",
        "seconds": round(time.monotonic() - started, 1),
    }
    (folder / "guide.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    return result


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    out = Path(sys.argv[1]).resolve()
    try:
        result = make(out)
    except Exception as err:  # noqa: BLE001 - said in the result, the job itself is built already
        result = {"ok": False, "error": f"{type(err).__name__}: {err}"}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
