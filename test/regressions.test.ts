// Regression tests for issues found in the adversarial review pass.
import { describe, expect, it } from 'vitest';
import { parseIngredientLine, detectMinutes, formatIngredient } from '../src/scale';
import { extractJsonLdRecipe } from '../src/extract/jsonld';
import { buildNoteText } from '../src/format/notes';
import type { Recipe } from '../src/types';

describe('scale: quantities glued to units', () => {
  it('parses "400g" (no space) and scales it', () => {
    const ing = parseIngredientLine('400g spaghetti');
    expect(ing.qty).toBe(400);
    expect(ing.unit).toBe('g');
    expect(ing.item).toBe('spaghetti');
    expect(formatIngredient(ing, 2)).toBe('800 g spaghetti');
  });

  it('parses "½cup" (vulgar fraction glued to unit)', () => {
    const ing = parseIngredientLine('½cup sugar');
    expect(ing.qty).toBeCloseTo(0.5);
    expect(ing.unit).toBe('cup');
    expect(ing.item).toBe('sugar');
  });

  it('still treats "2 eggs" as unitless', () => {
    const ing = parseIngredientLine('2 eggs');
    expect(ing.qty).toBe(2);
    expect(ing.unit).toBeNull();
    expect(ing.item).toBe('eggs');
  });
});

describe('scale: detectMinutes "and a half" phrasing', () => {
  it('"an hour and a half" is 90 minutes', () => {
    expect(detectMinutes('let it rise an hour and a half')).toBe(90);
  });
  it('"1 hour and a half" is 90 minutes', () => {
    expect(detectMinutes('bake 1 hour and a half')).toBe(90);
  });
  it('"an hour" is still 60', () => {
    expect(detectMinutes('rest for an hour')).toBe(60);
  });
  it('"half an hour" is still 30', () => {
    expect(detectMinutes('wait half an hour')).toBe(30);
  });
});

describe('jsonld: instruction string splitting', () => {
  const wrap = (instructions: string) =>
    `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Recipe',
      name: 'Test',
      recipeIngredient: ['1 cup flour'],
      recipeInstructions: instructions,
    })}</script>`;

  it('does NOT split a mid-sentence number followed by a period', () => {
    const data = extractJsonLdRecipe(wrap('Divide dough into 2. Roll each piece. Bake until golden.'));
    expect(data).not.toBeNull();
    // Must stay one step — the "2" must not be deleted or used as a list marker.
    expect(data!.steps).toHaveLength(1);
    expect(data!.steps[0]!.text).toContain('Divide dough into 2');
  });

  it('DOES split a genuine 1,2,3 numbered list', () => {
    const data = extractJsonLdRecipe(wrap('1. Preheat oven. 2. Mix batter. 3. Bake.'));
    expect(data).not.toBeNull();
    expect(data!.steps).toHaveLength(3);
    expect(data!.steps[0]!.text).toBe('Preheat oven.');
    expect(data!.steps[2]!.text).toBe('Bake.');
  });
});

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'r1',
    title: 'Test',
    description: null,
    source: { url: '', platform: 'web', author: null, siteName: null },
    servings: 12,
    prepMinutes: null,
    cookMinutes: null,
    totalMinutes: null,
    ingredients: [{ raw: '2 eggs', qty: 2, qtyHigh: null, unit: null, item: 'eggs', note: null, group: null }],
    steps: [{ text: 'Mix.', minutes: null, group: null }],
    notes: [],
    extractedFrom: 'jsonld',
    confidence: 'high',
    createdAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('notes: servings floor and scale links', () => {
  it('never shows "Serves 0" when scaling a big recipe down to one', () => {
    // 12 servings at factor 1/12 -> 1 serving (not 0).
    const note = buildNoteText(recipe(), 'https://x.test', 1 / 12);
    expect(note).toContain('Serves 1 (scaled from 12)');
    expect(note).not.toContain('Serves 0');
    expect(note).toContain('(1 serving)'); // singular, not "1 servings"
  });

  it('Full recipe link preserves the note factor', () => {
    const note = buildNoteText(recipe(), 'https://x.test', 2);
    expect(note).toContain('📖 Full recipe: https://x.test/r/r1?x=2');
  });

  it('marks scale when servings unknown but factor != 1', () => {
    const note = buildNoteText(recipe({ servings: null }), 'https://x.test', 2);
    expect(note).toContain('INGREDIENTS (scaled 2×)');
  });
});

describe('image: sniffImageType', () => {
  it('detects png/jpeg/gif/webp magic bytes and rejects junk', async () => {
    const { sniffImageType } = await import('../src/llm');
    expect(sniffImageType('iVBORw0KGgoAAAA')).toBe('image/png');
    expect(sniffImageType('/9j/4AAQSkZJRg')).toBe('image/jpeg');
    expect(sniffImageType('R0lGODlhAQABAIA')).toBe('image/gif');
    expect(sniffImageType('UklGRh4AAABXRUJQ')).toBe('image/webp');
    expect(sniffImageType('aGVsbG8gd29ybGQ=')).toBeNull();
    expect(sniffImageType('')).toBeNull();
  });
});

describe('llm: fixMojibake', () => {
  it('repairs UTF-8-as-CP1252 Polish text', async () => {
    const { fixMojibake } = await import('../src/llm');
    // "lyzeczki"/"maka" whose UTF-8 bytes were decoded as CP1252:
    // l-stroke -> \u00C5\u201A, z-dot -> \u00C5\u00BC, a-ogonek -> \u00C4\u2026
    expect(fixMojibake('2 \u00C5\u201Ay\u00C5\u00BCeczki proszku')).toBe('2 \u0142y\u017Ceczki proszku');
    expect(fixMojibake('m\u00C4\u2026ka')).toBe('m\u0105ka');
  });
  it('leaves genuine text untouched', async () => {
    const { fixMojibake } = await import('../src/llm');
    expect(fixMojibake('caf\u00E9 au lait')).toBe('caf\u00E9 au lait');
    expect(fixMojibake('1 cup flour')).toBe('1 cup flour');
    expect(fixMojibake('m\u0105ka i \u0142y\u017Ceczka')).toBe('m\u0105ka i \u0142y\u017Ceczka');
  });
});

describe('html: Facebook og:title caption source', () => {
  it('strips the "| Page | Facebook" suffix', async () => {
    const { stripFacebookTitleSuffix } = await import('../src/extract/html');
    expect(stripFacebookTitleSuffix('Great recipe text here | Le Bernardin | Facebook')).toBe('Great recipe text here');
    expect(stripFacebookTitleSuffix('Just a caption | Facebook')).toBe('Just a caption');
    expect(stripFacebookTitleSuffix('Caption with | a pipe inside it')).toBe('Caption with | a pipe inside it');
  });
  it('detects ellipsis truncation', async () => {
    const { looksTruncated } = await import('../src/extract/html');
    expect(looksTruncated('2 szklanki maki...')).toBe(true);
    expect(looksTruncated('2 cups flour…')).toBe(true);
    expect(looksTruncated('A complete sentence.')).toBe(false);
    expect(looksTruncated(null)).toBe(false);
  });
});
