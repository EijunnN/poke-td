import { G } from '../g';
import type { Player } from '../entities/player';
import type { Enemy } from '../entities/enemy';
import type { PokeType } from './types';
import type { MoveCat } from './moves';
/* ============ ability-fx.ts — qué hace cada habilidad en el Survivor ============
 * Los nombres están en data/abilities.ts. Aquí, el efecto de las que tienen sentido en un
 * survivor; las demás dan una pasiva suave de su tipo principal (+6 % de daño con sus movimientos
 * de ese tipo), con su nombre de siempre. La Defensa (modes/td.ts) no las usa.
 *
 * Ganchos, todos opcionales (los llama entities/player.ts y systems/combat.ts):
 *   start(pl)              al empezar la partida (stats fijos)
 *   out(pl, m)             × al daño de cada ataque, sin mirar a quién (Player.atkFor)
 *   vs(pl, m, e)           × al daño de un golpe concreto al enemigo e (depende de e)
 *   hit(pl, e, m)          ha golpeado a e
 *   inMul(pl, type, cat)   × al daño que recibe (cat 'phys' | 'spec' | null)
 *   absorb                 ese tipo no le hace daño: le cura un poco
 *   dodge(pl, type, cat)   probabilidad de esquivar un golpe
 *   hurt(pl, type, cat)    le acaban de golpear
 *   contact(pl, e)         un enemigo le ha golpeado cuerpo a cuerpo
 *   tick(pl, dt)           cada fotograma
 *   kill(pl, e)            ha caído un enemigo
 *   speed(pl)              × a la velocidad
 *   healMul                × a lo que le curan · cdMul × a la recarga de todo
 *   critMul                daño del crítico (normal ×1,5)
 *   summon                 pone ese clima al empezar y cada 3 min (si no hay otro)
 *   sheer / serene         quita / dobla los estados (quemar, envenenar, frenar) y los empujones
 *   steady / levitate / sturdy / lavaProof / trapProof   marcas
 * Cada descripción es [español, inglés].
 */
export type Text = readonly [es: string, en: string];
type MoveLike = { id?: string; type?: PokeType; cat?: MoveCat; kind?: string; burn?: number; poison?: number; slow?: number; knock?: number;
                  dmg?: number; count?: number; bounce?: number };
type Cls = MoveCat | null;

export interface AbilityFx {
  d: Text;
  /** Pasiva genérica de su tipo (sólo si la habilidad no tiene efecto propio). */
  generic?: boolean;
  start?(pl: Player): void;
  out?(pl: Player, m: MoveLike): number;
  vs?(pl: Player, m: MoveLike, e: Enemy): number;
  hit?(pl: Player, e: Enemy, m: MoveLike | undefined): void;
  inMul?(pl: Player, type: PokeType | null, cat: Cls): number;
  absorb?: PokeType;
  dodge?(pl: Player, type: PokeType | null, cat: Cls): number;
  hurt?(pl: Player, type: PokeType | null, cat: Cls): void;
  contact?(pl: Player, e: Enemy): void;
  tick?(pl: Player, dt: number): void;
  kill?(pl: Player, e: Enemy): void;
  speed?(pl: Player): number;
  healMul?: number;
  cdMul?: number;
  critMul?: number;
  summon?: string;
  sheer?: boolean; serene?: boolean;
  steady?: boolean; levitate?: boolean; sturdy?: boolean; lavaProof?: boolean; trapProof?: boolean;
}

