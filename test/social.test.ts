// Facebook/Instagram page variants: the caption must be found wherever the
// platform put it, and login walls must never pass for a post.
import { describe, expect, it } from 'vitest';
import { bestSocialCaption, extractMeta, isPlatformShell, isShellText, stripFacebookTitleSuffix } from '../src/extract/html';
import { looksLikeRecipeText } from '../src/llm';
import { titlesPlausiblyMatch } from '../src/extract/search';

const CAPTION =
  'Sour Cream Cake 🤍\n\nNo flour.\n\nRecipe 👇\n\nIngredients\n• 6 large eggs\n• 900 g sour cream\n• 140 g sugar\n• 75 g cornstarch\n• 1 tsp vanilla extract (or vanilla sugar)\n\nInstructions\n\nWhisk together the eggs, sugar, cornstarch and vanilla until smooth.\nBake at 180°C (355°F) for about 1 hour.\n\n#SourCreamCake #EasyDessert';

/** The browser-facing reel page as Facebook served it on 2026-09-05. */
const REEL_PAGE = `<html><head><title>Sour Cream Cake 🤍 | Taste the East | Facebook</title>
<meta property="og:type" content="video.other" />
<meta property="og:title" content="${CAPTION.replace(/"/g, '&quot;')} | Taste the East | Facebook" />
<meta property="og:description" content="Sour Cream Cake 🤍\n\nNo flour.\n\nNo kneading..." />
<meta property="og:url" content="https://www.facebook.com/reel/4600162466972157/" />
<meta property="og:image" content="https://scontent.xx.fbcdn.net/v/cover.jpg" />
<meta property="og:video" content="https://video.xx.fbcdn.net/o1/v/clip.mp4" />
<link rel="alternate" href="https://graph.facebook.com/v26.0/oembed_video?url=https%3A%2F%2Fwww.facebook.com%2Freel%2F4600162466972157%2F" title="${CAPTION.replace(/"/g, '&quot;')} | Taste the East | Facebook" />
</head><body></body></html>`;

/** Same reel, but the variant that carries the caption ONLY in the oEmbed link. */
const OEMBED_ONLY_PAGE = REEL_PAGE.replace(/<meta property="og:title"[^>]*>/, '').replace(/<meta property="og:description"[^>]*>/, '');

const LOGIN_WALL = `<html><head><title>Log into Facebook | Facebook</title>
<meta property="og:title" content="Log into Facebook | Facebook" />
<meta property="og:description" content="Log into Facebook to start sharing and connecting with your friends, family, and people you know." />
</head></html>`;

const NOT_FOUND = `<html><head><title>Content not found</title>
<meta property="og:title" content="Log in or sign up to view" />
<meta property="og:description" content="See posts, photos and more on Facebook." />
</head></html>`;

const INSTAGRAM_WALL = `<html><head><title>Instagram</title>
<meta property="og:title" content="Instagram" />
<meta property="og:description" content="Create an account or log in to Instagram - Share what you're into with the people who get you." />
</head></html>`;

describe('extractMeta: oEmbed link title', () => {
  it('captures the multi-line caption from the oEmbed <link> title', () => {
    const meta = extractMeta(REEL_PAGE);
    expect(meta.oembedTitle).not.toBeNull();
    expect(meta.oembedTitle).toContain('900 g sour cream');
    expect(meta.oembedTitle).toContain('Whisk together');
  });
  it('ignores <link> tags that are not oEmbed discovery', () => {
    const meta = extractMeta('<link rel="alternate" media="handheld" href="https://m.facebook.com/reel/1/" title="mobile" />');
    expect(meta.oembedTitle).toBeNull();
  });
});

describe('bestSocialCaption', () => {
  it('prefers the longest carrier and strips the "| Page | Facebook" wrapper', () => {
    const caption = bestSocialCaption(extractMeta(REEL_PAGE));
    expect(caption.startsWith('Sour Cream Cake')).toBe(true);
    expect(caption).toContain('75 g cornstarch');
    expect(caption.endsWith('#EasyDessert')).toBe(true);
    expect(caption).not.toContain('| Facebook');
  });
  it('recovers the full caption when og:title and og:description are missing', () => {
    const meta = extractMeta(OEMBED_ONLY_PAGE);
    expect(meta.ogTitle).toBeNull();
    const caption = bestSocialCaption(meta);
    expect(caption).toContain('Bake at 180°C');
    expect(caption.endsWith('#EasyDessert')).toBe(true);
  });
  it('never returns login-wall boilerplate as a caption', () => {
    expect(bestSocialCaption(extractMeta(LOGIN_WALL))).toBe('');
    expect(bestSocialCaption(extractMeta(NOT_FOUND))).toBe('');
    expect(bestSocialCaption(extractMeta(INSTAGRAM_WALL))).toBe('');
  });
});

