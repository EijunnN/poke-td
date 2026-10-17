/* ============ arena-ranking.test.ts — podio y victorias de la Arena ============
 * Contra un servidor de verdad con la base en memoria (como ranking.test.ts): subir el resultado
 * (aviso con /start 'a', equipo de la sala, una subida por partida, cuentas marcadas), datos rotos
 * o tramposos, y el top (orden por victorias, podios, partidas y nombre; periodos; amigos; tu puesto;
 * cuenta borrada). El reloj se controla con un módulo suelto donde hace falta.
 *
 *   bun test tests/arena-ranking.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startServer } from './helpers';
import { openDb } from '../server/db';
import { sha256 } from '../server/http';
import { createArena, type ArenaOptions } from '../server/arena';
import { createRanking, markAccount, periodIds } from '../server/ranking';
import { MAX_WAVE } from '../src/modes/td-waves';

let srv: ReturnType<typeof startServer>;
let base = '';

beforeAll(() => {
  srv = startServer({ port: 0, dbPath: ':memory:', dist: '.', loginLimit: 1000 });
  base = `http://127.0.0.1:${srv.server.port}`;
});
afterAll(() => srv.stop());

/** fetch que repite si la conexión se rechaza (ver ranking.test.ts). */
async function send(url: string, init: RequestInit): Promise<Response> {
  for (let i = 0; ; i++) {
    try { return await fetch(url, init); }
    catch (e: any) { if (i >= 5 || e?.code !== 'ConnectionRefused') throw e; await new Promise(r => setTimeout(r, 50 * (i + 1))); }
  }
}

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await send(base + '/api/ranking' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: method === 'GET' ? undefined : body === undefined ? undefined : JSON.stringify(body),
  });
  let j: any = null;
  try { j = await res.json(); } catch { /* no es JSON */ }
  return { status: res.status, j };
}

interface U { id: number; uid: string; name: string; token: string }
let n = 0;
/** Cuenta nueva con sesión, sin pasar por argon2. */
function mkUser(name = 'Arena' + (++n) + Math.random().toString(36).slice(2, 6)): U {
  const id = srv.db.addUser(name, name.toLowerCase(), 'x');
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(30))).toString('base64url');
  srv.db.addSession(sha256(token), id);
  return { id, uid: String(id), name, token };
}

/** Avisa de que empieza una Arena que lleva `age` s en marcha, con la sala del anfitrión apuntada (como hace realtime.ts). */
async function begin(host: U, equipo: U[], age = 0, mode = 'a') {
  const r = await call('POST', '/start', { mode }, host.token);
  expect(r.status).toBe(200);
  srv.db.raw.run('UPDATE ranking_runs SET started = ? WHERE user_id = ?', [Date.now() - age * 1000, host.id]);
  seedTeam(host, equipo, age);
}
function seedTeam(host: U, equipo: U[], age = 0) {
  const ids = [...new Set([host.id, ...equipo.map(m => m.id)])].sort((a, b) => a - b);
  srv.db.raw.run('INSERT OR REPLACE INTO group_starts (host_id, team, started) VALUES (?, ?, ?)', [host.id, JSON.stringify(ids), Date.now() - age * 1000 - 1000]);
}

/** El cuerpo de una subida: `orden` son los jugadores del primero al último (puestos 1, 2, 3...). */
const body = (orden: U[], over: Record<string, unknown> = {}) => ({
  map: 'valle', waves: 12, secs: 600,
  places: orden.map((u, i) => ({ uid: u.uid, place: i + 1, wave: Math.max(0, 12 - i), dex: 25 + i, shiny: false })), ...over,
});
/** Arena completa: aviso (con equipo) y subida del anfitrión (el primero de `orden`, salvo que se diga otro). */
async function arena(orden: U[], over: Record<string, unknown> = {}, host = orden[0], age = 700) {
  await begin(host, orden, age);
  return call('POST', '/arena', body(orden, over), host.token);
}
const topArena = (u: U, period = 'a', extra = '') => call('GET', `/arena/top?period=${period}${extra}`, undefined, u.token);
const count = (table: string, where = '1', ...args: unknown[]) =>
  (srv.db.raw.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...(args as any)) as { n: number }).n;

