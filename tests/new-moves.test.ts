/* ============ new-moves.test.ts — los 38 ataques nuevos, el movimiento inicial elegido y los monotipos ============
 *   bun test tests/new-moves.test.ts
 * El catálogo, quién los aprende, las traducciones, el daño de un monotipo, la mejora Movimiento inicial
 * (con el guardado) y cada forma nueva de atacar (perseguir, rebotar, cargar, girar, onda por el suelo,
 * remolino, empujón y aturdir) con el resto del juego simulado, sin navegador.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { G } from '../src/g';
import '../src/core/util';
import '../src/data/types';
import '../src/data/pokedex';
import '../src/data/base-stats';
import { Moves } from '../src/data/moves';
import '../src/data/upgrades';
import '../src/data/starters';
import '../src/systems/weather';
import '../src/entities/projectile';
import { Combat } from '../src/systems/combat';
import { Enemy } from '../src/entities/enemy';
import { Player } from '../src/entities/player';
import { DB } from '../src/core/db';

const G_ = globalThis as any;
const NEW = [
  'hyper-beam', 'rapid-spin', 'flame-charge', 'whirlpool', 'seed-bomb', 'energy-ball', 'solar-beam', 'thunder-wave', 'electro-ball',
  'extrasensory', 'mist-ball', 'acid-spray', 'sand-tomb', 'magnitude', 'whirlwind', 'air-slash', 'signal-beam', 'u-turn', 'rock-tomb',
  'ancient-power', 'power-gem', 'ice-shard', 'freeze-dry', 'rolling-kick', 'vacuum-wave', 'dynamic-punch', 'shadow-sneak',
  'ominous-wind', 'dragon-breath', 'dragon-claw', 'outrage', 'draining-kiss', 'play-rough', 'disarming-voice', 'mirror-shot',
  'gyro-ball', 'sucker-punch', 'night-slash'
];
const NEW_KINDS = ['homing', 'bounce', 'charge', 'spin', 'quake', 'vortex', 'shove', 'stun'];

describe('catálogo', () => {
  test('son 38, con categoría, escalera de mejoras y evolución', () => {
    expect(NEW.length).toBe(38);
    expect(new Set(NEW).size).toBe(38);
    for (const id of NEW) {
      const d = Moves.BY_ID[id];
      expect(d, id).toBeDefined();
      expect(['phys', 'spec'], id).toContain(d.cat);
      expect(d.ups!.length, id).toBe(4);
      expect(Moves.EVO[id], id).toBeDefined();
      const m = Moves.instance(id, d.maxLvl!);
      expect(Moves.evoInfo(m, {})!.text, id).toBeTruthy();
    }
  });

  test('las ocho formas nuevas salen en alguno', () => {
    const kinds = new Set(NEW.map(id => Moves.BY_ID[id].kind));
    for (const k of NEW_KINDS) expect(kinds.has(k as never), k).toBe(true);
  });

  test('todos los tipos tienen 5 o más movimientos (los que salen por tipo; Maquinación sólo a quien la aprende)', () => {
    for (const t of Object.keys(G.U.TYPE_COLOR)) expect((Moves.POOL[t] || []).length, t).toBeGreaterThanOrEqual(5);
  });

  test('los de Roca, Lucha, Dragón y Hada (antes sólo 2) salen a quien es de ese tipo', () => {
    const pool = (types: string[]) => Moves.poolFor({ types: types as never }, true);
    expect(pool(['rock']).filter(id => Moves.BY_ID[id].type === 'rock').length).toBeGreaterThanOrEqual(5);
    expect(pool(['fighting']).filter(id => Moves.BY_ID[id].type === 'fighting').length).toBeGreaterThanOrEqual(5);
    expect(pool(['dragon'])).toContain('outrage');
    expect(pool(['fairy'])).toContain('play-rough');
    expect(pool(['normal'])).toContain('hyper-beam');            // los Normal los tienen todos
    expect(pool(['water'])).not.toContain('outrage');
  });

  test('la Defensa pide la lista sin los nuevos y su reparto de torres no cambia', () => {
    for (const dex of [6, 9, 94, 130, 149, 282]) {
      const mon = G.DEX_BY[dex];
      const before = Moves.poolFor(mon);
      expect(before.filter(id => NEW.includes(id)), String(dex)).toEqual([]);
      expect(Moves.poolFor(mon, true).length, String(dex)).toBeGreaterThan(before.length);
    }
  });

  test('tienen nombre, descripción y mejoras en inglés (y la evolución)', () => {
    const src = ['lang-en.ts', 'lang-en-stats.ts'].map(f => readFileSync(new URL('../src/data/' + f, import.meta.url), 'utf8')).join('\n');
    const has = (es: string) => src.includes("'" + es.replace(/'/g, "\\'") + "':");
    for (const id of NEW) {
      const d = Moves.BY_ID[id];
      expect(has(d.name), 'nombre ' + id).toBe(true);
      expect(has(d.desc), 'descripción ' + id).toBe(true);
      expect(has(Moves.EVO[id][0]), 'evolución ' + id).toBe(true);
      for (const u of d.ups!) expect(has(u.t), 'mejora ' + id + ': ' + u.t).toBe(true);
      expect(has(Moves.evoInfo(Moves.instance(id, d.maxLvl!), {})!.text), 'texto de la evolución ' + id).toBe(true);
    }
  });
});

describe('monotipos', () => {
  /** Un jugador con sólo lo que mira atkFor. */
  const stub = (types: string[], cats = true) => Object.assign(Object.create(Player.prototype), {
    cats, atkMul: 1, basePhys: 1.2, baseSpec: 1.2, baseAtk: 1, mon: { types }, buffs: { atk: { n: 0, amount: 0 }, spa: { n: 0, amount: 0 } }
  }) as Player;

  test('+20 % con los ataques de su tipo, y nada con los demás', () => {
    const fuego = stub(['fire']);
    const base = fuego.atkFor({ cat: 'spec' });
    expect(fuego.atkFor({ cat: 'spec', type: 'fire' })).toBeCloseTo(base * 1.2, 6);
    expect(fuego.atkFor({ cat: 'spec', type: 'water' })).toBeCloseTo(base, 6);
    expect(fuego.atkFor({ cat: 'spec', type: 'normal' })).toBeCloseTo(base, 6);
  });

  test('los de dos tipos no lo tienen', () => {
    const p = stub(['fire', 'flying']);
    expect(p.atkFor({ cat: 'phys', type: 'fire' })).toBeCloseTo(p.atkFor({ cat: 'phys' }), 6);
  });

  test('sin categorías (la Defensa) nada cambia', () => {
    const p = stub(['fire'], false);
    expect(p.atkFor({ cat: 'spec', type: 'fire' })).toBe(p.atk);
  });
});

