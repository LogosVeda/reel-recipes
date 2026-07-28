import { describe, it, expect } from 'vitest';
import {
  parseIngredientLine,
  detectMinutes,
  scaleQty,
  formatQty,
  formatIngredient,
} from '../src/scale';

describe('parseIngredientLine', () => {
  it('parses integer quantity with no unit (unitless counts)', () => {
    expect(parseIngredientLine('2 eggs')).toEqual({
      raw: '2 eggs',
      qty: 2,
      qtyHigh: null,
      unit: null,
      item: 'eggs',
      note: null,
      group: null,
    });
  });

  it('parses unicode vulgar fractions', () => {
    const a = parseIngredientLine('½ cup sugar');
    expect(a.qty).toBe(0.5);
    expect(a.unit).toBe('cup');
    expect(a.item).toBe('sugar');

    const b = parseIngredientLine('⅔ cup milk');
    expect(b.qty).toBeCloseTo(2 / 3, 5);
    expect(b.unit).toBe('cup');
  });

  it('parses mixed numbers in both ascii and unicode form', () => {
    const a = parseIngredientLine('1 1/2 cups flour');
    expect(a.qty).toBe(1.5);
    expect(a.unit).toBe('cup');
    expect(a.item).toBe('flour');

    const b = parseIngredientLine('1½ cups flour');
    expect(b.qty).toBe(1.5);
    expect(b.unit).toBe('cup');
  });

  it('parses plain fractions and decimals', () => {
    const a = parseIngredientLine('1/2 tsp salt');
    expect(a.qty).toBe(0.5);
    expect(a.unit).toBe('tsp');
    expect(a.item).toBe('salt');

    const b = parseIngredientLine('1.5 kg potatoes');
    expect(b.qty).toBe(1.5);
    expect(b.unit).toBe('kg');
    expect(b.item).toBe('potatoes');
  });

  it('parses ranges with hyphen, en dash, and "to"', () => {
    const a = parseIngredientLine('2-3 cloves garlic');
    expect(a.qty).toBe(2);
    expect(a.qtyHigh).toBe(3);
    expect(a.unit).toBe('clove');
    expect(a.item).toBe('garlic');

    const b = parseIngredientLine('2–3 tbsp olive oil');
    expect(b.qty).toBe(2);
    expect(b.qtyHigh).toBe(3);
    expect(b.unit).toBe('tbsp');

    const c = parseIngredientLine('2 to 3 cups broth');
    expect(c.qty).toBe(2);
    expect(c.qtyHigh).toBe(3);
    expect(c.unit).toBe('cup');
    expect(c.item).toBe('broth');
  });

  it('normalizes unit spellings case-insensitively', () => {
    expect(parseIngredientLine('2 Tablespoons butter').unit).toBe('tbsp');
    expect(parseIngredientLine('3 teaspoons vanilla').unit).toBe('tsp');
    expect(parseIngredientLine('200 grams flour').unit).toBe('g');
    expect(parseIngredientLine('2 lbs chicken').unit).toBe('lb');
    expect(parseIngredientLine('2 lbs chicken').item).toBe('chicken');
    expect(parseIngredientLine('1 pkg yeast').unit).toBe('package');
  });

  it('strips "of" after the unit', () => {
    const a = parseIngredientLine('2 cups of flour');
    expect(a.unit).toBe('cup');
    expect(a.item).toBe('flour');

    const b = parseIngredientLine('1 pinch of salt');
    expect(b.unit).toBe('pinch');
    expect(b.item).toBe('salt');
  });

  it('splits a trailing comma note and keeps raw verbatim', () => {
    const a = parseIngredientLine('1 cup flour, sifted');
    expect(a.raw).toBe('1 cup flour, sifted');
    expect(a.qty).toBe(1);
    expect(a.unit).toBe('cup');
    expect(a.item).toBe('flour');
    expect(a.note).toBe('sifted');
  });

  it('handles lines with no leading quantity', () => {
    const a = parseIngredientLine('salt to taste');
    expect(a.qty).toBeNull();
    expect(a.qtyHigh).toBeNull();
    expect(a.unit).toBeNull();
    expect(a.item).toBe('salt to taste');
    expect(a.note).toBeNull();

    const b = parseIngredientLine('a pinch of nutmeg');
    expect(b.qty).toBeNull();
    expect(b.unit).toBeNull();
    expect(b.item).toBe('a pinch of nutmeg');
  });
});

