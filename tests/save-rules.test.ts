/* ============ save-rules.test.ts — anti-trampas del guardado de partida ============
 * La función pura (judgeSave) con casos medidos a mano, y PUT /api/save contra un
 * servidor de verdad con la base en memoria: partidas imposibles para el tiempo
 * transcurrido, colecciones que encogen, versiones que retroceden, campos de tipos
 * raros, y que una partida de juego real (crece poco a poco) pase siempre.
 *
 *   bun test tests/save-rules.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { startServer } from './helpers';
import { sha256 } from '../server/http';
import { isMarkedAccount } from '../server/ranking';
import { ACH_VALUE, LIMITS, judgeSave } from '../server/save-rules';

let srv: ReturnType<typeof startServer>;
let base = '';
beforeAll(() => {
  srv = startServer({ port: 0, dbPath: ':memory:', dist: '.', loginLimit: 1000 });
  base = `http://127.0.0.1:${srv.server.port}`;
});
afterAll(() => srv.stop());

/**
 * fetch que repite si la conexión se rechaza (Windows, con miles de conexiones locales seguidas y otros procesos
 * usando puertos, a veces no acepta una): la petición no llegó al servidor, así que repetirla es seguro.
 */
async function send(url: string, init: RequestInit): Promise<Response> {
  for (let i = 0; ; i++) {
    try { return await fetch(url, init); }
    catch (e: any) { if (i >= 5 || e?.code !== 'ConnectionRefused') throw e; await new Promise(r => setTimeout(r, 50 * (i + 1))); }
  }
}

async function call(method: string, path: string, body?: unknown, token?: string, raw?: string) {
  const res = await send(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: method === 'GET' ? undefined : raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  let j: any = null;
  try { j = await res.json(); } catch { /* no es JSON */ }
  return { status: res.status, j };
}

interface U { id: number; token: string }
let n = 0;
function mkUser(): U {
  const name = 'Guard' + (++n) + Math.random().toString(36).slice(2, 6);
  const id = srv.db.addUser(name, name.toLowerCase(), 'x');
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(30))).toString('base64url');
  srv.db.addSession(sha256(token), id);
  return { id, token };
}

const put = (u: U, save: unknown, ver: number) => call('PUT', '/api/save', { save, base: ver }, u.token);
const stored = async (u: U) => (await call('GET', '/api/save', undefined, u.token)).j;
const marked = (u: U) => isMarkedAccount(srv.db, u.id);
/** Hace como si el último guardado fuera de hace `secs` segundos (el reloj es el del servidor). */
const age = (u: U, secs: number) => srv.db.raw.run('UPDATE saves SET updated = ? WHERE user_id = ?', [Date.now() - secs * 1000, u.id]);
/** Deja una partida guardada saltándose las reglas (el punto de partida de la prueba). */
function seed(u: U, save: unknown) { srv.db.putSave(u.id, JSON.stringify(save), 0); }

/** Una partida como la que crea el cliente (src/core/db.ts, newSave), con lo que se le cambie. */
let dex = 0;
const mon = () => ({ at: Date.now(), from: 'gacha' });
function game(over: Record<string, any> = {}, ownedN = 0): any {
  const owned: Record<string, any> = {};
  for (let i = 1; i <= ownedN; i++) owned[i] = mon();
  return {
    v: 5, name: 'Ash', created: Date.now(), updated: Date.now(), coins: 500, owned, shiny: {}, partner: null,
    tickets: { t1: 0, t10: 0 }, legends: {}, arenas: {}, itemsFound: {}, evoMoves: {}, ach: {},
    stats: { runs: 0, bestTime: 0, bestLevel: 0, totalKills: 0, pulls: 0, coinsEarned: 0, shinies: 0, missionsDone: 0 },
    ...over,
  };
}
void dex;

