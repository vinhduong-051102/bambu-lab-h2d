'use client';

// The cards not yet ported to antd: their markup from the former DashboardMarkup, wired up by their
// original scripts (element ids are the contract), mounted once.
import { memo, useEffect } from 'react';
import { initCad } from '../cad';
import { initPrintHistory } from '../prints';
import { useActions } from '../DashboardContext';

type Init = (deps: { showToast: (message: string, type?: string) => void; addLog: (message: string, type?: string) => void }) => () => void;

function useLegacy(init: Init) {
  const { showToast, addLog } = useActions();
  useEffect(() => init({ showToast, addLog } as Parameters<Init>[0]), [init, showToast, addLog]);
}

export const LegacyCadCard = memo(function LegacyCadCard() {
  useLegacy(initCad as Init);
  return (
      <section data-page="cad" className="card cad-card" id="cadCard" hidden>
        <div className="card-header">
          <div className="header-title">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2 3 7v10l9 5 9-5V7z" />
              <path d="m3 7 9 5 9-5M12 12v10" />
            </svg>
            <h2>Thiết kế mô hình bằng AI</h2>
          </div>
          <div className="studio-toolbar">
            <span className="cad-worker-status" id="cadWorkerStatus" />
            <button type="button" className="btn-ams-action" id="btnCadRefresh">↻ Làm mới</button>
          </div>
        </div>
        <form className="cad-form" id="cadForm">
          {/* Technical parts: Claude writes build123d in the CAD container. Figures: Hunyuan3D-2 on the GPU (mesh3d) */}
          <div className="cad-kind" id="cadKind" role="radiogroup" aria-label="Loại mô hình" hidden>
            <label className="cad-kind-option">
              <input type="radio" name="cadKind" value="technical" defaultChecked />
              <span>🔧 Kỹ thuật</span>
            </label>
            <label className="cad-kind-option">
              <input type="radio" name="cadKind" value="figure" />
              <span>🧸 Nhân vật / trang trí</span>
            </label>
          </div>
          <textarea id="cadPrompt" className="cad-prompt" rows={3} maxLength={4000} />
          <div className="cad-figure-fields" id="cadFigureFields" hidden>
            <label className="btn-ams-action cad-image-btn">
              <input type="file" id="cadImage" accept="image/png,image/jpeg,image/webp" hidden />
              🖼 Chọn ảnh
            </label>
            <span className="cad-image-name" id="cadImageName" />
            <button type="button" className="btn-ams-action" id="btnCadImageClear" title="Bỏ ảnh" hidden>✕</button>
            <label className="cad-inline">
              Cao
              <input type="number" id="cadHeight" className="cad-number" min={10} max={300} step={1} defaultValue={80} />
              mm
            </label>
            <label className="cad-inline">
              <input type="checkbox" id="cadBase" defaultChecked />
              Thêm đế
            </label>
            <label className="cad-inline">
              <input type="checkbox" id="cadColour" />
              Tô màu
            </label>
            <span className="cad-colour-fields" id="cadColourFields" hidden>
              <select id="cadPalette" className="cad-number cad-palette-select" aria-label="Chọn màu">
                <option value="prefer">Ưu tiên màu có sẵn (AMS → của tôi → Bambu)</option>
                <option value="auto">Tự chọn màu theo ảnh</option>
                <option value="ams">Màu đang nạp trong AMS</option>
                <option value="bambu" id="cadPaletteBambu" hidden>Màu Bambu chính hãng</option>
                <option value="custom">Filament của tôi</option>
              </select>
              <select id="cadMaterial" className="cad-number cad-palette-select" aria-label="Loại nhựa Bambu" hidden />
              <label className="cad-inline" id="cadColoursLabel">
                Số màu
                <input type="number" id="cadColours" className="cad-number" min={2} max={8} step={1} defaultValue={4} />
              </label>
            </span>
          </div>
          {/* "Filament của tôi" to paint with: ticked ones only (src/ui/cad.js) */}
          <div className="cad-custom-pick" id="cadCustomPick" hidden />
          <div className="cad-form-row">
            <select id="cadModel" className="cad-model" aria-label="Model Claude" />
            <button type="submit" className="btn-ams-action btn-ams-primary" id="btnCadCreate">✨ Tạo mô hình</button>
          </div>
        </form>
        <div className="studio-note" id="cadHint" />
        {/* "Filament của tôi": other brands and colours Bambu doesn't make, saved for painting figures */}
        <details className="cad-filaments" id="cadFilaments">
          <summary id="cadFilamentsSummary">🎨 Filament của tôi</summary>
          <div className="cad-filament-list" id="cadFilamentList" />
          <form className="cad-filament-form" id="cadFilamentForm">
            <input type="color" id="cadFilamentColour" defaultValue="#C8783C" aria-label="Màu" />
            <input type="text" id="cadFilamentHex" className="cad-number" defaultValue="#C8783C" maxLength={7} aria-label="Mã màu" />
            <input type="text" id="cadFilamentName" className="cad-filament-input" placeholder="Tên màu, ví dụ Cam đất" maxLength={60} />
            <input type="text" id="cadFilamentBrand" className="cad-filament-input" placeholder="Hãng (không bắt buộc)" maxLength={40} />
            <input type="text" id="cadFilamentMaterial" className="cad-filament-input cad-filament-material" placeholder="Loại nhựa" defaultValue="PLA" maxLength={40} list="cadMaterialSuggestions" />
            <datalist id="cadMaterialSuggestions">
              <option value="PLA" />
              <option value="PLA Matte" />
              <option value="PLA Silk" />
              <option value="PETG" />
              <option value="ABS" />
              <option value="ASA" />
              <option value="TPU" />
            </datalist>
            <button type="submit" className="btn-ams-action btn-ams-primary">+ Lưu filament</button>
          </form>
        </details>
        <div className="cad-list" id="cadList">
          <div className="prints-empty">⏳ Đang tải...</div>
        </div>
      </section>
  );
});

export const LegacyPrintsCard = memo(function LegacyPrintsCard() {
  useLegacy(initPrintHistory as Init);
  return (
      <section data-page="prints" className="card prints-card" id="printsCard">
        <div className="card-header">
          <div className="header-title">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3v5h5" />
              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
              <path d="M12 7v5l4 2" />
            </svg>
            <h2>Lịch sử in</h2>
          </div>
          <div className="studio-toolbar">
            <button type="button" className="btn-ams-action btn-ams-primary" id="btnPrintsCompare" disabled>
              ⇄ So sánh 2 bản in
            </button>
            <button type="button" className="btn-ams-action" id="btnPrintsRefresh">↻ Làm mới</button>
          </div>
        </div>
        <div className="studio-note" id="printsSelectionNote">Tích 2 bản in để so sánh.</div>
        <div className="prints-list" id="printsList">
          <div className="prints-empty">⏳ Đang tải lịch sử in...</div>
        </div>
      </section>
  );
});
