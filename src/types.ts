// Core data contract for Reel Recipes. Every module builds against these types.

export type Platform =
  | 'instagram'
  | 'facebook'
  | 'tiktok'
  | 'pinterest'
  | 'youtube'
  | 'web';

export type ExtractionMethod = 'jsonld' | 'caption' | 'paste' | 'image' | 'transcript';

export interface Ingredient {
  /** Original line as written, e.g. "1 1/2 cups all-purpose flour, sifted" */
  raw: string;
  /** Parsed numeric quantity (1.5 for "1 1/2"); null when unquantified ("salt to taste") */
  qty: number | null;
  /** For ranges like "2-3 tbsp": the upper bound; null otherwise */
  qtyHigh: number | null;
  /** Normalized unit ("cup", "tbsp", "g") or null for unitless counts ("2 eggs") */
  unit: string | null;
  /** The food item itself, e.g. "all-purpose flour" */
  item: string;
  /** Trailing note, e.g. "sifted", "room temperature" */
  note: string | null;
  /** Section header when the recipe groups ingredients ("For the sauce") */
  group: string | null;
}

export interface Step {
  text: string;
  /** Duration in minutes when the step mentions one (used to render a timer link) */
  minutes: number | null;
  group: string | null;
}

export interface RecipeSource {
  url: string;
  platform: Platform;
  author: string | null;
  /** Site or account name, e.g. "AllRecipes", "@pastaqueen" */
  siteName: string | null;
}

export interface Recipe {
  id: string;
  title: string;
  /** ISO 639-1 code of the language the recipe text is in; null when unknown */
  language?: string | null;
  description: string | null;
  source: RecipeSource;
  /** Base number of servings the quantities refer to; null if unknown */
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  ingredients: Ingredient[];
  steps: Step[];
  notes: string[];
  extractedFrom: ExtractionMethod;
  /** high = structured data; medium = LLM on a full caption; low = LLM on thin text */
  confidence: 'high' | 'medium' | 'low';
  createdAt: string; // ISO timestamp
}

/** What platform adapters return before LLM structuring. */
export interface FetchedContent {
  platform: Platform;
  /** Cleaned-up text most likely to contain the recipe (caption, description, article body) */
  text: string;
  title: string | null;
  author: string | null;
  siteName: string | null;
  /** Raw HTML when available, so the JSON-LD extractor can run on it */
  html: string | null;
  /** Direct video URL the page itself publishes (og:video), for transcription fallback */
  videoUrl: string | null;
  /** Cover image URL (og:image) — last-resort vision input when caption and audio fail */
  imageUrl: string | null;
  /** True when the platform visibly cut the caption off (ellipsis) — more text exists at the source */
  truncated: boolean;
}

/** Result of the whole extraction pipeline. */
export type ExtractResult =
  | { ok: true; recipe: Recipe }
  | {
      ok: false;
      /** Machine-readable reason the UI/Shortcut can branch on */
      code: 'fetch_blocked' | 'no_recipe_found' | 'llm_unavailable' | 'invalid_url';
      message: string;
      /** Whatever text we did manage to fetch, offered back for the paste-fallback flow */
      fetchedText?: string;
      /** The dish the post is about, when identifiable despite having no recipe */
      dishGuess?: string;
    };

export interface Env {
  // Cloudflare KV. Absent on Vercel, where Upstash Redis is used instead —
  // always go through src/kv.ts rather than touching this directly.
  RECIPES?: KVNamespace;
  // Optional: the Workers AI binding is omitted in local dev (wrangler.dev.jsonc)
  // and on any non-Cloudflare host, so callers must guard before using it.
  AI?: Ai;
  ASSETS?: Fetcher;
  LLM_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  // Vercel (or any host without Cloudflare KV): Upstash Redis REST credentials.
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  // Official YouTube Data API v3 key (free) — the only reliable way to full
  // video descriptions from a datacenter IP; YouTube bot-walls everything else.
  YOUTUBE_API_KEY?: string;
  // Speech-to-text for hosts without the Workers AI binding. Any
  // OpenAI-compatible /audio/transcriptions endpoint (Groq, OpenAI).
  WHISPER_API_KEY?: string;
  WHISPER_API_URL?: string;
  WHISPER_MODEL?: string;
}