describe('judgeSave (función pura)', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const o = (secs: number, extra = {}) => ({ secs, now, ...extra });
  const prev = (over = {}) => game({ created: now - 10 * 86400000, coins: 5000, tickets: { t1: 10, t10: 1 }, ...over }, 30);

  test('una partida nueva normal pasa', () => {
    expect(judgeSave(null, game({ created: now - 1000, coins: 777, owned: { 25: mon() } }), o(0)).kind).toBe('ok');
  });

  test.each([
    ['monedas de más', { coins: 5000 }], ['tickets x1 de más', { tickets: { t1: 11, t10: 0 } }], ['tickets x10 de más', { tickets: { t1: 0, t10: 3 } }],
    ['4 Pokémon', { owned: { 1: 1, 2: 1, 3: 1, 4: 1 } }], ['2 shinies', { shiny: { 1: 1, 2: 1 } }], ['6 logros', { ach: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 } }],
    ['4 misiones', { stats: { missionsDone: 4 } }], ['fecha vieja', { created: now - 3 * 86400000 }], ['sin fecha', { created: undefined }],
  ])('partida nueva con %s: marca', (_, over) => {
    const v = judgeSave(null, game({ created: now - 1000, ...over }), o(0));
    expect(v.kind).toBe('sus');
  });

  test('límites exactos de una partida nueva', () => {
    const lim = game({ created: now - 1000, coins: 2000, tickets: { t1: 10, t10: 2 }, owned: { 1: 1, 2: 1, 3: 1 }, shiny: { 1: 1 }, ach: { a: 1, b: 1, c: 1, d: 1, e: 1 }, stats: { missionsDone: 3 } });
    expect(judgeSave(null, lim, o(0)).kind).toBe('ok');
  });

  test('el tiempo cuenta: la misma ganancia pasa con tiempo y no sin él', () => {
    const p = prev();
    const gana = { ...p, owned: { ...p.owned, ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [100 + i, mon()])) } };
    // 40 Pokémon más sin gastar un ticket: sólo horas de juego los explican
    expect(judgeSave(p, gana, o(30)).kind).toBe('sus');
    expect(judgeSave(p, gana, o(300)).kind).toBe('sus');
    expect(judgeSave(p, gana, o(3600)).kind).toBe('ok');
  });

  test('el tiempo tiene tope: 100 días sin guardar valen 12 h', () => {
    const p = prev({ tickets: { t1: 0, t10: 0 } });
    expect(LIMITS.gapSecs).toBe(12 * 3600);
    expect(judgeSave(p, { ...p, coins: p.coins + 1e6 }, o(12 * 3600)).kind).toBe('ok');
    expect(judgeSave(p, { ...p, coins: p.coins + 2e7 }, o(12 * 3600)).kind).toBe('sus');
    expect(judgeSave(p, { ...p, coins: p.coins + 2e7 }, o(100 * 86400)).kind).toBe('sus');
    // el reloj hacia atrás (secs negativo) no da margen extra
    expect(judgeSave(p, { ...p, coins: p.coins + 60000 }, o(-5000)).kind).toBe('sus');
  });

  test('gastar tickets explica Pokémon nuevos; no gastarlos, no', () => {
    const p = prev({ tickets: { t1: 0, t10: 5 } });
    const mas = (k: number) => ({ ...p.owned, ...Object.fromEntries(Array.from({ length: k }, (_, i) => [100 + i, mon()])) });
    const gastado = { ...p, tickets: { t1: 0, t10: 0 }, owned: mas(50) };
    expect(judgeSave(p, gastado, o(300)).kind).toBe('ok');
    expect(judgeSave(p, { ...gastado, owned: mas(100) }, o(300)).kind).toBe('sus');
    expect(judgeSave(p, { ...p, owned: mas(50) }, o(300)).kind).toBe('sus');
  });

  test('las monedas: jugar da, el resto tiene que salir de tickets', () => {
    const p = prev({ tickets: { t1: 0, t10: 0 } });
    // 5 min: 8000 + 40·300 = 20 000 monedas de margen
    expect(judgeSave(p, { ...p, coins: p.coins + 19000 }, o(300)).kind).toBe('ok');
    expect(judgeSave(p, { ...p, coins: p.coins + 60000 }, o(300)).kind).toBe('sus');
    expect(judgeSave(p, { ...p, coins: p.coins + 1e9 }, o(300)).kind).toBe('sus');
    // gastar monedas nunca es raro
    expect(judgeSave(p, { ...p, coins: 0 }, o(1)).kind).toBe('ok');
  });

  test('los logros nuevos traen su premio; los que no existen, un margen', () => {
    const p = prev({ tickets: { t1: 0, t10: 0 } });
    const con = (id: string, t1: number, t10 = 0) => ({ ...p, ach: { [id]: 1 }, tickets: { t1, t10 } });
    expect(judgeSave(p, con('ownAll', 0, 100), o(1)).kind).toBe('sus');       // 100 tiradas de premio + el margen fijo no llegan a 1000 de t10
    expect(judgeSave(p, con('own100', 0, 1), o(60)).kind).toBe('ok');
    expect(judgeSave(p, con('inventado', 0, 2), o(60)).kind).toBe('ok');      // 10 tiradas de margen por logro desconocido
    expect(judgeSave(p, con('leg_150', 1), o(60)).kind).toBe('ok');
  });

  test('la fecha de creación no puede cambiar; las misiones tienen un tope por día', () => {
    const p = prev();
    expect(judgeSave(p, { ...p, created: p.created + 1 }, o(300)).kind).toBe('sus');
    expect(judgeSave(p, { ...p, stats: { ...p.stats, missionsDone: 200 } }, o(300)).kind).toBe('sus');
    expect(judgeSave(p, { ...p, stats: { ...p.stats, missionsDone: 12 } }, o(3600)).kind).toBe('ok');
  });

  test('demasiados Pokémon, shinies o logros: marca aunque el presupuesto alcance', () => {
    const p = prev({ tickets: { t1: 0, t10: 0 } });
    const muchos = Object.fromEntries(Array.from({ length: LIMITS.collection + 1 }, (_, i) => [i, mon()]));
    expect(judgeSave(p, { ...p, owned: muchos }, o(1e9)).kind).toBe('sus');
    expect(judgeSave(p, { ...p, shiny: muchos }, o(1e9)).kind).toBe('sus');
    const logros = Object.fromEntries(Array.from({ length: LIMITS.ach + 1 }, (_, i) => ['x' + i, 1]));
    expect(judgeSave(p, { ...p, ach: logros }, o(1e9)).kind).toBe('sus');
  });

  test('una cuenta ya marcada no se vuelve a juzgar, pero la forma sí se mira', () => {
    const p = prev();
    expect(judgeSave(p, { ...p, coins: 1e12 }, o(1, { marked: true })).kind).toBe('ok');
    expect(judgeSave(p, { ...p, coins: 'mucho' }, o(1, { marked: true })).kind).toBe('reject');
  });

  test('no muta lo que le pasan', () => {
    const p = prev(), nx = game({ created: p.created, owned: { 1: mon() } });
    const copia = JSON.stringify([p, nx]);
    judgeSave(p, nx, o(300));
    expect(JSON.stringify([p, nx])).toBe(copia);
  });

  test('los premios de la tabla son los de src/data/achievements.ts', () => {
    const src = readFileSync(new URL('../src/data/achievements.ts', import.meta.url), 'utf8');
    const del_juego: Record<string, number> = {};
    for (const m of src.matchAll(/\{ id: '(\w+)'.*?reward: \{([^}]*)\}/g)) {
      let v = 0;
      for (const [, k, x] of m[2].matchAll(/(\w+):\s*(\d+)/g)) v += k === 't1' ? +x : k === 't10' ? 10 * +x : +x / 300;
      del_juego[m[1]] = Math.round(v * 1000) / 1000;
    }
    expect(Object.keys(del_juego).length).toBeGreaterThan(40);
    expect(ACH_VALUE).toEqual(del_juego);
  });
});

