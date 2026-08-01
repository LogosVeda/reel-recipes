import type { Recipe } from '../types.js';
import { SUPPORTED_LANGS } from '../llm.js';
import { formatIngredient } from '../scale.js';

// Recipe content comes from arbitrary websites: every recipe-derived string
// must pass through esc() before landing in HTML text or attributes.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prettyDuration(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
  }
  return `${minutes} min`;
}

function factorParam(factor: number): string {
  return String(Number(factor.toFixed(2)));
}

/** Scaled serving count, never below 1. */
function displayServings(servings: number, factor: number): number {
  return Math.max(1, Math.round(servings * factor));
}

/** Return the URL only if it parses as http(s); else null (render as text). */
function safeHttpUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const STYLE = `
:root{color-scheme:light;
--paper:#faf1ce;--white:#ffffff;
--ink:#1f2a58;--ink-soft:#5c6488;
--blue:#2946c8;--blue-press:#2138a6;--blue-pastel:#e7ebfb;
--melon:#f2687c;--melon-deep:#c94b5e;--melon-pastel:#fde3e6;
--font-ui:ui-rounded,'SF Pro Rounded',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
--font-display:'Iowan Old Style',Palatino,'Palatino Linotype',ui-serif,Georgia,serif;
--shadow-soft:0 2px 4px rgba(31,42,88,.04),0 18px 40px -28px rgba(31,42,88,.5);}
*{box-sizing:border-box;}
:focus-visible{outline:2.5px solid var(--blue);outline-offset:2px;}
body{margin:0;font-family:var(--font-ui);background:var(--paper);background-image:radial-gradient(120% 55% at 50% 0%,#fdf7dd 0%,#faf1ce 65%);background-repeat:no-repeat;color:var(--ink);line-height:1.55;-webkit-text-size-adjust:100%;padding-bottom:64px;}
header.app{max-width:640px;margin:0 auto;padding:16px 22px 0;}
header.app a{display:inline-flex;align-items:center;min-height:44px;color:var(--melon-deep);text-decoration:none;font-size:.74rem;font-weight:700;letter-spacing:.22em;text-transform:uppercase;}
main{max-width:640px;margin:0 auto;padding:6px 22px 0;}
h1{font-family:var(--font-display);font-weight:600;font-size:clamp(30px,8vw,40px);line-height:1.12;letter-spacing:-0.015em;color:var(--blue);margin:6px 0 10px;}
.source{margin:4px 0 12px;color:var(--ink-soft);font-size:0.9rem;}
.source a{color:var(--blue);word-break:break-all;}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0;}
.chip{background:var(--white);border-radius:999px;padding:6px 14px;font-size:0.85rem;font-weight:650;color:var(--ink);box-shadow:var(--shadow-soft);}
.scale{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:18px 0;}
.scale .lbl{font-size:0.85rem;color:var(--ink-soft);font-weight:650;}
.scale a{display:inline-flex;align-items:center;justify-content:center;min-width:48px;min-height:44px;padding:0 10px;border-radius:12px;text-decoration:none;color:var(--blue);font-weight:700;background:var(--white);box-shadow:var(--shadow-soft);}
.scale a.on{background:var(--blue);color:#fff;}
h2{font-size:.76rem;font-weight:700;text-transform:uppercase;letter-spacing:.22em;margin:34px 0 6px;color:var(--melon-deep);}
h3.group{font-size:0.82rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--ink-soft);margin:18px 0 0;}
ul.check{list-style:none;margin:8px 0;padding:0;}
ul.check li{border-bottom:1px solid rgba(31,42,88,.12);}
ul.check label{display:flex;align-items:center;gap:12px;min-height:48px;padding:8px 2px;cursor:pointer;}
ul.check input{width:22px;height:22px;flex:none;accent-color:var(--blue);}
ul.check input:checked+span{text-decoration:line-through;opacity:0.7;}
ol.steps{margin:8px 0;padding-left:26px;}
ol.steps li{margin:15px 0;}
ol.steps li::marker{color:var(--melon-deep);font-weight:700;font-family:var(--font-display);}
a.timer{display:inline-flex;align-items:center;min-height:44px;margin-top:8px;padding:0 16px;border-radius:12px;color:var(--blue);text-decoration:none;font-weight:700;font-size:0.92rem;background:var(--white);box-shadow:var(--shadow-soft);}
ul.notes{margin:8px 0;padding-left:22px;}
.actions{display:flex;flex-direction:column;gap:12px;margin:32px 0 0;}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:54px;padding:0 16px;border:none;border-radius:16px;font-size:1rem;font-weight:700;font-family:var(--font-ui);text-decoration:none;cursor:pointer;}
.btn.primary{background:var(--blue);color:#fff;box-shadow:0 12px 26px -14px rgba(41,70,200,.6);}
.btn.primary:active{background:var(--blue-press);}
.btn.ghost{background:var(--white);color:var(--blue);box-shadow:var(--shadow-soft);}
.back{display:inline-flex;align-items:center;min-height:44px;color:var(--blue);text-decoration:none;font-weight:700;font-size:.74rem;letter-spacing:.22em;text-transform:uppercase;}
.langbar{display:flex;align-items:center;gap:10px;margin:6px 0 0;}
.langbar label{font-size:.76rem;color:var(--ink-soft);font-weight:700;letter-spacing:.14em;text-transform:uppercase;}
.langbar select{min-height:44px;padding:0 12px;border:none;border-radius:12px;background:var(--white);color:var(--ink);font-size:1rem;font-family:inherit;box-shadow:var(--shadow-soft);}
`;

