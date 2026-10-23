import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE, pageFromHash } from '../src/ui/pages.js';

describe('dashboard pages', () => {
  const available = ['printer', 'studio', 'prints', 'system'];

  it('opens the page the URL hash names', () => {
    expect(pageFromHash('#studio', available)).toBe('studio');
    expect(pageFromHash('prints', available)).toBe('prints');
  });

  it('falls back to the printer page for no, unknown or unavailable pages', () => {
    expect(pageFromHash('', available)).toBe(DEFAULT_PAGE);
    expect(pageFromHash(undefined, available)).toBe(DEFAULT_PAGE);
    expect(pageFromHash('#nope', available)).toBe(DEFAULT_PAGE);
    // AI modelling not set up: its card stays hidden, so #cad is not available
    expect(pageFromHash('#cad', available)).toBe(DEFAULT_PAGE);
  });
});