describe('PUT /api/save: partida de juego real', () => {
  test('una cuenta que crece poco a poco durante 60 guardados no se marca nunca', async () => {
    const u = mkUser();
    let s = game({ coins: 500, tickets: { t1: 0, t10: 0 } });
    let r = await put(u, s, 0);
    expect(r.status).toBe(200);
    let ver = r.j.ver;
    let dexN = 0;
    for (let i = 1; i <= 60; i++) {
      age(u, 300);                                                    // un guardado cada 5 min
      s = JSON.parse(JSON.stringify(s));
      s.coins += 2500;                                                // una partida da unos miles de monedas
      s.tickets.t1 += 2;
      if (i % 10 === 0) s.tickets.t10 += 1;
      if (i % 4 === 0) { s.owned[++dexN + 100] = mon(); s.tickets.t1 -= 1; }       // tira y sale uno nuevo
      if (i % 25 === 0) s.shiny[dexN + 100] = mon();
      if (i % 6 === 0) s.stats.missionsDone += 1;
      if (i === 20) s.ach.own10 = 1, s.tickets.t1 += 2;                // el premio del logro
      s.stats.runs += 1; s.stats.totalKills += 600; s.updated = Date.now();
      r = await put(u, s, ver);
      expect(r.status).toBe(200);
      ver = r.j.ver;
      expect(marked(u)).toBe(false);
    }
    const g = (await stored(u)).save;
    expect(Object.keys(g.owned).length).toBe(15);
    expect(g.coins).toBe(500 + 60 * 2500);
  });

  test('guardados muy seguidos (cada 30 s, como al acabar partidas) y sin cambios no marcan', async () => {
    const u = mkUser();
    let s = game({ coins: 600 });
    let ver = (await put(u, s, 0)).j.ver;
    for (let i = 0; i < 20; i++) {
      age(u, 30);
      s = { ...s, coins: s.coins + 800, updated: Date.now() };
      const r = await put(u, s, ver);
      expect(r.status).toBe(200);
      ver = r.j.ver;
    }
    for (let i = 0; i < 5; i++) { age(u, 1); const r = await put(u, s, ver); expect(r.status).toBe(200); ver = r.j.ver; }
    expect(marked(u)).toBe(false);
  });

  test('la partida nueva del primer guardado (monedas de inicio, un starter) pasa', async () => {
    const u = mkUser();
    const r = await put(u, game({ coins: 777, partner: 25, starter: 25, owned: { 25: { at: Date.now(), from: 'starter' } } }), 0);
    expect(r.status).toBe(200);
    expect(marked(u)).toBe(false);
  });

  test('un día entero sin conexión (8 h de juego de golpe) no marca', async () => {
    const u = mkUser();
    const s = game({ created: Date.now() - 20 * 86400000, coins: 20000, tickets: { t1: 30, t10: 2 } }, 40);
    seed(u, s);
    age(u, 24 * 3600);
    const nx = JSON.parse(JSON.stringify(s));
    nx.coins += 200000; nx.tickets.t1 += 100; nx.tickets.t10 += 10;
    for (let i = 0; i < 20; i++) nx.owned[200 + i] = mon();
    nx.updated = Date.now();
    expect((await put(u, nx, 1)).status).toBe(200);
    expect(marked(u)).toBe(false);
  });
});

