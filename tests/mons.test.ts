/* ============ mons.test.ts — naturaleza, habilidad, MT y Tienda Kecleon ============
 *   bun test tests/mons.test.ts
 * Los datos (naturalezas, habilidades, MT), lo que hacen las naturalezas y las habilidades en el jugador, la
 * rotación diaria de la tienda, las compras (sin saldo, repetidas, que no estén a la venta), enseñar una MT, el
 * segundo movimiento inicial, el saneado y la fusión del guardado, y las reglas del servidor (server/save-rules.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { G } from '../src/g';
import '../src/core/util';
import '../src/data/types';
import '../src/data/pokedex';
import '../src/data/base-stats';
import '../src/data/natures';
import '../src/data/abilities';
import '../src/data/tms';
import { Moves } from '../src/data/moves';
import '../src/data/upgrades';
import '../src/data/starters';
import '../src/data/ability-fx';
import '../src/data/shop';
import '../src/systems/mons';
import { Player } from '../src/entities/player';
import { DB } from '../src/core/db';
import { SHOP_PRICE, TM_MIN_PRICE, judgeSave, shopCost } from '../server/save-rules';

const G_ = globalThis as any;
const store = new Map<string, string>();
const saved: Record<string, unknown> = {};
const lang = { lang: 'es' };

beforeAll(async () => {
  for (const k of ['window', 'localStorage']) saved[k] = G_[k];
  saved.DB = G.DB; saved.I18n = G.I18n;
  G.DB = DB;                             // otras pruebas dejan el suyo en G
  G.I18n = { lang: lang.lang, t: (s: string) => s, f: (s: string, ...v: unknown[]) => { let i = 0; return s.replace(/\{x\}/g, () => String(v[i++])); } };
  G_.window = globalThis;
  G_.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  expect((await DB.register('Kecleon', 'clave1')).ok).toBe(true);
});
afterAll(async () => {
  await DB.logout();
  G.DB = saved.DB; G.I18n = saved.I18n;
  delete saved.DB; delete saved.I18n;
  for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete G_[k]; else G_[k] = saved[k]; }
});

const CHARMANDER = 4, MEWTWO = 150;
/** Deja la partida como nueva en lo que importa a la tienda. */
function reset() {
  const s = DB.save;
  s.coins = 100000; s.partner = CHARMANDER; s.created = 1700000000000;
  s.bag = {}; s.tms = {}; s.ptm = {}; s.pnat = {}; s.pabil = {}; s.pstart = {}; s.pstart2 = {}; s.pupg = {};
  s.owned = { [CHARMANDER]: { at: 1, from: 'starter' }, [MEWTWO]: { at: 2, from: 'gacha' } };
}
beforeEach(reset);

describe('datos', () => {
  test('25 naturalezas: 5 neutras y 20 que suben una cualidad y bajan otra distinta', () => {
    expect(G.NATURES.length).toBe(25);
    expect(new Set(G.NATURES.map(n => n.id)).size).toBe(25);
    expect(G.NATURES.filter(n => !n.up && !n.down).length).toBe(5);
    for (const n of G.NATURES) {
      expect(!!n.up, n.id).toBe(!!n.down);
      if (n.up) expect(n.up).not.toBe(n.down);
      expect(n.n[0] && n.n[1], n.id).toBeTruthy();
    }
    // Las cinco combinaciones de cada cualidad que suben y bajan: 5 × 4 = 20 sin repetir.
    expect(new Set(G.NATURES.filter(n => n.up).map(n => n.up + '/' + n.down)).size).toBe(20);
  });

  test('todos los Pokémon tienen habilidad y todas las habilidades, nombre en los dos idiomas', () => {
    for (const p of G.DEX) {
      const l = G.DEX_ABIL[p.dex];
      expect(l, String(p.dex)).toBeDefined();
      expect(l[0], String(p.dex)).toBeTruthy();
      for (const id of l) if (id) expect(G.ABIL[id], id).toBeDefined();
    }
    for (const id of Object.keys(G.ABIL)) expect(G.ABIL[id][0] && G.ABIL[id][1], id).toBeTruthy();
  });

  test('toda habilidad con efecto propio existe, y todas (con o sin efecto) se describen en español e inglés', () => {
    for (const id of Object.keys(G.AbilityFX.FX)) expect(G.ABIL[id], 'habilidad desconocida: ' + id).toBeDefined();
    for (const p of G.DEX) for (const id of G.DEX_ABIL[p.dex]) {
      if (!id) continue;
      const fx = G.AbilityFX.of(id, p);
      expect(fx.d[0].length > 5 && fx.d[1].length > 5, id).toBe(true);
    }
  });

  test('las MT: sólo movimientos del juego, con precio, y los Pokémon que existen', () => {
    for (const [id, list] of Object.entries(G.TM_MOVES)) {
      expect(Moves.BY_ID[id], id).toBeDefined();
      expect(G.TM_PRICE[id], id).toBeGreaterThan(0);
      for (const d of list) expect(G.DEX_BY[d], id + ' ' + d).toBeDefined();
    }
    expect(Object.keys(G.TM_MOVES).length).toBeGreaterThanOrEqual(Shop().DAILY);
  });

  test('Mewtwo aprende por MT lo que no es de su tipo (Bola Sombra), y Charmander no puede con lo suyo', () => {
    expect(G.Mons.learnable(MEWTWO)).toContain('shadow-ball');
    expect(G.Mons.learnable(CHARMANDER)).not.toContain('ember');         // ya lo sabe de serie
    expect(G.Mons.learnable(CHARMANDER)).not.toContain('hydro-pump');    // no la aprende en los juegos
  });
});

