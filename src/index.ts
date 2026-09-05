// Reel Recipes — paste/share a reel or recipe link, get a clean, scalable
// recipe note for Apple Notes with tappable timer and shopping-list links.
import { Hono } from 'hono';
import type { DeviceInput, Env, Recipe } from './types.js';
import { extractFromImage, extractFromPaste, extractFromUrl } from './extract/index.js';
import { buildNoteText } from './format/notes.js';
import { renderRecipePage, renderShoppingListPage } from './format/html.js';
import { getRecipe, getRecipeInLang } from './store.js';
import { SUPPORTED_LANGS } from './llm.js';
import { kvGet, kvPut } from './kv.js';

const app = new Hono<{ Bindings: Env }>();

/** Scale factor from ?x= (multiplier) or ?servings= (target portion count). */
function scaleFactor(recipe: Recipe, xParam?: string, servingsParam?: string): number {
  const servings = servingsParam ? Number(servingsParam) : NaN;
  if (Number.isFinite(servings) && servings > 0 && recipe.servings) {
    // A target serving count is exact — clamp only to a sane 1..500 range so
    // "cook for 1" from a 12-serving base isn't silently bumped back up.
    const target = Math.min(500, Math.max(1, servings));
    return target / recipe.servings;
  }
  // A bare multiplier is clamped to a reasonable band.
  const x = xParam ? Number(xParam) : NaN;
  if (Number.isFinite(x) && x > 0) return Math.min(20, Math.max(0.1, x));
  return 1;
}


/** Requested language: ?lang= wins; else the device's Accept-Language; 'orig' disables. */
function pickLang(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }): string | null {
  const q = (c.req.query('lang') ?? '').toLowerCase();
  if (q === 'orig' || q === 'original') return null;
  if (/^[a-z]{2}$/.test(q)) return q;
  const accept = c.req.header('accept-language') ?? '';
  const m = /^\s*([a-z]{2})/i.exec(accept);
  return m ? m[1]!.toLowerCase() : null;
}