describe('PUT /api/save: partidas imposibles se guardan y marcan la cuenta', () => {
  async function marca(over: (s: any) => void, secs = 300) {
    const u = mkUser();
    const s = game({ created: Date.now() - 20 * 86400000, coins: 5000, tickets: { t1: 5, t10: 1 } }, 30);
    seed(u, s);
    age(u, secs);
    const nx = JSON.parse(JSON.stringify(s));
    over(nx);
    const r = await put(u, nx, 1);
    return { u, r, nx };
  }

  test.each<[string, (s: any) => void]>([
    ['un millón de monedas en 5 minutos', s => { s.coins += 1e6; }],
    ['monedas infinitas (1e308)', s => { s.coins = 1e308; }],
    ['100 tickets x10 de golpe', s => { s.tickets.t10 += 100; }],
    ['999 tickets x1', s => { s.tickets.t1 = 999; }],
    ['50 Pokémon nuevos sin gastar tickets', s => { for (let i = 0; i < 50; i++) s.owned[300 + i] = mon(); }],
    ['60 shinies de golpe', s => { for (let i = 0; i < 60; i++) s.shiny[300 + i] = mon(); }],
    ['200 misiones hechas', s => { s.stats.missionsDone = 200; }],
    ['la fecha de creación cambiada', s => { s.created -= 1; }],
    ['tickets que no cuadran con los logros nuevos', s => { s.ach.own10 = 1; s.tickets.t10 += 30; }],
    ['más de 1100 Pokémon', s => { for (let i = 0; i < 1200; i++) s.owned[1000 + i] = mon(); s.tickets.t10 = 0; }],
  ])('%s', async (_, over) => {
    const { u, r, nx } = await marca(over);
    expect(r.status).toBe(200);                                       // no se rechaza: nadie pierde progreso por un falso positivo
    expect(marked(u)).toBe(true);                                     // pero la cuenta ya no sube marcas
    const g = (await stored(u)).save;
    expect(g.coins).toBe(nx.coins);                                   // y se guarda lo que subió
    expect((await stored(u)).ver).toBe(r.j.ver);
  });

  test('una partida nueva imposible: monedas y colección enormes en la primera subida', async () => {
    const u = mkUser();
    const r = await put(u, game({ coins: 1e9, tickets: { t1: 500, t10: 50 } }, 400), 0);
    expect(r.status).toBe(200);
    expect(marked(u)).toBe(true);
  });

  test('una partida de otra época importada (fecha vieja) también queda marcada: el admin puede desmarcarla', async () => {
    const u = mkUser();
    const r = await put(u, game({ created: Date.now() - 30 * 86400000, coins: 100 }, 5), 0);
    expect(r.status).toBe(200);
    expect(marked(u)).toBe(true);
  });

  test('la cuenta marcada no puede subir al ranking, y al desmarcarla sí', async () => {
    const { u } = await marca(s => { s.coins += 1e7; });
    expect(marked(u)).toBe(true);
    await call('POST', '/api/ranking/start', { mode: 's' }, u.token);
    srv.db.raw.run('UPDATE ranking_runs SET started = ? WHERE user_id = ?', [Date.now() - 500_000, u.id]);
    const body = { mode: 's', t: 100, lv: 5, kills: 50, dex: 25, shiny: false };
    expect((await call('POST', '/api/ranking/submit', body, u.token)).status).toBe(403);
    srv.db.raw.run('DELETE FROM ranking_marked WHERE user_id = ?', [u.id]);                 // lo que hace el admin
    expect((await call('POST', '/api/ranking/submit', body, u.token)).status).toBe(200);
  });

  test('una vez marcada, los guardados siguientes se aceptan sin más (y la marca no se quita sola)', async () => {
    const { u, nx, r } = await marca(s => { s.coins += 1e7; });
    age(u, 5);
    nx.coins += 1e8;
    expect((await put(u, nx, r.j.ver)).status).toBe(200);
    expect(marked(u)).toBe(true);
    age(u, 3600);
    nx.coins -= 5;
    expect((await put(u, nx, r.j.ver + 1)).status).toBe(200);
    expect(marked(u)).toBe(true);
  });

  test('desmarcada por el admin, la cuenta vuelve a juzgarse desde lo que hay guardado', async () => {
    const { u, nx, r } = await marca(s => { s.coins += 1e7; });
    srv.db.raw.run('DELETE FROM ranking_marked WHERE user_id = ?', [u.id]);
    age(u, 300);
    nx.coins += 1000;
    expect((await put(u, nx, r.j.ver)).status).toBe(200);
    expect(marked(u)).toBe(false);
    age(u, 300);
    nx.coins += 1e7;
    expect((await put(u, nx, r.j.ver + 1)).status).toBe(200);
    expect(marked(u)).toBe(true);
  });

  test('la marca de otra cuenta no se contagia', async () => {
    const a = await marca(s => { s.coins += 1e7; });
    const b = mkUser();
    expect((await put(b, game(), 0)).status).toBe(200);
    expect(marked(a.u)).toBe(true);
    expect(marked(b)).toBe(false);
  });
});