describe('subir el resultado', () => {
  test('una partida legal: se guarda la partida y el puesto de cada cuenta, y se gasta el aviso', async () => {
    const [a, b, c] = [mkUser(), mkUser(), mkUser()];
    const r = await arena([b, a, c], {}, a);                // A es el anfitrión pero queda 2.º
    expect(r.status).toBe(200);
    expect(r.j).toMatchObject({ ok: true, counted: 3 });
    const g = srv.db.raw.query('SELECT * FROM arena_games WHERE id = ?').get(r.j.id) as any;
    expect(g).toMatchObject({ host: a.id, players: 3, map: 'valle', waves: 12, secs: 600 });
    const ids = periodIds();
    expect([g.pd, g.pw, g.pm]).toEqual([ids.d, ids.w, ids.m]);
    const ps = srv.db.raw.query('SELECT user_id, place, wave, dex, shiny FROM arena_places WHERE game_id = ? ORDER BY place').all(r.j.id) as any[];
    expect(ps).toEqual([
      { user_id: b.id, place: 1, wave: 12, dex: 25, shiny: 0 },
      { user_id: a.id, place: 2, wave: 11, dex: 26, shiny: 0 },
      { user_id: c.id, place: 3, wave: 10, dex: 27, shiny: 0 },
    ]);
    expect(count('ranking_runs', 'user_id = ?', a.id)).toBe(0);
    // La Arena no mete nada en las tablas de marcas del ranking normal.
    expect(count('ranking_entries', 'id LIKE ?', '%' + a.uid + '%')).toBe(0);
  });

  test('empates: dos puestos 1 y un 3 se guardan tal cual', async () => {
    const [a, b, c] = [mkUser(), mkUser(), mkUser()];
    const o = [a, b, c];
    const r = await arena(o, { places: o.map((u, i) => ({ uid: u.uid, place: [1, 1, 3][i], wave: 9, dex: 4, shiny: i === 0 })) });
    expect(r.status).toBe(200);
    const t = (await topArena(c)).j;
    expect(t.rows.find((x: any) => x.uid === a.uid)).toMatchObject({ wins: 1, podiums: 1, games: 1, shiny: true });
    expect(t.rows.find((x: any) => x.uid === b.uid)).toMatchObject({ wins: 1 });
    expect(t.rows.find((x: any) => x.uid === c.uid)).toMatchObject({ wins: 0, podiums: 1 });
  });

  test('una partida, una subida: la segunda falla (409) y no se guarda nada', async () => {
    const [a, b] = [mkUser(), mkUser()];
    expect((await arena([a, b])).status).toBe(200);
    const otra = await call('POST', '/arena', body([a, b]), a.token);
    expect(otra.status).toBe(409);
    expect(count('arena_places', 'user_id = ?', a.id)).toBe(1);
  });

  test('sin /start, o con el aviso de otro modo: 409', async () => {
    const [a, b] = [mkUser(), mkUser()];
    seedTeam(a, [a, b]);
    expect((await call('POST', '/arena', body([a, b]), a.token)).status).toBe(409);
    await begin(a, [a, b], 700, 'e');                              // aviso de Defensa en grupo
    expect((await call('POST', '/arena', body([a, b]), a.token)).status).toBe(409);
    expect(count('arena_games', 'host = ?', a.id)).toBe(0);
    expect(count('ranking_runs', 'user_id = ?', a.id)).toBe(1);   // y el aviso sigue sin gastar
  });

  test('un equipo que no es el de la sala (otra cuenta, o de menos o de más): 403 y el aviso sigue', async () => {
    const [a, b, c] = [mkUser(), mkUser(), mkUser()];
    await begin(a, [a, b], 700);                                   // la sala apuntó a A y B
    for (const orden of [[a, c], [a, b, c], [a]]) {
      const r = await call('POST', '/arena', orden.length < 2 ? { ...body([a, b]), places: body([a, b]).places.slice(0, 1) } : body(orden), a.token);
      expect([orden.length, r.status]).toEqual([orden.length, orden.length < 2 ? 400 : 403]);
    }
    expect(count('arena_games', 'host = ?', a.id)).toBe(0);
    expect(count('ranking_runs', 'user_id = ?', a.id)).toBe(1);
    expect((await call('POST', '/arena', body([a, b]), a.token)).status).toBe(200);   // el equipo bueno sí
  });

  test('sube sólo el anfitrión, dentro de la partida: si no estás entre los puestos, 403', async () => {
    const [a, b, c] = [mkUser(), mkUser(), mkUser()];
    await begin(a, [a, b]);
    expect((await call('POST', '/arena', body([b, c]), a.token)).status).toBe(403);
    // Otro de la sala no puede subirla con su cuenta: no ha avisado él.
    expect((await call('POST', '/arena', body([a, b]), b.token)).status).toBe(409);
    expect(count('arena_games', 'host = ?', b.id)).toBe(0);
  });

  test('requiere sesión', async () => {
    expect((await call('POST', '/arena', body([mkUser(), mkUser()]))).status).toBe(401);
    expect((await call('GET', '/arena/top?period=a')).status).toBe(401);
    expect((await call('POST', '/arena', body([mkUser(), mkUser()]), 'inventado')).status).toBe(401);
  });

  test('datos rotos o tramposos: 400 y no se gasta el aviso', async () => {
    const us = Array.from({ length: 9 }, () => mkUser());
    const [a, b] = us;
    const places = (ps: unknown[]) => ({ places: ps });
    const p = (u: U, place: number, over: Record<string, unknown> = {}) => ({ uid: u.uid, place, wave: 5, dex: 25, shiny: false, ...over });
    await begin(a, [a, b], 700);
    const malos: [string, Record<string, unknown>][] = [
      ['sin mapa', { map: undefined }], ['mapa largo', { map: 'x'.repeat(33) }], ['mapa con etiquetas', { map: '<b>' }], ['mapa numérico', { map: 5 }],
      ['oleadas negativas', { waves: -1 }], ['oleadas de más', { waves: MAX_WAVE + 1 }], ['oleadas decimales', { waves: 2.5 }], ['oleadas texto', { waves: '3' }],
      ['secs 0', { secs: 0 }], ['secs decimales', { secs: 99.5 }], ['secs de más', { secs: 3 * 3600 + 1 }], ['secs texto', { secs: '600' }],
      ['secs más que el tiempo real', { secs: 5000 }],
      ['sin places', { places: undefined }], ['places no es lista', { places: 'ab' }], ['un solo jugador', places([p(a, 1)])],
      ['nueve jugadores', places(us.map((u, i) => p(u, i + 1)))],
      ['uid repetido', places([p(a, 1), p(a, 2)])], ['uid inexistente', places([p(a, 1), { ...p(b, 2), uid: '999999' }])],
      ['uid roto', places([p(a, 1), { ...p(b, 2), uid: '1; DROP TABLE users' }])], ['uid numérico', places([p(a, 1), { ...p(b, 2), uid: b.id }])],
      ['puesto 0', places([p(a, 1), p(b, 0)])], ['puesto mayor que N', places([p(a, 1), p(b, 3)])], ['puesto decimal', places([p(a, 1), p(b, 1.5)])],
      ['puesto texto', places([p(a, 1), p(b, '2' as any)])], ['nadie gana', places([p(a, 2), p(b, 2)])],
      ['oleada negativa', places([p(a, 1), p(b, 2, { wave: -1 })])], ['oleada enorme', places([p(a, 1), p(b, 2, { wave: MAX_WAVE + 2 })])],
      ['Pokémon 0', places([p(a, 1), p(b, 2, { dex: 0 })])], ['Pokémon 2001', places([p(a, 1), p(b, 2, { dex: 2001 })])], ['Pokémon decimal', places([p(a, 1), p(b, 2, { dex: 1.5 })])],
      ['fila nula', places([p(a, 1), null])],
    ];
    for (const [que, over] of malos) {
      const r = await call('POST', '/arena', { ...body([a, b]), ...over }, a.token);
      expect([que, r.status]).toEqual([que, 400]);
    }
    expect((await call('POST', '/arena', undefined, a.token)).status).toBe(400);           // sin cuerpo
    expect(count('arena_games', 'host = ?', a.id)).toBe(0);
    expect(count('ranking_runs', 'user_id = ?', a.id)).toBe(1);
    // Con los datos buenos y el equipo de la sala, sí pasa.
    expect((await call('POST', '/arena', body([a, b]), a.token)).status).toBe(200);
  });

  test('"shiny" sólo vale si es true; lo demás es false', async () => {
    const [a, b] = [mkUser(), mkUser()];
    const r = await arena([a, b], { places: [{ uid: a.uid, place: 1, wave: 3, dex: 1, shiny: 'si' }, { uid: b.uid, place: 2, wave: 2, dex: 2, shiny: true }] });
    expect(r.status).toBe(200);
    expect((srv.db.raw.query('SELECT shiny FROM arena_places WHERE user_id = ? AND game_id = ?').get(a.id, r.j.id) as any).shiny).toBe(0);
    expect((srv.db.raw.query('SELECT shiny FROM arena_places WHERE user_id = ? AND game_id = ?').get(b.id, r.j.id) as any).shiny).toBe(1);
  });

  test('los nombres salen de la base de datos, no de lo que mande el cliente', async () => {
    const [a, b] = [mkUser(), mkUser()];
    const r = await arena([a, b], { places: [{ uid: a.uid, name: 'Falso', place: 1, wave: 3, dex: 1 }, { uid: b.uid, name: 'Otro', place: 2, wave: 2, dex: 2 }] });
    expect(r.status).toBe(200);
    const t = (await topArena(a)).j;
    expect(t.rows.find((x: any) => x.uid === a.uid).name).toBe(a.name);
    expect(t.rows.find((x: any) => x.uid === b.uid).name).toBe(b.name);
  });

  test('cuentas marcadas: el anfitrión marcado no sube (403); otro jugador marcado se omite sin tumbar la partida', async () => {
    const [a, b, c, d] = [mkUser(), mkUser(), mkUser(), mkUser()];
    markAccount(srv.db, a.id);
    await begin(a, [a, b]);
    expect((await call('POST', '/arena', body([a, b]), a.token)).status).toBe(403);
    expect(count('arena_games', 'host = ?', a.id)).toBe(0);

    markAccount(srv.db, c.id);
    const r = await arena([c, d, b], {}, d);                      // C (marcada) queda 1.ª, D es el anfitrión
    expect(r.status).toBe(200);
    expect(r.j.counted).toBe(2);
    expect(count('arena_places', 'user_id = ?', c.id)).toBe(0);
    // Los puestos de los demás se quedan como estaban: D fue 2.º, no gana.
    const t = (await topArena(d)).j;
    expect(t.rows.find((x: any) => x.uid === d.uid)).toMatchObject({ wins: 0, podiums: 1, games: 1 });
    expect(t.rows.some((x: any) => x.uid === c.uid)).toBe(false);
    expect((await topArena(c)).j.mine).toBeNull();
  });

  test('un cuerpo enorme se rechaza', async () => {
    const [a, b] = [mkUser(), mkUser()];
    await begin(a, [a, b]);
    expect((await call('POST', '/arena', { ...body([a, b]), basura: 'x'.repeat(5000) }, a.token)).status).toBe(413);
  });
});

