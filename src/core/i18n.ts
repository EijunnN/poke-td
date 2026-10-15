import { G } from '../g';
/* ============ i18n.js — idiomas (español / inglés) ============
 * El juego está escrito en español. Si el idioma es inglés, todo texto que
 * se enseña se traduce con el diccionario de js/data/lang-en.js, sin tener que
 * tocar cada pantalla:
 *   - el DOM (menús, cartas, avisos...) con un MutationObserver,
 *   - el canvas (HUD, avisos, números) envolviendo fillText/strokeText,
 *   - confirm()/alert().
 *
 * El diccionario usa el texto español como clave. Tres niveles:
 *   1. frase exacta                    'Volver' -> 'Back'
 *   2. patrón con huecos {x}           '¡Has conseguido a {x} shiny!' -> 'You got a shiny {x}!'
 *                                      (lo que cae en el hueco también se traduce)
 *   3. trozos dentro de un texto más largo, sólo palabras enteras
 * Lo que escriben los jugadores (apodos) va marcado con translate="no".
 *
 * Idioma: el elegido en Ajustes; si no, /en/ en la dirección o el del navegador
 * (español si el navegador está en español, inglés en cualquier otro caso).
 */
/** Patrón con hueco {x}: expresiones (normal y sin mayúsculas), traducción y texto fijo. */
interface Pattern { re: RegExp; reI: RegExp; en: string; lit: number }

/** Nodo de texto con la última traducción puesta (para no repetirla). */
interface TrText extends Text { __tr?: string | null }