// Restores checkbox state from localStorage and persists changes; wires up
// any [data-copy] button. Copy source: 'note' fetches the note endpoint,
// 'list' collects the on-page checklist text.
const SCRIPT = `
(function(){
  var boxes=document.querySelectorAll('input[data-k]');
  for(var i=0;i<boxes.length;i++){(function(b){
    var k=b.getAttribute('data-k');
    try{if(localStorage.getItem(k)==='1')b.checked=true;}catch(e){}
    b.addEventListener('change',function(){
      try{if(b.checked)localStorage.setItem(k,'1');else localStorage.removeItem(k);}catch(e){}
    });
  })(boxes[i]);}

  function fallbackCopy(t){
    var ta=document.createElement('textarea');
    ta.value=t;ta.setAttribute('readonly','');
    ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy');}catch(e){}
    document.body.removeChild(ta);
  }
  function copyText(t,btn){
    var done=function(){
      var old=btn.textContent;
      btn.textContent='Copied \\u2713';
      setTimeout(function(){btn.textContent=old;},2000);
    };
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(done,function(){fallbackCopy(t);done();});
    }else{fallbackCopy(t);done();}
  }
  var copies=document.querySelectorAll('button[data-copy]');
  for(var j=0;j<copies.length;j++){(function(btn){
    btn.addEventListener('click',function(){
      var mode=btn.getAttribute('data-copy');
      if(mode==='note'){
        fetch(btn.getAttribute('data-url'))
          .then(function(r){return r.text();})
          .then(function(t){copyText(t,btn);})
          .catch(function(){btn.textContent='Copy failed';});
      }else{
        var spans=document.querySelectorAll('ul.check span.txt');
        var out=[];
        for(var i=0;i<spans.length;i++){out.push('\\u2022 '+spans[i].textContent);}
        copyText(out.join('\\n'),btn);
      }
    });
  })(copies[j]);}
})();
`;