describe('PUT /api/save: lo conseguido nunca se pierde', () => {
  const rica = () => game({
    created: Date.now() - 20 * 86400000, coins: 100,
    shiny: { 3: mon(), 7: mon() }, legends: { 150: 1, 151: 1 }, arenas: { fuego: 1 }, itemsFound: { baya: 1 }, evoMoves: { ray: 1 },
    ach: { own10: 1, time5: 1, leg_150: 1 }, stats: { runs: 40, bestTime: 900, bestLevel: 22, totalKills: 9000, pulls: 80, missionsDone: 12 },
  }, 20);

  test('una colección que encoge se restituye (Pokémon, shinies, logros, legendarios, arenas, objetos, movimientos)', async () => {
    const u = mkUser();
    const s = rica();
    seed(u, s);
    age(u, 600);
    // (El que se queda, con la misma entrada: con mon() llevaría la hora de ahora, y si cambiaba el
    // milisegundo entre las dos la comparación de abajo fallaba sin que el servidor tuviera culpa.)
    const encogida = game({ created: s.created, coins: 100, owned: { 1: s.owned[1] }, stats: { runs: 1 } });
    const r = await put(u, encogida, 1);
    expect(r.status).toBe(200);
    const g = (await stored(u)).save;
    for (const c of ['owned', 'shiny', 'legends', 'arenas', 'itemsFound', 'evoMoves', 'ach']) {
      for (const k of Object.keys(s[c])) expect(g[c][k]).toEqual(s[c][k]);
    }
    expect(Object.keys(g.owned).length).toBe(20);
    expect(g.stats.runs).toBe(40);
    expect(g.stats.missionsDone).toBe(12);
    expect(g.stats.totalKills).toBe(9000);
    expect(marked(u)).toBe(false);                                    // encoger no es trampa, sólo no se acepta
  });

  test('un Pokémon que sale de la partida (porque el juego lo quitó de la Pokédex) sigue guardado, sin atascar nada', async () => {
    const u = mkUser();
    const s = rica();
    seed(u, s);
    const sin = JSON.parse(JSON.stringify(s));
    delete sin.owned[20];
    let ver = 1;
    for (let i = 0; i < 3; i++) {                                     // el cliente lo quita cada vez; el servidor no discute ni se atasca
      age(u, 300);
      const r = await put(u, sin, ver);
      expect(r.status).toBe(200);
      ver = r.j.ver;
    }
    expect((await stored(u)).save.owned[20]).toBeDefined();
  });

  test('borrar un logro para volver a cobrarlo no funciona', async () => {
    const u = mkUser();
    const s = rica();
    s.tickets = { t1: 0, t10: 0 };
    seed(u, s);
    age(u, 300);
    const nx = JSON.parse(JSON.stringify(s));
    delete nx.ach.own10; delete nx.ach.time5;
    expect((await put(u, nx, 1)).status).toBe(200);
    expect(Object.keys((await stored(u)).save.ach).sort()).toEqual(['leg_150', 'own10', 'time5']);
    age(u, 300);
    nx.ach.own10 = 1; nx.tickets.t1 = 2;                              // ... y "volver a conseguirlo" no da nada nuevo
    expect((await put(u, nx, 2)).status).toBe(200);
    expect(marked(u)).toBe(false);
    age(u, 300);
    nx.tickets.t1 = 500;
    expect((await put(u, nx, 3)).status).toBe(200);
    expect(marked(u)).toBe(true);
  });

  test('las estadísticas y las misiones no bajan', async () => {
    const u = mkUser();
    const s = rica();
    seed(u, s);
    age(u, 300);
    const nx = JSON.parse(JSON.stringify(s));
    nx.stats = { runs: 0, missionsDone: 0, bestTime: 1 };
    expect((await put(u, nx, 1)).status).toBe(200);
    expect((await stored(u)).save.stats).toMatchObject({ runs: 40, missionsDone: 12, bestTime: 900, bestLevel: 22 });
  });

  test('claves raras en las colecciones (__proto__, constructor) no rompen nada', async () => {
    const u = mkUser();
    const s = rica();
    seed(u, JSON.parse(JSON.stringify(s).replace('"owned":{', '"owned":{"__proto__":{"x":1},"constructor":{"y":2},')));
    age(u, 300);
    const raw = JSON.stringify({ save: JSON.parse(JSON.stringify(s)), base: 1 }).replace('"owned":{', '"owned":{"__proto__":{"coins":1e9},');
    const r = await call('PUT', '/api/save', undefined, u.token, raw);
    expect(r.status).toBe(200);
    expect(({} as any).coins).toBeUndefined();
    expect(({} as any).x).toBeUndefined();
  });
});

