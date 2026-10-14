/* ============ td-geom.ts — cálculos del modo Defensa ============
 * Funciones puras, sin nada del juego: a dónde apuntar a un enemigo que se
 * mueve, si se puede plantar una torre en un sitio y hasta dónde llega un
 * movimiento. Se prueban sin navegador en tests/td-geom.test.ts.
 */

export interface Pt { x: number; y: number }

/** Lo que tiene que haber libre alrededor de una torre nueva. */
export const PATH_CLEAR = 40;     // del centro del camino (mide 42 de ancho)
export const TOWER_GAP = 40;      // entre torres
export const ENDS_CLEAR = 60;     // de la entrada y de la base

/**
 * Ángulo de disparo para que un proyectil a `speed` alcance a un blanco que va
 * a velocidad (vx, vy). Si no hay forma de alcanzarlo, apunta a donde está.
 */
export function leadAngle(sx: number, sy: number, tx: number, ty: number, vx: number, vy: number, speed: number): number {
  const dx = tx - sx, dy = ty - sy;
  const direct = Math.atan2(dy, dx);
  if (!(speed > 0)) return direct;
  // |d + v·t| = speed·t  →  (v² − s²)t² + 2(d·v)t + d² = 0
  const a = vx * vx + vy * vy - speed * speed;
  const b = 2 * (dx * vx + dy * vy);
  const c = dx * dx + dy * dy;
  let t: number;
  if (Math.abs(a) < 1e-9) t = b !== 0 ? -c / b : -1;
  else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return direct;
    const r = Math.sqrt(disc);
    const t1 = (-b - r) / (2 * a), t2 = (-b + r) / (2 * a);
    t = t1 > 0 && t2 > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
  }
  if (!(t > 0) || !Number.isFinite(t)) return direct;
  return Math.atan2(dy + vy * t, dx + vx * t);
}

/** Distancia de un punto al segmento a-b. */
export function distToSegment(x: number, y: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
  return Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
}

/** Distancia de un punto al camino (una línea quebrada). */
export function distToPath(x: number, y: number, path: Pt[]): number {
  let d = Infinity;
  for (let i = 1; i < path.length; i++) d = Math.min(d, distToSegment(x, y, path[i - 1], path[i]));
  return d;
}

/**
 * ¿Se puede plantar una torre en (x, y)? Devuelve el motivo si no ('' si sí).
 * @param bound  radio del mapa jugable, desde el centro
 */
export function placementError(x: number, y: number, o: { path: Pt[]; towers: Pt[]; bound: number }): string {
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) > o.bound) return 'Fuera del mapa';
  if (o.path.length && (Math.hypot(x - o.path[0].x, y - o.path[0].y) < ENDS_CLEAR ||
      Math.hypot(x - o.path[o.path.length - 1].x, y - o.path[o.path.length - 1].y) < ENDS_CLEAR)) return 'Demasiado cerca de la entrada o de la base';
  if (distToPath(x, y, o.path) < PATH_CLEAR) return 'Encima del camino';
  if (o.towers.some(t => Math.hypot(t.x - x, t.y - y) < TOWER_GAP)) return 'Pegada a otra torre';
  return '';
}

/** Lo que importa de un movimiento para saber su alcance (data/moves). */
export interface MoveLike { kind: string; radius?: number; speed?: number; life?: number }

/**
 * Hasta dónde ataca un movimiento, para dibujar el alcance de una torre. Es el
 * mismo criterio con el que el combate decide si un blanco está a tiro
 * (systems/combat.ts, reach), y los que no buscan blanco llegan a su radio.
 */
export function moveRange(m: MoveLike): number {
  const r = m.radius || 0;
  switch (m.kind) {
    case 'melee': return r + 30;
    case 'beam': return r + 20;
    case 'boomerang': return r + 40;
    case 'chain': return 280;
    case 'meteor': return 340;
    case 'dash': return r + 60;
    case 'cone': return (m.speed || 0) * (m.life || 0) + 30;
    case 'projectile': return Math.min(520, (m.speed || 0) * (m.life || 0) || 520);
    case 'buff': return 0;
    default: return r || 100;           // nova, aura, órbita, minas, rastro, torreta: alrededor
  }
}

// ---------------- economía ----------------

/** Monedas al empezar la partida. */
export const START_MONEY = 150;
/** Nivel máximo de una torre (es el de su movimiento: data/moves tiene 5). */
export const MAX_LEVEL = 5;
/** Niveles en los que una torre evoluciona (si su Pokémon tiene evolución). */
export const EVOLVE_AT = [3, 5];
/** Parte de lo gastado en una torre que se devuelve al venderla. */
export const REFUND = 0.7;

