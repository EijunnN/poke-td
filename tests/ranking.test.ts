/* ============ ranking.test.ts — pruebas adversariales del ranking ============
 * Contra un servidor de verdad con la base en memoria: lo que intentaría un
 * tramposo (tiempos imposibles, subir sin avisar, equipos falsos, marcas peores
 * que pisan las buenas, rutas de admin, inyección) o un cliente roto, más el
 * orden del top, los puestos, los reportes, la moderación y el borrado de cuentas.
 *
 *   bun test tests/ranking.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { startServer } from './helpers';
import { openDb } from '../server/db';
import { sha256 } from '../server/http';
import { createRanking, periodIds, type RankingOptions } from '../server/ranking';
import { LAST_WAVE, MAX_WAVE, maxDefenseKills, minDefenseTime } from '../src/modes/td-waves';

// Las cuentas de moderación se leen de la variable de entorno al crear el servidor.
process.env.ADMIN_USERS = ' Moderadora , OTROADMIN,';
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
  const res = await send(base + '/api/ranking' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: method === 'GET' ? undefined : raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  let j: any = null;
  try { j = await res.json(); } catch { /* no es JSON */ }
  return { status: res.status, j };
}

interface U { id: number; uid: string; name: string; token: string }
let n = 0;
/** Cuenta nueva con sesión, sin pasar por argon2 (es lo que no se prueba aquí). */
function mkUser(name = 'Jug' + (++n) + Math.random().toString(36).slice(2, 6), s = srv): U {
  const id = s.db.addUser(name, name.toLowerCase(), 'x');
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(30))).toString('base64url');
  s.db.addSession(sha256(token), id);
  return { id, uid: String(id), name, token };
}

/** Corre `fn` contra un servidor limpio (el de las demás pruebas queda como estaba). */
async function aparte<T>(fn: () => Promise<T>): Promise<T> {
  const previo = { srv, base, moderadora };
  srv = startServer({ port: 0, dbPath: ':memory:', dist: '.', loginLimit: 1000 });
  base = `http://127.0.0.1:${srv.server.port}`;
  moderadora = null;
  try { return await fn(); }
  finally { srv.stop(); ({ srv, base, moderadora } = previo); }
}

/** Avisa de que empieza una partida que lleva `age` segundos en marcha. */
async function begin(u: U, mode: 's' | 'g' | 'd' | 'e' = 's', age = 0, s = srv, equipo?: U[]) {
  const r = await call('POST', '/start', { mode }, u.token);
  expect(r.status).toBe(200);
  s.db.raw.run('UPDATE ranking_runs SET started = ? WHERE user_id = ?', [Date.now() - age * 1000, u.id]);
  if (equipo) seedTeam(u, equipo, age, s);
}
/**
 * La sala del anfitrión apunta el equipo real cuando manda `start` (server/realtime.ts) y el
 * ranking sólo acepta ese equipo (verifyTeam). Aquí se apunta a mano, un poco antes del /start.
 */
function seedTeam(host: U, equipo: U[], age = 0, s = srv) {
  const ids = [...new Set([host.id, ...equipo.map(m => m.id)])].sort((a, b) => a - b);
  s.db.raw.run('INSERT OR REPLACE INTO group_starts (host_id, team, started) VALUES (?, ?, ?)', [host.id, JSON.stringify(ids), Date.now() - age * 1000 - 1000]);
}

const mark = (t: number, over: Record<string, unknown> = {}) => ({ mode: 's', t, lv: 5, kills: 100, dex: 25, shiny: false, ...over });
/** Partida en solitario completa: aviso (con `age` s de antigüedad) y subida. */
async function solo(u: U, t: number, over: Record<string, unknown> = {}, age = t + 5) {
  await begin(u, 's', age);
  return call('POST', '/submit', mark(t, over), u.token);
}
async function team(host: U, members: U[], t: number, over: Record<string, unknown> = {}, age = t + 5) {
  await begin(host, 'g', age, srv, members);
  return call('POST', '/submit', {
    mode: 'g', t, lv: 5, kills: 100,
    members: members.map((m, i) => ({ uid: m.uid, dex: 25 + i, shiny: false })), ...over,
  }, host.token);
}

const top = (u: U, mode = 's', period = 'a', extra = '') => call('GET', `/top?mode=${mode}&period=${period}${extra}`, undefined, u.token);
const rank = (u: U, mode = 's', period = 'a', extra = '') => call('GET', `/rank?mode=${mode}&period=${period}${extra}`, undefined, u.token);
const rows = async (u: U, mode = 's', period = 'a', extra = '') => (await top(u, mode, period, extra)).j.rows as any[];
/** Tu marca en una tabla (el puesto exacto no depende de salir en el top 50). */
const mine = async (u: U, mode = 's', period = 'a', extra = ''): Promise<any> => (await rank(u, mode, period, extra)).j.rank?.row;
const count = (table: string, where = '1', ...args: unknown[]) =>
  (srv.db.raw.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...(args as any)) as { n: number }).n;

/** Marcas sin ningún miembro: no debería haber nunca. */
const huerfanas = () => count('ranking_entries',
  'NOT EXISTS (SELECT 1 FROM ranking_members m WHERE m.board = ranking_entries.board AND m.id = ranking_entries.id)');

describe('periodos (hora de Madrid)', () => {
  test.each([
    ['2026-10-13T12:00:00Z', { d: 'd20261013', w: 'w2026-42', m: 'm202610', a: 'all2' }],
    // 22:30 UTC del 12 en octubre ya es el 13 en Madrid (UTC+2)
    ['2026-10-12T22:30:00Z', { d: 'd20261013', w: 'w2026-42', m: 'm202610', a: 'all2' }],
    ['2026-10-12T21:59:59Z', { d: 'd20261012', w: 'w2026-42', m: 'm202610', a: 'all2' }],
    // fin del horario de verano (25-oct-2026, 03:00 -> 02:00): 23:30 UTC ya es el 26 (UTC+1)
    ['2026-10-25T23:30:00Z', { d: 'd20261026', w: 'w2026-44', m: 'm202610', a: 'all2' }],
    // 2026 tiene 53 semanas: el 1 y el 3 de enero de 2027 siguen en la 53 de 2026
    ['2026-12-31T12:00:00Z', { d: 'd20261231', w: 'w2026-53', m: 'm202612', a: 'all2' }],
    ['2027-01-03T12:00:00Z', { d: 'd20270103', w: 'w2026-53', m: 'm202701', a: 'all2' }],
    ['2027-01-04T12:00:00Z', { d: 'd20270104', w: 'w2027-01', m: 'm202701', a: 'all2' }],
    // 31 dic 23:30 UTC ya es 1 ene en Madrid
    ['2026-12-31T23:30:00Z', { d: 'd20270101', w: 'w2026-53', m: 'm202701', a: 'all2' }],
    // 29-dic-2025 (lunes) abre la semana 1 de 2026
    ['2025-12-29T12:00:00Z', { d: 'd20251229', w: 'w2026-01', m: 'm202512', a: 'all2' }],
  ])('%s', (iso, want) => {
    expect(periodIds(new Date(iso))).toEqual(want);
  });
});

describe('sesión y forma de las peticiones', () => {
  test('sin sesión o con un token falso: 401 en todas las rutas', async () => {
    const rutas: [string, string][] = [
      ['POST', '/start'], ['POST', '/submit'], ['GET', '/top?mode=s&period=a'], ['GET', '/rank?mode=s&period=a'],
      ['POST', '/report'], ['DELETE', '/mine'], ['GET', '/admin'], ['GET', '/admin/reports'], ['POST', '/admin/purge'],
    ];
    for (const [m, p] of rutas) {
      expect((await call(m, p, {})).status).toBe(401);
      expect((await call(m, p, {}, 'a'.repeat(43))).status).toBe(401);
      expect((await call(m, p, {}, "x' OR '1'='1")).status).toBe(401);
    }
  });

  test('rutas que no existen o con otro método: 404, y no se traga las de otros módulos', async () => {
    const u = mkUser();
    expect((await call('GET', '/zzz', undefined, u.token)).status).toBe(404);
    expect((await call('GET', '/submit', undefined, u.token)).status).toBe(404);
    expect((await call('PUT', '/start', {}, u.token)).status).toBe(404);
    expect((await call('GET', '/admin/nada', undefined, u.token)).status).toBe(403);   // no admin: ni se entera de qué existe
    const me = await send(base + '/api/me', { headers: { Authorization: 'Bearer ' + u.token } });
    expect(me.status).toBe(200);
  });

  test('cuerpos rotos: no JSON, array, enorme, vacío', async () => {
    const u = mkUser();
    for (const p of ['/start', '/submit', '/report']) {
      expect((await call('POST', p, undefined, u.token, 'no es json')).status).toBe(400);
      expect((await call('POST', p, undefined, u.token, '[1,2]')).status).toBe(400);
      expect((await call('POST', p, undefined, u.token, 'null')).status).toBe(400);
      expect((await call('POST', p, undefined, u.token, '')).status).toBe(400);
      expect((await call('POST', p, undefined, u.token, JSON.stringify({ a: 'x'.repeat(10_000) }))).status).toBe(413);
    }
  });

  test('/start: sólo los modos s, g y d', async () => {
    const u = mkUser();
    for (const mode of [undefined, null, 'x', 'S', 1, ['s'], { a: 1 }, "s' OR 1=1"]) {
      expect((await call('POST', '/start', { mode }, u.token)).status).toBe(400);
    }
    expect(count('ranking_runs', 'user_id = ?', u.id)).toBe(0);
  });
});

