import { G } from '../g';
import type { Player } from '../entities/player';
import type { MoveInstance } from '../data/moves';
/* ============ hud.js — interfaz dentro del canvas ============
 * Se dibuja en coordenadas de PANTALLA (sin la transformación de cámara).
 */
/** Lo que el modo le cuenta al HUD: el reloj y qué piezas ocultar (la Defensa lleva las suyas). */
/** `noDown`: sin el aviso de caído del Survivor (en la Defensa el héroe se levanta solo, y en la Arena quien cae ya no vuelve). */
interface HudState { time: number; noLevel?: boolean; noClock?: boolean; noDown?: boolean }

export const HUD = (() => {
  const F = (w: number, s: number) => `${w} ${s}px Pixelify,"Segoe UI",system-ui,sans-serif`;

  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * Un efecto con tiempo (Danza Espada, poder de altar…): círculo con su icono
   * (o los segundos que quedan), un aro que se vacía según lo que le falta
   * (parpadea los 2 últimos segundos) y la etiqueta debajo.
   */
  function effect(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, frac: number, left: number,
                  col: string, label: string, icon: string | null) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.2832);
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.stroke();
    if (left < 2 && Math.floor(left * 6) % 2) ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + 6.2832 * G.U.clamp(frac, 0, 1));
    ctx.strokeStyle = col; ctx.lineCap = 'round'; ctx.stroke();
    ctx.textAlign = 'center';
    if (icon) G.Icons.draw(ctx, icon, cx - 10, cy - 10, 20);
    else { ctx.font = F(800, 11); ctx.fillStyle = col; ctx.fillText(String(Math.ceil(left)), cx, cy + 4); }
    ctx.globalAlpha = 1;
    ctx.font = F(800, 9);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(label, cx, cy + r + 11);
    ctx.fillStyle = col; ctx.fillText(label, cx, cy + r + 11);
    ctx.restore();
  }

  function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frac: number, col: string, bg = 'rgba(0,0,0,.55)') {
    roundRect(ctx, x, y, w, h, h / 2); ctx.fillStyle = bg; ctx.fill();
    if (frac > 0) {
      ctx.save();
      roundRect(ctx, x, y, w, h, h / 2); ctx.clip();
      ctx.fillStyle = col;
      ctx.fillRect(x, y, w * G.U.clamp(frac, 0, 1), h);
      ctx.restore();
    }
  }

  // Cursor en cruz mientras se apunta con él. Si el HUD deja de dibujarse (menú, fin de partida),
  // se quita solo en cuanto se mueve el ratón.
  let crossAt = 0;
  function crosshair() {
    const cv = document.getElementById('game');
    if (cv) cv.style.cursor = 'crosshair';
    crossAt = performance.now();
  }
  addEventListener('mousemove', () => {
    if (!crossAt || performance.now() - crossAt < 250) return;
    crossAt = 0;
    const cv = document.getElementById('game');
    if (cv) cv.style.cursor = '';
  });

  // ---------------- ficha de un movimiento (ratón sobre la barra) ----------------

  /** Parte `text` en líneas que quepan en `w` px con la fuente `font`. */
  function wrap(ctx: CanvasRenderingContext2D, text: string, w: number, font: string) {
    ctx.font = font;
    const out: string[] = [];
    let cur = '';
    for (const word of text.split(' ')) {
      const t = cur ? cur + ' ' + word : word;
      if (cur && ctx.measureText(t).width > w) { out.push(cur); cur = word; } else cur = t;
    }
    if (cur) out.push(cur);
    return out;
  }

  /** Movimientos que lanzan varias cosas por disparo: el daño de la ficha es el de cada una. */
  const MULTI = ['projectile', 'boomerang', 'nova', 'cone', 'orbit', 'meteor', 'mine'];

  /**
   * Una ficha: nombre, tipo, nivel, descripción, daño y recarga (ya con tus mejoras), la próxima
   * mejora y, si toca, la evolución. Con `draw` en false sólo mide. Devuelve el alto.
   * (El texto se traduce aquí antes de partirlo en líneas; el lienzo no traduce a trozos.)
   */
  function tipCard(ctx: CanvasRenderingContext2D, m: MoveInstance, pl: Player, x: number, y: number, w: number, draw: boolean) {
    const col = G.U.TYPE_COLOR[m.type];
    const num = (v: number) => (Math.round(v * 10) / 10).toString().replace('.', G.I18n.lang === 'es' ? ',' : '.');
    const text = (s: string, px: number, py: number, font: string, fill: string, align: CanvasTextAlign = 'left') => {
      if (!draw) return;
      ctx.font = font; ctx.fillStyle = fill; ctx.textAlign = align;
      ctx.fillText(s, px, py);
    };
    const y0 = y;

    if (draw) G.Icons.draw(ctx, 'move:' + m.id, x, y, 26);
    // (los tipos oscuros apenas se leen como texto: el nombre va en blanco y el tipo, con un punto de su color)
    text(m.name, x + 32, y + 12, F(800, 12), '#f4f8ff');
    if (draw) { ctx.fillStyle = col; ctx.fillRect(x + 32, y + 18, 6, 6); }
    text(G.T(G.U.TYPE_NAME[m.type]), x + 42, y + 24, F(600, 9), '#8fa3c4');
    text(G.I18n.f('Nv. {x}', m.lvl + '/' + m.def.maxLvl!), x + w, y + 12, F(700, 10), '#ffcb3d', 'right');
    y += 36;

    const lines = (s: string, font: string, fill: string, lh: number) => {
      for (const ln of wrap(ctx, s, w, font)) { text(ln, x, y, font, fill); y += lh; }
    };
    lines(G.T(m.desc), F(600, 10), '#c9d6ee', 13);
    y += 3;

    // daño y recarga con tus mejoras y objetos
    const stats: [string, string][] = [];
    if (m.dmg != null) stats.push([G.T('Daño'), Math.round(m.dmg * pl.atk) + (MULTI.includes(m.kind) && (m.count || 0) > 1 ? ' ×' + m.count : '')]);
    if (m.kind !== 'orbit') stats.push([G.T('Recarga'), num(m.cd * pl.cdMul) + ' s']);
    stats.forEach(([lab, val], i) => {
      const sx = x + i * (w / 2);
      text(lab, sx, y + 9, F(600, 9), '#8fa3c4');
      ctx.font = F(600, 9);
      const lw = ctx.measureText(lab).width;
      text(val, sx + lw + 5, y + 9, F(800, 11), '#ffffff');
    });
    if (stats.length) y += 20;

    const up = G.Moves.nextUpText(m);
    if (up) lines(G.T('Siguiente') + ': ' + G.T(up), F(600, 9), '#9fe3a8', 12);
    const ev = G.Moves.evoInfo(m, pl.statsTaken);
    if (ev) {
      lines(G.I18n.f('Evoluciona a {x}', ev.name), F(800, 10), '#ffd23f', 13);
      lines(ev.ready ? G.T('Condición cumplida: saldrá al subir de nivel') : G.I18n.f('Necesita la mejora {x}', ev.needName),
            F(600, 9), ev.ready ? '#9fe3a8' : '#8fa3c4', 12);
    }
    return y - y0;
  }

  /**
   * La ficha de un hueco de la barra: una sola, o en cuadrícula de 2 columnas si es un vínculo.
   * Va centrada sobre el hueco y no se sale de la pantalla.
   */
  function drawTip(ctx: CanvasRenderingContext2D, w: number, g: MoveInstance[], pl: Player, cx: number, top: number) {
    const CW = 210, PAD = 10, GAPX = 14, GAPY = 12;
    const cols = Math.min(2, g.length), rows = Math.ceil(g.length / 2);
    const hs = g.map(m => tipCard(ctx, m, pl, 0, 0, CW, false));
    const rowH = Array.from({ length: rows }, (_, r) => Math.max(...hs.slice(r * 2, r * 2 + 2)));
    const bw = cols * CW + (cols - 1) * GAPX + PAD * 2;
    const bh = rowH.reduce((a, b) => a + b, 0) + (rows - 1) * GAPY + PAD * 2;
    const bx = G.U.clamp(cx - bw / 2, 8, Math.max(8, w - bw - 8)), by = Math.max(8, top - 10 - bh);
    ctx.save();
    roundRect(ctx, bx, by, bw, bh, 10);
    ctx.fillStyle = 'rgba(8,14,26,.95)'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = g.length > 1 ? '#ff8ad8' : G.U.TYPE_COLOR[g[0].type]; ctx.stroke();
    let ry = by + PAD;
    g.forEach((m, i) => {
      const r = Math.floor(i / 2);
      if (i % 2 === 0 && r > 0) ry += rowH[r - 1] + GAPY;
      tipCard(ctx, m, pl, bx + PAD + (i % 2) * (CW + GAPX), ry, CW, true);
    });
    ctx.restore();
  }

  function draw(ctx: CanvasRenderingContext2D, w: number, h: number, pl: Player, st: HudState) {
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    G.Touch.clearButtons();
    const touch = G.Touch.active;
    if (pl.aimPt && !pl.dead) crosshair();

    // ---------- barra de experiencia (borde superior) ----------
    // (La Defensa no tiene experiencia: ni barra ni nivel.)
    if (!st.noLevel) {
      const xpF = pl.xp / pl.xpNext;
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(0, 0, w, 12);
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#4fd1ff'); g.addColorStop(1, '#a98bff');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w * G.U.clamp(xpF, 0, 1), 12);
      // Números sobre la barra: "24 / 62 XP · 38%".
      ctx.font = F(800, 9);
      ctx.textAlign = 'center';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)';
      const xpTxt = Math.floor(pl.xp) + ' / ' + pl.xpNext + ' XP · ' + Math.floor(G.U.clamp(xpF, 0, 1) * 100) + '%';
      ctx.strokeText(xpTxt, w / 2, 9);
      ctx.fillStyle = '#fff';
      ctx.fillText(xpTxt, w / 2, 9);
    }

    // ---------- vida + nivel ----------
    const px = 16, py = 20;
    ctx.font = F(800, 13);
    ctx.fillStyle = '#eaf2ff';
    ctx.textAlign = 'left';
    ctx.fillText(pl.mon.name, px, py + 10);

    ctx.font = F(700, 11);
    ctx.fillStyle = '#ffcb3d';
    if (!st.noLevel) ctx.fillText('Nv. ' + pl.level, px, py + 26);

    bar(ctx, px + 48, py + 17, 168, 11, pl.hp / pl.maxHp, '#ff5f6d');
    ctx.font = F(700, 10);
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.textAlign = 'center';
    ctx.fillText(Math.ceil(pl.hp) + ' / ' + Math.round(pl.maxHp), px + 48 + 84, py + 26);

    // buffs activos: icono del movimiento y aro con el tiempo que les queda
    const COL: Record<string, string> = { atk: '#ff6b4d', spd: '#7fe0ff', def: '#b0b8c8', regen: '#5fe08a' };
    const LBL: Record<string, string> = { atk: 'ATK', spd: 'VEL', def: 'DEF', regen: 'REG' };
    const ER = 15, ey = py + 36 + ER;
    let bx = px;
    for (const k in pl.buffs) {
      const b = pl.buffs[k as keyof typeof pl.buffs];
      if (b.n <= 0) continue;
      effect(ctx, bx + ER, ey, ER, b.dur ? b.t / b.dur : 1, b.t, COL[k], LBL[k] + ' ×' + b.n, b.src && 'move:' + b.src);
      bx += ER * 2 + 12;
    }

    // ---------- reloj / bioma / kills ----------
    // (Un modo con su propio marcador arriba, como la Defensa, lo quita con st.noClock.)
    ctx.textAlign = 'center';
    if (!st.noClock) {
      ctx.font = F(800, 26);
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.fillText(G.U.mmss(st.time), w / 2, 42);
      ctx.font = F(600, 10);
      ctx.fillStyle = '#8fa3c4';
      ctx.fillText(G.World.biomeName().toUpperCase() + '  ·  ' + pl.kills + ' DERROTADOS  ·  ' + pl.coins + ' MONEDAS', w / 2, 58);
    }

    // ---------- clima (arriba a la derecha) ----------
    const wx = G.Weather.current;
    if (wx) {
      ctx.font = F(800, 11);
      ctx.textAlign = 'left';
      const txt = wx.name.toUpperCase() + ' · ' + Math.ceil(wx.left) + 's';
      const tw = ctx.measureText(txt).width + 40;
      const x0 = w - tw - 16 - (touch ? 56 : 0), y0 = 14;
      roundRect(ctx, x0, y0, tw, 26, 9);
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fill();
      G.Icons.draw(ctx, wx.icon, x0 + 6, y0 + 3, 20);
      ctx.fillStyle = wx.color;
      ctx.fillText(txt, x0 + 32, y0 + 17);
    }

    // ---------- barra del jefe ----------
    const boss = G.EnemyMgr.all().find(e => e.boss && !e.dead);
    if (boss) {
      const bw = Math.min(420, w - 80);
      bar(ctx, (w - bw) / 2, 70, bw, 12, boss.hp / boss.maxHp, '#ffcb3d');
      ctx.font = F(800, 10);
      ctx.fillStyle = '#20160a';
      ctx.fillText(boss.name.toUpperCase(), w / 2, 80);
    }

    // ---------- aviso ----------
    // ---------- shinies fuera de pantalla: destello en el borde ----------
    const cam = G.Camera, pulse = 0.6 + Math.sin(performance.now() / 160) * 0.4;
    for (const e of G.EnemyMgr.shinies()) {
      const sx = (e.x - cam.left()) * cam.scale, sy = (e.y - cam.top()) * cam.scale;
      if (sx > 0 && sx < w && sy > 0 && sy < h) continue;
      const M = 34;
      const ex = G.U.clamp(sx, M, w - M), ey = G.U.clamp(sy, M + 60, h - M - 70);
      const a = Math.atan2(sy - ey, sx - ex);
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.translate(ex, ey);
      ctx.fillStyle = '#9ae6ff';
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 24, Math.sin(a) * 24);
      ctx.lineTo(Math.cos(a + 2.5) * 12, Math.sin(a + 2.5) * 12);
      ctx.lineTo(Math.cos(a - 2.5) * 12, Math.sin(a - 2.5) * 12);
      ctx.fill();
      ctx.globalAlpha = 1;
      G.Icons.draw(ctx, 'shiny', -12, -12, 24);
      ctx.restore();
    }
    // El jefe fuera de pantalla: flecha dorada en el borde hacia donde está.
    if (boss) {
      const sx = (boss.x - cam.left()) * cam.scale, sy = (boss.y - cam.top()) * cam.scale;
      if (!(sx > 0 && sx < w && sy > 0 && sy < h)) {
        const M = 34;
        const ex = G.U.clamp(sx, M, w - M), ey = G.U.clamp(sy, M + 60, h - M - 70);
        const a = Math.atan2(sy - ey, sx - ex);
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.translate(ex, ey);
        ctx.fillStyle = '#ffcb3d';
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 24, Math.sin(a) * 24);
        ctx.lineTo(Math.cos(a + 2.5) * 12, Math.sin(a + 2.5) * 12);
        ctx.lineTo(Math.cos(a - 2.5) * 12, Math.sin(a - 2.5) * 12);
        ctx.fill();
        ctx.globalAlpha = 1;
        G.Icons.draw(ctx, 'crown', -12, -12, 24);
        ctx.restore();
      }
    }

    // Poder de altar activo.
    if (pl.power) {
      const pw = pl.power;
      effect(ctx, bx + ER, ey, ER, pw.t / pw.dur, pw.t, pw.def.color, pw.def.name.toUpperCase(), null);
      bx += ER * 2 + 12;
    }

    // En cooperativo la lista del grupo baja para hacerle sitio a los efectos.
    if (G.Coop.active) drawCoop(ctx, w, h, pl, px, py + (bx > px ? 84 : 40), !!st.noDown);

    // Grieta: flecha grande que late en el borde si no se ve, y si se ve, una
    // flecha que bota encima; en la arena, cuenta atrás.
    const rift = G.Rift.rift;
    if (rift) {
      const sx = (rift.x - cam.left()) * cam.scale, sy = (rift.y - 40 - cam.top()) * cam.scale;
      const now = performance.now() / 1000, beat = 0.5 + Math.sin(now * 7) * 0.5;
      const label = 'GRIETA · ' + Math.round(G.U.dist(pl.x, pl.y, rift.x, rift.y) / 32) + ' m · ' + Math.ceil(rift.ttl) + ' s';
      const off = sx < 0 || sx > w || sy < 0 || sy > h;
      ctx.save();
      if (off) {
        const M = 52, ex = G.U.clamp(sx, M, w - M), ey = G.U.clamp(sy, M + 70, h - M - 80);
        const a = Math.atan2(sy - ey, sx - ex), ca = Math.cos(a), sa = Math.sin(a);
        ctx.translate(ex, ey);
        // Halo que late.
        ctx.globalAlpha = 0.18 + beat * 0.22;
        ctx.fillStyle = '#b48aff';
        ctx.beginPath(); ctx.arc(0, 0, 30 + beat * 8, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = 1;
        const tri = (k: number) => {
          ctx.beginPath();
          ctx.moveTo(ca * 40 * k, sa * 40 * k);
          ctx.lineTo(Math.cos(a + 2.45) * 20 * k, Math.sin(a + 2.45) * 20 * k);
          ctx.lineTo(Math.cos(a - 2.45) * 20 * k, Math.sin(a - 2.45) * 20 * k);
          ctx.closePath();
        };
        tri(1.12); ctx.fillStyle = '#1a0b33'; ctx.fill();
        tri(1); ctx.fillStyle = beat > 0.5 ? '#e2d0ff' : '#a06bff'; ctx.fill();
        ctx.font = F(800, 12);
        ctx.textAlign = ca > 0.3 ? 'right' : ca < -0.3 ? 'left' : 'center';
        const lx = -ca * 34, ly = -sa * 30 + 4;
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.85)';
        ctx.strokeText(label, lx, ly);
        ctx.fillStyle = '#e2d0ff';
        ctx.fillText(label, lx, ly);
      } else {
        // Encima de la grieta: flecha hacia abajo que bota.
        const by = sy - 46 - Math.abs(Math.sin(now * 4)) * 10;
        ctx.translate(sx, by);
        ctx.beginPath(); ctx.moveTo(-15, -12); ctx.lineTo(15, -12); ctx.lineTo(0, 8); ctx.closePath();
        ctx.lineWidth = 4; ctx.strokeStyle = '#1a0b33'; ctx.stroke();
        ctx.fillStyle = beat > 0.5 ? '#e2d0ff' : '#a06bff'; ctx.fill();
        ctx.font = F(800, 11); ctx.textAlign = 'center';
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.85)';
        const l2 = 'GRIETA · ' + Math.ceil(rift.ttl) + ' s';
        ctx.strokeText(l2, 0, -18); ctx.fillStyle = '#e2d0ff'; ctx.fillText(l2, 0, -18);
      }
      ctx.restore();
    }
    if (G.Rift.inArena) {
      ctx.textAlign = 'center';
      ctx.font = F(800, 12);
      ctx.fillStyle = '#d9c2ff';
      ctx.fillText('GRIETA · ' + G.U.mmss(G.Rift.timeLeft), w / 2, boss ? 98 : 76);
    }

    // Eventos: cuenta atrás, flecha al Pokémon perdido / a la marca y a los duendes.
    G.Events.drawHud(ctx, w, h, pl, F);

    // Aviso propio al abrirse una grieta (no lo tapan los otros avisos).
    if (rift && rift.t < 4.5) {
      const a = Math.min(1, rift.t * 4, (4.5 - rift.t) * 2), pop = 1 + Math.max(0, 0.25 - rift.t) * 1.6;
      const y0 = h * 0.2;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(w / 2, y0); ctx.scale(pop, pop);
      ctx.font = F(800, 20);
      const t1 = '¡SE HA ABIERTO UNA GRIETA!', t2 = 'Sigue la flecha morada: dentro te espera un legendario';
      const bw = Math.min(w - 24, Math.max(ctx.measureText(t1).width, (ctx.font = F(700, 11), ctx.measureText(t2).width)) + 36);
      roundRect(ctx, -bw / 2, -26, bw, 52, 10);
      ctx.fillStyle = 'rgba(26,11,51,.88)'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#b48aff'; ctx.stroke();
      ctx.textAlign = 'center';
      ctx.font = F(800, 20); ctx.fillStyle = '#e2d0ff'; ctx.fillText(t1, 0, -2);
      ctx.font = F(700, 11); ctx.fillStyle = '#c9b0ff'; ctx.fillText(t2, 0, 16);
      ctx.restore();
    }

    const ban = G.Spawner.banner();
    if (ban) {
      const a = Math.min(1, ban.t * 1.6);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = F(800, 22);
      ctx.fillStyle = '#ffcb3d';
      ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 4;
      ctx.strokeText(ban.text!, w / 2, h * 0.3);
      ctx.fillText(ban.text!, w / 2, h * 0.3);
      ctx.restore();
    }

    // ---------- ranura de movimientos ----------
    const S = 54, GAP = 9;
    const n = Math.max(1, pl.slots.length);
    const totalW = n * S + (n - 1) * GAP;
    let sx = (w - totalW) / 2;
    // Por encima de la barra de inicio del iPhone (allí los toques a veces no llegan).
    const sy = h - S - 18 - (touch ? Math.min(28, G.Touch.safeArea().bottom) : 0);
    const BOND = '#ff8ad8';
    const cdOf = (m: MoveInstance) => m.kind === 'orbit' ? 0 : G.U.clamp(m.t / (m.cd * pl.cdMul), 0, 1);
    // Ficha del movimiento bajo el ratón (sólo con ratón: en táctil no hay "encima").
    const mo = G.Input.mouse();
    let tip: { g: MoveInstance[]; cx: number; top: number } | null = null;

    for (let i = 0; i < n; i++) {
      const g: MoveInstance[] = pl.slots[i] || [];
      const m = g[0];
      const fused = g.length > 1;
      const on = i === pl.active;
      const x = sx + i * (S + GAP);
      const y = on ? sy - 6 : sy;
      // Tocar (o hacer clic en) un icono activa ese movimiento.
      if (m) G.Touch.addButton(x, y, S, S, () => { if (G.Game.state === 'playing' && pl.active !== i) { pl.setActive(i); G.Audio.sfx('click'); } }, GAP / 2 + 3);
      const col = m ? G.U.TYPE_COLOR[m.type] : '#4a5468';
      if (m && !touch && mo.over && mo.x >= x - GAP / 2 && mo.x <= x + S + GAP / 2 && mo.y >= sy - 8 && mo.y <= sy + S + 8) {
        tip = { g, cx: x + S / 2, top: Math.min(y, sy) - 14 };
      }

      // fondo
      roundRect(ctx, x, y, S, S, 12);
      ctx.fillStyle = on ? 'rgba(20,30,50,.95)' : 'rgba(10,16,28,.8)';
      ctx.fill();
      ctx.lineWidth = on ? 2.5 : fused || (m && m.evolved) ? 2 : 1.2;
      // Vínculo: borde rosa. Evolucionado: dorado.
      ctx.strokeStyle = fused ? BOND : m && m.evolved ? '#ffd23f' : on ? col : 'rgba(140,170,210,.22)';
      ctx.stroke();

      if (!m) continue;

      if (fused) {
        // Vínculo: los movimientos en una cuadrícula de 2×2, cada uno con su recarga.
        const C = 22, P = (S - C * 2) / 3;
        g.forEach((gm, k) => {
          const cx = x + P + (k % 2) * (C + P), cy = y + P + Math.floor(k / 2) * (C + P);
          G.Icons.draw(ctx, 'move:' + gm.id, cx, cy, C);
          const f = cdOf(gm);
          if (f > 0) { ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(cx, cy, C, C * f); }
          if (gm.evolved) { ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 1; ctx.strokeRect(cx + 0.5, cy + 0.5, C - 1, C - 1); }
          // Destello al lanzarse.
          const fl = 1 - (performance.now() - (gm.castAt || 0)) / 180;
          if (fl > 0) { ctx.fillStyle = 'rgba(255,255,255,' + (fl * 0.55).toFixed(2) + ')'; ctx.fillRect(cx, cy, C, C); }
        });
      } else {
        // recarga: se vacía de abajo a arriba
        const cdFrac = cdOf(m);
        if (cdFrac > 0) {
          ctx.save();
          roundRect(ctx, x, y, S, S, 12); ctx.clip();
          ctx.fillStyle = 'rgba(0,0,0,.6)';
          ctx.fillRect(x, y, S, S * cdFrac);
          ctx.restore();
        }

        // emblema del tipo + insignia de la familia
        G.Icons.draw(ctx, 'move:' + m.id, x + (S - 32) / 2, y + (S - 32) / 2 - 2, 32);

        // nivel del movimiento (puntitos)
        const dots = m.def.maxLvl!;
        const dw = 4, dgap = 2;
        const tw = dots * dw + (dots - 1) * dgap;
        for (let d = 0; d < dots; d++) {
          ctx.fillStyle = d < m.lvl ? col : 'rgba(255,255,255,.18)';
          ctx.fillRect(x + (S - tw) / 2 + d * (dw + dgap), y + S - 9, dw, 3);
        }
      }

      // tecla
      ctx.font = F(800, 9);
      ctx.fillStyle = fused ? BOND : on ? col : 'rgba(180,200,230,.6)';
      ctx.textAlign = 'left';
      ctx.fillText(String(i + 1), x + 3, y + 10);

      // nombre encima del activo (con un vínculo: "Ascuas +2")
      if (on) {
        ctx.font = F(700, 10);
        ctx.textAlign = 'center';
        ctx.fillStyle = fused ? BOND : col;
        ctx.fillText(fused ? m.name + ' +' + (g.length - 1) : m.name, x + S / 2, y - 7);
      }
    }

    // ---------- vínculo guardado (aún no hay dos movimientos sueltos) ----------
    if (pl.bonds > 0) {
      const bx = sx + totalW + 12, by = sy + S / 2 - 12;
      G.Icons.draw(ctx, 'bond', bx, by, 24);
      if (pl.bonds > 1) {
        ctx.font = F(800, 10);
        ctx.textAlign = 'left';
        ctx.fillStyle = BOND;
        ctx.fillText('×' + pl.bonds, bx + 25, by + 20);
      }
    }

    // ---------- objeto equipado (a la izquierda de los movimientos) ----------
    {
      const ix = sx - S - 18, iy = sy;
      roundRect(ctx, ix, iy, S, S, 12);
      ctx.fillStyle = pl.item ? 'rgba(40,30,10,.9)' : 'rgba(10,16,28,.55)';
      ctx.fill();
      ctx.lineWidth = pl.item ? 2 : 1;
      ctx.strokeStyle = pl.item ? '#ffd23f' : 'rgba(140,170,210,.18)';
      ctx.stroke();
      if (pl.item) {
        G.Icons.draw(ctx, pl.item, ix + (S - 36) / 2, iy + (S - 36) / 2, 36);
        ctx.font = F(700, 9);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffd23f';
        ctx.fillText(G.Items.BY[pl.item].name, ix + S / 2, iy - 6);
      }
    }

    // ---------- botón de pausa (táctil) ----------
    if (touch) {
      const sa = G.Touch.safeArea();
      const bx = w - 52 - Math.min(44, sa.right), by = 12 + Math.min(20, sa.top), bs = 40;
      roundRect(ctx, bx, by, bs, bs, 10);
      ctx.fillStyle = 'rgba(10,16,28,.7)'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(244,248,255,.8)'; ctx.stroke();
      ctx.fillStyle = '#f4f8ff';
      ctx.fillRect(bx + 13, by + 11, 5, 18); ctx.fillRect(bx + 22, by + 11, 5, 18);
      G.Touch.addButton(bx, by, bs, bs, () => G.Game.togglePause(), 8);
    }

    if (tip) drawTip(ctx, w, tip.g, pl, tip.cx, tip.top);

    // pista de controles
    if (st.time < 14) {
      ctx.font = F(600, 10);
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(180,200,230,.55)';
      ctx.fillText(touch ? 'Arrastra el dedo para moverte  ·  toca un ataque para cambiarlo'
                         : 'WASD moverse  ·  1-4 / Q / E o clic en un ataque para cambiarlo  ·  Esc pausa', w / 2, h - 4);
    }

    ctx.restore();
  }

  // ---------------- cooperativo ----------------

  /**
   * - Vida de cada compañero debajo de la tuya.
   * - Flecha en el borde de la pantalla hacia los que no se ven, con su nombre
   *   y a cuántos metros están (roja y parpadeando si está caído).
   * - Si has caído tú: aviso y barra de "te están levantando".
   */
  function drawCoop(ctx: CanvasRenderingContext2D, w: number, h: number, pl: Player, px: number, top: number, noDown = false) {
    const cam = G.Camera;
    const t = performance.now() / 1000;
    let y = top;
    ctx.textAlign = 'left';
    for (const m of G.Coop.mates) {
      if (!m.connected) continue;
      const o = m.pl;
      ctx.font = F(800, 10);
      ctx.fillStyle = m.color;
      ctx.fillText(m.name, px, y + 9);
      const lx = px + 78;
      bar(ctx, lx, y + 1, 110, 8, o.dead ? 0 : o.hp / o.maxHp, o.dead ? '#ff5f6d' : '#5fe08a');
      if (o.dead) {
        ctx.font = F(800, 9);
        ctx.fillStyle = Math.sin(t * 8) > 0 ? '#ff8a96' : '#ffd0d5';
        ctx.fillText('CAÍDO', lx + 116, y + 9);
      }
      y += 15;
    }

    // Flechas hacia los compañeros fuera de la vista.
    for (const m of G.Coop.mates) {
      if (!m.connected) continue;
      const o = m.pl;
      const sx = (o.x - cam.left()) * cam.scale, sy = (o.y - o.bodyH * 0.5 - cam.top()) * cam.scale;
      if (sx > 0 && sx < w && sy > 0 && sy < h) continue;
      const M = 42;
      const ex = G.U.clamp(sx, M, w - M), ey = G.U.clamp(sy, M + 70, h - M - 80);
      const a = Math.atan2(sy - ey, sx - ex);
      const metres = Math.round(G.U.dist(pl.x, pl.y, o.x, o.y) / 32);
      const col = o.dead ? (Math.sin(t * 8) > 0 ? '#ff5f6d' : '#ffd0d5') : m.color;
      ctx.save();
      ctx.translate(ex, ey);
      // Flecha
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath(); ctx.arc(0, 0, 17, 0, 6.2832); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 28, Math.sin(a) * 28);
      ctx.lineTo(Math.cos(a + 2.4) * 14, Math.sin(a + 2.4) * 14);
      ctx.lineTo(Math.cos(a - 2.4) * 14, Math.sin(a - 2.4) * 14);
      ctx.closePath(); ctx.fill();
      // Inicial del compañero dentro del círculo
      ctx.font = F(800, 14);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.fillText(m.name.charAt(0).toUpperCase(), 0, 5);
      // Nombre y distancia: al lado contrario de la flecha, para que no se salga
      const lx = -Math.cos(a) * 30, ly = -Math.sin(a) * 26 + 4;
      ctx.font = F(800, 12);
      const label = (o.dead ? '¡' + m.name + ' necesita ayuda! ' : m.name + ' ') + '· ' + metres + ' m';
      ctx.textAlign = Math.cos(a) > 0.3 ? 'right' : Math.cos(a) < -0.3 ? 'left' : 'center';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.strokeText(label, lx, ly);
      ctx.fillStyle = col;
      ctx.fillText(label, lx, ly);
      ctx.restore();
    }

    // Tú, caído.
    if (pl.dead && !noDown) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = F(800, 20);
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.75)';
      const msg = G.Coop.players().every(p => p.dead) ? 'Habéis caído todos…' : 'Has caído: un compañero puede levantarte';
      ctx.strokeText(msg, w / 2, h * 0.62);
      ctx.fillStyle = '#ffb0b8';
      ctx.fillText(msg, w / 2, h * 0.62);
      const f = (pl.reviveT || 0) / G.Player.REVIVE_TIME;
      if (f > 0) bar(ctx, w / 2 - 110, h * 0.62 + 12, 220, 10, f, '#5fe08a');
      // La cámara va libre mientras estás caído (modes/survivor.ts).
      const hint = G.Touch.active ? 'Mueve la cámara con el joystick' : 'Mueve la cámara · Tab: seguir a un compañero';
      ctx.font = F(800, 12);
      ctx.lineWidth = 3;
      ctx.strokeText(hint, w / 2, h * 0.62 + 40);
      ctx.fillStyle = '#e8ecff';
      ctx.fillText(hint, w / 2, h * 0.62 + 40);
      ctx.restore();
    }
  }

  return { draw, roundRect, bar };
})();
G.HUD = HUD;

declare module '../g' {
  interface Registry { HUD: typeof HUD }
}
