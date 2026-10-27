import { G } from '../g';
/* ============ fx.js — partículas, números de daño y efectos (pixel art) ============
 * Todo lo puramente visual vive aquí. Nada de esto afecta al gameplay.
 *
 * Todo se dibuja en la rejilla de píxeles del juego (G.Sprites.PX): las
 * partículas son cuadrados, los anillos son puntos y los golpes y rayos se
 * construyen con bloques y con los sprites de G.VFX, para que los efectos
 * casen con los sprites de Mundo Misterioso.
 */
interface PxOpts { vx?: number; vy?: number; life?: number; size?: number; grav?: number; drag?: number }
interface SpOpts { vx?: number; vy?: number; life?: number; scale?: number; angle?: number; spin?: number; grav?: number; frameRate?: number; fade?: boolean }
interface MoveFx { pal?: string; melee?: string; beam?: string }

interface Part { x: number; y: number; vx: number; vy: number; t: number; life: number; color: string; s: number; grav: number; drag: number; g: boolean }
/** Sprite de efecto, o centelleo de shiny (twinkle: sin forma ni paleta). */
interface Sprite {
  x: number; y: number; vx: number; vy: number; t: number; life: number;
  twinkle?: boolean; shape?: string; pal?: string; scale?: number; angle?: number; spin?: number;
  grav?: number; fr?: number; fade?: boolean; g?: boolean;
}
interface Texto { x: number; y: number; vy: number; t: number; life: number; s: string; color: string; big: boolean }
interface Ring { x: number; y: number; r0: number; r1: number; color: string; life: number; t: number; width: number; g: boolean }
interface Slash { x: number; y: number; angle: number; radius: number; arc: number; pal: string; t: number; life: number; g: boolean }
interface Beam { x: number; y: number; angle: number; len: number; width: number; pal: string; shape: string | null; t: number; life: number; seed: number; g: boolean }