function Shop() { return G.Shop; }

describe('naturaleza', () => {
  test('la que te toca es fija para tu cuenta y Pokémon, y varía entre Pokémon y cuentas', () => {
    const a = G.Mons.natureOf(CHARMANDER).id;
    expect(G.Mons.natureOf(CHARMANDER).id).toBe(a);
    const ids = new Set(G.DEX.slice(0, 200).map(p => G.Mons.natureOf(p.dex).id));
    expect(ids.size).toBeGreaterThan(15);                                // reparte entre casi todas
    DB.save.created += 1;
    const other = new Set(G.DEX.slice(0, 200).map(p => G.Mons.natureOf(p.dex).id + p.dex));
    DB.save.created -= 1;
    const mine = new Set(G.DEX.slice(0, 200).map(p => G.Mons.natureOf(p.dex).id + p.dex));
    expect([...other].filter(x => !mine.has(x)).length).toBeGreaterThan(50);   // otra cuenta, otro reparto
  });

  test('una Menta la cambia, y sólo a una que exista', () => {
    expect(G.Mons.setNature(CHARMANDER, 'no-existe')).toBe(false);
    expect(G.Mons.setNature(99999, 'bold')).toBe(false);
    expect(G.Mons.setNature(CHARMANDER, 'bold')).toBe(true);
    expect(G.Mons.natureOf(CHARMANDER).id).toBe('bold');
    expect(DB.save.pnat[CHARMANDER][0]).toBe('bold');
  });

  /** Un jugador con sólo las cualidades que toca una naturaleza. */
  const stub = (dex: number) => Object.assign(Object.create(Player.prototype), {
    dex, mon: G.DEX_BY[dex], basePhys: 1.2, baseSpec: 1.1, guardPhys: 1, guardSpec: 1, baseSpd: 100, cdMul: 1,
  }) as Player;

  test('sube un 10 % una cualidad y baja otro 10 % otra, y las neutras no tocan nada', () => {
    G.Mons.setNature(CHARMANDER, 'adamant');                              // +Ataque −At. Esp.
    let p = stub(CHARMANDER); G.Mons.apply(p);
    expect(p.basePhys).toBeCloseTo(1.2 * 1.1, 9);
    expect(p.baseSpec).toBeCloseTo(1.1 * 0.9, 9);
    expect(p.guardPhys).toBe(1); expect(p.guardSpec).toBe(1); expect(p.baseSpd).toBe(100);
    expect(p.nature).toBe('adamant');

    G.Mons.setNature(CHARMANDER, 'bold');                                 // +Defensa −Ataque
    p = stub(CHARMANDER); G.Mons.apply(p);
    expect(p.guardPhys).toBeCloseTo(1 / 1.1, 9);                          // recibe menos daño físico
    expect(p.basePhys).toBeCloseTo(1.2 * 0.9, 9);

    G.Mons.setNature(CHARMANDER, 'timid');                                // +Velocidad −Ataque
    p = stub(CHARMANDER); G.Mons.apply(p);
    expect(p.baseSpd).toBeCloseTo(110, 9);

    G.Mons.setNature(CHARMANDER, 'calm');                                 // +Def. Esp. −Ataque
    p = stub(CHARMANDER); G.Mons.apply(p);
    expect(p.guardSpec).toBeCloseTo(1 / 1.1, 9);

    G.Mons.setNature(CHARMANDER, 'hardy');                                // neutra
    p = stub(CHARMANDER); G.Mons.apply(p);
    expect([p.basePhys, p.baseSpec, p.guardPhys, p.guardSpec, p.baseSpd]).toEqual([1.2, 1.1, 1, 1, 100]);
  });
});