describe('isPlatformShell', () => {
  it('flags Facebook login walls, not-found shells and Instagram walls', () => {
    expect(isPlatformShell(extractMeta(LOGIN_WALL))).toBe(true);
    expect(isPlatformShell(extractMeta(NOT_FOUND))).toBe(true);
    expect(isPlatformShell(extractMeta(INSTAGRAM_WALL))).toBe(true);
  });
  it('does not flag a real post, even one whose og tags are missing', () => {
    expect(isPlatformShell(extractMeta(REEL_PAGE))).toBe(false);
    expect(isPlatformShell(extractMeta(OEMBED_ONLY_PAGE))).toBe(false);
  });
  it('does not flag a short real caption ("Facebook" is a shell title, "Facebook cake" is not)', () => {
    expect(isPlatformShell(extractMeta('<meta property="og:title" content="Facebook cake for the office party 🎂" />'))).toBe(false);
  });
});

describe('stripFacebookTitleSuffix on oEmbed titles', () => {
  it('strips " | Page | Facebook" after a hashtag run', () => {
    expect(stripFacebookTitleSuffix('#SourCreamCake #SimpleBaking | Taste the East | Facebook')).toBe('#SourCreamCake #SimpleBaking');
  });
});

describe('looksLikeRecipeText', () => {
  it('recognizes an English ingredient list', () => {
    expect(looksLikeRecipeText(CAPTION)).toBe(true);
  });
  it('recognizes Polish and Russian ingredient lists', () => {
    expect(looksLikeRecipeText('Składniki:\n• 250 g mąki\n• 2 jajka\n• 100 ml mleka\n• 1 łyżka cukru')).toBe(true);
    expect(looksLikeRecipeText('Ингредиенты:\n- 3 яйца\n- 200 г сметаны\n- 1 ст. л. сахара')).toBe(true);
  });
  it('recognizes a heading plus bullets even without units', () => {
    expect(looksLikeRecipeText('Ingredientes\n• huevos\n• crema\n• azúcar')).toBe(true);
  });
  it('recognizes US-style fractional captions without bullets', () => {
    expect(looksLikeRecipeText("Grandma's Banana Bread\n1/2 cup butter\n3/4 cup sugar\n2 eggs\n1 1/2 cups flour\n1/4 tsp salt\n3 bananas\nMix everything, bake at 350 for 55 minutes.")).toBe(true);
    expect(looksLikeRecipeText('Ingredients:\n1/2 cup butter\n1/4 cup sugar\n3/4 cup flour\nInstructions:\nMix. Bake.')).toBe(true);
  });
  it('recognizes a RECIPE section with glued metric units (the YouTube tarte tatin description)', () => {
    expect(looksLikeRecipeText('Chapters 0:00 intro 2:10 caramel\n\nRECIPE\n• 150g soft unsalted butter\n• 150g caster sugar\n• 8 Pink Lady apples\n• 1 sheet puff pastry\n• pinch of salt\nBake in a 180°C oven for 40–50 minutes.')).toBe(true);
  });
  it('rejects teasers, ads and login boilerplate', () => {
    expect(looksLikeRecipeText('Recipe in comments! 😍 Follow for more #cake #viral')).toBe(false);
    expect(looksLikeRecipeText('Log into Facebook to start sharing and connecting with your friends, family, and people you know.')).toBe(false);
    expect(looksLikeRecipeText('Our new 2 in 1 blender is 30% off for 3 days only. Link in bio!')).toBe(false);
  });
});

describe('isShellText', () => {
  it('flags login-wall boilerplate and not real captions', () => {
    expect(isShellText('Log into Facebook to start sharing and connecting with your friends, family, and people you know.')).toBe(true);
    expect(isShellText('Create an account or log in to Instagram - Share what you\'re into with the people who get you.')).toBe(true);
    expect(isShellText('Log in or sign up to view')).toBe(true);
    expect(isShellText('Sour Cream Cake 🤍 No flour. Ingredients • 6 large eggs')).toBe(false);
    expect(isShellText('')).toBe(false);
  });
});