describe('el top', () => {
  // Un servidor aparte: el top 50 compartido lo llenan las demás pruebas.
  let principal: { srv: typeof srv; base: string };
  beforeAll(() => {
    principal = { srv, base };
    srv = startServer({ port: 0, dbPath: ':memory:', dist: '.', loginLimit: 1000 });
    base = `http://127.0.0.1:${srv.server.port}`;
  });
  afterAll(() => { srv.stop(); srv = principal.srv; base = principal.base; });

  const U_: Record<string, U> = {};
  const names = ['Ana', 'Beto', 'Zeta', 'Alfa', 'Dani', 'Xavi', 'Yago', 'Zoe', 'Wanda', 'Fer'];

  test('orden por victorias, podios, partidas (menos es mejor) y nombre; con el recuento de cada una', async () => {
    for (const nm of names) U_[nm] = mkUser(nm);
    const { Ana, Beto, Zeta, Alfa, Dani, Xavi, Yago, Zoe, Wanda, Fer } = U_;
    // Ana: 2 victorias, 3 podios, 3 partidas · Beto: 1 victoria, 3 podios, 3 partidas
    await arena([Ana, Beto]);
    await arena([Ana, Beto]);
    await arena([Beto, Ana]);
    // Zeta y Alfa: 1 victoria, 1 podio, 1 partida (empate total: el nombre decide, Alfa antes)
    await arena([Zeta, Dani]);
    await arena([Alfa, Fer]);
    // Xavi: 1 victoria, 1 podio, 2 partidas (cae tras los anteriores por jugar más) · Yago: 1 victoria, 2 podios, 2 partidas
    await arena([Xavi, Yago]);
    await arena([Yago, Zoe, Wanda, Xavi]);
    const t = (await topArena(Ana)).j;
    expect(t.ok).toBe(true);
    const fila = (nm: string) => t.rows.find((r: any) => r.name === nm);
    expect(['Ana', 'Beto', 'Yago', 'Alfa', 'Zeta', 'Xavi'].map(x => t.rows.findIndex((r: any) => r.name === x))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fila('Ana')).toMatchObject({ uid: Ana.uid, wins: 2, podiums: 3, games: 3 });
    expect(fila('Beto')).toMatchObject({ wins: 1, podiums: 3, games: 3 });
    expect(fila('Yago')).toMatchObject({ wins: 1, podiums: 2, games: 2 });
    expect(fila('Xavi')).toMatchObject({ wins: 1, podiums: 1, games: 2 });
    // Los de 0 victorias, detrás: más podios primero (Zoe y Wanda: 1 podio... Dani, Fer: 1 podio)
    const sinVictoria = t.rows.filter((r: any) => r.wins === 0);
    expect(sinVictoria.map((r: any) => r.name)).toEqual(['Dani', 'Fer', 'Wanda', 'Zoe']);   // mismos números: por nombre
    expect(t.rows.length).toBe(10);
  });

  test('cada cuenta lleva el Pokémon de su última partida (y si era shiny)', async () => {
    const { Ana, Beto } = U_;
    // En `arena()` el primero de la lista usa el 25 y el segundo el 26: la última de Ana la jugó 2.ª (26), la de Beto 1.º (25).
    const t = (await topArena(Ana)).j;
    expect(t.rows.find((r: any) => r.name === 'Ana')).toMatchObject({ dex: 26, shiny: false });
    expect(t.rows.find((r: any) => r.name === 'Beto')).toMatchObject({ dex: 25 });
    // Una partida nueva de Ana con otro Pokémon shiny cambia su icono.
    await arena([Ana, Beto], { places: [{ uid: Ana.uid, place: 1, wave: 5, dex: 150, shiny: true }, { uid: Beto.uid, place: 2, wave: 4, dex: 151, shiny: false }] });
    const t2 = (await topArena(Ana)).j;
    expect(t2.rows.find((r: any) => r.name === 'Ana')).toMatchObject({ dex: 150, shiny: true, wins: 3, games: 4 });
    expect(t2.rows.find((r: any) => r.name === 'Beto')).toMatchObject({ dex: 151, wins: 1, games: 4 });
  });

  test('periodo: hoy, semana, mes e histórico usan las fronteras del ranking', async () => {
    const [a, b] = [mkUser('PeriodoA'), mkUser('PeriodoB')];
    const vieja = await arena([a, b]);                             // la ganó A
    const ids = periodIds();
    // La movemos: otra semana pero el mismo mes, y luego otro mes.
    srv.db.raw.run('UPDATE arena_games SET pd = ?, pw = ? WHERE id = ?', ['d20000101', 'w2000-01', vieja.j.id]);
    const delPeriodo = async (u: U, p: string) => (await topArena(u, p)).j.rows.filter((r: any) => r.name.startsWith('Periodo')).map((r: any) => r.name);
    expect(await delPeriodo(a, 'd')).toEqual([]);
    expect(await delPeriodo(a, 'w')).toEqual([]);
    expect(await delPeriodo(a, 'm')).toEqual(['PeriodoA', 'PeriodoB']);              // el mes sigue siendo el de hoy
    expect(await delPeriodo(a, 'a')).toEqual(['PeriodoA', 'PeriodoB']);
    srv.db.raw.run('UPDATE arena_games SET pm = ? WHERE id = ?', ['m200001', vieja.j.id]);
    expect(await delPeriodo(a, 'm')).toEqual([]);
    expect(await delPeriodo(a, 'a')).toEqual(['PeriodoA', 'PeriodoB']);              // el histórico no olvida
    // Una de hoy: B gana y sólo cuenta en hoy, semana, mes; en el histórico se suma a lo anterior.
    await arena([b, a]);
    for (const p of ['d', 'w', 'm']) {
      const rs = (await topArena(a, p)).j.rows.filter((r: any) => r.name.startsWith('Periodo'));
      expect([p, rs.map((r: any) => [r.name, r.wins, r.games])]).toEqual([p, [['PeriodoB', 1, 1], ['PeriodoA', 0, 1]]]);
    }
    const hist = (await topArena(a, 'a')).j.rows.filter((r: any) => r.name.startsWith('Periodo'));
    expect(hist.map((r: any) => [r.name, r.wins, r.games])).toEqual([['PeriodoA', 1, 2], ['PeriodoB', 1, 2]]);
    // Tu fila también es del periodo: A no tiene nada hoy... sí, perdió la de hoy.
    expect((await topArena(a, 'd')).j.mine).toMatchObject({ wins: 0, games: 1 });
    expect(ids.a).toBe('all2');
    // Un periodo que no existe
    expect((await topArena(a, 'y')).status).toBe(400);
    expect((await call('GET', '/arena/top', undefined, a.token)).status).toBe(400);
  });

  test('sólo amigos: tú y las cuentas de `circle`; con la lista vacía, sólo tú', async () => {
    const [a, b, c] = [mkUser('CircA'), mkUser('CircB'), mkUser('CircC')];
    await arena([a, b, c]);
    const solo = async (extra: string) => (await topArena(a, 'a', extra)).j.rows.filter((r: any) => r.name.startsWith('Circ')).map((r: any) => r.name);
    expect(await solo('&circle=' + b.uid)).toEqual(['CircA', 'CircB']);
    expect(await solo('&circle=' + b.uid + ',' + c.uid + ',basura,0')).toEqual(['CircA', 'CircB', 'CircC']);
    expect(await solo('&circle=,')).toEqual(['CircA']);
    // Tu puesto sigue siendo el global.
    const j = (await topArena(c, 'a', '&circle=,')).j;
    expect(j.rows.map((r: any) => r.name)).toEqual(['CircC']);
    expect(j.mine.pos).toBe((await topArena(c, 'a')).j.rows.findIndex((r: any) => r.name === 'CircC') + 1);
  });

  test('una cuenta borrada desaparece del top y de sus partidas; la partida sin nadie se borra sola', async () => {
    const reg = async (name: string) => {
      const r = await send(base + '/api/register', { method: 'POST', body: JSON.stringify({ name, pass: 'secreta1' }) });
      const j: any = await r.json();
      expect(r.status).toBe(200);
      return { id: +j.uid, uid: j.uid as string, name, token: j.token as string } as U;
    };
    const suf = Math.random().toString(36).slice(2, 6);
    const yo = await reg('Borra' + suf), otra = mkUser('Queda' + suf);
    const g1 = await arena([yo, otra]);                           // yo gano
    expect((await topArena(otra)).j.rows.find((r: any) => r.uid === yo.uid)).toMatchObject({ wins: 1, games: 1 });
    expect(count('arena_games', 'id = ?', g1.j.id)).toBe(1);

    const d = await send(base + '/api/account', { method: 'DELETE', headers: { Authorization: 'Bearer ' + yo.token }, body: JSON.stringify({ pass: 'secreta1' }) });
    expect(d.status).toBe(200);
    expect(count('arena_places', 'user_id = ?', yo.id)).toBe(0);
    expect((await topArena(otra)).j.rows.some((r: any) => r.uid === yo.uid)).toBe(false);
    expect((await topArena(otra)).j.rows.find((r: any) => r.uid === otra.uid)).toMatchObject({ wins: 0, podiums: 1, games: 1 });   // lo ajeno sigue
    expect(count('arena_games', 'id = ?', g1.j.id)).toBe(1);      // queda otra con una fila

    // Borra a la última: la partida entera se va.
    srv.db.deleteUser(otra.id);
    expect(count('arena_games', 'id = ?', g1.j.id)).toBe(0);
    // El anfitrión borrado no se lleva la partida de los demás.
    const [h, x] = [mkUser(), mkUser()];
    const g3 = await arena([x, h], {}, h);
    srv.db.deleteUser(h.id);
    expect(count('arena_games', 'id = ?', g3.j.id)).toBe(1);
    expect((srv.db.raw.query('SELECT host FROM arena_games WHERE id = ?').get(g3.j.id) as any).host).toBeNull();
    expect(count('arena_places', 'game_id = ?', g3.j.id)).toBe(1);
  });

  test('tu fila y puesto exactos aunque no salgas en el top 50', async () => {
    const { Ana, Fer } = U_;
    const t = (await topArena(Ana)).j;
    expect(t.mine).toMatchObject({ uid: Ana.uid, pos: 1, wins: 3 });
    const f = (await topArena(Fer)).j;
    expect(f.mine.pos).toBe(f.rows.findIndex((r: any) => r.uid === Fer.uid) + 1);
    // 60 cuentas más que ganan una vez cada una, y la última (Rezagada) sólo ha jugado y perdido.
    const muchos = Array.from({ length: 60 }, () => mkUser());
    for (const u of muchos) await arena([u, mkUser()]);
    const rez = mkUser('Rezagada');
    await arena([muchos[0], rez]);
    const r = (await topArena(rez)).j;
    expect(r.rows.length).toBe(50);
    expect(r.rows.some((x: any) => x.uid === rez.uid)).toBe(false);
    expect(r.mine).toMatchObject({ uid: rez.uid, wins: 0, podiums: 1, games: 1 });
    // Su puesto es el de verdad: delante hay todas las cuentas con más victorias o iguales a 0 con más podios, etc.
    const delante = (srv.db.raw.query(`
      WITH a AS (SELECT user_id, SUM(place = 1) w, SUM(place <= 3) p, COUNT(*) g FROM arena_places GROUP BY user_id)
      SELECT COUNT(*) AS n FROM a JOIN users u ON u.id = a.user_id
      WHERE w > 0 OR (w = 0 AND (p > 1 OR (p = 1 AND (g < 1 OR (g = 1 AND u.name COLLATE NOCASE < 'Rezagada')))))`).get() as { n: number }).n;
    expect(r.mine.pos).toBe(delante + 1);
    // Y quien no ha jugado, nada.
    expect((await topArena(mkUser())).j.mine).toBeNull();
  });
});