describe('Movimiento inicial', () => {
  const store = new Map<string, string>();
  const saved: Record<string, unknown> = {};
  beforeAll(async () => {
    for (const k of ['window', 'localStorage']) saved[k] = G_[k];
    saved.DB = G.DB;
    G.DB = DB;                             // otras pruebas dejan el suyo en G
    G_.window = globalThis;
    G_.localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    };
    expect((await DB.register('Inicial', 'clave1')).ok).toBe(true);
  });
  afterAll(async () => {
    await DB.logout();
    G.DB = saved.DB;
    delete saved.DB;
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete G_[k]; else G_[k] = saved[k]; }
  });

  const charmander = 4;                    // Fuego; su movimiento de serie es Ascuas

  test('es una mejora de un solo nivel que se compra', () => {
    const u = G.Upgrades.BY['start'];
    expect(u.max).toBe(1);
    expect(G.Upgrades.cost('start', 0)).toBeGreaterThan(0);
  });

  test('sin comprarla (o sin elegir) empieza con el de serie', () => {
    expect(G.baseStartOf(charmander)).toBe('ember');
    expect(G.startMoveOf(charmander)).toBe('ember');
    DB.save.pstart = { [charmander]: 'flame-charge' };                 // elegido, pero sin comprar
    expect(G.startMoveOf(charmander)).toBe('ember');
  });

  test('comprada, empieza con el que elijas entre los suyos', () => {
    DB.save.pupg[charmander] = { start: 1 };
    DB.save.pstart = { [charmander]: 'flame-charge' };
    expect(G.startMoveOf(charmander)).toBe('flame-charge');
    DB.save.pstart = { [charmander]: 'rapid-spin' };                   // uno Normal también vale
    expect(G.startMoveOf(charmander)).toBe('rapid-spin');
  });

  test('lo que no es suyo o no ataca se ignora', () => {
    DB.save.pstart = { [charmander]: 'hydro-pump' };                   // de Agua
    expect(G.startMoveOf(charmander)).toBe('ember');
    DB.save.pstart = { [charmander]: 'swords-dance' };                 // un potenciador
    expect(G.startMoveOf(charmander)).toBe('ember');
    DB.save.pstart = { [charmander]: 'no-existe' };
    expect(G.startMoveOf(charmander)).toBe('ember');
    expect(G.startChoices(charmander).every(id => Moves.BY_ID[id].kind !== 'buff')).toBe(true);
  });

  test('la Defensa (sin categorías) sigue con el de serie', () => {
    DB.save.pstart = { [charmander]: 'flame-charge' };
    expect(G.startMoveOf(charmander, false)).toBe('ember');
  });

  test('el guardado lo limpia y la fusión se queda con el de la versión más reciente', async () => {
    DB.save.pstart = { [charmander]: 'flame-charge', 99999: 'ember', 25: 'no-existe', 6: 5 as never };
    DB.commit();
    await DB.logout();
    expect((await DB.login('Inicial', 'clave1')).ok).toBe(true);
    expect(DB.save.pstart).toEqual({ [charmander]: 'flame-charge' });

    const clone = () => JSON.parse(JSON.stringify(DB.save));
    const phone = clone(), pc = clone();
    phone.updated = 1000; pc.updated = 2000;
    phone.pstart = { 4: 'ember', 25: 'thunder-wave' };
    pc.pstart = { 4: 'flame-charge' };
    expect(DB.merge(phone, pc).pstart).toEqual({ 4: 'flame-charge', 25: 'thunder-wave' });
    expect(DB.merge(pc, phone).pstart).toEqual(DB.merge(phone, pc).pstart);        // da igual el orden
    delete phone.pstart; delete pc.pstart;
    expect(DB.merge(phone, pc).pstart).toEqual({});                                // una partida vieja carga bien
  });
});

