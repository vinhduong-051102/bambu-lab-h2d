"""
The engineering report of one model version: the latest analysis of each kind (or the ones named), in Markdown and
HTML, in the eleven sections the brief asks for. Each check keeps its status (PASS, WARNING, FAIL,
NOT_EVALUATED); a section with nothing run says NOT_EVALUATED, never PASS.
"""

import base64
import html

from . import schema
from .schema import NOT_EVALUATED
from .store import analysis_dir, list_analyses, load_analysis, new_analysis, now, write_json

KINDS = ["inspect", "validate", "assembly", "clearance", "motion", "fea", "printability", "visualize"]
BADGE = {"PASS": "#15803d", "WARNING": "#b45309", "FAIL": "#b91c1c", "NOT_EVALUATED": "#6b7280"}


def latest(model, kinds, chosen=None):
    found = {}
    if chosen:
        for aid in chosen:
            r = load_analysis(aid)
            if r and r.get("model_id") == model["model_id"]:
                found.setdefault(r["kind"], []).append(r)
    for kind in kinds:
        if kind in found:
            continue
        for entry in list_analyses(model["model_id"], kind):
            if entry.get("model_version") == model["version"] and entry.get("state", "completed") == "completed":
                found[kind] = [load_analysis(entry["analysis_id"])]
                break
    return found


def fmt(value):
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.4g}"
    if isinstance(value, list):
        return "[" + ", ".join(fmt(v) for v in value) + "]"
    return str(value)


def check_rows(checks):
    rows = ["| Trạng thái | Kiểm tra | Giá trị | Giới hạn | Chi tiết |", "|---|---|---|---|---|"]
    for c in checks:
        unit = f" {c['unit']}" if c.get("unit") else ""
        rows.append(f"| **{c['status']}** | {c['title']} | {fmt(c.get('value'))}{unit if c.get('value') is not None else ''}"
                    f" | {fmt(c.get('limit'))} | {c.get('detail', '').replace('|', '/')} |")
    return rows


def section(title, results, lines_for):
    out = [f"## {title}", ""]
    if not results:
        out += [f"**{NOT_EVALUATED}**: chưa chạy phân tích này.", ""]
        return out, [], NOT_EVALUATED
    checks = []
    for r in results:
        out += [f"Phân tích `{r.get('analysis_id')}` lúc {r.get('finished_at') or r.get('started_at')}, "
                f"trạng thái **{r['status']}**" + (f", engine {r['engine']}" if r.get("engine") else "") + ".", ""]
        out += lines_for(r)
        if r.get("error"):
            out += [f"> Lỗi: {r['error']}", ""]
        if r["checks"]:
            out += check_rows(r["checks"]) + [""]
        checks += r["checks"]
    return out, checks, schema.overall(checks)