function shell(title: string, body: string, lang?: string | null): string {
  return `<!doctype html>
<html lang="${esc(lang && /^[a-z]{2}$/i.test(lang) ? lang.toLowerCase() : 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#faf1ce">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="app"><a href="/">Reel Recipes</a></header>
<main>
${body}
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}

function checklist(recipe: Recipe, factor: number, keyKind: 'ing' | 'list'): string {
  const fp = factorParam(factor);
  const out: string[] = [];
  let group: string | null = null;
  let open = false;
  recipe.ingredients.forEach((ing, i) => {
    if (ing.group !== group) {
      if (open) { out.push('</ul>'); open = false; }
      if (ing.group !== null) out.push(`<h3 class="group">${esc(ing.group)}</h3>`);
      else if (group !== null) out.push('<h3 class="group">More</h3>');
      group = ing.group;
    }
    if (!open) { out.push('<ul class="check">'); open = true; }
    const key = `rr:${recipe.id}:${fp}:${keyKind}:${i}`;
    out.push(
      `<li><label><input type="checkbox" data-k="${esc(key)}"><span class="txt">${esc(formatIngredient(ing, factor))}</span></label></li>`
    );
  });
  if (open) out.push('</ul>');
  return out.join('\n');
}

function scaleControl(recipe: Recipe, factor: number, path: string, langQuery = ''): string {
  const options = [0.5, 1, 2, 3, 4];
  const links = options
    .map((f) => {
      const on = Math.abs(f - factor) < 0.001 ? ' class="on"' : '';
      return `<a${on} href="${esc(path)}?x=${factorParam(f)}${langQuery}">${factorParam(f)}x</a>`;
    })
    .join('');
  const servings =
    recipe.servings !== null
      ? `<span class="lbl">servings: ${displayServings(recipe.servings, factor)}</span>`
      : '';
  return `<div class="scale"><span class="lbl">Scale</span>${links}${servings}</div>`;
}

export interface RenderOptions {
  /** Language the recipe was originally written in (null = unknown) */
  originalLanguage: string | null;
  /** The ?lang= value in effect ('' = following the device language) */
  currentLang: string;
}

/**
 * Query fragment that carries an EXPLICIT ?lang= choice into every link and
 * fetch on the page (scale pills, shopping list, copy-note). Without it, the
 * page can show English while the copy button silently follows the device
 * language — the exact bug where a note arrived in Spanish.
 */
function langQueryOf(opts?: RenderOptions): string {
  const l = opts?.currentLang ?? '';
  return /^([a-z]{2}|orig)$/i.test(l) ? `&lang=${l.toLowerCase()}` : '';
}

function languageSelector(recipe: Recipe, idPath: string, fp: string, opts?: RenderOptions): string {
  if (!opts) return '';
  const current = opts.currentLang || (recipe.language ?? '');
  const options: string[] = [];
  options.push(`<option value="orig"${opts.currentLang === 'orig' ? ' selected' : ''}>Original${opts.originalLanguage ? ` (${opts.originalLanguage.toUpperCase()})` : ''}</option>`);
  for (const [code, name] of Object.entries(SUPPORTED_LANGS)) {
    options.push(`<option value="${code}"${current === code ? ' selected' : ''}>${esc(name)}</option>`);
  }
  return `<div class="langbar"><label for="lang">Language</label>
<select id="lang" onchange="location.href='${esc(idPath)}?x=${fp}&lang='+this.value">${options.join('')}</select></div>`;
}

export function renderRecipePage(recipe: Recipe, origin: string, factor: number, opts?: RenderOptions): string {
  const fp = factorParam(factor);
  const idPath = `/r/${encodeURIComponent(recipe.id)}`;

  const chips: string[] = [];
  if (recipe.servings !== null) chips.push(`Serves ${displayServings(recipe.servings, factor)}`);
  if (recipe.prepMinutes !== null) chips.push(`Prep ${prettyDuration(recipe.prepMinutes)}`);
  if (recipe.cookMinutes !== null) chips.push(`Cook ${prettyDuration(recipe.cookMinutes)}`);
  if (recipe.totalMinutes !== null) chips.push(`Total ${prettyDuration(recipe.totalMinutes)}`);
  const meta = chips.length
    ? `<div class="meta">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>`
    : '';

  let sourceLine = '';
  if (recipe.source.url) {
    const who = recipe.source.author ?? recipe.source.siteName ?? recipe.source.platform;
    const safe = safeHttpUrl(recipe.source.url);
    sourceLine = safe
      ? `<p class="source">From <a href="${esc(safe)}" rel="noopener" target="_blank">${esc(who)}</a></p>`
      : `<p class="source">From ${esc(who)}</p>`;
  }

  const stepsOut: string[] = [];
  let group: string | null = null;
  let open = false;
  let n = 0;
  for (const step of recipe.steps) {
    if (step.group !== group) {
      if (open) { stepsOut.push('</ol>'); open = false; }
      if (step.group !== null) stepsOut.push(`<h3 class="group">${esc(step.group)}</h3>`);
      else if (group !== null) stepsOut.push('<h3 class="group">More</h3>');
      group = step.group;
    }
    if (!open) { stepsOut.push(`<ol class="steps" start="${n + 1}">`); open = true; }
    n += 1;
    const text = esc(step.text.replace(/\s*\n+\s*/g, ' ').trim());
    const m = step.minutes;
    let timer = '';
    if (m !== null && m >= 1 && m <= 720) {
      const href = `${origin}/t?m=${m}&l=Step%20${n}`;
      timer = `<br><a class="timer" href="${esc(href)}">Start ${esc(prettyDuration(m))} timer</a>`;
    }
    stepsOut.push(`<li>${text}${timer}</li>`);
  }
  if (open) stepsOut.push('</ol>');

  const notes = recipe.notes.length
    ? `<h2>Notes</h2><ul class="notes">${recipe.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
    : '';

  const lq = langQueryOf(opts);
  const noteUrl = `/api/recipe/${encodeURIComponent(recipe.id)}/note?x=${fp}${lq}`;

  const body = `
<h1>${esc(recipe.title)}</h1>
${sourceLine}
${recipe.description !== null ? `<p class="source">${esc(recipe.description)}</p>` : ''}
${meta}
${scaleControl(recipe, factor, idPath, lq)}
${languageSelector(recipe, idPath, fp, opts)}
<h2>Ingredients</h2>
${checklist(recipe, factor, 'ing')}
${recipe.steps.length > 0 ? `<h2>Steps</h2>\n${stepsOut.join('\n')}` : ''}
${notes}
<div class="actions">
<a class="btn primary" href="${esc(idPath)}/list?x=${fp}${lq}">Shopping list</a>
<button class="btn ghost" data-copy="note" data-url="${esc(noteUrl)}">Copy note for Apple Notes</button>
</div>`;

  return shell(recipe.title, body, recipe.language);
}

export function renderShoppingListPage(recipe: Recipe, origin: string, factor: number, opts?: RenderOptions): string {
  const fp = factorParam(factor);
  const idPath = `/r/${encodeURIComponent(recipe.id)}`;
  const title = `${recipe.title} — Shopping list`;
  const lq = langQueryOf(opts);

  const servings =
    recipe.servings !== null
      ? `<div class="meta"><span class="chip">For ${displayServings(recipe.servings, factor)} servings</span></div>`
      : '';

  const body = `
<a class="back" href="${esc(idPath)}?x=${fp}${lq}">← Back to recipe</a>
<h1>${esc(title)}</h1>
${servings}
${checklist(recipe, factor, 'list')}
<div class="actions">
<button class="btn primary" data-copy="list">Copy list</button>
</div>`;

  return shell(title, body, recipe.language);
}