describe('anti-trampas: el tiempo', () => {
  test('subir sin avisar de que empieza la partida', async () => {
    const u = mkUser();
    const r = await call('POST', '/submit', mark(120), u.token);
    expect(r.status).toBe(409);
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(0);
  });

  test('un tiempo mayor que lo transcurrido desde /start (+30 s) se rechaza; uno justo, no', async () => {
    const u = mkUser();
    await begin(u, 's', 100);
    for (const t of [131, 140, 200, 3600]) {
      const r = await call('POST', '/submit', mark(t), u.token);
      expect(r.status).toBe(400);
    }
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(0);
    // Los rechazos no gastan la partida: el jugador honesto aún puede subir la suya.
    const ok = await call('POST', '/submit', mark(125), u.token);
    expect(ok.status).toBe(200);
    expect((await mine(u)).t).toBe(125);
  });

  test('/start recién llamado: no cabe una marca de 60 s', async () => {
    const u = mkUser();
    await call('POST', '/start', { mode: 's' }, u.token);          // sin envejecerla
    expect((await call('POST', '/submit', mark(60), u.token)).status).toBe(400);
    expect((await call('POST', '/submit', mark(100), u.token)).status).toBe(400);
  });

  test('valores que no son un tiempo posible', async () => {
    const u = mkUser();
    await begin(u, 's', 5000);
    const malos: unknown[] = [0, -1, -60, 59, 3601, 99999, 1e9, 1e308, 60.5, 100.0000001, '120', '120abc', 'NaN', 'Infinity',
      null, undefined, true, false, [120], { t: 120 }, '', Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER];
    for (const t of malos) {
      const r = await call('POST', '/submit', mark(t as number), u.token);
      expect(r.status).toBe(400);
    }
    // JSON a mano: NaN no es JSON; 1e999 se lee como Infinity.
    for (const rawT of ['NaN', 'Infinity', '-Infinity', '1e999', '-1e999', '0x78', '1_20']) {
      const r = await call('POST', '/submit', undefined, u.token, `{"mode":"s","t":${rawT},"lv":5,"kills":100,"dex":25}`);
      expect(r.status).toBe(400);
    }
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(0);
    expect(count('ranking_runs', 'user_id = ?', u.id)).toBe(1);        // seguía sin gastar
  });

  test('el tope de 1 h aunque haya pasado más tiempo', async () => {
    const u = mkUser();
    await begin(u, 's', 7200);
    expect((await call('POST', '/submit', mark(3601), u.token)).status).toBe(400);
    expect((await call('POST', '/submit', mark(3600, { lv: 900, kills: 40000 }), u.token)).status).toBe(200);
  });

  test('una partida, una subida: la segunda sin /start nuevo se rechaza', async () => {
    const u = mkUser();
    expect((await solo(u, 100)).status).toBe(200);
    expect((await call('POST', '/submit', mark(100), u.token)).status).toBe(409);
    expect((await call('POST', '/submit', mark(3000), u.token)).status).toBe(409);
  });

  test('diez subidas a la vez con una sola partida: pasa una', async () => {
    const u = mkUser();
    await begin(u, 's', 1000);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => call('POST', '/submit', mark(100 + i), u.token)));
    expect(rs.filter(r => r.status === 200).length).toBe(1);
    expect(rs.filter(r => r.status === 409).length).toBe(9);
  });

  test('el modo de la subida tiene que ser el de /start', async () => {
    const u = mkUser(), v = mkUser();
    await begin(u, 'g', 500);
    expect((await call('POST', '/submit', mark(100), u.token)).status).toBe(409);
    await begin(u, 's', 500, srv, [u, v]);
    const r = await call('POST', '/submit', { mode: 'g', t: 100, lv: 5, kills: 10, members: [{ uid: u.uid, dex: 1 }, { uid: v.uid, dex: 2 }] }, u.token);
    expect(r.status).toBe(409);
  });

  test('la hora la pone el servidor: el cliente no puede mandar su propia hora de inicio', async () => {
    const u = mkUser();
    await call('POST', '/start', { mode: 's', startedAt: 1, started: 1, t: 0, at: 1 }, u.token);
    const r = await call('POST', '/submit', mark(600, { startedAt: 1, started: 1, now: 99999999999999 }), u.token);
    expect(r.status).toBe(400);
  });

  test('un /start nuevo reinicia la cuenta atrás (no se acumula la antigüedad de la anterior)', async () => {
    const u = mkUser();
    await begin(u, 's', 3000);
    await call('POST', '/start', { mode: 's' }, u.token);                  // la hora vuelve a ser ahora
    expect((await call('POST', '/submit', mark(1000), u.token)).status).toBe(400);
  });
});

describe('anti-trampas: nivel, derrotados y Pokémon', () => {
  test.each([
    ['nivel 0', { lv: 0 }], ['nivel negativo', { lv: -5 }], ['nivel decimal', { lv: 5.5 }], ['nivel texto', { lv: '5' }],
    ['nivel imposible para 100 s (> 10 + t/4)', { lv: 36 }], ['nivel enorme', { lv: 1e9 }], ['nivel nulo', { lv: null }],
    ['derrotados negativos', { kills: -1 }], ['derrotados decimales', { kills: 1.5 }], ['derrotados texto', { kills: '10' }],
    ['derrotados imposibles (> 100 + 12·t)', { kills: 1301 }], ['derrotados enormes', { kills: 1e12 }], ['sin derrotados', { kills: undefined }],
    ['Pokémon 0', { dex: 0 }], ['Pokémon negativo', { dex: -1 }], ['Pokémon fuera de rango', { dex: 99999 }], ['Pokémon decimal', { dex: 1.5 }],
    ['Pokémon texto', { dex: 'pikachu' }], ['Pokémon inyección', { dex: "1; DROP TABLE ranking_entries" }], ['sin Pokémon', { dex: undefined }],
    ['modo roto', { mode: 'x' }], ['sin modo', { mode: undefined }],
  ])('%s', async (_, over) => {
    const u = mkUser();
    await begin(u, 's', 1000);
    const r = await call('POST', '/submit', mark(100, over), u.token);
    expect(r.status).toBe(400);
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(0);
  });

  test('los límites exactos sí valen', async () => {
    const u = mkUser();
    await begin(u, 's', 1000);
    // t=100: nivel hasta 35, derrotados hasta 1300; dex 1..2000
    const r = await call('POST', '/submit', mark(100, { lv: 35, kills: 1300, dex: 2000 }), u.token);
    expect(r.status).toBe(200);
    expect(await mine(u)).toMatchObject({ t: 100, lv: 35, kills: 1300, dex: [2000] });
  });

  test('el shiny que no es booleano true cuenta como no shiny', async () => {
    const u = mkUser();
    await solo(u, 100, { shiny: 'true' });
    expect((await mine(u)).shiny).toEqual([false]);
  });
});

describe('marcas: sólo mejoran', () => {
  test('una marca peor o igual no pisa la buena; una mejor sí', async () => {
    const u = mkUser();
    const a = await solo(u, 200, { lv: 20, kills: 500 });
    expect(a.j.better).toEqual(['d', 'w', 'm', 'a']);
    const peor = await solo(u, 150, { lv: 30, kills: 1800 });
    expect(peor.status).toBe(200);
    expect(peor.j.better).toEqual([]);
    const igual = await solo(u, 200, { lv: 34, kills: 2000 });
    expect(igual.j.better).toEqual([]);
    for (const p of ['d', 'w', 'm', 'a']) {
      expect(await mine(u, 's', p)).toMatchObject({ t: 200, lv: 20, kills: 500 });
    }
    const mejor = await solo(u, 250, { lv: 7, kills: 9 });
    expect(mejor.j.better).toEqual(['d', 'w', 'm', 'a']);
    expect(await mine(u)).toMatchObject({ t: 250, lv: 7, kills: 9 });
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(5);         // d, w, m, a, a_p25
  });

  test('una marca solo mejora en la tabla de otro Pokémon: no anuncia nada y no toca el resto', async () => {
    const u = mkUser();
    await solo(u, 200, { dex: 25 });
    const r = await solo(u, 150, { dex: 4 });
    expect(r.j.better).toEqual([]);
    expect(await mine(u, 's', 'a', '&dex=4')).toMatchObject({ t: 150, dex: [4] });
    expect(await mine(u, 's', 'a', '&dex=25')).toMatchObject({ t: 200, dex: [25] });
    expect(await mine(u)).toMatchObject({ t: 200, dex: [25] });
  });

  test('el Pokémon de una marca cambia con ella (mejor marca, otro Pokémon)', async () => {
    const u = mkUser();
    await solo(u, 100, { dex: 25 });
    await solo(u, 200, { dex: 6, shiny: true });
    expect(await mine(u)).toMatchObject({ t: 200, dex: [6], shiny: [true] });
  });

  test('no se puede subir la marca de otro: el uid del cuerpo no cuenta', async () => {
    const u = mkUser(), victima = mkUser();
    await begin(u, 's', 1000);
    const r = await call('POST', '/submit', mark(300, { uid: victima.uid, id: victima.uid, uids: [victima.uid], names: ['x'], user: victima.uid }), u.token);
    expect(r.status).toBe(200);
    expect(count('ranking_entries', 'id = ?', victima.uid)).toBe(0);
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(5);
  });

  test('las partidas de menos de 60 s no se suben', async () => {
    const u = mkUser();
    await begin(u, 's', 1000);
    expect((await call('POST', '/submit', mark(59), u.token)).status).toBe(400);
    expect((await call('POST', '/submit', mark(60), u.token)).status).toBe(200);
  });
});