describe('PUT /api/save: versiones que retroceden y choques', () => {
  test('con una versión vieja (base) responde 409 y no juzga ni marca, aunque la partida sea imposible', async () => {
    const u = mkUser();
    const s = game({ created: Date.now() - 20 * 86400000 }, 5);
    seed(u, s);
    age(u, 300);
    const buena = { ...s, coins: s.coins + 100 };
    const ok = await put(u, buena, 1);
    expect(ok.j.ver).toBe(2);
    const imposible = { ...s, coins: 1e12 };
    const stale = await put(u, imposible, 1);
    expect(stale.status).toBe(409);
    expect(stale.j.save.coins).toBe(buena.coins);
    expect(marked(u)).toBe(false);
    expect((await stored(u)).ver).toBe(2);
  });

  test('una versión (base) mayor que la guardada tampoco se acepta', async () => {
    const u = mkUser();
    seed(u, game({ created: Date.now() - 20 * 86400000 }, 5));
    const r = await put(u, game({ coins: 1e12, created: Date.now() - 20 * 86400000 }, 5), 99);
    expect(r.status).toBe(409);
    expect(marked(u)).toBe(false);
  });

  test('si el cliente repite tras el 409 con la fusión, se guarda; sin marcar', async () => {
    const u = mkUser();
    const s = game({ created: Date.now() - 20 * 86400000, coins: 2000 }, 5);
    seed(u, s);
    age(u, 600);
    await put(u, { ...s, coins: 2500 }, 1);                           // otro dispositivo
    const stale = await put(u, { ...s, coins: 3000 }, 1);
    expect(stale.status).toBe(409);
    age(u, 600);
    const fusion = { ...stale.j.save, coins: 3000 };
    expect((await put(u, fusion, stale.j.ver)).status).toBe(200);
    expect(marked(u)).toBe(false);
  });

  test('la versión del formato (v) o la hora de guardado (updated) hacia atrás no importan', async () => {
    const u = mkUser();
    const s = game({ created: Date.now() - 20 * 86400000, v: 9, updated: Date.now() }, 5);
    seed(u, s);
    age(u, 300);
    const r = await put(u, { ...s, v: 1, updated: 5 }, 1);
    expect(r.status).toBe(200);
    expect(marked(u)).toBe(false);
    expect((await stored(u)).save.v).toBe(1);
  });

  test('diez guardados imposibles a la vez con la misma base: uno se guarda, nueve chocan', async () => {
    const u = mkUser();
    seed(u, game({ created: Date.now() - 20 * 86400000 }, 5));
    age(u, 300);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => put(u, game({ coins: 1e9 + i, created: Date.now() - 20 * 86400000 }, 5), 1)));
    expect(rs.filter(r => r.status === 200).length).toBe(1);
    expect(rs.filter(r => r.status === 409).length).toBe(9);
    expect(marked(u)).toBe(true);
  });
});

