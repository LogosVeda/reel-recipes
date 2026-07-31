import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  extractMeta,
  htmlToText,
  stripInstagramTitlePrefix,
  unwrapInstagramDescription,
} from '../src/extract/html';
import { parseDuckDuckGoResults, titlesPlausiblyMatch } from '../src/extract/search';
import { parseTranscriptPayload } from '../src/extract/platforms';

describe('decodeEntities', () => {
  it('decodes named entities', () => {
    expect(decodeEntities('Salt &amp; pepper &lt;3 &gt; &quot;hi&quot; &apos;yo&apos;')).toBe(
      'Salt & pepper <3 > "hi" \'yo\''
    );
  });

  it('decodes nbsp to a plain space', () => {
    expect(decodeEntities('one&nbsp;cup')).toBe('one cup');
  });

  it('decodes decimal numeric entities', () => {
    expect(decodeEntities('&#39;tis &#123;x&#125;')).toBe("'tis {x}");
  });

  it('decodes hex numeric entities including astral code points', () => {
    expect(decodeEntities('&#x1F35D; noodles &#x41;')).toBe('\u{1F35D} noodles A');
  });

  it('leaves unknown entities and bare ampersands alone', () => {
    expect(decodeEntities('a &notarealentityzz; b & c')).toBe('a &notarealentityzz; b & c');
  });
});

describe('extractMeta', () => {
  it('extracts title and standard meta tags', () => {
    const html = `<html><head>
      <title>Best Pasta &amp; Sauce</title>
      <meta name="description" content="A quick weeknight pasta.">
      <meta name="author" content="Chef Ana">
    </head><body></body></html>`;
    const meta = extractMeta(html);
    expect(meta.title).toBe('Best Pasta & Sauce');
    expect(meta.description).toBe('A quick weeknight pasta.');
    expect(meta.author).toBe('Chef Ana');
    expect(meta.ogTitle).toBeNull();
  });

  it('handles content attribute before property attribute', () => {
    const html = `<meta content="OG Pasta" property="og:title">
      <meta content="OG description here" property="og:description">
      <meta content="Tasty Site" property="og:site_name">`;
    const meta = extractMeta(html);
    expect(meta.ogTitle).toBe('OG Pasta');
    expect(meta.ogDescription).toBe('OG description here');
    expect(meta.siteName).toBe('Tasty Site');
  });

  it('handles single quotes and self-closing tags', () => {
    const html = `<meta property='og:title' content='Single Quoted' />
      <meta name='description' content='Desc in singles'/>`;
    const meta = extractMeta(html);
    expect(meta.ogTitle).toBe('Single Quoted');
    expect(meta.description).toBe('Desc in singles');
  });

  it('is case-insensitive on tag and attribute names', () => {
    const html = `<META PROPERTY="OG:TITLE" CONTENT="Shouted Title">`;
    expect(extractMeta(html).ogTitle).toBe('Shouted Title');
  });

  it('decodes entities in content values', () => {
    const html = `<meta property="og:description" content="Mac &amp; cheese &#x1F9C0;">`;
    expect(extractMeta(html).ogDescription).toBe('Mac & cheese \u{1F9C0}');
  });

  it('keeps the first occurrence when duplicated', () => {
    const html = `<meta property="og:title" content="First">
      <meta property="og:title" content="Second">`;
    expect(extractMeta(html).ogTitle).toBe('First');
  });

  it('returns nulls for missing fields and empty content', () => {
    const meta = extractMeta('<meta property="og:title" content=""><p>hi</p>');
    expect(meta).toEqual({
      title: null,
      description: null,
      ogTitle: null,
      ogDescription: null,
      ogVideo: null,
      ogImage: null,
      siteName: null,
      author: null,
    });
  });
});

describe('htmlToText', () => {
  it('strips script, style, noscript, and template blocks', () => {
    const html = `<p>Keep me</p>
      <script>var hidden = "nope";</script>
      <style>.x { color: red }</style>
      <noscript>enable js</noscript>
      <template><span>ghost</span></template>
      <p>And me</p>`;
    const text = htmlToText(html);
    expect(text).toContain('Keep me');
    expect(text).toContain('And me');
    expect(text).not.toContain('hidden');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('enable js');
    expect(text).not.toContain('ghost');
  });

  it('strips HTML comments', () => {
    expect(htmlToText('a <!-- secret --> b')).toBe('a b');
  });

  it('turns br and block boundaries into newlines', () => {
    const html = '<p>one</p><div>two</div><ul><li>three</li><li>four</li></ul>five<br>six';
    const text = htmlToText(html);
    expect(text.split('\n')).toEqual(['one', 'two', 'three', 'four', 'five', 'six']);
  });

  it('handles heading and table row boundaries', () => {
    const text = htmlToText('<h1>Title</h1><table><tr><td>a</td><td>b</td></tr></table>done');
    expect(text).toBe('Title\na b\ndone');
  });

  it('collapses runs of spaces and 3+ newlines', () => {
    const html = '<p>one</p>\n\n\n\n<p>two   words</p>\n\n\n\n\n<p>three</p>';
    const text = htmlToText(html);
    expect(text).toBe('one\n\ntwo words\n\nthree');
  });

  it('decodes entities in the flattened text', () => {
    expect(htmlToText('<p>1&frac12; cups &amp; a pinch</p>')).toBe('1½ cups & a pinch');
  });

  it('respects maxLen', () => {
    const html = '<p>' + 'x'.repeat(500) + '</p>';
    expect(htmlToText(html, 100)).toHaveLength(100);
  });
});

