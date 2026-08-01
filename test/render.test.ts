import { describe, expect, it } from 'vitest';
import type { Recipe } from '../src/types';
import { renderRecipePage, renderShoppingListPage } from '../src/format/html';

const ORIGIN = 'https://example.com';

function fixture(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'abc123',
    title: 'Tiramisu',
    language: 'en',
    description: null,
    source: { url: 'https://facebook.com/share/r/x', platform: 'facebook', author: 'Adam', siteName: null },
    servings: 4,
    prepMinutes: null,
    cookMinutes: null,
    totalMinutes: null,
    ingredients: [
      { raw: '200 g sugar', qty: 200, qtyHigh: null, unit: 'g', item: 'sugar', note: null, group: null },
    ],
    steps: [{ text: 'Whisk.', minutes: null, group: null }],
    notes: [],
    extractedFrom: 'caption',
    confidence: 'high',
    createdAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  } as Recipe;
}

describe('language propagation on the recipe page', () => {
  const opts = { originalLanguage: 'it', currentLang: 'en' };

  it('carries ?lang into the copy-note URL — the note must match the page', () => {
    const html = renderRecipePage(fixture(), ORIGIN, 1, opts);
    expect(html).toContain('/api/recipe/abc123/note?x=1&amp;lang=en');
  });

  it('carries ?lang into scale links and the shopping-list link', () => {
    const html = renderRecipePage(fixture(), ORIGIN, 1, opts);
    expect(html).toContain('/r/abc123?x=2&lang=en');
    expect(html).toContain('/r/abc123/list?x=1&lang=en');
  });

  it('adds no lang param when following the device language', () => {
    const html = renderRecipePage(fixture(), ORIGIN, 1, { originalLanguage: 'it', currentLang: '' });
    expect(html).toContain('/api/recipe/abc123/note?x=1"');
    expect(html).toContain('/r/abc123?x=2"'); // scale link carries no lang
  });

  it('propagates the explicit "orig" choice too', () => {
    const html = renderRecipePage(fixture(), ORIGIN, 1, { originalLanguage: 'it', currentLang: 'orig' });
    expect(html).toContain('/api/recipe/abc123/note?x=1&amp;lang=orig');
  });

  it('rejects a malicious lang value instead of echoing it into URLs', () => {
    const html = renderRecipePage(fixture(), ORIGIN, 1, { originalLanguage: 'it', currentLang: '"<script>' });
    expect(html).not.toContain('lang="<');
    expect(html).not.toContain('lang=%22');
    expect(html).toContain('/api/recipe/abc123/note?x=1"');
  });

  it('shopping list back-link keeps the language', () => {
    const html = renderShoppingListPage(fixture(), ORIGIN, 1, opts);
    expect(html).toContain('/r/abc123?x=1&lang=en');
  });
});