/** Lo que cuesta plantar un Pokémon: según su rareza en el gacha (1-5). */
export function towerCost(rarity: number): number {
  const r = Math.max(1, Math.min(5, Math.round(rarity) || 1));
  return 60 + (r - 1) * 30;
}

/** Lo que cuesta subir una torre de nivel `level` al siguiente (null si ya está al máximo). */
export function upgradeCost(baseCost: number, level: number): number | null {
  if (level >= MAX_LEVEL) return null;
  return Math.round(baseCost * 0.75 * level / 5) * 5;
}

/** Lo que te devuelven al vender una torre en la que has gastado `spent`. */
export function sellValue(spent: number): number {
  return Math.floor(spent * REFUND);
}

/** Monedas por derrotar a un enemigo en la oleada `wave` (el grandullón vale por diez). */
export function killReward(wave: number, big = false): number {
  return (3 + Math.floor(wave / 3)) * (big ? 10 : 1);
}

/** Monedas por superar la oleada `wave`, más un extra por adelantarla (segundos que quedaban). */
export function waveBonus(wave: number, earlySecs = 0): number {
  return 20 + 4 * wave + Math.max(0, Math.floor(earlySecs)) * 2;
}

/** ¿Evoluciona al llegar a este nivel? */
export const evolvesAt = (level: number) => EVOLVE_AT.includes(level);

// ---------------- el camino ----------------

/** Distancia recorrida por el camino hasta cada punto (la [0] es 0). */
export function pathLengths(path: Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  return out;
}

/**
 * Cuánto ha avanzado por el camino alguien que está en (x, y) y va hacia el
 * punto `wp`: lo que le falta hasta ese punto, restado de lo que mide el camino
 * hasta él. Sirve para saber quién va primero.
 */
export function pathProgress(x: number, y: number, wp: number, path: Pt[], lens: number[]): number {
  const i = Math.max(0, Math.min(path.length - 1, wp | 0));
  return lens[i] - Math.hypot(path[i].x - x, path[i].y - y);
}

/** Retrocede `d` por el camino desde (x, y), que va hacia `wp`. Devuelve la nueva posición y punto de destino. */
export function stepBack(x: number, y: number, wp: number, d: number, path: Pt[]): { x: number; y: number; wp: number } {
  let px = x, py = y, w = Math.max(1, Math.min(path.length - 1, wp | 0));
  while (d > 0 && w >= 1) {
    const prev = path[w - 1], len = Math.hypot(prev.x - px, prev.y - py);
    if (len >= d) { px += (prev.x - px) / len * d; py += (prev.y - py) / len * d; d = 0; }
    else { px = prev.x; py = prev.y; d -= len; if (w === 1) break; w--; }
  }
  return { x: px, y: py, wp: w };
}

// ---------------- a quién atacar ----------------

/** A quién ataca una torre, entre los que tiene a su alcance. */
export type TargetMode = 'first' | 'last' | 'strong' | 'near';
export const TARGET_MODES: TargetMode[] = ['first', 'last', 'strong', 'near'];
export const TARGET_NAME: Record<TargetMode, string> = { first: 'El primero', last: 'El último', strong: 'El más fuerte', near: 'El más cercano' };

export interface Candidate { d2: number; progress: number; hp: number }

/** El índice del blanco según el modo (los candidatos ya están a su alcance), o -1. */
export function pickTarget(list: Candidate[], mode: TargetMode): number {
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    if (best < 0) { best = i; continue; }
    const a = list[i], b = list[best];
    const better = mode === 'first' ? a.progress > b.progress
                 : mode === 'last' ? a.progress < b.progress
                 : mode === 'strong' ? a.hp > b.hp || (a.hp === b.hp && a.progress > b.progress)
                 : a.d2 < b.d2;
    if (better) best = i;
  }
  return best;
}

// ---------------- el poder de cada tipo ----------------

/**
 * Lo que añade cada tipo a los golpes de una torre, además de su daño (el tipo
 * es el del ataque: el de su movimiento). La tabla de tipos de los juegos ya se
 * aplica aparte: aquí sólo va el efecto propio de cada uno.
 */
export interface Role {
  name: string;
  desc: string;
  /** Nombre y explicación en inglés. */
  en: [string, string];
  /** Multiplicador fijo del daño. */
  mul?: number;
  /** Contra jefes y legendarios. */
  bossMul?: number;
  /** Contra los que vuelan. */
  flyMul?: number;
  /** Crítico: probabilidad y multiplicador. */
  crit?: [number, number];
  /** Rematar: por debajo de esta parte de la vida, el daño se multiplica por `execMul`. */
  exec?: number; execMul?: number;
  /** Ralentiza: parte de la velocidad que quita y segundos. */
  slow?: [number, number];
  /** Frío: golpes seguidos que congelan, y segundos congelado. */
  chill?: [number, number];
  /** Probabilidad de dejarlo quieto y segundos. */
  stun?: [number, number];
  /** Quemadura (cargas). */
  burn?: number;
  /** Veneno (cargas: quita una parte de la vida máxima). */
  poison?: number;
  /** Probabilidad de empujarlo hacia atrás por el camino, y distancia. */
  push?: [number, number];
  /** Probabilidad de que ande hacia atrás un rato, y segundos. */
  confuse?: [number, number];
  /** Maldición: segundos durante los que recibe más daño, y cuánto más. */
  curse?: [number, number];
  /** Monedas de más al derrotarlo (parte de su recompensa). */
  bounty?: number;
}

