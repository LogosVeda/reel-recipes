import type { Recipe } from '../types.js';
import { formatIngredient } from '../scale.js';

/** 90 -> '1 hr 30 min', 60 -> '1 hr', 8 -> '8 min' */
function prettyDuration(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
  }
  return `${minutes} min`;
}

/** Render factor with up to 2 decimals, trimmed: 1 -> '1', 1.5 -> '1.5' */
function factorParam(factor: number): string {
  return String(Number(factor.toFixed(2)));
}

/** Scaled serving count, never below 1. */
function displayServings(servings: number, factor: number): number {
  return Math.max(1, Math.round(servings * factor));
}

function servingsLabel(n: number): string {
  return `${n} serving${n === 1 ? '' : 's'}`;
}

export function buildNoteText(recipe: Recipe, origin: string, factor: number): string {
  const lines: string[] = [];
  const fp = factorParam(factor);
  const base = `${origin}/r/${encodeURIComponent(recipe.id)}`;
  // Preserve the note's own scale when linking back to the web view.
  const scaledUrl = factor !== 1 ? `${base}?x=${fp}` : base;

  lines.push(`🍳 ${recipe.title}`);

  if (recipe.servings !== null) {
    const scaled = displayServings(recipe.servings, factor);
    lines.push(
      factor !== 1
        ? `Serves ${scaled} (scaled from ${recipe.servings})`
        : `Serves ${scaled}`
    );
  }

  const timeParts: string[] = [];
  if (recipe.prepMinutes !== null) timeParts.push(`Prep ${recipe.prepMinutes} min`);
  if (recipe.cookMinutes !== null) timeParts.push(`Cook ${recipe.cookMinutes} min`);
  if (recipe.totalMinutes !== null) timeParts.push(`Total ${recipe.totalMinutes} min`);
  if (timeParts.length > 0) lines.push(timeParts.join(' · '));

  if (recipe.source.url) {
    const who = recipe.source.author ?? recipe.source.siteName;
    lines.push(who ? `From ${who}: ${recipe.source.url}` : `From ${recipe.source.url}`);
  }

  lines.push('');
  if (recipe.servings !== null) {
    lines.push(`INGREDIENTS (${servingsLabel(displayServings(recipe.servings, factor))})`);
  } else if (factor !== 1) {
    lines.push(`INGREDIENTS (scaled ${fp}×)`);
  } else {
    lines.push('INGREDIENTS');
  }
  let ingGroup: string | null = null;
  for (const ing of recipe.ingredients) {
    if (ing.group !== ingGroup) {
      // Header on entering a group; a neutral header when trailing ungrouped
      // items follow grouped ones, so they aren't read under the last section.
      if (ing.group !== null) lines.push(`— ${ing.group} —`);
      else if (ingGroup !== null) lines.push('— More —');
      ingGroup = ing.group;
    }
    lines.push(`• ${formatIngredient(ing, factor)}`);
  }

  lines.push('');
  lines.push('STEPS');
  let stepGroup: string | null = null;
  let n = 0;
  for (const step of recipe.steps) {
    if (step.group !== stepGroup) {
      if (step.group !== null) lines.push(`— ${step.group} —`);
      else if (stepGroup !== null) lines.push('— More —');
      stepGroup = step.group;
    }
    n += 1;
    const text = step.text.replace(/\s*\n+\s*/g, ' ').trim();
    const m = step.minutes;
    lines.push(`${n}. ${text}${m !== null && m > 0 ? ` (${prettyDuration(m)})` : ''}`);
    if (m !== null && m >= 1 && m <= 720) {
      lines.push(`   ⏱ ${origin}/t?m=${m}&l=Step%20${n}`);
    }
  }

  if (recipe.notes.length > 0) {
    lines.push('');
    lines.push('NOTES');
    for (const note of recipe.notes) lines.push(`• ${note}`);
  }

  lines.push('');
  lines.push(`🛒 Shopping list: ${base}/list?x=${fp}`);
  lines.push(`📖 Full recipe: ${scaledUrl}`);
  // Quick multipliers of the ORIGINAL recipe (1x resets a scaled note to base).
  lines.push(`Scale it: 1x ${base} · 2x ${base}?x=2 · 3x ${base}?x=3`);

  return lines.join('\n');
}
