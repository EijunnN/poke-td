/* ============ dex-query.test.ts — buscador, filtros y favoritos de la colección ============
 * La lógica pura (data/dex-query.ts) con la Pokédex de verdad, y los favoritos en el
 * guardado (core/db.ts): se guardan, una partida vieja sin el campo carga bien y la
 * fusión entre aparatos se queda con el cambio más reciente de cada Pokémon.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DEX } from '../src/data/pokedex';
import { DexQuery, type DexSave } from '../src/data/dex-query';
import { DB, type SaveData } from '../src/core/db';

const G_ = globalThis as any;
const own = (...dex: number[]) => Object.fromEntries(dex.map((d, i) => [d, { at: 1000 + i, from: 'gacha' }]));
const dexes = (list: { dex: number }[]) => list.map(p => p.dex);
const blank = () => DexQuery.blank();

describe('buscar y filtrar', () => {
  test('sin filtros salen todos, por número', () => {
    const r = DexQuery.run(blank(), { owned: {} });
    expect(r.length).toBe(DEX.length);
    expect(dexes(r)).toEqual([...dexes(r)].sort((a, b) => a - b));
    expect(DexQuery.active(blank())).toBe(false);
  });

  test('el nombre sólo se busca entre los que tienes; el número, en todos', () => {
    const s: DexSave = { owned: own(25) };
    const q = blank();
    q.text = 'PIKACHU'; expect(dexes(DexQuery.run(q, s))).toEqual([25]);
    q.text = 'bulbasaur'; expect(DexQuery.run(q, s)).toEqual([]);        // no lo tienes: no se delata
    q.text = '1'; expect(dexes(DexQuery.run(q, s))).toContain(1);
    q.text = '#025'; expect(dexes(DexQuery.run(q, s))).toEqual([25]);
    q.text = 'zzz'; expect(DexQuery.run(q, s)).toEqual([]);
    expect(DexQuery.norm('Flabébé')).toBe('flabebe');
  });

  test('los filtros se cruzan', () => {
    const s: DexSave = { owned: own(4, 5, 6, 7), shiny: { 6: { at: 1 } } };
    const q = blank();
    q.gen = 1; q.types = ['fire'];
    const fire = dexes(DexQuery.run(q, s));
    expect(fire).toContain(4);
    expect(fire).not.toContain(7);
    q.own = 'own'; expect(dexes(DexQuery.run(q, s))).toEqual([4, 5, 6]);
    q.shiny = true; expect(dexes(DexQuery.run(q, s))).toEqual([6]);
    q.shiny = false; q.own = 'miss';
    expect(dexes(DexQuery.run(q, s))).not.toContain(4);
    q.own = 'all'; q.types = ['water', 'fire'];                          // varios tipos: basta uno
    expect(dexes(DexQuery.run(q, s))).toEqual(expect.arrayContaining([4, 7]));
    q.types = []; q.rarity = [5];
    for (const p of DexQuery.run(q, s)) expect(p.rarity).toBe(5);
  });

  test('"sólo favoritos" ve todas las generaciones; con la generación puesta, sólo esa', () => {
    const s: DexSave = { owned: own(1, 152) };
    DexQuery.toggleFav(s, 1); DexQuery.toggleFav(s, 152);
    const q = blank();
    q.fav = true;
    expect(dexes(DexQuery.run(q, s))).toEqual([1, 152]);
    q.gen = 2; expect(dexes(DexQuery.run(q, s))).toEqual([152]);
  });

  test('órdenes: los que faltan van al final', () => {
    const s: DexSave = { owned: { 25: { at: 50 }, 1: { at: 90 }, 4: { at: 70 } } };
    const q = blank();
    q.own = 'all'; q.sort = 'recent';
    expect(dexes(DexQuery.run(q, s)).slice(0, 4)).toEqual([1, 4, 25, 2]);
    q.sort = 'name';
    expect(dexes(DexQuery.run(q, s)).slice(0, 4)).toEqual([1, 4, 25, 2]);   // Bulbasaur, Charmander, Pikachu
    q.sort = 'rarity';
    const r = DexQuery.run(q, s);
    for (let i = 1; i < r.length; i++) expect(r[i - 1].rarity).toBeGreaterThanOrEqual(r[i].rarity);
    q.sort = 'hp';
    const own3 = DexQuery.run(q, s).slice(0, 3);
    expect(own3.map(p => p.hp)).toEqual([...own3.map(p => p.hp)].sort((a, b) => b - a));
    expect(dexes(own3).sort((a, b) => a - b)).toEqual([1, 4, 25]);
  });

  test('limpiar quita los filtros y deja la generación y el orden', () => {
    const q = blank();
    q.gen = 3; q.sort = 'atk'; q.text = 'x'; q.fav = true; q.types = ['ice']; q.rarity = [2]; q.own = 'own'; q.shiny = true;
    expect(DexQuery.active(q)).toBe(true);
    DexQuery.clear(q);
    expect(DexQuery.active(q)).toBe(false);
    expect([q.gen, q.sort]).toEqual([3, 'atk']);
  });
});

describe('favoritos', () => {
  test('marcar y quitar, aunque el reloj no avance', () => {
    const s: DexSave = { owned: {} };
    expect(DexQuery.toggleFav(s, 25, 5000)).toBe(true);
    expect(DexQuery.isFav(s, 25)).toBe(true);
    expect(DexQuery.toggleFav(s, 25, 5000)).toBe(false);                 // mismo milisegundo
    expect(DexQuery.isFav(s, 25)).toBe(false);
    expect(Math.abs(s.dexFav![25])).toBeGreaterThan(5000);
    expect(DexQuery.favCount(s)).toBe(0);
    DexQuery.toggleFav(s, 25, 1); expect(DexQuery.isFav(s, 25)).toBe(true);   // reloj atrasado
  });

  test('fusión: gana el cambio más reciente de cada Pokémon, y es idempotente', () => {
    const a = { 1: 100, 2: 300, 3: -200 };      // 1 y 2 favoritos; 3 quitado
    const b = { 1: -150, 2: 250, 4: 400 };      // 1 quitado después; 4 nuevo
    const m = DexQuery.mergeFavs(a, b);
    expect(m).toEqual({ 1: -150, 2: 300, 3: -200, 4: 400 });
    expect(DexQuery.mergeFavs(b, a)).toEqual(m);
    expect(DexQuery.mergeFavs(m, a)).toEqual(m);
    expect(DexQuery.mergeFavs(undefined, undefined)).toEqual({});
  });

  test('una partida editada a mano se limpia', () => {
    const ok = (d: number) => d < 1000;
    expect(DexQuery.cleanFavs({ 25: 7, 9999: 3, x: 1, 4: 'si', 5: NaN, 6: 0, 7: -9.7 }, ok)).toEqual({ 25: 7, 7: -9 });
    expect(DexQuery.cleanFavs([1, 2], ok)).toEqual({});
    expect(DexQuery.cleanFavs(null, ok)).toEqual({});
  });
});

describe('favoritos en el guardado', () => {
  const store = new Map<string, string>();
  const saved: Record<string, unknown> = {};
  beforeAll(() => {
    // El guardado local usa el navegador: se simula (y se deja como estaba).
    for (const k of ['window', 'localStorage']) saved[k] = G_[k];
    G_.window = globalThis;
    G_.localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    };
  });
  afterAll(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete G_[k]; else G_[k] = saved[k]; } });

  const clone = (s: SaveData): SaveData => JSON.parse(JSON.stringify(s));

  test('se guardan, y una partida vieja sin el campo carga bien', async () => {
    expect((await DB.register('Favorita', 'clave1')).ok).toBe(true);
    expect(DB.save.dexFav).toBeUndefined();                              // nueva: sin favoritos aún
    DB.grant(25, 'gacha');
    DexQuery.toggleFav(DB.save, 25);
    DexQuery.toggleFav(DB.save, 6);
    DexQuery.toggleFav(DB.save, 6);                                      // 6: puesto y quitado
    DB.commit();
    await DB.logout();

    const raw = JSON.parse(store.get('ps.save.favorita')!);
    expect(raw.dexFav[25]).toBeGreaterThan(0);
    expect(raw.dexFav[6]).toBeLessThan(0);

    expect((await DB.login('Favorita', 'clave1')).ok).toBe(true);
    expect(DexQuery.isFav(DB.save, 25)).toBe(true);
    expect(DexQuery.isFav(DB.save, 6)).toBe(false);
    await DB.logout();

    // Partida de antes de existir los favoritos: sin el campo.
    delete raw.dexFav;
    store.set('ps.save.favorita', JSON.stringify(raw));
    expect((await DB.login('Favorita', 'clave1')).ok).toBe(true);
    expect(DB.save.dexFav).toBeUndefined();
    expect(DexQuery.favCount(DB.save)).toBe(0);
    expect(DexQuery.run(Object.assign(blank(), { fav: true }), DB.save)).toEqual([]);
    expect(DexQuery.isFav(DB.save, 25)).toBe(false);
    expect(DexQuery.toggleFav(DB.save, 25)).toBe(true);                  // y se puede empezar a marcar
    DB.commit();
    expect(JSON.parse(store.get('ps.save.favorita')!).dexFav[25]).toBeGreaterThan(0);
    await DB.logout();
  });

  test('un campo roto en el guardado se limpia al cargar', async () => {
    const raw = JSON.parse(store.get('ps.save.favorita')!);
    raw.dexFav = { 25: 10, 99999: 4, ab: 1, 6: 'x' };
    store.set('ps.save.favorita', JSON.stringify(raw));
    await DB.login('Favorita', 'clave1');
    expect(DB.save.dexFav).toEqual({ 25: 10 });
    await DB.logout();
  });

  test('fusionar dos aparatos: cada favorito, por su último cambio; sin el campo no se inventa', async () => {
    await DB.login('Favorita', 'clave1');
    const base = clone(DB.save);
    await DB.logout();
    delete base.dexFav;

    const phone = clone(base), pc = clone(base);
    phone.updated = 2000; pc.updated = 3000;
    phone.dexFav = { 1: 1500, 2: 1600, 3: 1700 };                        // el móvil marcó 1, 2 y 3
    pc.dexFav = { 2: -2500, 4: 2600 };                                   // el PC quitó el 2 y marcó el 4
    const m = DB.merge(phone, pc);
    expect(m.dexFav).toEqual({ 1: 1500, 2: -2500, 3: 1700, 4: 2600 });
    expect(DB.merge(pc, phone).dexFav).toEqual(m.dexFav);                // da igual el orden
    expect(DB.merge(m, phone).dexFav).toEqual(m.dexFav);                 // idempotente
    expect(DexQuery.favCount(m)).toBe(3);

    // El más reciente de los dos guardados no manda sobre los favoritos del otro.
    const old = clone(base); old.updated = 1000; old.dexFav = { 9: 900 };
    expect(DB.merge(pc, old).dexFav).toEqual({ 2: -2500, 4: 2600, 9: 900 });

    // Ninguna copia los tiene (partidas viejas): la fusión no los inventa.
    expect('dexFav' in DB.merge(clone(base), clone(base))).toBe(false);
    // Sólo una los tiene.
    expect(DB.merge(clone(base), pc).dexFav).toEqual(pc.dexFav);
  });
});
