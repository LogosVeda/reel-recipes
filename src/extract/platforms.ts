// Platform detection and network adapters. Runs on Cloudflare Workers (fetch only).

import type { FetchedContent, Platform } from '../types.js';
import { extractMeta, htmlToText, looksTruncated, stripFacebookTitleSuffix, stripInstagramTitlePrefix, unwrapInstagramDescription } from './html.js';
import { validateUrl } from './url.js';

export function detectPlatform(url: string): Platform {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'web';
  }
  host = host.replace(/^(www|m)\./, '');

  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  if (
    host === 'facebook.com' ||
    host.endsWith('.facebook.com') ||
    host === 'fb.watch' ||
    host === 'fb.com'
  ) {
    return 'facebook';
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  // Anchored so "pinterest" must be the registrable label and the tail a real
  // TLD (pinterest.com, .co.uk, .com.au) — not "pinterest.evil.com".
  if (host === 'pin.it' || /^(?:[a-z0-9-]+\.)*pinterest\.(?:[a-z]{2,3}|com?\.[a-z]{2})$/.test(host)) {
    return 'pinterest';
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
    return 'youtube';
  }
  return 'web';
}

const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// Cap how much of a response body we keep (~1.5MB of text).
const MAX_BODY_CHARS = 1_500_000;
const MAX_REDIRECTS = 5;

interface FetchedPage {
  ok: boolean;
  status: number;
  text: string;
}

// Read the body incrementally and stop at the cap, so a hostile server can't
// stream hundreds of MB into memory before we truncate.
async function readCapped(res: Response): Promise<string> {
  const body = res.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length >= MAX_BODY_CHARS) {
        out = out.slice(0, MAX_BODY_CHARS);
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    /* return whatever we have */
  }
  return out;
}

async function fetchPage(url: string): Promise<FetchedPage | null> {
  // Follow redirects manually so each hop is re-validated — a vetted public URL
  // must not be able to bounce us to localhost / a metadata endpoint / odd port.
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!validateUrl(current)) return null;
      const res = await fetch(current, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { ok: false, status: res.status, text: '' };
        try {
          current = new URL(loc, current).toString();
        } catch {
          return null;
        }
        continue;
      }
      const contentLength = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(contentLength) && contentLength > 16_000_000) {
        return { ok: false, status: res.status, text: '' };
      }
      const text = await readCapped(res);
      return { ok: res.ok, status: res.status, text };
    }
    return null; // too many redirects
  } catch {
    return null;
  }
}


// Max video size we will pull for transcription (~25MB covers virtually all reels).
const MAX_VIDEO_BYTES = 25_000_000;

/**
 * Download a media file the source page itself published (og:video).
 * Returns null unless the response is actually audio/video and within the cap.
 */
export async function fetchVideoBytes(url: string): Promise<Uint8Array | null> {
  if (!validateUrl(url)) return null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!type.startsWith('video/') && !type.startsWith('audio/') && !type.includes('octet-stream')) {
      return null; // e.g. an embed player page, not a media file
    }
    const contentLength = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(contentLength) && contentLength > MAX_VIDEO_BYTES) return null;
    const body = res.body;
    if (!body) return null;
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_VIDEO_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  } catch {
    return null;
  }
}

// Max cover-image size for the vision fallback (~8MB matches the upload cap).
const MAX_IMAGE_BYTES = 8_000_000;

/**
 * Download the cover image the source page itself published (og:image).
 * Returns null unless the response is actually an image and within the cap.
 */
export async function fetchImageBytes(url: string): Promise<Uint8Array | null> {
  if (!validateUrl(url)) return null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!type.startsWith('image/')) return null;
    const contentLength = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) return null;
    const body = res.body;
    if (!body) return null;
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  } catch {
    return null;
  }
}

/**
 * Pull plain transcript text out of a youtube-transcript.io response. Their
 * payload shape isn't formally documented, so accept every plausible layout
 * (tracks[].transcript[].text, transcript[] directly, or a plain string) and
 * return null rather than guessing when none matches.
 */