export const FX = (() => {
  const PX = G.Sprites.PX;
  // Topes según la calidad (Ajustes → Gráficos): bajo, medio, alto.
  const CAP_PARTS = [350, 800, 1400], CAP_SPRITES = [110, 210, 320], CAP_TEXTS = [25, 45, 70], DENS = [0.35, 0.65, 1];
  const q = () => G.Settings.fx;
  let parts: Part[] = [], sprites: Sprite[] = [], texts: Texto[] = [], rings: Ring[] = [], slashes: Slash[] = [], beams: Beam[] = [];

  function clear() { parts = []; sprites = []; texts = []; rings = []; slashes = []; beams = []; ghostTag = false; }

  // ---------------- ataques de los compañeros ----------------
  // Los efectos de un compañero (cooperativo) se repiten aquí como "fantasma": mientras combat.ts lo
  // indica (ghost(true)), lo que nace va marcado, y al dibujar se le aplica la opacidad de Ajustes →
  // Gráficos. Sólo toca lo que se ve: ni el azar ni el daño.
  let ghostTag = false;
  function ghost(on: boolean) { ghostTag = on; }
  /** Opacidad con la que se ven los ataques de los compañeros ahora (1 = como los tuyos). */
  function allyAlpha() {
    const a = G.Settings.get('allyFx');
    if (a >= 1) return 1;
    return G.Game.st.time / 60 >= G.Settings.get('allyFxFrom') ? Math.max(0, a) : 1;
  }

  const snap = (v: number) => Math.round(v / PX) * PX;

  // ---------------- partículas ----------------

  /** Partícula cuadrada. o: { vx, vy, life, size (en píxeles de arte), grav, drag } */
  function px(x: number, y: number, color: string, o: PxOpts = {}) {
    if (parts.length >= CAP_PARTS[q()] || (ghostTag && allyAlpha() <= 0)) return;
    parts.push({ x, y, vx: o.vx || 0, vy: o.vy || 0, t: 0, life: o.life || 0.4, color,
                 s: (o.size || 1) * PX, grav: o.grav || 0, drag: o.drag == null ? 0.9 : o.drag, g: ghostTag });
  }

  function burst(x: number, y: number, color: string, n = 8, power = 110) {
    n = Math.max(1, Math.round(n * DENS[q()]));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.2832, s = G.U.rand(power * 0.35, power);
      px(x, y, color, { vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: G.U.rand(0.22, 0.5), size: Math.random() < 0.35 ? 2 : 1 });
    }
  }

  function spark(x: number, y: number, color: string, dirX: number, dirY: number, n = 4) {
    n = Math.max(1, Math.round(n * DENS[q()]));
    const base = Math.atan2(dirY, dirX);
    for (let i = 0; i < n; i++) {
      const a = base + G.U.rand(-0.9, 0.9), s = G.U.rand(60, 170);
      px(x, y, color, { vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: G.U.rand(0.14, 0.32) });
    }
  }

  /** Sprite de efecto suelto. o: { vx, vy, life, scale, angle, spin, grav, frameRate, fade } */
  function sp(shape: string, pal: string, x: number, y: number, o: SpOpts = {}) {
    if (sprites.length >= CAP_SPRITES[q()] || (ghostTag && allyAlpha() <= 0)) return;
    sprites.push({ shape, pal, x, y, vx: o.vx || 0, vy: o.vy || 0, t: 0, life: o.life || 0.4,
                   scale: o.scale || 1, angle: o.angle || 0, spin: o.spin || 0, grav: o.grav || 0,
                   fr: o.frameRate || 10, fade: o.fade !== false, g: ghostTag });
  }

  /** Centelleo de shiny (cruz de píxeles que nace y se apaga). */
  function twinkle(x: number, y: number) {
    if (sprites.length >= CAP_SPRITES[q()]) return;
    sprites.push({ twinkle: true, x, y, vx: 0, vy: -8, t: 0, life: G.U.rand(0.45, 0.7) });
  }

  /** Partículas de estela de los proyectiles, según el material. */
  function trail(kind: string, pal: string, x: number, y: number, vx: number, vy: number) {
    if (Math.random() > DENS[q()]) return;          // en calidad baja, menos estela
    const P = G.VFX.PAL[pal] || G.VFX.PAL.normal;
    const back = Math.atan2(-vy, -vx);
    const j = () => G.U.rand(-3, 3);
    switch (kind) {
      case 'ember':   px(x + j(), y + j(), P[Math.random() < 0.5 ? 3 : 2], { vx: Math.cos(back) * 30, vy: -40, life: 0.35 }); break;
      case 'drip':    px(x + j(), y + j(), P[3], { vx: Math.cos(back) * 20, vy: 10, grav: 260, life: 0.35 }); break;
      case 'spark':   px(x + j() * 2, y + j() * 2, Math.random() < 0.5 ? P[4] : P[3], { vx: G.U.rand(-60, 60), vy: G.U.rand(-60, 60), life: 0.16 }); break;
      case 'bubbles': px(x + j(), y + j(), P[3], { vy: -35, life: 0.45, size: Math.random() < 0.3 ? 2 : 1 }); break;
      case 'dirt':    px(x + j(), y + j(), P[Math.random() < 0.5 ? 2 : 1], { vx: Math.cos(back) * 25, vy: -20, grav: 300, life: 0.35 }); break;
      case 'wisp':    px(x + j() * 2, y + j() * 2, P[Math.random() < 0.5 ? 1 : 2], { vy: -30, life: 0.5, size: 2 }); break;
    }
  }

  function dmgText(x: number, y: number, value: string | number, color = '#ffffff', big = false) {
    // Con cientos de golpes por segundo no se leen igual: tope de 70 (los
    // grandes, como "¡Muy eficaz!" o los de jefe, siempre entran).
    // Ajustes → "Números de daño": los números se ocultan; los avisos de texto no.
    if ((typeof value === 'number' || /^-\d/.test(value)) && !G.Settings.get('dmgNumbers')) return;
    if (texts.length >= CAP_TEXTS[q()]) { if (!big) return; texts.shift(); }
    texts.push({ x: x + G.U.rand(-6, 6), y, vy: -46, t: 0, life: big ? 0.95 : 0.62, s: String(value), color, big });
  }

  /** Anillo de onda (puntos de píxel). */
  function ring(x: number, y: number, r0: number, r1: number, color: string, life = 0.3, width = 3) {
    if (ghostTag && allyAlpha() <= 0) return;
    rings.push({ x, y, r0, r1, color, life, t: 0, width, g: ghostTag });
  }

  /** Golpe cuerpo a cuerpo. fx: { pal, melee } (ver G.VFX.forMove). */
  function slash(x: number, y: number, angle: number, radius: number, arc: number, color: string, fx: MoveFx = {}) {
    const pal = fx.pal || 'normal';
    if (!(ghostTag && allyAlpha() <= 0)) slashes.push({ x, y, angle, radius, arc, pal, t: 0, life: 0.22, g: ghostTag });
    const mx = x + Math.cos(angle) * radius * 0.7, my = y + Math.sin(angle) * radius * 0.7;
    switch (fx.melee) {
      case 'impact': sp('impact', pal, mx, my, { life: 0.2, scale: 1.5, frameRate: 12, fade: false }); break;
      case 'jaws':   sp('jaws', pal, mx, my, { life: 0.24, scale: 1.5, frameRate: 9, fade: false }); break;
      case 'claw':   sp('claw', pal, mx, my, { life: 0.2, scale: 1.5, angle: angle - Math.PI / 4 }); break;
      case 'vine':
      case 'feather':
        for (let i = 0; i < 4; i++) {
          const a = angle + G.U.rand(-arc / 2, arc / 2), r = radius * G.U.rand(0.5, 1);
          sp('leaf', fx.melee === 'feather' ? 'flying' : pal, x + Math.cos(a) * r, y + Math.sin(a) * r,
             { vx: Math.cos(a) * 40, vy: Math.sin(a) * 40 + 20, life: 0.45, spin: G.U.rand(-8, 8), grav: 60 });
        }
        break;
    }
  }

  /** Rayo recto. fx: { pal, beam } — beam = forma que viaja por él o 'lightning'. */
  function beam(x: number, y: number, angle: number, len: number, width: number, color: string, fx: MoveFx = {}) {
    const seed = Math.random() * 100;
    if (!(ghostTag && allyAlpha() <= 0)) beams.push({ x, y, angle, len, width, pal: fx.pal || 'normal', shape: fx.beam || null, t: 0, life: 0.2, seed, g: ghostTag });
    sp('impact', fx.pal || 'normal', x + Math.cos(angle) * 10, y + Math.sin(angle) * 10, { life: 0.12, scale: 1 });
    sp('impact', fx.pal || 'normal', x + Math.cos(angle) * len, y + Math.sin(angle) * len, { life: 0.18, scale: 1.5 });
  }

  // ---------------- actualización ----------------

  function update(dt: number) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.t += dt;
      if (p.t >= p.life) { parts.splice(i, 1); continue; }
      p.vy += p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const k = Math.pow(p.drag, dt * 60);
      p.vx *= k; p.vy *= k;
    }
    for (let i = sprites.length - 1; i >= 0; i--) {
      const s = sprites[i];
      s.t += dt;
      if (s.t >= s.life) { sprites.splice(i, 1); continue; }
      s.vy += (s.grav || 0) * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      if (s.spin) s.angle! += s.spin * dt;
    }
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i];
      t.t += dt;
      if (t.t >= t.life) { texts.splice(i, 1); continue; }
      t.y += t.vy * dt; t.vy *= 0.94;
    }
    const timed: { t: number; life: number }[][] = [rings, slashes, beams];
    for (const arr of timed) {
      for (let i = arr.length - 1; i >= 0; i--) {
        arr[i].t += dt;
        if (arr[i].t >= arr[i].life) arr.splice(i, 1);
      }
    }
  }

  // ---------------- dibujo ----------------

  // La transparencia va a escalones (1 · ,66 · ,33) para que no parezca vectorial.
  const step = (k: number) => k > 0.66 ? 1 : k > 0.33 ? 0.66 : 0.33;

  // Vista de este fotograma (mundo): lo que cae fuera ni se dibuja. Los rayos de Arceus miden 1700 px
  // y los anillos de la caída, 700 de radio: sin recortar eran miles de rectángulos por fotograma.
  let vL = 0, vT = 0, vR = 0, vB = 0, gk = 1;
  const inView = (x: number, y: number, pad: number) => x > vL - pad && x < vR + pad && y > vT - pad && y < vB + pad;

  /** Tramo [d0, d1] de un rayo (origen, ángulo, largo) que cae dentro de la vista ensanchada `pad`; null si no entra. */
  function beamSpan(x: number, y: number, a: number, len: number, pad: number): [number, number] | null {
    const dx = Math.cos(a), dy = Math.sin(a);
    let t0 = 0, t1 = len;
    for (let axis = 0; axis < 2; axis++) {
      const o = axis ? y : x, v = axis ? dy : dx, lo = (axis ? vT : vL) - pad, hi = (axis ? vB : vR) + pad;
      if (Math.abs(v) < 1e-9) { if (o < lo || o > hi) return null; continue; }
      let ta = (lo - o) / v, tb = (hi - o) / v;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return null;
    }
    return [t0, t1];
  }

  function drawBeam(ctx: CanvasRenderingContext2D, b: Beam) {
    const k = 1 - b.t / b.life;
    const a = Math.round(b.angle / (Math.PI / 16)) * (Math.PI / 16);
    const bx = snap(b.x), by = snap(b.y);
    const span = beamSpan(bx, by, a, b.len, b.width + 40);
    if (!span) return;
    const P = G.VFX.PAL[b.pal] || G.VFX.PAL.normal;
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(a);
    ctx.globalAlpha = step(k) * (b.g ? gk : 1);
    const seg = PX * 2, now = performance.now() / 1000;
    const dFrom = Math.max(0, Math.floor(span[0] / seg) * seg - seg);

    if (b.shape === 'lightning') {
      // Zigzag que se redibuja cada fotograma.
      const nyAt = (d: number) => d + seg >= b.len ? 0 : snap((G.U.hash(d | 0, (now * 30) | 0, b.seed | 0) - 0.5) * b.width);
      // (cada capa, de una vez: un trazado con todos los bloques en vez de un fillRect por bloque)
      const start = dFrom > 0 ? nyAt(dFrom - seg) : 0;
      for (let layer = 0; layer < 2; layer++) {
        let py = start;
        ctx.fillStyle = layer ? P[4] : P[3];
        ctx.beginPath();
        for (let d = dFrom; d < b.len && d <= span[1]; d += seg) {
          const ny = nyAt(d);
          const lo = Math.min(py, ny), hi = Math.max(py, ny);
          if (layer) ctx.rect(d, lo - PX, seg, hi - lo + PX * 2);
          else ctx.rect(d - PX, lo - PX * 2, seg + PX * 2, hi - lo + PX * 4);
          py = ny;
        }
        ctx.fill();
      }
    } else {
      // Cuerpo del rayo a bloques, con el borde vibrando.
      // (cada capa, de una vez: un trazado con todos los bloques en vez de cuatro fillRect por bloque)
      const hws: number[] = [];
      for (let d = dFrom; d < b.len && d <= span[1]; d += seg) {
        const wob = 0.7 + 0.3 * Math.sin(d * 0.18 + now * 30 + b.seed);
        hws.push(Math.max(PX, snap(b.width / 2 * wob * (0.6 + 0.4 * k))));
      }
      for (let layer = 1; layer <= 4; layer++) {
        ctx.fillStyle = P[layer];
        ctx.beginPath();
        let i = 0;
        for (let d = dFrom; d < b.len && d <= span[1]; d += seg, i++) {
          const hw = hws[i];
          if (layer === 1) ctx.rect(d, -hw - PX, seg, hw * 2 + PX * 2);
          else if (layer === 2) ctx.rect(d, -hw, seg, hw * 2);
          else if (layer === 3) ctx.rect(d, -snap(hw * 0.55), seg, snap(hw * 0.55) * 2);
          else ctx.rect(d, -PX, seg, PX * 2);
        }
        ctx.fill();
      }
      // Sprites que viajan por el rayo (llamas, gotas, cristales, ondas).
      if (b.shape) {
        const gap = 26, off = (now * 420) % gap;
        const first = off + Math.max(0, Math.ceil((span[0] - 24 - off) / gap)) * gap;
        for (let d = first; d < b.len - 6 && d <= span[1] + 24; d += gap) {
          const yo = Math.sin(d * 0.3 + b.seed) * b.width * 0.18;
          G.VFX.draw(ctx, b.shape, b.pal, d, yo, { angle: 0.0001, scale: 1.5, frame: (d / gap + now * 12) | 0 });
        }
      }
    }
    ctx.restore();
  }

  function drawSlash(ctx: CanvasRenderingContext2D, s: Slash) {
    if (!inView(s.x, s.y, s.radius + 24)) return;
    const k = 1 - s.t / s.life;
    const P = G.VFX.PAL[s.pal] || G.VFX.PAL.normal;
    const half = Math.min(s.arc, 6.2832) / 2;
    const r = s.radius * (0.72 + 0.28 * (1 - k));
    const n = Math.max(8, Math.ceil(r * half * 2 / PX));
    ctx.globalAlpha = step(k) * (s.g ? gk : 1);
    // Los píxeles se agrupan por color y cada color se pinta de una vez (un tajo son cientos de cuadrados).
    for (let c = 0; c < 4; c++) slashBuf[c].length = 0;
    for (let i = 0; i <= n; i++) {
      const u = i / n, a = s.angle - half + u * half * 2;
      const thick = Math.round(Math.sin(Math.PI * u) * 3 * k);      // grosor en píxeles de arte
      for (let j = -1; j <= thick; j++) {
        const rr = r - j * PX;
        slashBuf[j < 0 ? 0 : j === thick ? 3 : j > thick / 2 ? 2 : 1].push(snap(s.x + Math.cos(a) * rr), snap(s.y + Math.sin(a) * rr));
      }
    }
    for (let c = 0; c < 4; c++) {
      const buf = slashBuf[c];
      if (!buf.length) continue;
      ctx.fillStyle = P[c + 1];
      ctx.beginPath();
      for (let q = 0; q < buf.length; q += 2) ctx.rect(buf[q], buf[q + 1], PX, PX);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  const slashBuf: number[][] = [[], [], [], []];

  function drawRing(ctx: CanvasRenderingContext2D, r: Ring) {
    const k = r.t / r.life;
    const rad = G.U.lerp(r.r0, r.r1, k);
    const n = Math.max(10, Math.ceil(rad * 6.2832 / (PX * 2)));
    const size = r.width >= 4 ? PX * 2 : PX;
    // Un anillo cuyo círculo no toca la vista no pinta nada; si la toca, sólo los puntos que caen dentro.
    const cx = Math.max(vL, Math.min(vR, r.x)), cy = Math.max(vT, Math.min(vB, r.y));
    const near = Math.hypot(cx - r.x, (cy - r.y) / 0.9), far = Math.hypot(Math.max(Math.abs(vL - r.x), Math.abs(vR - r.x)), Math.max(Math.abs(vT - r.y), Math.abs(vB - r.y)) / 0.9);
    if (rad + size < near || rad - size > far) return;
    ctx.globalAlpha = step(1 - k) * (r.g ? gk : 1);
    ctx.fillStyle = r.color;
    ctx.beginPath();                 // (todos los puntos en un solo trazado)
    for (let i = 0; i < n; i++) {
      const a = i / n * 6.2832;
      const x = snap(r.x + Math.cos(a) * rad), y = snap(r.y + Math.sin(a) * rad * 0.9);
      if (x < vL - size || x > vR || y < vT - size || y > vB) continue;
      ctx.rect(x, y, size, size);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function draw(ctx: CanvasRenderingContext2D) {
    const cam = G.Camera;
    gk = allyAlpha();
    vL = cam.left() - 8; vT = cam.top() - 8; vR = cam.left() + cam.w + 8; vB = cam.top() + cam.h + 8;
    for (const b of beams) drawBeam(ctx, b);
    for (const s of slashes) drawSlash(ctx, s);
    for (const r of rings) drawRing(ctx, r);

    for (const p of parts) {
      if (p.x < vL - p.s || p.x > vR || p.y < vT - p.s || p.y > vB) continue;
      ctx.globalAlpha = step(1 - p.t / p.life) * (p.g ? gk : 1);
      ctx.fillStyle = p.color;
      ctx.fillRect(snap(p.x), snap(p.y), p.s, p.s);
    }
    ctx.globalAlpha = 1;

    for (const s of sprites) {
      if (!inView(s.x, s.y, 80)) continue;
      const k = 1 - s.t / s.life;
      if (s.twinkle) { G.Icons.twinkle(ctx, s.x, s.y, s.t / s.life, PX); continue; }
      G.VFX.draw(ctx, s.shape!, s.pal!, s.x, s.y, {
        angle: s.angle, scale: s.scale, alpha: (s.fade ? step(k) : 1) * (s.g ? gk : 1),
        frame: Math.floor(s.t * s.fr!)
      });
    }

    // Números de daño.
    // (el estado del lienzo se fija una vez; sólo cambian el alfa, el color y, a veces, la letra)
    if (texts.length) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,.75)';
      let big: boolean | null = null;
      for (const t of texts) {
        const k = 1 - t.t / t.life;
        if (!!t.big !== big) { big = !!t.big; ctx.font = (big ? '700 20px' : '700 13px') + ' Pixelify,"Segoe UI",sans-serif'; }
        ctx.globalAlpha = Math.min(1, k * 2.2);
        ctx.strokeText(t.s, t.x, t.y);
        ctx.fillStyle = t.color;
        ctx.fillText(t.s, t.x, t.y);
      }
      ctx.restore();
    }
  }

  return { clear, ghost, allyAlpha, px, burst, spark, sp, twinkle, trail, dmgText, ring, slash, beam, update, draw,
           get count() { return parts.length + sprites.length + texts.length; } };
})();
G.FX = FX;

declare module '../g' {
  interface Registry { FX: typeof FX }
}
