// Facebook's classic video page (facebook.com/<page>/videos/<id>/, reached
// via facebook.com/watch/?v=<id>) server-renders the top comments for any
// visitor — no login involved, it is what a logged-out browser shows. Reel
// pages and the mobile sites do not. Creators routinely post the written
// recipe as their own first comment, so that comment is worth reading.
// Pure parsing here; the fetch lives in platforms.ts.

export interface FacebookComment {
  text: string;
  author: string | null;
  authorId: string | null;
  /** 0 = top-level comment, 1+ = reply */
  depth: number;
  /** Reaction count as Facebook renders it ("832", "1.2K"), parsed to a number */
  reactions: number;
}

/** The numeric video id from any Facebook video/reel URL shape. */
export function facebookVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    if (v && /^\d{6,}$/.test(v)) return v;
    const m = /\/(?:reel|videos|video|watch)\/(?:[^/]+\/)?(\d{6,})/.exec(u.pathname) ?? /\/videos\/(\d{6,})/.exec(u.pathname);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** Decode a JSON string body captured without its quotes. */
function jsonString(raw: string): string | null {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return null;
  }
}

function parseCount(s: string | undefined): number {
  if (!s) return 0;
  const m = /^([\d.,]+)\s*([KkMm])?$/.exec(s.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  const unit = (m[2] ?? '').toUpperCase();
  return Math.round(unit === 'K' ? n * 1000 : unit === 'M' ? n * 1_000_000 : n);
}

const JSON_STR = '((?:[^"\\\\]|\\\\.)*)';
/** The tail every comment node ends with: …,"depth":N,"body":{"text":"…"} */
const NODE_TAIL_RE = new RegExp(`"depth":(\\d+),"body":\\{"text":"${JSON_STR}"`, 'g');
// id then name, with only flat fields in between (the object goes on to nest
// profile pictures, which a bracket-free run must not cross).
const AUTHOR_RE = new RegExp(`"author":\\{"__typename":"(?:User|Page)","id":"(\\d+)"[^{}]{0,400}?"name":"${JSON_STR}"`, 'g');
const COUNT_RE = /"count_reduced":"([^"]*)"/g;

function lastMatch(re: RegExp, text: string): RegExpExecArray | null {
  re.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m;
  return last;
}

function field(objBody: string, key: string): string | null {
  const m = new RegExp(`"${key}":"${JSON_STR}"`).exec(objBody);
  return m ? jsonString(m[1]!) : null;
}

/**
 * Comments embedded in the page's server-rendered JSON. Works on the raw
 * text (no JSON.parse of a megabyte payload, and tolerant of a body that was
 * cut off by our size cap). A comment node's keys arrive in a fixed order —
 * id, …, feedback (with the reaction count), legacy_fbid, depth, body, …,
 * author, …, __typename — so each `"depth":N,"body":{"text":…}` marks one
 * node: its reaction count is the last one before it, its author the first
 * one after it (before the next node's body).
 */
