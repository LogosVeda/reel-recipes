// The extraction pipeline: URL → fetch → structured data (JSON-LD) when the
// site provides it, otherwise caption/description text → LLM structuring.
import type { AudioOutcome, DeviceInput, Env, ExtractResult, FetchedContent, Ingredient, Platform, Recipe, Step } from '../types.js';
import { extractJsonLdRecipe } from './jsonld.js';
import { looksTruncated } from './html.js';
import { detectPlatform, fetchContent, fetchImageBytes, fetchVideoBytes, fetchYouTubeTranscript, youTubeVideoId } from './platforms.js';
import { validateUrl } from './url.js';
import { bytesToBase64, dishNameInEnglish, llmAvailable, looksLikeRecipeText, readImageText, sniffImageType, structureRecipeImage, structureRecipeText, transcribeAudio, transcriptionAvailable } from '../llm.js';
import { detectMinutes, parseIngredientLine } from '../scale.js';
import { newRecipeId, saveRecipe } from '../store.js';
import { searchWeb, titlesPlausiblyMatch } from './search.js';

export { validateUrl };

const MIN_USEFUL_TEXT = 80; // captions shorter than this never contain a real recipe

/**
 * The page's declared language (<html lang="en-US"> → "en"). Structured-data
 * recipes carry no language of their own, and without one every localized
 * request (a browser's Accept-Language) triggers a needless LLM translation,
 * even English to English.
 */
