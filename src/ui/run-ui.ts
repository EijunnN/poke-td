import { G } from '../g';
import type { Card } from '../systems/levelup';
import type { MoveInstance } from '../data/moves';
/* ============ run-ui.js — cartas de nivel, pausa y fin de run ============ */
/** Lo que se enseña al acabar la run (la Defensa cambia las cuatro cifras de arriba con `cells`). */
interface RunResult {
  dead: boolean; time: number; level: number; kills: number; bosses: number; coins: number; record: boolean;
  t1: number; t10: number; judge: { time: number; bosses: number } | null;
  moves: MoveInstance[]; caught: { dex: number; isNew?: boolean }[]; breakdown: string;
  cells?: [string, string | number][];
}
/** Lo que se puede hacer con un vínculo (Player.bondOptions): `group` sólo en 'add'. */
interface BondOption { mode: string; group: MoveInstance[] | null; loose: MoveInstance[] }
interface BondState { opt: BondOption; cb: (list: MoveInstance[]) => void; first: MoveInstance | null; list: MoveInstance[] }

export const RunUI = (() => {
  const $ = G.UI.$;
  let offers: Card[] | null = null, offerCb: ((c: Card) => void) | null = null, coopMode = false;

  /**
   * Las teclas 1-4 también cambian de movimiento al jugar: si la pantalla acepta la elección nada
   * más abrirse, una pulsación sin querer elige carta. Durante este margen se ignora la entrada
   * (teclado y clic/toque) de las pantallas de nivel, objeto y vínculo.
   */
  const GUARD_MS = 400;
  let openedAt = 0;
  const armGuard = () => { openedAt = performance.now(); };
  const guarded = () => performance.now() - openedAt < GUARD_MS;

  /** @param coop  en grupo: tras elegir, se queda esperando a los demás */
  function showLevelUp(level: number, list: Card[], cb: (c: Card) => void, coop = false) {
    offerCb = cb; coopMode = coop;
    armGuard();
    $('lvl-num').textContent = String(level);
    $('lvl-wait').textContent = '';
    $('lvl-wait').classList.toggle('hidden', !coop);
    $('cards').classList.remove('done');
    renderCards(list);
    $('lvl-reroll').onclick = reroll;
    G.UI.show('scr-levelup');
  }

  /**
   * Cambiar las cartas: 1 vez gratis por partida y 1 más por cada jefe
   * derrotado (en grupo cuentan los jefes del equipo; cada uno tiene los suyos).
   */
  function rerollsLeft() {
    const p = G.Game.player;
    // 1 gratis + los comprados en Mejoras (antes, 1 más por cada jefe).
    return p ? Math.max(0, 1 + (p.rerollBonus || 0) - (p.rerolls || 0)) : 0;
  }

  function reroll() {
    if (!offers || rerollsLeft() <= 0) return;
    const p = G.Game.player!;   // rerollsLeft() > 0 implica que hay jugador
    p.rerolls = (p.rerolls || 0) + 1;
    G.Audio.sfx('select');
    renderCards(G.LevelUp.offer(p));
  }

  function renderCards(list: Card[]) {
    offers = list;
    const left = rerollsLeft();
    $('lvl-rr-n').textContent = String(left);
    $('lvl-reroll').classList.toggle('hidden', left <= 0);
    const box = $('cards');
    box.innerHTML = '';
    list.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'card';
      const tag = c.type === 'new'
        ? `<span class="tag-chip" style="background:${c.color}">Nuevo · ${c.tag}</span>`
        : c.type === 'up' || c.type === 'evo'
          ? `<span class="tag-chip" style="background:${c.color}">${c.tag}</span>`
          : `<span class="tag-chip" style="background:${c.color === '#ffd23f' ? '#ffd23f' : '#9fb1c9'}">${c.tag}</span>`;
      if (c.type === 'evo') el.classList.add('evo');
      el.innerHTML =
        `<div class="ico" style="background:${c.color}33">${G.Icons.html(c.icon, 32)}</div>
         <div class="txt"><div class="nm">${c.title} ${tag}</div><div class="ds">${c.desc}</div></div>
         <div class="key">${i + 1}</div>`;
      el.dataset.sfx = 'none';             // el juego pone su propio sonido al elegir
      el.onclick = () => pick(i);
      box.appendChild(el);
    });
  }

  function pick(i: number) {
    if (!offers || !offers[i] || guarded()) return;
    const c = offers[i], cb = offerCb;
    offers = null; offerCb = null;
    $('lvl-reroll').classList.add('hidden');
    if (coopMode) {
      // Se queda la carta elegida a la vista mientras eligen los demás.
      $('cards').querySelectorAll('.card').forEach((el: Element, j: number) => el.classList.toggle('picked', j === i));
      $('cards').classList.add('done');
    } else G.UI.hide('scr-levelup');
    cb!(c);
  }

  /** Cooperativo: quién falta por elegir. */
  function setWaiting(names: string[]) {
    const me = G.Social.me ? G.Social.me.name : '';
    const others = names.filter(n => n !== me);
    const list = (a: string[]) => a.length > 1 ? a.slice(0, -1).join(', ') + ' y ' + a[a.length - 1] : a[0];
    $('lvl-wait').textContent = !names.length ? ''
      : !others.length ? 'Elige tu carta'
      : names.includes(me) ? 'Faltan por elegir: ' + list([...others, 'tú'])
      : 'Esperando a ' + list(others) + '…';
  }

  function closeLevelUp() {
    offers = null; offerCb = null;
    $('cards').classList.remove('done');
    G.UI.hide('scr-levelup');
  }

  /**
   * Mensaje de apoyo (Ko-fi) al acabar: tras un récord o cada 10 partidas,
   * nunca en la primera y como mucho una vez al día. Se cierra con la X.
   */
  function askSupport(r: RunResult) {
    if (!G.Funding || !G.Funding.url) return false;
    const runs = (G.DB.save && G.DB.save.stats && G.DB.save.stats.runs) || 0;
    if (runs < 2 || !(r.record || runs % 10 === 0)) return false;
    const today = new Date().toISOString().slice(0, 10);
    try { if (localStorage.getItem('ps.ask') === today) return false; localStorage.setItem('ps.ask', today); } catch (e) { return false; }
    return true;
  }

  /** @param r  lo de la partida; `cells` ([nombre, valor][]) cambia las cuatro cifras de arriba (la Defensa enseña oleadas y vidas). */
  function showOver(r: RunResult, onBack: () => void) {
    $('over-title').textContent = r.dead ? 'Has caído…' : 'Run terminada';
    const cells: [string, string | number][] = r.cells || [['Tiempo', G.U.mmss(r.time)], ['Nivel', r.level], ['Derrotados', r.kills], ['Jefes', r.bosses]];
    $('over-stats').innerHTML = `
      ${cells.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}
      ${r.judge ? `<div style="grid-column:1/-1"><span>Ante Arceus</span><b class="gold">${G.U.mmss(r.judge.time)} · ${r.judge.bosses} ${r.judge.bosses === 1 ? 'legendario' : 'legendarios'}</b></div>` : ''}
      <div style="grid-column:1/-1"><span>Pokémonedas ganadas</span>
        <b class="gold"><span class="coin"></span> +${r.coins}</b>
        <div style="font-size:12px;color:var(--muted)">${r.breakdown}</div></div>
      ${r.t1 || r.t10 ? `<div style="grid-column:1/-1"><span>Tickets del gacha</span><b>
        ${r.t1 ? G.Icons.html('ticket', 22) + ' +' + r.t1 + ' ' : ''}${r.t10 ? G.Icons.html('ticket10', 22) + ' +' + r.t10 + ' ×10' : ''}</b></div>` : ''}
      <div style="grid-column:1/-1"><span>Movimientos</span><b style="font-size:15px">
        ${r.moves.map(m => `${G.Icons.html('move:' + m.id, 16)} ${m.name} Nv.${m.lvl}`).join(' · ') || '—'}</b></div>
      ${r.caught && r.caught.length ? `<div style="grid-column:1/-1" class="caught"><span>${G.Icons.html('shiny', 12)} Shinies conseguidos</span>
        <div class="caught-row" id="over-caught"></div></div>` : ''}
      ${r.record ? '<div style="grid-column:1/-1;text-align:center" class="gold">¡Nuevo récord de tiempo!</div>' : ''}
      ${askSupport(r) ? `<div class="support-ask" id="over-ask" style="grid-column:1/-1">
        <button class="x" type="button" aria-label="Cerrar">×</button>
        <p>¿Te está gustando PokéTD? Lo hago yo solo y los servidores cuestan dinero. Si quieres, puedes ayudarme a mantenerlo en línea.</p>
        <a class="btn small gold" href="${G.Funding.url}" target="_blank" rel="noopener">${G.Icons.html('heart', 14)} Apoyar en Ko-fi</a>
      </div>` : ''}`;
    const ask = $('over-ask');
    if (ask) ask.querySelector<HTMLElement>('.x')!.onclick = () => ask.remove();
    $('btn-again').onclick = onBack;
    if (r.caught && r.caught.length) {
      const row = $('over-caught');
      for (const c of r.caught) {
        const w = document.createElement('div');
        w.appendChild(G.UI.spriteCanvas(c.dex, 90, 72, { shiny: true, lively: true, scale: 2 }));
        w.insertAdjacentHTML('beforeend', `<small>${G.DEX_BY[c.dex].name}${c.isNew ? ' · ¡nuevo!' : ''}</small>`);
        row.appendChild(w);
      }
    }
    G.UI.show('scr-over');
  }

  /** Has encontrado un objeto llevando ya otro: ¿con cuál te quedas? */
  function showItemChoice(cur: string, next: string, cb: (id: string) => void) {
    armGuard();
    const box = $('item-cards');
    box.innerHTML = '';
    ([[cur, 'Quedarme con'], [next, 'Cambiar a']] as [string, string][]).forEach(([id, verb], i) => {
      const it = G.Items.BY[id];
      const el = document.createElement('div');
      el.className = 'card' + (i === 1 ? ' evo' : '');
      el.innerHTML = `<div class="ico">${G.Icons.html(id, 36)}</div>
        <div class="txt"><div class="nm">${verb} ${it.name}</div><div class="ds">${it.desc}</div></div>
        <div class="key">${i + 1}</div>`;
      el.onclick = () => { if (guarded()) return; G.UI.hide('scr-item'); cb(id); };
      box.appendChild(el);
    });
    G.UI.show('scr-item');
  }

  // ---------------- vínculo: qué movimientos se fusionan ----------------

  let bond: BondState | null = null;

  /**
   * @param opt  pl.bondOptions(): 'add' (uno suelto al grupo) o 'pair' (dos sueltos, en dos pasos)
   * @param cb   recibe la lista de movimientos que se juntan
   */
  function showBond(opt: BondOption, cb: (list: MoveInstance[]) => void) {
    bond = { opt, cb, first: null, list: [] };
    armGuard();
    $('bond-back').onclick = bondBack;
    renderBond();
    G.UI.show('scr-bond');
  }

  function renderBond() {
    const b = bond!;
    const { opt, first } = b;
    const names = (ms: MoveInstance[]) => ms.map(m => m.name).join(' + ');
    const step2 = opt.mode === 'pair' && first;
    $('bond-sub').textContent = opt.mode === 'add' ? 'Elige qué movimiento se une a ' + names(opt.group!)
      : step2 ? '¿Con cuál unes ' + first.name + '?' : 'Elige el primer movimiento que vas a unir';
    $('bond-back').classList.toggle('hidden', !step2);
    b.list = step2 ? opt.loose.filter(m => m !== first) : opt.loose;
    const box = $('bond-cards');
    box.innerHTML = '';
    b.list.forEach((m, i) => {
      const col = G.U.TYPE_COLOR[m.type];
      const desc = opt.mode === 'add' ? 'Se lanzará a la vez que ' + names(opt.group!) + '.'
        : step2 ? 'Se lanzará a la vez que ' + first.name + '. Queda un hueco libre.'
        : m.desc || '';
      const el = document.createElement('div');
      el.className = 'card' + (opt.mode === 'add' || step2 ? ' bond' : '');
      el.innerHTML =
        `<div class="ico" style="background:${col}33">${G.Icons.html('move:' + m.id, 32)}</div>
         <div class="txt"><div class="nm">${m.name} <span class="tag-chip" style="background:${col}">Nv.${m.lvl}</span></div><div class="ds">${desc}</div></div>
         <div class="key">${i + 1}</div>`;
      el.dataset.sfx = 'none';
      el.onclick = () => pickBond(i);
      box.appendChild(el);
    });
  }

  function pickBond(i: number) {
    if (!bond || !bond.list[i] || guarded()) return;
    const m = bond.list[i];
    if (bond.opt.mode === 'pair' && !bond.first) {
      bond.first = m;
      G.Audio.sfx('select');
      renderBond();
      return;
    }
    const picked = bond.opt.mode === 'add' ? [m] : [bond.first!, m];
    const cb = bond.cb;
    bond = null;
    G.UI.hide('scr-bond');
    cb(picked);
  }

  function bondBack() {
    if (!bond) return;
    bond.first = null;
    renderBond();
  }

  function showPause(coop = false) {
    G.UI.soundControls($('pause-sound'));
    $('pause-coop').classList.toggle('hidden', !coop);
    $('btn-quit').textContent = coop ? 'Salir de la partida' : 'Abandonar run';
    G.UI.show('scr-pause');
  }

  function wirePause(onResume: () => void, onQuit: () => void) {
    $('btn-resume').onclick = onResume;
    $('btn-quit').onclick = onQuit;
  }

  return { showLevelUp, reroll, showItemChoice, showBond, pickBond, bondBack, pick, setWaiting, closeLevelUp, showOver, wirePause, showPause };
})();
G.RunUI = RunUI;

declare module '../g' {
  interface Registry { RunUI: typeof RunUI }
}
