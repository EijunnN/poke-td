import { G } from '../g';
/* ============ gamepad.ts — mando (Xbox, PlayStation, Switch Pro…) ============
 * Idea del PR #141 del original (ZeroTrace), adaptada a PokéTD. Se lee en
 * cada fotograma (G.Input.endFrame llama a poll()) y sólo si hay un mando:
 * sin mando no se hace nada (cada 2 s se mira una vez si ha aparecido alguno).
 *
 * - En partida: el stick izquierdo y la cruceta mueven (G.Input.axis) y los
 *   botones se convierten en las teclas de siempre (1–4, Q, E, Esc, R): el
 *   resto del juego no sabe si se juega con teclado o con mando. Así también
 *   valen los bloqueos de 400 ms de las pantallas de elegir (run-ui.ts) y el
 *   del resumen (keysOver).
 * - En pantallas de elegir (cartas de nivel, objeto, vínculo): los botones de
 *   ataque son las teclas 1–4 y R (cambiar cartas); además, cruceta o stick
 *   marcan una carta y el botón de abajo (A / ✕) la elige.
 * - En el resumen: A = Intro (otra vez), B o pausa = Esc (menú). Cruceta + A
 *   también pulsan el botón marcado.
 * - En menús y pausa: cruceta o stick van de botón en botón, A pulsa y B
 *   vuelve (Esc).
 * - Los botones de partida se cambian en Ajustes > Controles y se guardan en
 *   este aparato (como los demás ajustes).
 * - En la Defensa, el stick mueve al héroe; plantar torres sigue siendo con
 *   ratón o táctil.
 * - En grupo / espectador no hay nada especial: el mando sólo produce la
 *   entrada local.
 *
 *   G.Gamepad.vector()  ·  G.Gamepad.rebind('pause')  ·  G.Gamepad.on(fn)
 */
type Act = 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'prev' | 'next' | 'pause' | 'reroll';
type KeyName = Act | 'ok';
type Mode = 'play' | 'modal' | 'over' | 'menu';