def build(model, analysis_ids=None):
    found = latest(model, KINDS, analysis_ids)
    report_id, folder = new_analysis("report")
    md = [f"# Báo cáo kỹ thuật: {model['name']}", "",
          f"Mô hình `{model['model_id']}` phiên bản {model['version']}, tạo báo cáo {now()}. Đơn vị: mm, N, MPa, độ.", "",
          "Phân loại: **PASS** đạt tiêu chí đã xác định · **WARNING** cần kiểm tra thêm · **FAIL** vi phạm tiêu chí · "
          "**NOT_EVALUATED** thiếu dữ liệu hoặc chưa chạy. Không có lỗi phát hiện không có nghĩa là PASS.", ""]
    summary = []

    def add(title, kind, lines_for=lambda r: []):
        lines, checks, status = section(title, found.get(kind, []), lines_for)
        md.extend(lines)
        summary.append((title, status, len(checks)))

    def model_info(r):
        d = r["data"]
        rows = ["| Chi tiết | Nguồn | Kích thước (mm) | Thể tích (mm³) | Mặt | Khối |", "|---|---|---|---|---|---|"]
        src = {s["id"]: s for s in d.get("sources", [])}
        for cid, c in d["components"].items():
            rows.append(f"| {cid} | {src.get(cid, {}).get('source_label', '')} | {fmt(c['size'])} | {fmt(c['volume'])} | "
                        f"{c['faces']} | {c['bodies']} |")
        return [f"Kích thước cả cụm: {fmt(d['assembly_size'])} mm.", ""] + rows + [""]

    md += ["## 1. Thông tin mô hình", "", f"- Tên: {model['name']}", f"- Mã: `{model['model_id']}` v{model['version']}",
           f"- Tạo lúc: {model['created_at']}", f"- Số chi tiết: {len(model['components'])}",
           "- File gốc (giữ nguyên, SHA-256): " + ", ".join(
               f"{c['source_label']} `{c['source_sha256'][:12]}…`" for c in model["components"]), ""]
    add("2. Kích thước và đặc điểm hình học", "inspect", model_info)
    add("3. Lỗi lưới (mesh)", "validate")

    def assembly_lines(r):
        d = r["data"]
        out = []
        if d.get("suggested_joints"):
            out += ["Khớp đề xuất từ hình học (cần người dùng xác nhận):", ""]
            out += [f"- {s['type']} {s['component_a']}–{s['component_b']}: {s['reason']}" for s in d["suggested_joints"]]
            out.append("")
        if d.get("joints"):
            out += ["Khớp đã xác nhận:", ""] + [f"- {j['id']}: {j['type']} {j['component_a']}–{j['component_b']}"
                                               for j in d["joints"]] + [""]
        return out

    add("4. Kiểm tra lắp ráp", "assembly", assembly_lines)
    add("5. Khe hở và dung sai", "clearance")

    def motion_lines(r):
        s = r["data"].get("summary") or {}
        out = [f"Chạy `{r.get('sim_id')}`: {s.get('result_kind', '')}.", ""]
        for jid, j in (s.get("joints") or {}).items():
            out.append(f"- {jid} ({j['kind']}): giá trị {fmt(j.get('value'))}, phản lực lớn nhất "
                       f"{fmt(j.get('max_reaction_force_N'))} N")
        return out + [""]

    add("6. Mô phỏng chuyển động", "motion", motion_lines)

    def fea_lines(r):
        d = r.get("data") or {}
        if not d.get("levels"):
            return []
        rows = ["| Lưới h (mm) | Nút | Phần tử | Chuyển vị lớn nhất (mm) | von Mises đỉnh (MPa) | von Mises ngoài vùng biên (MPa) |",
                "|---|---|---|---|---|---|"]
        rows += [f"| {fmt(l['mesh_size_mm'])} | {l['nodes']} | {l['elements']} | {fmt(l['max_displacement_mm'])} | "
                 f"{fmt(l['max_von_mises_MPa'])} | {fmt(l['robust_max_von_mises_MPa'])} |" for l in d["levels"]]
        cfg = r["inputs"]["config"]
        mat = cfg["material"]
        return [f"Chi tiết {d['component']}, vật liệu {mat.get('name') or '?'}: E = {fmt(mat['young_modulus_MPa'])} MPa, "
                f"ν = {fmt(mat['poisson_ratio'])} (nguồn: {mat.get('source')}).", ""] + rows + [""]

    add("7. Phân tích độ bền (FEM)", "fea", fea_lines)

    def print_lines(r):
        need = r["data"].get("calibration_needed") or []
        return ([f"Cần hiệu chuẩn trước khi sản xuất: {', '.join(need)}.", ""] if need else [])

    add("8. Đánh giá khả năng in 3D", "printability", print_lines)

    # 9. Assumptions and missing data, from every analysis
    md += ["## 9. Giả định và dữ liệu còn thiếu", ""]
    seen = set()
    for kind, results in found.items():
        for r in results:
            for a in r.get("assumptions", []):
                key = (a.get("path"), a.get("message"))
                if key not in seen:
                    seen.add(key)
                    md.append(f"- Giả định ({kind}) `{a.get('path')}`: {a.get('message')}")
            for m in r.get("missing", []):
                if m not in seen:
                    seen.add(m)
                    md.append(f"- Thiếu ({kind}): {m}")
            for w in r.get("warnings", []):
                key = (w.get("path"), w.get("message"))
                if key not in seen:
                    seen.add(key)
                    md.append(f"- Cảnh báo ({kind}) `{w.get('path')}`: {w.get('message')}")
    md.append("")

    # 10. Recommendations: from the failed and warned checks
    md += ["## 10. Khuyến nghị sửa đổi thiết kế", ""]
    recs = [c for rs in found.values() for r in rs for c in r["checks"] if c["status"] in ("FAIL", "WARNING")]
    md += [f"- **{c['status']}** {c['title']}: {c['detail']}" for c in recs] or ["- Không có (trong những gì đã kiểm tra)."]
    md.append("")

    # 11. Confidence
    md += ["## 11. Mức độ tin cậy và giới hạn", "", "| Mục | Trạng thái | Số kiểm tra |", "|---|---|---|"]
    md += [f"| {t} | **{s}** | {n} |" for t, s, n in summary]
    md += ["", "- Hình học đo trên lưới tam giác: độ chính xác theo độ mịn lưới; không có thông tin CAD (dung sai, ren, "
           "vật liệu) trừ khi người dùng cung cấp.",
           "- Chuyển động: vật rắn lý tưởng (Project Chrono); không nói gì về cong, gãy.",
           "- FEM: tuyến tính, đẳng hướng, chi tiết coi là đặc; vật in FDM dị hướng và phụ thuộc infill/số thành. Ứng "
           "suất đỉnh ở vùng ngàm/góc sắc có thể là điểm kỳ dị số học.",
           "- Khả năng in: quy tắc hình học; sai số thật phải đo bằng mẫu hiệu chuẩn trên đúng máy, vật liệu, thông số.",
           ""]
    images = [(r, f) for r in found.get("visualize", []) for f in ("result.png",) if (r.get("files") or {}).get(f)]
    if images:
        md += ["## Hình minh họa", ""]
        for r, f in images:
            (folder / f"{r['analysis_id']}.png").write_bytes((analysis_dir(r["analysis_id"]) / f).read_bytes())
            md += [f"![{r['inputs'].get('mode')}]({r['analysis_id']}.png)", ""]
    text = "\n".join(md)
    (folder / "report.md").write_text(text, encoding="utf-8")
    (folder / "report.html").write_text(to_html(text, folder), encoding="utf-8")
    overall = schema.overall([{"status": s} for _, s, _ in summary])
    result = schema.new_result("report", model, {"analysis_ids": analysis_ids})
    result.update(analysis_id=report_id, state="completed", status=overall, started_at=now(), finished_at=now(),
                  files={"report.md": "report.md", "report.html": "report.html"},
                  data={"sections": [{"title": t, "status": s, "checks": n} for t, s, n in summary],
                        "analyses": {k: [r.get("analysis_id") for r in v] for k, v in found.items()}})
    write_json(folder / "result.json", result)
    return result, text


