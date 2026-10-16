import { G } from '../g';
/* ============ touch.js — controles táctiles ============
 * Joystick flotante: pones el dedo en cualquier sitio de la pantalla de juego
 * y ahí aparece; arrastras para moverte y al soltar desaparece. El centro se
 * queda fijo donde pusiste el dedo; si te alejas más que el radio, sólo el
 * pomo se queda en el borde (la dirección sigue siendo la del dedo).
 * Con el ajuste stickMode = 'fixed' el joystick es fijo: siempre se ve abajo a la
 * izquierda (sobre el margen seguro) y sólo lo mueven los toques que empiezan en
 * su zona; el resto de la pantalla (el mapa de la Defensa, por ejemplo) queda libre.
 *
 * Botones del HUD (iconos de ataque, pausa): el HUD los registra en cada
 * fotograma con addButton(); un toque (o un clic con el ratón) sobre uno lo
 * pulsa en vez de abrir el joystick. Varios dedos a la vez funcionan.
 */
/** Botón del HUD registrado con addButton() (coordenadas de pantalla). */
export interface TouchButton { x: number; y: number; w: number; h: number; fn: () => void; pad: number }
/** Joystick flotante: origen (ox, oy) y posición actual (x, y) del dedo. */
export interface TouchStick { id: number; ox: number; oy: number; x: number; y: number }
export interface SafeArea { top: number; right: number; bottom: number; left: number }

