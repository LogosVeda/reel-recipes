// Platform detection and network adapters. Runs on Cloudflare Workers (fetch only).

import type { FetchedContent, Platform } from '../types.js';
import { bestSocialCaption, extractMeta, htmlToText, isPlatformShell, isShellText, looksTruncated } from './html.js';
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
  if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com')) {
    return 'twitter';
  }
  return 'web';
}

/** HTML a phone client already fetched, standing in for our own request. */
export interface Prefetched {
  html?: string;
  page?: {
    text: string;
    title?: string | null;
    author?: string | null;
    siteName?: string | null;
    videoUrl?: string | null;
    imageUrl?: string | null;
    truncated?: boolean;
  };
}

/** The page: the client's copy when it sent one, otherwise our own fetch. */
async function pageFor(url: string, pre?: Prefetched): Promise<FetchedPage | null> {
  if (pre?.html && pre.html.length > 0) return { ok: true, status: 200, text: pre.html };
  return fetchPage(url);
}

/**
 * A non-browser signature. Facebook answers it with its crawler-facing page:
 * the same og caption (often a little more of it) but no og:video — so it is
 * the second look, never the first. Measured 2026-09 from Cloudflare's IPs.
 */
const PLAIN_USER_AGENT = 'ReelRecipes/1.0 (+https://github.com/LogosVeda/reel-recipes)';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