export function parseTranscriptPayload(data: unknown): string | null {
  const joinSegments = (segs: unknown): string | null => {
    if (typeof segs === 'string') return segs.trim() || null;
    if (!Array.isArray(segs)) return null;
    const parts = segs
      .map((s) => (typeof s === 'string' ? s : typeof (s as { text?: unknown })?.text === 'string' ? (s as { text: string }).text : ''))
      .filter(Boolean);
    return parts.length > 0 ? parts.join(' ').replace(/\s+/g, ' ').trim() : null;
  };

  const fromItem = (item: unknown): string | null => {
    if (!item || typeof item !== 'object') return null;
    const it = item as Record<string, unknown>;
    const tracks = it['tracks'];
    if (Array.isArray(tracks)) {
      for (const track of tracks) {
        const t = joinSegments((track as Record<string, unknown>)?.['transcript']);
        if (t) return t;
      }
    }
    return joinSegments(it['transcript']) ?? joinSegments(it['text']);
  };

  if (Array.isArray(data)) {
    for (const item of data) {
      const t = fromItem(item);
      if (t) return t;
    }
    return null;
  }
  return fromItem(data);
}

/** Spoken words of a YouTube video via youtube-transcript.io (paid API). */
export async function fetchYouTubeTranscript(apiToken: string, videoId: string): Promise<string | null> {
  try {
    const res = await fetch('https://www.youtube-transcript.io/api/transcripts', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: [videoId] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const transcript = parseTranscriptPayload(await res.json());
    if (!transcript) return null;
    // Keep prompts inside the fallback model's context window.
    return transcript.length > 9000 ? transcript.slice(0, 9000) : transcript;
  } catch {
    return null;
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const page = await fetchPage(url);
  if (!page || !page.ok) return null;
  try {
    const parsed: unknown = JSON.parse(page.text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export async function fetchContent(url: string, env?: { YOUTUBE_API_KEY?: string }): Promise<FetchedContent | null> {
  const platform = detectPlatform(url);
  switch (platform) {
    case 'tiktok':
      return fetchTikTok(url);
    case 'youtube':
      return fetchYouTube(url, env?.YOUTUBE_API_KEY);
    case 'instagram':
      return fetchInstagramOrFacebook(url, 'instagram');
    case 'facebook':
      return fetchInstagramOrFacebook(url, 'facebook');
    case 'pinterest':
      return fetchPinterest(url);
    default:
      return fetchWeb(url);
  }
}

async function fetchTikTok(url: string): Promise<FetchedContent | null> {
  const oembed = await fetchJson(
    'https://www.tiktok.com/oembed?url=' + encodeURIComponent(url)
  );
  const caption = asString(oembed?.['title']);
  const oembedAuthor = asString(oembed?.['author_name']);

  const page = await fetchPage(url);
  const html = page && page.ok ? page.text : null;

  let text = caption ?? '';
  let title: string | null = null;
  let author = oembedAuthor;
  let siteName: string | null = 'TikTok';

  if (html) {
    const meta = extractMeta(html);
    title = meta.ogTitle ?? meta.title;
    if (!author) author = meta.author;
    if (meta.siteName) siteName = meta.siteName;
    if (meta.ogDescription && meta.ogDescription.length > text.length) {
      text = meta.ogDescription;
    }
  }

  if (!caption && !html) return null;
  return { platform: 'tiktok', text, title, author, siteName, html, videoUrl: html ? extractMeta(html).ogVideo : null, imageUrl: html ? extractMeta(html).ogImage : null, truncated: false };
}

// Pull "shortDescription":"..." out of the embedded ytInitialPlayerResponse JSON.
function extractYouTubeDescription(html: string): string | null {
  const m = /"shortDescription"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(html);
  if (!m) return null;
  try {
    const decoded: unknown = JSON.parse('"' + m[1] + '"');
    return typeof decoded === 'string' && decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** Video id from watch?v=, youtu.be/, shorts/ and live/ URL shapes. */
export function youTubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = /^\/(shorts|live|embed)\/([A-Za-z0-9_-]{6,})/.exec(u.pathname);
    return m ? m[2]! : null;
  } catch {
    return null;
  }
}

async function fetchYouTube(url: string, apiKey?: string): Promise<FetchedContent | null> {
  const oembed = await fetchJson(
    'https://www.youtube.com/oembed?url=' + encodeURIComponent(url) + '&format=json'
  );
  let title = asString(oembed?.['title']);
  let author = asString(oembed?.['author_name']);
  let description = '';
  let imageUrl: string | null = null;

  // The watch page (and Innertube) are bot-walled from datacenter IPs
  // (429 → google.com/sorry, verified 2026-07). The official Data API is the
  // reliable way to the full description — free key, 10k requests/day.
  const videoId = youTubeVideoId(url);
  if (apiKey && videoId) {
    const data = await fetchJson(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`
    );
    const snippet = (data?.['items'] as Array<{ snippet?: Record<string, unknown> }> | undefined)?.[0]?.snippet;
    if (snippet) {
      description = asString(snippet['description']) ?? '';
      title = asString(snippet['title']) ?? title;
      author = asString(snippet['channelTitle']) ?? author;
      const thumbs = snippet['thumbnails'] as Record<string, { url?: string }> | undefined;
      imageUrl = thumbs?.['maxres']?.url ?? thumbs?.['high']?.url ?? null;
    }
  }

  // Try the page anyway — it works from residential IPs (local dev) and, when
  // it answers, may carry more than the API (or fill in for a missing key).
  const page = await fetchPage(url);
  const html = page && page.ok ? page.text : null;
  if (html) {
    if (!description) description = extractYouTubeDescription(html) ?? '';
    const meta = extractMeta(html);
    if (!description && meta.ogDescription) description = meta.ogDescription;
    if (!title) title = meta.ogTitle ?? meta.title;
    if (!author) author = meta.author;
    if (!imageUrl) imageUrl = meta.ogImage;
  }

  if (!title && !description) return null;
  const text = title && description ? title + '\n\n' + description : (title ?? description);
  return { platform: 'youtube', text, title, author, siteName: 'YouTube', html, videoUrl: html ? extractMeta(html).ogVideo : null, imageUrl, truncated: false };
}

async function fetchInstagramOrFacebook(
  url: string,
  platform: 'instagram' | 'facebook'
): Promise<FetchedContent | null> {
  const page = await fetchPage(url);
  if (!page || !page.ok) return null;
  const html = page.text;
  const meta = extractMeta(html);

  const rawDescription = meta.ogDescription ?? '';
  const fromDescription = unwrapInstagramDescription(rawDescription);
  // FB's og:title usually carries ~4x more of the caption than og:description.
  // Both wrappers are platform-specific and mutually exclusive, so applying
  // the pair is safe regardless of which platform this post came from.
  const fromTitle = meta.ogTitle ? stripInstagramTitlePrefix(stripFacebookTitleSuffix(meta.ogTitle)) : '';
  const caption = fromTitle.length > fromDescription.length ? fromTitle : fromDescription;
  // og:description ending in an ellipsis is FB's own truncation marker; a
  // title-sourced caption that ends mid-word (no closing punctuation) is the
  // same thing happening to og:title.
  const truncated =
    looksTruncated(rawDescription) &&
    (caption === fromDescription || !/[.!?)»”"]\s*$/.test(caption));

  // Too short usually means a login wall or an empty caption — but if the page
  // still publishes its og:video, return what we have so the caller can try
  // transcription instead of giving up.
  if (caption.length < 40 && !meta.ogVideo && !meta.ogImage) return null;

  const fallbackSite = platform === 'instagram' ? 'Instagram' : 'Facebook';
  return {
    platform,
    text: caption,
    title: meta.ogTitle ?? meta.title,
    author: meta.author,
    siteName: meta.siteName ?? fallbackSite,
    html,
    videoUrl: meta.ogVideo,
    imageUrl: meta.ogImage,
    truncated,
  };
}

async function fetchPinterest(url: string): Promise<FetchedContent | null> {
  const page = await fetchPage(url);
  if (!page || !page.ok) return null;
  const html = page.text;
  const meta = extractMeta(html);

  let text = meta.ogDescription ?? '';
  if (text.length < 200) {
    const bodyText = htmlToText(html, 8000);
    text = text ? text + '\n\n' + bodyText : bodyText;
  }

  return {
    platform: 'pinterest',
    text,
    title: meta.ogTitle ?? meta.title,
    author: meta.author,
    siteName: meta.siteName ?? 'Pinterest',
    html,
    videoUrl: meta.ogVideo,
    imageUrl: meta.ogImage,
    truncated: false,
  };
}

async function fetchWeb(url: string): Promise<FetchedContent | null> {
  const page = await fetchPage(url);
  if (!page || !page.ok) return null;
  const html = page.text;
  const meta = extractMeta(html);

  return {
    platform: 'web',
    text: htmlToText(html),
    title: meta.title ?? meta.ogTitle,
    author: meta.author,
    siteName: meta.siteName,
    html,
    videoUrl: meta.ogVideo,
    imageUrl: meta.ogImage,
    truncated: false,
  };
}