describe('detectMinutes', () => {
  it('detects minute variants', () => {
    expect(detectMinutes('8 min')).toBe(8);
    expect(detectMinutes('rest for 8 mins')).toBe(8);
    expect(detectMinutes('bake for 8 minutes until golden')).toBe(8);
  });

  it('uses the upper bound of a range', () => {
    expect(detectMinutes('simmer 8-10 minutes')).toBe(10);
    expect(detectMinutes('cook 10 to 12 minutes')).toBe(12);
  });

  it('detects hours including combined and word forms', () => {
    expect(detectMinutes('bake 1 hour')).toBe(60);
    expect(detectMinutes('slow roast for 1.5 hours')).toBe(90);
    expect(detectMinutes('chill 1 hr')).toBe(60);
    expect(detectMinutes('braise 1 hour 20 minutes')).toBe(80);
    expect(detectMinutes('proof for an hour')).toBe(60);
    expect(detectMinutes('let rest half an hour')).toBe(30);
  });

  it('rounds seconds up to at least one whole minute', () => {
    expect(detectMinutes('microwave 90 seconds')).toBe(2);
    expect(detectMinutes('blanch for 30 seconds')).toBe(1);
  });

  it('requires word boundaries and practical durations', () => {
    expect(detectMinutes('add minced garlic and stir')).toBeNull();
    expect(detectMinutes('stir the sauce well')).toBeNull();
    expect(detectMinutes('ferment 48 hours')).toBeNull();
  });
});

describe('scaleQty and formatQty', () => {
  it('scales and rounds to 2 decimals', () => {
    expect(scaleQty(1.5, 2)).toBe(3);
    expect(scaleQty(1 / 3, 1)).toBe(0.33);
    expect(scaleQty(0.75, 3)).toBe(2.25);
  });

  it('renders fractions, mixed numbers, and trimmed decimals', () => {
    expect(formatQty(2)).toBe('2');
    expect(formatQty(0.25)).toBe('¼');
    expect(formatQty(0.5)).toBe('½');
    expect(formatQty(0.33)).toBe('⅓');
    expect(formatQty(0.67)).toBe('⅔');
    expect(formatQty(0.875)).toBe('⅞');
    expect(formatQty(1.5)).toBe('1½');
    expect(formatQty(2.25)).toBe('2¼');
    expect(formatQty(2.1)).toBe('2.1');
    expect(formatQty(1.45)).toBe('1.45');
  });
});

describe('formatIngredient', () => {
  it('returns raw unchanged when qty is null', () => {
    const ing = parseIngredientLine('salt to taste');
    expect(formatIngredient(ing, 2)).toBe('salt to taste');
  });

  it('scales, pluralizes word units, and keeps the note', () => {
    const ing = parseIngredientLine('1½ cups flour, sifted');
    expect(formatIngredient(ing, 2)).toBe('3 cups flour, sifted');
    expect(formatIngredient(ing, 1 / 3)).toBe('½ cup flour, sifted');
  });

  it('never pluralizes abbreviated units', () => {
    const ing = parseIngredientLine('2 tbsp oil');
    expect(formatIngredient(ing, 2)).toBe('4 tbsp oil');
  });

  it('formats ranges with an en dash and pluralizes off the upper bound', () => {
    const ing = parseIngredientLine('2-3 cloves garlic');
    expect(formatIngredient(ing, 1)).toBe('2–3 cloves garlic');
    expect(formatIngredient(ing, 0.5)).toBe('1–1½ cloves garlic');
  });

  it('scales unitless counts', () => {
    const ing = parseIngredientLine('2 eggs');
    expect(formatIngredient(ing, 2)).toBe('4 eggs');
  });
});
