import { G } from '../g';
/* ============ input.js — teclado y ratón (el táctil está en touch.js) ============ */
export const Input = (() => {
  const down = new Set<string>();
  const pressed = new Set<string>();   // se limpia cada frame
  let mx = 0, my = 0, mdown = false;

  const MOVE_KEYS = {
    up: ['keyw', 'arrowup'], down: ['keys', 'arrowdown'],
    left: ['keya', 'arrowleft'], right: ['keyd', 'arrowright']
  };

  function code(e: KeyboardEvent) { return (e.code || e.key).toLowerCase(); }

  /** ¿Se está escribiendo en un campo? Entonces las teclas son del campo, no del juego. */
  function typing(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
  }

  addEventListener('keydown', e => {
    if (typing(e)) return;
    const c = code(e);
    if (!down.has(c)) pressed.add(c);
    down.add(c);
    // Evita que el navegador haga scroll con flechas/espacio durante la partida. En los
    // menús no: ahí Tab, flechas y Espacio sirven para moverse entre botones y pulsarlos.
    if (G.Game && G.Game.state !== 'ui' && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'space', 'tab'].includes(c)) e.preventDefault();
  });
  addEventListener('keyup', e => down.delete(code(e)));
  addEventListener('blur', () => { down.clear(); });
  addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; });
  addEventListener('mousedown', () => mdown = true);
  addEventListener('mouseup', () => mdown = false);

  return {
    /** Vector de movimiento del jugador (teclado o joystick táctil). */
    axis() {
      const t = G.Touch && G.Touch.vector();
      if (t && (t[0] || t[1])) return t;
      let x = 0, y = 0;
      if (MOVE_KEYS.left.some(k => down.has(k))) x -= 1;
      if (MOVE_KEYS.right.some(k => down.has(k))) x += 1;
      if (MOVE_KEYS.up.some(k => down.has(k))) y -= 1;
      if (MOVE_KEYS.down.some(k => down.has(k))) y += 1;
      return G.U.norm(x, y);
    },
    held(c: string) { return down.has(c); },
    /** true sólo en el frame en que se pulsó. */
    tap(c: string) { return pressed.has(c); },
    mouse() { return { x: mx, y: my, down: mdown }; },
    endFrame() { pressed.clear(); }
  };
})();
G.Input = Input;

declare module '../g' {
  interface Registry { Input: typeof Input }
}