describe('grupo', () => {
  test('el equipo legal: id ordenado, nombres del servidor, un puesto para cada miembro', async () => {
    const [a, b, c] = [mkUser(), mkUser(), mkUser()];
    // Mandados al revés y con nombres inventados: el servidor ordena y usa los suyos.
    await begin(b, 'g', 500, srv, [a, b, c]);
    const r = await call('POST', '/submit', { mode: 'g', t: 300, lv: 12, kills: 400,
      members: [{ uid: c.uid, name: 'FALSO', dex: 3, shiny: true }, { uid: a.uid, name: 'OTRO', dex: 1 }, { uid: b.uid, dex: 2 }] }, b.token);
    expect(r.status).toBe(200);
    expect(r.j.better).toEqual(['d', 'w', 'm', 'a']);
    const fila = await mine(a, 'g', 'a');
    expect(fila.id).toBe([a.id, b.id, c.id].sort((x, y) => x - y).join('_'));
    expect(fila.uids).toEqual([a.uid, b.uid, c.uid]);
    expect(fila.names).toEqual([a.name, b.name, c.name]);
    expect(fila.dex).toEqual([1, 2, 3]);
    expect(fila.shiny).toEqual([false, false, true]);
    for (const u of [a, b, c]) expect((await mine(u, 'g', 'a')).id).toBe(fila.id);
    // Tablas de Pokémon: una por cada Pokémon distinto del equipo
    expect(count('ranking_entries', "board LIKE 'g_all2_p%' AND id = ?", fila.id)).toBe(3);
    // Y nada de equipos en las tablas de solitario
    expect(count('ranking_entries', "board LIKE 's!_%' ESCAPE '!' AND id LIKE '%!_%' ESCAPE '!'")).toBe(0);
  });

  test('el id es numérico, no de texto (9 y 10 -> "9_10")', async () => {
    await aparte(async () => {
      const us = Array.from({ length: 11 }, () => mkUser());
      const a = us[8], b = us[9];                                        // ids 9 y 10
      expect([a.id, b.id]).toEqual([9, 10]);
      await begin(b, 'g', 500, srv, [a, b]);
      const r = await call('POST', '/submit', { mode: 'g', t: 100, lv: 3, kills: 3, members: [{ uid: '10', dex: 1 }, { uid: '9', dex: 2 }] }, b.token);
      expect(r.status).toBe(200);
      const e = srv.db.raw.query("SELECT id FROM ranking_entries WHERE board = 'g_all2'").all() as { id: string }[];
      expect(e).toEqual([{ id: '9_10' }]);
      expect((await mine(a, 'g')).uids).toEqual(['9', '10']);
    });
  });

  test.each([
    ['sin el anfitrión dentro', (h: U, o: U[]) => [o[0], o[1]], 403],
    ['un solo miembro', (h: U) => [h], 400],
    ['cinco miembros', (h: U, o: U[]) => [h, ...o, mkUser()], 400],
    ['sin miembros', () => [], 400],
  ])('equipo %s', async (_, build, status) => {
    const h = mkUser(), o = [mkUser(), mkUser(), mkUser()];
    const antes = count('ranking_entries');
    const r = await team(h, (build as (h: U, o: U[]) => U[])(h, o), 100);
    expect(r.status).toBe(status as number);
    expect(count('ranking_entries')).toBe(antes);
  });

  test('alguien que no está en el equipo no puede subir la marca de otros', async () => {
    const [a, b, intruso] = [mkUser(), mkUser(), mkUser()];
    const antes = count('ranking_entries');
    const r = await team(intruso, [a, b], 100);
    expect(r.status).toBe(403);
    expect(count('ranking_entries')).toBe(antes);
  });

  test('uids repetidos', async () => {
    const [h, o] = [mkUser(), mkUser()];
    const antes = count('ranking_entries');
    expect((await team(h, [h, o, o], 100)).status).toBe(400);
    expect((await team(h, [h, h], 100)).status).toBe(400);
    expect((await team(h, [h, h, o, o], 100)).status).toBe(400);
    expect(count('ranking_entries')).toBe(antes);
  });

  test.each([
    ['uid que no existe', '999999'], ['uid con letras', 'abc'], ['uid vacío', ''], ['uid con ceros', '007'], ['uid negativo', '-1'],
    ['uid decimal', '1.5'], ['uid en notación científica', '1e3'], ['uid enorme', '9'.repeat(30)], ['inyección', "1' OR '1'='1"],
    ['uid con guion bajo (falsifica un id de equipo)', '1_2'],
  ])('miembro falso: %s', async (_, uid) => {
    const h = mkUser();
    await begin(h, 'g', 500);
    const r = await call('POST', '/submit', { mode: 'g', t: 100, lv: 3, kills: 3,
      members: [{ uid: h.uid, dex: 1 }, { uid, dex: 2 }] }, h.token);
    expect(r.status).toBe(400);
    expect(count('ranking_members', 'user_id = ?', h.id)).toBe(0);
  });

  test('miembros que no son objetos o con uid numérico en vez de texto', async () => {
    const h = mkUser(), o = mkUser();
    for (const members of [null, 'x', 5, {}, [null, null], [1, 2], [{ uid: h.id, dex: 1 }, { uid: o.id, dex: 2 }],
                           [{ uid: h.uid }, { uid: o.uid }], [{ uid: h.uid, dex: 'a' }, { uid: o.uid, dex: 2 }], [[h.uid], [o.uid]]]) {
      await begin(h, 'g', 500);
      const r = await call('POST', '/submit', { mode: 'g', t: 100, lv: 3, kills: 3, members }, h.token);
      expect(r.status).toBe(400);
    }
  });

  test('el anfitrión sin partida de grupo en marcha no sube', async () => {
    const [h, o] = [mkUser(), mkUser()];
    const body = { mode: 'g', t: 100, lv: 3, kills: 3, members: [{ uid: h.uid, dex: 1 }, { uid: o.uid, dex: 2 }] };
    expect((await call('POST', '/submit', body, h.token)).status).toBe(403);       // ni sala ni equipo apuntado
    seedTeam(h, [o]);
    expect((await call('POST', '/submit', body, h.token)).status).toBe(403);       // con equipo, pero sin /start: tampoco
  });

  test('sólo vale el equipo que de verdad empezó la partida en la sala del anfitrión (verifyTeam, con las salas reales)', async () => {
    const [h, o, intruso, otro] = [mkUser(), mkUser(), mkUser(), mkUser()];
    const body = (ms: U[]) => ({ mode: 'g', t: 100, lv: 3, kills: 3, members: ms.map(m => ({ uid: m.uid, dex: 1 })) });
    const antes = count('ranking_entries');
    // Sin sala: nadie se inventa un equipo (ni con amigos reales)
    await begin(h, 'g', 500);
    expect((await call('POST', '/submit', body([h, o]), h.token)).status).toBe(403);
    // La sala apuntó a h y o: no se puede añadir a nadie, ni quitar a nadie, ni cambiar a otro anfitrión
    await begin(h, 'g', 500, srv, [o]);
    expect((await call('POST', '/submit', body([h, o, intruso]), h.token)).status).toBe(403);
    expect((await call('POST', '/submit', body([h, otro]), h.token)).status).toBe(403);
    expect((await call('POST', '/submit', body([o, intruso]), h.token)).status).toBe(403);
    await begin(o, 'g', 500);
    expect((await call('POST', '/submit', body([h, o]), o.token)).status).toBe(403);    // o no es el anfitrión de esa sala
    expect(count('ranking_entries')).toBe(antes);
    // Un /start anterior a que empezara la partida no sirve (daría margen de tiempo que no se jugó)
    seedTeam(h, [o], -600);                                                              // la partida "empezó" 10 min DESPUÉS del /start
    expect((await call('POST', '/submit', body([h, o]), h.token)).status).toBe(403);
    // La buena
    await begin(h, 'g', 500, srv, [o]);
    expect((await call('POST', '/submit', body([h, o]), h.token)).status).toBe(200);
  });

  test('el tiempo del equipo también se comprueba contra el /start del anfitrión', async () => {
    const [h, o] = [mkUser(), mkUser()];
    await begin(h, 'g', 100, srv, [o]);
    const r = await call('POST', '/submit', { mode: 'g', t: 500, lv: 3, kills: 3, members: [{ uid: h.uid, dex: 1 }, { uid: o.uid, dex: 2 }] }, h.token);
    expect(r.status).toBe(400);
    // El /start de otro miembro no vale: se mira el del que sube.
    await begin(o, 'g', 5000);
    const r2 = await call('POST', '/submit', { mode: 'g', t: 500, lv: 3, kills: 3, members: [{ uid: h.uid, dex: 1 }, { uid: o.uid, dex: 2 }] }, h.token);
    expect(r2.status).toBe(400);
  });

  test('marcas de grupo peores no pisan las mejores; el mismo equipo con otro orden es el mismo equipo', async () => {
    const [a, b] = [mkUser(), mkUser()];
    expect((await team(a, [a, b], 300, { lv: 20 })).j.better).toEqual(['d', 'w', 'm', 'a']);
    expect((await team(b, [b, a], 200, { lv: 30 })).j.better).toEqual([]);
    expect((await team(b, [b, a], 400, { lv: 40 })).j.better).toEqual(['d', 'w', 'm', 'a']);
    expect(count('ranking_entries', "board = 'g_all2' AND id = ?", [a.id, b.id].sort((x, y) => x - y).join('_'))).toBe(1);
    expect(await mine(a, 'g')).toMatchObject({ t: 400, lv: 40 });
  });

  test('una cuenta marcada en el equipo: nadie sube', async () => {
    const [h, o, malo] = [mkUser(), mkUser(), mkUser()];
    await call('POST', '/admin/mark', { uid: malo.uid, on: true }, (await mod()).token);
    expect((await team(h, [h, o, malo], 100)).status).toBe(403);
    expect((await team(malo, [malo, h], 100)).status).toBe(403);
    expect(count('ranking_members', 'user_id = ?', malo.id)).toBe(0);
  });
});

