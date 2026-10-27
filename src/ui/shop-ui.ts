import { G } from '../g';
/* ============ shop-ui.ts — Tienda Kecleon ============
 * Menta, Cápsulas Habilidad y las 8 MT del día (lógica y precios en data/shop.ts), con la Mochila resumida arriba.
 * Lo comprado se usa desde la ficha de cada Pokémon en la colección (ui/menu.ts, monExtras).
 */
export const ShopUI = (() => {
  const $ = G.UI.$;
  const KECLEON = 352;
  const SAYS = [
    '¡Bienvenido! Mentas, Cápsulas y MT recién llegadas.',
    'Las MT cambian cada día: lo que ves hoy, mañana no estará.',
    'Una Menta y tu Pokémon cambia de carácter.',
    'Una Cápsula y tu Pokémon descubre otra habilidad.',
    '¿Buscas algo para tu compañero? Mira las MT de hoy.'
  ];

  /* ---- el puesto, dibujado por código en una cuadrícula de 160×88 (dos capas: fondo y mostrador) ---- */
  const SW = 160, SH = 88, COUNTER = 60;
  const px = (c: CanvasRenderingContext2D, col: string, x: number, y: number, w = 1, h = 1) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
  /** Círculo relleno en píxeles (cx, cy es el centro). */
  function disc(c: CanvasRenderingContext2D, col: string, cx: number, cy: number, r: number) {
    for (let y = -r; y <= r; y++) {
      const w = Math.floor(Math.sqrt(r * r + r - y * y + 0.25));
      px(c, col, cx - w, cy + y, 2 * w + 1, 1);
    }
  }
  /** Frasco de Menta: el pie en (x, base). */
  function jar(c: CanvasRenderingContext2D, x: number, base: number, col: string, lid: string) {
    px(c, '#0b1838', x - 1, base - 11, 9, 12);
    px(c, col, x, base - 8, 7, 8);
    px(c, 'rgba(255,255,255,.55)', x + 1, base - 7, 1, 5);
    px(c, 'rgba(0,0,0,.18)', x + 5, base - 7, 1, 7);
    px(c, lid, x + 1, base - 10, 5, 2);
    px(c, '#f4f8ff', x + 2, base - 5, 3, 2);       // etiqueta
  }
  /** Cápsula tumbada de 14×7 con las esquinas redondeadas: cabeza de color, mitad blanca. */
  function capsule(c: CanvasRenderingContext2D, x: number, base: number, col: string) {
    const y = base - 7;
    px(c, '#0b1838', x + 1, y, 12, 7); px(c, '#0b1838', x, y + 1, 14, 5);
    px(c, col, x + 1, y + 1, 6, 5); px(c, '#f4f8ff', x + 7, y + 1, 6, 5);
    px(c, col, x + 2, y + 1, 5, 1); px(c, 'rgba(255,255,255,.55)', x + 2, y + 2, 4, 1);
    px(c, 'rgba(0,0,0,.22)', x + 7, y + 5, 6, 1);
    px(c, '#0b1838', x + 7, y + 1, 1, 5);
  }
  /** Disco de MT de canto, del color de un tipo. */
  function tmDisc(c: CanvasRenderingContext2D, cx: number, cy: number, col: string) {
    disc(c, '#0b1838', cx, cy, 7);
    disc(c, col, cx, cy, 6);
    disc(c, 'rgba(255,255,255,.28)', cx - 1, cy - 1, 4);
    disc(c, col, cx, cy, 3);
    disc(c, '#0b1838', cx, cy, 1);
    px(c, '#fff', cx - 4, cy - 4, 2, 1); px(c, '#fff', cx - 5, cy - 3, 1, 1);
  }

  function drawStall() {
    const back = $<HTMLCanvasElement>('shop-back').getContext('2d')!, front = $<HTMLCanvasElement>('shop-front').getContext('2d')!;
    back.clearRect(0, 0, SW, SH); front.clearRect(0, 0, SW, SH);
    // Pared del fondo: tablones azules oscuros.
    px(back, '#14244e', 0, 0, SW, SH);
    for (let x = 0; x < SW; x += 16) { px(back, '#101d42', x, 0, 1, SH); px(back, '#1a2d5e', x + 1, 0, 1, SH); }
    // Toldo a rayas verdes y crema, con volante festoneado.
    const GREEN = '#43b06a', GREEN_D = '#2f8a50', CREAM = '#f4f8ff', CREAM_D = '#c9d6ee';
    for (let i = 0; i * 10 < SW; i++) {
      const g = i % 2 === 0, x = i * 10;
      px(back, g ? GREEN : CREAM, x, 0, 10, 17);
      px(back, g ? GREEN_D : CREAM_D, x, 12, 10, 5);
      px(back, g ? '#6ad58d' : '#fff', x, 0, 10, 2);
      for (let dy = 0; dy < 5; dy++) {              // media luna
        const w = Math.round(Math.sqrt(25 - dy * dy)) ;
        px(back, g ? GREEN_D : CREAM_D, x + 5 - w, 17 + dy, 2 * w, 1);
      }
    }
    px(back, 'rgba(0,0,0,.28)', 0, 22, SW, 4);       // sombra bajo el toldo
    px(back, 'rgba(0,0,0,.15)', 0, 26, SW, 3);
    // Farolillos colgando de una cuerda.
    for (const lx of [30, 80, 130]) {
      px(back, '#0b1838', lx, 22, 1, 4);
      px(back, '#0b1838', lx - 3, 26, 7, 8);
      px(back, '#ffd35a', lx - 2, 27, 5, 6);
      px(back, '#fff4b8', lx - 1, 28, 2, 3);
      disc(back, 'rgba(255,211,90,.1)', lx, 30, 9);
    }
    // Suelo de tierra tras el mostrador.
    px(back, '#0e1a3c', 0, 76, SW, 12);

    // ---- Mostrador (capa de delante) ----
    px(front, '#0b1838', 0, COUNTER - 1, SW, 1);
    px(front, '#c58a52', 0, COUNTER, SW, 3);
    px(front, '#e0a96d', 0, COUNTER, SW, 1);
    px(front, '#8d5a2f', 0, COUNTER + 3, SW, SH - COUNTER - 3);
    for (let x = 0; x < SW; x += 12) { px(front, '#6f4624', x, COUNTER + 3, 1, SH - COUNTER - 3); px(front, '#a06a3b', x + 1, COUNTER + 3, 1, SH - COUNTER - 3); }
    px(front, '#5a3719', 0, COUNTER + 3, SW, 1);
    px(front, 'rgba(0,0,0,.25)', 0, SH - 4, SW, 4);
    // Postes del toldo.
    for (const x of [0, SW - 5]) { px(front, '#0b1838', x, 0, 5, SH); px(front, '#a06a3b', x + 1, 0, 3, SH); px(front, '#c58a52', x + 1, 0, 1, SH); }
    // Tablilla con una moneda en el frente del mostrador.
    px(front, '#0b1838', 62, 67, 36, 15); px(front, '#e8c88c', 63, 68, 34, 13); px(front, '#c9a56a', 63, 79, 34, 2);
    disc(front, '#0b1838', 80, 74, 5); disc(front, '#ffc93c', 80, 74, 4); disc(front, '#ffe58a', 79, 73, 2);
    px(front, '#c8901e', 80, 71, 1, 6);
    px(front, '#8d5a2f', 68, 74, 6, 1); px(front, '#8d5a2f', 87, 74, 6, 1);

    // Mercancía sobre el mostrador: Mentas, Cápsulas y discos de MT.
    jar(front, 9, COUNTER, '#ff8fb0', '#ffd0dc'); jar(front, 19, COUNTER, '#6bb6ff', '#cfe6ff'); jar(front, 29, COUNTER, '#7ee07a', '#d4f7cf');
    jar(front, 14, COUNTER - 12, '#ffd35a', '#fff0b8');
    capsule(front, 66, COUNTER, '#ff6b6b'); capsule(front, 81, COUNTER, '#b48cff'); capsule(front, 73, COUNTER - 7, '#ffc93c');
    tmDisc(front, 122, COUNTER - 7, '#f08030'); tmDisc(front, 137, COUNTER - 7, '#6890f0'); tmDisc(front, 129, COUNTER - 17, '#78c850');
  }

  const price = (n: number) => `<span class="coin"></span> ${n.toLocaleString('es')}`;

  function open() {
    G.UI.show('scr-shop', true);
    drawStall();
    // Detrás del mostrador, a la escala del puesto (1 píxel de arte = 1 de la cuadrícula): el normal y el shiny.
    G.UI.sprite($('shop-keck'), KECLEON, { lively: true, scale: 1, shadow: false });
    G.UI.sprite($('shop-keck2'), KECLEON, { lively: true, scale: 1, shadow: false, shiny: true });
    $('scr-shop').querySelector<HTMLElement>('.shop-stall')!.style.setProperty('--stage-c', G.U.TYPE_COLOR.normal);
    $('shop-bubble').textContent = G.T(G.U.pick(SAYS));
    render();
  }

  /** Cuántos de tus Pokémon pueden aprender esta MT (y si tu compañero puede). */
  function learners(id: string): { n: number; partner: boolean } {
    const s = G.DB.save;
    let n = 0;
    for (const d of Object.keys(s.owned)) if (G.Mons.canLearn(+d, id)) n++;
    return { n, partner: !!s.partner && G.Mons.canLearn(s.partner, id) };
  }

  function bagLine(): string {
    const items = G.Shop.ORDER.filter(id => G.Shop.count(id)).map(id => `${G.T(G.Mons.name(G.Shop.ITEMS[id].name))} ×${G.Shop.count(id)}`);
    const tms = Object.keys(G.DB.save.tms || {}).filter(id => G.Shop.tmCount(id) && G.Moves.BY_ID[id]).map(id => G.Moves.BY_ID[id].name);
    if (!items.length && !tms.length) return G.T('Tu Mochila está vacía. Lo que compres se usa desde la ficha de cada Pokémon (Pokémon → elige uno).');
    return G.T('Mochila:') + ' ' + [...items, ...(tms.length ? [G.T('MT') + ': ' + tms.map(m => G.T(m)).join(', ')] : [])].join(' · ')
      + ' — ' + G.T('se usan desde la ficha de cada Pokémon.');
  }

  function render() {
    const s = G.DB.save;
    $('shop-bag').textContent = bagLine();
    const items = G.Shop.ORDER.map(id => {
      const it = G.Shop.ITEMS[id], have = G.Shop.count(id), full = have >= G.Shop.MAX_ITEM;
      return `<div class="panel shop-item">
        <div class="ic">${G.Icons.html(it.icon, 32)}</div>
        <div><b>${G.Mons.name(it.name)}</b> <small class="muted">${have ? '×' + have : ''}</small>
          <div class="sub" style="margin:2px 0 0">${G.Mons.name(it.desc)}</div></div>
        <button class="btn small gold" data-buy="${id}" data-sfx="none" ${s.coins < it.price || full ? 'disabled' : ''}>${price(it.price)}</button>
      </div>`;
    }).join('');
    const tms = G.Shop.dailyTms(G.Shop.today(), s.partner).map(id => {
      const d = G.Moves.BY_ID[id], p = G.Shop.tmPrice(id), l = learners(id), has = G.Shop.tmCount(id) > 0;
      const note = has ? G.T('Ya la llevas en la Mochila')
        : l.partner ? G.T('Tu compañero puede aprenderla')
        : l.n ? G.I18n.f('La pueden aprender {x} de tus Pokémon', l.n) : G.T('Ninguno de tus Pokémon puede aprenderla');
      return `<div class="panel shop-item tm">
        <div class="ic">${G.Icons.html('move:' + d.id, 28)}</div>
        <div><b>${d.name}</b> ${G.U.TYPE_NAME[d.type]}${d.cat ? ' · ' + G.T(G.Moves.CAT_NAME[d.cat]) : ''}
          <div class="sub" style="margin:2px 0 0">${d.desc}</div>
          <div class="sub shop-note${l.partner && !has ? ' ok' : ''}" style="margin:2px 0 0">${note}</div></div>
        <button class="btn small gold" data-buy="tm:${id}" data-sfx="none" ${s.coins < p || has ? 'disabled' : ''}>${has ? '✓' : price(p)}</button>
      </div>`;
    }).join('');
    $('shop-body').innerHTML = `
      <h3 class="shop-h">Objetos en venta</h3>${items}
      <h3 class="shop-h">${G.Icons.html('tm', 18)} MT de hoy</h3>
      <p class="sub" style="margin:0 0 6px">8 nuevas cada día (a medianoche, hora de España). Enseñan un ataque a un Pokémon para siempre; se gasta al enseñarla.</p>
      ${tms}`;
    $('shop-body').querySelectorAll<HTMLElement>('[data-buy]').forEach(b => {
      b.onclick = () => {
        const key = b.dataset.buy!;
        const r = G.Shop.buy(key);
        if (!r.ok) { if (r.error) G.UI.toast(r.error); render(); return; }
        G.Audio.sfx('buy');
        G.UI.refreshCoins();
        const name = key.startsWith('tm:') ? G.T('MT') + ' ' + G.Moves.BY_ID[key.slice(3)].name : G.Mons.name(G.Shop.ITEMS[key].name);
        G.UI.toast(G.I18n.f('Comprado: {x}', name));
        render();
      };
    });
  }

  return { open, render, learners };
})();
G.ShopUI = ShopUI;

declare module '../g' {
  interface Registry { ShopUI: typeof ShopUI }
}
