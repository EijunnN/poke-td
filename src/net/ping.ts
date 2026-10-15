import { G } from '../g';
import { Link, type ServerMsg } from './link';
/* ============ ping.ts — señales en el mapa ("¡aquí!") para la partida en grupo ============
 * Como en Dota (y en Fortaleza): Alt + clic en el mapa (o en el minimapa de la Defensa) marca
 * ese punto para todos los de la sala. En el móvil, el botón 📍 (ui/chat-ui.ts) arma el
 * siguiente toque como señal.
 *
 * Va por el servidor (server/realtime.ts, `mark`: `ping` es el latido de la conexión), que lo reparte a los de la sala (también a
 * los que miran) y limita el ritmo. Sólo se dibuja: no toca la partida.
 *   - Ondas del color de quien la lanza, un marcador "!" y su nombre (drawWorld, con la cámara).
 *   - Si queda fuera de la pantalla, una flecha en el borde (drawHud).
 *   - Un sonido corto, más a la izquierda o a la derecha según dónde esté.
 * A quien tienes silenciado en el chat tampoco se le ven las señales.
 */
export interface MapPing { f: string; name: string; color: string; x: number; y: number; t0: number }

export const Pings = (() => {
  const LIFE = 3000, MAX = 12, GAP = 350;
  let list: MapPing[] = [];
  let armed = false, lastSent = 0;
  const armFns = new Set<(v: boolean) => void>();

  /** ¿Se pueden lanzar? (en una partida en grupo, jugando o mirando) */
  const available = () => G.Coop.active && G.Game.state !== 'ui';

  /** Color de quien la lanza: el de su Pokémon en la partida (los que miran, blanco). */
  function colorOf(uid: string): string {
    for (const p of G.Game.everyone()) if (p && p.uid === uid && p.tagColor) return p.tagColor;
    return '#ffffff';
  }

  function add(m: { f: string; n: string; x: number; y: number }) {
    if (!available() || G.Chat.isMuted(m.f)) return;
    list.push({ f: m.f, name: m.n, color: colorOf(m.f), x: m.x, y: m.y, t0: performance.now() });
    if (list.length > MAX) list.shift();
    // El sonido, del lado de la pantalla donde está.
    const cam = G.Camera;
    const sx = (m.x - cam.left()) * cam.scale, w = window.innerWidth || 1;
    G.Audio.sfx('ping', { pan: Math.max(-1, Math.min(1, sx / w * 2 - 1)) });
  }

  Link.on((m: ServerMsg) => {
    if (m.k === 'mark' && typeof m.f === 'string' && typeof m.n === 'string' && Number.isFinite(m.x) && Number.isFinite(m.y)) add(m as never);
  });

  /** Lanza una señal en (x, y) del mundo. → true si ha salido */
  function send(x: number, y: number): boolean {
    if (!available()) return false;
    const now = performance.now();
    if (now - lastSent < GAP) return false;
    lastSent = now;
    Link.send({ k: 'mark', x: Math.round(x), y: Math.round(y) });
    setArmed(false);
    return true;
  }
  function setArmed(v: boolean) {
    if (armed === v) return;
    armed = v;
    armFns.forEach(fn => fn(v));
  }

  /** De la pantalla (clientX/Y) al mundo. */
  function toWorld(cx: number, cy: number) {
    const cv = document.getElementById('game')!.getBoundingClientRect(), cam = G.Camera;
    return { x: cam.left() + (cx - cv.left) / cam.scale, y: cam.top() + (cy - cv.top) / cam.scale };
  }

  // Alt + clic en el mapa (o un toque con la señal armada): se lanza y el juego no se entera del clic.
  let swallow: number | null = null;
  function hook() {
    const cv = document.getElementById('game');
    if (!cv) return;
    cv.addEventListener('pointerdown', e => {
      if (!available() || !(armed || (e.altKey && e.button === 0))) return;
      if (G.Touch.onButton(e.clientX, e.clientY)) return;         // los iconos de ataque siguen siendo iconos
      e.preventDefault(); e.stopImmediatePropagation();
      swallow = e.pointerId;
      const p = toWorld(e.clientX, e.clientY);
      send(p.x, p.y);
    }, true);
    const end = (e: PointerEvent) => { if (swallow === e.pointerId) { swallow = null; e.stopImmediatePropagation(); } };
    cv.addEventListener('pointerup', end, true);
    cv.addEventListener('pointercancel', end, true);
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', hook); else hook();

  // ---------------- dibujo ----------------

  function alive() {
    const now = performance.now();
    list = list.filter(p => now - p.t0 < LIFE);
    return now;
  }

  /** En el mundo (con la cámara puesta): ondas, marcador y nombre. */
  function drawWorld(ctx: CanvasRenderingContext2D) {
    if (!list.length) return;
    const now = alive();
    ctx.save();
    for (const p of list) {
      const age = (now - p.t0) / LIFE, a = Math.min(1, (LIFE - (now - p.t0)) / 500);
      ctx.strokeStyle = p.color; ctx.lineWidth = 2;
      for (let k = 0; k < 3; k++) {
        const ph = (age * 2.4 + k / 3) % 1;
        ctx.globalAlpha = a * (1 - ph) * 0.85;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 6 + ph * 26, (6 + ph * 26) * 0.5, 0, 0, 6.2832); ctx.stroke();
      }
      // Marcador tipo gota con "!" (bota un poco).
      ctx.globalAlpha = a;
      const my = p.y - 22 + Math.sin(age * Math.PI * 6) * 1.5;
      ctx.fillStyle = p.color; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, my, 7, 0, 6.2832);
      ctx.moveTo(p.x - 4, my + 5); ctx.lineTo(p.x, p.y - 2); ctx.lineTo(p.x + 4, my + 5);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#10141c'; ctx.font = '700 9px Pixelify,"Segoe UI",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('!', p.x, my + 0.5);
      ctx.font = '700 6px Pixelify,"Segoe UI",sans-serif'; ctx.textBaseline = 'bottom';
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.strokeText(p.name, p.x, my - 8); ctx.fillStyle = p.color; ctx.fillText(p.name, p.x, my - 8);
    }
    ctx.restore();
  }

  /** En pantalla (sin cámara): flecha en el borde hacia las que quedan fuera. */
  function drawHud(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (!list.length) return;
    const now = alive(), cam = G.Camera, M = 26;
    for (const p of list) {
      const sx = (p.x - cam.left()) * cam.scale, sy = (p.y - cam.top()) * cam.scale;
      if (sx > 0 && sx < w && sy > 0 && sy < h) continue;
      const ex = G.U.clamp(sx, M, w - M), ey = G.U.clamp(sy, M + 50, h - M - 60), ang = Math.atan2(sy - ey, sx - ex);
      ctx.save();
      ctx.globalAlpha = Math.min(1, (LIFE - (now - p.t0)) / 500) * (0.75 + 0.25 * Math.sin(now / 90));
      ctx.translate(ex, ey); ctx.rotate(ang);
      ctx.fillStyle = p.color; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(13, 0); ctx.lineTo(-7, -9); ctx.lineTo(-3, 0); ctx.lineTo(-7, 9); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }

  return {
    send, toWorld, drawWorld, drawHud, available,
    get list() { alive(); return list; },
    get armed() { return armed; },
    setArmed, onArmed(fn: (v: boolean) => void) { armFns.add(fn); },
    /** Pruebas y capturas: como si llegara del servidor. */
    debugReceive(m: { f: string; n: string; x: number; y: number }) { add(m); },
    clear() { list = []; setArmed(false); },
  };
})();
G.Pings = Pings;

declare module '../g' {
  interface Registry { Pings: typeof Pings }
}
