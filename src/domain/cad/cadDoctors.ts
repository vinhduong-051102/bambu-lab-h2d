/**
 * How each kind of background work is run again after a failure (retryDoctor.ts): the knobs a retry may turn on
 * it, and the rules for the failures it is known to meet. The defaults are the workers' own (cad/worker.py).
 */
import { longer, type Doctor, type Tuning } from '../retryDoctor';

const TIMEOUT = /quá \d+ giây|không trả lời kịp/;

/** The assembly guide (cad/assembly_guide.py): a picture per step and a video of every move */
export const GUIDE_DOCTOR: Doctor = {
  about: 'Vẽ hướng dẫn lắp (ảnh từng bước và video) của một mô hình nhiều chi tiết, bằng Python vẽ từng tam giác.',
  knobs: {
    timeout_s: { type: 'number', min: 60, max: 1800, describe: 'Thời gian cho phép (giây)' },
    grid_cells: { type: 'number', min: 100, max: 1000, describe: 'Độ mịn lưới khi vẽ (ô trên bề rộng mô hình; ít hơn thì nhanh hơn)' },
    video: { type: 'boolean', describe: 'Làm video (tắt thì chỉ vẽ ảnh từng bước)' },
  },
  rules: [
    {
      match: TIMEOUT,
      cause: 'Mô hình nhiều chi tiết, nhiều tam giác: vẽ từng khung hình không kịp trong thời gian cho phép.',
      // Longer and coarser first; then without the video; then nothing left to turn
      tune: (t) => {
        const more = longer(GUIDE_DOCTOR, t, 'timeout_s', 420);
        if (more) return { ...more, grid_cells: Math.min((t.grid_cells as number) || 500, 300) };
        return t.video === false ? null : { ...t, video: false };
      },
    },
  ],
};

/** The engineering drawing (cad/drawing.py): views with hidden lines, a sheet per printed part */
export const DRAWING_DOCTOR: Doctor = {
  about: 'Vẽ bản vẽ kỹ thuật A3 (hình chiếu có nét khuất, mỗi chi tiết in một tờ) bằng text-to-cad.',
  knobs: {
    timeout_s: { type: 'number', min: 60, max: 1800, describe: 'Thời gian cho phép (giây)' },
    max_sheets: { type: 'number', min: 1, max: 12, describe: 'Số tờ tối đa (mỗi chi tiết in một tờ)' },
  },
  rules: [
    {
      match: TIMEOUT,
      cause: 'Nhiều chi tiết, mỗi hình chiếu tính nét khuất: vẽ không kịp.',
      tune: (t) => {
        const more = longer(DRAWING_DOCTOR, t, 'timeout_s', 300);
        const sheets = (t.max_sheets as number) || 12;
        if (more) return { ...more, max_sheets: Math.min(sheets, 6) };
        return sheets > 3 ? { ...t, max_sheets: 3 } : null;
      },
    },
  ],
};

/** The DfAM check (cad/dfam.py): wall thickness by ray casting, overhangs, orientations */
export const DFAM_DOCTOR: Doctor = {
  about: 'Kiểm tra DfAM (bề dày thành bằng dò tia, phần nhô, hướng in) trên lưới STL của mô hình.',
  knobs: { timeout_s: { type: 'number', min: 60, max: 2400, describe: 'Thời gian cho phép (giây)' } },
  rules: [{ match: TIMEOUT, cause: 'Lưới lớn: dò bề dày thành không kịp.', tune: (t) => longer(DFAM_DOCTOR, t, 'timeout_s', 600) }],
};

/** The engineering check of a model (mesh3d eng): inspect, clearance, printability, a thickness render */
export const ENG_DOCTOR: Doctor = {
  about: 'Kiểm tra kỹ thuật một mô hình in trong container mesh3d: đo, kiểm lưới, khe hở, khả năng in, ảnh bề dày.',
  knobs: { render: { type: 'boolean', describe: 'Vẽ ảnh bề dày bằng Blender (tắt cho nhanh)' } },
  rules: [
    {
      match: /không trả lời kịp|quá lâu/,
      cause: 'Phép kiểm tra chạy quá lâu, phần lớn là vẽ ảnh bề dày bằng Blender.',
      tune: (t) => (t.render === false ? null : { ...t, render: false }),
    },
  ],
};