describe('PUT /api/save: campos de tipos raros', () => {
  const base0 = () => game({ created: Date.now() - 20 * 86400000, coins: 1000 }, 5);

  test.each<[string, (s: any) => void]>([
    ['coins texto', s => { s.coins = '999'; }], ['coins negativo', s => { s.coins = -1; }], ['coins null', s => { s.coins = null; }],
    ['coins array', s => { s.coins = [1]; }], ['coins objeto', s => { s.coins = { a: 1 }; }], ['coins booleano', s => { s.coins = true; }],
    ['tickets array', s => { s.tickets = [1, 2]; }], ['tickets texto', s => { s.tickets = 'muchos'; }], ['tickets null', s => { s.tickets = null; }],
    ['t1 texto', s => { s.tickets.t1 = '5'; }], ['t10 negativo', s => { s.tickets.t10 = -3; }], ['t1 null', s => { s.tickets.t1 = null; }],
    ['created texto', s => { s.created = 'ayer'; }], ['created null', s => { s.created = null; }],
    ['stats array', s => { s.stats = []; }], ['stats null', s => { s.stats = null; }], ['missionsDone texto', s => { s.stats.missionsDone = '3'; }],
    ['missionsDone negativo', s => { s.stats.missionsDone = -1; }],
    ['owned array', s => { s.owned = [1, 2, 3]; }], ['owned texto', s => { s.owned = 'todos'; }], ['owned null', s => { s.owned = null; }],
    ['shiny número', s => { s.shiny = 5; }], ['ach null', s => { s.ach = null; }], ['legends true', s => { s.legends = true; }],
    ['arenas array', s => { s.arenas = []; }], ['itemsFound texto', s => { s.itemsFound = 'x'; }], ['evoMoves número', s => { s.evoMoves = 1; }],
  ])('%s -> 400 y la guardada no cambia', async (_, rompe) => {
    const u = mkUser();
    const s = base0();
    seed(u, s);
    age(u, 300);
    const nx = JSON.parse(JSON.stringify(s));
    rompe(nx);
    const r = await put(u, nx, 1);
    expect(r.status).toBe(400);
    expect(r.j.ok).toBe(false);
    const g = await stored(u);
    expect(g.ver).toBe(1);
    expect(g.save).toEqual(JSON.parse(JSON.stringify(s)));
    expect(marked(u)).toBe(false);
  });

  test('infinitos y NaN de un JSON escrito a mano', async () => {
    const u = mkUser();
    seed(u, base0());
    for (const v of ['1e999', '-1e999', '1e400']) {
      const r = await call('PUT', '/api/save', undefined, u.token, `{"save":{"coins":${v}},"base":1}`);
      expect(r.status).toBe(400);
    }
    expect((await call('PUT', '/api/save', undefined, u.token, '{"save":{"coins":NaN},"base":1}')).status).toBe(400);
    expect((await stored(u)).ver).toBe(1);
  });

  test('campos desconocidos, nombres raros o tipos que no importan no se discuten', async () => {
    const u = mkUser();
    const s = base0();
    seed(u, s);
    age(u, 300);
    const nx = { ...s, name: 123, partner: 'x', nuevo: { a: [1, { b: null }] }, profile: 'texto', pity: [], v: 'v9', updated: 'ayer' };
    expect((await put(u, nx, 1)).status).toBe(200);
    expect(marked(u)).toBe(false);
  });

  test('una partida {} o sin campos pasa como nueva (compatibilidad) y no explota', async () => {
    const u = mkUser();
    expect((await put(u, {}, 0)).status).toBe(200);
    age(u, 100);
    expect((await put(u, { coins: 5 }, 1)).status).toBe(200);
  });
});