export const ROLES: Record<string, Role> = {
  normal:   { name: 'Constante',    desc: '+15% de daño siempre', en: ['Steady', '+15% damage, always'], mul: 1.15 },
  fire:     { name: 'Quemadura',    desc: 'Quema: sigue haciendo daño unos segundos', en: ['Burn', 'Burns: keeps dealing damage for a few seconds'], burn: 2 },
  water:    { name: 'Corriente',    desc: 'A veces lo arrastra hacia atrás por el camino', en: ['Current', 'Sometimes drags it back along the path'], push: [0.25, 45] },
  grass:    { name: 'Enredo',       desc: 'Lo frena un poco (−25%)', en: ['Tangle', 'Slows it a little (−25%)'], slow: [0.25, 1.2] },
  electric: { name: 'Parálisis',    desc: 'A veces lo deja quieto un instante', en: ['Paralysis', 'Sometimes stops it for a moment'], stun: [0.18, 0.6] },
  ice:      { name: 'Congelar',     desc: 'Lo frena mucho, y a los 4 golpes lo congela', en: ['Freeze', 'Slows it a lot, and freezes it on the 4th hit'], slow: [0.4, 1.5], chill: [4, 1.1] },
  fighting: { name: 'Golpe crítico', desc: 'A veces pega ×1,8', en: ['Critical hit', 'Sometimes hits ×1.8'], crit: [0.2, 1.8] },
  poison:   { name: 'Veneno',       desc: 'Envenena: quita una parte de su vida máxima', en: ['Poison', 'Poisons: takes away part of its max HP'], poison: 2 },
  ground:   { name: 'Temblor',      desc: 'Lo frena (−30%)', en: ['Tremor', 'Slows it (−30%)'], slow: [0.3, 1] },
  flying:   { name: 'Ráfaga',       desc: '+30% contra los que vuelan', en: ['Gust', '+30% against flying enemies'], flyMul: 1.3 },
  psychic:  { name: 'Confusión',    desc: 'A veces anda hacia atrás un rato', en: ['Confusion', 'Sometimes walks backwards for a while'], confuse: [0.12, 1.2] },
  bug:      { name: 'Picadura',     desc: 'Envenena un poco', en: ['Sting', 'Poisons a little'], poison: 1 },
  rock:     { name: 'Derribo',      desc: 'A veces lo deja quieto un instante', en: ['Rock slam', 'Sometimes stops it for a moment'], stun: [0.1, 0.7] },
  ghost:    { name: 'Maldición',    desc: 'El golpeado recibe +20% de daño 3 s', en: ['Curse', 'The target takes +20% damage for 3 s'], curse: [3, 1.2] },
  dragon:   { name: 'Furia',        desc: '+20% de daño, +20% más contra jefes', en: ['Fury', '+20% damage, +20% more against bosses'], mul: 1.2, bossMul: 1.2 },
  dark:     { name: 'Rematar',      desc: '×2 de daño a los que tienen menos del 25% de vida', en: ['Finisher', '×2 damage to enemies under 25% HP'], exec: 0.25, execMul: 2 },
  steel:    { name: 'Perforar',     desc: '+40% contra jefes y legendarios', en: ['Pierce', '+40% against bosses and legendaries'], bossMul: 1.4 },
  fairy:    { name: 'Fortuna',      desc: '+50% de monedas por los que derrota', en: ['Fortune', '+50% coins for the enemies it defeats'], bounty: 0.5 },
};

/** Lo que tiene que saber un golpe del enemigo al que da. */
export interface HitTarget { hp: number; maxHp: number; boss: boolean; flying: boolean; cursed: boolean }

/** Lo que hace un golpe de tipo `type` además del daño (calculado con `rnd`, 0..1). */
export interface HitEffect { mul: number; crit: boolean; stun: number; confuse: number; push: number }

