/* ============ stats.test.ts — el panel interno (GET /api/admin/stats) ============
 * Sólo lo ven las cuentas admin; cuenta bien a los conectados, las salas, las muestras cada
 * 5 min y los jugadores distintos por día. Sin red: servidor en el proceso (tests/helpers.ts),
 * conexiones simuladas y reloj falso, como en social.test.ts.
 *
 *   bun test tests/stats.test.ts
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import type { WsData } from '../server/realtime';
import { sha256 } from '../server/http';
import { FakeClock } from './fakes';
import { startServer } from './helpers';

process.env.ADMIN_USERS = 'Jefa';

let clock: FakeClock;
let srv: ReturnType<typeof startServer>;
let base = '';
beforeEach(() => {
  clock = new FakeClock();
  srv = startServer({ port: 0, dbPath: ':memory:', loginLimit: 10_000, realtime: { clock: clock.clock } });
  base = `http://127.0.0.1:${srv.server.port}`;
});
afterEach(() => srv.stop());

function account(name: string) {
  const id = srv.db.addUser(name, name.toLowerCase(), 'x');
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  srv.db.addSession(sha256(token), id);
  return { id, name, token };
}
const stats = (token?: string) => fetch(base + '/api/admin/stats', { headers: token ? { Authorization: 'Bearer ' + token } : {} });

/** Conexión simulada (lo que realtime.ts usa de ServerWebSocket). */
function connect(id: number) {
  const out: any[] = [];
  let i = 0;
  const ws = { data: { user: srv.db.userById(id)! }, send: (s: string) => { out.push(JSON.parse(s)); return s.length; }, close() {}, getBufferedAmount: () => 0 } as unknown as ServerWebSocket<WsData>;
  srv.rt.websocket.open!(ws);
  return {
    req(m: Record<string, unknown>) { const n = ++i; srv.rt.websocket.message!(ws, JSON.stringify({ ...m, i: n })); return out.find(x => x.k === 'ack' && x.i === n); },
    close() { srv.rt.websocket.close!(ws, 1000, ''); },
  };
}

test('sin sesión 401; una cuenta normal 403; la admin (sin importar mayúsculas) lo ve', async () => {
  const normal = account('Pepe'), jefa = account('JEFA');
  expect((await stats()).status).toBe(401);
  expect((await stats(normal.token)).status).toBe(403);
  const r = await stats(jefa.token);
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.ok).toBe(true);
  expect(j.counts.accounts).toBe(2);
  expect(j.counts.new24h).toBe(2);
  expect(j.online).toEqual([]);
});

test('conectados, en partida, salas, muestras y jugadores por día', async () => {
  const jefa = account('Jefa'), a = account('Ana'), b = account('Beto');
  const ca = connect(a.id);
  clock.advance(1000);
  const cb = connect(b.id);
  expect(ca.req({ k: 'play', v: true }).ok).toBe(true);
  expect(cb.req({ k: 'room.new', dex: 25, shiny: false }).ok).toBe(true);
  clock.advance(5 * 60_000);                                 // una muestra

  let j = await (await stats(jefa.token)).json();
  expect(j.online.map((o: any) => [o.name, o.play, !!o.room])).toEqual([['Ana', true, false], ['Beto', false, true]]);
  expect(j.rooms).toHaveLength(1);
  expect(j.rooms[0]).toMatchObject({ host: 'Beto', mode: 'survivor', max: 4, members: [{ name: 'Beto', away: false }] });
  expect(j.counts.peak).toBe(2);
  expect(j.counts.active24h).toBe(3);                         // también la admin, que ha usado la API
  expect(j.history.at(-1)).toMatchObject({ n: 2, play: 1, rooms: 1 });
  const day = Math.floor(clock.clock.now() / 86_400_000) * 86_400_000;
  expect(j.daily).toEqual([{ day, n: 2 }]);

  // Al día siguiente vuelve sólo Ana: dos días, cada uno con los suyos; quien se fue ya no sale conectado.
  ca.close(); cb.close();
  clock.advance(24 * 3600_000);
  connect(a.id);
  j = await (await stats(jefa.token)).json();
  expect(j.online.map((o: any) => o.name)).toEqual(['Ana']);
  expect(j.daily).toEqual([{ day, n: 2 }, { day: day + 86_400_000, n: 1 }]);
  expect(j.counts.peak).toBe(2);
  expect(j.history.length).toBeGreaterThan(200);             // una cada 5 min durante el día
});