export function htmlLang(html: string | null): string | null {
  if (!html) return null;
  const m = /<html[^>]*\slang\s*=\s*["']?([A-Za-z]{2})(?:[-_][A-Za-z]+)?["'\s>]/i.exec(html.slice(0, 4000));
  return m ? m[1]!.toLowerCase() : null;
}


/** Human name for a platform, for user-facing copy. */
function platformName(p: Recipe['source']['platform']): string {
  switch (p) {
    case 'instagram': return 'Instagram';
    case 'facebook': return 'Facebook';
    case 'tiktok': return 'TikTok';
    case 'youtube': return 'YouTube';
    case 'pinterest': return 'Pinterest';
    case 'twitter': return 'X';
    default: return 'This site';
  }
}

/** Per-request limits shared by every step of one extraction. */
export interface ExtractOptions {
  /** How many description links deep this extraction already is (0 = the user's own link). */
  depth?: number;
  /** Model calls spent so far by this request — one request must never fan out into an unbounded bill. */
  budget?: { calls: number };
  /** Cloudflare ray id, echoed in logs and failures so a report can be matched to its log line. */
  ray?: string;
}
const MAX_MODEL_CALLS_PER_REQUEST = 8;
const MAX_LINK_DEPTH = 1;

export async function extractFromUrl(env: Env, input: string, device?: DeviceInput, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const url = validateUrl(input);
  if (!url) {
    return {
      ok: false,
      code: 'invalid_url',
      message: 'That does not look like a valid public link. Paste the full URL of the reel, video, or recipe page.',
    };
  }

  const platform = detectPlatform(url.toString());
  const started = Date.now();
  const content = await fetchContent(
    url.toString(),
    env,
    device && (device.html || device.page) ? { html: device.html, page: device.page } : undefined,
  );
  const settings: Required<Pick<ExtractOptions, 'depth' | 'budget'>> & ExtractOptions = {
    ...opts,
    depth: opts.depth ?? 0,
    budget: opts.budget ?? { calls: 0 },
  };
  let result = await extractWithContent(env, url, platform, content, device, settings);
  if (!result.ok && settings.ray) result = { ...result, requestId: settings.ray };
  // One structured line per extraction, so a failure can be reconstructed
  // from Workers Logs after the fact (what was fetched, what each step found)
  // instead of guessed at from the user's screenshot. Only public,
  // server-fetched text gets a head — never what a phone or a paste sent.
  try {
    console.log(
      JSON.stringify({
        evt: 'extract',
        ray: settings.ray ?? null,
        depth: settings.depth,
        modelCalls: settings.budget.calls,
        platform,
        host: url.hostname,
        ms: Date.now() - started,
        fetched: content
          ? { chars: content.text.length, video: Boolean(content.videoUrl), image: Boolean(content.imageUrl), truncated: content.truncated, head: device ? undefined : content.text.slice(0, 120) }
          : null,
        device: device ? { html: Boolean(device.html), page: Boolean(device.page), transcript: Boolean(device.transcript), audio: Boolean(device.audio) } : null,
        ok: result.ok,
        ...(result.ok
          ? { from: result.recipe.extractedFrom, ingredients: result.recipe.ingredients.length, steps: result.recipe.steps.length }
          : { code: result.code, audio: result.audio ?? null, dish: result.dishGuess ?? null, message: result.message.slice(0, 160) }),
      }),
    );
  } catch {
    /* logging must never affect the response */
  }
  return result;
}

async function extractWithContent(
  env: Env,
  url: URL,
  platform: Platform,
  content: FetchedContent | null,
  device: DeviceInput | undefined,
  settings: Required<Pick<ExtractOptions, 'depth' | 'budget'>>,
): Promise<ExtractResult> {

  if (!content) {
    return {
      ok: false,
      code: 'fetch_blocked',
      message:
        platform === 'instagram' || platform === 'facebook'
          ? `${platformName(platform)} blocked automatic reading of this post (it may be private or age-restricted). Screenshot the recipe and use the Photos option instead.`
          : 'This site could not be read automatically. Screenshot the recipe and use the Photos option, or paste the text.',
    };
  }

  return extractFromContent(env, url, platform, content, device, settings);
}

/** The pipeline after the page is in hand — the same whether we fetched it or a phone did. */
async function extractFromContent(
  env: Env,
  url: URL,
  platform: Platform,
  content: FetchedContent,
  device: DeviceInput | undefined,
  settings: Required<Pick<ExtractOptions, 'depth' | 'budget'>>,
): Promise<ExtractResult> {
  // Path 1: structured recipe data embedded in the page (most food blogs).
  if (content.html) {
    const jsonld = extractJsonLdRecipe(content.html);
    if (jsonld && jsonld.ingredientLines.length > 0 && jsonld.steps.length > 0) {
      const recipe = assembleRecipe(env, {
        title: jsonld.title || content.title || 'Untitled recipe',
        language: htmlLang(content.html),
        description: jsonld.description,
        servings: jsonld.servings,
        prepMinutes: jsonld.prepMinutes,
        cookMinutes: jsonld.cookMinutes,
        totalMinutes: jsonld.totalMinutes,
        ingredientLines: jsonld.ingredientLines,
        steps: jsonld.steps,
        notes: [],
        url: url.toString(),
        platform,
        author: jsonld.author ?? content.author,
        siteName: jsonld.siteName ?? content.siteName,
        extractedFrom: 'jsonld',
        confidence: 'high',
      });
      await saveRecipe(env, recipe);
      return { ok: true, recipe };
    }
  }

  // Path 2: caption/description/page text → LLM.
  const text = (content.text ?? '').trim();
  const ctx: LlmContext = {
    url: url.toString(),
    platform,
    author: content.author,
    siteName: content.siteName,
    extractedFrom: 'caption',
    // The truncated flag is heuristic (it also drives transcribe-first, where
    // a false positive is harmless). The user-facing warning needs certainty:
    // only show it when the caption visibly ends in Facebook's own ellipsis —
    // captions ending in a signoff ("Happy cooking, Adam x") are complete.
    extraNotes: content.truncated && looksTruncated(text)
      ? [`${platformName(platform)} cut the description short — check the original post in case final steps are missing.`]
      : [],
    depth: settings.depth,
    budget: settings.budget,
  };

  if (text.length >= MIN_USEFUL_TEXT) {
    // A visibly truncated caption may be missing its final steps; when the
    // video is available, transcribe FIRST so the spoken version can fill the
    // gap, and only fall back to the caption alone.
    let spokenAttempt: Awaited<ReturnType<typeof transcribeAndStructure>> | null = null;
    if (content.truncated) {
      spokenAttempt = await transcribeAndStructure(env, content, text, ctx, device);
      if (spokenAttempt.result?.ok) return spokenAttempt.result;
    }
    const captionResult = await structureWithLlm(env, text, ctx);
    if (captionResult.ok) {
      // "More informed" pass: a caption that gave ingredients but no method
      // can be completed by the video's spoken words, or by the written
      // recipe the description links to.
      if (captionResult.recipe.steps.length === 0) {
        if ((device?.transcript || device?.audio) && !spokenAttempt) {
          const heard = await transcribeAndStructure(env, content, text, ctx, device);
          if (heard.result?.ok && heard.result.recipe.steps.length > 0) return heard.result;
        }
        const enriched = await youTubeTranscriptAndStructure(env, url.toString(), text, ctx);
        if (enriched.result?.ok && enriched.result.recipe.steps.length > 0) return enriched.result;
        const linked = await tryDescriptionLinks(env, text, ctx);
        if (linked) return linked;
      }
      return captionResult;
    }
    // Caption didn't yield a recipe (teaser text, or even a flaky model reply) —
    // listen to the video before giving up (once: the truncated-caption
    // pre-pass already did exactly this, so reuse its outcome).
    const spoken = spokenAttempt ?? (await transcribeAndStructure(env, content, text, ctx, device));
    if (spoken.result) return spoken.result;
    const ytSpoken = await youTubeTranscriptAndStructure(env, url.toString(), text, ctx);
    if (ytSpoken.result) return ytSpoken.result;
    if (captionResult.code !== 'no_recipe_found') return captionResult;
    const fromLinks = await tryDescriptionLinks(env, text, ctx);
    if (fromLinks) return fromLinks;
    const fromCover = await tryCoverImage(env, content, url.toString());
    if (fromCover) return fromCover;
    const dish = captionResult.dishGuess ?? spoken.dish ?? ytSpoken.dish ?? null;
    const dishEn = captionResult.dishGuessEn ?? spoken.dishEn ?? ytSpoken.dishEn ?? null;
    // The caption plainly lists quantities and still no model would structure
    // it (every retry included). Substituting a stranger's recipe here would
    // be worse than the failure — hand the text back for a retry or a paste.
    if (looksLikeRecipeText(text)) {
      return {
        ok: false,
        code: 'no_recipe_found',
        message: `The caption looks like it contains the recipe, but it couldn't be read reliably just now. Please try again in a moment — or paste the caption text and it will be written up from that.`,
        fetchedText: text.slice(0, 4000),
        dishGuess: dish ?? undefined,
        audio: ytSpoken.audio ?? spoken.audio,
        captionLooksLikeRecipe: true,
      };
    }
    // The post names a dish even though it hides the recipe — find a public
    // recipe for the same dish rather than returning empty-handed.
    if (dish) {
      const similar = await findSimilarRecipe(env, dish, url.toString(), PAYWALL_RE.test(text), dishEn);
      if (similar) return similar;
    }
    return {
      ok: false,
      code: 'no_recipe_found',
      message: noRecipeMessage(platform, text, ytSpoken.audio ?? spoken.audio, false, content.imageUrl !== null, dish),
      fetchedText: text.slice(0, 4000),
      dishGuess: dish ?? undefined,
      audio: ytSpoken.audio ?? spoken.audio,
    };
  }

  // Thin or missing caption: the video may still speak the recipe.
  const spoken = await transcribeAndStructure(env, content, text, ctx, device);
  if (spoken.result) return spoken.result;
  const ytSpoken = await youTubeTranscriptAndStructure(env, url.toString(), text, ctx);
  if (ytSpoken.result) return ytSpoken.result;
  const fromCover = await tryCoverImage(env, content, url.toString());
  if (fromCover) return fromCover;
  const coverScanned = content.imageUrl !== null;
  let dish = spoken.dish ?? ytSpoken.dish ?? null;
  let dishEn = spoken.dishEn ?? ytSpoken.dishEn ?? null;
  if (!dish && content.title && llmAvailable(env)) {
    // Even a bare title usually names the dish ("How French Restaurants
    // Make Tarte Tatin") — one cheap pass to seed the similar-recipe search.
    try {
      const seed = await structureWithLlm(
        env,
        `Video title: "${content.title}". This text is only the video's title — it contains no recipe itself. What dish is the video about?`,
        ctx,
      );
      if (!seed.ok && seed.code === 'no_recipe_found') {
        dish = seed.dishGuess ?? null;
        dishEn = seed.dishGuessEn ?? null;
      }
    } catch { /* the seed is best-effort */ }
  }
  if (dish) {
    const similar = await findSimilarRecipe(env, dish, url.toString(), PAYWALL_RE.test(text), dishEn);
    if (similar) return similar;
  }
  return {
    ok: false,
    code: 'no_recipe_found',
    message: noRecipeMessage(platform, text, ytSpoken.audio ?? spoken.audio, true, coverScanned, dish),
    fetchedText: text ? text.slice(0, 4000) : undefined,
    dishGuess: dish ?? undefined,
    audio: ytSpoken.audio ?? spoken.audio,
  };
}

/**
 * Creators routinely link the full written recipe from a video description
 * ("full recipe on my blog", "Текстовая версия"). Follow those links and
 * extract from the page — the one path that recovers a real method when the
 * description itself only lists ingredients.
 *
 * Only accepts a result that actually ADDS steps, so a link farm of product
 * and playlist URLs can never replace a good ingredient list with junk.
 */
const LINK_SKIP_HOSTS =
  /(^|\.)(youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch|tiktok\.com|twitter\.com|x\.com|t\.me|telegram\.me|rutube\.ru|vk\.com|patreon\.com|amazon\.[a-z.]+|bit\.ly|goo\.gl|tinyurl\.com|linktr\.ee|paypal\.[a-z.]+)$/i;

/** Words that mark a link as "the recipe lives here", across our languages. */
const RECIPE_LINK_HINT =
  /(recipe|full\s+recipe|written|text\s*version|printable|blog|рецепт|текстова|przepis|receta)/i;

export function recipeLinksFromText(text: string, max = 3): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  const scored: Array<{ url: string; score: number }> = [];
  for (const line of lines) {
    const hinted = RECIPE_LINK_HINT.test(line);
    for (const m of line.matchAll(/https?:\/\/[^\s<>"')]+/g)) {
      let url = m[0].replace(/[.,;:)]+$/, '');
      let host: string;
      try {
        host = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        continue;
      }
      if (LINK_SKIP_HOSTS.test(host)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      scored.push({ url, score: hinted ? 2 : 0 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  for (const s of scored) {
    if (out.length >= max) break;
    out.push(s.url);
  }
  return out;
}

async function tryDescriptionLinks(
  env: Env,
  description: string,
  ctx: LlmContext,
): Promise<ExtractResult | null> {
  // A linked page may itself link onward; one hop is where creators put
  // their written recipe, anything deeper is a link farm.
  if ((ctx.depth ?? 0) >= MAX_LINK_DEPTH) return null;
  for (const link of recipeLinksFromText(description)) {
    try {
      const linked = await extractFromUrl(env, link, undefined, { depth: (ctx.depth ?? 0) + 1, budget: ctx.budget });
      // Only a page that yields an actual method is worth swapping in.
      if (linked.ok && linked.recipe.steps.length > 0) {
        const recipe: Recipe = {
          ...linked.recipe,
          notes: [
            `Steps came from the recipe page the video links to (${new URL(link).hostname.replace(/^www\./, '')}).`,
            ...linked.recipe.notes,
          ],
        };
        await saveRecipe(env, recipe);
        return { ok: true, recipe };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The creator hid the recipe but named the dish — search the public web for
 * the same dish and extract the best structured match. Strictly JSON-LD:
 * only pages with real schema.org/Recipe data qualify, so a "similar recipe"
 * is always a complete, real one. The result is labeled honestly in its
 * notes: where it came from, and that it is NOT the creator's own version.
 */
async function findSimilarRecipe(
  env: Env,
  dish: string,
  originalUrl: string,
  paywalled: boolean,
  dishEn?: string | null,
): Promise<ExtractResult | null> {
  // Search in English when the dish name is not Latin script — "Медовик"
  // finds nothing on Anglo recipe sites, "honey cake" finds plenty.
  const query = dishEn || (await dishNameInEnglish(env, dish)) || dish;
  const hits = await searchWeb(query);
  let fetches = 0;
  for (const hit of hits) {
    if (fetches >= 3) break;
    // A titled hit that shares no word with the dish isn't worth a fetch —
    // WordPress search returns its best fuzzy guess for anything.
    if (hit.title && !titlesPlausiblyMatch(query, hit.title)) continue;
    const candidate = hit.url;
    fetches++;
    try {
      const content = await fetchContent(candidate);
      if (!content?.html) continue;
      const jsonld = extractJsonLdRecipe(content.html);
      if (!jsonld || jsonld.ingredientLines.length === 0 || jsonld.steps.length === 0) continue;
      // Fuzzy site search can return its best wrong guess — demand at least
      // one substantive word in common between dish and found recipe.
      if (jsonld.title && !titlesPlausiblyMatch(query, jsonld.title)) continue;
      const host = new URL(candidate).hostname.replace(/^www\./, '');
      const recipe = assembleRecipe(env, {
        title: jsonld.title || content.title || dish,
        language: htmlLang(content.html),
        description: jsonld.description,
        servings: jsonld.servings,
        prepMinutes: jsonld.prepMinutes,
        cookMinutes: jsonld.cookMinutes,
        totalMinutes: jsonld.totalMinutes,
        ingredientLines: jsonld.ingredientLines,
        steps: jsonld.steps,
        notes: [
          paywalled
            ? `The creator of the video keeps their exact recipe behind a subscription, so this is a similar ${dish} recipe from ${host} — not the creator's own version.`
            : `The video didn't include a written recipe, so this is a similar ${dish} recipe from ${host} — not the creator's own version. If the creator posted theirs in the comments, paste that text to get it instead.`,
          `Original video: ${originalUrl}`,
        ],
        url: candidate,
        platform: 'web',
        author: jsonld.author ?? content.author,
        siteName: jsonld.siteName ?? content.siteName ?? host,
        extractedFrom: 'jsonld',
        confidence: 'medium',
      });
      await saveRecipe(env, recipe);
      return { ok: true, recipe };
    } catch {
      continue; // a broken candidate must never sink the whole request
    }
  }
  return null;
}

/**
 * Last-ditch visual pass: reels always publish a cover frame (og:image), and
 * some creators put the whole recipe on it as on-screen text. Only an actual
 * recipe comes back — every failure stays silent so the caller's error copy
 * (which says the cover was scanned) is the single message the user sees.
 */
async function tryCoverImage(env: Env, content: { imageUrl: string | null }, _url: string): Promise<ExtractResult | null> {
  if (!content.imageUrl || !llmAvailable(env)) return null;
  const bytes = await fetchImageBytes(content.imageUrl);
  if (!bytes) return null;
  try {
    const b64 = bytesToBase64(bytes);
    const mediaType = sniffImageType(b64);
    if (!mediaType) return null;
    // Transcribe first, then structure the TRANSCRIPT as text. Asking a vision
    // model to "extract the recipe" from a photo of a finished cake makes it
    // invent one; requiring readable words on the image is a real gate.
    const seen = await readImageText(env, b64, mediaType);
    if (!seen || seen.length < MIN_USEFUL_TEXT) return null;
    // A thumbnail carrying a real recipe shows quantities; prose alone (a
    // channel name, a title card) must not become ingredients.
    if (!/\d/.test(seen)) return null;
    const result = await structureWithLlm(env, seen, {
      url: _url,
      platform: detectPlatform(_url),
      author: null,
      siteName: null,
      extractedFrom: 'image',
      extraNotes: ['Read from the text shown on the video’s cover image — double-check it against the video.'],
    });
    return result.ok ? result : null;
  } catch {
    return null;
  }
}

/**
 * YouTube's audio is unreachable from servers, but its spoken words are
 * available through the youtube-transcript.io API when a token is configured.
 * Same contract as transcribeAndStructure: result only on success, plus what
 * the attempt learned (audio outcome for honest copy, dish guess if any).
 */
async function youTubeTranscriptAndStructure(
  env: Env,
  sourceUrl: string,
  captionText: string,
  ctx: LlmContext,
): Promise<{ result: ExtractResult | null; audio: AudioOutcome | null; dish?: string | null; dishEn?: string | null }> {
  if (ctx.platform !== 'youtube' || !env.TRANSCRIPT_API_KEY) return { result: null, audio: null };
  const videoId = youTubeVideoId(sourceUrl);
  if (!videoId) return { result: null, audio: null };
  const transcript = await fetchYouTubeTranscript(env.TRANSCRIPT_API_KEY, videoId);
  if (!transcript || transcript.length < MIN_USEFUL_TEXT) return { result: null, audio: 'no-speech' };
  const combined = captionText
    ? `${captionText}\n\nSpoken in the video:\n${transcript}`
    : `Spoken in the video:\n${transcript}`;
  const result = await structureWithLlm(env, combined, { ...ctx, extractedFrom: 'transcript' });
  if (!result.ok && result.code === 'no_recipe_found') {
    return { result: null, audio: 'checked', dish: result.dishGuess ?? null, dishEn: result.dishGuessEn ?? null };
  }
  return { result, audio: 'checked' };
}

/** Captions that say the recipe lives somewhere else the creator controls. */
const PAYWALL_RE =
  /(?:full|complete|whole)\s+recipes?\s+(?:is\s+|are\s+)?(?:on|at|in)\s+(?:my|our|the)\s*(?:web\s?site|site|blog|link)|recipes?\s+(?:is\s+|are\s+)?(?:in|via|through|at)\s+(?:the\s+)?link\s+in\s+(?:my\s+|our\s+|the\s+)?bio|link\s+in\s+(?:my\s+|our\s+|the\s+)?bio\s+for\s+(?:the\s+)?(?:full\s+)?recipes?|subscribe\s+to\s+(?:my|our)\s+(?:web\s?site|site|blog|newsletter)|exclusive\s+recipes|(?:free\s+trial|membership|patreon)/i;

/**
 * Honest failure copy: say exactly what was checked and what wasn't, and when
 * the caption points at the creator's own website, route the user there —
 * recipe sites are the one input that extracts perfectly.
 */
function noRecipeMessage(platform: Platform, caption: string, audio: AudioOutcome, thinCaption: boolean, coverChecked = false, dish: string | null = null): string {
  const name = platformName(platform);
  const parts: string[] = [];
  if (dish) parts.push(`This looks like ${dish}.`);
  parts.push(
    thinCaption
      ? platform === 'youtube'
        ? `YouTube only shared this video's title with us — it blocks apps from reading video descriptions, where the recipe usually lives.`
        : `This ${name} post has no written description to read.`
      : `The caption on this ${name} post is only a teaser — the recipe itself isn't written in it.`
  );
  if (audio === 'unsupported') {
    parts.push(`This deployment can't listen to video audio (no transcription backend is configured), so only the text was checked.`);
  } else if (audio === 'no-video') {
    parts.push(`${name} didn't publish this video's file for apps to read, so the audio couldn't be checked.`);
  } else if (audio === 'unfetchable') {
    parts.push(`${name} refused to hand over the video file just now, so the audio couldn't be checked — trying again sometimes works.`);
  } else if (audio === 'no-speech') {
    parts.push(`The video's audio was checked, but nothing spoken in it spells out the recipe (probably just music).`);
  } else {
    parts.push(`The video was listened to as well, and the recipe isn't spoken out loud either.`);
  }
  if (coverChecked) {
    parts.push('The video’s cover image was scanned too, but the recipe isn’t readable on it.');
  }
  if (!thinCaption && PAYWALL_RE.test(caption)) {
    parts.push(
      dish
        ? `The creator keeps the written recipe behind their newsletter/subscription, and no public ${dish} recipe could be verified just now. If you can open theirs, paste that page’s link here — recipe sites extract perfectly. Otherwise screenshot the recipe wherever you can see it and use the screenshots option.`
        : 'The caption says the full recipe lives on the creator’s own website — if you can open it there, paste that page’s link here instead; recipe sites extract perfectly. Otherwise screenshot the recipe wherever you can see it and use the screenshots option.'
    );
  } else {
    parts.push(
      platform === 'youtube'
        ? `Open the video's description, copy the recipe text and paste it here — or send a screenshot of it. (Setting a free YouTube API key on this deployment removes this step for everyone.)`
        : COMMENTS_HINT_RE.test(caption)
          ? `The caption says the recipe is in the comments — the one thing ${name} hides from every app. Open the post, copy the creator's comment and paste it here; it will be written up from that.`
          : `On ${name} the creator usually posts the full recipe as a comment on the video — the one thing ${name} hides from every app. Open the post, copy the creator's comment and paste it here; it will be written up from that.`
    );
  }
  return parts.join(' ');
}

/**
 * A "recipe" the model assembled from speech alone can be a 15-second clip's
 * worth of words: four unquantified ingredients and "bake it". Presenting
 * that as the recipe is worse than admitting the recipe was not spoken —
 * the written version is usually one comment away. Spoken recipes with no
 * quantities are only trusted when they are substantial (many ingredients
 * AND a real method).
 */
export function isThinSpokenRecipe(recipe: { ingredients: Ingredient[]; steps: Step[] }): boolean {
  const quantified = recipe.ingredients.filter((i) => i.qty !== null).length;
  if (quantified > 0) return false;
  return recipe.ingredients.length < 6 || recipe.steps.length < 4;
}

/** Captions that point at the comments for the recipe ("recipe in comments 👇"). */
export const COMMENTS_HINT_RE =
  /recipe[^.\n]{0,40}(?:\bin\b|below)[^.\n]{0,20}comments?|comments?\s*(?:👇|⬇|below)|(?:see|check)\s+(?:the\s+)?comments|link\s+in\s+(?:the\s+)?comments|przepis[^.\n]{0,30}komentarz|рецепт[^.\n]{0,30}коммент|receta[^.\n]{0,30}comentarios/iu;

/**
 * Path 3: the page published its own og:video — download it, transcribe the
 * audio with Whisper, and structure caption+transcript together. `result` is
 * null when transcription wasn't possible; `audio` records exactly how far
 * the attempt got, so error copy never claims a check that didn't happen.
 */
async function transcribeAndStructure(
  env: Env,
  content: { videoUrl: string | null },
  captionText: string,
  ctx: LlmContext,
  device?: DeviceInput,
): Promise<{ result: ExtractResult | null; audio: AudioOutcome; dish?: string | null; dishEn?: string | null }> {
  let transcript: string | null = null;
  if (device?.transcript && device.transcript.length >= MIN_USEFUL_TEXT) {
    // The phone already has the spoken words (a caption track).
    transcript = device.transcript;
  } else if (device?.audio && device.audio.length > 0) {
    // The phone pulled the audio out of a video only it could reach.
    if (!transcriptionAvailable(env)) return { result: null, audio: 'unsupported' };
    transcript = await transcribeAudio(env, device.audio);
    if (!transcript || transcript.length < MIN_USEFUL_TEXT) return { result: null, audio: 'no-speech' };
  } else {
    // Transcription needs either the Workers AI binding or an HTTP Whisper key —
    // without one, say so rather than blaming the platform for withholding video.
    if (!transcriptionAvailable(env)) return { result: null, audio: 'unsupported' };
    if (!content.videoUrl) return { result: null, audio: 'no-video' };
    const media = await fetchVideoBytes(content.videoUrl);
    if (!media) return { result: null, audio: 'unfetchable' };
    transcript = await transcribeAudio(env, media);
    if (!transcript || transcript.length < MIN_USEFUL_TEXT) return { result: null, audio: 'no-speech' };
  }

  const combined = captionText
    ? `${captionText}\n\nSpoken in the video:\n${transcript}`
    : `Spoken in the video:\n${transcript}`;
  const result = await structureWithLlm(env, combined, { ...ctx, extractedFrom: 'transcript' });
  if (!result.ok && result.code === 'no_recipe_found') {
    // "We listened and there's still no recipe" must NOT end the funnel —
    // the caller still has the cover scan and the similar-recipe search to
    // try. Hand back what we learned (the dish, if named) and keep going.
    return { result: null, audio: 'checked', dish: result.dishGuess ?? null, dishEn: result.dishGuessEn ?? null };
  }
  if (result.ok && isThinSpokenRecipe(result.recipe)) {
    // A few unquantified words from a short clip is not the recipe — keep
    // the dish name and let the funnel look for a written version.
    console.log(JSON.stringify({ evt: 'thin_spoken_recipe', ingredients: result.recipe.ingredients.length, steps: result.recipe.steps.length, title: result.recipe.title.slice(0, 60) }));
    return { result: null, audio: 'checked', dish: result.recipe.title, dishEn: null };
  }
  return { result, audio: 'checked' };
}

/** Fallback flow: the user pasted recipe text themselves. */
export async function extractFromPaste(env: Env, text: string, sourceUrl?: string): Promise<ExtractResult> {
  const trimmed = (text ?? '').trim();
  if (trimmed.length < 40) {
    return {
      ok: false,
      code: 'no_recipe_found',
      message: 'That text is too short to contain a recipe. Paste the full caption or recipe text.',
    };
  }
  const url = sourceUrl ? validateUrl(sourceUrl) : null;
  return structureWithLlm(env, trimmed.slice(0, 40000), {
    url: url?.toString() ?? '',
    platform: url ? detectPlatform(url.toString()) : 'web',
    author: null,
    siteName: null,
    extractedFrom: 'paste',
  });
}

/** Screenshot flow: the user's screenshot (comments, on-screen text, cookbook page) → vision LLM. */
export async function extractFromImage(env: Env, imageB64: string, sourceUrl?: string, source: 'screenshot' | 'cover' = 'screenshot'): Promise<ExtractResult> {
  const cleaned = imageB64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const mediaType = sniffImageType(cleaned);
  if (!mediaType) {
    return {
      ok: false,
      code: 'no_recipe_found',
      message: 'That does not look like a PNG/JPEG/GIF/WebP image. Upload the screenshot itself, not a link to it.',
    };
  }
  // ~8MB binary cap (base64 is ~4/3 of binary size) — plenty for phone screenshots.
  if (cleaned.length > 11_000_000) {
    return {
      ok: false,
      code: 'no_recipe_found',
      message: 'That image is too large (over ~8MB). Screenshot the recipe portion, or let the site shrink it for you by re-uploading.',
    };
  }
  if (!llmAvailable(env)) {
    return {
      ok: false,
      code: 'llm_unavailable',
      message: 'No AI backend is configured to read screenshots. Deploy with Workers AI enabled or set an ANTHROPIC_API_KEY secret.',
    };
  }

  let result;
  try {
    result = await structureRecipeImage(env, cleaned, mediaType, source);
  } catch (err) {
    return {
      ok: false,
      code: 'llm_unavailable',
      message: `Reading the screenshot failed (${err instanceof Error ? err.message : 'unknown error'}). Try again in a moment.`,
    };
  }

  if (!result.isRecipe) {
    return {
      ok: false,
      code: 'no_recipe_found',
      message: 'No recipe was readable in that screenshot. Make sure the ingredients/steps text is visible and not cut off, then try again.',
    };
  }

  const url = sourceUrl ? validateUrl(sourceUrl) : null;
  const recipe: Recipe = {
    id: newRecipeId(),
    title: result.title,
    language: result.language,
    description: result.description,
    source: {
      url: url?.toString() ?? '',
      platform: url ? detectPlatform(url.toString()) : 'web',
      author: null,
      siteName: null,
    },
    servings: result.servings,
    prepMinutes: result.prepMinutes,
    cookMinutes: result.cookMinutes,
    totalMinutes: result.totalMinutes,
    ingredients: result.ingredients,
    steps: result.steps,
    notes: result.notes,
    extractedFrom: 'image',
    confidence: 'medium',
    createdAt: new Date().toISOString(),
  };
  await saveRecipe(env, recipe);
  return { ok: true, recipe };
}

interface LlmContext {
  url: string;
  platform: Recipe['source']['platform'];
  author: string | null;
  siteName: string | null;
  extractedFrom: 'caption' | 'paste' | 'transcript' | 'image';
  /** Honest caveats to carry into the note (e.g. "description was truncated") */
  extraNotes?: string[];
  /** Link-following depth of this extraction (see ExtractOptions). */
  depth?: number;
  /** Model calls spent by the whole request so far (shared object, see ExtractOptions). */
  budget?: { calls: number };
}

async function structureWithLlm(env: Env, text: string, ctx: LlmContext): Promise<ExtractResult> {
  if (!llmAvailable(env)) {
    return {
      ok: false,
      code: 'llm_unavailable',
      message:
        ctx.extractedFrom === 'paste'
          ? 'No AI backend is configured to structure pasted text. Deploy with Workers AI enabled or set an ANTHROPIC_API_KEY secret.'
          : 'This link has no structured recipe data, and no AI backend is configured to read the caption. Deploy with Workers AI enabled or set an ANTHROPIC_API_KEY secret.',
      fetchedText: text.slice(0, 4000),
    };
  }

  // Every path through the funnel (caption, transcript, linked page, cover
  // seed) lands here; the shared counter is what keeps one request's bill
  // bounded no matter how many fallbacks it walks through.
  if (ctx.budget) {
    if (ctx.budget.calls >= MAX_MODEL_CALLS_PER_REQUEST) {
      return {
        ok: false,
        code: 'llm_unavailable',
        message: 'This link needed more analysis steps than one request allows. Try again in a moment, or paste the recipe text.',
        fetchedText: text.slice(0, 4000),
      };
    }
    ctx.budget.calls++;
  }
  let result;
  try {
    result = await structureRecipeText(env, text, ctx.extractedFrom === 'transcript');
  } catch (err) {
    return {
      ok: false,
      code: 'llm_unavailable',
      message: `The AI extraction step failed (${err instanceof Error ? err.message : 'unknown error'}). Try again in a moment.`,
      fetchedText: text.slice(0, 4000),
    };
  }

  if (!result.isRecipe) {
    // Callers on the URL path wrap this with full context (audio outcome,
    // paywall hints) — this copy must only claim what THIS step looked at.
    return {
      ok: false,
      code: 'no_recipe_found',
      message:
        ctx.extractedFrom === 'paste'
          ? "That text doesn't seem to contain a recipe. Paste the whole thing — ingredients with quantities and the steps."
          : `The text on this ${platformName(ctx.platform)} page doesn't contain the recipe itself.`,
      fetchedText: text.slice(0, 4000),
      dishGuess: result.dishGuess ?? undefined,
      dishGuessEn: result.dishGuessEn ?? undefined,
    };
  }

  // A post on a video platform means the method is being demonstrated, even
  // when only ingredients are written down — say that, rather than implying
  // the recipe is incomplete.
  const videoLike =
    ctx.platform === 'youtube' || ctx.platform === 'instagram' ||
    ctx.platform === 'facebook' || ctx.platform === 'tiktok';
  const recipe: Recipe = {
    id: newRecipeId(),
    title: result.title,
    language: result.language,
    description: result.description,
    source: {
      url: ctx.url,
      platform: ctx.platform,
      author: ctx.author,
      siteName: ctx.siteName,
    },
    servings: result.servings,
    prepMinutes: result.prepMinutes,
    cookMinutes: result.cookMinutes,
    totalMinutes: result.totalMinutes,
    ingredients: result.ingredients,
    steps: result.steps,
    notes: [
      ...(result.steps.length === 0
        ? [videoLike
            ? 'The creator demonstrates the method in the video — the post itself lists only ingredients, so follow along there for the steps.'
            : 'Only an ingredient list was published — no method was written anywhere in the post.']
        : []),
      ...result.notes,
      ...(ctx.extraNotes ?? []),
    ],
    extractedFrom: ctx.extractedFrom,
    confidence: text.length > 400 ? 'medium' : 'low',
    createdAt: new Date().toISOString(),
  };
  if (ctx.extractedFrom === 'transcript') {
    const quantified = recipe.ingredients.filter((i) => i.qty !== null).length;
    if (quantified * 2 < recipe.ingredients.length) {
      recipe.confidence = 'low';
      recipe.notes.unshift('Written up from what is said in the video — most amounts were not spoken, so check them against the video or the creator\'s comment.');
    }
  }
  await saveRecipe(env, recipe);
  return { ok: true, recipe };
}

interface AssembleInput {
  title: string;
  language?: string | null;
  description: string | null;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  ingredientLines: string[];
  steps: { text: string; group: string | null }[];
  notes: string[];
  url: string;
  platform: Recipe['source']['platform'];
  author: string | null;
  siteName: string | null;
  extractedFrom: Recipe['extractedFrom'];
  confidence: Recipe['confidence'];
}

function assembleRecipe(_env: Env, input: AssembleInput): Recipe {
  const ingredients: Ingredient[] = input.ingredientLines.map((line) => parseIngredientLine(line));
  const steps: Step[] = input.steps.map((s) => ({
    text: s.text,
    minutes: detectMinutes(s.text),
    group: s.group,
  }));
  return {
    id: newRecipeId(),
    title: input.title,
    language: input.language ?? null,
    description: input.description,
    source: {
      url: input.url,
      platform: input.platform,
      author: input.author,
      siteName: input.siteName,
    },
    servings: input.servings,
    prepMinutes: input.prepMinutes,
    cookMinutes: input.cookMinutes,
    totalMinutes: input.totalMinutes,
    ingredients,
    steps,
    notes: input.notes,
    extractedFrom: input.extractedFrom,
    confidence: input.confidence,
    createdAt: new Date().toISOString(),
  };
}
