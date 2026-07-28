// KV persistence for extracted recipes. Recipes are stored by short id so the
// links baked into an Apple Note (/r/:id, shopping list, timers, scale links)
// keep working after the note is saved.
import type { Env, Recipe } from './types.js';
import { translateRecipe } from './llm.js';
import { kvGet, kvPut } from './kv.js';

const TTL_SECONDS = 60 * 60 * 24 * 365; // keep recipes for a year

export function newRecipeId(): string {
  // 8 chars of base36 from crypto randomness — short enough for note links,
  // ~2^41 space so collisions are not a practical concern at this scale.
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString(36).slice(0, 8).padStart(8, '0');
}

export async function saveRecipe(env: Env, recipe: Recipe): Promise<void> {
  await kvPut(env, `recipe:${recipe.id}`, JSON.stringify(recipe), TTL_SECONDS);
}

export async function getRecipe(env: Env, id: string): Promise<Recipe | null> {
  if (!/^[a-z0-9]{1,16}$/.test(id)) return null;
  const raw = await kvGet(env, `recipe:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Recipe;
  } catch {
    return null;
  }
}

/**
 * Recipe in the requested language, translating once and caching in KV.
 * Falls back to the original when translation isn't possible.
 */
export async function getRecipeInLang(env: Env, recipe: Recipe, lang: string | null): Promise<Recipe> {
  if (!lang || !/^[a-z]{2}$/.test(lang)) return recipe;
  if (recipe.language && recipe.language === lang) return recipe;
  // v2: the l: generation could cache half-translated recipes (per-field
  // fallback bug) — a new prefix abandons every stale entry at once.
  const key = `recipe:${recipe.id}:l2:${lang}`;
  const cached = await kvGet(env, key);
  if (cached) {
    try { return JSON.parse(cached) as Recipe; } catch { /* fall through */ }
  }
  const translated = await translateRecipe(env, recipe, lang);
  if (!translated) return recipe;
  await kvPut(env, key, JSON.stringify(translated), TTL_SECONDS);
  return translated;
}