describe('habilidad', () => {
  test('la que te toca es una de las suyas, fija, y la oculta sale de vez en cuando', () => {
    for (const p of G.DEX.slice(0, 150)) {
      const a = G.Mons.abilityOf(p.dex);
      expect(G.DEX_ABIL[p.dex]).toContain(a.id);
      expect(G.Mons.abilityOf(p.dex).id).toBe(a.id);
    }
    let hidden = 0, withHidden = 0;
    for (const p of G.DEX) if (G.DEX_ABIL[p.dex][2]) { withHidden++; if (G.Mons.abilityOf(p.dex).slot === 2) hidden++; }
    expect(hidden / withHidden).toBeGreaterThan(0.02);
    expect(hidden / withHidden).toBeLessThan(0.1);                        // 1 de cada 20
  });

  test('una Cápsula cambia a otra de las suyas; la oculta, sólo con la Cápsula Oculta', () => {
    const l = G.DEX_ABIL[CHARMANDER];                                     // Mar Llamas / —  / Poder Solar
    expect(G.Mons.abilityChoices(CHARMANDER, false).every(i => i < 2)).toBe(true);
    expect(G.Mons.abilityChoices(CHARMANDER, true)).toContain(2);
    expect(G.Mons.abilityChoices(CHARMANDER, false)).not.toContain(2);
    const cur = G.Mons.abilityOf(CHARMANDER).id;
    for (const i of G.Mons.abilityChoices(CHARMANDER, true)) expect(l[i]).not.toBe(cur);
    expect(G.Mons.setAbility(CHARMANDER, 2)).toBe(true);
    expect(G.Mons.abilityOf(CHARMANDER)).toEqual({ id: l[2], slot: 2 });
    expect(G.Mons.setAbility(CHARMANDER, 1)).toBe(false);                 // no tiene segunda habilidad
    expect(G.Mons.abilityOf(CHARMANDER).slot).toBe(2);
  });

  const mine = (id: string, hp = 100) => {
    const p: any = Object.assign(Object.create(Player.prototype), {
      dex: CHARMANDER, mon: { ...G.DEX_BY[CHARMANDER], types: ['fire'] }, cats: true, atkMul: 1, basePhys: 1, baseSpec: 1, baseAtk: 1,
      buffs: { atk: { n: 0, amount: 0 }, spa: { n: 0, amount: 0 } }, cdMul: 1, guardPhys: 1, guardSpec: 1, critChance: 0, coinMul: 1, magnet: 78,
      regenFlat: 0, hp, maxHp: 100, level: 10, slowT: 0, item: null,
    });
    p.setAbility(id);
    return p as Player;
  };

  test('daño: Potencia (físicos ×1,5), Mar Llamas (con poca vida), Adaptable y la genérica por tipo', () => {
    expect(mine('huge-power').atkFor({ cat: 'phys' })).toBeCloseTo(1.5, 9);
    expect(mine('huge-power').atkFor({ cat: 'spec' })).toBeCloseTo(1, 9);
    expect(mine('blaze', 100).atkFor({ cat: 'spec', type: 'fire' })).toBeCloseTo(1.2, 9);        // monotipo, vida llena
    expect(mine('blaze', 20).atkFor({ cat: 'spec', type: 'fire' })).toBeCloseTo(1.2 * 1.35, 9);  // poca vida
    expect(mine('blaze', 20).atkFor({ cat: 'spec', type: 'water' })).toBeCloseTo(1, 9);
    expect(mine('adaptability').atkFor({ cat: 'spec', type: 'fire' })).toBeCloseTo(1.2 * 1.25, 9);
    // Una sin efecto propio da +6 % con los movimientos de su tipo.
    expect(G.AbilityFX.FX.stall).toBeUndefined();
    expect(mine('stall').atkFor({ cat: 'spec', type: 'fire' })).toBeCloseTo(1.2 * 1.06, 9);
    expect(mine('stall').atkFor({ cat: 'spec', type: 'water' })).toBeCloseTo(1, 9);
  });

  test('defensa y marcas: Levitación, Robustez, Intimidación, y el crítico y la recarga cambian al empezar', () => {
    expect(mine('levitate').abil!.levitate).toBe(true);
    expect(mine('levitate').abil!.inMul!(mine('levitate'), 'ground', 'phys')).toBeLessThan(0.5);
    expect(mine('sturdy').abil!.sturdy).toBe(true);
    expect(mine('intimidate').abil!.inMul!(mine('intimidate'), 'normal', 'phys')).toBeCloseTo(0.88, 9);
    expect(mine('intimidate').abil!.inMul!(mine('intimidate'), 'normal', 'spec')).toBe(1);
    expect(mine('super-luck').critChance).toBeCloseTo(0.1, 9);
    expect(mine('truant').cdMul).toBeCloseTo(1.6, 9);
    expect(mine('pickup').coinMul).toBeGreaterThan(1);
    expect(mine('water-absorb').abil!.absorb).toBe('water');
    const sf = mine('sheer-force'); expect(sf.abil!.sheer).toBe(true);
  });

  test('Autoestima sube con cada derrotado, hasta un tope', () => {
    const p = mine('moxie');
    const base = p.atkFor({ cat: 'phys' });
    for (let i = 0; i < 5; i++) p.abil!.kill!(p, {} as never);
    expect(p.atkFor({ cat: 'phys' })).toBeCloseTo(base * 1.025, 6);
    for (let i = 0; i < 100; i++) p.abil!.kill!(p, {} as never);
    expect(p.atkFor({ cat: 'phys' })).toBeCloseTo(base * 1.15, 6);
  });

  test('Sin habilidad (la Defensa) atkFor no cambia', () => {
    const p = mine('huge-power');
    p.cats = false;
    expect(p.atkFor({ cat: 'phys' })).toBe(p.atk);
  });

  test('el español y el inglés se eligen por el idioma', () => {
    const fx = G.AbilityFX.of('huge-power', G.DEX_BY[CHARMANDER]);
    expect(G.AbilityFX.describe(fx)).toBe(fx.d[0]);
    G.I18n.lang = 'en';
    expect(G.AbilityFX.describe(fx)).toBe(fx.d[1]);
    expect(G.Mons.name(G.NATURE_BY.bold.n)).toBe('Bold');
    expect(G.Mons.abilityName('huge-power')).toBe('Huge Power');
    G.I18n.lang = 'es';
    expect(G.Mons.name(G.NATURE_BY.bold.n)).toBe('Osada');
  });
});

