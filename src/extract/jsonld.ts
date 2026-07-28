// Pure JSON-LD (schema.org/Recipe) extractor. No DOM, no fetch — regex + JSON.parse only,
// so it runs both in Cloudflare Workers and in vitest under Node.

import { decodeEntities } from './html';

export interface JsonLdRecipeData {
  title: string;
  description: string | null;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  ingredientLines: string[];
  steps: { text: string; group: string | null }[];
  author: string | null;
  siteName: string | null;
}

type JsonValue = unknown;
type JsonObject = Record<string, unknown>;

function isObject(v: JsonValue): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Decode entities, then strip HTML tags, then collapse whitespace.
 * Decode-first means encoded markup ("&lt;b&gt;") is treated as markup and
 * stripped rather than leaking literal "<b>" into recipe text; the shared
 * single-pass decoder also can't double-decode "&amp;lt;" the way chained
 * replaces did, and handles numeric entities (&#233;, &frac12;) that the old
 * hand-rolled list missed.
 */
function cleanText(input: string): string {
  return decodeEntities(input)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract raw contents of every <script type="application/ld+json"> block. */
function findJsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  // The type attribute can appear anywhere among other attributes, any quoting.
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
    if (/type\s*=\s*["']?application\/ld\+json["']?/i.test(openTag)) {
      blocks.push(m[1]);
    }
  }
  return blocks;
}

function isRecipeNode(node: JsonValue): node is JsonObject {
  if (!isObject(node)) return false;
  const t = node['@type'];
  if (typeof t === 'string') return t.toLowerCase() === 'recipe';
  if (Array.isArray(t)) {
    return t.some((x) => typeof x === 'string' && x.toLowerCase() === 'recipe');
  }
  return false;
}

/** Search a parsed JSON-LD value (object, array, or @graph wrapper) for the first Recipe node. */
function findRecipeNode(data: JsonValue): JsonObject | null {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }
  if (isObject(data)) {
    if (isRecipeNode(data)) return data;
    const graph = data['@graph'];
    if (Array.isArray(graph)) return findRecipeNode(graph);
  }
  return null;
}

/** ISO-8601 duration (PT30M, PT1H30M, P0DT1H10M) -> total minutes, or null. */
function parseIsoDurationMinutes(value: JsonValue): number | null {
  if (typeof value !== 'string') return null;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
    value.trim(),
  );
  if (!m) return null;
  const [, d, h, min, s] = m;
  if (d === undefined && h === undefined && min === undefined && s === undefined) return null;
  const total =
    (d ? Number(d) * 24 * 60 : 0) +
    (h ? Number(h) * 60 : 0) +
    (min ? Number(min) : 0) +
    (s ? Number(s) / 60 : 0);
  const rounded = Math.round(total);
  // Cap at one week — beyond that it's broken markup, not a real recipe time.
  return rounded > 0 && rounded <= 10080 ? rounded : null;
}

/** recipeYield: number | numeric string | "4 servings" | array -> first integer 1-100. */
function parseServings(value: JsonValue): number | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const parsed = parseServings(v);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  if (typeof value === 'number') {
    const n = Math.round(value);
    return n >= 1 && n <= 100 ? n : null;
  }
  if (typeof value === 'string') {
    const m = /\d+/.exec(value);
    if (!m) return null;
    const n = parseInt(m[0], 10);
    return n >= 1 && n <= 100 ? n : null;
  }
  return null;
}

function parseIngredients(node: JsonObject): string[] {
  const raw = node['recipeIngredient'] ?? node['ingredients'];
  if (!Array.isArray(raw)) return [];
  const lines: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cleaned = cleanText(item);
    if (cleaned) lines.push(cleaned);
  }
  return lines;
}

function stepTextFrom(obj: JsonObject): string | null {
  const text = obj['text'] ?? obj['name'];
  if (typeof text !== 'string') return null;
  const cleaned = cleanText(text);
  return cleaned || null;
}