describe('aprender un ataque no cambia a él solo', () => {
  const grupo = (id: string) => [Moves.instance(id, 1)];
  const stub = (cur: string[]) => {
    const slots = cur.map(grupo);
    return Object.assign(Object.create(Player.prototype), {
      slots, moves: slots.flat(), active: 0, maxMoves: 4, bind: {}, hasItem: () => false,
    }) as Player;
  };
  test('sigues con el que llevabas', () => {
    const p = stub(['ember', 'water-gun']);
    p.addMove('seed-bomb');
    expect(p.slots.length).toBe(3);
    expect(p.active).toBe(0);
    expect(p.activeMove().id).toBe('ember');
  });
});

// ---------------------------------------------------------------------------------------------------
// El combate, con el resto del juego simulado
// ---------------------------------------------------------------------------------------------------

interface Mob {
  id: number; x: number; y: number; r: number; bodyH: number; dead: boolean; boss: boolean; judge: boolean; remote: boolean;
  types: string[]; touchCd: number; dazeT: number; behavior: string; dmg: number; atkType: string; kx: number; ky: number;
  taken: number; hits: number; knock: number; daze: number; pulled: [number, number][];
  cy(): number; hurt(d: number, col: string, dx: number, dy: number, knock: number): void;
  applyDaze(t: number): void; applySlow(): void; applyBurn(): void; applyPoison(): void; strike(): void;
}
let nextId = 1;
const mob = (x: number, y: number, extra: Partial<Mob> = {}): Mob => ({
  id: nextId++, x, y, r: 12, bodyH: 20, dead: false, boss: false, judge: false, remote: false, types: ['normal'], touchCd: 0, dazeT: 0,
  behavior: 'chase', dmg: 1, atkType: 'normal', kx: 0, ky: 0, taken: 0, hits: 0, knock: 0, daze: 0, pulled: [],
  cy() { return this.y; },
  hurt(d, _c, dx, dy, knock) { this.taken += d; this.hits++; this.knock = Math.max(this.knock, knock); this.pulled.push([dx, dy]); },
  applyDaze(t) { this.daze = Math.max(this.daze, t); },
  applySlow() {}, applyBurn() {}, applyPoison() {}, strike() {},
  ...extra
});