async function fetchPage(url: string, opts: { userAgent?: string } = {}): Promise<FetchedPage | null> {
  // Follow redirects manually so each hop is re-validated — a vetted public URL
  // must not be able to bounce us to localhost / a metadata endpoint / odd port.
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!validateUrl(current)) return null;
      const res = await fetch(current, {
        headers: { 'User-Agent': opts.userAgent ?? USER_AGENT, 'Accept-Language': 'en' },
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

export async function fetchContent(
  url: string,
  env?: { YOUTUBE_API_KEY?: string },
  pre?: Prefetched,
): Promise<FetchedContent | null> {
  const platform = detectPlatform(url);
  let content: FetchedContent | null;
  switch (platform) {
    case 'tiktok':
      content = await fetchTikTok(url, pre);
      break;
    case 'youtube':
      content = await fetchYouTube(url, env?.YOUTUBE_API_KEY, pre);
      break;
    case 'instagram':
      content = await fetchInstagramOrFacebook(url, 'instagram', pre);
      break;
    case 'facebook':
      content = await fetchInstagramOrFacebook(url, 'facebook', pre);
      break;
    case 'pinterest':
      content = await fetchPinterest(url, pre);
      break;
    case 'twitter':
      content = await fetchTwitter(url);
      break;
    default:
      content = await fetchWeb(url, pre);
  }
  // Whatever the phone parsed itself fills the gaps in (or replaces) what
  // the adapter found — a phone's YouTube description beats a bare title.
  const page = pre?.page;
  // A phone's logged-out session is served login walls too; their boilerplate
  // ("Log into Facebook to start sharing…") must never stand in for a caption.
  if (page && typeof page.text === 'string' && !isShellText(page.text)) {
    if (!content) {
      content = {
        platform,
        text: page.text,
        title: page.title ?? null,
        author: page.author ?? null,
        siteName: page.siteName ?? null,
        html: pre?.html ?? null,
        videoUrl: page.videoUrl ?? null,
        imageUrl: page.imageUrl ?? null,
        truncated: page.truncated === true,
      };
    } else {
      if (page.text.length > content.text.length) content.text = page.text;
      content.title = content.title ?? page.title ?? null;
      content.author = content.author ?? page.author ?? null;
      content.siteName = content.siteName ?? page.siteName ?? null;
      content.videoUrl = content.videoUrl ?? page.videoUrl ?? null;
      content.imageUrl = content.imageUrl ?? page.imageUrl ?? null;
    }
  }
  return content;
}

/**
 * Whisper only needs the audio, so the lightest MP4 rendition is the right
 * one to download — a 4K vertical video blows past our size cap while its
 * 320px sibling is a few MB. FixTweet lists renditions under `variants`.
 */
function smallestMp4(video: Record<string, unknown> | undefined): string | null {
  if (!video) return null;
  const variants = (video['variants'] as Array<Record<string, unknown>> | undefined) ?? [];
  let best: { url: string; bitrate: number } | null = null;
  for (const v of variants) {
    const url = asString(v['url']);
    const type = asString(v['content_type']) ?? '';
    const bitrate = Number(v['bitrate']);
    if (!url || !type.includes('mp4') || !Number.isFinite(bitrate) || bitrate <= 0) continue;
    if (!best || bitrate < best.bitrate) best = { url, bitrate };
  }
  return best?.url ?? asString(video['url']);
}

/** Status id from x.com/twitter.com/<user>/status/<id> (and /i/status/<id>). */
export function tweetId(url: string): string | null {
  try {
    const m = /\/status(?:es)?\/(\d{5,25})/.exec(new URL(url).pathname);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/**
 * X publishes nothing to logged-out fetches, but two long-running open-source
 * services (FixTweet and vxTwitter) expose a post's text, author and media as
 * plain JSON. Try FixTweet first, vxTwitter as the fallback.
 */
async function fetchTwitter(url: string): Promise<FetchedContent | null> {
  const id = tweetId(url);
  if (!id) return null;

  const fx = await fetchJson(`https://api.fxtwitter.com/status/${id}`);
  const tweet = fx?.['tweet'] as Record<string, unknown> | undefined;
  if (tweet && typeof tweet['text'] === 'string') {
    const author = tweet['author'] as Record<string, unknown> | undefined;
    const media = tweet['media'] as Record<string, unknown> | undefined;
    const videos = (media?.['videos'] as Array<Record<string, unknown>> | undefined) ?? [];
    const photos = (media?.['photos'] as Array<Record<string, unknown>> | undefined) ?? [];
    const name = asString(author?.['name']);
    const handle = asString(author?.['screen_name']);
    return {
      platform: 'twitter',
      text: tweet['text'] as string,
      title: null,
      author: name ? (handle ? `${name} (@${handle})` : name) : handle ? `@${handle}` : null,
      siteName: 'X',
      html: null,
      videoUrl: smallestMp4(videos[0]),
      imageUrl: asString(videos[0]?.['thumbnail_url']) ?? asString(photos[0]?.['url']),
      truncated: false,
    };
  }

  const vx = await fetchJson(`https://api.vxtwitter.com/i/status/${id}`);
  if (vx && typeof vx['text'] === 'string') {
    const media = (vx['media_extended'] as Array<Record<string, unknown>> | undefined) ?? [];
    const video = media.find((m) => m['type'] === 'video' || m['type'] === 'gif');
    const image = media.find((m) => m['type'] === 'image');
    const name = asString(vx['user_name']);
    const handle = asString(vx['user_screen_name']);
    return {
      platform: 'twitter',
      text: vx['text'] as string,
      title: null,
      author: name ? (handle ? `${name} (@${handle})` : name) : handle ? `@${handle}` : null,
      siteName: 'X',
      html: null,
      videoUrl: asString(video?.['url']),
      imageUrl: asString(video?.['thumbnail_url']) ?? asString(image?.['url']),
      truncated: false,
    };
  }
  return null;
}

async function fetchTikTok(url: string, pre?: Prefetched): Promise<FetchedContent | null> {
  const oembed = await fetchJson(
    'https://www.tiktok.com/oembed?url=' + encodeURIComponent(url)
  );
  const caption = asString(oembed?.['title']);
  const oembedAuthor = asString(oembed?.['author_name']);

  const page = await pageFor(url, pre);
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

async function fetchYouTube(url: string, apiKey?: string, pre?: Prefetched): Promise<FetchedContent | null> {
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
  const page = await pageFor(url, pre);
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

/** One look at a Facebook/Instagram page, reduced to what the pipeline needs. */
interface SocialLook {
  html: string;
  caption: string;
  shell: boolean;
  videoUrl: string | null;
  imageUrl: string | null;
  ogDescription: string;
  title: string | null;
  author: string | null;
  siteName: string | null;
}

function lookAt(html: string): SocialLook {
  const meta = extractMeta(html);
  return {
    html,
    caption: bestSocialCaption(meta),
    shell: isPlatformShell(meta),
    videoUrl: meta.ogVideo,
    imageUrl: meta.ogImage,
    ogDescription: meta.ogDescription ?? '',
    title: meta.ogTitle ?? meta.title,
    author: meta.author,
    siteName: meta.siteName,
  };
}

/** A caption shorter than this is a teaser or a truncation — worth a second look. */
const THIN_SOCIAL_CAPTION = 200;

/**
 * Facebook and Instagram serve several variants of a post page, and not all
 * of them carry everything: the browser-facing one has og:video but has been
 * seen without a caption; the crawler-facing one has the caption but no
 * video; login walls have neither. One fetch is therefore not enough to say
 * "the caption isn't written". Take up to three looks and merge them — the
 * longest caption, the first video, the first image — so a single thin or
 * generic response can never be mistaken for the post itself.
 */
async function fetchInstagramOrFacebook(
  url: string,
  platform: 'instagram' | 'facebook',
  pre?: Prefetched,
): Promise<FetchedContent | null> {
  const looks: SocialLook[] = [];
  const first = await pageFor(url, pre);
  if (first?.ok) looks.push(lookAt(first.text));

  const merged = () => ({
    caption: looks.reduce((best, l) => (l.caption.length > best.length ? l.caption : best), ''),
    videoUrl: looks.find((l) => l.videoUrl)?.videoUrl ?? null,
    imageUrl: looks.find((l) => l.imageUrl)?.imageUrl ?? null,
    shell: looks.length === 0 || looks.every((l) => l.shell),
  });

  // Second look: the crawler-facing variant, whenever the first one came
  // back thin, generic, or not at all.
  let state = merged();
  if (state.shell || state.caption.length < THIN_SOCIAL_CAPTION) {
    const second = await fetchPage(url, { userAgent: PLAIN_USER_AGENT });
    if (second?.ok) looks.push(lookAt(second.text));
    state = merged();
  }
  // Third look: the browser variant once more after a beat — a transient
  // shell (rate-limit, checkpoint) usually clears on the next request.
  if (state.shell || (state.caption.length < 40 && !state.videoUrl && !state.imageUrl)) {
    await sleep(700);
    const third = await fetchPage(url);
    if (third?.ok) looks.push(lookAt(third.text));
    state = merged();
  }

  if (looks.length === 0) return null;
  // Too short usually means a login wall or an empty caption — but if the page
  // still publishes its og:video, return what we have so the caller can try
  // transcription instead of giving up.
  if (state.shell && !state.videoUrl && !state.imageUrl) return null;
  if (state.caption.length < 40 && !state.videoUrl && !state.imageUrl) return null;

  const best = looks.reduce((a, l) => (l.caption.length > a.caption.length ? l : a), looks[0]!);
  const caption = state.caption;
  // og:description ending in an ellipsis is the platform's own truncation
  // marker; a caption that ends mid-word (no closing punctuation) is the same
  // thing happening to the longer carrier.
  const truncated =
    looksTruncated(best.ogDescription) &&
    (caption.length <= best.ogDescription.length || !/[.!?)»”"]\s*$/.test(caption));

  const fallbackSite = platform === 'instagram' ? 'Instagram' : 'Facebook';
  return {
    platform,
    text: caption,
    title: best.title,
    author: best.author,
    siteName: best.siteName ?? fallbackSite,
    html: best.html,
    videoUrl: state.videoUrl,
    imageUrl: state.imageUrl,
    truncated,
  };
}

async function fetchPinterest(url: string, pre?: Prefetched): Promise<FetchedContent | null> {
  const page = await pageFor(url, pre);
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

async function fetchWeb(url: string, pre?: Prefetched): Promise<FetchedContent | null> {
  const page = await pageFor(url, pre);
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
