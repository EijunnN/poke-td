import { G } from '../g';
import type { Player } from '../entities/player';
import type { Card } from '../systems/levelup';
import type { PokeType } from '../data/types';
import { rank } from '../systems/recount';
/* ============ stats-ui.ts — estadísticas, resumen y medidor de daño ============
 * Lo que enseña la pausa (pestañas Resumen, Estadísticas y Daño), el resumen de
 * la partida y cuánto sube cada carta de nivel. Los cálculos no tocan el DOM
 * (se prueban en tests/stats-ui.test.ts); los *Html devuelven el texto que pinta run-ui.ts.
 */
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Un multiplicador como cambio: 1,35 → "+35%", 0,85 → "-15%". */
const mult = (v: number) => { const d = Math.round((v - 1) * 100); return d > 0 ? '+' + d + '%' : d + '%'; };
const percent = (v: number) => Math.round(v * 100) + '%';
const dec = (v: number) => String(Math.round(v * 10) / 10);

/** Cifras grandes cortas: 1234 → "1.2k", 3 400 000 → "3.4M". */
export function fmtN(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M';
}

// ---------------- estadísticas del jugador ----------------

/** Una estadística del Pokémon. `id` es el de la carta de nivel que la sube (LevelUp.STATS), si la hay. */
interface StatDef {
  id: string; label: string; icon: string;
  read(p: Player): number;
  fmt(n: number): string;
  /** Lo que da ahora un potenciador (Danza Espada...): caduca, así que no cuenta en la carta. */
  temp?(p: Player): string | null;
  /** Texto de la pausa si no es sólo `fmt(read)`. */
  show?(p: Player): string;
  /** Sin carta de nivel propia: sólo se enseña si tiene algún valor. */
  extra?(p: Player): boolean;
}
type Buff = Player['buffs']['atk'];
const stacked = (b: Buff) => b.n > 0 ? 1 + b.n * b.amount : 1;

const DEFS: StatDef[] = [
  { id: 'hp', label: 'Vida máxima', icon: 'heart', read: p => p.maxHp, fmt: n => String(Math.round(n)),
    show: p => Math.ceil(p.hp) + ' / ' + Math.round(p.maxHp) },
  { id: 'atk', label: 'Daño', icon: 'fist', read: p => p.atkMul, fmt: mult,
    temp: p => {
      // Danza Espada sube los físicos y Maquinación los especiales: con las dos a la vez, se dice cuál es cuál.
      const a = p.buffs.atk.n > 0, s = p.buffs.spa.n > 0;
      if (a && s) return 'Fís. ' + mult(stacked(p.buffs.atk)) + ' · Esp. ' + mult(stacked(p.buffs.spa));
      return s ? 'Esp. ' + mult(stacked(p.buffs.spa)) : a ? mult(stacked(p.buffs.atk)) : null;
    } },
  { id: 'spd', label: 'Velocidad', icon: 'boot', read: p => p.spdMul, fmt: mult,
    temp: p => p.buffs.spd.n > 0 ? mult(stacked(p.buffs.spd)) : null },
  { id: 'cd', label: 'Recarga', icon: 'clock', read: p => p.cdMul, fmt: mult },
  { id: 'def', label: 'Daño recibido', icon: 'shield', read: p => p.dmgReduce, fmt: n => (n > 0 ? '-' : '') + percent(n),
    temp: p => p.buffs.def.n > 0 ? '-' + percent(p.buffs.def.n * p.buffs.def.amount) : null },
  { id: 'rgn', label: 'Regeneración', icon: 'sprout', read: p => p.regenFlat, fmt: n => dec(n) + '/s',
    temp: p => p.buffs.regen.n > 0 ? '+' + dec(p.buffs.regen.n * p.buffs.regen.amount) + '/s' : null },
  { id: 'mag', label: 'Radio de recogida', icon: 'magnet', read: p => p.magnet, fmt: n => String(Math.round(n)) },
  { id: 'xp', label: 'Experiencia', icon: 'book', read: p => p.xpMul, fmt: mult },
  { id: 'crit', label: 'Crítico', icon: 'star', read: p => p.critChance, fmt: percent, extra: p => p.critChance > 0 },
  { id: 'coin', label: 'Pokémonedas', icon: 'coin', read: p => p.coinMul, fmt: mult, extra: p => Math.abs(p.coinMul - 1) > 0.005 }
];

/** Cartas de nivel de esa mejora que llevas y el tope (sin tope, `max` vale 0). */
function cardsOf(p: Player, id: string) {
  const s = G.LevelUp.STATS.find((x: { id: string }) => x.id === id);
  return s ? { n: p.statsTaken[id] || 0, max: s.max || 0 } : null;
}

export interface StatRow { id: string; label: string; icon: string; value: string; temp: string | null; n: number; max: number }

/** Las estadísticas que se enseñan en la pausa. */
export function statRows(p: Player): StatRow[] {
  return DEFS.filter(d => !d.extra || d.extra(p)).map(d => {
    const c = cardsOf(p, d.id);
    return { id: d.id, label: d.label, icon: d.icon, value: d.show ? d.show(p) : d.fmt(d.read(p)),
             temp: d.temp ? d.temp(p) : null, n: c ? c.n : 0, max: c ? c.max : 0 };
  });
}