describe('Tienda Kecleon: MT del día', () => {
  const madrid = (iso: string) => G.Shop.today(Date.parse(iso));

  test('la fecha es la de España: cambia a medianoche allí, no en UTC', () => {
    expect(madrid('2026-10-27T10:00:00Z')).toBe('20261027');
    expect(madrid('2026-10-27T22:59:00Z')).toBe('20261027');              // 23:59 en Madrid (UTC+1)
    expect(madrid('2026-10-27T23:00:00Z')).toBe('20261028');              // 00:00 en Madrid
    expect(madrid('2026-07-01T21:59:00Z')).toBe('20260701');              // en verano, UTC+2
    expect(madrid('2026-07-01T22:00:00Z')).toBe('20260702');
  });

  test('son 8, distintas, de las que existen, y las mismas todo el día', () => {
    const a = G.Shop.dailyTms('20261027');
    expect(a.length).toBe(8);
    expect(new Set(a).size).toBe(8);
    for (const id of a) expect(G.TM_MOVES[id], id).toBeDefined();
    expect(G.Shop.dailyTms('20261027')).toEqual(a);
    expect(G.Shop.dailyTms('20261027', null)).toEqual(a);
  });

  test('rotan: cada día sale otra tanda, y a lo largo de un mes salen casi todas', () => {
    const seen = new Set<string>();
    let same = 0, prev = '';
    for (let d = 1; d <= 30; d++) {
      const day = '202611' + String(d).padStart(2, '0');
      const list = G.Shop.dailyTms(day);
      const key = list.join();
      if (key === prev) same++;
      prev = key;
      list.forEach(id => seen.add(id));
    }
    expect(same).toBe(0);
    expect(seen.size).toBeGreaterThan(Object.keys(G.TM_MOVES).length * 0.8);
  });

  test('si ninguna le sirve a tu compañero, la última se cambia por una que sí aprende', () => {
    // Un Pokémon que casi no aprende nada por MT: se busca un día en que de serie no le sirva ninguna.
    const dex = MEWTWO;
    let day = '', plain: string[] = [];
    for (let d = 1; d <= 28 && !day; d++) {
      const cand = '202612' + String(d).padStart(2, '0');
      const l = G.Shop.dailyTms(cand);
      if (!l.some(id => G.Mons.canLearn(dex, id))) { day = cand; plain = l; }
    }
    if (!day) return;                                                     // Mewtwo aprende tantas que siempre hay una: nada que comprobar
    const adapted = G.Shop.dailyTms(day, dex);
    expect(adapted.slice(0, 7)).toEqual(plain.slice(0, 7));
    expect(G.Mons.canLearn(dex, adapted[7])).toBe(true);
  });
});