/** A model Claude designs (cad/worker.py generate): its run is given the failure and the analysis */
export const CLAUDE_MODEL_DOCTOR: Doctor = {
  about: 'Claude Code thiết kế một mô hình CAD build123d theo request.md, dựng và tự kiểm tra (container cad).',
  knobs: { timeout_s: { type: 'number', min: 600, max: 7200, describe: 'Thời gian cho Claude (giây)' } },
  rules: [
    {
      match: /Claude chạy quá \d+ phút/,
      cause: 'Claude chưa xong trong thời gian cho phép (mô hình lớn, dựng lại nhiều lần).',
      tune: (t) => longer(CLAUDE_MODEL_DOCTOR, t, 'timeout_s', 2400),
      hint: 'Lần trước hết giờ: tiếp tục từ model.py đang có, dựng ít lần hơn (gộp nhiều sửa vào một lần dựng), làm phần còn thiếu trước.',
    },
    {
      match: /không dựng được|Lần dựng cuối/,
      cause: 'Mã Claude viết không dựng được.',
      hint: 'Đọc kỹ lỗi dựng ở trên, sửa đúng chỗ gây lỗi trong model.py rồi dựng lại; đừng viết lại toàn bộ.',
    },
  ],
};

/** A model whose code was given as it is (source "code"): built again, or fixed by Claude when it does not build */
export const CODE_MODEL_DOCTOR: Doctor = {
  about: 'Dựng một model.py viết sẵn (build123d) bằng build.py; nếu mã lỗi thì Claude có thể sửa cho dựng được.',
  knobs: {
    timeout_s: { type: 'number', min: 60, max: 1800, describe: 'Thời gian dựng (giây)' },
    claude_fix: { type: 'boolean', describe: 'Nhờ Claude sửa model.py cho dựng được' },
  },
  rules: [
    {
      match: /Dựng mô hình quá \d+ giây/,
      cause: 'Mô hình lớn (nhiều chi tiết, xếp bàn in): dựng không kịp trong thời gian cho phép.',
      tune: (t) => longer(CODE_MODEL_DOCTOR, t, 'timeout_s', 180),
    },
    {
      match: /Traceback|Error|không dựng được|lỗi/i,
      cause: 'model.py viết sẵn bị lỗi khi dựng.',
      tune: (t) => (t.claude_fix ? null : { ...t, claude_fix: true }),
      hint: 'Sửa đúng lỗi dựng ở trên, giữ nguyên thiết kế và thông số.',
    },
  ],
};

/** A figure (mesh3d): Hunyuan3D-2 shapes it, Claude fixes and paints it in Blender */
export const FIGURE_DOCTOR: Doctor = {
  about: 'Tạo/sửa nhân vật in 3D: Hunyuan3D-2 dựng hình trên GPU từ ảnh, Claude sửa và tô màu trong Blender (container mesh3d).',
  knobs: {},
  rules: [
    {
      match: /GPU hết bộ nhớ|out of memory/i,
      cause: 'GPU hết bộ nhớ khi dựng hình.',
      stop: 'Đóng bớt ứng dụng đang dùng GPU (game, Blender khác…) rồi thử lại.',
    },
    {
      match: /Claude chạy quá \d+ phút/,
      cause: 'Claude chưa sửa xong trong thời gian cho phép.',
      tune: (t) => t,
      hint: 'Lần trước hết giờ: làm việc quan trọng nhất trước, ít vòng thử hơn, xuất mô hình sớm rồi mới tinh chỉnh.',
    },
    {
      match: /Blender không sẵn sàng/,
      cause: 'Blender trong container chưa khởi động kịp.',
      tune: (t) => t,
    },
  ],
};

/** The worker's time for a call, and the gateway's wait for its answer a little longer */
export const waitFor = (tuning: Tuning, fallbackS: number) => ((typeof tuning.timeout_s === 'number' ? tuning.timeout_s : fallbackS) + 30) * 1000;
