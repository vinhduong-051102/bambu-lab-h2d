"""
DfAM check of a built job: python dfam.py <out dir>

text-to-cad's dfam-check made without Claude: its fact-only tool (text-to-cad/skills/dfam-check/scripts/dfam_tool.py)
measures out/model.stl, what is printed (watertightness, wall thickness by ray casting, overhangs, a support
volume estimate, the six axis-aligned orientations), and the facts are compared with the FDM column of the skill's
process limits (references/process-limits.md). Writes <out>/dfam.json and prints it:

  {"ok", "process": "FDM", "angle_limit_deg", "findings": [{"status": "pass" | "fail" | "info", "title",
   "detail"}], "measure": <the tool's measure>, "orientations": <its orientations>}

Statuses as the skill words them: pass, the fact meets the cited limit; fail, it breaks it; info, not measured or
needing a person's judgement (no verdict is guessed).
"""

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = HERE / "text-to-cad" / "skills" / "dfam-check" / "scripts" / "dfam_tool.py"
SOURCE = "text-to-cad dfam-check, process-limits.md (FDM/FFF)"
# The FDM/FFF column of process-limits.md
ANGLE_LIMIT = 45.0
MIN_SUPPORTED_WALL = 1.2
MIN_UNSUPPORTED_WALL = 1.6
SUPPORT_RATIO_HIGH = 30.0
TIMEOUT_S = 240


def tool(*args):
    done = subprocess.run([sys.executable, str(TOOL), *args], capture_output=True, text=True, timeout=TIMEOUT_S,
                          check=False)
    if done.returncode == 1 or not done.stdout.strip():
        raise RuntimeError((done.stdout.strip() or done.stderr.strip()[-500:]) or "dfam_tool.py không trả kết quả")
    return json.loads(done.stdout)


def findings_of(measure, orientations):
    out = []

    def add(status, title, detail):
        out.append({"status": status, "title": title, "detail": detail})

    mesh = measure.get("mesh") or {}
    if mesh.get("watertight") is False:
        add("fail", "Lưới không kín", "Lưới hở thì không cắt lớp được ở mọi công nghệ: sửa mô hình trước.")
    elif mesh.get("watertight"):
        add("pass", "Lưới kín", f"{mesh.get('body_count', 1)} khối, {mesh.get('triangle_count')} tam giác.")

    wall = measure.get("wall_thickness") or {}
    if "error" in wall or not wall.get("samples_valid"):
        add("info", "Chưa đo được độ dày thành", str(wall.get("error") or wall.get("note") or "không có mẫu"))
    else:
        p05, low = wall.get("p05_mm"), wall.get("min_mm")
        where = (wall.get("thinnest_samples") or [{}])[0].get("location_xyz")
        if p05 is not None and p05 < MIN_SUPPORTED_WALL:
            add("fail", f"Thành mỏng: 5% mẫu dưới {p05:g} mm",
                f"Giới hạn FDM {MIN_SUPPORTED_WALL:g} mm (thành có đỡ). Mỏng nhất {low:g} mm"
                + (f" ở {where}." if where else "."))
        elif low is not None and low < MIN_SUPPORTED_WALL:
            add("info", f"Một vài điểm mỏng {low:g} mm",
                f"5% mẫu vẫn dày từ {p05:g} mm (≥ {MIN_SUPPORTED_WALL:g} mm): có thể là cạnh vát hay mép lỗ"
                + (f", xem chỗ {where}." if where else "."))
        else:
            add("pass", f"Thành dày từ {low:g} mm",
                f"≥ {MIN_SUPPORTED_WALL:g} mm (thành có đỡ); thành đứng tự do nên từ {MIN_UNSUPPORTED_WALL:g} mm.")

    overhang = measure.get("overhangs") or {}
    support = measure.get("support_volume") or {}
    pct = overhang.get("down_facing_area_below_limit_pct")
    if pct is None:
        add("info", "Chưa đo được phần nhô", str(overhang.get("error") or ""))
    elif pct <= 0:
        add("pass", "Không cần support", f"Không mặt úp nào dốc quá {ANGLE_LIMIT:g}° so với phương ngang.")
    else:
        ratio = support.get("support_to_part_ratio_pct")
        detail = (f"{pct:g}% diện tích bề mặt úp xuống dưới {ANGLE_LIMIT:g}°"
                  + (f"; support ước tính {ratio:g}% thể tích chi tiết (ước lượng trên)." if ratio is not None else "."))
        add("fail" if ratio is not None and ratio > SUPPORT_RATIO_HIGH else "info",
            "Cần support" + (" nhiều" if ratio is not None and ratio > SUPPORT_RATIO_HIGH else ""), detail)

    candidates = (orientations.get("orientations") or {}).get("candidates") or []
    current = next((c for c in candidates if c["orientation"] == "current_plus_z"), None)
    best = min(candidates, key=lambda c: c["support_area_mm2"], default=None)
    if current and best and best is not current \
            and best["support_area_mm2"] < 0.7 * current["support_area_mm2"] \
            and current["support_area_mm2"] - best["support_area_mm2"] > 100:
        add("info", "Có hướng đặt ít support hơn",
            f"{best['orientation']}: {best['support_area_mm2']:g} mm² mặt cần đỡ thay vì "
            f"{current['support_area_mm2']:g} mm², cao {best['build_height_mm']:g} mm thay vì "
            f"{current['build_height_mm']:g} mm.")

    add("info", "Chưa kiểm tra",
        "Đường kính lỗ nhỏ nhất (2 mm), chi tiết nhỏ nhất (0,8 mm) và cầu không đỡ (10 mm): công cụ chưa đo được.")
    return out


def main():
    out = Path(sys.argv[1]).resolve()
    stl = out / "model.stl"
    try:
        if not stl.exists():
            raise FileNotFoundError("Chưa có out/model.stl: dựng mô hình trước.")
        measure = tool("measure", str(stl), "--angle-limit", str(ANGLE_LIMIT))
        orientations = tool("orientations", str(stl), "--angle-limit", str(ANGLE_LIMIT))
        report = {"ok": True, "process": "FDM", "source": SOURCE, "angle_limit_deg": ANGLE_LIMIT,
                  "findings": findings_of(measure, orientations), "partial": bool(measure.get("partial")),
                  "measure": measure, "orientations": orientations.get("orientations")}
    except Exception as err:  # noqa: BLE001 - what went wrong is the answer
        report = {"ok": False, "error": f"{type(err).__name__}: {err}"}
    (out / "dfam.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