/** Split a single instruction string into steps on newlines or "1. " style numbering. */
function splitInstructionString(text: string): string[] {
  const byNewline = text
    .split(/\r?\n+/)
    .map((s) => cleanText(s))
    .filter(Boolean);
  if (byNewline.length > 1) return byNewline;

  const single = cleanText(text);
  if (!single) return [];

  // Sentence numbering: "1. Do this. 2. Do that." Only split when the markers
  // form a real 1,2,3… sequence — otherwise a mid-sentence number followed by a
  // period ("Divide into 2. Roll…") would be mistaken for a list marker and the
  // number silently deleted.
  const markers: { index: number; length: number; num: number }[] = [];
  const re = /(?:^|\s)(\d+)[.)]\s+/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(single)) !== null) {
    markers.push({ index: mm.index, length: mm[0].length, num: parseInt(mm[1] as string, 10) });
  }
  const sequential =
    markers.length > 1 &&
    markers[0]!.num === 1 &&
    markers.every((mk, i) => mk.num === i + 1);
  if (sequential) {
    const parts: string[] = [];
    // Keep any preamble before "1." ("Preheat the oven. 1. Mix…") as a step
    // rather than silently dropping it.
    const preamble = single.slice(0, markers[0]!.index).trim();
    if (preamble.length > 3) parts.push(preamble);
    for (let i = 0; i < markers.length; i++) {
      const start = markers[i]!.index + markers[i]!.length;
      const end = i + 1 < markers.length ? markers[i + 1]!.index : single.length;
      const part = single.slice(start, end).trim();
      if (part) parts.push(part);
    }
    if (parts.length > 1) return parts;
  }
  return [single];
}

function parseInstructions(node: JsonObject): { text: string; group: string | null }[] {
  const raw = node['recipeInstructions'];
  const steps: { text: string; group: string | null }[] = [];

  const addFromValue = (value: JsonValue, group: string | null): void => {
    if (typeof value === 'string') {
      for (const text of splitInstructionString(value)) {
        steps.push({ text, group });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) addFromValue(item, group);
      return;
    }
    if (isObject(value)) {
      const type = value['@type'];
      const typeStr = typeof type === 'string' ? type.toLowerCase() : '';
      if (typeStr === 'howtosection') {
        const name = typeof value['name'] === 'string' ? cleanText(value['name'] as string) : null;
        addFromValue(value['itemListElement'], name || group);
        return;
      }
      const text = stepTextFrom(value);
      if (text) steps.push({ text, group });
    }
  };

  addFromValue(raw, null);
  return steps;
}

/** author: string | {name} | array of either -> first name. */
function parseAuthor(value: JsonValue): string | null {
  if (typeof value === 'string') {
    const cleaned = cleanText(value);
    return cleaned || null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseAuthor(item);
      if (parsed) return parsed;
    }
    return null;
  }
  if (isObject(value) && typeof value['name'] === 'string') {
    const cleaned = cleanText(value['name'] as string);
    return cleaned || null;
  }
  return null;
}

function parseSiteName(node: JsonObject): string | null {
  const publisher = node['publisher'];
  if (isObject(publisher) && typeof publisher['name'] === 'string') {
    const cleaned = cleanText(publisher['name'] as string);
    return cleaned || null;
  }
  return null;
}

export function extractJsonLdRecipe(html: string): JsonLdRecipeData | null {
  let recipe: JsonObject | null = null;
  for (const block of findJsonLdBlocks(html)) {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    recipe = findRecipeNode(parsed);
    if (recipe) break;
  }
  if (!recipe) return null;

  const ingredientLines = parseIngredients(recipe);
  const steps = parseInstructions(recipe);
  if (ingredientLines.length === 0 && steps.length === 0) return null;

  const title = typeof recipe['name'] === 'string' ? cleanText(recipe['name'] as string) : '';
  const description =
    typeof recipe['description'] === 'string' ? cleanText(recipe['description'] as string) || null : null;

  return {
    title: title || 'Untitled recipe',
    description,
    servings: parseServings(recipe['recipeYield']),
    prepMinutes: parseIsoDurationMinutes(recipe['prepTime']),
    cookMinutes: parseIsoDurationMinutes(recipe['cookTime']),
    totalMinutes: parseIsoDurationMinutes(recipe['totalTime']),
    ingredientLines,
    steps,
    author: parseAuthor(recipe['author']),
    siteName: parseSiteName(recipe),
  };
}