export const Gamepad = (() => {
  const KEY = 'ps.pad';
  // Botón de cada acción (índices del "standard mapping" de los navegadores).
  const DEF: Record<Act, number> = { slot1: 0, slot2: 1, slot3: 2, slot4: 3, prev: 4, next: 5, pause: 9, reroll: 8 };
  const ACTIONS: [Act, string][] = [
    ['slot1', 'Ataque / carta 1'], ['slot2', 'Ataque / carta 2'], ['slot3', 'Ataque / carta 3'], ['slot4', 'Ataque 4'],
    ['prev', 'Ataque anterior'], ['next', 'Ataque siguiente'], ['pause', 'Pausa'], ['reroll', 'Cambiar cartas']
  ];
  // La tecla que "pulsa" cada acción: [code, key], como un KeyboardEvent de verdad
  // (input.ts lee `code`: 'digit1', 'keyq', 'escape'...). 'ok' es el Intro del resumen.
  const KEYS: Record<KeyName, [string, string]> = {
    slot1: ['Digit1', '1'], slot2: ['Digit2', '2'], slot3: ['Digit3', '3'], slot4: ['Digit4', '4'],
    prev: ['KeyQ', 'q'], next: ['KeyE', 'e'], pause: ['Escape', 'Escape'], reroll: ['KeyR', 'r'], ok: ['Enter', 'Enter']
  };
  const OK = 0, BACK = 1, UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15, HOME = 16;
  const DEAD = 0.25;
  const NAMES: Record<string, string[]> = {
    xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L3', 'R3', '↑', '↓', '←', '→', 'Home'],
    ps: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3', '↑', '↓', '←', '→', 'PS'],
    nin: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '−', '+', 'L3', 'R3', '↑', '↓', '←', '→', 'Home']
  };
  // Pantallas de elegir de la partida (se miran también por la pantalla, no sólo por el estado: en grupo la partida sigue 'held').
  const CHOOSE = ['scr-levelup', 'scr-bond', 'scr-item'];
  // Tras cambiar de situación, un momento sin pulsar con el mando lo marcado (como los bloqueos del juego).
  const CALM_MS = 400;

  let map: Record<Act, number> = Object.assign({}, DEF);
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const k of Object.keys(DEF) as Act[]) if (Number.isInteger(s[k])) map[k] = s[k];
  } catch (e) { /* nada */ }

  let last: boolean[] = [], vec: [number, number] | null = null, mode: Mode | null = null, capture: Act | null = null;
  let present = false, probeAt = 0, calmUntil = 0;
  let navKey: string | null = null, navT = 0, focusEl: HTMLElement | null = null, focusSig = '';
  const sent = new Set<Act>();     // acciones con la tecla "pulsada"
  const fns = new Set<() => void>();

  function save() { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (e) { /* nada */ } }
  function changed() { fns.forEach(fn => { try { fn(); } catch (e) { /* nada */ } }); }

  function pad(): Gamepad | null {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    let any: Gamepad | null = null;
    for (const p of list) {
      if (!p || !p.connected) continue;
      if (p.mapping === 'standard') return p;
      any = any || p;
    }
    return any;
  }
  function family(p: Gamepad | null) {
    const id = (p && p.id) || '';
    if (/xbox|045e|xinput/i.test(id)) return 'xbox';
    if (/054c|sony|playstation|dualsense|dualshock|wireless controller/i.test(id)) return 'ps';
    if (/057e|nintendo|pro controller|joy-con/i.test(id)) return 'nin';
    return 'xbox';
  }

  function send(type: 'keydown' | 'keyup', k: KeyName) {
    const [code, key] = KEYS[k];
    dispatchEvent(new KeyboardEvent(type, { code, key, bubbles: true, cancelable: true }));
  }
  function tapKey(k: KeyName) { send('keydown', k); send('keyup', k); }
  function releaseAll() { sent.forEach(a => send('keyup', a)); sent.clear(); }

  /** ¿Está escribiendo en un campo de texto? Entonces el mando no toca el juego (B suelta el campo). */
  function typing() {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    if (!el.getClientRects().length) return false;      // campo escondido (su pantalla ya no está)
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    return el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file)$/.test((el as HTMLInputElement).type);
  }

  /** En qué situación están los botones: partida, elegir carta/objeto/vínculo, resumen o menú. */
  function situation(): Mode {
    if (G.SettingsUI && G.SettingsUI.isOpen) return 'menu';
    const s = G.Run.state;
    if (s === 'ui') return 'menu';
    if (s === 'over') return 'over';
    if (s === 'paused' || G.UI.isOpen('scr-pause')) return 'menu';   // en grupo la pausa es una pantalla y la partida sigue
    if (s === 'levelup' || s === 'choice' || CHOOSE.some(G.UI.isOpen)) return 'modal';
    return 'play';
  }

  // ---------------- navegar por los menús ----------------
  const SEL = 'button, a[href], input, select, textarea, .card, .chip, .menu-item, [tabindex]';
  const center = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const sig = (el: HTMLElement) => el.id || (Object.keys(el.dataset).length ? JSON.stringify(el.dataset) : (el.textContent || '').trim().slice(0, 40));

  function scroller(el: Element): Element | null {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
  }
  /** ¿Se ve (no está tapado por otra pantalla)? Si está fuera de su lista con scroll, cuenta la lista. */
  function onTop(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const { x, y } = center(el);
    const sc = scroller(el);
    if (sc) {
      const s = sc.getBoundingClientRect();
      if (y < s.top || y > s.bottom || x < s.left || x > s.right) return onTop(sc);
    }
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return !!hit && el.contains(hit);
  }
  function candidates() {
    return [...document.querySelectorAll<HTMLElement>(SEL)].filter(el => !(el as HTMLButtonElement).disabled && onTop(el));
  }
  function setFocus(el: HTMLElement | null) {
    if (focusEl) focusEl.classList.remove('pad-focus');
    focusEl = el; focusSig = el ? sig(el) : '';
    if (el) { el.classList.add('pad-focus'); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  /** El botón marcado, si sigue a la vista (tras redibujar una pantalla se busca su gemelo). */
  function current(list: HTMLElement[]) {
    if (focusEl && !focusEl.isConnected) focusEl = list.find(el => sig(el) === focusSig) || null;
    if (focusEl && list.includes(focusEl)) { focusEl.classList.add('pad-focus'); return focusEl; }
    setFocus(null);     // su pantalla ya no está: que no se quede marcado para cuando vuelva
    return null;
  }
  /** Primer botón que se marca en una pantalla: el dorado (el principal), si no el primer elemento del menú o, si no, el primero. */
  function firstOf(list: HTMLElement[]) {
    return list.find(el => el.classList.contains('gold')) || list.find(el => el.classList.contains('menu-item')) || list[0] || null;
  }
  function move(dx: number, dy: number) {
    const list = candidates();
    const cur = current(list);
    if (!cur) { setFocus(firstOf(list)); return; }
    // Un deslizador (volumen): izquierda y derecha lo mueven.
    if (cur instanceof HTMLInputElement && cur.type === 'range') {
      if (dx) { if (dx > 0) cur.stepUp(5); else cur.stepDown(5); cur.dispatchEvent(new Event('input', { bubbles: true })); cur.dispatchEvent(new Event('change', { bubbles: true })); return; }
    }
    // Hacia esa dirección (dentro de un cono, si hay algo en él).
    const a = center(cur);
    let opts: { el: HTMLElement; along: number; side: number }[] = [];
    for (const el of list) {
      if (el === cur || el.contains(cur) || cur.contains(el)) continue;
      const c = center(el), vx = c.x - a.x, vy = c.y - a.y;
      const along = vx * dx + vy * dy;
      if (along > 2) opts.push({ el, along, side: Math.abs(vx * dy - vy * dx) });
    }
    const cone = opts.filter(o => o.side <= o.along * 2);
    if (cone.length) opts = cone;
    if (!opts.length) return;
    // El más cercano hacia esa dirección, pero el desvío a los lados pesa el doble (así "derecha" va al de la misma fila).
    const best = opts.sort((u, v) => (u.along + 2 * u.side) - (v.along + 2 * v.side))[0];
    setFocus(best.el);
  }
  /** Pulsa el botón marcado (si no hay ninguno y `first`, marca el primero). @returns si pulsó algo */
  function activate(first: boolean) {
    const list = candidates();
    const cur = current(list);
    if (!cur) { if (first) setFocus(firstOf(list)); return false; }
    const t = cur as HTMLInputElement;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(cur.tagName) && !/^(checkbox|radio|button|submit|reset)$/.test(t.type)) cur.focus();
    else cur.click();
    return true;
  }

  // ---------------- cada fotograma ----------------

  /** Sin mando: una mirada cada 2 s por si ha aparecido alguno (lo normal es el evento 'gamepadconnected'). */
  function probe() {
    const t = performance.now();
    if (t < probeAt) return false;
    probeAt = t + 2000;
    present = !!pad();
    return present;
  }

  function lost() { present = false; vec = null; last = []; mode = null; navKey = null; setFocus(null); if (sent.size) releaseAll(); }

  function poll() {
    if (!present && !probe()) return;
    const p = pad();
    if (!p) { lost(); return; }
    const now = p.buttons.map(b => b.pressed || b.value > 0.5);
    const hit = (i: number) => !!now[i] && !last[i];

    // Ajustes: esperando el botón nuevo de una acción.
    if (capture) {
      if (!(G.SettingsUI && G.SettingsUI.isOpen)) capture = null;
      else {
        const i = now.findIndex((on, j) => on && !last[j] && (j < UP || j > HOME));
        if (i >= 0) { assign(capture, i); capture = null; changed(); }
        last = now; vec = null;
        return;
      }
    }

    // Escribiendo en un campo: el mando no toca nada; B suelta el campo.
    if (typing()) {
      if (hit(BACK)) (document.activeElement as HTMLElement).blur();
      last = now; vec = null;
      return;
    }

    let x = p.axes[0] || 0, y = p.axes[1] || 0;
    const m = Math.hypot(x, y);
    if (m < DEAD) x = y = 0;
    else { const k = Math.min(1, (m - DEAD) / (1 - DEAD)) / m; x *= k; y *= k; }
    const dx = (now[RIGHT] ? 1 : 0) - (now[LEFT] ? 1 : 0), dy = (now[DOWN] ? 1 : 0) - (now[UP] ? 1 : 0);
    if (dx || dy) [x, y] = G.U.norm(dx, dy);

    const md = situation();
    if (md !== mode) { releaseAll(); mode = md; navKey = null; calmUntil = performance.now() + CALM_MS; setFocus(null); }

    if (md === 'play') {
      vec = x || y ? [x, y] : null;
      keysPlay(now, hit);
    } else {
      vec = null;
      // La pantalla se ha redibujado (p. ej. Ajustes): se marca enseguida el gemelo.
      if (focusEl && !focusEl.isConnected) {
        const twin = [...document.querySelectorAll<HTMLElement>(SEL)].find(el => sig(el) === focusSig);
        if (twin) setFocus(twin);
      }
      // "Pulsa para empezar": cualquier botón del mando la quita (es una tecla, como con el teclado).
      const start = document.getElementById('tap-start');
      if (start && !start.classList.contains('hidden')) {
        if (now.some((on, i) => on && !last[i])) tapKey('ok');
        last = now;
        return;
      }
      const quiet = performance.now() < calmUntil;   // recién abierto: nada de pulsar lo marcado
      let used = false;                              // el botón de abajo ya ha pulsado lo marcado
      if (md === 'modal') {
        // Cartas / objeto / vínculo: los botones de ataque eligen directo (teclas 1–4, R);
        // si se ha marcado una con la cruceta, el botón de abajo elige la marcada.
        used = !!focusEl && hit(OK) && !quiet && activate(false);
        keysPlay(now, hit, used ? OK : -1);
      } else if (md === 'over') {
        // Resumen: Intro = otra vez, Esc = menú, por las teclas (que ya tienen su bloqueo).
        // Si se ha marcado un botón con la cruceta, el de abajo pulsa ese.
        if (hit(OK)) { if (focusEl && !quiet) activate(false); else tapKey('ok'); }
        if (hit(map.pause) || (hit(BACK) && map.pause !== BACK)) tapKey('pause');
      } else {
        if (hit(map.pause) || (hit(BACK) && map.pause !== BACK)) tapKey('pause');
        if (hit(OK) && !quiet) activate(true);
      }
      const ax = Math.abs(x), ay = Math.abs(y);
      const dir = ax > 0.5 || ay > 0.5 ? (ax > ay ? [Math.sign(x), 0] : [0, Math.sign(y)]) : null;
      if (!dir) navKey = null;
      else {
        const t = performance.now(), k = dir.join();
        if (k !== navKey) { navKey = k; navT = t + 380; move(dir[0], dir[1]); }
        else if (t >= navT) { navT = t + 140; move(dir[0], dir[1]); }
      }
    }
    last = now;
  }

  /** Botones de partida → teclas. Sólo al apretar: un botón que venía pulsado del menú no dispara nada. */
  function keysPlay(now: boolean[], hit: (i: number) => boolean, skip = -1) {
    for (const act of Object.keys(map) as Act[]) {
      const b = map[act];
      if (b === skip) continue;
      if (hit(b) && !sent.has(act)) { sent.add(act); send('keydown', act); }
      else if (!now[b] && sent.has(act)) { sent.delete(act); send('keyup', act); }
    }
  }

  // ---------------- cambiar botones ----------------
  /** Pone el botón i a la acción; si otra lo tenía, se quedan intercambiados. */
  function assign(act: Act, i: number) {
    const other = (Object.keys(map) as Act[]).find(k => map[k] === i);
    if (other && other !== act) map[other] = map[act];
    map[act] = i;
    save();
  }

  addEventListener('gamepadconnected', () => { present = true; if (G.UI) G.UI.toast('Mando conectado'); changed(); });
  addEventListener('gamepaddisconnected', () => {
    // Si queda otro mando, se sigue con él.
    if (!pad()) lost();
    if (G.UI) G.UI.toast('Mando desconectado');
    changed();
  });

  return {
    poll, ACTIONS,
    /** Hacia dónde empuja el stick o la cruceta en partida (null si nada). */
    vector() { return vec; },
    get map() { return Object.assign({}, map); },
    get name() { const p = pad(); return p ? p.id.replace(/\s*\(.*\)\s*$/, '') || 'Mando' : ''; },
    get capturing() { return capture; },
    label(i: number) { return NAMES[family(pad())][i] || 'Botón ' + i; },
    /** Espera el siguiente botón del mando para esa acción (otra vez: cancela). */
    rebind(act: string) { capture = capture === act ? null : act as Act; changed(); },
    reset() { map = Object.assign({}, DEF); capture = null; save(); changed(); },
    on(fn: () => void) { fns.add(fn); }
  };
})();
G.Gamepad = Gamepad;

declare module '../g' {
  interface Registry { Gamepad: typeof Gamepad }
}
