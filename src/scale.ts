import type { Ingredient } from './types.js';

const VULGAR: Record<string, number> = {
  '¼': 1 / 4,
  '½': 1 / 2,
  '¾': 3 / 4,
  '⅐': 1 / 7,
  '⅑': 1 / 9,
  '⅒': 1 / 10,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '⅕': 1 / 5,
  '⅖': 2 / 5,
  '⅗': 3 / 5,
  '⅘': 4 / 5,
  '⅙': 1 / 6,
  '⅚': 5 / 6,
  '⅛': 1 / 8,
  '⅜': 3 / 8,
  '⅝': 5 / 8,
  '⅞': 7 / 8,
};
const VULGAR_CHARS = Object.keys(VULGAR).join('');

// A single quantity token: "1 1/2", "1½", "1/2", "1.5", "2", "½".
// Order matters: mixed forms must be tried before their plain-integer prefix.
const NUM = `(?:\\d+\\s+\\d+/\\d+|\\d+\\s*[${VULGAR_CHARS}]|\\d+/\\d+|\\d+(?:\\.\\d+)?|[${VULGAR_CHARS}])`;
// The trailing boundary is whitespace, end-of-line, OR a zero-width position
// before a letter — so metric-style "400g" / "½cup" (unit glued to the number)
// still parse; the unit is then read from `rest`.
const QTY_RE = new RegExp(
  `^(${NUM})(?:(?:\\s*[-–]\\s*|\\s+to\\s+)(${NUM}))?(?:\\s+|(?=[A-Za-z])|$)`,
  'i'
);

const UNITS: Record<string, string> = {
  cup: 'cup', cups: 'cup',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbsp: 'tbsp', tbsps: 'tbsp',
  teaspoon: 'tsp', teaspoons: 'tsp', tsp: 'tsp', tsps: 'tsp',
  gram: 'g', grams: 'g', g: 'g',
  kilogram: 'kg', kilograms: 'kg', kg: 'kg',
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml', ml: 'ml',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l', l: 'l',
  ounce: 'oz', ounces: 'oz', oz: 'oz',
  pound: 'lb', pounds: 'lb', lb: 'lb', lbs: 'lb',
  clove: 'clove', cloves: 'clove',
  can: 'can', cans: 'can',
  stick: 'stick', sticks: 'stick',
  pinch: 'pinch', pinches: 'pinch',
  bunch: 'bunch', bunches: 'bunch',
  slice: 'slice', slices: 'slice',
  piece: 'piece', pieces: 'piece',
  package: 'package', packages: 'package', pkg: 'package',
  handful: 'handful', handfuls: 'handful',
};

// Only full-word units pluralize; abbreviations (tbsp, tsp, g, ...) never do.
const PLURALS: Record<string, string> = {
  cup: 'cups',
  clove: 'cloves',
  can: 'cans',
  stick: 'sticks',
  pinch: 'pinches',
  bunch: 'bunches',
  slice: 'slices',
  piece: 'pieces',
  package: 'packages',
  handful: 'handfuls',
};

function parseNum(s: string): number {
  const t = s.trim();
  const vulgar = t.match(new RegExp(`^(\\d+)?\\s*([${VULGAR_CHARS}])$`));
  if (vulgar) {
    const whole = vulgar[1] ? parseInt(vulgar[1], 10) : 0;
    return whole + (VULGAR[vulgar[2] as string] ?? 0);
  }
  const frac = t.match(/^(?:(\d+)\s+)?(\d+)\/(\d+)$/);
  if (frac) {
    const whole = frac[1] ? parseInt(frac[1], 10) : 0;
    return whole + parseInt(frac[2] as string, 10) / parseInt(frac[3] as string, 10);
  }
  return parseFloat(t);
}

function splitNote(text: string): { item: string; note: string | null } {
  const idx = text.indexOf(',');
  if (idx === -1) return { item: text.trim(), note: null };
  const note = text.slice(idx + 1).trim();
  return { item: text.slice(0, idx).trim(), note: note.length > 0 ? note : null };
}

export function parseIngredientLine(raw: string): Ingredient {
  const line = raw.trim();
  const m = line.match(QTY_RE);
  if (!m) {
    const { item, note } = splitNote(line);
    return { raw, qty: null, qtyHigh: null, unit: null, item, note, group: null };
  }

  const qty = parseNum(m[1] as string);
  const qtyHigh = m[2] !== undefined ? parseNum(m[2]) : null;
  let rest = line.slice(m[0].length);

  let unit: string | null = null;
  const word = rest.match(/^([A-Za-z]+)\.?(?:\s+|$)/);
  if (word) {
    const canonical = UNITS[(word[1] as string).toLowerCase()];
    if (canonical !== undefined) {
      unit = canonical;
      rest = rest.slice(word[0].length).replace(/^of\s+/i, '');
    }
  }

  const { item, note } = splitNote(rest);
  return { raw, qty, qtyHigh, unit, item, note, group: null };
}

