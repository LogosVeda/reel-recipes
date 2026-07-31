// Reel Recipes — paste/share a reel or recipe link, get a clean, scalable
// recipe note for Apple Notes with tappable timer and shopping-list links.
import { Hono } from 'hono';
import type { Env, Recipe } from './types.js';
import { extractFromImage, extractFromPaste, extractFromUrl } from './extract/index.js';
import { buildNoteText } from './format/notes.js';
import { renderRecipePage, renderShoppingListPage } from './format/html.js';
import { getRecipe, getRecipeInLang } from './store.js';
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

// Main entry point, used by both the web UI and the iOS Shortcut.
// Body: { url?: string, text?: string, image?: base64 string, servings?: number }
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
  let body: { url?: string; text?: string; image?: string; servings?: number };
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
        ? await extractFromUrl(c.env, url)
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

app.get('/api/recipe/:id', async (c) => {
  const recipe = await getRecipe(c.env, c.req.param('id'));
  if (!recipe) return c.json({ ok: false, message: 'Recipe not found' }, 404);
  return c.json({ ok: true, recipe });
});

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
  return c.html(renderShoppingListPage(localized, origin, factor));
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