// Cloudflare serves the homepage from its assets binding before the Worker
// ever runs, so this route is only reached on hosts (Vercel) that route '/'
// into the function. Fetch the static file from our own origin rather than
// duplicating it in code.
app.get('/', async (c) => {
  try {
    const res = await fetch(new URL('/index.html', c.req.url).toString());
    if (res.ok) {
      return new Response(res.body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
  } catch {
    /* fall through to the diagnostic page */
  }
  return c.html(homeMissingPage(), 500);
});

// --- abuse guard ---------------------------------------------------------
// Extraction is the only expensive route (LLM + transcription per call).
// Free-tier reality check (all measured, not assumed): Cloudflare's ratelimit
// binding silently never limits on workers.dev, the Cache API is a no-op
// there, and per-isolate memory misses most requests because bursts spawn
// fresh isolates. So two honest layers:
//   1. per-IP in-memory window — catches same-isolate bursts only;
//   2. a GLOBAL budget breaker in KV — sampled writes (fits the 1k/day free
//      write quota), estimates total extraction volume per 10-minute window
//      and closes the API when it exceeds what a legitimate crowd could do.
// The real production fix is a custom domain + a WAF rate rule (see README).
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_CALLS = 12; // a human pasting links stays far under this
const rateLog = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const log = (rateLog.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (log.length >= RATE_MAX_CALLS) {
    rateLog.set(ip, log);
    return true;
  }
  log.push(now);
  rateLog.set(ip, log);
  // Cap total memory: drop the oldest entries when the map grows too large.
  if (rateLog.size > 5000) {
    const first = rateLog.keys().next().value;
    if (first !== undefined) rateLog.delete(first);
  }
  return false;
}

const BREAKER_WINDOW_MS = 10 * 60 * 1000;
const BREAKER_SAMPLE_P = 0.2; // 1 KV write per ~5 extractions
const BREAKER_MAX_ESTIMATE = 120; // est. extractions/10min before closing

async function globallyOverloaded(env: Env): Promise<boolean> {
  const bucket = Math.floor(Date.now() / BREAKER_WINDOW_MS);
  const key = `rl:global:${bucket}`;
  try {
    const stored = Number((await kvGet(env, key)) ?? '0') || 0;
    const estimate = stored / BREAKER_SAMPLE_P;
    if (estimate >= BREAKER_MAX_ESTIMATE) return true;
    if (Math.random() < BREAKER_SAMPLE_P) {
      await kvPut(env, key, String(stored + 1), 30 * 60);
    }
    return false;
  } catch {
    // KV failing usually means the write quota is gone — the day's budget is
    // spent, so fail closed rather than run the AI bill uncounted.
    return true;
  }
}

// --- API ---------------------------------------------------------------

interface ExtractBody {
  url?: string;
  text?: string;
  image?: string;
  servings?: number;
  lang?: string;
  // Phone clients (the iOS app) may hand over what they fetched themselves.
  html?: string;
  page?: DeviceInput['page'];
  transcript?: string;
  audio?: string;
  audioType?: string;
  client?: string;
}

const MAX_DEVICE_HTML_CHARS = 1_500_000;
const MAX_DEVICE_AUDIO_B64 = 22_000_000; // ~16MB decoded — an AAC track of even a long video
const MAX_DEVICE_TRANSCRIPT = 20_000;

/**
 * Base64 → bytes without a Node Buffer and without a 3x memory spike: decode
 * in 4-byte-aligned slices straight into one preallocated array.
 */
function base64ToBytes(b64: string): Uint8Array | null {
  const clean = b64.replace(/[\s]/g, '');
  if (clean.length === 0 || clean.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(clean)) return null;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  const SLICE = 1_048_576; // multiple of 4
  let offset = 0;
  try {
    for (let i = 0; i < clean.length; i += SLICE) {
      const bin = atob(clean.slice(i, i + SLICE));
      for (let j = 0; j < bin.length; j++) out[offset + j] = bin.charCodeAt(j);
      offset += bin.length;
    }
  } catch {
    return null;
  }
  return offset === out.length ? out : out.slice(0, offset);
}

/** Validate and shape the phone-gathered fields; undefined when there are none. */
function deviceInput(body: ExtractBody): DeviceInput | undefined {
  const html = typeof body.html === 'string' && body.html.length > 200 ? body.html.slice(0, MAX_DEVICE_HTML_CHARS) : undefined;
  const rawPage = body.page;
  const page =
    rawPage && typeof rawPage === 'object' && typeof rawPage.text === 'string' && rawPage.text.trim().length > 0
      ? {
          text: rawPage.text.slice(0, 40_000),
          title: typeof rawPage.title === 'string' ? rawPage.title : null,
          author: typeof rawPage.author === 'string' ? rawPage.author : null,
          siteName: typeof rawPage.siteName === 'string' ? rawPage.siteName : null,
          videoUrl: typeof rawPage.videoUrl === 'string' ? rawPage.videoUrl : null,
          imageUrl: typeof rawPage.imageUrl === 'string' ? rawPage.imageUrl : null,
          truncated: rawPage.truncated === true,
        }
      : undefined;
  const transcript =
    typeof body.transcript === 'string' && body.transcript.trim().length > 0
      ? body.transcript.slice(0, MAX_DEVICE_TRANSCRIPT)
      : undefined;
  let audio: Uint8Array | undefined;
  if (typeof body.audio === 'string' && body.audio.length > 0 && body.audio.length <= MAX_DEVICE_AUDIO_B64) {
    const decoded = base64ToBytes(body.audio.replace(/^data:[^;]+;base64,/, ''));
    if (decoded && decoded.length > 0) audio = decoded;
  } else if (typeof body.audio === 'string' && body.audio.length > MAX_DEVICE_AUDIO_B64) {
    // Silent drops are how a phone ends up hearing "the platform withheld
    // the video" after it just uploaded the audio — leave a trace.
    console.log(JSON.stringify({ evt: 'device_audio_too_large', chars: body.audio.length }));
  }
  if (!html && !page && !transcript && !audio) return undefined;
  return { html, page, transcript, audio };
}

// Main entry point, used by the web UI, the iOS Shortcut and the iOS app.
// Body: { url?, text?, image?: base64, servings?, lang?,
//         html?, page?, transcript?, audio?: base64 }   (phone-gathered extras)
app.post('/api/extract', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  if (rateLimited(ip)) {
    return c.json(
      { ok: false, code: 'rate_limited', message: 'That’s a lot of recipes at once — give it a minute and try again.' },
      429,
    );
  }
  if (await globallyOverloaded(c.env)) {
    return c.json(
      { ok: false, code: 'rate_limited', message: 'The kitchen is at full capacity right now — please try again in a little while.' },
      429,
    );
  }
  let body: ExtractBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, code: 'invalid_url', message: 'Send a JSON body like {"url": "https://..."}' }, 400);
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const image = typeof body.image === 'string' ? body.image.trim() : '';

  const result = image
    ? await extractFromImage(c.env, image, url || undefined)
    : text
      ? await extractFromPaste(c.env, text, url || undefined)
      : url
        ? await extractFromUrl(c.env, url, deviceInput(body), { ray: c.req.header('cf-ray') ?? undefined })
        : null;

  if (!result) {
    return c.json({ ok: false, code: 'invalid_url', message: 'Provide a "url", pasted "text", or an "image".' }, 400);
  }
  if (!result.ok) {
    return c.json(result, 422);
  }

  const recipe = result.recipe;
  const origin = new URL(c.req.url).origin;
  const factor = body.servings && recipe.servings ? scaleFactor(recipe, undefined, String(body.servings)) : 1;
  const bodyLang = typeof (body as { lang?: string }).lang === 'string' ? (body as { lang?: string }).lang!.toLowerCase() : '';
  const lang = /^[a-z]{2}$/.test(bodyLang) ? bodyLang : bodyLang === 'orig' ? null : pickLang(c);
  const localized = await getRecipeInLang(c.env, recipe, lang);
  return c.json({
    ok: true,
    id: recipe.id,
    title: recipe.title,
    servings: recipe.servings,
    confidence: recipe.confidence,
    extractedFrom: recipe.extractedFrom,
    noteText: buildNoteText(localized, origin, factor),
    webUrl: `${origin}/r/${recipe.id}`,
    recipe: localized,
  });
});