/** Cuánto sube una carta de mejora: de qué valor a cuál, y qué carta de esa mejora sería. */
export interface CardPreview { label: string; from: string; to: string; n: number; max: number }

/**
 * Se aplica la mejora (la misma `apply` de la carta, sin repetir cifras) sobre una copia del
 * jugador que hereda de él: lo que escribe se queda en la copia y el jugador no se entera.
 */
export function cardPreview(card: Pick<Card, 'type' | 'key'>, p: Player): CardPreview | null {
  if (card.type !== 'stat') return null;
  const id = card.key.slice(5);
  const def = DEFS.find(d => d.id === id), st = G.LevelUp.STATS.find((x: { id: string }) => x.id === id);
  if (!def || !st) return null;
  const copy = Object.create(p) as Player;
  try { st.apply(copy); } catch (e) { return null; }
  const from = def.fmt(def.read(p)), to = def.fmt(def.read(copy));
  if (from === to) return null;
  return { label: def.label, from, to, n: (p.statsTaken[id] || 0) + 1, max: st.max || 0 };
}

/** La línea que va bajo la descripción de una carta de mejora ('' si no cambia nada que enseñar). */
export function cardHtml(card: Card, p: Player): string {
  const v = cardPreview(card, p);
  if (!v) return '';
  const n = v.max ? `${v.n}/${v.max}` : '×' + v.n;
  return `<div class="up-line"><span>${v.label}</span> <b>${v.from}</b> <i>→</i> <b class="gold">${v.to}</b>
    <small title="Cartas de esta mejora que llevarías">${n}</small></div>`;
}

/** Ataque, At. Esp., Defensa y Def. Esp. base del Pokémon; el lado en que más pega va resaltado. */
export function baseStatsHtml(p: Player): string {
  if (!p.cats) return '';
  const [atk, spa, def, spd] = G.statsOf(p.mon.dex), best = p.bestCat();
  const cell = (label: string, v: number, on: boolean) => `<div class="pz-bs${on ? ' on' : ''}"><span>${label}</span><b>${v}</b></div>`;
  return `<h4 class="pz-h">Estadísticas base</h4>
    <div class="pz-base">${cell('Ataque', atk, best === 'phys')}${cell('At. Esp.', spa, best === 'spec')}${cell('Defensa', def, false)}${cell('Def. Esp.', spd, false)}</div>
    <p class="note">Los ataques físicos pegan con el Ataque y los especiales con el At. Esp. Los golpes cuerpo a cuerpo se frenan con la Defensa y los disparos con la Def. Esp.</p>${natureHtml(p)}`;
}

/** Su naturaleza y su habilidad (Survivor; el nombre y la descripción ya vienen en el idioma del juego). */
function natureHtml(p: Player): string {
  const n = p.nature && G.NATURE_BY[p.nature];
  if (!n || !p.abil) return '';
  return `<h4 class="pz-h">Naturaleza y habilidad</h4>
    <p class="note"><b translate="no">${esc(G.Mons.name(n.n))}</b> · <b translate="no">${esc(G.Mons.abilityName(p.abilId))}</b><br>
      <span translate="no">${esc(G.AbilityFX.describe(p.abil))}</span></p>`;
}

export function statsHtml(p: Player): string {
  return `<div class="pz-grid">${statRows(p).map(r => `
    <div class="pz-stat">${G.Icons.html(r.icon, 20)}
      <span class="pz-lb">${r.label}${r.temp ? `<small class="pz-temp">${r.temp} <span>temporal</span></small>` : ''}</span>
      <b>${r.value}</b>
      ${r.n || r.max ? `<small class="pz-n" title="Cartas de esta mejora que llevas">${r.max ? `${r.n}/${r.max}` : '×' + r.n}</small>` : '<small class="pz-n"></small>'}
    </div>`).join('')}</div>${baseStatsHtml(p)}`;
}

// ---------------- medidor de daño ----------------

export interface MoveDmg { id: string; name: string; type: PokeType; dmg: number; pct: number; frac: number }
export interface TeamDmg { name: string; color: string; me: boolean; dmg: number; pct: number; frac: number }
/** Daño de la run: total, por segundo, por movimiento y (en grupo) por jugador. */
export interface DmgReport { total: number; dps: number; time: number; moves: MoveDmg[]; team: TeamDmg[] }

/** @param team  Coop.damage() en grupo; vacío en solitario */
export function damageReport(p: Pick<Player, 'moves'>, time: number,
    team: { name: string; color: string; me: boolean; dmg: number }[] = [], rows: { id: string; dmg: number }[] = G.Recount.rows()): DmgReport {
  const moves = rank(rows).map(r => {
    const m = p.moves.find(x => x.id === r.id) || (G.Moves && G.Moves.BY_ID[r.id]);
    return { ...r, name: m ? m.name : r.id, type: (m ? m.type : 'normal') as PokeType };
  });
  const total = rows.reduce((a, r) => a + r.dmg, 0);
  return { total, dps: total / Math.max(1, time), time, moves, team: team.length > 1 ? rank(team) : [] };
}