describe('tablas y parámetros inventados', () => {
  test.each([
    ['modo roto', 'x', 'a', ''], ['modo vacío', '', 'a', ''], ['modo inyección', "s' OR '1'='1", 'a', ''], ['modo en mayúscula', 'S', 'a', ''],
    ['periodo inventado', 's', 'x', ''], ['periodo año (quitado)', 's', 'y', ''], ['periodo vacío', 's', '', ''],
    ['periodo inyección', 's', "a' OR 1=1 --", ''], ['periodo con id de tabla', 's', 'all2', ''], ['periodo largo', 's', 'a'.repeat(5000), ''],
    ['Pokémon fuera de rango', 's', 'a', '&dex=99999'], ['Pokémon 0', 's', 'a', '&dex=0'], ['Pokémon negativo', 's', 'a', '&dex=-1'],
    ['Pokémon decimal', 's', 'a', '&dex=25.5'], ['Pokémon texto', 's', 'a', '&dex=pikachu'], ['Pokémon inyección', 's', 'a', '&dex=' + encodeURIComponent('1 OR 1=1')],
    ['Pokémon científico', 's', 'a', '&dex=1e3'], ['Pokémon con ceros', 's', 'a', '&dex=025'],
  ])('top y puesto: %s -> 400', async (_, mode, period, extra) => {
    const u = mkUser();
    expect((await top(u, mode, period, extra)).status).toBe(400);
    expect((await rank(u, mode, period, extra)).status).toBe(400);
  });

  test('sin parámetros -> 400', async () => {
    const u = mkUser();
    expect((await call('GET', '/top', undefined, u.token)).status).toBe(400);
    expect((await call('GET', '/rank', undefined, u.token)).status).toBe(400);
  });

  test('el filtro por Pokémon se ignora fuera del histórico (igual que board() del cliente)', async () => {
    const u = mkUser();
    await solo(u, 100, { dex: 25 });
    const sin = await rows(u, 's', 'd');
    expect(await rows(u, 's', 'd', '&dex=999999')).toEqual(sin);
    expect(await rows(u, 's', 'w', '&dex=basura')).toEqual(await rows(u, 's', 'w'));
  });

  test('no se pueden leer tablas viejas ni de otros periodos pidiéndolas por nombre', async () => {
    const u = mkUser();
    await solo(u, 100);
    srv.db.raw.run("INSERT INTO ranking_entries (board, id, t, lv, kills, at) VALUES ('s_all', 'viejo', 999, 1, 1, 1)");
    expect((await rows(u, 's', 'a')).some(r => r.id === 'viejo')).toBe(false);
    srv.db.raw.run("DELETE FROM ranking_entries WHERE id = 'viejo'");
  });

  test('las tablas del ranking siguen intactas tras todo ese manoseo', () => {
    for (const t of ['ranking_entries', 'ranking_members', 'ranking_runs', 'ranking_reports', 'ranking_marked']) {
      expect(count('sqlite_master', 'name = ?', t)).toBe(1);
    }
  });
});