describe('formas nuevas de atacar', () => {
  let enemies: Mob[] = [];
  const saved: Record<string, any> = {};
  const noop = new Proxy({}, { get: () => () => {} });

  beforeAll(() => {
    for (const k of ['FX', 'Camera', 'Audio', 'Coop', 'World', 'Recount', 'VFX', 'EnemyMgr']) saved[k] = G[k];
    G.FX = noop; G.Audio = noop; G.Recount = noop;
    G.Camera = { sees: () => true, kick() {} };
    G.Coop = { active: false, isHost: false, status() {}, cast() {} };
    G.World = { isWall: () => false, propsInCircle: () => [], damageProp() {}, projectileBlock: () => null, isFree: () => true, collide() {} };
    G.VFX = { forMove: () => ({ proj: 'star', pal: 'normal' }), spins: () => false };
    G.EnemyMgr = {
      queryCircle: (x: number, y: number, r: number) => enemies.filter(e => !e.dead && Math.hypot(e.x - x, e.y - y) <= r + e.r),
      all: () => enemies
    };
  });
  afterAll(() => { for (const k in saved) G[k] = saved[k]; });
  beforeEach(() => { enemies = []; Combat.clearFields(); G.Projectiles.clear(); });

  /** Un jugador con sólo lo que usa el combate; `atkFor` devuelve 1 para ver el daño tal cual. */
  function player(id: string, lvl = 1) {
    const m = Moves.instance(id, lvl);
    const pl: any = {
      x: 0, y: 0, r: 12, aim: 0, dead: false, cdMul: 1, aimPt: null, target: null, critChance: 0, dmgDealt: 0, healed: 0, hurtN: 0,
      slots: [[m]], atkFor: () => 1, onDealt() {}, heal(n: number) { this.healed += n; }, cast() {},
      activeGroup() { return this.slots[0]; }, hasItem: () => false, hurt() { this.hurtN++; }
    };
    return { pl, m };
  }
  /** Lanza el movimiento (el jugador apunta al primer enemigo) y deja pasar `secs` segundos. */
  function play(pl: any, secs: number, dt = 1 / 60) {
    pl.target = enemies[0] || null;
    Combat.tick(dt, pl, 0);
    let t = 0;
    for (let i = 0; i < Math.round(secs / dt); i++) {
      t += dt;
      Combat.updateFields(dt);
      G.Projectiles.update(dt, pl, enemies);
      Combat.resolve(dt, pl, t);
    }
  }

  test('perseguir: el proyectil gira hacia el enemigo', () => {
    const { pl } = player('energy-ball');
    const e = mob(60, 0);
    enemies = [e, mob(10_000, 0)];
    pl.aim = 0.9;                                    // sale torcido
    play(pl, 1.2);
    expect(e.hits).toBe(1);
  });

  test('rebotar: golpea a uno, salta al siguiente y se gasta cuando no le quedan rebotes', () => {
    const { pl } = player('seed-bomb');
    enemies = [0, 1, 2, 3, 4].map(i => mob(80, i * 90));
    play(pl, 3);
    expect(enemies.map(e => e.hits)).toEqual([1, 1, 1, 1, 0]);      // el primero y 3 rebotes
    expect(G.Projectiles.all().length).toBe(0);
  });

  test('rebotar: con un solo enemigo no vuelve a golpearlo', () => {
    const { pl } = player('electro-ball');
    enemies = [mob(80, 0)];
    play(pl, 3);
    expect(enemies[0].hits).toBe(1);
  });

  test('rebotar: el nivel suma rebotes', () => {
    const { pl } = player('seed-bomb', 2);
    enemies = [0, 1, 2, 3, 4].map(i => mob(80, i * 90));
    play(pl, 4);
    expect(enemies.map(e => e.hits)).toEqual([1, 1, 1, 1, 1]);
  });

  test('cargar: no pega hasta soltarse y luego atraviesa en línea', () => {
    const { pl, m } = player('hyper-beam');
    enemies = [mob(150, 0), mob(250, 0), mob(150, 120), mob(500, 0)];
    play(pl, 0.5);
    expect(enemies.every(e => e.hits === 0)).toBe(true);
    play(pl, 0.5);
    expect(enemies[0].hits).toBe(1);
    expect(enemies[1].hits).toBe(1);
    expect(enemies[2].hits).toBe(0);                 // fuera del rayo
    expect(enemies[3].hits).toBe(0);                 // más allá del alcance
    expect(enemies[0].taken).toBeCloseTo(m.dmg, 5);
  });

  test('cargar: mientras carga no empieza otra carga', () => {
    const { pl } = player('hyper-beam');
    enemies = [mob(150, 0)];
    play(pl, 0.2);
    pl.slots[0][0].t = 0;
    play(pl, 0.9);
    expect(enemies[0].hits).toBe(1);
  });

  test('girar: golpea `count` veces a lo que tiene alrededor y no a lo lejano', () => {
    const { pl, m } = player('rapid-spin');
    enemies = [mob(40, 0), mob(300, 0)];
    play(pl, 0.7);
    expect(enemies[0].hits).toBe(m.count);
    expect(enemies[1].hits).toBe(0);
  });

  test('onda por el suelo: avanza en línea, ni hacia atrás ni de lado', () => {
    const { pl } = player('magnitude');
    enemies = [mob(70, 0), mob(170, 0), mob(-70, 0), mob(70, 120), mob(900, 0)];
    play(pl, 0.7);
    expect(enemies.map(e => e.hits > 0)).toEqual([true, true, false, false, false]);
  });

  test('onda por el suelo: se corta en la primera pared', () => {
    const { pl } = player('magnitude');
    const isWall = G.World.isWall;
    G.World.isWall = (x: number) => x > 100;
    try {
      enemies = [mob(70, 0), mob(170, 0)];
      play(pl, 0.7);
    } finally { G.World.isWall = isWall; }
    expect(enemies.map(e => e.hits > 0)).toEqual([true, false]);
  });

  test('remolino: atrae a los de alrededor hacia el centro, y a los jefes mucho menos', () => {
    const { pl } = player('whirlpool');
    const centro = mob(150, 0), cerca = mob(150, 60), jefe = mob(150, -60, { boss: true }), lejos = mob(150, 400);
    enemies = [centro, cerca, jefe, lejos];
    play(pl, 1.2);
    const d = (e: Mob) => Math.hypot(e.x - 150, e.y);
    expect(d(cerca)).toBeLessThan(25);
    expect(d(jefe)).toBeGreaterThan(d(cerca));
    expect(d(jefe)).toBeLessThan(60);
    expect(lejos.y).toBe(400);
    expect(cerca.hits).toBeGreaterThan(1);           // y le va dañando
  });

  test('remolino: en una copia del anfitrión no se mueve, pero cada golpe lo empuja hacia el centro', () => {
    const { pl } = player('whirlpool');
    const centro = mob(150, 0), copia = mob(150, 60, { remote: true });
    enemies = [centro, copia];
    play(pl, 1);
    expect(copia.y).toBe(60);
    expect(copia.knock).toBeGreaterThan(0);
    expect(copia.pulled[0][1]).toBeLessThan(0);      // la dirección apunta al centro (y menor)
  });

  test('empujón: daña y empuja sólo a lo cercano', () => {
    const { pl, m } = player('extrasensory');
    enemies = [mob(50, 0), mob(50, 400)];
    play(pl, 0.1);
    expect(enemies[0].hits).toBe(1);
    expect(enemies[0].knock).toBe(m.knock);
    expect(enemies[0].pulled[0][0]).toBeGreaterThan(0);   // hacia fuera
    expect(enemies[1].hits).toBe(0);
  });

  test('aturdir: avisa un momento y luego daña y deja quietos a los de la zona', () => {
    const { pl, m } = player('thunder-wave');
    const dentro = mob(120, 0), jefe = mob(130, 0, { boss: true }), fuera = mob(120, 200);
    enemies = [dentro, jefe, fuera];
    play(pl, 0.3);
    expect(dentro.hits).toBe(0);
    play(pl, 0.3);
    expect(dentro.hits).toBe(1);
    expect(dentro.daze).toBe(m.stun);
    expect(jefe.daze).toBeCloseTo(m.stun! * 0.35, 6);       // a los jefes, menos
    expect(fuera.daze).toBe(0);
    expect(fuera.hits).toBe(0);
  });

  test('aturdir: sin nadie cerca no hace nada', () => {
    const { pl } = player('rock-tomb');
    enemies = [mob(5000, 0)];
    play(pl, 1);
    expect(enemies[0].hits).toBe(0);
  });

  test('Beso Drenaje cura una parte de lo que pega', () => {
    const { pl, m } = player('draining-kiss');
    enemies = [mob(80, 0)];
    play(pl, 1);
    expect(pl.healed).toBeCloseTo(m.dmg * m.drain!, 5);
  });

  test('el ataque de un compañero (fantasma) se ve pero no hace daño ni aturde ni mueve', () => {
    const { pl } = player('magnitude');
    const e = mob(70, 0), r = mob(150, 60);
    enemies = [e, r];
    for (const id of ['magnitude', 'whirlpool', 'thunder-wave', 'hyper-beam', 'rapid-spin', 'extrasensory', 'seed-bomb']) {
      Combat.ghostCast(pl, id, 1, 0);
    }
    for (let i = 0; i < 120; i++) { Combat.updateFields(1 / 60); G.Projectiles.update(1 / 60, pl, enemies); Combat.resolve(1 / 60, pl, i / 60); }
    expect(e.hits).toBe(0);
    expect(e.daze).toBe(0);
    expect(r.y).toBe(60);
  });

  test('un aturdido no hace daño por contacto', () => {
    const { pl } = player('rapid-spin');
    enemies = [mob(5, 0, { dazeT: 1 }), mob(-5, 0)];
    Combat.resolve(1 / 60, pl, 0);
    expect(pl.hurtN).toBe(1);                         // sólo el que no está aturdido
  });
});

describe('aturdido', () => {
  const saved: Record<string, any> = {};
  beforeAll(() => { saved.Coop = G.Coop; });
  afterAll(() => { G.Coop = saved.Coop; });

  test('en una copia del cooperativo se avisa al anfitrión y aquí sólo se apunta para dibujar', () => {
    const sent: unknown[][] = [];
    G.Coop = { status: (...a: unknown[]) => sent.push(a) };
    const e = Object.assign(Object.create(Enemy.prototype), { remote: true, dazeT: 0 });
    e.applyDaze(0.8);
    expect(sent).toEqual([[e, 'd', 0.8]]);
    expect(e.dazeT).toBe(0.8);
    e.applyDaze(0.3);
    expect(e.dazeT).toBe(0.8);                        // se queda el mayor
  });

  test('en el anfitrión o en solitario se aplica sin avisar a nadie', () => {
    const sent: unknown[][] = [];
    G.Coop = { status: (...a: unknown[]) => sent.push(a) };
    const e = Object.assign(Object.create(Enemy.prototype), { remote: false, dazeT: 0 });
    e.applyDaze(1.2);
    expect(e.dazeT).toBe(1.2);
    expect(sent).toEqual([]);
  });
});