export function roleHit(type: string, t: HitTarget, rnd: () => number): HitEffect {
  const r = ROLES[type];
  const out: HitEffect = { mul: 1, crit: false, stun: 0, confuse: 0, push: 0 };
  if (t.cursed) out.mul *= ROLES.ghost.curse![1];
  if (!r) return out;
  if (r.mul) out.mul *= r.mul;
  if (r.bossMul && t.boss) out.mul *= r.bossMul;
  if (r.flyMul && t.flying) out.mul *= r.flyMul;
  if (r.exec && t.maxHp > 0 && t.hp / t.maxHp < r.exec) out.mul *= r.execMul || 1;
  if (r.crit && rnd() < r.crit[0]) { out.mul *= r.crit[1]; out.crit = true; }
  // Jefes y legendarios: se les para y se les mueve la mitad.
  const k = t.boss ? 0.5 : 1;
  if (r.stun && rnd() < r.stun[0]) out.stun = r.stun[1] * k;
  if (r.confuse && rnd() < r.confuse[0]) out.confuse = r.confuse[1] * k;
  if (r.push && rnd() < r.push[0]) out.push = r.push[1] * k;
  return out;
}

// ---------------- Pokémon de apoyo (auras) ----------------

/**
 * Algunos Pokémon no atacan: refuerzan a las torres que tienen cerca (como el
 * Estandarte de Fortaleza TD). Cada uno con el movimiento que lo caracteriza.
 * Las auras de la misma clase NO se suman: cuenta la más fuerte (si no, cinco
 * apoyos juntos lo rompían todo).
 */
export type AuraKind = 'dmg' | 'haste' | 'crit' | 'bounty' | 'range';
export const AURA_KINDS: AuraKind[] = ['dmg', 'haste', 'crit', 'bounty', 'range'];

/** `en`: el movimiento y lo que da, en inglés. */
export interface AuraDef { move: string; color: string; what: string; levels: number[]; en: [string, string] }
export const AURAS: Record<AuraKind, AuraDef> = {
  dmg:    { move: 'Danza Espada', color: '#ff6b4a', what: 'de daño',              levels: [0.15, 0.2, 0.25, 0.3, 0.4], en: ['Swords Dance', 'damage'] },
  haste:  { move: 'Viento Afín',  color: '#7fd4ff', what: 'de velocidad de ataque', levels: [0.15, 0.2, 0.25, 0.3, 0.4], en: ['Tailwind', 'attack speed'] },
  crit:   { move: 'Foco Energía', color: '#ffb03b', what: 'de golpe crítico (×1,5)', levels: [0.1, 0.13, 0.16, 0.2, 0.25], en: ['Focus Energy', 'critical hit chance (×1.5)'] },
  bounty: { move: 'Día de Pago',  color: '#ffd23f', what: 'de monedas por cada derrotado', levels: [0.2, 0.3, 0.4, 0.5, 0.6], en: ['Pay Day', 'coins per defeated enemy'] },
  range:  { move: 'Vista Lince',  color: '#b48cff', what: 'de alcance (a las de largo alcance)', levels: [0.1, 0.15, 0.2, 0.25, 0.3], en: ['Keen Eye', 'range (for long-range towers)'] },
};

/** Qué aura da cada Pokémon de apoyo (sus evoluciones también, para que evolucionar no se la quite). */
export const SUPPORT: Record<number, AuraKind> = {
  123: 'dmg', 212: 'dmg', 83: 'dmg', 900: 'dmg',                  // Scyther, Scizor, Farfetch'd, Kleavor
  175: 'haste', 176: 'haste', 468: 'haste', 291: 'haste',         // Togepi, Togetic, Togekiss, Ninjask
  447: 'crit', 448: 'crit', 359: 'crit',                          // Riolu, Lucario, Absol
  52: 'bounty', 53: 'bounty', 863: 'bounty', 1000: 'bounty',      // Meowth, Persian, Perrserker, Gholdengo
  163: 'range', 164: 'range',                                     // Hoothoot, Noctowl
};

/** Fuerza del aura en el nivel `level` (1-5). */
export function auraStrength(kind: AuraKind, level: number): number {
  const l = AURAS[kind].levels;
  return l[Math.max(0, Math.min(l.length - 1, (level | 0) - 1))];
}

/** Radio del aura en el nivel `level`. */
export const auraRadius = (level: number) => 150 + 15 * (Math.max(1, Math.min(MAX_LEVEL, level | 0)) - 1);

export interface AuraSource { x: number; y: number; kind: AuraKind; level: number }
export type AuraTotals = Record<AuraKind, number>;

/** Las auras que recibe quien está en (x, y): de cada clase, la más fuerte que le llega. */
export function aurasAt(x: number, y: number, sources: AuraSource[]): AuraTotals {
  const out: AuraTotals = { dmg: 0, haste: 0, crit: 0, bounty: 0, range: 0 };
  for (const s of sources) {
    const r = auraRadius(s.level);
    if ((s.x - x) * (s.x - x) + (s.y - y) * (s.y - y) > r * r) continue;
    out[s.kind] = Math.max(out[s.kind], auraStrength(s.kind, s.level));
  }
  return out;
}
