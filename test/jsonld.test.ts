import { describe, expect, it } from 'vitest';
import { extractJsonLdRecipe } from '../src/extract/jsonld';

function page(...scripts: string[]): string {
  const blocks = scripts
    .map((s) => `<script type="application/ld+json">${s}</script>`)
    .join('\n');
  return `<!doctype html><html><head><title>Some Blog</title>${blocks}</head><body><p>hi</p></body></html>`;
}

describe('extractJsonLdRecipe', () => {
  it('extracts a simple recipe object', () => {
    const html = page(
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Recipe',
        name: 'Garlic Butter Pasta',
        description: 'Quick weeknight pasta.',
        author: { '@type': 'Person', name: 'Dana Cook' },
        publisher: { '@type': 'Organization', name: 'Dana Cooks' },
        recipeYield: 4,
        prepTime: 'PT10M',
        cookTime: 'PT20M',
        totalTime: 'PT30M',
        recipeIngredient: ['8 oz spaghetti', '4 cloves garlic, minced', '2 tbsp butter'],
        recipeInstructions: [
          { '@type': 'HowToStep', text: 'Boil the pasta until al dente.' },
          { '@type': 'HowToStep', text: 'Saute garlic in butter, then toss with pasta.' },
        ],
      }),
    );
    const r = extractJsonLdRecipe(html);
    expect(r).not.toBeNull();
    expect(r!.title).toBe('Garlic Butter Pasta');
    expect(r!.description).toBe('Quick weeknight pasta.');
    expect(r!.author).toBe('Dana Cook');
    expect(r!.siteName).toBe('Dana Cooks');
    expect(r!.servings).toBe(4);
    expect(r!.prepMinutes).toBe(10);
    expect(r!.cookMinutes).toBe(20);
    expect(r!.totalMinutes).toBe(30);
    expect(r!.ingredientLines).toEqual(['8 oz spaghetti', '4 cloves garlic, minced', '2 tbsp butter']);
    expect(r!.steps).toEqual([
      { text: 'Boil the pasta until al dente.', group: null },
      { text: 'Saute garlic in butter, then toss with pasta.', group: null },
    ]);
  });

  it('finds the Recipe inside an @graph wrapper (WPRM/AllRecipes style)', () => {
    const html = page(
      JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'WebSite', name: 'Food Blog' },
          { '@type': 'WebPage', name: 'Post page' },
          {
            '@type': 'Recipe',
            name: 'Sheet Pan Chicken',
            recipeIngredient: ['2 lb chicken thighs'],
            recipeInstructions: [{ '@type': 'HowToStep', text: 'Roast at 425F for 30 minutes.' }],
          },
        ],
      }),
    );
    const r = extractJsonLdRecipe(html);
    expect(r).not.toBeNull();
    expect(r!.title).toBe('Sheet Pan Chicken');
    expect(r!.ingredientLines).toEqual(['2 lb chicken thighs']);
  });

  it('accepts @type given as an array', () => {
    const html = page(
      JSON.stringify([
        { '@type': 'BreadcrumbList' },
        {
          '@type': ['Recipe', 'NewsArticle'],
          name: 'Miso Soup',
          recipeIngredient: ['4 cups dashi', '3 tbsp miso paste'],
        },
      ]),
    );
    const r = extractJsonLdRecipe(html);
    expect(r).not.toBeNull();
    expect(r!.title).toBe('Miso Soup');
  });

  it('uses HowToSection names as step groups', () => {
    const html = page(
      JSON.stringify({
        '@type': 'Recipe',
        name: 'Layer Cake',
        recipeIngredient: ['2 cups flour', '1 cup sugar'],
        recipeInstructions: [
          {
            '@type': 'HowToSection',
            name: 'Cake',
            itemListElement: [
              { '@type': 'HowToStep', text: 'Mix dry ingredients.' },
              { '@type': 'HowToStep', text: 'Bake 25 minutes.' },
            ],
          },
          {
            '@type': 'HowToSection',
            name: 'Frosting',
            itemListElement: [{ '@type': 'HowToStep', text: 'Beat butter and sugar.' }],
          },
        ],
      }),
    );
    const r = extractJsonLdRecipe(html);
    expect(r).not.toBeNull();
    expect(r!.steps).toEqual([
      { text: 'Mix dry ingredients.', group: 'Cake' },
      { text: 'Bake 25 minutes.', group: 'Cake' },
      { text: 'Beat butter and sugar.', group: 'Frosting' },
    ]);
  });

  it('splits a single instruction string into steps', () => {
    const html = page(
      JSON.stringify({
        '@type': 'Recipe',
        name: 'Overnight Oats',
        recipeIngredient: ['1 cup oats', '1 cup milk'],
        recipeInstructions: 'Combine oats and milk in a jar.\nStir well.\nRefrigerate overnight.',
      }),
    );
    const r = extractJsonLdRecipe(html);
    expect(r).not.toBeNull();
    expect(r!.steps.map((s) => s.text)).toEqual([
      'Combine oats and milk in a jar.',
      'Stir well.',
      'Refrigerate overnight.',
    ]);
    expect(r!.steps.every((s) => s.group === null)).toBe(true);
  });

  it('parses recipeYield variants', () => {
    const yields: [unknown, number | null][] = [
      [6, 6],
      ['8', 8],
      ['4 servings', 4],
      ['Serves 6', 6],
      ['12 cookies', 12],
      [['4 servings', '8 pieces'], 4],
      ['a lot', null],
      [500, null],
    ];
    for (const [y, expected] of yields) {
      const html = page(
        JSON.stringify({
          '@type': 'Recipe',
          name: 'Yield Test',
          recipeYield: y,
          recipeIngredient: ['1 thing'],
        }),
      );
      const r = extractJsonLdRecipe(html);
      expect(r, JSON.stringify(y)).not.toBeNull();
      expect(r!.servings, JSON.stringify(y)).toBe(expected);
    }
  });

  it('parses ISO-8601 duration variants including hours and days', () => {
    const html = page(
      JSON.stringify({
        '@type': 'Recipe',
        name: 'Braised Short Ribs',
        prepTime: 'PT1H30M',
        cookTime: 'P0DT1H10M',
        totalTime: 'PT3H',
        recipeIngredient: ['3 lb short ribs'],
      }),
    );
    const r = extractJsonLdRecipe(html);
    expect(r).not.toBeNull();
    expect(r!.prepMinutes).toBe(90);
    expect(r!.cookMinutes).toBe(70);
    expect(r!.totalMinutes).toBe(180);
  });

  it('returns null for missing or invalid durations', () => {
    const html = page(
      JSON.stringify({
        '@type': 'Recipe',
        name: 'No Times',
        prepTime: '30 minutes',
        recipeIngredient: ['1 cup rice'],
      }),
    );
    const r = extractJsonLdRecipe(html);
    expect(r).not.toBeNull();
    expect(r!.prepMinutes).toBeNull();
    expect(r!.cookMinutes).toBeNull();
    expect(r!.totalMinutes).toBeNull();
  });

  it('skips a malformed JSON block and uses a later valid one', () => {
    const html = page(
      '{ this is not valid json !!!',
      JSON.stringify({
        '@type': 'Recipe',
        name: 'Survivor Salad',
        recipeIngredient: ['2 cups greens'],
        recipeInstructions: [{ '@type': 'HowToStep', text: 'Toss everything together.' }],
      }),
    );
    const r = extractJsonLdRecipe(html);
    expect(r).not.toBeNull();
    expect(r!.title).toBe('Survivor Salad');
  });

  it('strips HTML tags and decodes entities in ingredients and steps', () => {
    const html = page(
      JSON.stringify({
        '@type': 'Recipe',
        name: 'Mac &amp; Cheese',
        recipeIngredient: ['2 cups <b>sharp</b> cheddar,&nbsp;grated', '1 tsp Dijon &quot;mustard&quot; &#39;optional&#39;'],
        recipeInstructions: [{ '@type': 'HowToStep', text: 'Melt butter &amp; whisk in   flour.' }],
      }),
    );
    const r = extractJsonLdRecipe(html);
    expect(r).not.toBeNull();
    expect(r!.title).toBe('Mac & Cheese');
    expect(r!.ingredientLines).toEqual([
      '2 cups sharp cheddar, grated',
      '1 tsp Dijon "mustard" \'optional\'',
    ]);
    expect(r!.steps[0].text).toBe('Melt butter & whisk in flour.');
  });

  it('handles legacy "ingredients" key, uppercase attributes, and step "name" fallback', () => {
    const html = `<html><head>
      <SCRIPT class="yoast" TYPE='application/ld+json' data-x="1">${JSON.stringify({
        '@type': 'Recipe',
        name: 'Legacy Toast',
        author: ['Pat Baker', { name: 'Ignored Second' }],
        ingredients: ['2 slices bread'],
        recipeInstructions: [{ '@type': 'HowToStep', name: 'Toast the bread until golden.' }],
      })}</SCRIPT>
    </head><body></body></html>`;
    const r = extractJsonLdRecipe(html);
    expect(r).not.toBeNull();
    expect(r!.title).toBe('Legacy Toast');
    expect(r!.author).toBe('Pat Baker');
    expect(r!.ingredientLines).toEqual(['2 slices bread']);
    expect(r!.steps).toEqual([{ text: 'Toast the bread until golden.', group: null }]);
  });

  it('returns null when the page has no Recipe node', () => {
    const html = page(
      JSON.stringify({ '@type': 'NewsArticle', headline: 'Ten best pans' }),
    );
    expect(extractJsonLdRecipe(html)).toBeNull();
    expect(extractJsonLdRecipe('<html><body>no scripts here</body></html>')).toBeNull();
  });

  it('returns null when the Recipe has neither ingredients nor instructions', () => {
    const html = page(
      JSON.stringify({ '@type': 'Recipe', name: 'Empty Shell' }),
    );
    expect(extractJsonLdRecipe(html)).toBeNull();
  });
});
