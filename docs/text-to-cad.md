# text-to-cad trong gateway

The technical-part side of **Thiết kế mô hình bằng AI** ([cad.md](cad.md)) runs on
[text-to-cad](https://github.com/earthtojake/text-to-cad) (MIT): cadgen's engine builds the models, its OCCT
renderer draws the previews, its exporters write the files, and Claude in the `cad` container works with
text-to-cad's own skills, as it does on this computer in `cad-projects`.

## What each side had

| Chức năng | Gateway (trước) | text-to-cad | Bây giờ |
| --- | --- | --- | --- |
| Claude viết mô hình kỹ thuật bằng build123d | `claude -p` + `cad/guide.md`, file gán `result` | Skill `cad`: hàm `@model`, engine cadgen giữ bản dựng ấm | **Thay**: skill `cad` của text-to-cad, `@model` |
| Dựng mô hình | `runpy` + build123d 0.13 | Engine cadgen (dựng lại phần đã đổi) | **Thay**: engine cadgen; file cũ gán `result` vẫn dựng được |
| Ảnh xem trước | matplotlib, 4 góc, tô bóng thô | `cadgen snapshot`: OCCT vẽ như CAD Viewer | **Thay**: 4 góc vẽ bằng `cadgen snapshot` (matplotlib chỉ khi không có OpenGL) |
| Xuất file | STL, STEP (build123d) | STEP, STL, 3MF, GLB, xbf, DXF (giữ tên, màu, vật liệu, khớp) | **Thay**: `cadgen export`; thêm **GLB** |
| Báo cáo dựng (kích thước, thể tích, lưới kín, vừa bàn H2D, nằm trên Z = 0) | Có | Một phần (bounds, số part) | Giữ, đo trên hình cadgen dựng |
| Đo, tra tham chiếu mặt/cạnh (`cadgen inspect`) | Không | Có | **Thêm**: Claude dùng khi làm việc |
| Linh kiện mua sẵn STEP (ổ bi, servo, vít) | Không | Skill `step-parts` (step.parts) | **Thêm**: Claude tải STEP thật từ step.parts |
| Khớp, tư thế, hoạt ảnh tháo rời (GLB) | Không | `cadgen.ap242`, `cadgen.gltf` | **Thêm**: theo skill `cad`; hoạt ảnh nằm trong GLB |
| Bản vẽ kỹ thuật PDF | Không | Skill `engineering-drawing` (`cadgen.eng_drawing`) | **Thêm**: nút **📐 Bản vẽ**, `POST /api/cad/jobs/:id/drawing` |
| Kiểm tra DfAM (thành mỏng, overhang, support, hướng in) | Không (chỉ `analyze_printability` của mesh3d) | Skill `dfam-check` | **Thêm**: nút **🧪 DfAM**, `POST /api/cad/jobs/:id/dfam` |
| DFM gia công (tấm, CNC, ép phun), DXF, URDF/SRDF/SDF, SendCutSend | Không | Các skill tương ứng | **Thêm**: Claude dùng khi yêu cầu cần; file nằm trong `out/exports/` và tải về từ thẻ |
| Sửa mô hình (revision), cây phiên bản | Có | Không (sửa script tại chỗ) | Giữ |
| Lắp ráp: components, `mechanism`, xếp bàn in nhiều plate, 3MF từng plate | Có | Không có xếp bàn in | Giữ; components là các con có nhãn của assembly `@model` |
| Hướng dẫn lắp (ảnh từng bước, video) | Có | Không | Giữ |
| STEP/IGES → STL từng solid | Có (`convert.py`) | `cadgen export` STEP → STL cả khối, không IGES | Giữ của gateway |
| Tấm hiệu chuẩn dung sai | Có | Không | Giữ, viết lại theo `@model` |
| Nhân vật (Hunyuan3D-2 + Blender) | Có | Không | Giữ |
| Gửi sang Studio | Có (Studio trong Docker) | Skill `bambu-labs` (Bambu Connect / Studio trên máy) | Giữ của gateway: Studio của gateway làm đúng việc này |
| Cắt lớp G-code | Studio | Skill `gcode` (OrcaSlicer) | Không ghép: Studio của gateway cắt lớp cho H2D |
| Mô phỏng Chrono, FEA, kiểm tra kỹ thuật | Có | Không | Giữ |
| MCP cho agent | `bambu-cad` (Antigravity) | `cad` (cad_show, inspect, snapshot, export) | Giữ `bambu-cad`; `cad_build` nhận cả `@model` |