export const I18n = (() => {
  const KEY = 'ps.lang';
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* nada */ }
  const byPath = /\/en(\/|$)/.test(location.pathname) ? 'en' : null;
  const nav = ((navigator.languages && navigator.languages[0]) || navigator.language || 'es').toLowerCase();
  const lang = saved === 'es' || saved === 'en' ? saved : byPath || (nav.startsWith('es') ? 'es' : 'en');
  document.documentElement.lang = lang;

  const exact = new Map<string, string>(), exactLow = new Map<string, string>();
  const patterns: Pattern[] = [];
  let frag: RegExp | null = null, fragLow = null;
  const fragMap = new Map<string, string>();
  const cache = new Map<string, string>();
  const L = '\\p{L}\\p{N}';
  const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Añade traducciones { 'texto en español': 'English text' }. */
  function add(dict: Record<string, string>) {
    const fr = [];
    for (const [es, en] of Object.entries(dict)) {
      if (!en || es === en) continue;
      if (es.includes('{x}')) {
        const parts = es.split('{x}').map(reEsc);
        patterns.push({ re: new RegExp('^' + parts.join('(.+?)') + '$', 'u'), reI: new RegExp('^' + parts.join('(.+?)') + '$', 'iu'), en,
                        lit: es.replace(/\{x\}/g, '').length });
      } else {
        exact.set(es, en);
        exactLow.set(es.toLowerCase(), en);
        if (es.length >= 4 || /\s/.test(es)) { fr.push(es); fragMap.set(es.toLowerCase(), en); }
      }
    }
    // Gana el patrón más concreto (más texto fijo): 'Oleada {x} en {x} s · {x}' antes que 'Oleada {x}'.
    // A igualdad, el que se añadió antes (sort es estable).
    patterns.sort((a, b) => b.lit - a.lit);
    // Una sola expresión con todos los trozos (los más largos primero), sólo palabras enteras.
    const all = [...fragMap.keys()].sort((a, b) => b.length - a.length).map(reEsc).join('|');
    frag = all ? new RegExp(`(?<![${L}])(${all})(?![${L}])`, 'giu') : null;
    cache.clear();
  }

  function keepCase(src: string, en: string) {
    if (src === src.toUpperCase() && /\p{L}/u.test(src)) return en.toUpperCase();
    return en;
  }

  /** Traduce un texto (sin espacios de los lados) al idioma actual. */
  function t(s: string): string;
  function t<T>(s: T): T;
  function t(s: unknown): unknown {
    if (lang === 'es' || !s || typeof s !== 'string') return s;
    if (!/\p{L}/u.test(s)) return s;
    const c = cache.get(s);
    if (c !== undefined) return c;
    let r = core(s);
    if (cache.size > 4000) cache.clear();
    cache.set(s, r);
    return r;
  }

  function core(s: string): string {
    // Respeta los espacios de alrededor (nodos de texto del DOM).
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    // Los textos del HTML pueden ocupar varias líneas: se comparan con los espacios juntos.
    const lead = m![1], tail = m![3], body = m![2].replace(/\s+/g, ' ');
    if (!body) return s;
    const upper = body === body.toUpperCase() && /\p{L}/u.test(body);
    let r = exact.get(body);
    if (r === undefined && upper) { const e = exactLow.get(body.toLowerCase()); if (e !== undefined) r = keepCase(body, e); }
    if (r === undefined) {
      for (const p of patterns) {
        const mm = (upper ? p.reI : p.re).exec(body);
        if (!mm) continue;
        let i = 1;
        r = p.en.replace(/\{x\}/g, () => { const g = mm[i++]; return g === undefined ? '' : core(g); });
        r = keepCase(body, r);
        break;
      }
    }
    if (r === undefined && frag) {
      r = body.replace(frag, w => keepCase(w, fragMap.get(w.toLowerCase()) || w));
    }
    return lead + (r === undefined ? body : r) + tail;
  }

  /** Texto con huecos para el código: T('Nivel {x}', 5). */
  function f(es: string, ...vals: unknown[]) { let i = 0; return t(es).replace(/\{x\}/g, () => String(vals[i++])); }

  // ---------------- DOM ----------------
  const ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  const skipEl = (el: Element | null) => !!(el && el.closest && el.closest('[translate="no"], script, style, code'));

  function doText(n: TrText) {
    const p = n.parentElement;
    if (!p || skipEl(p)) return;
    const v = n.nodeValue;
    if (n.__tr === v) return;
    const r = t(v);
    n.__tr = r;
    if (r !== v) n.nodeValue = r;
  }
  function doEl(el: Element) {
    if (skipEl(el)) return;
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) { const r = t(v); if (r !== v) el.setAttribute(a, r); }
    }
  }
  function walk(root: Node) {
    if (root.nodeType === 3) { doText(root as Text); return; }
    if (root.nodeType !== 1 || skipEl(root as Element)) return;
    doEl(root as Element);
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n: Node | null;
    while ((n = tw.nextNode())) { if (n.nodeType === 3) doText(n as Text); else doEl(n as Element); }
  }

  function startDom() {
    if (lang === 'es') return;
    // Los enlaces a las páginas de la web, a su versión en inglés.
    const EN_LINKS: Record<string, string> = { 'guia/': 'en/guide/', 'pokedex/': 'en/pokedex/' };
    document.querySelectorAll('a[href]').forEach(a => { const h = a.getAttribute('href')!; if (EN_LINKS[h]) a.setAttribute('href', EN_LINKS[h]); });
    walk(document.body);
    new MutationObserver(ms => {
      for (const m of ms) {
        if (m.type === 'characterData') doText(m.target as Text);
        else if (m.type === 'attributes') doEl(m.target as Element);
        else m.addedNodes.forEach(walk);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    document.title = t(document.title);
  }

  // ---------------- canvas y ventanas del navegador ----------------
  if (lang !== 'es') {
    type TextFn = (this: CanvasRenderingContext2D, s: unknown, ...a: unknown[]) => unknown;
    const P = CanvasRenderingContext2D.prototype as unknown as Record<string, TextFn>;
    for (const k of ['fillText', 'strokeText', 'measureText']) {
      const orig = P[k];
      P[k] = function (s, ...a) { return orig.call(this, typeof s === 'string' ? t(s) : s, ...a); };
    }
    const oc = window.confirm, oa = window.alert;
    window.confirm = (s?: string) => oc.call(window, t(s));
    window.alert = (s?: string) => oa.call(window, t(s));
  }

  function set(l: string) {
    try { localStorage.setItem(KEY, l); } catch (e) { /* nada */ }
    location.reload();
  }

  return { lang, add, t, f, set, startDom, walk };
})();
G.I18n = I18n;
G.T = G.I18n.t;

declare module '../g' {
  interface Registry { I18n: typeof I18n }
}