// ?lang=xx returns the recipe translated (cached in KV); no ?lang, or
// ?lang=orig, returns it exactly as stored. The iOS app's per-recipe
// language switch lives on this.
app.get('/api/recipe/:id', async (c) => {
  const recipe = await getRecipe(c.env, c.req.param('id'));
  if (!recipe) return c.json({ ok: false, message: 'Recipe not found' }, 404);
  const q = (c.req.query('lang') ?? '').toLowerCase();
  const localized = /^[a-z]{2}$/.test(q) ? await getRecipeInLang(c.env, recipe, q) : recipe;
  return c.json({ ok: true, recipe: localized, language: localized.language ?? recipe.language ?? null });
});

// The languages translateRecipe can produce, for clients that offer a picker.
app.get('/api/languages', (c) => c.json({ ok: true, languages: SUPPORTED_LANGS }));

// Plain-text note (used by the Shortcut when re-scaling: ?servings=6 or ?x=2)
app.get('/api/recipe/:id/note', async (c) => {
  const recipe = await getRecipe(c.env, c.req.param('id'));
  if (!recipe) return c.text('Recipe not found', 404);
  const origin = new URL(c.req.url).origin;
  const factor = scaleFactor(recipe, c.req.query('x'), c.req.query('servings'));
  const localized = await getRecipeInLang(c.env, recipe, pickLang(c));
  return c.text(buildNoteText(localized, origin, factor));
});

// --- Web pages ----------------------------------------------------------

app.get('/r/:id', async (c) => {
  const recipe = await getRecipe(c.env, c.req.param('id'));
  if (!recipe) return c.html(notFoundPage(), 404);
  const origin = new URL(c.req.url).origin;
  const factor = scaleFactor(recipe, c.req.query('x'), c.req.query('servings'));
  const lang = pickLang(c);
  const localized = await getRecipeInLang(c.env, recipe, lang);
  return c.html(renderRecipePage(localized, origin, factor, { originalLanguage: recipe.language ?? null, currentLang: c.req.query('lang') ?? '' }));
});

app.get('/r/:id/list', async (c) => {
  const recipe = await getRecipe(c.env, c.req.param('id'));
  if (!recipe) return c.html(notFoundPage(), 404);
  const origin = new URL(c.req.url).origin;
  const factor = scaleFactor(recipe, c.req.query('x'), c.req.query('servings'));
  const localized = await getRecipeInLang(c.env, recipe, pickLang(c));
  return c.html(renderShoppingListPage(localized, origin, factor, {
    originalLanguage: recipe.language ?? null,
    currentLang: c.req.query('lang') ?? '',
  }));
});

app.notFound((c) => {
  // API clients (the iOS Shortcut) must get a JSON error, not the homepage HTML,
  // so a typo'd path fails loudly instead of confusing "Get Dictionary Value".
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/')) {
    return c.json({ ok: false, message: 'Not found' }, 404);
  }
  // Never redirect '/' to itself. The homepage is a static asset on every host;
  // if a request for it reaches the app, static serving is misconfigured and
  // redirecting would spin forever rather than surface the problem.
  if (path === '/') {
    return c.html(homeMissingPage(), 500);
  }
  return c.redirect('/');
});

// Any unhandled exception still returns JSON on API routes (never an empty/HTML
// body), so the Shortcut and web UI can always parse a response.
app.onError((err, c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/')) {
    return c.json({ ok: false, code: 'server_error', message: 'Something went wrong extracting that recipe. Please try again.' }, 500);
  }
  return c.html(notFoundPage(), 500);
});

/** Shown only when the homepage asset isn't being served by the host. */
function homeMissingPage(): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reel Recipes</title>
<body style="font-family:-apple-system,sans-serif;text-align:center;padding:4rem 1rem">
<h1>Almost there</h1><p>The app is running, but its homepage file isn't being served.
Check that <code>public/</code> is deployed as static assets.</p>
<p><a href="/shortcut">iPhone Shortcut setup</a></p></body>`;
}

function notFoundPage(): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recipe not found</title>
<body style="font-family:-apple-system,sans-serif;text-align:center;padding:4rem 1rem">
<h1>Recipe not found</h1><p>This recipe may have expired. <a href="/">Extract it again</a>.</p></body>`;
}

export default app;
