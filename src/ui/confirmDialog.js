// Themed replacement for window.confirm(). Resolves true on confirm, false on cancel / Esc / backdrop click.
export function confirmDialog({
  title = 'Xác nhận',
  message = '',
  confirmText = 'Xác nhận',
  cancelText = 'Hủy',
  danger = false,
  icon = danger ? '⚠️' : '❓',
} = {}) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop confirm-backdrop';
    backdrop.innerHTML = `
      <div class="modal-content confirm-dialog ${danger ? 'is-danger' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="confirmDialogTitle" aria-describedby="confirmDialogMsg">
        <div class="confirm-icon"></div>
        <h3 class="confirm-title" id="confirmDialogTitle"></h3>
        <p class="confirm-message" id="confirmDialogMsg"></p>
        <div class="confirm-actions">
          <button type="button" class="btn-ctrl confirm-cancel"></button>
          <button type="button" class="btn-ctrl confirm-ok ${danger ? 'btn-stop' : 'btn-resume'}"></button>
        </div>
      </div>`;
    // textContent keeps file names and labels from being interpreted as HTML
    backdrop.querySelector('.confirm-icon').textContent = icon;
    backdrop.querySelector('.confirm-title').textContent = title;
    backdrop.querySelector('.confirm-message').textContent = message;
    const cancelBtn = backdrop.querySelector('.confirm-cancel');
    const okBtn = backdrop.querySelector('.confirm-ok');
    cancelBtn.textContent = cancelText;
    okBtn.textContent = confirmText;

    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.classList.remove('open');
      setTimeout(() => backdrop.remove(), 200);
      previousFocus?.focus?.({ preventScroll: true });
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Enter' && document.activeElement !== cancelBtn) { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') {
        // Keep focus inside the dialog
        e.preventDefault();
        (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
      }
    };

    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(false); });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('open'));
    // Dangerous actions focus Cancel so a stray Enter doesn't fire them
    (danger ? cancelBtn : okBtn).focus({ preventScroll: true });
  });
}
