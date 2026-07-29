// Reel Recipes — paste/share a reel or recipe link, get a clean, scalable
// recipe note for Apple Notes with tappable timer and shopping-list links.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Recipe } from './types.js';
import { extractFromImage, extractFromPaste, extractFromUrl } from './extract/index.js';
import { buildNoteText } from './format/notes.js';
import { renderRecipePage, renderShoppingListPage } from './format/html.js';
import { getRecipe, getRecipeInLang, saveRecipe } from './store.js';
import { currentUser, endSession, login, publicUser, signup, startSession, type UserRecord } from './auth.js';

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

/**
 * A recipe is viewable when it belongs to the current user. Legacy recipes
 * created before accounts existed (no ownerId) stay public so their existing
 * note links keep working.
 */
function canView(recipe: Recipe, user: UserRecord | null): boolean {
  if (!recipe.ownerId) return true;
  return user != null && recipe.ownerId === user.id;
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

// Serve the auth pages from their static files on hosts (Vercel) that route
// these paths into the function; mirrors the '/' handler above.
async function serveStatic(c: Context, file: string): Promise<Response> {
  try {
    const res = await fetch(new URL(file, c.req.url).toString());
    if (res.ok) {
      return new Response(res.body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
  } catch {
    /* fall through */
  }
  return c.html(homeMissingPage(), 500);
}

app.get('/login', (c) => serveStatic(c, '/login.html'));
app.get('/account', (c) => serveStatic(c, '/account.html'));

// --- Auth ---------------------------------------------------------------

async function readCredentials(c: Context): Promise<{ email: string; password: string } | null> {
  try {
    const body = (await c.req.json()) as { email?: unknown; password?: unknown };
    const email = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) return null;
    return { email, password };
  } catch {
    return null;
  }
}

app.post('/api/auth/signup', async (c) => {
  const creds = await readCredentials(c);
  if (!creds) return c.json({ ok: false, message: 'Send an email and password.' }, 400);
  const result = await signup(c.env, creds.email, creds.password);
  if (!result.ok) return c.json({ ok: false, code: result.code, message: result.message }, 400);
  await startSession(c.env, c, result.user.id);
  return c.json({ ok: true, user: publicUser(result.user) });
});

app.post('/api/auth/login', async (c) => {
  const creds = await readCredentials(c);
  if (!creds) return c.json({ ok: false, message: 'Send an email and password.' }, 400);
  const result = await login(c.env, creds.email, creds.password);
  if (!result.ok) return c.json({ ok: false, code: result.code, message: result.message }, 401);
  await startSession(c.env, c, result.user.id);
  return c.json({ ok: true, user: publicUser(result.user) });
});

app.post('/api/auth/logout', async (c) => {
  await endSession(c.env, c);
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => {
  const user = await currentUser(c.env, c);
  if (!user) return c.json({ ok: false }, 401);
  return c.json({ ok: true, user: publicUser(user) });
});

// --- API ---------------------------------------------------------------

// Main entry point, used by both the web UI and the iOS Shortcut.
// Body: { url?: string, text?: string, image?: base64 string, servings?: number }
app.post('/api/extract', async (c) => {
  // Extraction is account-only: the website (session cookie) or the iOS
  // Shortcut (Authorization: Bearer <personal token>) must identify a user, so
  // every recipe is owned by whoever generated it.
  const user = await currentUser(c.env, c);
  if (!user) {
    return c.json(
      {
        ok: false,
        code: 'unauthorized',
        message: 'Sign in to save recipes. In the Shortcut, add an "Authorization: Bearer <your token>" header — copy your token from the Account page.',
      },
      401,
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
  // The pipeline already persisted the recipe; stamp the owner and re-save so
  // the recipe is private to this account from here on.
  recipe.ownerId = user.id;
  await saveRecipe(c.env, recipe);
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
  const user = await currentUser(c.env, c);
  // Don't leak that a private recipe exists — respond 404 to non-owners.
  if (!canView(recipe, user)) return c.json({ ok: false, message: 'Recipe not found' }, 404);
  return c.json({ ok: true, recipe });
});

// Plain-text note (used by the Shortcut when re-scaling: ?servings=6 or ?x=2)
app.get('/api/recipe/:id/note', async (c) => {
  const recipe = await getRecipe(c.env, c.req.param('id'));
  if (!recipe) return c.text('Recipe not found', 404);
  const user = await currentUser(c.env, c);
  if (!canView(recipe, user)) return c.text('Recipe not found', 404);
  const origin = new URL(c.req.url).origin;
  const factor = scaleFactor(recipe, c.req.query('x'), c.req.query('servings'));
  const localized = await getRecipeInLang(c.env, recipe, pickLang(c));
  return c.text(buildNoteText(localized, origin, factor));
});

// --- Web pages ----------------------------------------------------------

app.get('/r/:id', async (c) => {
  const recipe = await getRecipe(c.env, c.req.param('id'));
  if (!recipe) return c.html(notFoundPage(), 404);
  const user = await currentUser(c.env, c);
  if (!canView(recipe, user)) return gateRecipe(c, user);
  const origin = new URL(c.req.url).origin;
  const factor = scaleFactor(recipe, c.req.query('x'), c.req.query('servings'));
  const lang = pickLang(c);
  const localized = await getRecipeInLang(c.env, recipe, lang);
  return c.html(renderRecipePage(localized, origin, factor, { originalLanguage: recipe.language ?? null, currentLang: c.req.query('lang') ?? '' }));
});

app.get('/r/:id/list', async (c) => {
  const recipe = await getRecipe(c.env, c.req.param('id'));
  if (!recipe) return c.html(notFoundPage(), 404);
  const user = await currentUser(c.env, c);
  if (!canView(recipe, user)) return gateRecipe(c, user);
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

/**
 * A private recipe was requested by the wrong person. Anonymous visitors are
 * sent to sign in (and returned here afterwards); signed-in non-owners get a
 * neutral "not found" so a recipe's existence isn't revealed.
 */
function gateRecipe(c: Context, user: UserRecord | null): Response {
  if (!user) {
    const path = new URL(c.req.url).pathname;
    return c.redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  return c.html(notFoundPage(), 404);
}

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