/** @param top  como mucho tantas filas por lista (el resumen final) */
export function dmgHtml(r: DmgReport, top = 99): string {
  if (r.total <= 0) return '<p class="note">Aún no has hecho daño.</p>';
  const row = (ico: string, nm: string, col: string, frac: number, n: number, pct: number, cls = '') =>
    `<div class="dm-row ${cls}">${ico}<div class="dm-bar"><i style="width:${(frac * 100).toFixed(1)}%;background:${col}"></i>${nm}</div><b>${fmtN(n)}</b><small>${Math.round(pct)}%</small></div>`;
  const mvs = r.moves.slice(0, top).map(m =>
    row(G.Icons.html('move:' + m.id, 20), `<span>${m.name}</span>`, G.U.TYPE_COLOR[m.type], m.frac, m.dmg, m.pct)).join('');
  const team = r.team.slice(0, top).map(t =>
    row(`<span class="dm-dot" style="background:${esc(t.color)}"></span>`, `<span translate="no">${esc(t.name)}</span>`, esc(t.color), t.frac, t.dmg, t.pct, t.me ? 'me' : '')).join('');
  // En grupo la cabecera es la del equipo (la suma de todos); abajo, lo tuyo.
  const all = r.team.length ? r.team.reduce((a, t) => a + t.dmg, 0) : r.total;
  return `<div class="dm-head"><div><span>${r.team.length ? 'Daño del equipo' : 'Daño total'}</span><b>${fmtN(all)}</b></div>
      <div><span>Daño por segundo</span><b>${fmtN(all / Math.max(1, r.time))}</b></div></div>
    ${team ? `<h4 class="pz-h">Equipo</h4><div class="dm-list">${team}</div><h4 class="pz-h">Tus movimientos</h4>` : ''}
    <div class="dm-list">${mvs}</div>`;
}

// ---------------- resumen de la partida ----------------

/** Cifras del resumen: [nombre, valor][]. */
export function runCells(p: Player, time: number, dmg: DmgReport): [string, string | number][] {
  const out: [string, string | number][] = [
    ['Tiempo', G.U.mmss(time)], ['Nivel', p.level], ['Derrotados', p.kills], ['Jefes', p.bosses],
    ['Monedas', p.coins], ['Daño', fmtN(dmg.total)], ['Daño/s', fmtN(dmg.dps)]
  ];
  if (p.t1 || p.t10) out.push(['Tickets', (p.t1 ? p.t1 : '') + (p.t1 && p.t10 ? ' + ' : '') + (p.t10 ? p.t10 + ' ×10' : '')]);
  return out;
}

/** Un movimiento aprendido, en su hueco (los de un vínculo comparten número). */
export interface MoveLine { slot: number; first: boolean; active: boolean; id: string; name: string; lvl: number; color: string; dmg: number | null; hits: number; cd: number | null }

export function moveLines(p: Player): MoveLine[] {
  const out: MoveLine[] = [];
  p.slots.forEach((g, i) => g.forEach((m, j) => out.push({
    slot: i + 1, first: j === 0, active: i === p.active, id: m.id, name: m.name, lvl: m.lvl, color: G.U.TYPE_COLOR[m.type],
    dmg: m.dmg ? m.dmg * p.atkFor(m) : null,
    hits: m.count && ['projectile', 'cone', 'meteor', 'homing', 'spin', 'quake'].includes(m.kind) ? m.count : 1,
    cd: m.kind === 'orbit' ? null : m.cd * p.cdMul
  })));
  return out;
}

export function summaryHtml(p: Player, time: number, dmg: DmgReport): string {
  const it = p.item ? G.Items.BY[p.item] : null;
  return `<div class="pz-cells">${runCells(p, time, dmg).map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
    ${it ? `<div class="pz-item">${G.Icons.html(p.item!, 28)}<div><b>${it.name}</b><small>${it.desc}</small></div></div>` : ''}
    <h4 class="pz-h">Movimientos</h4>
    <div class="pz-moves">${moveLines(p).map(m => `
      <div class="pz-mv${m.active ? ' on' : ''}"><span class="pz-slot">${m.first ? m.slot : ''}</span>${G.Icons.html('move:' + m.id, 22)}
        <span class="pz-mn"><b>${m.name}</b> <small>Nv. ${m.lvl}</small></span>
        ${m.dmg ? `<span class="pz-kv"><span>Daño</span> <b>${fmtN(m.dmg)}${m.hits > 1 ? ' ×' + m.hits : ''}</b></span>` : ''}
        ${m.cd ? `<span class="pz-kv"><span>Recarga</span> <b>${dec(m.cd)} s</b></span>` : ''}
      </div>`).join('')}</div>`;
}

export const StatsUI = { fmtN, statRows, cardPreview, cardHtml, statsHtml, baseStatsHtml, damageReport, dmgHtml, runCells, moveLines, summaryHtml };
G.StatsUI = StatsUI;

declare module '../g' {
  interface Registry { StatsUI: typeof StatsUI }
}
