import { G } from '../g';
/* ============ input.js — teclado y ratón (el táctil está en touch.js y el mando en gamepad.ts) ============ */
export const Input = (() => {
  const down = new Set<string>();
  const pressed = new Set<string>();   // se limpia cada frame
  let mx = 0, my = 0, mdown = false;
  let over = false;          // ¿el ratón está encima del lienzo del juego (y no de un menú)?
  let mouseMode = false;     // el ratón se ha movido y el mando no lo ha tomado después
  let cv: HTMLElement | null = null;

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
  addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY; mouseMode = true;
    over = (e.target as HTMLElement | null)?.id === 'game';
  });
  document.documentElement.addEventListener('mouseleave', () => { over = false; });
  addEventListener('mousedown', () => mdown = true);
  addEventListener('mouseup', () => mdown = false);

  return {
    /** Vector de movimiento del jugador (joystick táctil, mando o teclado). */
    axis() {
      const t = G.Touch && G.Touch.vector();
      if (t && (t[0] || t[1])) return t;
      const p = G.Gamepad && G.Gamepad.vector();
      if (p) { mouseMode = false; return p; }
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
    mouse() { return { x: mx, y: my, down: mdown, over }; },
    /** Dónde apunta el ratón en el mundo; null si no se juega con ratón (táctil, mando o aún sin moverlo). */
    mouseWorld() {
      if (!mouseMode || G.Touch.active) return null;
      cv = cv || document.getElementById('game');
      if (!cv) return null;
      const r = cv.getBoundingClientRect(), cam = G.Camera;
      return { x: cam.left() + (mx - r.left) / cam.scale, y: cam.top() + (my - r.top) / cam.scale };
    },
    endFrame() {
      pressed.clear();
      // El mando se lee aquí: lo que pulse llega como teclas en el fotograma siguiente.
      if (G.Gamepad) G.Gamepad.poll();
    }
  };
})();
G.Input = Input;

declare module '../g' {
  interface Registry { Input: typeof Input }
}
