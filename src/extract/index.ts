// The extraction pipeline: URL → fetch → structured data (JSON-LD) when the
// site provides it, otherwise caption/description text → LLM structuring.
import type { Env, ExtractResult, Ingredient, Platform, Recipe, Step } from '../types.js';
import { extractJsonLdRecipe } from './jsonld.js';
import { looksTruncated } from './html.js';
import { detectPlatform, fetchContent, fetchImageBytes, fetchVideoBytes, fetchYouTubeTranscript, youTubeVideoId } from './platforms.js';
import { validateUrl } from './url.js';
import { bytesToBase64, llmAvailable, sniffImageType, structureRecipeImage, structureRecipeText, transcribeAudio, transcriptionAvailable } from '../llm.js';
import { detectMinutes, parseIngredientLine } from '../scale.js';
import { newRecipeId, saveRecipe } from '../store.js';
import { searchWeb, titlesPlausiblyMatch } from './search.js';

export { validateUrl };

const MIN_USEFUL_TEXT = 80; // captions shorter than this never contain a real recipe


/** Human name for a platform, for user-facing copy. */
function platformName(p: Recipe['source']['platform']): string {
  switch (p) {
    case 'instagram': return 'Instagram';
    case 'facebook': return 'Facebook';
    case 'tiktok': return 'TikTok';
    case 'youtube': return 'YouTube';
    case 'pinterest': return 'Pinterest';
    default: return 'This site';
  }
}