/** Módulos sueltos (ranking + arena) con reloj y verificación controlados. */
function harness(o: ArenaOptions) {
  const db = openDb(':memory:');
  createRanking(db, { now: o.now, verifyTeam: o.verifyTeam });
  const arena = createArena(db, o);
  const call = async (user: ReturnType<typeof db.userById>, method: string, path: string, data?: unknown) => {
    const req = new Request('http://x/api' + path, { method, body: data === undefined ? undefined : JSON.stringify(data) });
    const res = await arena(req, { ip: '1', user: user!, path: path.split('?')[0], method });
    if (!res) return { status: 0, j: null as any };
    return { status: res.status, j: (await res.json()) as any };
  };
  const run = (id: number, started: number, mode = 'a') => db.raw.run('INSERT OR REPLACE INTO ranking_runs (user_id, started, mode) VALUES (?, ?, ?)', [id, started, mode]);
  return { db, run, call, user(name: string) { const id = db.addUser(name, name.toLowerCase(), 'x'); return db.userById(id)!; } };
}
const places = (...us: { id: number }[]) => us.map((u, i) => ({ uid: String(u.id), place: i + 1, wave: 5, dex: 25, shiny: false }));

describe('con reloj controlado (módulo suelto)', () => {
  test('el tiempo de juego puede ser el doble del real (×2), no más: tolerancia de 30 s como en la Defensa', async () => {
    let now = 1_000_000_000_000;
    const h = harness({ now: () => now });
    const [a, b] = [h.user('Ana'), h.user('Beto')];
    const sube = (secs: number) => h.call(a, 'POST', '/ranking/arena', { map: 'valle', waves: 3, secs, places: places(a, b) });
    h.run(a.id, now);
    now += 100_000;                                                // han pasado 100 s reales: hasta 2·(100+30) = 260 s de juego
    expect((await sube(261)).status).toBe(400);
    expect((await sube(261)).j.error).toMatch(/imposible/i);
    expect((await sube(260)).status).toBe(200);
  });

  test('el reloj atrasado no deja subir', async () => {
    let now = 1_000_000_000_000;
    const h = harness({ now: () => now });
    const [a, b] = [h.user('Ana'), h.user('Beto')];
    h.run(a.id, now);
    now -= 3_600_000;
    expect((await h.call(a, 'POST', '/ranking/arena', { map: 'valle', waves: 3, secs: 100, places: places(a, b) })).status).toBe(400);
  });

  test('verifyTeam recibe el anfitrión, los uids ordenados y la hora de su aviso', async () => {
    const vistos: [number, number[], number | null][] = [];
    const h = harness({ verifyTeam: (host, ms, at) => { vistos.push([host, ms, at]); return true; } });
    const [a, b, c] = [h.user('Ana'), h.user('Beto'), h.user('Cris')];
    const data = { map: 'valle', waves: 1, secs: 1, places: places(c, a, b) };
    expect((await h.call(a, 'POST', '/ranking/arena', data)).status).toBe(409);
    expect(vistos).toEqual([]);                                    // sin aviso ni se mira la sala
    h.run(a.id, 0);
    expect((await h.call(a, 'POST', '/ranking/arena', data)).status).toBe(200);
    expect(vistos).toEqual([[a.id, [a.id, b.id, c.id], 0]]);
  });

  test('verifyTeam que dice que no: 403 aunque el resto sea legal', async () => {
    const h = harness({ verifyTeam: () => false, now: () => 5_000_000 });
    const [a, b] = [h.user('Ana'), h.user('Beto')];
    h.run(a.id, 0);
    expect((await h.call(a, 'POST', '/ranking/arena', { map: 'valle', waves: 1, secs: 1, places: places(a, b) })).status).toBe(403);
  });

  test('el periodo de la partida es el de la hora a la que se sube (medianoche de Madrid)', async () => {
    let now = Date.parse('2026-10-12T21:59:30Z');                  // 23:59:30 del lunes 12 en Madrid
    const h = harness({ now: () => now });
    const [a, b] = [h.user('Ana'), h.user('Beto')];
    const sube = () => h.call(a, 'POST', '/ranking/arena', { map: 'valle', waves: 1, secs: 20, places: places(a, b) });
    h.run(a.id, now); now += 60_000;                               // ya es el martes 13
    expect((await sube()).status).toBe(200);
    const g = h.db.raw.query('SELECT pd, pw, pm FROM arena_games').get() as any;
    expect(g).toEqual({ pd: 'd20261013', pw: 'w2026-42', pm: 'm202610' });
    const hoy = await h.call(a, 'GET', '/ranking/arena/top?period=d');
    expect(hoy.j.rows.map((r: any) => r.name)).toEqual(['Ana', 'Beto']);
    now = Date.parse('2026-10-14T10:00:00Z');                      // al día siguiente: hoy vacío, semana igual
    expect((await h.call(a, 'GET', '/ranking/arena/top?period=d')).j.rows).toEqual([]);
    expect((await h.call(a, 'GET', '/ranking/arena/top?period=w')).j.rows.length).toBe(2);
    now = Date.parse('2026-10-26T10:00:00Z');                      // otra semana, mismo mes
    expect((await h.call(a, 'GET', '/ranking/arena/top?period=w')).j.rows).toEqual([]);
    expect((await h.call(a, 'GET', '/ranking/arena/top?period=m')).j.rows.length).toBe(2);
    now = Date.parse('2026-11-02T10:00:00Z');
    expect((await h.call(a, 'GET', '/ranking/arena/top?period=m')).j.rows).toEqual([]);
    expect((await h.call(a, 'GET', '/ranking/arena/top?period=a')).j.rows.length).toBe(2);
  });

  test('no responde a rutas que no son suyas y crearlo dos veces sobre la misma base no falla', async () => {
    const h = harness({});
    const a = h.user('Ana');
    expect((await h.call(a, 'GET', '/ranking/top?mode=s&period=a')).status).toBe(0);
    expect((await h.call(a, 'DELETE', '/ranking/arena')).status).toBe(405);
    createArena(h.db);
    createArena(h.db);
  });
});

describe('/start admite la Arena y /submit no', () => {
  test('mode "a" en /start vale; en /submit y /top del ranking normal, no', async () => {
    const u = mkUser();
    expect((await call('POST', '/start', { mode: 'a' }, u.token)).status).toBe(200);
    expect(count('ranking_runs', "user_id = ? AND mode = 'a'", u.id)).toBe(1);
    expect((await call('POST', '/start', { mode: 'z' }, u.token)).status).toBe(400);
    expect((await call('POST', '/submit', { mode: 'a', t: 100, lv: 3, kills: 3, dex: 1 }, u.token)).status).toBe(400);
    expect((await call('GET', '/top?mode=a&period=a', undefined, u.token)).status).toBe(400);
    expect((await call('GET', '/rank?mode=a&period=a', undefined, u.token)).status).toBe(400);
  });
});