export function parseFacebookComments(html: string): FacebookComment[] {
  const out: FacebookComment[] = [];
  const seen = new Set<string>();
  // A page cut off by our size cap has no closing tag on its last script —
  // still worth reading up to the cut.
  const scriptRe = /<script type="application\/json"[^>]*>([\s\S]*?)(?:<\/script>|$)/g;
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(html)) !== null) {
    const script = sm[1]!;
    if (!script.includes('"__typename":"Comment"')) continue;
    const tails: RegExpExecArray[] = [];
    NODE_TAIL_RE.lastIndex = 0;
    let t: RegExpExecArray | null;
    while ((t = NODE_TAIL_RE.exec(script)) !== null) tails.push(t);
    for (let i = 0; i < tails.length; i++) {
      const tail = tails[i]!;
      const text = jsonString(tail[2]!)?.trim();
      if (!text) continue;
      const before = script.slice(i === 0 ? 0 : tails[i - 1]!.index + tails[i - 1]![0].length, tail.index);
      const after = script.slice(tail.index + tail[0].length, tails[i + 1]?.index ?? script.length);
      AUTHOR_RE.lastIndex = 0;
      const author = AUTHOR_RE.exec(after);
      const authorId = author?.[1] ?? null;
      const authorName = author ? jsonString(author[2]!) : null;
      const count = lastMatch(COUNT_RE, before);
      const key = `${authorId ?? ''}|${text.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text, author: authorName, authorId, depth: Number(tail[1]), reactions: parseCount(count?.[1]) });
    }
  }
  return out;
}

/**
 * The page/profile that owns THIS video. The video's own owner object is
 * nameless ("owner":{…,"id":"…","__isVideoOwner":…}) and comes before the
 * "related videos" rail, whose entries do carry names — so resolve the id
 * first and only then look the name up, rather than trusting the first
 * named owner-ish object on the page. The comments' parent feedback names
 * the post owner too (owning_profile), which is the fallback.
 */
export function facebookVideoOwner(html: string): { name: string | null; id: string | null } {
  const byVideo = /"owner":\{"__typename":"(?:User|Page)","id":"(\d+)","__isVideoOwner"/.exec(html);
  const id = byVideo?.[1] ?? null;
  if (id) {
    const named =
      new RegExp(`"id":"${id}"[^{}]{0,200}?"name":"${JSON_STR}"`).exec(html) ??
      new RegExp(`"name":"${JSON_STR}"[^{}]{0,200}?"id":"${id}"`).exec(html);
    return { name: named ? jsonString(named[1]!) : null, id };
  }
  const re = /"(?:owning_profile|video_owner|owner)":\{"__typename":"(?:User|Page)",([^{}]{0,400}?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const body = m[1]!;
    const name = field(body, 'name');
    const ownerId = /"id":"(\d+)"/.exec(body)?.[1] ?? null;
    if (name) return { name, id: ownerId };
  }
  return { name: null, id: null };
}

export function isByOwner(c: FacebookComment, owner: { name: string | null; id: string | null }): boolean {
  return Boolean(
    (owner.id && c.authorId === owner.id) ||
      (owner.name && c.author && c.author.trim().toLowerCase() === owner.name.trim().toLowerCase()),
  );
}

/** Every http(s) link in a text, in order. */
export function linksInText(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
}

/**
 * The written recipe among the comments. The creator's own comments win —
 * all of them, in page order, since a long recipe is often split into an
 * "ingredients" comment and a "method" comment. Without the creator, the
 * first top-level comment that reads like a recipe (Facebook lists pinned
 * comments first) unless a far more reacted one exists. `looksLikeRecipe`
 * is the same smell test the model step uses, injected so this module stays
 * free of the LLM code.
 */
export function pickRecipeComment(
  comments: FacebookComment[],
  owner: { name: string | null; id: string | null },
  looksLikeRecipe: (s: string) => boolean,
): { text: string; author: string | null; authorId: string | null; byOwner: boolean; links: string[] } | null {
  const ownerComments = comments.filter((c) => isByOwner(c, owner) && c.text.length >= 40);
  const ownerLinks = ownerComments.flatMap((c) => linksInText(c.text));
  if (ownerComments.some((c) => looksLikeRecipe(c.text))) {
    const text = ownerComments.map((c) => c.text).join('\n\n');
    return { text, author: ownerComments[0]!.author, authorId: ownerComments[0]!.authorId, byOwner: true, links: ownerLinks };
  }
  const recipeLike = comments.filter((c) => c.text.length >= 60 && looksLikeRecipe(c.text));
  const topLevel = recipeLike.filter((c) => c.depth === 0);
  let pick: FacebookComment | null = null;
  if (topLevel.length > 0) {
    const first = topLevel[0]!;
    const mostReacted = [...topLevel].sort((a, b) => b.reactions - a.reactions)[0]!;
    pick = mostReacted.reactions > first.reactions * 5 ? mostReacted : first;
  } else if (recipeLike.length > 0) {
    pick = recipeLike[0]!;
  }
  if (!pick && ownerLinks.length === 0) return null;
  return {
    text: pick?.text ?? '',
    author: pick?.author ?? ownerComments[0]?.author ?? null,
    authorId: pick?.authorId ?? null,
    byOwner: false,
    links: ownerLinks,
  };
}
