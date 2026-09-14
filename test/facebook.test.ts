// The creator's recipe comment on Facebook's server-rendered video page.
import { describe, expect, it } from 'vitest';
import { facebookVideoId, facebookVideoOwner, parseFacebookComments, pickRecipeComment } from '../src/extract/facebook';
import { looksLikeRecipeText } from '../src/llm';
import { PAGE } from './fixtures/facebook-video-page';

describe('facebookVideoId', () => {
  it('reads the id from every URL shape', () => {
    expect(facebookVideoId('https://www.facebook.com/reel/1036203532674501/?rdid=x')).toBe('1036203532674501');
    expect(facebookVideoId('https://www.facebook.com/SucculentBite/videos/1036203532674501/')).toBe('1036203532674501');
    expect(facebookVideoId('https://www.facebook.com/watch/?v=1036203532674501')).toBe('1036203532674501');
    expect(facebookVideoId('https://www.facebook.com/video.php?v=1036203532674501')).toBe('1036203532674501');
    expect(facebookVideoId('https://www.facebook.com/share/r/19gqCfzEcf/')).toBeNull();
  });
});

describe('parseFacebookComments', () => {
  it('extracts the top-level comments with author, depth and reactions', () => {
    const comments = parseFacebookComments(PAGE);
    expect(comments.length).toBe(2);
    const [recipe, reply] = comments;
    expect(recipe!.author).toBe('The Succulent Bite');
    expect(recipe!.authorId).toBe('100044369081549');
    expect(recipe!.depth).toBe(0);
    expect(recipe!.reactions).toBe(832);
    expect(recipe!.text.startsWith('Ingredients\n• 8oz cream cheese (room temp)')).toBe(true);
    expect(recipe!.text).toContain('Bake at 350°F for 20 minutes');
    expect(reply!.author).toBe('Son Dang');
    expect(reply!.reactions).toBe(233);
  });
  it('survives a payload cut off mid-way', () => {
    const cut = PAGE.slice(0, PAGE.indexOf('Japanese cotton cheesecake') - 200);
    const comments = parseFacebookComments(cut);
    expect(comments.length).toBe(1);
    expect(comments[0]!.text).toContain('8oz cream cheese');
    expect(comments[0]!.author).toBe('The Succulent Bite');
  });
  it('returns nothing for pages without comment payloads', () => {
    expect(parseFacebookComments('<html><script type="application/json">{"a":1}</script></html>')).toEqual([]);
  });
});

describe('facebookVideoOwner + pickRecipeComment', () => {
  it('resolves the owner by the video\'s own id, not the first named page in the related rail', () => {
    const owner = facebookVideoOwner(PAGE);
    expect(owner.id).toBe('100044369081549');
    expect(owner.name).toBe('The Succulent Bite');
    const pick = pickRecipeComment(parseFacebookComments(PAGE), owner, looksLikeRecipeText);
    expect(pick?.byOwner).toBe(true);
    expect(pick?.author).toBe('The Succulent Bite');
    expect(pick?.text).toContain('7 inch springform pan');
    expect(pick?.links).toEqual([]);
  });
  it('joins a recipe the creator split across two comments and surfaces the creator\'s links', () => {
    const comments = [
      { text: 'INGREDIENTS\n• 250 g flour\n• 3 eggs\n• 100 ml milk', author: 'Creator', authorId: '2', depth: 0, reactions: 50 },
      { text: 'Fan question?', author: 'Fan', authorId: '9', depth: 0, reactions: 1 },
      { text: 'METHOD\n1. Whip the whites\n2. Fold\n3. Bake 40 min. Printable: https://creator.example/cake', author: 'Creator', authorId: '2', depth: 0, reactions: 30 },
    ];
    const pick = pickRecipeComment(comments, { name: 'Creator', id: '2' }, looksLikeRecipeText);
    expect(pick?.byOwner).toBe(true);
    expect(pick?.text).toContain('250 g flour');
    expect(pick?.text).toContain('Whip the whites');
    expect(pick?.links).toEqual(['https://creator.example/cake']);
  });
  it('surfaces a creator comment that only links to the recipe', () => {
    const comments = [{ text: 'Full written recipe with measurements here 👉 https://thesucculentbite.com/fluffy-cheesecake', author: 'Creator', authorId: '2', depth: 0, reactions: 5 }];
    const pick = pickRecipeComment(comments, { name: 'Creator', id: '2' }, looksLikeRecipeText);
    expect(pick?.links).toEqual(['https://thesucculentbite.com/fluffy-cheesecake']);
    expect(pick?.text).toBe('');
  });
  it('never picks a chatty comment', () => {
    const chat = [{ text: 'Japanese cotton cheesecake made super fluffy then:)) love it so much, thanks for sharing this!', author: 'Son Dang', authorId: '1', depth: 0, reactions: 9000 }];
    expect(pickRecipeComment(chat, { name: 'The Succulent Bite', id: '2' }, looksLikeRecipeText)).toBeNull();
  });
  it('falls back to the most-reacted recipe-looking comment when the creator wrote none', () => {
    const comments = [
      { text: 'Ingredients:\n• 2 cups flour\n• 1 cup sugar\n• 3 eggs\nMix and bake 30 min.', author: 'Fan A', authorId: '10', depth: 0, reactions: 12 },
      { text: 'Ingredients:\n• 250 g flour\n• 200 g sugar\n• 3 eggs\n• 100 ml milk\nMix, bake 35 min at 180C.', author: 'Fan B', authorId: '11', depth: 0, reactions: 340 },
    ];
    expect(pickRecipeComment(comments, { name: 'Creator', id: '2' }, looksLikeRecipeText)?.author).toBe('Fan B');
    expect(pickRecipeComment(comments, { name: 'Creator', id: '2' }, looksLikeRecipeText)?.byOwner).toBe(false);
  });
});