export const AbilityFX = (() => {
  const TYPE_EN: Record<string, string> = {
    normal: 'Normal', fire: 'Fire', water: 'Water', grass: 'Grass', electric: 'Electric', ice: 'Ice', fighting: 'Fighting',
    poison: 'Poison', ground: 'Ground', flying: 'Flying', psychic: 'Psychic', bug: 'Bug', rock: 'Rock', ghost: 'Ghost',
    dragon: 'Dragon', dark: 'Dark', steel: 'Steel', fairy: 'Fairy'
  };
  const tn = (t: string): Text => [(G.U.TYPE_NAME as Record<string, string>)[t] || t, TYPE_EN[t] || t];
  const WX: Record<string, Text> = {
    sun: ['sol', 'sun'], rain: ['lluvia', 'rain'], sand: ['tormenta de arena', 'a sandstorm'], snow: ['nieve', 'snow']
  };
  const wx = () => ((G.Weather.current || {}) as { kind?: string }).kind;
  const low = (pl: Player) => pl.hp < pl.maxHp / 3;
  const half = (pl: Player) => pl.hp < pl.maxHp / 2;
  const heal = (pl: Player, k: number) => { pl.hp = Math.min(pl.maxHp, pl.hp + pl.maxHp * k); };
  const st = (pl: Player) => pl.ab || (pl.ab = {});
  const melee = (m: MoveLike) => m.kind === 'melee' || m.kind === 'dash' || m.kind === 'spin';
  const superEff = (pl: Player, type: PokeType | null) => !!type && G.Types.mult(type, pl.mon.types) > 1;
  const effOn = (type: PokeType | undefined, e: Enemy) => (type ? G.Types.mult(type, e.types) : 1);

  // ---------- constructores ----------
  const pinch = (type: PokeType): AbilityFx => ({
    d: [`+35 % de daño de tipo ${tn(type)[0]} con poca vida (menos de un tercio).`, `+35% ${tn(type)[1]} damage when low on HP (under a third).`],
    out: (pl, m) => (m.type === type && low(pl) ? 1.35 : 1)
  });
  const boost = (type: PokeType, k = 1.2): AbilityFx => ({
    d: [`+${Math.round((k - 1) * 100)} % de daño con movimientos de tipo ${tn(type)[0]}.`, `+${Math.round((k - 1) * 100)}% damage with ${tn(type)[1]}-type moves.`],
    out: (pl, m) => (m.type === type ? k : 1)
  });
  const byName = (re: RegExp, es: string, en: string, k = 1.25): AbilityFx => ({
    d: [`+${Math.round((k - 1) * 100)} % de daño con ${es}.`, `+${Math.round((k - 1) * 100)}% damage with ${en}.`],
    out: (pl, m) => (m.id && re.test(m.id) ? k : 1)
  });
  const absorb = (type: PokeType): AbilityFx => ({
    d: [`Los ataques de tipo ${tn(type)[0]} no le hacen daño: le curan un poco.`, `${tn(type)[1]}-type attacks do no damage: they heal a little.`],
    absorb: type
  });
  const rush = (w: string): AbilityFx => ({
    d: [`+50 % de velocidad con ${WX[w][0]}.`, `+50% speed in ${WX[w][1]}.`], speed: () => (wx() === w ? 1.5 : 1)
  });
  const summon = (w: string): AbilityFx => ({
    d: [`Pone ${WX[w][0]} al empezar y cada 3 minutos (si no hay otro clima).`, `Brings ${WX[w][1]} at the start and every 3 minutes (if there is no other weather).`], summon: w
  });
  const flat = (k: number): AbilityFx => ({ d: [`Recibe un ${Math.round((1 - k) * 100)} % menos de daño.`, `Takes ${Math.round((1 - k) * 100)}% less damage.`], inMul: () => k });
  const steady: AbilityFx = { d: ['No le frenan las trampas pegajosas ni el terreno.', 'Sticky traps and rough terrain do not slow it.'], steady: true };
  const magnet = (k: number): AbilityFx => ({
    d: [`Atrae los objetos desde más lejos (+${Math.round((k - 1) * 100)} %).`, `Pulls items in from farther away (+${Math.round((k - 1) * 100)}%).`],
    start: pl => { pl.magnet *= k; }
  });
  const coins: AbilityFx = { d: ['+12 % de Pokémonedas en la partida.', '+12% Pokémonedas in the run.'], start: pl => { pl.coinMul *= 1.12; } };
  const moxie: AbilityFx = {
    d: ['Cada enemigo derrotado le da +0,5 % de daño (hasta +15 %).', 'Each defeated enemy gives +0.5% damage (up to +15%).'],
    kill: pl => { const s = st(pl); s.moxie = Math.min(0.15, (s.moxie || 0) + 0.005); },
    out: pl => 1 + (pl.ab && pl.ab.moxie || 0)
  };
  const contact = (fn: (pl: Player, e: Enemy) => void, es: string, en: string): AbilityFx => ({ d: [es, en], contact: fn });
  const thorns = (pl: Player) => 10 + pl.level * 3;
  const crit = (p: number): AbilityFx => ({
    d: [`+${p} % de probabilidad de golpe crítico.`, `+${p}% critical hit chance.`], start: pl => { pl.critChance += p / 100; }
  });
  const regen = (pct: number): AbilityFx => ({
    d: [`Recupera un ${String(pct).replace('.', ',')} % de su vida por segundo.`, `Recovers ${pct}% of its HP per second.`], start: pl => { pl.regenFlat += pl.maxHp * pct / 100; }
  });
  const dodgeAll = (p: number): AbilityFx => ({ d: [`Esquiva el ${p} % de los golpes.`, `Dodges ${p}% of hits.`], dodge: () => p / 100 });

  const FX: Record<string, AbilityFx> = {
    // --- más daño ---
    overgrow: pinch('grass'), blaze: pinch('fire'), torrent: pinch('water'), swarm: pinch('bug'),
    steelworker: boost('steel'), 'steely-spirit': boost('steel'), 'dragons-maw': boost('dragon'), transistor: boost('electric'),
    'sand-spit': boost('ground', 1.1),
    'water-bubble': {
      d: ['+40 % de daño de tipo Agua y recibe la mitad de daño de Fuego.', '+40% Water damage and takes half damage from Fire.'],
      out: (pl, m) => (m.type === 'water' ? 1.4 : 1), inMul: (pl, type) => (type === 'fire' ? 0.5 : 1)
    },
    technician: { d: ['+35 % de daño con los ataques de golpes flojos.', '+35% damage with weak-hitting moves.'], out: (pl, m) => ((m.dmg || 99) <= 12 ? 1.35 : 1) },
    'huge-power': { d: ['+50 % de daño con movimientos físicos.', '+50% damage with physical moves.'], out: (pl, m) => (m.cat === 'phys' ? 1.5 : 1) },
    hustle: {
      d: ['+25 % de daño físico, pero 1 de cada 6 golpes físicos sale flojo.', '+25% physical damage, but 1 in 6 physical hits comes out weak.'],
      out: (pl, m) => (m.cat === 'phys' ? 1.25 : 1),
      // (El golpe flojo se echa a suertes en cada golpe, no en atkFor: el HUD lo lee muchas veces.)
      vs: (pl, m) => (m.cat === 'phys' && Math.random() < 1 / 6 ? 0.3 / 1.25 : 1)
    },
    guts: { d: ['+30 % de daño físico con menos de la mitad de vida.', '+30% physical damage under half HP.'], out: (pl, m) => (m.cat === 'phys' && half(pl) ? 1.3 : 1) },
    adaptability: { d: ['+25 % de daño con los movimientos de sus tipos.', '+25% damage with moves of its own types.'], out: (pl, m) => (m.type && pl.mon.types.includes(m.type) ? 1.25 : 1) },
    protean: { d: ['+12 % de daño con todos sus movimientos.', '+12% damage with all its moves.'], out: () => 1.12 },
    'sheer-force': {
      d: ['+25 % de daño con movimientos que queman, envenenan, frenan o empujan, pero pierden ese efecto.', '+25% damage with moves that burn, poison, slow or push back, but they lose that effect.'],
      out: (pl, m) => (m.burn || m.poison || m.slow || m.knock ? 1.25 : 1), sheer: true
    },
    'serene-grace': { d: ['Las quemaduras, venenos y frenazos de sus movimientos son el doble de fuertes.', 'Burns, poison and slows from its moves are twice as strong.'], serene: true },
    'tough-claws': { d: ['+25 % de daño con ataques cuerpo a cuerpo y embestidas.', '+25% damage with melee moves and dashes.'], out: (pl, m) => (melee(m) ? 1.25 : 1) },
    reckless: { d: ['+25 % de daño con las embestidas.', '+25% damage with dashing moves.'], out: (pl, m) => (m.kind === 'dash' ? 1.25 : 1) },
    'iron-fist': byName(/punch|meteor-mash/, 'los puñetazos', 'punching moves'),
    'strong-jaw': byName(/bite|fang|crunch/, 'los mordiscos', 'biting moves', 1.3),
    'mega-launcher': byName(/pulse|aura-sphere|beam/, 'los pulsos, esferas y rayos', 'pulses, spheres and beams', 1.25),
    sharpness: byName(/cut|slash|blade|claw/, 'los cortes y zarpazos', 'slashing and clawing moves', 1.25),
    'punk-rock': byName(/voice|buzz|boom|noise|wind|breath/, 'los sonidos y soplidos', 'sound and wind moves', 1.25),
    'tinted-lens': {
      d: ['Sus movimientos poco eficaces hacen daño normal.', 'Its not-very-effective moves deal normal damage.'],
      vs: (pl, m, e) => { const k = effOn(m.type, e); return k < 1 && k > 0 ? 1 / k : 1; }
    },
    scrappy: {
      d: ['Sus movimientos Normal y Lucha dañan del todo a los Fantasma.', 'Its Normal and Fighting moves fully damage Ghosts.'],
      vs: (pl, m, e) => ((m.type === 'normal' || m.type === 'fighting') && e.types.includes('ghost') ? 1 / Math.max(0.3, effOn(m.type, e)) : 1)
    },
    'sand-force': {
      d: ['+30 % de daño Roca, Tierra y Acero con tormenta de arena.', '+30% Rock, Ground and Steel damage in a sandstorm.'],
      out: (pl, m) => (wx() === 'sand' && (m.type === 'rock' || m.type === 'ground' || m.type === 'steel') ? 1.3 : 1)
    },
    'solar-power': {
      d: ['+40 % de daño especial con sol, pero el sol le quita algo de vida.', '+40% special damage in sun, but the sun drains some HP.'],
      out: (pl, m) => (wx() === 'sun' && m.cat === 'spec' ? 1.4 : 1),
      tick: (pl, dt) => { if (wx() === 'sun' && pl.hp > pl.maxHp * 0.1) pl.hp -= pl.maxHp * 0.004 * dt; }
    },
    sniper: { d: ['Sus golpes críticos hacen ×2 de daño (en vez de ×1,5).', 'Its critical hits do ×2 damage (instead of ×1.5).'], critMul: 2 },
    'super-luck': crit(10), 'compound-eyes': crit(6), 'keen-eye': crit(5),
    moxie, 'chilling-neigh': moxie, 'grim-neigh': moxie, 'beast-boost': moxie,
    analytic: { d: ['+15 % de daño a enemigos con menos de la mitad de vida.', '+15% damage to enemies under half HP.'], vs: (pl, m, e) => (e.hp < e.maxHp * 0.5 ? 1.15 : 1) },
    'mold-breaker': { d: ['+12 % de daño a los jefes.', '+12% damage to bosses.'], vs: (pl, m, e) => (e.boss ? 1.12 : 1) },
    rivalry: {
      d: ['+15 % de daño a enemigos que comparten un tipo con él.', '+15% damage to enemies that share a type with it.'],
      vs: (pl, m, e) => (e.types.some(t => pl.mon.types.includes(t)) ? 1.15 : 1)
    },
    'skill-link': { d: ['+25 % de daño con movimientos de varios golpes.', '+25% damage with multi-hit moves.'], out: (pl, m) => ((m.count || 1) > 2 || m.bounce ? 1.25 : 1) },
    plus: { d: ['+10 % de daño con movimientos especiales.', '+10% damage with special moves.'], out: (pl, m) => (m.cat === 'spec' ? 1.1 : 1) },
    minus: { d: ['+10 % de daño con movimientos especiales.', '+10% damage with special moves.'], out: (pl, m) => (m.cat === 'spec' ? 1.1 : 1) },
    'hyper-cutter': { d: ['+8 % de daño con movimientos físicos.', '+8% damage with physical moves.'], out: (pl, m) => (m.cat === 'phys' ? 1.08 : 1) },
    'no-guard': { d: ['Todo acierta: +15 % de daño hecho, pero recibe un 10 % más.', 'Everything lands: +15% damage dealt, but takes 10% more.'], out: () => 1.15, inMul: () => 1.1 },
    protosynthesis: { d: ['Con sol, +20 % de daño.', '+20% damage in sun.'], out: () => (wx() === 'sun' ? 1.2 : 1) },
    'quark-drive': { d: ['Con lluvia, +15 % de daño.', '+15% damage in rain.'], out: () => (wx() === 'rain' ? 1.15 : 1) },
    steadfast: {
      d: ['Al recibir un golpe, +10 % de velocidad un momento (se acumula).', 'When hit, +10% speed for a moment (stacks).'],
      hurt: pl => pl.addBuff('spd', 0.1, 3, 2)
    },

    // --- velocidad ---
    'speed-boost': {
      d: ['Cada 10 segundos va un 1,5 % más rápido (hasta +30 %).', 'Every 10 seconds it gets 1.5% faster (up to +30%).'],
      tick: (pl, dt) => { const s = st(pl); s.boostT = (s.boostT || 0) + dt; if (s.boostT >= 10) { s.boostT = 0; s.speed = Math.min(0.3, (s.speed || 0) + 0.015); } },
      speed: pl => 1 + (pl.ab && pl.ab.speed || 0)
    },
    'swift-swim': rush('rain'), chlorophyll: rush('sun'), 'sand-rush': rush('sand'), 'slush-rush': rush('snow'),
    'run-away': { d: ['+8 % de velocidad.', '+8% speed.'], speed: () => 1.08 },
    unburden: { d: ['Sin objeto equipado va un 12 % más rápido.', 'With no held item it moves 12% faster.'], speed: pl => (pl.item ? 1 : 1.12) },
    'quick-feet': { d: ['Frenado, va más rápido (en vez de más lento).', 'When slowed, it goes faster instead.'], speed: pl => (pl.slowT > 0 ? 2.5 : 1) },
    klutz: { d: ['Sin objeto equipado, +12 % de daño.', 'With no held item, +12% damage.'], out: pl => (pl.item ? 1 : 1.12) },

    // --- climas ---
    drought: summon('sun'), 'orichalcum-pulse': summon('sun'), drizzle: summon('rain'), 'sand-stream': summon('sand'), 'snow-warning': summon('snow'),
    'rain-dish': { d: ['Con lluvia recupera un 1,5 % de vida por segundo.', 'Recovers 1.5% HP per second in rain.'], tick: (pl, dt) => { if (wx() === 'rain') heal(pl, 0.015 * dt); } },
    'ice-body': { d: ['Con nieve recupera un 1,5 % de vida por segundo.', 'Recovers 1.5% HP per second in snow.'], tick: (pl, dt) => { if (wx() === 'snow') heal(pl, 0.015 * dt); } },
    'dry-skin': {
      d: ['El Agua le cura y con lluvia recupera vida, pero el Fuego le hace un 25 % más.', 'Water heals it and it recovers HP in rain, but Fire hurts 25% more.'],
      absorb: 'water', inMul: (pl, type) => (type === 'fire' ? 1.25 : 1), tick: (pl, dt) => { if (wx() === 'rain') heal(pl, 0.012 * dt); }
    },
    'sand-veil': { d: ['Con tormenta de arena esquiva el 15 % de los golpes.', 'Dodges 15% of hits in a sandstorm.'], dodge: () => (wx() === 'sand' ? 0.15 : 0) },
    'snow-cloak': { d: ['Con nieve esquiva el 15 % de los golpes.', 'Dodges 15% of hits in snow.'], dodge: () => (wx() === 'snow' ? 0.15 : 0) },
    'leaf-guard': {
      d: ['Con sol no le frena nada y recibe un 15 % menos de daño.', 'In sun nothing slows it and it takes 15% less damage.'],
      tick: pl => { if (wx() === 'sun') pl.slowT = 0; }, inMul: () => (wx() === 'sun' ? 0.85 : 1)
    },
    hydration: {
      d: ['Con lluvia recupera un 1 % de vida por segundo y nada le frena.', 'In rain it recovers 1% HP per second and nothing slows it.'],
      tick: (pl, dt) => { if (wx() === 'rain') { heal(pl, 0.01 * dt); pl.slowT = 0; } }
    },

    // --- defensa ---
    levitate: { d: ['Flota: no le afectan el agua, la lava ni las trampas, y la Tierra le hace muy poco.', 'Floats: water, lava and traps do nothing, and Ground barely hurts.'], levitate: true, inMul: (pl, type) => (type === 'ground' ? 0.3 : 1) },
    'thick-fat': { d: ['Recibe un 40 % menos de daño de Fuego y Hielo.', 'Takes 40% less Fire and Ice damage.'], inMul: (pl, type) => (type === 'fire' || type === 'ice' ? 0.6 : 1) },
    heatproof: { d: ['Recibe la mitad de daño de Fuego.', 'Takes half Fire damage.'], inMul: (pl, type) => (type === 'fire' ? 0.5 : 1) },
    'water-absorb': absorb('water'), 'storm-drain': absorb('water'), 'volt-absorb': absorb('electric'), 'lightning-rod': absorb('electric'),
    'motor-drive': absorb('electric'), 'flash-fire': absorb('fire'), 'well-baked-body': absorb('fire'), 'sap-sipper': absorb('grass'), 'earth-eater': absorb('ground'),
    multiscale: { d: ['Con la vida casi llena recibe la mitad de daño.', 'With nearly full HP it takes half damage.'], inMul: pl => (pl.hp >= pl.maxHp * 0.95 ? 0.5 : 1) },
    'shadow-shield': { d: ['Con la vida casi llena recibe la mitad de daño.', 'With nearly full HP it takes half damage.'], inMul: pl => (pl.hp >= pl.maxHp * 0.95 ? 0.5 : 1) },
    filter: { d: ['Los ataques muy eficaces le hacen un 25 % menos.', 'Super effective attacks do 25% less.'], inMul: (pl, type) => (superEff(pl, type) ? 0.75 : 1) },
    'solid-rock': { d: ['Los ataques muy eficaces le hacen un 25 % menos.', 'Super effective attacks do 25% less.'], inMul: (pl, type) => (superEff(pl, type) ? 0.75 : 1) },
    'prism-armor': { d: ['Los ataques muy eficaces le hacen un 25 % menos.', 'Super effective attacks do 25% less.'], inMul: (pl, type) => (superEff(pl, type) ? 0.75 : 1) },
    'fur-coat': { d: ['Recibe un 40 % menos de daño físico.', 'Takes 40% less physical damage.'], inMul: (pl, type, c) => (c === 'phys' ? 0.6 : 1) },
    fluffy: { d: ['Recibe un 30 % menos de daño físico.', 'Takes 30% less physical damage.'], inMul: (pl, type, c) => (c === 'phys' ? 0.7 : 1) },
    'ice-scales': { d: ['Recibe un 40 % menos de daño especial.', 'Takes 40% less special damage.'], inMul: (pl, type, c) => (c === 'spec' ? 0.6 : 1) },
    'shell-armor': flat(0.92), 'battle-armor': flat(0.92), pressure: flat(0.92), unaware: flat(0.92),
    'friend-guard': flat(0.94), unnerve: flat(0.94),
    intimidate: { d: ['Los enemigos le hacen un 12 % menos de daño físico.', 'Enemies deal 12% less physical damage to it.'], inMul: (pl, type, c) => (c === 'phys' ? 0.88 : 1) },
    soundproof: { d: ['Recibe un 10 % menos de daño especial.', 'Takes 10% less special damage.'], inMul: (pl, type, c) => (c === 'spec' ? 0.9 : 1) },
    overcoat: { d: ['Recibe un 6 % menos de daño especial.', 'Takes 6% less special damage.'], inMul: (pl, type, c) => (c === 'spec' ? 0.94 : 1) },
    'big-pecks': { d: ['Recibe un 8 % menos de daño físico.', 'Takes 8% less physical damage.'], inMul: (pl, type, c) => (c === 'phys' ? 0.92 : 1) },
    bulletproof: { d: ['Recibe un 15 % menos de daño especial.', 'Takes 15% less special damage.'], inMul: (pl, type, c) => (c === 'spec' ? 0.85 : 1) },
    'magic-bounce': {
      d: ['Recibe un 15 % menos de daño especial y esquiva el 10 % de esos golpes.', 'Takes 15% less special damage and dodges 10% of those hits.'],
      inMul: (pl, type, c) => (c === 'spec' ? 0.85 : 1), dodge: (pl, type, c) => (c === 'spec' ? 0.1 : 0)
    },
    'water-veil': { d: ['La lava no le quema y recibe la mitad de daño de Fuego.', 'Lava does not burn it and it takes half Fire damage.'], lavaProof: true, inMul: (pl, type) => (type === 'fire' ? 0.5 : 1) },
    sturdy: { d: ['Un golpe que le dejaría KO le deja con 1 de vida (cada 90 s).', 'A hit that would KO it leaves it at 1 HP (every 90 s).'], sturdy: true },
    regenerator: regen(0.6), 'natural-cure': regen(0.3), healer: regen(0.3), 'poison-heal': regen(0.4),
    'magic-guard': { d: ['Sólo le hacen daño los ataques: ni la lava ni las trampas.', 'Only attacks hurt it: not lava, not traps.'], lavaProof: true, trapProof: true },
    stamina: { d: ['Cada golpe cuerpo a cuerpo que recibe le sube un poco la defensa.', 'Each melee hit it takes raises its defense a little.'], contact: pl => pl.addBuff('def', 0.03, 6, 5) },
    'weak-armor': { d: ['Al recibir un golpe físico, +20 % de velocidad un momento.', 'When hit physically, +20% speed for a moment.'], hurt: (pl, type, c) => { if (c === 'phys') pl.addBuff('spd', 0.2, 3, 1); } },
    rattled: {
      d: ['Los golpes de Bicho, Fantasma o Siniestro le asustan: +25 % de velocidad un momento.', 'Bug, Ghost and Dark hits spook it: +25% speed for a moment.'],
      hurt: (pl, type) => { if (type === 'bug' || type === 'ghost' || type === 'dark') pl.addBuff('spd', 0.25, 4, 1); }
    },
    limber: steady, 'own-tempo': steady, oblivious: steady, 'inner-focus': steady, 'clear-body': steady, 'white-smoke': steady,
    'full-metal-body': steady, insomnia: steady, 'vital-spirit': steady, 'early-bird': steady, 'shield-dust': steady, 'sweet-veil': steady,
    'shed-skin': {
      d: ['Cada 5 s muda: se quita los frenazos y recupera un 2 % de vida.', 'Every 5 s it sheds: clears slows and recovers 2% HP.'],
      tick: (pl, dt) => { const s = st(pl); s.shedT = (s.shedT || 0) + dt; if (s.shedT >= 5) { s.shedT = 0; pl.slowT = 0; heal(pl, 0.02); } }
    },
    'tangled-feet': { d: ['Frenado, esquiva el 20 % de los golpes.', 'When slowed, dodges 20% of hits.'], dodge: pl => (pl.slowT > 0 ? 0.2 : 0) },
    telepathy: dodgeAll(8), anticipation: dodgeAll(6), forewarn: dodgeAll(6),

    // --- contraataques ---
    static: contact((pl, e) => e.applySlow(0.5, 2.5), 'Quien le golpea cuerpo a cuerpo se queda frenado (paralizado).', 'Whoever hits it in melee gets slowed (paralyzed).'),
    'flame-body': contact((pl, e) => e.applyBurn(2), 'Quien le golpea cuerpo a cuerpo se quema.', 'Whoever hits it in melee gets burned.'),
    'poison-point': contact((pl, e) => e.applyPoison(2), 'Quien le golpea cuerpo a cuerpo se envenena.', 'Whoever hits it in melee gets poisoned.'),
    'cute-charm': contact((pl, e) => e.applySlow(0.4, 2.5), 'Quien le golpea cuerpo a cuerpo se queda embobado (frenado).', 'Whoever hits it in melee is charmed (slowed).'),
    'effect-spore': contact((pl, e) => (Math.random() < 0.5 ? e.applySlow(0.45, 2.5) : e.applyPoison(2)), 'Quien le golpea cuerpo a cuerpo se frena o se envenena.', 'Whoever hits it in melee is slowed or poisoned.'),
    'rough-skin': contact((pl, e) => e.hurt(thorns(pl), '#9aa6b5'), 'Quien le golpea cuerpo a cuerpo recibe daño.', 'Whoever hits it in melee takes damage.'),
    'iron-barbs': contact((pl, e) => e.hurt(thorns(pl), '#9aa6b5'), 'Quien le golpea cuerpo a cuerpo recibe daño.', 'Whoever hits it in melee takes damage.'),
    synchronize: contact((pl, e) => e.hurt(6 + pl.level * 2, '#ff9fcf'), 'Quien le golpea cuerpo a cuerpo recibe parte del golpe.', 'Whoever hits it in melee takes part of the blow.'),
    'cursed-body': contact((pl, e) => { if (Math.random() < 0.3) e.applySlow(0.5, 2); }, 'A veces frena a quien le golpea cuerpo a cuerpo.', 'Sometimes slows whoever hits it in melee.'),
    'poison-touch': { d: ['Sus ataques cuerpo a cuerpo y embestidas envenenan a veces.', 'Its melee and dash moves sometimes poison.'], hit: (pl, e, m) => { if (m && melee(m) && Math.random() < 0.3) e.applyPoison(1); } },
    corrosion: { d: ['Sus golpes envenenan a veces (1 de cada 5).', 'Its hits sometimes poison (1 in 5).'],
                 hit: (pl, e) => { if (Math.random() < 0.2) e.applyPoison(1); } },
    'toxic-debris': { d: ['Al recibir un golpe físico, envenena a los enemigos de su alrededor.', 'When hit physically, it poisons the enemies around it.'],
                      hurt: (pl, type, c) => { if (c === 'phys') for (const e of G.EnemyMgr.queryCircle(pl.x, pl.y, 110)) if (!e.dead) e.applyPoison(2); } },
    stench: { d: ['Sus golpes a veces frenan (1 de cada 10).', 'Its hits sometimes slow (1 in 10).'], hit: (pl, e) => { if (Math.random() < 0.1) e.applySlow(0.35, 1.5); } },

    // --- botín y varios ---
    pickup: coins, 'honey-gather': coins, 'ball-fetch': coins,
    frisk: magnet(1.2), 'magnet-pull': magnet(1.2), 'sticky-hold': magnet(1.2), illuminate: magnet(1.1),
    gluttony: { d: ['Las curas le curan un 40 % más.', 'Healing heals it 40% more.'], healMul: 1.4 },
    harvest: { d: ['Las curas le curan un 30 % más.', 'Healing heals it 30% more.'], healMul: 1.3 },
    'cheek-pouch': { d: ['Las curas le curan un 30 % más.', 'Healing heals it 30% more.'], healMul: 1.3 },
    prankster: { d: ['Todo se recarga un 6 % antes.', 'Everything recharges 6% faster.'], cdMul: 0.94 },
    justified: { d: ['+15 % de daño a los enemigos de tipo Siniestro.', '+15% damage to Dark-type enemies.'], vs: (pl, m, e) => (e.types.includes('dark') ? 1.15 : 1) },
    pickpocket: { d: ['+8 % de Pokémonedas en la partida.', '+8% Pokémonedas in the run.'], start: pl => { pl.coinMul *= 1.08; } },
    'anger-point': {
      d: ['La primera vez que baja de la mitad de vida se enfurece: +25 % de daño el resto de la partida.', 'The first time it drops under half HP it flies into a rage: +25% damage for the rest of the run.'],
      tick: pl => { const s = st(pl); if (!s.angry && half(pl)) { s.angry = 1; G.FX.dmgText(pl.x, pl.y - pl.bodyH - 16, '¡Irascible!', '#ff6b4d', true); } },
      out: pl => (pl.ab && pl.ab.angry ? 1.25 : 1)
    },
    aftermath: {
      d: ['Una vez por partida, al quedar con poca vida, explota y daña a los de alrededor.', 'Once per run, when it gets low on HP, it blows up and damages everything around.'],
      tick: pl => {
        const s = st(pl);
        if (s.boomed || pl.hp >= pl.maxHp * 0.2 || pl.dead) return;
        s.boomed = 1;
        G.FX.ring(pl.x, pl.y, 10, 140, '#ff7b3d', 0.5, 6); G.Camera.kick(0.6); G.Audio.sfx('break');
        for (const e of G.EnemyMgr.queryCircle(pl.x, pl.y, 140)) e.hurt(40 + pl.level * 10, '#ff7b3d', e.x - pl.x, e.y - pl.y, 160);
      }
    },
    moody: {
      d: ['Cada 10 s, +10 % a algo al azar: ataque, ataque especial, velocidad o defensa.', 'Every 10 s, +10% to something random: attack, special attack, speed or defense.'],
      tick: (pl, dt) => {
        const s = st(pl);
        s.moodT = (s.moodT || 0) - dt;
        if (s.moodT > 0) return;
        s.moodT = 10; s.mood = G.U.pick([1, 2, 3, 4]);
        G.FX.ring(pl.x, pl.y, pl.r * 2.4, pl.r * 1.1, ['', '#ff6b4d', '#ff8ad8', '#7fe0ff', '#b0b8c8'][s.mood], 0.35, 2.5);
      },
      out: (pl, m) => (pl.ab && pl.ab.mood === (m.cat === 'spec' ? 2 : 1) ? 1.1 : 1),
      speed: pl => (pl.ab && pl.ab.mood === 3 ? 1.1 : 1), inMul: pl => (pl.ab && pl.ab.mood === 4 ? 0.9 : 1)
    },

    // --- las que en los juegos son un lastre: aquí, un intercambio ---
    truant: { d: ['Golpes sueltos y fuertes: tarda un 60 % más en recargar, pero cada golpe hace +35 %.', 'Slow, heavy hits: recharges 60% slower, but every hit does +35%.'], cdMul: 1.6, out: () => 1.35 },
    'slow-start': {
      d: ['Arranca lento: el primer minuto hace −40 % de daño y va más despacio; después, a plena potencia.', 'Starts slow: for the first minute it deals −40% damage and moves slower; then it is at full power.'],
      tick: (pl, dt) => { const s = st(pl); s.ss = (s.ss || 0) + dt; },
      out: pl => ((pl.ab && pl.ab.ss || 0) < 60 ? 0.6 : 1), speed: pl => ((pl.ab && pl.ab.ss || 0) < 60 ? 0.8 : 1)
    },
    defeatist: { d: ['Cañón de cristal: +15 % de daño con más de la mitad de vida; con menos, −25 %.', 'Glass cannon: +15% damage above half HP; below it, −25%.'], out: pl => (half(pl) ? 0.75 : 1.15) },
    'wonder-guard': {
      d: ['Lo que no es muy eficaz apenas le hace daño (35 %); lo muy eficaz, un 50 % más.', 'What is not super effective barely hurts it (35%); what is, hurts 50% more.'],
      inMul: (pl, type) => (superEff(pl, type) ? 1.5 : 0.35)
    },
    schooling: {
      d: ['Forma banco: +25 % de vida y, con más de un cuarto de vida, +40 % de daño.', 'Schools together: +25% HP and, above a quarter of its HP, +40% damage.'],
      start: pl => { pl.maxHp = Math.round(pl.maxHp * 1.25); pl.hp = pl.maxHp; }, out: pl => (pl.hp > pl.maxHp / 4 ? 1.4 : 1)
    },
    'zen-mode': { d: ['Con menos de la mitad de vida entra en Modo Daruma: +30 % de daño especial.', 'Under half HP it enters Zen Mode: +30% special damage.'], out: (pl, m) => (half(pl) && m.cat === 'spec' ? 1.3 : 1) },
    imposter: {
      d: ['Se transforma: pega y aguanta igual por los dos lados (la media de los suyos).', 'It transforms: hits and endures the same on both sides (the average of its own).'],
      start: pl => { pl.basePhys = pl.baseSpec = (pl.basePhys + pl.baseSpec) / 2; pl.guardPhys = pl.guardSpec = (pl.guardPhys + pl.guardSpec) / 2; }
    }
  };
  // Alias: lo que es igual que otra.
  FX['pure-power'] = FX['huge-power'];
  FX['libero'] = FX['protean'];

  /** Pasiva genérica: +6 % con los movimientos de su tipo principal. */
  function generic(mon: { types: PokeType[] }): AbilityFx {
    const t = mon.types[0];
    return { generic: true, d: [`+6 % de daño con movimientos de tipo ${tn(t)[0]}.`, `+6% damage with ${tn(t)[1]}-type moves.`], out: (pl, m) => (m.type === t ? 1.06 : 1) };
  }

  /** Efecto de la habilidad `id` para ese Pokémon (nunca null). */
  function of(id: string, mon: { types: PokeType[] }): AbilityFx {
    return (id && FX[id]) || generic(mon);
  }

  /** La descripción en el idioma del juego. */
  const describe = (fx: AbilityFx): string => fx.d[G.I18n.lang === 'es' ? 0 : 1];

  return { FX, of, describe };
})();
G.AbilityFX = AbilityFX;

declare module '../g' {
  interface Registry { AbilityFX: typeof AbilityFX }
}