def to_html(md, folder):
    """A small Markdown subset (headings, lists, tables, bold, code, images) to a self-contained HTML page"""
    import re

    def inline(s):
        s = html.escape(s)
        s = re.sub(r"\*\*(PASS|WARNING|FAIL|NOT_EVALUATED)\*\*",
                   lambda m: f'<span class="b" style="background:{BADGE[m.group(1)]}">{m.group(1)}</span>', s)
        s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
        return re.sub(r"`(.+?)`", r"<code>\1</code>", s)

    body, table, items = [], [], []

    def flush():
        if table:
            head, rows = table[0], table[2:]
            body.append("<table><thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in head) + "</tr></thead><tbody>"
                        + "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in rows)
                        + "</tbody></table>")
            table.clear()
        if items:
            body.append("<ul>" + "".join(f"<li>{inline(i)}</li>" for i in items) + "</ul>")
            items.clear()

    for line in md.splitlines():
        if line.startswith("|"):
            table.append([c.strip() for c in line.strip("|").split("|")])
            continue
        if line.startswith("- "):
            items.append(line[2:])
            continue
        flush()
        m = re.match(r"!\[(.*?)\]\((.+?)\)", line)
        if line.startswith("# "):
            body.append(f"<h1>{inline(line[2:])}</h1>")
        elif line.startswith("## "):
            body.append(f"<h2>{inline(line[3:])}</h2>")
        elif m:
            data = base64.b64encode((folder / m.group(2)).read_bytes()).decode()
            body.append(f'<img alt="{html.escape(m.group(1))}" src="data:image/png;base64,{data}">')
        elif line.startswith("> "):
            body.append(f"<blockquote>{inline(line[2:])}</blockquote>")
        elif line.strip():
            body.append(f"<p>{inline(line)}</p>")
    flush()
    style = ("body{font-family:system-ui,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#1f2937}"
             "table{border-collapse:collapse;width:100%;margin:8px 0;font-size:14px}th,td{border:1px solid #d1d5db;"
             "padding:4px 8px;text-align:left;vertical-align:top}th{background:#f3f4f6}.b{color:#fff;padding:1px 6px;"
             "border-radius:4px;font-size:12px}img{max-width:100%;border:1px solid #e5e7eb}code{background:#f3f4f6;"
             "padding:0 3px}h2{border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin-top:28px}")
    return (f"<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\"><title>Báo cáo kỹ thuật</title>"
            f"<style>{style}</style></head><body>{''.join(body)}</body></html>")