describe('el top y los puestos', () => {
  // Un servidor aparte: el top 50 de las tablas compartidas lo llenarían las demás pruebas.
  let principal: { srv: typeof srv; base: string };
  beforeEach(() => {
    principal = { srv, base };
    srv = startServer({ port: 0, dbPath: ':memory:', dist: '.', loginLimit: 1000 });
    base = `http://127.0.0.1:${srv.server.port}`;
  });
  afterEach(() => { srv.stop(); srv = principal.srv; base = principal.base; });

  test('60 cuentas con muchos empates: 50 filas, orden por tiempo, quien llegó antes, id; y el puesto de las 60 cuadra', async () => {
    const us: U[] = [];
    for (let i = 0; i < 60; i++) us.push(mkUser());
    // Sólo 10 tiempos distintos: empates por todas partes.
    const t = (i: number) => 100 + (i % 10) * 10;
    for (let i = 0; i < 60; i++) expect((await solo(us[i], t(i), {}, 400)).status).toBe(200);
    // Hora de llegada a mano: las cuentas i e i+10 (mismo tiempo) llegan a la vez en cada tanda de 20.
    const at = (i: number) => 5000 + Math.floor(i / 20);
    for (let i = 0; i < 60; i++) srv.db.raw.run('UPDATE ranking_entries SET at = ? WHERE id = ?', [at(i), us[i].uid]);

    const esperado = us.map((u, i) => ({ id: u.uid, t: t(i), at: at(i) }))
      .sort((x, y) => y.t - x.t || x.at - y.at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const lista = await rows(us[0], 's', 'a');
    expect(lista.length).toBe(50);
    expect(lista.map(r => r.id)).toEqual(esperado.slice(0, 50).map(e => e.id));
    expect(lista.map(r => r.t)).toEqual(esperado.slice(0, 50).map(e => e.t));
    // Los puestos, también los que no salen en las 50
    for (let i = 0; i < 60; i++) {
      const u = us.find(x => x.uid === esperado[i].id)!;
      expect((await rank(u)).j.rank.pos).toBe(i + 1);
    }
  });

  test('empate total (mismo tiempo, misma hora): manda el id, y es estable', async () => {
    const [a, b, c] = [mkUser(), mkUser(), mkUser()];
    for (const u of [c, a, b]) await solo(u, 3500, {}, 3600);
    srv.db.raw.run('UPDATE ranking_entries SET at = 1 WHERE id IN (?, ?, ?)', [a.uid, b.uid, c.uid]);
    const ids = [a.uid, b.uid, c.uid].sort();
    expect((await rows(a)).slice(0, 3).map(r => r.id)).toEqual(ids);
    expect(await rows(a)).toEqual(await rows(b));
    expect((await rank(c)).j.rank.pos).toBe(ids.indexOf(c.uid) + 1);
  });

  test('tu puesto fuera del top 50 es exacto', async () => {
    const campeones: U[] = [];
    for (let i = 0; i < 55; i++) { const u = mkUser(); campeones.push(u); await solo(u, 1000 + i, {}, 1100); }
    const yo = mkUser();
    await solo(yo, 999, {}, 1100);                                       // justo por debajo de los 55
    const r = (await rank(yo)).j.rank;
    expect(r.pos).toBe(56);
    expect(r.t).toBe(999);
    expect(r.row.id).toBe(yo.uid);
    expect((await rows(yo)).some(x => x.id === yo.uid)).toBe(false);     // no sale en las 50
    expect((await rank(campeones[54])).j.rank.pos).toBe(1);
    expect((await rank(campeones[0])).j.rank.pos).toBe(55);
    // También en las tablas de periodo y de Pokémon (antes sólo el histórico daba el puesto)
    expect((await rank(yo, 's', 'w')).j.rank.pos).toBe(56);
    expect((await rank(yo, 's', 'd')).j.rank.pos).toBe(56);
    expect((await rank(yo, 's', 'a', '&dex=25')).j.rank.pos).toBe(56);
  });

  test('sin marca en la tabla: rank null; y el modo cuenta (solitario no es grupo)', async () => {
    const u = mkUser();
    expect((await rank(u)).j.rank).toBeNull();
    await solo(u, 100);
    expect((await rank(u)).j.rank.pos).toBeGreaterThan(0);
    expect((await rank(u, 'g')).j.rank).toBeNull();
    expect((await rank(u, 's', 'a', '&dex=25')).j.rank).not.toBeNull();
    expect((await rank(u, 's', 'a', '&dex=26')).j.rank).toBeNull();
  });

  test('en grupo tu puesto es el de tu mejor equipo', async () => {
    const [a, b, c] = [mkUser(), mkUser(), mkUser()];
    await team(a, [a, b], 200);
    await team(c, [c, a], 700);
    const r = (await rank(a, 'g')).j.rank;
    expect(r.t).toBe(700);
    expect(r.row.uids).toEqual([a.uid, c.uid].sort((x, y) => +x - +y));
    expect((await rank(b, 'g')).j.rank.t).toBe(200);
  });

  test('sólo amigos (circle): tú y los de la lista, aunque pidan 1000 uids o basura', async () => {
    const [yo, amigo, otro] = [mkUser(), mkUser(), mkUser()];
    for (const u of [yo, amigo, otro]) await solo(u, 1200, {}, 1300);
    expect((await rows(yo, 's', 'a', '&circle=' + amigo.uid)).map(r => r.id).sort()).toEqual([yo.uid, amigo.uid].sort());
    expect((await rows(yo, 's', 'a', '&circle=' + encodeURIComponent(','))).map(r => r.id)).toEqual([yo.uid]);
    const basura = ["1' OR 1=1", 'abc', '-1', '0', '1.5', amigo.uid + 'x', '', ' '];
    expect((await rows(yo, 's', 'a', '&circle=' + encodeURIComponent(basura.join(',')))).map(r => r.id)).toEqual([yo.uid]);
    const mil = Array.from({ length: 1000 }, (_, i) => String(i + 1)).join(',');
    expect((await top(yo, 's', 'a', '&circle=' + mil)).status).toBe(200);
    // En grupo: las marcas donde está alguno del círculo
    await team(yo, [yo, amigo], 300);
    await team(otro, [otro, mkUser()], 300);
    const gs = await rows(yo, 'g', 'a', '&circle=' + amigo.uid);
    expect(gs.length).toBe(1);
    expect(gs[0].uids).toEqual([yo.uid, amigo.uid].sort((x, y) => +x - +y));
  });
});

describe('cuentas marcadas', () => {
  test('una cuenta marcada no sube; al desmarcarla, sí; la marca se pide al admin', async () => {
    const m = await mod();
    const u = mkUser();
    expect((await call('POST', '/admin/mark', { uid: u.uid, on: true }, m.token)).status).toBe(200);
    await begin(u, 's', 500);
    const r = await call('POST', '/submit', mark(100), u.token);
    expect(r.status).toBe(403);
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(0);
    expect((await call('POST', '/admin/mark', { uid: u.uid, on: false }, m.token)).status).toBe(200);
    expect((await call('POST', '/submit', mark(100), u.token)).status).toBe(200);
  });

  test('el admin ve las cuentas marcadas con lo de su partida', async () => {
    const m = await mod();
    const u = mkUser();
    srv.db.putSave(u.id, JSON.stringify({ coins: 1234, tickets: { t1: 3, t10: 2 }, owned: { 1: 1, 4: 1, 7: 1 } }), 0);
    await call('POST', '/admin/mark', { uid: u.uid, on: true }, m.token);
    const lista = (await call('GET', '/admin/marked', undefined, m.token)).j.accounts;
    expect(lista.find((a: any) => a.uid === u.uid)).toEqual({ uid: u.uid, name: u.name, coins: 1234, t1: 3, t10: 2, owned: 3 });
    await call('POST', '/admin/mark', { uid: u.uid, on: false }, m.token);
    expect((await call('GET', '/admin/marked', undefined, m.token)).j.accounts.some((a: any) => a.uid === u.uid)).toBe(false);
  });

  test('marcar dos veces no duplica; marcar una cuenta que no existe, 404; entradas rotas, 400', async () => {
    const m = await mod();
    const u = mkUser();
    await call('POST', '/admin/mark', { uid: u.uid, on: true }, m.token);
    await call('POST', '/admin/mark', { uid: u.uid, on: true }, m.token);
    expect(count('ranking_marked', 'user_id = ?', u.id)).toBe(1);
    expect((await call('POST', '/admin/mark', { uid: '999999', on: true }, m.token)).status).toBe(404);
    for (const body of [{}, { uid: u.uid }, { uid: u.id, on: true }, { uid: u.uid, on: 'yes' }, { uid: "1' OR 1=1", on: true }, { uid: '0', on: true }]) {
      expect((await call('POST', '/admin/mark', body, m.token)).status).toBe(400);
    }
    await call('POST', '/admin/mark', { uid: u.uid, on: false }, m.token);
  });
});

/** La cuenta de moderación (ADMIN_USERS) del servidor de pruebas. */
let moderadora: U | null = null;
async function mod(): Promise<U> {
  return moderadora ??= mkUser('Moderadora');
}

describe('moderación: quién puede', () => {
  test('una cuenta cualquiera recibe 403 en todas las rutas de admin, y no cambia nada', async () => {
    const u = mkUser(), v = mkUser();
    await solo(v, 400);
    const antes = count('ranking_entries');
    const rutas: [string, string, unknown][] = [
      ['GET', '/admin/reports', undefined], ['GET', `/admin/entry?board=s_all2&e=${v.uid}`, undefined], ['GET', '/admin/marked', undefined],
      ['POST', '/admin/remove', { board: 's_all2', e: v.uid }], ['POST', '/admin/remove-all', { e: v.uid, mode: 's' }],
      ['POST', '/admin/purge', { maxT: 600 }], ['POST', '/admin/mark', { uid: v.uid, on: true }], ['POST', '/admin/dismiss', { ids: ['1'] }],
    ];
    for (const [m, p, b] of rutas) expect((await call(m, p, b, u.token)).status).toBe(403);
    expect(count('ranking_entries')).toBe(antes);
    expect(count('ranking_marked', 'user_id = ?', v.id)).toBe(0);
    expect((await call('GET', '/admin', undefined, u.token)).j.admin).toBe(false);
  });

  test('nombres parecidos al de un admin no valen; las mayúsculas y los espacios de la variable, sí', async () => {
    for (const name of ['Moderadora2', 'Moderador', 'xModeradora', 'oTROADMINx']) {
      const u = mkUser(name);
      expect((await call('GET', '/admin/marked', undefined, u.token)).status).toBe(403);
      expect((await call('GET', '/admin', undefined, u.token)).j.admin).toBe(false);
    }
    const o = mkUser('OtroAdmin');
    expect((await call('GET', '/admin', undefined, o.token)).j.admin).toBe(true);
    expect((await call('GET', '/admin/marked', undefined, o.token)).status).toBe(200);
    expect((await call('GET', '/admin', undefined, (await mod()).token)).j.admin).toBe(true);
  });

  test('el campo admin llega con las listas; los demás no son admin', async () => {
    const u = mkUser();
    expect((await top(u)).j.admin).toBe(false);
    expect((await rank(u)).j.admin).toBe(false);
    expect((await top(await mod())).j.admin).toBe(true);
  });

  test('un cuerpo que diga ser admin no cambia nada', async () => {
    const u = mkUser();
    const r = await call('POST', '/admin/mark', { uid: u.uid, on: true, admin: true, user: 'Moderadora' }, u.token);
    expect(r.status).toBe(403);
    const r2 = await call('POST', '/admin/purge', { maxT: 600, admin: true }, u.token);
    expect(r2.status).toBe(403);
  });

  test('createRanking acepta los admins por opción (y sin opción ni variable no hay ninguno)', async () => {
    const h = harness({ admins: ['  Jefe '] });
    const jefe = h.user('jefe'), otro = h.user('otro');
    expect((await h.call(jefe, 'GET', '/ranking/admin')).j.admin).toBe(true);
    expect((await h.call(otro, 'GET', '/ranking/admin')).j.admin).toBe(false);
    expect((await h.call(otro, 'GET', '/ranking/admin/marked')).status).toBe(403);
    const vacio = harness({ admins: [] });
    expect((await vacio.call(vacio.user('jefe'), 'GET', '/ranking/admin')).j.admin).toBe(false);
  });
});

describe('moderación: acciones', () => {
  test('quitar una marca, quitarla de todas partes, y ver una marca', async () => {
    const m = await mod();
    const u = mkUser(), otro = mkUser();
    await solo(u, 500, { dex: 25 });
    await solo(otro, 400, { dex: 25 });
    const ids = periodIds();
    const info = await call('GET', `/admin/entry?board=s_all2&e=${u.uid}`, undefined, m.token);
    expect(info.j.row).toMatchObject({ id: u.uid, t: 500, names: [u.name], dex: [25] });
    expect((await call('GET', `/admin/entry?board=s_all2&e=${u.id + 777}`, undefined, m.token)).j.row).toBeNull();

    expect((await call('POST', '/admin/remove', { board: 's_all2', e: u.uid }, m.token)).j.removed).toBe(1);
    expect((await rows(u)).some(r => r.id === u.uid)).toBe(false);
    expect(count('ranking_entries', "id = ? AND board = ?", u.uid, 's_' + ids.w)).toBe(1);        // la de la semana sigue

    const r = await call('POST', '/admin/remove-all', { e: u.uid, mode: 's', dexes: [25], also: 's_all2' }, m.token);
    expect(r.status).toBe(200);
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(0);
    expect(count('ranking_members', 'user_id = ?', u.id)).toBe(0);
    expect(count('ranking_entries', 'id = ?', otro.uid)).toBe(5);                                    // la de otro, intacta
  });

  test('quitarla de todas partes incluye las tablas de cualquier Pokémon, aunque no se pidan; y no toca el otro modo', async () => {
    const m = await mod();
    const [u, c] = [mkUser(), mkUser()];
    await solo(u, 500, { dex: 25 });
    await solo(u, 600, { dex: 6 });                                   // la marca del histórico pasa a Charizard; la de Pikachu queda
    await team(u, [u, c], 300);
    expect(count('ranking_entries', "id = ? AND board LIKE 's!_all2!_p%' ESCAPE '!'", u.uid)).toBe(2);
    const r = await call('POST', '/admin/remove-all', { e: u.uid, mode: 's' }, m.token);
    expect(r.status).toBe(200);
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(0);
    expect(await mine(c, 'g')).not.toBeNull();                        // el equipo (otro id, otro modo) sigue
    expect(huerfanas()).toBe(0);
  });

  test('entradas rotas en las acciones de admin: 400 y nada cambia', async () => {
    const m = await mod();
    const v = mkUser();
    await solo(v, 400);
    const antes = count('ranking_entries');
    const malas: [string, string, unknown][] = [
      ['POST', '/admin/remove', { board: "s_all2'; DROP TABLE ranking_entries; --", e: v.uid }],
      ['POST', '/admin/remove', { board: 's_all2', e: "1' OR '1'='1" }],
      ['POST', '/admin/remove', { board: 's_all', e: v.uid }],
      ['POST', '/admin/remove', { board: 's_all2_p0', e: v.uid }],
      ['POST', '/admin/remove', { board: 'x_all2', e: v.uid }],
      ['POST', '/admin/remove', { board: 's_d2026101', e: v.uid }],
      ['POST', '/admin/remove', { board: ['s_all2'], e: v.uid }],
      ['POST', '/admin/remove', { board: 's_all2', e: [v.uid] }],
      ['POST', '/admin/remove', { board: 's_all2', e: '%' }],
      ['POST', '/admin/remove', {}],
      ['POST', '/admin/remove-all', { e: v.uid, mode: 'x' }],
      ['POST', '/admin/remove-all', { e: v.uid, mode: 's', dexes: 'todos' }],
      ['POST', '/admin/remove-all', { e: v.uid, mode: 's', dexes: [0] }],
      ['POST', '/admin/remove-all', { e: v.uid, mode: 's', dexes: ["1' OR 1=1"] }],
      ['POST', '/admin/remove-all', { e: v.uid, mode: 's', also: 'todas' }],
      ['POST', '/admin/remove-all', { e: '%', mode: 's' }],
      ['GET', "/admin/entry?board=s_all2&e=%25", undefined],
      ['GET', "/admin/entry?board=basura&e=1", undefined],
      ['POST', '/admin/dismiss', { ids: ['1', 'x'] }],
      ['POST', '/admin/dismiss', { ids: [1] }],
      ['POST', '/admin/dismiss', { ids: "1' OR 1=1" }],
      ['POST', '/admin/dismiss', { ids: Array.from({ length: 501 }, () => '1') }],
    ];
    for (const [meth, p, b] of malas) expect([meth + p, (await call(meth, p, b, m.token)).status]).toEqual([meth + p, 400]);
    expect(count('ranking_entries')).toBe(antes);
  });

  test('purge: quita todo lo de más de maxT en todas las tablas; el tope mínimo evita vaciarlo todo', async () => {
    const m = await mod();
    const u = mkUser(), v = mkUser();
    await solo(u, 3000, {}, 3100);
    await solo(v, 700, {}, 800);
    for (const maxT of [0, -1, 59, 599, 600.5, '600', null, undefined, 1e999, NaN, [600], {}]) {
      expect((await call('POST', '/admin/purge', { maxT }, m.token)).status).toBe(400);
    }
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(5);
    const r = await call('POST', '/admin/purge', { maxT: 1500 }, m.token);
    expect(r.status).toBe(200);
    expect(r.j.rows).toBeGreaterThanOrEqual(5);
    expect(r.j.boards).toBeGreaterThanOrEqual(5);
    expect(count('ranking_entries', 't > 1500')).toBe(0);
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(0);
    expect(count('ranking_entries', 'id = ?', v.uid)).toBe(5);
    expect((await call('POST', '/admin/purge', { maxT: 1500 }, m.token)).j.rows).toBe(0);
  });

  test('quitarse las propias marcas', async () => {
    const [a, b] = [mkUser(), mkUser()];
    await solo(a, 100); await solo(b, 100);
    await team(a, [a, b], 100);
    const r = await call('DELETE', '/mine', undefined, a.token);
    expect(r.status).toBe(200);
    expect(r.j.removed).toBeGreaterThanOrEqual(5);
    expect(count('ranking_members', 'user_id = ?', a.id)).toBe(0);
    expect(count('ranking_entries', 'id = ?', b.uid)).toBe(5);                                       // la de b, intacta
    expect(huerfanas()).toBe(0);
    expect((await rows(b, 'g', 'a')).some(x => x.uids.includes(a.uid))).toBe(false);                // el equipo de a también se fue
  });
});

describe('reportes', () => {
  test('reportar dos veces la misma marca cuenta una; otro jugador suma; el admin los ve juntos y los descarta', async () => {
    const m = await mod();
    const [tramposo, r1, r2] = [mkUser(), mkUser(), mkUser()];
    await solo(tramposo, 3000, {}, 3100);
    const body = { board: 's_all2', e: tramposo.uid };
    const a = await call('POST', '/report', body, r1.token);
    expect(a.j).toEqual({ ok: true, dup: false });
    expect((await call('POST', '/report', body, r1.token)).j).toEqual({ ok: true, dup: true });
    expect((await call('POST', '/report', body, r1.token)).j.dup).toBe(true);
    expect(count('ranking_reports', 'entry = ? AND board = ?', tramposo.uid, 's_all2')).toBe(1);
    expect((await call('POST', '/report', body, r2.token)).j.dup).toBe(false);

    const g = (await call('GET', '/admin/reports', undefined, m.token)).j.groups.find((x: any) => x.e === tramposo.uid && x.board === 's_all2');
    expect(g).toMatchObject({ board: 's_all2', e: tramposo.uid, names: [tramposo.name], t: 3000, n: 2 });
    expect(g.ids.length).toBe(2);
    // Descartar con ids ajenos o repetidos no rompe nada
    expect((await call('POST', '/admin/dismiss', { ids: [...g.ids, '999999', g.ids[0]] }, m.token)).status).toBe(200);
    expect((await call('GET', '/admin/reports', undefined, m.token)).j.groups.some((x: any) => x.e === tramposo.uid)).toBe(false);
    expect(count('ranking_entries', 'id = ?', tramposo.uid)).toBe(5);                                // descartar no borra la marca
  });

  test('reportes: los más reportados primero', async () => {
    const m = await mod();
    const [x, y] = [mkUser(), mkUser()];
    await solo(x, 100); await solo(y, 100);
    const rs = [mkUser(), mkUser(), mkUser()];
    await call('POST', '/report', { board: 's_all2', e: x.uid }, rs[0].token);
    for (const r of rs) await call('POST', '/report', { board: 's_all2', e: y.uid }, r.token);
    const gs = (await call('GET', '/admin/reports', undefined, m.token)).j.groups;
    expect(gs.findIndex((g: any) => g.e === y.uid)).toBeLessThan(gs.findIndex((g: any) => g.e === x.uid));
    for (let i = 1; i < gs.length; i++) expect(gs[i - 1].n).toBeGreaterThanOrEqual(gs[i].n);
  });

  test('no se reporta la marca propia, ni una que no existe, ni una tabla inventada', async () => {
    const u = mkUser(), v = mkUser();
    await solo(u, 100);
    const antes = count('ranking_reports');
    expect((await call('POST', '/report', { board: 's_all2', e: u.uid }, u.token)).status).toBe(400);
    expect((await call('POST', '/report', { board: 's_all2', e: String(v.id + 5000) }, u.token)).status).toBe(404);
    expect((await call('POST', '/report', { board: 's_all2', e: v.uid }, u.token)).status).toBe(404);   // v no tiene marca
    for (const body of [{}, { board: 's_all2' }, { e: u.uid }, { board: "s_all2' OR 1=1", e: u.uid }, { board: 'g_all2_p0', e: u.uid },
                        { board: 's_all2', e: u.id }, { board: 's_all2', e: "1' OR '1'='1" }, { board: ['s_all2'], e: u.uid }, { board: 'x'.repeat(100), e: u.uid }]) {
      expect((await call('POST', '/report', body, v.token)).status).toBe(400);
    }
    expect(count('ranking_reports')).toBe(antes);
  });

  test('en grupo no puede reportar quien está en el equipo; el resto sí, y el nombre sale de la base', async () => {
    const [a, b, c] = [mkUser(), mkUser(), mkUser()];
    await team(a, [a, b], 3000, {}, 3100);
    const id = [a.id, b.id].sort((x, y) => x - y).join('_');
    expect((await call('POST', '/report', { board: 'g_all2', e: id }, b.token)).status).toBe(400);
    expect((await call('POST', '/report', { board: 'g_all2', e: id }, c.token)).status).toBe(200);
    const m = await mod();
    const g = (await call('GET', '/admin/reports', undefined, m.token)).j.groups.find((x: any) => x.e === id);
    expect(g.names).toEqual([a.name, b.name]);
  });

  test('quitar la marca arrastra sus reportes', async () => {
    const m = await mod();
    const [t, r] = [mkUser(), mkUser()];
    await solo(t, 100);
    await call('POST', '/report', { board: 's_all2', e: t.uid }, r.token);
    expect(count('ranking_reports', 'entry = ?', t.uid)).toBe(1);
    await call('POST', '/admin/remove', { board: 's_all2', e: t.uid }, m.token);
    expect(count('ranking_reports', 'entry = ?', t.uid)).toBe(0);
  });

  test('un reporte no se puede inundar: hay límite de peticiones', async () => {
    const u = mkUser(), v = mkUser();
    await solo(v, 100);
    let limitado = 0;
    for (let i = 0; i < 130; i++) if ((await call('POST', '/report', { board: 's_all2', e: v.uid }, u.token)).status === 429) limitado++;
    expect(limitado).toBeGreaterThan(0);
    expect(count('ranking_reports', 'by = ?', u.id)).toBe(1);
  });
});

describe('límites de uso', () => {
  test('inundar /start devuelve 429', async () => {
    const u = mkUser();
    const rs: number[] = [];
    for (let i = 0; i < 130; i++) rs.push((await call('POST', '/start', { mode: 's' }, u.token)).status);   // (de una en una: 150 conexiones a la vez tumban el puerto en Windows)
    expect(rs.some(r => r === 429)).toBe(true);
    expect(rs.filter(r => r === 200).length).toBe(120);
  });
});

describe('borrar la cuenta se lleva todo', () => {
  async function real(name: string) {
    const r = await send(base + '/api/register', { method: 'POST', body: JSON.stringify({ name, pass: 'secreta1' }) });
    const j: any = await r.json();
    expect(r.status).toBe(200);
    return { id: +j.uid, uid: j.uid as string, name, token: j.token as string } as U;
  }

  test('sus marcas en solitario y en grupo, sus reportes, su partida y su marca de moderación', async () => {
    const m = await mod();
    const nombre = 'Borra' + Math.random().toString(36).slice(2, 7);
    const yo = await real(nombre);
    const [a, b, c] = [mkUser(), mkUser(), mkUser()];
    await solo(yo, 200); await solo(a, 300);
    await team(yo, [yo, a], 250);                    // equipo con a
    await team(b, [b, c], 250);                      // equipo ajeno
    await call('POST', '/report', { board: 's_all2', e: a.uid }, yo.token);
    await call('POST', '/report', { board: 's_all2', e: yo.uid }, b.token);
    await call('POST', '/admin/mark', { uid: yo.uid, on: true }, m.token);
    await call('POST', '/start', { mode: 's' }, yo.token);
    expect(count('ranking_members', 'user_id = ?', yo.id)).toBeGreaterThan(0);

    const d = await send(base + '/api/account', { method: 'DELETE', headers: { Authorization: 'Bearer ' + yo.token }, body: JSON.stringify({ pass: 'secreta1' }) });
    expect(d.status).toBe(200);

    expect(count('ranking_members', 'user_id = ?', yo.id)).toBe(0);
    expect(count('ranking_entries', 'id = ?', yo.uid)).toBe(0);
    expect(huerfanas()).toBe(0);                                                                   // ni equipos sin miembros
    expect(count('ranking_reports', 'by = ?', yo.id)).toBe(0);
    expect(count('ranking_reports', 'entry = ?', yo.uid)).toBe(0);
    expect(count('ranking_runs', 'user_id = ?', yo.id)).toBe(0);
    expect(count('ranking_marked', 'user_id = ?', yo.id)).toBe(0);
    // Ya no sale en ninguna lista...
    expect((await rows(a, 's', 'a')).some(r => r.uids.includes(yo.uid))).toBe(false);
    expect((await rows(a, 'g', 'a')).some(r => r.uids.includes(yo.uid))).toBe(false);
    // ...y lo ajeno sigue: la marca de a, el equipo de b y c
    expect((await rank(a, 's', 'a')).j.rank.t).toBe(300);
    expect((await rank(b, 'g', 'a')).j.rank.t).toBe(250);
    expect((await rank(c, 'g', 'a')).j.rank.t).toBe(250);
    // Los reportes de otros contra la marca de a (hechos por yo) se fueron con yo, no con a
    expect(count('ranking_entries', 'id = ?', a.uid)).toBe(5);
    // Sus sesiones ya no valen
    expect((await call('GET', '/rank?mode=s&period=a', undefined, yo.token)).status).toBe(401);
  });
});

/** Un módulo suelto con su propia base, para controlar el reloj y las opciones. */
function harness(opts: RankingOptions) {
  const db = openDb(':memory:');
  const mod = createRanking(db, opts);
  return {
    db,
    user(name: string) { const id = db.addUser(name, name.toLowerCase(), 'x'); return db.userById(id)!; },
    async call(user: ReturnType<typeof db.userById>, method: string, path: string, body?: unknown) {
      const req = new Request('http://x/api' + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      const res = await mod(req, { ip: '1', user: user!, path: path.split('?')[0], method });
      if (!res) return { status: 0, j: null };
      return { status: res.status, j: (await res.json()) as any };
    },
  };
}

describe('con reloj controlado (módulo suelto)', () => {
  test('el cambio de día a medianoche de Madrid abre otra tabla diaria pero no la semanal', async () => {
    let now = Date.parse('2026-10-12T21:59:00Z');                      // 23:59 del lunes 12 en Madrid
    const h = harness({ now: () => now });
    const u = h.user('Nocturna');
    await h.call(u, 'POST', '/ranking/start', { mode: 's' });
    now += 100_000;                                                    // 00:00:40 del martes 13
    const r1 = await h.call(u, 'POST', '/ranking/submit', mark(100));
    expect(r1.j.better).toEqual(['d', 'w', 'm', 'a']);
    const boards = (h.db.raw.query("SELECT board FROM ranking_entries WHERE board NOT LIKE '%\\_p%' ESCAPE '\\' ORDER BY board").all() as { board: string }[]).map(x => x.board);
    expect(boards).toEqual(['s_all2', 's_d20261013', 's_m202610', 's_w2026-42']);
    // Otro día, partida peor: sólo la tabla diaria (nueva) la admite
    now = Date.parse('2026-10-14T10:00:00Z');
    await h.call(u, 'POST', '/ranking/start', { mode: 's' });
    now += 90_000;
    const r2 = await h.call(u, 'POST', '/ranking/submit', mark(80));
    expect(r2.j.better).toEqual(['d']);
    // El top de hoy sólo muestra lo de hoy
    const hoy = await h.call(u, 'GET', '/ranking/top?mode=s&period=d');
    expect(hoy.j.rows.map((x: any) => x.t)).toEqual([80]);
  });

  test('el reloj manda: con el reloj atrasado nada de lo anterior se cuela', async () => {
    let now = Date.parse('2026-10-13T12:00:00Z');
    const h = harness({ now: () => now });
    const u = h.user('Viajera');
    await h.call(u, 'POST', '/ranking/start', { mode: 's' });
    now -= 3_600_000;                                                  // el reloj va hacia atrás: tiempo transcurrido negativo
    expect((await h.call(u, 'POST', '/ranking/submit', mark(100))).status).toBe(400);
    now += 3_600_000 + 130_000;
    expect((await h.call(u, 'POST', '/ranking/submit', mark(100))).status).toBe(200);
  });

  test('verifyTeam: si la sala no cuadra, no se sube', async () => {
    const h = harness({ verifyTeam: () => false });
    const [a, b] = [h.user('Ana'), h.user('Beto')];
    await h.call(a, 'POST', '/ranking/start', { mode: 'g' });
    h.db.raw.run('UPDATE ranking_runs SET started = 0');
    const r = await h.call(a, 'POST', '/ranking/submit', { mode: 'g', t: 100, lv: 3, kills: 3, members: [{ uid: String(a.id), dex: 1 }, { uid: String(b.id), dex: 2 }] });
    expect(r.status).toBe(403);
    // Recibe la hora del aviso (/start) del propio anfitrión; sin aviso, null.
    const vistos: (number | null)[] = [];
    const ok = harness({ verifyTeam: (host, ms, at) => { vistos.push(at); return host === 1 && ms.length === 2; } });
    const [c, d] = [ok.user('Cris'), ok.user('Dani')];
    const sin = await ok.call(c, 'POST', '/ranking/submit', { mode: 'g', t: 100, lv: 3, kills: 3, members: [{ uid: String(c.id), dex: 1 }, { uid: String(d.id), dex: 2 }] });
    expect(sin.status).toBe(409);
    expect(vistos).toEqual([null]);
    await ok.call(c, 'POST', '/ranking/start', { mode: 'g' });
    ok.db.raw.run('UPDATE ranking_runs SET started = 0');
    expect((await ok.call(c, 'POST', '/ranking/submit', { mode: 'g', t: 100, lv: 3, kills: 3, members: [{ uid: String(c.id), dex: 1 }, { uid: String(d.id), dex: 2 }] })).status).toBe(200);
    expect(vistos).toEqual([null, 0]);                        // la segunda vez, la hora de su aviso
  });

  test('crear el módulo dos veces sobre la misma base no falla (CREATE IF NOT EXISTS)', () => {
    const db = openDb(':memory:');
    createRanking(db);
    createRanking(db);
  });
});

describe('Defensa (modo d)', () => {
  /** Una partida de Defensa posible: `waves` superadas con lo mínimo que dura, a ×1. */
  const defense = (waves: number, lives: number, over: Record<string, unknown> = {}) =>
    ({ mode: 'd', waves, lives, secs: Math.ceil(minDefenseTime(waves)) + 60, kills: 50, dex: 4, shiny: false, ...over });
  /** Aviso con `age` s de antigüedad y subida. */
  async function td(u: U, body: Record<string, unknown>, age = 4000) {
    await begin(u, 'd', age);
    return call('POST', '/submit', body, u.token);
  }

  test('una marca legal: puntuación oleadas·100 + vidas, en las 4 tablas de Defensa y en ninguna más', async () => {
    const u = mkUser();
    const r = await td(u, defense(10, 25));
    expect(r.status).toBe(200);
    expect(r.j.better).toEqual(['d', 'w', 'm', 'a']);
    const ids = periodIds();
    for (const p of ['d', 'w', 'm', 'a'] as const) {
      expect(count('ranking_entries', 'board = ? AND id = ?', 'd_' + ids[p], u.uid)).toBe(1);
    }
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(4);              // sin tablas por Pokémon
    expect(await mine(u, 'd')).toMatchObject({ t: 1025, lv: 10, kills: 50, dex: [4], names: [u.name] });
    expect(await mine(u, 's')).toBeUndefined();
  });

  test('manda la oleada; a igualdad, las vidas; una peor no pisa la buena', async () => {
    const u = mkUser();
    await td(u, defense(10, 25));
    expect((await td(u, defense(10, 20))).j.better).toEqual([]);
    expect((await mine(u, 'd')).t).toBe(1025);
    expect((await td(u, defense(10, 26))).j.better).toEqual(['d', 'w', 'm', 'a']);
    expect((await td(u, defense(11, 0))).j.better).toEqual(['d', 'w', 'm', 'a']);
    expect((await mine(u, 'd')).t).toBe(1100);

    const a = mkUser(), b = mkUser();
    await td(a, defense(LAST_WAVE, 3));
    await td(b, defense(LAST_WAVE - 1, 30));
    const top = await rows(a, 'd', 'a');
    expect(top.findIndex(r => r.id === a.uid)).toBeLessThan(top.findIndex(r => r.id === b.uid));
  });

  test('valores imposibles o rotos -> 400 y nada guardado', async () => {
    const u = mkUser();
    const min = (w: number) => Math.floor(minDefenseTime(w) * 0.9);
    const malas: Record<string, unknown>[] = [
      { waves: 0 }, { waves: MAX_WAVE + 1 }, { waves: 1.5 }, { waves: '10' }, { waves: null }, { waves: -3 },
      { lives: -1 }, { lives: 31 }, { lives: 2.5 }, { lives: '30' },
      { secs: min(10) - 1 }, { secs: 0 }, { secs: 3 * 3600 + 1 }, { secs: 1e999 }, { secs: '900' }, { secs: 900.5 },
      { kills: -1 }, { kills: maxDefenseKills(10) + 1 }, { kills: 1.5 }, { kills: '5' },
      { dex: 0 }, { dex: 2001 }, { dex: 'pikachu' },
    ];
    for (const m of malas) {
      await begin(u, 'd', 4000);
      expect([m, (await call('POST', '/submit', defense(10, 10, m), u.token)).status]).toEqual([m, 400]);
    }
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(0);
    // Los límites exactos sí valen.
    expect((await td(u, defense(10, 30, { secs: min(10), kills: maxDefenseKills(10) }))).status).toBe(200);
  });

  test('el tiempo: a ×2 cabe el doble de partida que de tiempo real, no más', async () => {
    const u = mkUser();
    const secs = Math.ceil(minDefenseTime(20)) + 100;
    const real = Math.ceil(secs / 2);
    await begin(u, 'd', real - 40);                       // 10 s más allá del margen de 30
    expect((await call('POST', '/submit', defense(20, 5, { secs }), u.token)).status).toBe(400);
    await begin(u, 'd', real - 20);
    expect((await call('POST', '/submit', defense(20, 5, { secs }), u.token)).status).toBe(200);
  });

  test('sin avisar, con el aviso de otro modo o dos veces con un aviso: 409', async () => {
    const u = mkUser();
    expect((await call('POST', '/submit', defense(5, 5), u.token)).status).toBe(409);
    await begin(u, 's', 4000);
    expect((await call('POST', '/submit', defense(5, 5), u.token)).status).toBe(409);
    await begin(u, 'd', 4000);
    expect((await call('POST', '/submit', mark(120), u.token)).status).toBe(409);
    expect((await call('POST', '/submit', defense(5, 5), u.token)).status).toBe(200);
    expect((await call('POST', '/submit', defense(6, 5), u.token)).status).toBe(409);
  });

  test('una cuenta marcada no sube a Defensa', async () => {
    const m = await mod();
    const u = mkUser();
    await call('POST', '/admin/mark', { uid: u.uid, on: true }, m.token);
    expect((await td(u, defense(5, 5))).status).toBe(403);
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(0);
  });

  test('no hay tablas de Defensa por Pokémon: el filtro se ignora y d_all2_p4 no es una tabla', async () => {
    const u = mkUser(), v = mkUser();
    await td(u, defense(8, 8));
    expect(await rows(u, 'd', 'a', '&dex=4')).toEqual(await rows(u, 'd', 'a'));
    expect((await call('POST', '/report', { board: 'd_all2_p4', e: u.uid }, v.token)).status).toBe(400);
    expect((await call('POST', '/report', { board: 'd_all2', e: u.uid }, v.token)).status).toBe(200);
  });

  test('el sin fin: pasada la 30 se sigue subiendo (y la 99 es el tope)', async () => {
    const u = mkUser();
    const r = await td(u, defense(45, 0), 9000);
    expect(r.status).toBe(200);
    expect(await mine(u, 'd')).toMatchObject({ t: 4500, lv: 45 });
    expect((await td(u, defense(MAX_WAVE, 3), 9000)).status).toBe(200);
    expect((await mine(u, 'd')).t).toBe(MAX_WAVE * 100 + 3);
  });

  test('purge sólo mira tiempos: no toca las puntuaciones de Defensa; remove-all sí las quita', async () => {
    const m = await mod();
    const u = mkUser();
    await td(u, defense(LAST_WAVE, 30));                  // 3030 "segundos" si fuera un tiempo
    await call('POST', '/admin/purge', { maxT: 600 }, m.token);
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(4);
    const r = await call('POST', '/admin/remove-all', { e: u.uid, mode: 'd', also: 'd_all2' }, m.token);
    expect(r.j.removed).toBe(4);
    expect(count('ranking_entries', 'id = ?', u.uid)).toBe(0);
  });
});

describe('Defensa en grupo (modo e)', () => {
  /** El anfitrión avisa (con el equipo apuntado por la sala) y sube la marca del equipo. */
  async function tdTeam(host: U, members: U[], waves: number, lives: number, over: Record<string, unknown> = {}, age = 4000) {
    await begin(host, 'e', age, srv, members);
    return call('POST', '/submit', {
      mode: 'e', waves, lives, secs: Math.ceil(minDefenseTime(waves)) + 60, kills: 40,
      members: members.map((m, i) => ({ uid: m.uid, dex: 4 + i, shiny: false })), ...over,
    }, host.token);
  }

  test('una marca de equipo legal: tablas e_*, los dos miembros, y nada en las de solitario', async () => {
    const a = mkUser(), b = mkUser();
    const r = await tdTeam(a, [a, b], 12, 20);
    expect(r.status).toBe(200);
    expect(r.j.better).toEqual(['d', 'w', 'm', 'a']);
    const id = [a.id, b.id].sort((x, y) => x - y).join('_');
    const ids = periodIds();
    for (const p of ['d', 'w', 'm', 'a'] as const) expect(count('ranking_entries', 'board = ? AND id = ?', 'e_' + ids[p], id)).toBe(1);
    expect(count('ranking_entries', 'id = ?', id)).toBe(4);
    const row = await mine(b, 'e');                       // el invitado también la ve como suya
    expect(row).toMatchObject({ t: 1220, lv: 12 });
    expect(row.names.sort()).toEqual([a.name, b.name].sort());
    expect(await mine(a, 'd')).toBeUndefined();
  });

  test('equipo que no es el de la sala, sin el anfitrión, o con el aviso de otro modo: no sube', async () => {
    const a = mkUser(), b = mkUser(), c = mkUser();
    // La sala apuntó a A y B, pero la marca dice A y C.
    await begin(a, 'e', 4000, srv, [a, b]);
    const otro = await call('POST', '/submit', { mode: 'e', waves: 5, lives: 5, secs: Math.ceil(minDefenseTime(5)) + 60, kills: 5,
      members: [{ uid: a.uid, dex: 4 }, { uid: c.uid, dex: 7 }] }, a.token);
    expect(otro.status).toBe(403);
    // Sin el anfitrión dentro.
    const sin = await call('POST', '/submit', { mode: 'e', waves: 5, lives: 5, secs: Math.ceil(minDefenseTime(5)) + 60, kills: 5,
      members: [{ uid: b.uid, dex: 4 }, { uid: c.uid, dex: 7 }] }, a.token);
    expect(sin.status).toBe(403);
    // Con el aviso de Defensa en solitario.
    await begin(a, 'd', 4000);
    const modo = await call('POST', '/submit', { mode: 'e', waves: 5, lives: 5, secs: Math.ceil(minDefenseTime(5)) + 60, kills: 5,
      members: [{ uid: a.uid, dex: 4 }, { uid: b.uid, dex: 7 }] }, a.token);
    expect(modo.status).toBe(409);
    expect(count('ranking_entries', "board LIKE 'e!_%' ESCAPE '!' AND (id LIKE ? OR id LIKE ?)", '%' + c.uid + '%', a.uid + '_%')).toBe(0);
  });

  test('las mismas reglas de Defensa: oleadas, vidas, tiempo y derrotados', async () => {
    const a = mkUser(), b = mkUser();
    for (const m of [{ waves: 0 }, { waves: MAX_WAVE + 1 }, { lives: 31 }, { secs: 1 }, { kills: maxDefenseKills(12) + 1 }]) {
      expect([m, (await tdTeam(a, [a, b], 12, 10, m)).status]).toEqual([m, 400]);
    }
  });

  test('no hay tablas por Pokémon en grupo; purge no las toca', async () => {
    const m = await mod();
    const a = mkUser(), b = mkUser();
    await tdTeam(a, [a, b], LAST_WAVE, 30);
    expect(await rows(a, 'e', 'a', '&dex=4')).toEqual(await rows(a, 'e', 'a'));
    expect((await call('POST', '/report', { board: 'e_all2_p4', e: a.uid }, mkUser().token)).status).toBe(400);
    await call('POST', '/admin/purge', { maxT: 600 }, m.token);
    const id = [a.id, b.id].sort((x, y) => x - y).join('_');
    expect(count('ranking_entries', 'id = ?', id)).toBe(4);
  });
});
