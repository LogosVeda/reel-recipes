import { describe, expect, it } from 'vitest';
import type { Recipe } from '../src/types';
import { buildNoteText } from '../src/format/notes';
import { formatIngredient } from '../src/scale';

const ORIGIN = 'https://example.com';

function fixture(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'abc123',
    title: 'Spicy Tomato Pasta',
    description: null,
    source: {
      url: 'https://instagram.com/reel/xyz',
      platform: 'instagram',
      author: '@pastacook',
      siteName: null,
    },
    servings: 4,
    prepMinutes: 10,
    cookMinutes: 20,
    totalMinutes: 30,
    ingredients: [
      { raw: '2 cups flour', qty: 2, qtyHigh: null, unit: 'cup', item: 'flour', note: null, group: 'Dough' },
      { raw: '1 tsp salt', qty: 1, qtyHigh: null, unit: 'tsp', item: 'salt', note: null, group: 'Dough' },
      { raw: '400 g tomatoes, crushed', qty: 400, qtyHigh: null, unit: 'g', item: 'tomatoes', note: 'crushed', group: 'Sauce' },
    ],
    steps: [
      { text: 'Mix the dough until smooth.', minutes: null, group: null },
      { text: 'Simmer the sauce.', minutes: 10, group: null },
    ],
    notes: ['Freezes well.'],
    extractedFrom: 'caption',
    confidence: 'high',
    createdAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildNoteText', () => {
  it('starts with the title line', () => {
    const note = buildNoteText(fixture(), ORIGIN, 1);
    expect(note.startsWith('🍳 Spicy Tomato Pasta')).toBe(true);
  });

  it('scales ingredients and marks scaled servings at factor 2', () => {
    const recipe = fixture();
    const note = buildNoteText(recipe, ORIGIN, 2);
    expect(note).toContain('Serves 8 (scaled from 4)');
    const firstIngredient = recipe.ingredients[0]!;
    expect(note).toContain(`• ${formatIngredient(firstIngredient, 2)}`);
  });

  it('emits a timer URL only for the timed step', () => {
    const note = buildNoteText(fixture(), ORIGIN, 1);
    expect(note).toContain(`⏱ ${ORIGIN}/t?m=10&l=Step%202`);
    expect(note.match(/⏱/g)).toHaveLength(1);
  });

  it('links the shopping list with the factor param', () => {
    const note = buildNoteText(fixture(), ORIGIN, 2);
    expect(note).toContain(`🛒 Shopping list: ${ORIGIN}/r/abc123/list?x=2`);
  });

  it('adds group headers when ingredient groups exist', () => {
    const note = buildNoteText(fixture(), ORIGIN, 1);
    expect(note).toContain('— Dough —');
    expect(note).toContain('— Sauce —');
  });

  it('omits the Serves line and servings count when servings is null', () => {
    const note = buildNoteText(fixture({ servings: null }), ORIGIN, 1);
    expect(note).not.toContain('Serves');
    expect(note).toContain('INGREDIENTS\n');
    expect(note).not.toContain('INGREDIENTS (');
  });
});