export const Touch = (() => {
  let cv: HTMLCanvasElement | null = null, stick: TouchStick | null = null;
  let active = G.Settings.touch;      // ¿se está usando táctil?
  let buttons: TouchButton[] = [];

  const R = () => 56 * (G.Settings.get('stick') || 1);

  /** ¿Joystick fijo? Sólo con el táctil en uso y el ajuste elegido. */
  const fixed = () => active && G.Settings.get('stickMode') === 'fixed';
  /** Centro del joystick fijo: abajo a la izquierda, por encima de la barra de inicio y a la altura de la barra de ataques. */
  function fixedPos() {
    const sa = safeArea(), r = R();
    return { x: Math.min(44, sa.left) + 28 + r, y: cv!.clientHeight - 20 - Math.min(28, sa.bottom) - r };
  }
  /** ¿Cae el punto en la zona del joystick fijo? (un poco más grande que el dibujo, para el pulgar) */
  function inFixedZone(x: number, y: number) {
    if (!fixed() || !cv) return false;
    const p = fixedPos();
    return Math.hypot(x - p.x, y - p.y) <= R() + 24;
  }

  function init(canvas: HTMLCanvasElement) {
    cv = canvas;
    if (active) document.body.classList.add('touch');
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('contextmenu', e => e.preventDefault());
    // iPhone: la pulsación larga sobre el juego abría la lupa y el menú de
    // "Copiar / Seleccionar todo". Cortar el toque aquí lo evita (los eventos
    // pointer, que son los que usa el joystick, siguen llegando).
    // Además, los botones (movimientos, pausa) se pulsan también desde aquí: en
    // iPhone (Safari y Chrome usan WebKit) a veces no llegaba el pointerdown de
    // un segundo dedo con el otro en el joystick y no se podía cambiar de movimiento.
    cv.addEventListener('touchstart', e => {
      if (e.cancelable) e.preventDefault();
      if (!active) { active = true; document.body.classList.add('touch'); }
      for (const t of e.changedTouches) { const b = hit(t.clientX, t.clientY); if (b) press(b); }
    }, { passive: false });
    document.addEventListener('selectstart', e => {
      const el = e.target as Element;
      if (!el.closest || !el.closest('input, textarea, [contenteditable]')) e.preventDefault();
    });
    addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
  }

  function hit(x: number, y: number) {
    for (let i = buttons.length - 1; i >= 0; i--) {
      const b = buttons[i];
      if (x >= b.x - b.pad && x <= b.x + b.w + b.pad && y >= b.y - b.pad && y <= b.y + b.h + b.pad) return b;
    }
    return null;
  }

  // Un mismo toque llega por touchstart y por pointerdown: se pulsa una sola vez.
  let lastKey = '', lastAt = 0;
  function press(b: TouchButton) {
    const k = Math.round(b.x) + ',' + Math.round(b.y), now = performance.now();
    if (k === lastKey && now - lastAt < 350) return;
    lastKey = k; lastAt = now;
    b.fn();
  }

  function down(e: PointerEvent) {
    const touchy = e.pointerType !== 'mouse';
    if (touchy && !active) { active = true; document.body.classList.add('touch'); }
    const b = hit(e.clientX, e.clientY);
    if (b) { e.preventDefault(); press(b); return; }
    if (!touchy || stick || !G.Game || G.Game.state !== 'playing') return;
    // Fijo: sólo vale un toque dentro de su zona, y el centro es siempre el mismo.
    let ox = e.clientX, oy = e.clientY;
    if (fixed()) {
      if (!inFixedZone(ox, oy)) return;
      const p = fixedPos(); ox = p.x; oy = p.y;
    }
    e.preventDefault();
    stick = { id: e.pointerId, ox, oy, x: e.clientX, y: e.clientY };
    try { cv!.setPointerCapture(e.pointerId); } catch (err) { /* nada */ }
  }

  function move(e: PointerEvent) {
    if (!stick || e.pointerId !== stick.id) return;
    stick.x = e.clientX; stick.y = e.clientY;
  }

  function up(e: PointerEvent) { if (stick && e.pointerId === stick.id) stick = null; }
  function reset() { stick = null; }

  /** Dirección del joystick (con fuerza 0..1), o null si no se usa. */
  function vector(): [number, number] | null {
    if (!stick) return null;
    const dx = stick.x - stick.ox, dy = stick.y - stick.oy, d = Math.hypot(dx, dy);
    if (d < 7) return [0, 0];
    // A partir de medio radio ya va a toda velocidad.
    const k = Math.min(1, (d - 7) / (R() * 0.5 - 7));
    return [dx / d * k, dy / d * k];
  }

  /** Márgenes del iPhone (barra de inicio abajo, muesca a los lados), en px. */
  let safe: SafeArea | null = null;
  function safeArea(): SafeArea {
    if (safe) return safe;
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(d);
    const cs = getComputedStyle(d);
    safe = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0,
             bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
    d.remove();
    return safe;
  }
  addEventListener('resize', () => { safe = null; });
  addEventListener('orientationchange', () => { safe = null; });

  /** El HUD vacía y vuelve a registrar sus botones cada fotograma. */
  function clearButtons() { buttons = []; }
  function addButton(x: number, y: number, w: number, h: number, fn: () => void, pad = 6) { buttons.push({ x, y, w, h, fn, pad }); }

  /** Dibuja el joystick (coordenadas de pantalla, CSS px). */
  function draw(ctx: CanvasRenderingContext2D) {
    // Fijo y sin dedo encima: se dibuja en reposo (más tenue) mientras se juega.
    let s: TouchStick | null = stick, rest = false;
    if (!s && fixed() && G.Game && G.Game.state === 'playing') { const p = fixedPos(); s = { id: -1, ox: p.x, oy: p.y, x: p.x, y: p.y }; rest = true; }
    if (!s) return;
    const r = R();
    const dx = s.x - s.ox, dy = s.y - s.oy, d = Math.hypot(dx, dy);
    const kx = s.ox + (d > r ? dx / d * r : dx), ky = s.oy + (d > r ? dy / d * r : dy);
    ctx.save();
    ctx.globalAlpha = rest ? 0.3 : 0.5;
    ctx.fillStyle = 'rgba(10,20,48,.55)';
    ctx.beginPath(); ctx.arc(s.ox, s.oy, r, 0, 6.2832); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#f4f8ff';
    ctx.stroke();
    ctx.globalAlpha = rest ? 0.5 : 0.85;
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath(); ctx.arc(kx, ky, r * 0.42, 0, 6.2832); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#a55f00'; ctx.stroke();
    ctx.restore();
  }

  /** ¿Hay un botón del HUD (o el joystick fijo) en ese punto? (para que el modo no lo tome por un toque en el mapa) */
  const onButton = (x: number, y: number) => !!hit(x, y) || inFixedZone(x, y);

  return { init, vector, draw, clearButtons, addButton, reset, safeArea, onButton,
           get active() { return active; }, get stick() { return stick; } };
})();
G.Touch = Touch;

declare module '../g' {
  interface Registry { Touch: typeof Touch }
}
