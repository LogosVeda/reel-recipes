// Find a public recipe for a dish whose original recipe is locked away
// (newsletter/subscription teasers). Two keyless strategies, in order:
//
//   1. DuckDuckGo's HTML endpoint — broadest coverage, but it serves a bot
//      challenge from many networks, so treat it as opportunistic.
//   2. The WordPress REST search API (/wp-json/wp/v2/search) on a small pool
//      of permissive recipe blogs — standardized JSON, no scraping, reliable.
//
// Either way, callers vet every candidate the strict way: only pages with
// real schema.org/Recipe data (and a plausibly matching title) count.
import { validateUrl } from './url.js';

const SEARCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

// Domains that can rank for "<dish> recipe" but never carry extractable
// recipes (social/video platforms) — skip without fetching.
const SKIP_HOSTS =
  /(^|\.)(instagram\.com|facebook\.com|tiktok\.com|youtube\.com|youtu\.be|pinterest\.[a-z.]+|reddit\.com|x\.com|twitter\.com)$/i;

// WordPress recipe blogs whose REST search answered from a datacenter IP
// (probed 2026-07). Grouped by language; unknown languages use the EN pool.
const WP_POOLS: Record<string, string[]> = {
  en: ['www.budgetbytes.com', 'sallysbakingaddiction.com', 'www.cookieandkate.com'],
  pl: ['www.mojewypieki.com'],
};

/**
 * Parse DuckDuckGo's HTML results page into external result URLs, in rank
 * order. DDG wraps every result as /l/?uddg=<encoded-url>&rut=... — decode
 * those; a layout change or challenge page yields [] (never throws).
 */
export function parseDuckDuckGoResults(html: string, max = 8): string[] {
  const out: string[] = [];
  const seenHosts = new Set<string>();
  const re = /href="[^"]*?[?&]uddg=([^"&]+)[^"]*"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < max) {
    let url: string;
    try {
      url = decodeURIComponent(m[1]!);
    } catch {
      continue;
    }
    if (!/^https:\/\//i.test(url)) continue;
    let host: string;
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (SKIP_HOSTS.test(host) || seenHosts.has(host)) continue;
    if (!validateUrl(url)) continue;
    seenHosts.add(host);
    out.push(url);
  }
  return out;
}

async function duckDuckGo(query: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: { 'User-Agent': SEARCH_UA, 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return [];
    return parseDuckDuckGoResults(await res.text());
  } catch {
    return [];
  }
}

async function wordPressSearch(host: string, query: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://${host}/wp-json/wp/v2/search?search=${encodeURIComponent(query)}&per_page=2&subtype=post`,
      {
        headers: { 'User-Agent': SEARCH_UA, Accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return [];
    const items = (await res.json()) as Array<{ url?: string }>;
    if (!Array.isArray(items)) return [];
    return items
      .map((i) => (typeof i.url === 'string' ? i.url : ''))
      .filter((u) => /^https:\/\//.test(u) && validateUrl(u));
  } catch {
    return [];
  }
}

/** Crude but effective for this app's audience: Polish diacritics → pl pool. */
function poolFor(dish: string): string[] {
  return /[ąćęłńóśźż]/i.test(dish) ? WP_POOLS.pl! : WP_POOLS.en!;
}

/** Lowercase and fold diacritics (incl. Polish ł, which NFD won't decompose). */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * A found recipe only counts as "similar" when its title shares at least one
 * substantive word with the dish — WordPress search happily returns its best
 * fuzzy guess, and "blueberry chłodnik" must not come back as banana bread.
 */
export function titlesPlausiblyMatch(dish: string, foundTitle: string): boolean {
  const words = (s: string) => new Set(fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  const a = words(dish);
  const b = words(foundTitle);
  for (const w of a) if (b.has(w)) return true;
  return false;
}

/**
 * Candidate recipe-page URLs for a dish, best sources first. Never throws;
 * [] when every strategy comes up dry.
 */
export async function searchWeb(dish: string): Promise<string[]> {
  const ddg = await duckDuckGo(`${dish} recipe`);
  if (ddg.length > 0) return ddg;
  const pool = poolFor(dish);
  const perSite = await Promise.all(pool.map((host) => wordPressSearch(host, dish)));
  return perSite.flat();
}