describe('titlesPlausiblyMatch: similar-recipe guard', () => {
  it('still accepts a genuine match', () => {
    expect(titlesPlausiblyMatch('honey cake', 'Russian Honey Cake (Medovik)')).toBe(true);
    expect(titlesPlausiblyMatch('sour cream cake', 'Easy Sour Cream Cake')).toBe(true);
  });
  it('accepts descriptive recipe titles for short dish names', () => {
    expect(titlesPlausiblyMatch('tiramisu', 'The Best Tiramisu You Will Ever Make')).toBe(true);
    expect(titlesPlausiblyMatch('pierogi', 'Homemade Polish Pierogi with Potato and Cheese Filling')).toBe(true);
    expect(titlesPlausiblyMatch('banana bread', 'Moist Banana Bread with Brown Butter and Walnuts')).toBe(true);
    expect(titlesPlausiblyMatch('honey cake', 'Russian Honey Cake (Medovik) - Layered with Sour Cream')).toBe(true);
    expect(titlesPlausiblyMatch('chłodnik', 'Chłodnik – Polish Cold Beet Soup')).toBe(true);
  });
  it('rejects a different dish that merely shares a category word', () => {
    expect(titlesPlausiblyMatch('key lime sour cream pound cake', 'Sour Cream Coffee Cake with Cinnamon-Walnut Swirl')).toBe(false);
    expect(titlesPlausiblyMatch('key lime sour cream pound cake', 'Sour Cream Coffee Cake with Walnut Swirl')).toBe(false);
    expect(titlesPlausiblyMatch('banana bread', 'Zucchini Bread')).toBe(false);
    expect(titlesPlausiblyMatch('cake', 'Sour Cream Coffee Cake with Cinnamon-Walnut Swirl and Espresso Glaze')).toBe(false);
  });
});

describe('spoken-recipe quality gate', async () => {
  const { isThinSpokenRecipe, COMMENTS_HINT_RE } = await import('../src/extract/index');
  const ing = (item: string, qty: number | null = null) => ({ raw: item, qty, qtyHigh: null, unit: null, item, note: null, group: null });
  const step = (text: string) => ({ text, minutes: null, group: null });
  it('rejects a 15-second clip summary (four unquantified ingredients, three vague steps)', () => {
    expect(isThinSpokenRecipe({
      ingredients: [ing('flour'), ing('sugar'), ing('yolk'), ing('wipes')],
      steps: [step('Combine flour, sugar, and yolk mixes'), step('Bake in the pan'), step('Let it cool')],
    })).toBe(true);
  });
  it('keeps a spoken recipe that has quantities', () => {
    expect(isThinSpokenRecipe({ ingredients: [ing('flour', 250), ing('sugar'), ing('eggs', 2)], steps: [step('Mix'), step('Bake')] })).toBe(false);
  });
  it('keeps a long talk-through even without quantities', () => {
    const many = ['flour', 'sugar', 'eggs', 'butter', 'milk', 'vanilla', 'salt'].map((i) => ing(i));
    expect(isThinSpokenRecipe({ ingredients: many, steps: [step('a'), step('b'), step('c'), step('d')] })).toBe(false);
  });
  it('spots captions that send readers to the comments', () => {
    expect(COMMENTS_HINT_RE.test('Fluffy cheesecake 😍 recipe in the comments 👇')).toBe(true);
    expect(COMMENTS_HINT_RE.test('Full recipe below in comments!')).toBe(true);
    expect(COMMENTS_HINT_RE.test('Przepis w komentarzu ⬇️')).toBe(true);
    expect(COMMENTS_HINT_RE.test('Fluffy cheesecake 😍')).toBe(false);
  });
});

describe('normalize: split ingredient lines are not repeated', async () => {
  const { normalizeModelRecipe } = await import('../src/llm');
  const base = { is_recipe: true, dish_guess: null, dish_guess_en: null, title: 'Cheesecake', language: 'en', description: null, servings: null, prep_minutes: null, cook_minutes: null, total_minutes: null, steps: [], notes: [] };
  it('gives each entry its own part when the model repeated the whole line', () => {
    const r = normalizeModelRecipe({ ...base, ingredients: [
      { raw: '5 egg yolks, 5 egg whites', qty: 5, qty_high: null, unit: null, item: 'egg yolks', note: null, group: null },
      { raw: '5 egg yolks, 5 egg whites', qty: 5, qty_high: null, unit: null, item: 'egg whites', note: null, group: null },
      { raw: '1/4 cup flour + 2tbsp cornstarch', qty: 0.25, qty_high: null, unit: 'cup', item: 'flour', note: null, group: null },
      { raw: '1/4 cup flour + 2tbsp cornstarch', qty: 2, qty_high: null, unit: 'tbsp', item: 'cornstarch', note: null, group: null },
      { raw: '3/4 cup sugar', qty: 0.75, qty_high: null, unit: 'cup', item: 'sugar', note: null, group: null },
    ] });
    expect(r.ingredients.map((i) => i.raw)).toEqual(['5 egg yolks', '5 egg whites', '1/4 cup flour', '2 tbsp cornstarch', '3/4 cup sugar']);
  });
  it('drops true duplicates', () => {
    const r = normalizeModelRecipe({ ...base, ingredients: [
      { raw: '2 eggs', qty: 2, qty_high: null, unit: null, item: 'eggs', note: null, group: null },
      { raw: '2 eggs', qty: 2, qty_high: null, unit: null, item: 'eggs', note: null, group: null },
    ] });
    expect(r.ingredients.length).toBe(1);
  });
});