const N = '\\d+(?:\\.\\d+)?';
const MIN_WORDS = '(?:minutes?|mins?)';
// Alternatives, earliest match in the text wins. Group numbering:
// 1,2 = hours (+ optional trailing minutes); 3,4 = minute range; 5 = minutes; 6 = seconds.
const DURATION_RE = new RegExp(
  [
    // "an hour and a half" must precede "an hour" (which is a prefix of it).
    '\\ban\\s+hour\\s+and\\s+a\\s+half\\b',
    '\\bhalf\\s+an\\s+hour\\b',
    '\\ban\\s+hour\\b',
    // "1 hour 20 min", "2 hrs", and "1 hour and a half" (the last sub-alt adds 30).
    `\\b(${N})\\s*(?:hours?|hrs?)\\b(?:\\s+and\\s+a\\s+half\\b|\\s+(?:and\\s+)?(${N})\\s*${MIN_WORDS}\\b)?`,
    `\\b(${N})\\s*(?:[-–]|to)\\s*(${N})\\s*${MIN_WORDS}\\b`,
    `\\b(${N})\\s*${MIN_WORDS}\\b`,
    `\\b(${N})\\s*(?:seconds?|secs?)\\b`,
  ].join('|'),
  'i'
);

export function detectMinutes(text: string): number | null {
  const m = text.match(DURATION_RE);
  if (!m) return null;
  const matched = m[0].toLowerCase();

  let minutes: number;
  if (/^an\s+hour\s+and\s+a\s+half$/.test(matched)) {
    minutes = 90;
  } else if (matched.startsWith('half')) {
    minutes = 30;
  } else if (/^an\s+hour$/.test(matched)) {
    minutes = 60;
  } else if (m[1] !== undefined) {
    let base = parseFloat(m[1]) * 60 + (m[2] !== undefined ? parseFloat(m[2]) : 0);
    if (m[2] === undefined && /and\s+a\s+half/.test(matched)) base += 30; // "1 hour and a half"
    minutes = Math.round(base);
  } else if (m[4] !== undefined) {
    minutes = Math.round(parseFloat(m[4])); // range: upper bound
  } else if (m[5] !== undefined) {
    minutes = Math.round(parseFloat(m[5]));
  } else if (m[6] !== undefined) {
    minutes = Math.max(1, Math.ceil(parseFloat(m[6]) / 60));
  } else {
    minutes = 60; // "an hour"
  }

  return minutes > 1440 ? null : minutes;
}

export function scaleQty(qty: number, factor: number): number {
  return Math.round(qty * factor * 100) / 100;
}

const FRACTION_GLYPHS: Array<[number, string]> = [
  [0.125, '⅛'],
  [0.167, '⅙'],
  [0.25, '¼'],
  [0.33, '⅓'],
  [0.375, '⅜'],
  [0.5, '½'],
  [0.625, '⅝'],
  [0.67, '⅔'],
  [0.75, '¾'],
  [0.833, '⅚'],
  [0.875, '⅞'],
];

// Snap tolerance: tight enough that 2.1 stays "2.1" (0.1 must not snap to 1/8),
// loose enough that 0.33 / 0.67 snap to thirds.
const SNAP = 0.02;

export function formatQty(qty: number): string {
  const nearest = Math.round(qty);
  if (nearest > 0 && Math.abs(qty - nearest) <= SNAP) return String(nearest);
  if (Number.isInteger(qty)) return String(qty);

  const whole = Math.floor(qty);
  const frac = qty - whole;
  for (const [value, glyph] of FRACTION_GLYPHS) {
    if (Math.abs(frac - value) <= SNAP) {
      return whole >= 1 ? `${whole}${glyph}` : glyph;
    }
  }
  return String(Math.round(qty * 100) / 100);
}

export function formatIngredient(ing: Ingredient, factor: number): string {
  if (ing.qty === null) return ing.raw;

  const scaled = scaleQty(ing.qty, factor);
  const scaledHigh = ing.qtyHigh !== null ? scaleQty(ing.qtyHigh, factor) : null;

  let qtyText = formatQty(scaled);
  if (scaledHigh !== null) qtyText += `–${formatQty(scaledHigh)}`;

  let unitText = ing.unit;
  if (unitText !== null) {
    const effective = scaledHigh ?? scaled;
    const plural = PLURALS[unitText];
    if (effective > 1 && plural !== undefined) unitText = plural;
  }

  const parts = [qtyText];
  if (unitText !== null) parts.push(unitText);
  if (ing.item.length > 0) parts.push(ing.item);

  let out = parts.join(' ');
  if (ing.note !== null && ing.note.length > 0) out += `, ${ing.note}`;
  return out;
}
