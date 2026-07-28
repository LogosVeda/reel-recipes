# 🍳 Reel Recipes

Paste a link to an Instagram/Facebook/TikTok/Pinterest/YouTube reel — or any recipe
website — and get a clean, structured recipe you can drop straight into Apple Notes,
complete with:

- **Tappable timer links** for every timed step (opens a kitchen timer page)
- **Shopping list link** with checkboxes that remember what you've grabbed
- **Portion scaling** — 0.5×–4× or "cook for N people" links baked into the note
- **iOS Share Sheet integration** — share a reel → the recipe lands in Apple Notes
  automatically (via a 2-minute one-time Shortcut setup, see `/shortcut` in the app)

## How extraction works

1. **Recipe websites** — most food blogs embed structured `schema.org/Recipe` data
   (JSON-LD). This is parsed directly: exact, fast, no AI needed.
2. **Social links** — the caption / video description is fetched (oEmbed +
   OpenGraph meta tags) and an LLM turns it into a structured recipe.
3. **Spoken recipes** — when the caption is just a teaser, the app downloads the
   video that the page itself publishes in its `og:video` meta tag, transcribes
   the audio with Whisper (Workers AI), and structures the spoken recipe. Works
   for FB/IG reels, TikTok, Pinterest video pins — any page that exposes og:video.
4. **Nothing written or spoken?** — the app tells you and offers a paste box:
   copy the recipe from the comments and paste it.
5. **Screenshots** — upload/share a screenshot (recipe in the comments, on-screen
   video text, a cookbook page, handwriting) and a vision model reads it.
   Note: nobody can fetch Facebook/Instagram *comments* server-side — they're
   login-walled — so the screenshot path is the designed answer for comment recipes.

The LLM is **Claude (`claude-opus-4-8`)** when an `ANTHROPIC_API_KEY` secret is set,
otherwise it falls back to **Cloudflare Workers AI** (Llama 3.3) which needs no
external account.

## Local development

```sh
npm install
npm run dev          # http://localhost:8787
npm test             # unit tests (parsing, scaling, note formatting)
npm run typecheck
```

Notes for local dev:
- KV runs locally and persists in `.wrangler/state` across dev-server restarts
  (delete that directory to wipe it). Production KV is a separate namespace.
- `npm run dev` uses `wrangler.dev.jsonc`, which deliberately omits the Workers AI
  binding (it needs a Cloudflare login even locally). So:
  - **JSON-LD recipe sites work fully with no AI** (this is most food blogs).
  - **Caption-based extraction** (Instagram/TikTok/etc.) needs an
    `ANTHROPIC_API_KEY` in a `.dev.vars` file:
    ```
    ANTHROPIC_API_KEY=sk-ant-...
    ```
  - To exercise the Workers AI fallback locally instead, run
    `npx wrangler login` and start with the deploy config:
    `npx wrangler dev` (uses `wrangler.jsonc`, which has the `ai` binding).

## Deploy to Cloudflare (free tier works)

1. Create a free account at https://dash.cloudflare.com/sign-up
2. Log in from the terminal:
   ```sh
   npx wrangler login
   ```
3. Create the KV namespace that stores recipes:
   ```sh
   npx wrangler kv namespace create RECIPES
   ```
   Copy the printed `id` into `wrangler.jsonc` (replace `REPLACE_WITH_KV_ID_AFTER_SETUP`).
4. (Optional, better extraction quality) add a Claude API key:
   ```sh
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
5. Deploy:
   ```sh
   npm run deploy
   ```
   You'll get a URL like `https://reel-recipes.<your-subdomain>.workers.dev`.
6. Open `https://<your-app>/shortcut` on your iPhone and follow the 2-minute
   Shortcut setup. After that: **Share → Save Recipe** from any reel.

## Deploy to Vercel

The same app runs on Vercel via `api/index.ts` (Edge runtime). Cloudflare's two
bindings have no Vercel equivalent, so they are replaced by services:

| Cloudflare | Vercel replacement | Needed? |
|---|---|---|
| KV binding (`RECIPES`) | Upstash Redis REST (free tier) | **Required** — recipe links break without it |
| Workers AI binding (`AI`) | `ANTHROPIC_API_KEY` | **Required** — nothing can be extracted without an AI backend |

1. Push this repo to GitHub, then in Vercel: **Add New → Project → Import**.
   Framework preset: **Other**. No build command is needed.
2. Create a free Redis database at https://console.upstash.com and copy its
   **REST URL** and **REST token**.
3. In Vercel → Settings → Environment Variables, add the values from
   [.env.example](.env.example): `UPSTASH_REDIS_REST_URL`,
   `UPSTASH_REDIS_REST_TOKEN`, `ANTHROPIC_API_KEY`.
4. Deploy. Update the API URL inside `public/shortcut.html` and rebuild the
   iOS shortcut if you want the Share Sheet to point at the Vercel domain.

**What changes on Vercel:** spoken-recipe transcription is Cloudflare-only —
Whisper runs on the Workers AI binding, and Anthropic has no audio model. The
app degrades honestly (it says audio couldn't be checked rather than blaming
the platform). Caption, website, screenshot, cover-image and translation
extraction all work identically. Claude vision is used for screenshots.

## API

| Route | What it does |
|---|---|
| `POST /api/extract` `{url}`, `{text, url?}`, or `{image: <base64>, url?}`, optional `servings` | Extract → `{ok, id, noteText, webUrl, recipe}` or `{ok:false, code, message, fetchedText?}` |
| `GET /api/recipe/:id` | The stored recipe as JSON (`{ok, recipe}`) |
| `GET /api/recipe/:id/note?x=2` or `?servings=6` | Plain-text Apple Note, scaled |
| `GET /r/:id?x=2` | Recipe web page (checklists, timers, scaling) |
| `GET /r/:id/list?x=2` | Shopping list page |
| `GET /t?m=10&l=Step%203` | Kitchen timer |

Error codes from `/api/extract`: `invalid_url`, `fetch_blocked` (site refused the
fetch — paste the caption instead), `no_recipe_found` (no recipe in the text),
`llm_unavailable` (no AI backend configured).

## Known limitations

- **Transcription needs the page to publish og:video.** Most public FB/IG reels
  do; private/age-gated posts don't. Videos over ~25MB are skipped. Spoken
  recipes inherit whatever vagueness the creator spoke ("a splash of cream").
- **Instagram/Facebook are hostile to server-side reading.** Captions usually come
  through via OpenGraph tags, but Meta sometimes serves a login wall; the app
  detects this and falls back to paste mode.
- **No rate limiting yet** — if you share the URL publicly, consider adding
  Cloudflare's rate-limiting rules in the dashboard (free tier includes it).
