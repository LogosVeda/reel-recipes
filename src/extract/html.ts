// Pure HTML parsing helpers. No fetch, no Workers APIs — vitest runs these in Node.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Decode nbsp to a plain space so whitespace collapsing treats it uniformly.
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  ntilde: 'ñ',
  times: '×',
  middot: '·',
  bull: '•',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,30});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      // Surrogate halves are invalid code points for fromCodePoint.
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    const name = m[1].toLowerCase();
    attrs[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

export interface MetaInfo {
  title: string | null;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  /** Direct media URL from og:video / og:video:secure_url, when the page publishes one */
  ogVideo: string | null;
  /** Cover/preview image from og:image — the one visual reels always publish */
  ogImage: string | null;
  siteName: string | null;
  author: string | null;
  /** Canonical URL the page declares (og:url) — resolves share links to the real post */
  ogUrl: string | null;
  /**
   * Facebook/Instagram advertise their oEmbed endpoint with a <link> whose
   * title attribute carries the FULL caption — on some page variants the
   * only place it appears (og:title/og:description can be absent or generic).
   */
  oembedTitle: string | null;
}

export function extractMeta(html: string): MetaInfo {
  const out: MetaInfo = {
    title: null,
    description: null,
    ogTitle: null,
    ogDescription: null,
    ogVideo: null,
    ogImage: null,
    siteName: null,
    author: null,
    ogUrl: null,
    oembedTitle: null,
  };

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (titleMatch) {
    const t = decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
    if (t) out.title = t;
  }

  const metaRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const attrs = parseAttrs(m[0]);
    const key = (attrs['property'] ?? attrs['name'] ?? '').toLowerCase().trim();
    const rawContent = attrs['content'];
    if (!key || rawContent === undefined) continue;
    const content = decodeEntities(rawContent).trim();
    if (!content) continue;
    switch (key) {
      case 'description':
        if (out.description === null) out.description = content;
        break;
      case 'og:title':
        if (out.ogTitle === null) out.ogTitle = content;
        break;
      case 'og:description':
        if (out.ogDescription === null) out.ogDescription = content;
        break;
      case 'og:video':
      case 'og:video:url':
      case 'og:video:secure_url':
        if (out.ogVideo === null && /^https:\/\//.test(content)) out.ogVideo = content;
        break;
      case 'og:image':
      case 'og:image:url':
      case 'og:image:secure_url':
        if (out.ogImage === null && /^https:\/\//.test(content)) out.ogImage = content;
        break;
      case 'og:site_name':
        if (out.siteName === null) out.siteName = content;
        break;
      case 'og:url':
        if (out.ogUrl === null && /^https?:\/\//.test(content)) out.ogUrl = content;
        break;
      case 'author':
        if (out.author === null) out.author = content;
        break;
    }
  }

  // <link rel="alternate" href="…/oembed_video?url=…" title="full caption">
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const attrs = parseAttrs(m[0]);
    const href = attrs['href'] ?? '';
    const type = attrs['type'] ?? '';
    if (!/oembed/i.test(href) && !/oembed/i.test(type)) continue;
    const title = decodeEntities(attrs['title'] ?? '').trim();
    if (title && out.oembedTitle === null) out.oembedTitle = title;
  }

  return out;
}

/**
 * Login walls and "content not found" shells that Facebook/Instagram serve
 * instead of a post. They still carry og tags — generic ones — so a caption
 * length check alone would happily hand "Log into Facebook to start sharing…"
 * to the model. Recognize them so the fetcher can try again another way.
 */
const SHELL_TITLE_RE =
  /^(?:facebook|instagram|error|content not found|log ?in(?:to| or sign up to view)?.*|log into facebook.*|iniciar sesión.*|zaloguj się.*|войти.*|connexion.*|anmelden.*)$/i;
const SHELL_DESCRIPTION_RE =
  /^(?:log into facebook to start sharing|see posts, photos and more on facebook|create an account or log in to instagram|see photos and videos from your friends|log in to facebook|facebook helps you connect)/i;

/** True for login-wall / not-found boilerplate masquerading as a caption. */
export function isShellText(s: string | null | undefined): boolean {
  const t = (s ?? '').trim();
  return t.length > 0 && (SHELL_DESCRIPTION_RE.test(t) || SHELL_TITLE_RE.test(t));
}

export function isPlatformShell(meta: MetaInfo): boolean {
  const ogTitle = (meta.ogTitle ?? '').trim();
  const title = (meta.title ?? '').trim();
  const desc = (meta.ogDescription ?? '').trim();
  // A real post whose og:title is the caption never matches the generic
  // titles; the oEmbed caption being present also proves it's a real post.
  if (meta.oembedTitle && meta.oembedTitle.length >= 40) return false;
  if (SHELL_DESCRIPTION_RE.test(desc)) return true;
  if (ogTitle && SHELL_TITLE_RE.test(ogTitle)) return true;
  if (!ogTitle && title && SHELL_TITLE_RE.test(title)) return true;
  return false;
}

/**
 * The caption a Facebook/Instagram page publishes, taken from whichever
 * carrier holds the most of it: og:title (~1000 chars on Facebook, wrapped
 * with the page name), og:description (~200, ellipsis-truncated), or the
 * oEmbed <link> title (the full caption on variants that drop the og tags).
 */
export function bestSocialCaption(meta: MetaInfo): string {
  const candidates = [
    meta.ogTitle ? stripInstagramTitlePrefix(stripFacebookTitleSuffix(meta.ogTitle)) : '',
    meta.ogDescription ? unwrapInstagramDescription(meta.ogDescription) : '',
    meta.oembedTitle ? stripInstagramTitlePrefix(stripFacebookTitleSuffix(meta.oembedTitle)) : '',
  ].map((c) => (SHELL_DESCRIPTION_RE.test(c) || SHELL_TITLE_RE.test(c) ? '' : c));
  return candidates.reduce((best, c) => (c.length > best.length ? c : best), '');
}

export function htmlToText(html: string, maxLen = 30000): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/ ?\n ?/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// Instagram og:description wraps the caption:
//   '123 likes, 4 comments - chef on July 1, 2026: "caption text"'
// Strip the stats prefix and surrounding quotes when present.
export function unwrapInstagramDescription(s: string): string {
  const markers = [': "', ': “'];
  for (const marker of markers) {
    const idx = s.indexOf(marker);
    if (idx === -1) continue;
    let caption = s.slice(idx + marker.length);
    caption = caption.replace(/["”]\s*$/, '');
    return caption.trim();
  }
  return s.trim();
}

/**
 * Facebook og:title carries far more of a reel's caption (~780 chars) than
 * og:description (~200), but may end with " | Page Name | Facebook" — strip it.
 */
/**
 * Instagram og:title wraps the caption as:
 *   Account | Display Name on Instagram: "caption text"
 * Left unstripped, models regularly crown the recipe with the ACCOUNT name
 * ("Buchta z Masłem") instead of the dish. Strip the wrapper, keep the caption.
 */
export function stripInstagramTitlePrefix(s: string): string {
  const m = /^[^"”«]{0,160}\bon Instagram\s*:\s*["“]?([\s\S]*?)["”]?\s*$/.exec(s.trim());
  return m ? m[1]!.trim() : s.trim();
}

export function stripFacebookTitleSuffix(s: string): string {
  return s
    .replace(/\s*\|\s*[^|]{0,120}\|\s*Facebook\s*$/, '')
    .replace(/\s*\|\s*Facebook\s*$/, '')
    .trim();
}

/** True when a meta description shows the "cut off with an ellipsis" pattern. */
export function looksTruncated(s: string | null): boolean {
  if (!s) return false;
  return /(\.\.\.|\u2026)\s*$/.test(s.trim());
}

/** Captions that point at the comments for the recipe ("recipe in comments 👇"). */
export const COMMENTS_HINT_RE =
  /recipe[^.\n]{0,40}(?:\bin\b|below)[^.\n]{0,20}comments?|comments?\s*(?:👇|⬇|below)|(?:see|check)\s+(?:the\s+)?comments|link\s+in\s+(?:the\s+)?comments|przepis[^.\n]{0,30}komentarz|рецепт[^.\n]{0,30}коммент|receta[^.\n]{0,30}comentarios/iu;