export async function extractFromUrl(env: Env, input: string): Promise<ExtractResult> {
  const url = validateUrl(input);
  if (!url) {
    return {
      ok: false,
      code: 'invalid_url',
      message: 'That does not look like a valid public link. Paste the full URL of the reel, video, or recipe page.',
    };
  }

  const platform = detectPlatform(url.toString());
  const content = await fetchContent(url.toString(), env);

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

  // Path 1: structured recipe data embedded in the page (most food blogs).
  if (content.html) {
    const jsonld = extractJsonLdRecipe(content.html);
    if (jsonld && jsonld.ingredientLines.length > 0 && jsonld.steps.length > 0) {
      const recipe = assembleRecipe(env, {
        title: jsonld.title || content.title || 'Untitled recipe',
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
  };

  if (text.length >= MIN_USEFUL_TEXT) {
    // A visibly truncated caption may be missing its final steps; when the
    // video is available, transcribe FIRST so the spoken version can fill the
    // gap, and only fall back to the caption alone.
    if (content.truncated) {
      const merged = await transcribeAndStructure(env, content, text, ctx);
      if (merged.result?.ok) return merged.result;
    }
    const captionResult = await structureWithLlm(env, text, ctx);
    if (captionResult.ok) {
      // "More informed" pass: a caption that gave ingredients but no method
      // can be completed by the video's spoken words (YouTube transcript API).
      if (captionResult.recipe.steps.length === 0) {
        const enriched = await youTubeTranscriptAndStructure(env, url.toString(), text, ctx);
        if (enriched.result?.ok && enriched.result.recipe.steps.length > 0) return enriched.result;
      }
      return captionResult;
    }
    // Caption didn't yield a recipe (teaser text, or even a flaky model reply) —
    // listen to the video before giving up.
    const spoken = await transcribeAndStructure(env, content, text, ctx);
    if (spoken.result) return spoken.result;
    const ytSpoken = await youTubeTranscriptAndStructure(env, url.toString(), text, ctx);
    if (ytSpoken.result) return ytSpoken.result;
    if (captionResult.code !== 'no_recipe_found') return captionResult;
    const fromCover = await tryCoverImage(env, content, url.toString());
    if (fromCover) return fromCover;
    // The post names a dish even though it hides the recipe — find a public
    // recipe for the same dish rather than returning empty-handed.
    const dish = captionResult.dishGuess ?? spoken.dish ?? ytSpoken.dish ?? null;
    if (dish) {
      const similar = await findSimilarRecipe(env, dish, url.toString(), PAYWALL_RE.test(text));
      if (similar) return similar;
    }
    return {
      ok: false,
      code: 'no_recipe_found',
      message: noRecipeMessage(platform, text, ytSpoken.audio ?? spoken.audio, false, content.imageUrl !== null, dish),
      fetchedText: text.slice(0, 4000),
      dishGuess: dish ?? undefined,
    };
  }

  // Thin or missing caption: the video may still speak the recipe.
  const spoken = await transcribeAndStructure(env, content, text, ctx);
  if (spoken.result) return spoken.result;
  const ytSpoken = await youTubeTranscriptAndStructure(env, url.toString(), text, ctx);
  if (ytSpoken.result) return ytSpoken.result;
  const fromCover = await tryCoverImage(env, content, url.toString());
  if (fromCover) return fromCover;
  let dish = spoken.dish ?? ytSpoken.dish ?? null;
  if (!dish && content.title && llmAvailable(env)) {
    // Even a bare title usually names the dish ("How French Restaurants
    // Make Tarte Tatin") — one cheap pass to seed the similar-recipe search.
    try {
      const seed = await structureWithLlm(
        env,
        `Video title: "${content.title}". This text is only the video's title — it contains no recipe itself. What dish is the video about?`,
        ctx,
      );
      if (!seed.ok && seed.code === 'no_recipe_found') dish = seed.dishGuess ?? null;
    } catch { /* the seed is best-effort */ }
  }
  if (dish) {
    const similar = await findSimilarRecipe(env, dish, url.toString(), PAYWALL_RE.test(text));
    if (similar) return similar;
  }
  return {
    ok: false,
    code: 'no_recipe_found',
    message: noRecipeMessage(platform, text, ytSpoken.audio ?? spoken.audio, true, content.imageUrl !== null, dish),
    fetchedText: text ? text.slice(0, 4000) : undefined,
    dishGuess: dish ?? undefined,
  };
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
): Promise<ExtractResult | null> {
  const hits = await searchWeb(dish);
  let fetches = 0;
  for (const hit of hits) {
    if (fetches >= 3) break;
    // A titled hit that shares no word with the dish isn't worth a fetch —
    // WordPress search returns its best fuzzy guess for anything.
    if (hit.title && !titlesPlausiblyMatch(dish, hit.title)) continue;
    const candidate = hit.url;
    fetches++;
    try {
      const content = await fetchContent(candidate);
      if (!content?.html) continue;
      const jsonld = extractJsonLdRecipe(content.html);
      if (!jsonld || jsonld.ingredientLines.length === 0 || jsonld.steps.length === 0) continue;
      // Fuzzy site search can return its best wrong guess — demand at least
      // one substantive word in common between dish and found recipe.
      if (jsonld.title && !titlesPlausiblyMatch(dish, jsonld.title)) continue;
      const host = new URL(candidate).hostname.replace(/^www\./, '');
      const recipe = assembleRecipe(env, {
        title: jsonld.title || content.title || dish,
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
            : `The video didn't include its recipe, so this is a similar ${dish} recipe from ${host}.`,
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
    const result = await extractFromImage(env, bytesToBase64(bytes), _url);
    return result.ok ? result : null;
  } catch {
    return null;
  }
}

/** Why the audio path ended without a recipe — used to tell the user the truth. */
type AudioOutcome = 'no-video' | 'unfetchable' | 'no-speech' | 'checked' | 'unsupported';

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
): Promise<{ result: ExtractResult | null; audio: AudioOutcome | null; dish?: string | null }> {
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
    return { result: null, audio: 'checked', dish: result.dishGuess ?? null };
  }
  return { result, audio: 'checked' };
}

/** Captions that say the recipe lives somewhere else the creator controls. */
const PAYWALL_RE =
  /(?:full|complete|whole)\s+recipes?\s+(?:is\s+|are\s+)?(?:on|at|in)\s+(?:my|our|the)\s*(?:web\s?site|site|blog|link)|link\s+in\s+(?:my\s+|our\s+|the\s+)?bio|subscribe\s+to\s+(?:my|our)\s+(?:web\s?site|site|blog|newsletter)|exclusive\s+recipes|(?:free\s+trial|membership|patreon)/i;

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
      ? `This ${name} post has no written description to read.`
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
      `If the recipe is in the comments or shown on screen, screenshot it and use the screenshots option — comments are the one thing ${name} hides from every app.`
    );
  }
  return parts.join(' ');
}

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
): Promise<{ result: ExtractResult | null; audio: AudioOutcome; dish?: string | null }> {
  // Transcription needs either the Workers AI binding or an HTTP Whisper key —
  // without one, say so rather than blaming the platform for withholding video.
  if (!transcriptionAvailable(env)) return { result: null, audio: 'unsupported' };
  if (!content.videoUrl) return { result: null, audio: 'no-video' };
  const media = await fetchVideoBytes(content.videoUrl);
  if (!media) return { result: null, audio: 'unfetchable' };
  const transcript = await transcribeAudio(env, media);
  if (!transcript || transcript.length < MIN_USEFUL_TEXT) return { result: null, audio: 'no-speech' };

  const combined = captionText
    ? `${captionText}\n\nSpoken in the video:\n${transcript}`
    : `Spoken in the video:\n${transcript}`;
  const result = await structureWithLlm(env, combined, { ...ctx, extractedFrom: 'transcript' });
  if (!result.ok && result.code === 'no_recipe_found') {
    // "We listened and there's still no recipe" must NOT end the funnel —
    // the caller still has the cover scan and the similar-recipe search to
    // try. Hand back what we learned (the dish, if named) and keep going.
    return { result: null, audio: 'checked', dish: result.dishGuess ?? null };
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
export async function extractFromImage(env: Env, imageB64: string, sourceUrl?: string): Promise<ExtractResult> {
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
    result = await structureRecipeImage(env, cleaned, mediaType);
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
  extractedFrom: 'caption' | 'paste' | 'transcript';
  /** Honest caveats to carry into the note (e.g. "description was truncated") */
  extraNotes?: string[];
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
    };
  }

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
        ? ['The method isn’t written out anywhere — watch the original video for the steps; the ingredient list above is complete.']
        : []),
      ...result.notes,
      ...(ctx.extraNotes ?? []),
    ],
    extractedFrom: ctx.extractedFrom,
    confidence: text.length > 400 ? 'medium' : 'low',
    createdAt: new Date().toISOString(),
  };
  await saveRecipe(env, recipe);
  return { ok: true, recipe };
}

interface AssembleInput {
  title: string;
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
