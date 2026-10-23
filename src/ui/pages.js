/**
 * Dashboard pages: the cards are grouped by their data-page (printer, studio, cad, prints, system) and one page
 * shows at a time, picked by the tabs in #pageTabs and kept in the URL hash (#studio), so the back button
 * and a bookmark land on it. A tab whose cards are all hidden (Studio or AI modelling not set up) is hidden
 * too, and its page is never shown.
 */

export const DEFAULT_PAGE = 'printer';

/** The page a URL hash asks for: one of `available`, else the default */
export function pageFromHash(hash, available) {
  const name = String(hash ?? '').replace(/^#/, '');
  return available.includes(name) ? name : DEFAULT_PAGE;
}

/**
 * onChange(page, previous) runs once at start (previous null) and on every switch. Returns a dispose function.
 */
export function initPages({ onChange = () => {} } = {}) {
  const nav = document.getElementById('pageTabs');
  const grid = document.querySelector('.dashboard-grid');
  if (!nav || !grid) return () => {};

  const tabs = [...nav.querySelectorAll('.page-tab[data-page]')];
  const cards = [...grid.querySelectorAll(':scope > [data-page]')];
  let current = null;

  // A page is available when at least one of its cards is not hidden by its own feature (hidden attribute)
  const available = () =>
    tabs.map((tab) => tab.dataset.page).filter((page) => cards.some((card) => card.dataset.page === page && !card.hidden));

  function show(page) {
    const previous = current;
    current = page;
    for (const card of cards) card.classList.toggle('page-hidden', card.dataset.page !== page);
    for (const tab of tabs) {
      const active = tab.dataset.page === page;
      tab.classList.toggle('active', active);
      if (active) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    if (previous !== page) onChange(page, previous);
  }

  function sync() {
    const pages = available();
    for (const tab of tabs) tab.hidden = !pages.includes(tab.dataset.page);
    show(pageFromHash(window.location.hash, pages));
  }

  // Studio's and the AI card's scripts unhide their cards once they know the feature is set up
  const observer = new MutationObserver(sync);
  for (const card of cards) observer.observe(card, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('hashchange', sync);
  sync();

  return () => {
    observer.disconnect();
    window.removeEventListener('hashchange', sync);
  };
}
