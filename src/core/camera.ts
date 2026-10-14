import { G } from '../g';
/* ============ camera.js — vista y transformación mundo<->pantalla ============
 * El ancho visible del mundo es constante (VIEW_W) sea cual sea el tamaño de
 * ventana, así el juego se siente igual en cualquier pantalla.
 */
export interface CameraT {
  x: number; y: number;
  scale: number;
  VIEW_W: number;
  shake: number;
  _sx: number; _sy: number;
  dpr: number;
  MIN_VIEW_H: number;
  /** Tamaño visible del mundo; se fija en resize(). */
  w: number; h: number;
  resize(cssW: number, cssH: number, dpr?: number): void;
  follow(tx: number, ty: number, dt: number): void;
  kick(amount: number): void;
  apply(ctx: CanvasRenderingContext2D): void;
  left(): number;
  top(): number;
  sees(x: number, y: number, pad?: number): boolean;
  outerRadius(): number;
}

export const Camera = {
  x: 0, y: 0,
  scale: 1,
  VIEW_W: 768,              // un 20% más de vista que al principio (640)
  shake: 0,
  _sx: 0, _sy: 0,

  /** Recalcula la escala para el tamaño actual del canvas. */
  dpr: 1,

  // En pantallas más anchas que 16:9 (móviles en horizontal) se asegura
  // también un alto mínimo de mundo, para no ver una franja estrecha.
  MIN_VIEW_H: 420,

  resize(cssW: number, cssH: number, dpr = 1) {
    this.dpr = dpr;
    this.scale = Math.min(cssW / this.VIEW_W, cssH / this.MIN_VIEW_H);
    this.w = cssW / this.scale;
    this.h = cssH / this.scale;
  },

  follow(tx: number, ty: number, dt: number) {
    this.x = G.U.damp(this.x, tx, 9, dt);
    this.y = G.U.damp(this.y, ty, 9, dt);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.4);
      const a = this.shake * 7;
      this._sx = G.U.rand(-a, a);
      this._sy = G.U.rand(-a, a);
    } else { this._sx = this._sy = 0; }
  },

  kick(amount: number) {
    if (G.Settings.get('calm')) amount *= 0.25;      // "menos sacudidas"
    this.shake = Math.min(1.2, this.shake + amount);
  },

  /** Aplica la transformación de cámara al contexto. */
  apply(ctx: CanvasRenderingContext2D) {
    // Redondea a píxeles físicos de pantalla: sin esto aparecen juntas de
    // 1 px entre chunks y los sprites "tiemblan" al moverse.
    const k = this.scale * this.dpr;
    ctx.translate(Math.round((-this.left() + this._sx) * k) / k,
                  Math.round((-this.top() + this._sy) * k) / k);
  },

  left() { return this.x - this.w / 2; },
  top() { return this.y - this.h / 2; },

  /** ¿Está el punto dentro de la vista (con margen)? */
  sees(x: number, y: number, pad = 60) {
    return x > this.left() - pad && x < this.left() + this.w + pad &&
           y > this.top() - pad && y < this.top() + this.h + pad;
  },

  /** Radio del círculo que envuelve la vista: usado para spawnear fuera. */
  outerRadius() { return Math.hypot(this.w, this.h) / 2 + 40; }
} as CameraT;
G.Camera = Camera;

declare module '../g' {
  interface Registry { Camera: CameraT }
}