describe('stripInstagramTitlePrefix', () => {
  it('drops the "Account | Name on Instagram:" wrapper and keeps the caption', () => {
    const s = 'Buchta z Masłem | Marianna on Instagram: "Jagody w polskiej kuchni najczęściej kojarzymy z pierogami."';
    expect(stripInstagramTitlePrefix(s)).toBe('Jagody w polskiej kuchni najczęściej kojarzymy z pierogami.');
  });

  it('keeps a truncated caption that never closed its quote', () => {
    const s = 'Delaney & Shelby on Instagram: "We clearly are on a pastina kick (but who';
    expect(stripInstagramTitlePrefix(s)).toBe('We clearly are on a pastina kick (but who');
  });

  it('returns non-Instagram titles unchanged', () => {
    expect(stripInstagramTitlePrefix('Perfect Carbonara | RecipeTin Eats')).toBe('Perfect Carbonara | RecipeTin Eats');
  });
});

describe('parseDuckDuckGoResults', () => {
  const page = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.seriouseats.com%2Fpastina-soup&rut=abc">Pastina</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dxyz&rut=def">Video</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.seriouseats.com%2Fother&rut=ghi">Dup host</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2Finsecure.example%2Fx&rut=jkl">http only</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbudgetbytes.com%2Fpastina%2F&rut=mno">BB</a>`;

  it('decodes uddg targets, skips video/social hosts, dedupes hosts, https only', () => {
    expect(parseDuckDuckGoResults(page)).toEqual([
      'https://www.seriouseats.com/pastina-soup',
      'https://budgetbytes.com/pastina/',
    ]);
  });

  it('returns [] on markup it does not recognize', () => {
    expect(parseDuckDuckGoResults('<html><body>No results wrapper here</body></html>')).toEqual([]);
  });
});

describe('parseTranscriptPayload', () => {
  it('reads tracks[].transcript[].text', () => {
    expect(parseTranscriptPayload([{ id: 'x', tracks: [{ language: 'en', transcript: [{ text: 'Peel the' }, { text: 'apples.' }] }] }]))
      .toBe('Peel the apples.');
  });
  it('reads a bare transcript array of strings', () => {
    expect(parseTranscriptPayload({ transcript: ['Caramel', 'in the pan'] })).toBe('Caramel in the pan');
  });
  it('returns null on shapes it does not recognize', () => {
    expect(parseTranscriptPayload({ nothing: true })).toBeNull();
    expect(parseTranscriptPayload([])).toBeNull();
  });
});

describe('titlesPlausiblyMatch', () => {
  it('accepts a shared substantive word', () => {
    expect(titlesPlausiblyMatch('chicken pastina soup', 'Italian Wedding Soup')).toBe(true);
  });
  it('rejects unrelated dishes', () => {
    expect(titlesPlausiblyMatch('chłodnik jagodowy', 'Banana Bread')).toBe(false);
  });
  it('folds diacritics so Polish matches survive', () => {
    expect(titlesPlausiblyMatch('chłodnik jagodowy', 'Chlodnik jagodowy z kluskami')).toBe(true);
  });
});

describe('unwrapInstagramDescription', () => {
  it('strips the likes/comments prefix and surrounding quotes', () => {
    const s =
      '1,234 likes, 56 comments - pastaqueen on July 1, 2026: "Creamy garlic pasta! Full recipe below."';
    expect(unwrapInstagramDescription(s)).toBe('Creamy garlic pasta! Full recipe below.');
  });

  it('handles curly quotes', () => {
    const s = '10 likes, 2 comments - chef on May 3, 2026: “Smash burger tacos”';
    expect(unwrapInstagramDescription(s)).toBe('Smash burger tacos');
  });

  it('keeps captions containing quotes intact except the trailing wrapper quote', () => {
    const s = '5 likes, 0 comments - c on Jan 1, 2026: "She said "wow" and left"';
    expect(unwrapInstagramDescription(s)).toBe('She said "wow" and left');
  });

  it('returns trimmed input when there is no prefix pattern', () => {
    expect(unwrapInstagramDescription('  Just a plain caption  ')).toBe('Just a plain caption');
  });
});
