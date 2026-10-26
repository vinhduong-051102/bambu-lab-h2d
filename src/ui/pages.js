/**
 * Dashboard pages (printer, studio, cad, prints, system): one shows at a time, picked by the tabs and kept in
 * the URL hash (#studio), so the back button and a bookmark land on it. Studio and AI modelling are only
 * available when the gateway has them set up.
 */

export const DEFAULT_PAGE = 'printer';

/** The page a URL hash asks for: one of `available`, else the default */
export function pageFromHash(hash, available) {
  const name = String(hash ?? '').replace(/^#/, '');
  return available.includes(name) ? name : DEFAULT_PAGE;
}