describe('Tienda Kecleon: compras', () => {
  const NOW = Date.parse('2026-10-27T12:00:00Z');
  const today = () => G.Shop.dailyTms(G.Shop.today(NOW), DB.save.partner);

  test('objetos: cobra, mete en la Mochila y no pasa de 99', () => {
    const before = DB.save.coins;
    expect(G.Shop.buy('mint', NOW)).toEqual({ ok: true });
    expect(DB.save.coins).toBe(before - G.Shop.ITEMS.mint.price);
    expect(G.Shop.count('mint')).toBe(1);
    expect(G.Shop.buy('mint', NOW).ok).toBe(true);
    expect(G.Shop.count('mint')).toBe(2);
    DB.save.bag.cap = 99;
    const c = DB.save.coins;
    const r = G.Shop.buy('cap', NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(DB.save.coins).toBe(c);                                        // no cobra
    expect(DB.save.bag.cap).toBe(99);
  });

  test('sin saldo no compra nada, ni cambia monedas ni Mochila', () => {
    DB.save.coins = 1499;
    const r = G.Shop.buy('mint', NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('No tienes Pokémonedas suficientes.');
    expect(DB.save.coins).toBe(1499);
    expect(G.Shop.count('mint')).toBe(0);
    DB.save.coins = 4999;
    expect(G.Shop.buy('caph', NOW).ok).toBe(false);
    DB.save.coins = 5000;
    expect(G.Shop.buy('caph', NOW).ok).toBe(true);
    expect(DB.save.coins).toBe(0);
    const tm = today()[0];
    expect(G.Shop.buy('tm:' + tm, NOW).ok).toBe(false);                   // con 0 monedas
    expect(G.Shop.tmCount(tm)).toBe(0);
  });

  test('cosas que no existen o claves raras no hacen nada', () => {
    const c = DB.save.coins;
    for (const k of ['nada', '', 'tm:', 'tm:no-existe', 'tm:ember', '__proto__', 'constructor']) expect(G.Shop.buy(k, NOW).ok, k).toBe(false);
    expect(G.Shop.buy(null as never, NOW).ok).toBe(false);
    expect(DB.save.coins).toBe(c);
  });

  test('una MT: sólo las de hoy, una sola vez (hasta gastarla) y al precio de la tabla', () => {
    const list = today();
    const fuera = Object.keys(G.TM_MOVES).find(id => !list.includes(id))!;
    expect(G.Shop.buy('tm:' + fuera, NOW).ok).toBe(false);                // no está a la venta hoy
    const id = list[0], c = DB.save.coins;
    expect(G.Shop.buy('tm:' + id, NOW)).toEqual({ ok: true });
    expect(DB.save.coins).toBe(c - G.TM_PRICE[id]);
    expect(G.Shop.tmCount(id)).toBe(1);
    // Comprarla otra vez (un doble clic): no se cobra.
    const r = G.Shop.buy('tm:' + id, NOW);
    expect(r.ok).toBe(false);
    expect(DB.save.coins).toBe(c - G.TM_PRICE[id]);
    expect(G.Shop.tmCount(id)).toBe(1);
    // Mañana ya no está (o no hoy mismo): la lista de ayer no vale.
    const tomorrow = NOW + 86400e3;
    const yest = list.filter(x => !G.Shop.dailyTms(G.Shop.today(tomorrow), DB.save.partner).includes(x))[0];
    expect(G.Shop.buy('tm:' + yest, tomorrow).ok).toBe(false);
  });

  test('enseñar: gasta la MT, la aprende para siempre y sale entre sus movimientos (sólo en el Survivor)', () => {
    const dex = MEWTWO, id = 'shadow-ball';
    expect(Moves.poolFor(G.DEX_BY[dex], true)).not.toContain(id);
    expect(G.Mons.teach(dex, id)).toBe(false);                            // no la tiene
    DB.save.tms[id] = 1;
    expect(G.Mons.teach(CHARMANDER, id)).toBe(false);                     // Charmander no la aprende
    expect(DB.save.tms[id]).toBe(1);
    expect(G.Mons.teach(dex, id)).toBe(true);
    expect(G.Shop.tmCount(id)).toBe(0);
    expect(G.Mons.taught(dex)).toEqual([id]);
    expect(G.Mons.canLearn(dex, id)).toBe(false);                         // ya no se enseña dos veces
    expect(Moves.poolFor(G.DEX_BY[dex], true)).toContain(id);             // cartas de nivel y movimiento inicial
    expect(Moves.poolFor(G.DEX_BY[dex])).not.toContain(id);               // la Defensa, igual que antes
    expect(G.startChoices(dex)).toContain(id);
    DB.save.tms[id] = 1;
    expect(G.Mons.teach(dex, id)).toBe(false);
    expect(DB.save.tms[id]).toBe(1);
  });

  test('un movimiento de su tipo no hace falta enseñarlo', () => {
    DB.save.tms.ember = 1;
    expect(G.Mons.teach(CHARMANDER, 'ember')).toBe(false);
    expect(G.Mons.natural(CHARMANDER, 'ember')).toBe(true);
  });
});

describe('Segundo movimiento inicial', () => {
  test('es una mejora de un nivel que necesita Repertorio', () => {
    const u = G.Upgrades.BY.start2;
    expect(u.max).toBe(1);
    expect(u.needs).toBe('moves');
    expect(G.Upgrades.cost('start2', 0)).toBeGreaterThan(0);
  });

  test('sólo cuenta con la mejora y con Repertorio, y no puede ser el primero ni uno que no sea suyo', () => {
    DB.save.pstart2 = { [CHARMANDER]: 'flame-charge' };
    expect(G.startMove2Of(CHARMANDER)).toBeNull();                        // sin comprar
    DB.save.pupg[CHARMANDER] = { start2: 1 };
    expect(G.startMove2Of(CHARMANDER)).toBeNull();                        // sin Repertorio
    DB.save.pupg[CHARMANDER] = { start2: 1, moves: 1 };
    expect(G.startMove2Of(CHARMANDER)).toBe('flame-charge');
    DB.save.pstart2 = { [CHARMANDER]: 'ember' };                          // el primero
    expect(G.startMove2Of(CHARMANDER)).toBeNull();
    DB.save.pstart2 = { [CHARMANDER]: 'hydro-pump' };                     // de otro tipo
    expect(G.startMove2Of(CHARMANDER)).toBeNull();
    DB.save.pstart2 = { [CHARMANDER]: 'swords-dance' };                   // un potenciador
    expect(G.startMove2Of(CHARMANDER)).toBeNull();
    DB.save.pstart2 = { [CHARMANDER]: 'flame-charge' };
    DB.save.pstart = { [CHARMANDER]: 'flame-charge' };
    DB.save.pupg[CHARMANDER].start = 1;                                   // ahora ese es el primero
    expect(G.startMove2Of(CHARMANDER)).toBeNull();
  });

  test('una MT aprendida vale de segundo movimiento inicial', () => {
    DB.save.ptm = { [MEWTWO]: ['shadow-ball'] };
    DB.save.pupg[MEWTWO] = { start2: 1, moves: 1 };
    DB.save.pstart2 = { [MEWTWO]: 'shadow-ball' };
    expect(G.startMove2Of(MEWTWO)).toBe('shadow-ball');
  });
});

describe('guardado', () => {
  const reload = async () => {
    DB.commit();
    await DB.logout();
    expect((await DB.login('Kecleon', 'clave1')).ok).toBe(true);
  };

  test('lo raro se limpia al cargar y lo bueno se queda', async () => {
    const s = DB.save;
    s.bag = { mint: 3, cap: -4, caph: 'mucho' as never, tontería: 5, __proto__: 1 as never };
    s.tms = { 'shadow-ball': 2, 'no-existe': 1, psychic: 99999 };
    s.ptm = { [MEWTWO]: ['shadow-ball', 'shadow-ball', 'no-existe', 5 as never], 99999: ['psychic'], [CHARMANDER]: [] };
    s.pnat = { [CHARMANDER]: ['bold', 5], [MEWTWO]: ['rara-rara', 1] as never, 25: 'adamant' as never, 99999: ['bold', 1] };
    s.pabil = { [CHARMANDER]: [2, 7], [MEWTWO]: [3, 1] as never, 25: ['x', 2] as never };
    s.pstart2 = { [CHARMANDER]: 'flame-charge', 99999: 'ember', 25: 'no-existe', 6: 5 as never };
    await reload();
    expect(DB.save.bag).toEqual({ mint: 3 });
    expect(DB.save.tms).toEqual({ 'shadow-ball': 2, psychic: 9 });
    expect(DB.save.ptm).toEqual({ [MEWTWO]: ['shadow-ball'] });
    expect(DB.save.pnat).toEqual({ [CHARMANDER]: ['bold', 5] });
    expect(DB.save.pabil).toEqual({ [CHARMANDER]: [2, 7] });
    expect(DB.save.pstart2).toEqual({ [CHARMANDER]: 'flame-charge' });
  });

  test('campos con otro tipo (una partida vieja, o rota a mano) no rompen nada', async () => {
    const s = DB.save as any;
    delete s.bag; delete s.tms; delete s.ptm; delete s.pnat; delete s.pabil; delete s.pstart2;
    await reload();
    for (const k of ['bag', 'tms', 'ptm', 'pnat', 'pabil', 'pstart2']) expect((DB.save as any)[k], k).toEqual({});
    const s2 = DB.save as any;
    s2.bag = [1, 2]; s2.tms = 'x'; s2.ptm = null; s2.pnat = 5; s2.pabil = []; s2.pstart2 = 'a';
    await reload();
    for (const k of ['bag', 'tms', 'ptm', 'pnat', 'pabil', 'pstart2']) expect((DB.save as any)[k], k).toEqual({});
  });

  const clone = () => JSON.parse(JSON.stringify(DB.save));
  test('fusión entre aparatos: MT aprendidas se unen, naturaleza y habilidad se quedan con la última elegida', () => {
    const phone = clone(), pc = clone();
    phone.updated = 1000; pc.updated = 2000;
    phone.ptm = { [MEWTWO]: ['shadow-ball'], [CHARMANDER]: ['agility'] };
    pc.ptm = { [MEWTWO]: ['psychic', 'shadow-ball'] };
    phone.pnat = { [CHARMANDER]: ['bold', 500], [MEWTWO]: ['timid', 100] };
    pc.pnat = { [CHARMANDER]: ['calm', 400] };
    phone.pabil = { [CHARMANDER]: [2, 10] };
    pc.pabil = { [CHARMANDER]: [0, 20] };
    phone.pstart2 = { 4: 'ember', 25: 'thunder-wave' }; pc.pstart2 = { 4: 'flame-charge' };
    const m = DB.merge(phone, pc), m2 = DB.merge(pc, phone);
    expect(m.ptm[MEWTWO].sort()).toEqual(['psychic', 'shadow-ball']);
    expect(m.ptm[CHARMANDER]).toEqual(['agility']);
    expect(m.pnat).toEqual({ [CHARMANDER]: ['bold', 500], [MEWTWO]: ['timid', 100] });       // la de más tarde de cada Pokémon
    expect(m.pabil).toEqual({ [CHARMANDER]: [0, 20] });
    expect(m.pstart2).toEqual({ 4: 'flame-charge', 25: 'thunder-wave' });
    expect(m2.pnat).toEqual(m.pnat); expect(m2.pabil).toEqual(m.pabil);                      // da igual el orden
    expect(DB.merge(m, m).ptm).toEqual(m.ptm);                                                // idempotente
  });

  test('fusión: la Mochila y las MT sin usar van con la versión más reciente (como las monedas con que se pagaron)', () => {
    const a = clone(), b = clone();
    a.updated = 1000; b.updated = 2000;
    a.coins = 100; b.coins = 5000;
    a.bag = { mint: 5 }; b.bag = { cap: 1 };
    a.tms = { psychic: 1 }; b.tms = {};
    const m = DB.merge(a, b);
    expect(m.bag).toEqual({ cap: 1 });
    expect(m.tms).toEqual({});
    expect(m.coins).toBe(5000);
  });

  test('una partida vieja sin estos campos carga y se fusiona bien', () => {
    const old = clone(), nw = clone();
    for (const k of ['bag', 'tms', 'ptm', 'pnat', 'pabil', 'pstart2']) delete old[k];
    old.updated = 1; nw.updated = 2;
    nw.ptm = { [MEWTWO]: ['psychic'] };
    const m = DB.merge(old, nw);
    expect(m.ptm).toEqual({ [MEWTWO]: ['psychic'] });
    expect(DB.merge(nw, old).ptm).toEqual({ [MEWTWO]: ['psychic'] });
  });
});

describe('servidor (server/save-rules.ts)', () => {
  const T0 = 1_800_000_000_000;
  const base = (over: Record<string, any> = {}) => ({
    v: 5, name: 'Ash', created: T0 - 10 * 86400e3, updated: T0, coins: 20000, owned: { 1: { at: 1, from: 'gacha' }, 4: { at: 1, from: 'gacha' } }, shiny: {},
    tickets: { t1: 0, t10: 0 }, legends: {}, arenas: {}, itemsFound: {}, evoMoves: {}, ach: {},
    stats: { runs: 3, missionsDone: 5 }, bag: {}, tms: {}, ptm: {}, pnat: {}, pabil: {}, pstart2: {}, ...over,
  });
  const judge = (prev: any, next: any, secs = 60) => judgeSave(prev, next, { secs, now: T0 + secs * 1000 });

  test('los precios del servidor son los del juego', () => {
    for (const id of Object.keys(G.Shop.ITEMS)) expect(SHOP_PRICE[id], id).toBe(G.Shop.ITEMS[id].price);
    expect(Object.keys(SHOP_PRICE).sort()).toEqual(Object.keys(G.Shop.ITEMS).sort());
    expect(TM_MIN_PRICE).toBe(Math.min(...Object.values(G.TM_PRICE)));
  });

  test('una compra de verdad (monedas que bajan) pasa', () => {
    const prev = base();
    const next = base({ coins: 20000 - 1500, bag: { mint: 1 } });
    expect(shopCost(prev, next)).toBe(1500);
    expect(judge(prev, next).kind).toBe('ok');
    const tm = base({ coins: 20000 - 840, tms: { psychic: 1 } });
    expect(judge(prev, tm).kind).toBe('ok');
    // Comprar una MT y enseñarla antes de guardar: el objeto nuevo es la MT aprendida.
    const taught = base({ coins: 20000 - 840, ptm: { 150: ['psychic'] } });
    expect(shopCost(prev, taught)).toBe(TM_MIN_PRICE);
    expect(judge(prev, taught).kind).toBe('ok');
  });

  test('objetos de la Tienda sin monedas que los paguen quedan apuntados', () => {
    const prev = base({ coins: 100 });
    const next = base({ coins: 100, bag: { caph: 20 }, tms: { psychic: 5 } });
    const v = judge(prev, next);
    expect(v.kind).toBe('sus');
    if (v.kind === 'sus') expect(v.why).toContain('Tienda Kecleon');
    // Gastarlos (la Mochila baja) o no cambiar nada nunca es sospechoso.
    expect(judge(next, prev).kind).toBe('ok');
    expect(judge(prev, base({ coins: 100 })).kind).toBe('ok');
  });

  test('un campo de la Tienda con otra forma se rechaza; la forma buena no', () => {
    for (const k of ['bag', 'tms', 'ptm', 'pnat', 'pabil', 'pstart2']) {
      expect(judge(base(), base({ [k]: 5 })).kind, k).toBe('reject');
      expect(judge(base(), base({ [k]: [1] })).kind, k).toBe('reject');
      expect(judge(base(), base({ [k]: {} })).kind, k).toBe('ok');
    }
    expect(judge(base(), (() => { const s = base(); delete (s as any).bag; return s; })()).kind).toBe('ok');   // una partida vieja
  });

  test('las MT aprendidas no se pierden: se restituyen', () => {
    const prev = base({ ptm: { 150: ['psychic', 'shadow-ball'], 4: ['agility'] } });
    const v = judge(prev, base({ ptm: { 150: ['psychic'] } }));
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') {
      expect(v.save.ptm[150].sort()).toEqual(['psychic', 'shadow-ball']);
      expect(v.save.ptm[4]).toEqual(['agility']);
    }
  });
});
