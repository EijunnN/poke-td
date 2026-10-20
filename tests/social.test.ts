/* ============ social.test.ts — pruebas adversariales de amigos, salas y relé ============
 * Lo que intentaría alguien con malas intenciones o un cliente roto. Solicitudes
 * a uno mismo, cruzadas, con inyección; perfiles gigantes o con HTML; conexiones
 * sin sesión; mensajes rotos o a ritmo de inundación; hablar en salas ajenas; un
 * invitado gobernando; quinto jugador; invitaciones caducadas; caídas bruscas y
 * reconexiones; salas que sobreviven a un reinicio del servidor; marcas de grupo
 * contra la sala real; cuentas borradas.
 *
 * Sin red y sin esperas: la parte REST va contra el servidor de verdad dentro del proceso
 * (tests/helpers.ts) y el WebSocket se prueba pasándole a `rt.websocket` conexiones simuladas
 * (objetos que imitan a `ServerWebSocket`). El tiempo es un reloj falso (`FakeClock`): "esperar
 * los 45 s de gracia" es `advance(45_000)`, y todo ocurre de forma síncrona, en el mismo orden
 * siempre. Lo que sólo se puede comprobar con un WebSocket de verdad (el apretón de manos de Bun,
 * el tope de 64 KB) está en tests/realtime.smoke.test.ts.
 *
 *   bun test tests/social.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { ServerWebSocket } from 'bun';
import type { RealtimeOptions, WsData } from '../server/realtime';
import { sha256 } from '../server/http';
import { FakeClock } from './fakes';
import { startServer } from './helpers';

// ---------------- el entorno de cada prueba: servidor + reloj + conexiones ----------------

interface Acc { name: string; token: string; uid: string }
interface EnvOptions { realtime?: RealtimeOptions; file?: boolean }

/** Un servidor (base en memoria, o en archivo si hay que reiniciarlo), su reloj falso y las conexiones simuladas. */
class Env {
  readonly clock = new FakeClock();
  srv!: ReturnType<typeof startServer>;
  base = '';
  readonly dbPath: string;
  private conns: Client[] = [];
  private closing: [Client, number][] = [];
  constructor(private o: EnvOptions = {}) {
    this.dbPath = o.file ? join(mkdtempSync(join(tmpdir(), 'poke-td-rt-')), 't.sqlite') : ':memory:';
    this.clock.after = () => this.settle();
    this.boot();
  }
  private boot() {
    this.srv = startServer({ port: 0, dbPath: this.dbPath, loginLimit: 10_000, realtime: { ...this.o.realtime, clock: this.clock.clock } });
    this.base = `http://127.0.0.1:${this.srv.server.port}`;
    this.conns = [];
  }
  get rt() { return this.srv.rt; }
  add(c: Client) { this.conns.push(c); }
  /** Bun avisa del cierre de una conexión DESPUÉS de que el servidor la corte: aquí, cuando termina la acción en curso. */
  queueClose(c: Client, code: number) { this.closing.push([c, code]); }
  settle() { while (this.closing.length) { const [c, code] = this.closing.shift()!; c.fireClose(code); } }
  advance(ms: number) { this.clock.advance(ms); this.settle(); }
  /** Para el servidor y lo vuelve a arrancar con la misma base (y el mismo reloj): las conexiones se cortan. `between` corre con el servidor parado. */
  restart(between?: () => void) {
    this.srv.stop();
    for (const c of this.conns) c.serverStopped();
    between?.();
    this.boot();
  }
  stop() { this.srv.stop(); }
}

let E: Env;
beforeEach(() => { E = new Env(); });
afterEach(() => { E.stop(); });
/** Sustituye el entorno de esta prueba por otro con opciones propias (el de por defecto se descarta). */
function fresh(o: EnvOptions) { E.stop(); E = new Env(o); return E; }

const PASS = 'secreta1';
let HASH = '';
// Registrar cuesta ~100 ms (argon2): las cuentas se crean directamente en la base con una contraseña ya
// cifrada (barata de comprobar). El registro de verdad se prueba en server.test.ts y account.test.ts.
beforeAll(async () => { HASH = await Bun.password.hash(PASS, { algorithm: 'argon2id', memoryCost: 8, timeCost: 1 }); });

const rawDb = () => E.srv.db.raw;

async function call(method: string, path: string, body?: unknown, token?: string, raw?: string) {
  const res = await fetch(E.base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  let j: any = null;
  try { j = await res.json(); } catch { /* no es JSON */ }
  E.settle();                                        // p. ej. borrar una cuenta corta su conexión
  return { status: res.status, j };
}

let n = 0;
function account(): Acc {
  const name = 'Soc' + (++n) + Math.random().toString(36).slice(2, 6);
  const id = E.srv.db.addUser(name, name.toLowerCase(), HASH);
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  E.srv.db.addSession(sha256(token), id);
  return { name, token, uid: String(id) };
}
const api = (a: Acc, method: string, path: string, body?: unknown) => call(method, path, body, a.token);

/** a y b son amigos. */
async function befriend(a: Acc, b: Acc) {
  expect((await api(a, 'POST', '/api/social/friends/request', { name: b.name })).status).toBe(200);
  expect((await api(b, 'POST', '/api/social/friends/accept', { uid: a.uid })).status).toBe(200);
}
const friendsOf = async (a: Acc) => (await api(a, 'GET', '/api/social/friends')).j.friends as any[];

/**
 * Conexión simulada: un objeto que imita a `ServerWebSocket` (lo que usa realtime.ts es `data`, `send` y
 * `close`) y se le pasa directamente a `rt.websocket`. Guarda todo lo que el servidor le manda.
 */
class Client {
  msgs: any[] = [];
  closed: { code: number } | null = null;
  /** El `hello` con que el servidor recibió esta conexión (lleva la sala en la que ya estabas). */
  hello: any = null;
  private seq = 0;
  private ws: ServerWebSocket<WsData>;
  private rt: Env['rt'];
  constructor(private env: Env, public acc: Acc) {
    this.rt = env.rt;
    this.ws = {
      data: { user: env.srv.db.userById(Number(acc.uid))! },
      send: (s: string) => { if (!this.closed) this.msgs.push(JSON.parse(s)); return s.length; },
      close: (code = 1000) => { this.cut(code); },
      getBufferedAmount: () => 0,
    } as unknown as ServerWebSocket<WsData>;
    env.add(this);
    this.rt.websocket.open!(this.ws);
    env.settle();
  }
  /** Se corta la conexión (la cierre quien la cierre); el servidor se entera después. */
  private cut(code: number) {
    if (this.closed) return;
    this.closed = { code };
    this.env.queueClose(this, code);
  }
  fireClose(code: number) { this.rt.websocket.close!(this.ws, code, ''); }
  /** Se paró el servidor: Bun corta las conexiones y, estando parado, el cierre ya no toca nada. */
  serverStopped() { if (!this.closed) this.closed = { code: 1001 }; }
  private raw(s: string | Buffer<ArrayBuffer>) {
    if (this.closed) return;                           // un socket cerrado ya no entrega nada
    this.rt.websocket.message!(this.ws, s);
    this.env.settle();
  }
  send(m: unknown) { this.raw(JSON.stringify(m)); }
  /** Texto tal cual (roto, vacío...). */
  sendText(s: string) { this.raw(s); }
  sendBinary(b: Uint8Array) { this.raw(Buffer.from(b) as Buffer<ArrayBuffer>); }
  /** Orden con respuesta. */
  req(m: Record<string, unknown>): any {
    const i = ++this.seq;
    this.send({ ...m, i });
    return this.take(x => x.k === 'ack' && x.i === i);
  }
  /** Saca (y consume) el primer mensaje que cumpla `pred`: el servidor contesta en el acto, así que si no está, no llegó. */
  take(pred: (m: any) => boolean): any {
    const k = this.msgs.findIndex(pred);
    if (k < 0) throw new Error('no llegó el mensaje esperado; llegó: ' + JSON.stringify(this.msgs.slice(-5)));
    return this.msgs.splice(k, 1)[0];
  }
  /** Comprueba que NO ha llegado nada que cumpla `pred`. */
  none(pred: (m: any) => boolean) { expect(this.msgs.filter(pred)).toEqual([]); }
  close() { this.cut(1000); E.settle(); }
  /** Caída brusca: sin despedirse. */
  kill() { this.cut(1006); E.settle(); }
}

function online(a: Acc): Client {
  const c = new Client(E, a);
  c.hello = c.take(m => m.k === 'hello');
  return c;
}

/** Sala con el anfitrión `h` y los invitados `gs` ya dentro (todos amigos del anfitrión). */
async function roomWith(h: Acc, gs: Acc[]) {
  for (const g of gs) await befriend(h, g);
  const hc = online(h);
  const room = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
  const gcs: Client[] = [];
  for (const g of gs) {
    const gc = online(g);
    expect(hc.req({ k: 'inv', to: g.uid }).ok).toBe(true);
    gc.take(m => m.k === 'inv');
    const j = gc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false });
    expect(j.ok).toBe(true);
    gcs.push(gc);
  }
  return { hc, gcs, room };
}

/** Lo que tarda en sacar de la sala a quien se desconecta (el valor por defecto del servidor). */
const GRACE = 45_000;
const advance = (ms: number) => E.advance(ms);

// ====================================================================

describe('amistades por REST', () => {
  test('el apodo buscado se normaliza: ñ descompuesta y caracteres de ancho cero (#3)', async () => {
    const a = account();
    const name = 'Pe' + String.fromCharCode(0xF1) + 'a' + Math.random().toString(36).slice(2, 6);     // Peña...
    E.srv.db.addUser(name, name.toLowerCase(), HASH);
    const nfd = name.replace(String.fromCharCode(0xF1), 'n' + String.fromCharCode(0x303));            // la ñ como n + tilde
    const zw = String.fromCharCode(0x200B), bom = String.fromCharCode(0xFEFF), shy = String.fromCharCode(0xAD);
    for (const typed of [nfd, zw + name, name + zw, name.slice(0, 3) + zw + name.slice(3), bom + name, name.slice(0, 2) + shy + name.slice(2), ' ' + name + ' ']) {
      const r = await api(a, 'POST', '/api/social/friends/request', { name: typed });
      expect(r.status).toBe(200);                                  // se encuentra la cuenta de verdad
      const other = E.srv.db.userByKey(name.toLowerCase())!;
      expect((await api(a, 'DELETE', '/api/social/friends/' + other.id)).status).toBe(200);   // para repetir la solicitud con el siguiente
    }
    // lo que sigue sin ser un apodo (otras letras o símbolos) sigue rechazado
    expect((await api(a, 'POST', '/api/social/friends/request', { name: 'Pe' + String.fromCharCode(0x4E2D) + 'a123' })).status).toBe(400);
    expect((await api(a, 'POST', '/api/social/friends/request', { name: zw + zw })).status).toBe(400);
  });

  test('a uno mismo, a inexistentes y con inyección', async () => {
    const a = account();
    expect((await api(a, 'POST', '/api/social/friends/request', { name: a.name })).status).toBe(400);
    expect((await api(a, 'POST', '/api/social/friends/request', { name: a.name.toUpperCase() })).status).toBe(400);
    expect((await api(a, 'POST', '/api/social/friends/request', { name: 'NoExisteNadie' })).status).toBe(404);
    for (const name of ["x' OR 1=1 --", "'; DROP TABLE users; --", '<script>alert(1)</script>', 'ab😀c', 'a'.repeat(100), '', '  ', 12345, null, { $ne: 1 }, ['a']]) {
      const r = await api(a, 'POST', '/api/social/friends/request', { name });
      expect(r.status).toBe(400);
    }
    expect((await call('POST', '/api/social/friends/request', undefined, a.token, '{no json')).status).toBe(400);
    expect((await call('POST', '/api/social/friends/request', undefined, a.token, '[]')).status).toBe(400);
    expect((await call('POST', '/api/social/friends/request', undefined, a.token, JSON.stringify({ name: 'x'.repeat(2000) }))).status).toBe(413);
    // La base sigue entera: se puede entrar y no hay nada raro.
    expect((await api(a, 'GET', '/api/me')).status).toBe(200);
    expect(await friendsOf(a)).toEqual([]);
  });

  test('sin sesión o con sesión falsa: 401', async () => {
    for (const [m, p] of [['GET', '/api/social/friends'], ['POST', '/api/social/friends/request'], ['POST', '/api/social/friends/accept'],
      ['DELETE', '/api/social/friends/1'], ['PUT', '/api/social/profile'], ['GET', '/api/social/profile/1']]) {
      const body = m === 'GET' ? undefined : {};
      expect((await call(m, p, body)).status).toBe(401);
      expect((await call(m, p, body, 'falso'.repeat(8))).status).toBe(401);
    }
  });

  test('solicitud, aceptar y quitar; la presencia no se filtra antes de ser amigos', async () => {
    const a = account(), b = account();
    const ca = online(a);
    const r = await api(a, 'POST', '/api/social/friends/request', { name: b.name.toUpperCase() });
    expect(r.status).toBe(200);
    expect((await friendsOf(a))[0]).toMatchObject({ uid: b.uid, name: b.name, status: 'out', online: false });
    expect((await friendsOf(b))[0]).toMatchObject({ uid: a.uid, name: a.name, status: 'in', online: false });   // a está conectado, b aún no puede saberlo
    expect((await api(b, 'POST', '/api/social/friends/accept', { uid: a.uid })).j.msg).toContain(a.name);
    expect((await friendsOf(b))[0]).toMatchObject({ status: 'ok', online: true });
    expect((await api(a, 'DELETE', '/api/social/friends/' + b.uid)).status).toBe(200);
    expect(await friendsOf(a)).toEqual([]);
    expect(await friendsOf(b)).toEqual([]);
  });

  test('duplicadas: la segunda se rechaza; el que la recibe no la puede reenviar', async () => {
    const a = account(), b = account();
    expect((await api(a, 'POST', '/api/social/friends/request', { name: b.name })).status).toBe(200);
    const again = await api(a, 'POST', '/api/social/friends/request', { name: b.name });
    expect(again.status).toBe(409);
    expect((await friendsOf(a)).length).toBe(1);
    await api(b, 'POST', '/api/social/friends/accept', { uid: a.uid });
    expect((await api(a, 'POST', '/api/social/friends/request', { name: b.name })).status).toBe(409);
    expect((await api(b, 'POST', '/api/social/friends/request', { name: a.name })).status).toBe(409);
  });

  test('cruzadas y repetidas a la vez: una sola amistad confirmada, ningún 500', async () => {
    const a = account(), b = account();
    const rs = await Promise.all([
      ...Array.from({ length: 6 }, () => api(a, 'POST', '/api/social/friends/request', { name: b.name })),
      ...Array.from({ length: 6 }, () => api(b, 'POST', '/api/social/friends/request', { name: a.name })),
    ]);
    expect(rs.every(r => r.status < 500)).toBe(true);
    expect(rs.some(r => r.status === 200)).toBe(true);
    const fa = await friendsOf(a), fb = await friendsOf(b);
    expect(fa.length).toBe(1);
    expect(fb.length).toBe(1);
    expect(fa[0].status).toBe('ok');
    expect(fb[0].status).toBe('ok');
  });

  test('aceptar lo que no te mandaron: tu propia solicitud, una inexistente, o con un uid roto', async () => {
    const a = account(), b = account(), c = account();
    await api(a, 'POST', '/api/social/friends/request', { name: b.name });
    expect((await api(a, 'POST', '/api/social/friends/accept', { uid: b.uid })).status).toBe(404);   // la mandó él mismo
    expect((await api(c, 'POST', '/api/social/friends/accept', { uid: a.uid })).status).toBe(404);   // c no es el destinatario
    expect((await api(c, 'POST', '/api/social/friends/accept', { uid: '999999' })).status).toBe(404);
    for (const uid of ['abc', '-1', '0', '1e3', '1 OR 1', 5, null, '9'.repeat(30)]) {
      expect((await api(c, 'POST', '/api/social/friends/accept', { uid })).status).toBe(400);
    }
    expect((await friendsOf(a))[0].status).toBe('out');                                               // sigue pendiente
  });

  test('quitar amistades ajenas: no se puede y no se toca nada', async () => {
    const a = account(), b = account(), c = account();
    await befriend(a, b);
    // c no tiene ninguna relación con a ni b.
    expect((await api(c, 'DELETE', '/api/social/friends/' + a.uid)).status).toBe(404);
    expect((await api(c, 'DELETE', '/api/social/friends/' + b.uid)).status).toBe(404);
    for (const uid of ['x', '1%20OR%201', '0', '1.5']) expect((await api(c, 'DELETE', '/api/social/friends/' + uid)).status).toBe(400);
    expect((await friendsOf(a))[0]).toMatchObject({ uid: b.uid, status: 'ok' });
    expect((await friendsOf(b))[0]).toMatchObject({ uid: a.uid, status: 'ok' });
  });

  test('el rechazo y la cancelación borran la solicitud para los dos', async () => {
    const a = account(), b = account();
    await api(a, 'POST', '/api/social/friends/request', { name: b.name });
    expect((await api(b, 'DELETE', '/api/social/friends/' + a.uid)).status).toBe(200);   // rechazar
    expect(await friendsOf(a)).toEqual([]);
    await api(a, 'POST', '/api/social/friends/request', { name: b.name });
    expect((await api(a, 'DELETE', '/api/social/friends/' + b.uid)).status).toBe(200);   // cancelar
    expect(await friendsOf(b)).toEqual([]);
  });

  test('tope de solicitudes sin responder', async () => {
    const a = account();
    const targets = Array.from({ length: 31 }, () => account());
    let last = 0;
    for (const t of targets) last = (await api(a, 'POST', '/api/social/friends/request', { name: t.name })).status;
    expect(last).toBe(429);
    expect((await friendsOf(a)).length).toBe(30);
  });
});

describe('perfiles públicos', () => {
  const good = { favs: [{ dex: 25, shiny: true }, { dex: 6, shiny: false }], title: 'Coleccionista',
    best: { solo: 600, group: 300, level: 20, bosses: 3, legends: 1, kills: 9000, medals: 4 }, medals: ['own50', 'shiny1'] };

  test('se publica, se lee y el nombre es siempre el de la cuenta', async () => {
    const a = account(), b = account();
    expect((await api(a, 'PUT', '/api/social/profile', { ...good, name: 'Hacker', user_id: 1, __proto__: { x: 1 }, extra: 'y'.repeat(100) })).status).toBe(200);
    const p = (await api(b, 'GET', '/api/social/profile/' + a.uid)).j.profile;
    expect(p).toEqual({ name: a.name, ...good });
    expect(Object.keys(p).sort()).toEqual(['best', 'favs', 'medals', 'name', 'title']);
  });

  test('quien nunca publicó sale con marcas a cero; quien no existe, 404', async () => {
    const a = account(), b = account();
    const p = (await api(a, 'GET', '/api/social/profile/' + b.uid)).j.profile;
    expect(p).toMatchObject({ name: b.name, favs: [], title: '', medals: [] });
    expect(p.best.solo).toBe(0);
    expect((await api(a, 'GET', '/api/social/profile/99999999')).status).toBe(404);
    for (const x of ['abc', '1;DROP', '%00']) expect((await api(a, 'GET', '/api/social/profile/' + x)).status).toBe(400);
  });

  test.each([
    ['título con HTML', { title: '<img src=x onerror=alert(1)>' }],
    ['título con etiqueta suelta', { title: 'a>b' }],
    ['título largo', { title: 'a'.repeat(41) }],
    ['título con control', { title: 'a\u0000b' }],
    ['título no texto', { title: { $gt: '' } }],
    ['cuatro favoritos', { favs: [1, 2, 3, 4].map(dex => ({ dex, shiny: false })) }],
    ['favorito dex negativo', { favs: [{ dex: -1, shiny: false }] }],
    ['favorito dex enorme', { favs: [{ dex: 1e9, shiny: false }] }],
    ['favorito dex decimal', { favs: [{ dex: 1.5, shiny: false }] }],
    ['favorito dex texto', { favs: [{ dex: '25', shiny: false }] }],
    ['favorito shiny texto', { favs: [{ dex: 25, shiny: 'sí' }] }],
    ['favoritos no lista', { favs: 'pikachu' }],
    ['marca negativa', { best: { solo: -5 } }],
    ['marca decimal', { best: { solo: 1.5 } }],
    ['marca gigante', { best: { kills: 1e12 } }],
    ['marca texto', { best: { level: '9' } }],
    ['marcas lista', { best: [1, 2] }],
    ['nueve medallas', { medals: Array.from({ length: 9 }, (_, i) => 'm' + i) }],
    ['medalla con HTML', { medals: ['<b>x</b>'] }],
    ['medalla larga', { medals: ['m'.repeat(41)] }],
    ['medalla no texto', { medals: [1] }],
  ])('perfil no válido: %s', async (_, body) => {
    const a = account();
    expect((await api(a, 'PUT', '/api/social/profile', body)).status).toBe(400);
    expect((await api(a, 'GET', '/api/social/profile/' + a.uid)).j.profile.title).toBe('');   // y no quedó guardado nada
  });

  test('perfil gigante: 413, y el anterior se conserva', async () => {
    const a = account();
    await api(a, 'PUT', '/api/social/profile', good);
    const big = await call('PUT', '/api/social/profile', { title: 'x', medals: ['a'.repeat(200_000)] }, a.token);
    expect(big.status).toBe(413);
    expect((await call('PUT', '/api/social/profile', undefined, a.token, '{"title":' + '"a"'.repeat(10) + '}')).status).toBe(400);
    expect((await api(a, 'GET', '/api/social/profile/' + a.uid)).j.profile.title).toBe('Coleccionista');
  });

  test('un perfil ajeno no se puede escribir: PUT sólo toca el tuyo', async () => {
    const a = account(), b = account();
    await api(a, 'PUT', '/api/social/profile', good);
    await api(b, 'PUT', '/api/social/profile', { title: 'Mío' });
    expect((await api(a, 'GET', '/api/social/profile/' + a.uid)).j.profile.title).toBe('Coleccionista');
    expect((await api(a, 'PUT', '/api/social/profile/' + a.uid, { title: 'x' })).status).toBe(404);
  });
});

describe('WebSocket: conexión y mensajes', () => {
  test('sin token o con token falso no hay conexión', async () => {
    for (const q of ['', '?token=', '?token=falso', '?token=' + 'a'.repeat(43), '?token=' + 'x'.repeat(5000), "?token=' OR 1=1"]) {
      const r = await fetch(E.base + '/ws' + q);
      expect(r.status).toBe(401);
    }
    const a = account();
    expect((await fetch(`${E.base}/ws?token=${a.token}`)).status).toBe(400);      // buena sesión pero no es un WebSocket
    // (Que un WebSocket de verdad con token falso tampoco llega a abrirse: tests/realtime.smoke.test.ts.)
  });

  test('una sesión cerrada ya no abre WebSocket', async () => {
    const a = account();
    await api(a, 'POST', '/api/logout');
    expect((await fetch(`${E.base}/ws?token=${a.token}`)).status).toBe(401);
  });

  test('ping/pong y hello', async () => {
    const a = account();
    const c = online(a);
    expect(c.hello).toEqual({ k: 'hello', uid: a.uid, name: a.name, room: null });
    c.send({ k: 'ping' });
    c.take(m => m.k === 'pong');
  });

  test('mensajes rotos: se ignoran y la conexión sigue', async () => {
    const a = account();
    const c = online(a);
    for (const s of ['no json', '', '[]', 'null', '5', '"x"', '{}', '{"k":5}', '{"k":"nada"}', '{"k":null}', '{"k":"play","v":"sí"}',
      '{"k":"room.new","dex":"25","shiny":false}', '{"k":"room.join","id":{"$ne":1},"dex":1,"shiny":false}', '{"k":"inv","to":{"a":1}}',
      '{"k":"g"}', '{"k":"g","d":[1]}', '{"k":"g","d":"texto"}']) c.sendText(s);
    c.sendBinary(new Uint8Array([1, 2, 3]));
    expect(c.closed).toBeNull();
    c.send({ k: 'ping' });
    c.take(m => m.k === 'pong');
  });

  test('muchos mensajes rotos seguidos: se corta la conexión (1008)', async () => {
    const a = account(), other = account();
    const [c, o] = [online(a), online(other)];
    for (let i = 0; i < 80; i++) c.sendText('basura ' + i);
    expect(c.closed?.code).toBe(1008);
    o.send({ k: 'ping' });
    o.take(m => m.k === 'pong');                         // los demás ni se enteran
  });

  // El tope de 64 KB por mensaje lo aplica Bun, no el módulo: se comprueba con un WebSocket de verdad en tests/realtime.smoke.test.ts.

  test('inundación de pings: se descarta y se corta; los demás siguen', async () => {
    const a = account(), other = account();
    const [c, o] = [online(a), online(other)];
    for (let i = 0; i < 3000; i++) c.send({ k: 'ping' });
    expect(c.closed?.code).toBe(1008);
    expect(c.msgs.filter(m => m.k === 'pong').length).toBeLessThan(400);
    o.send({ k: 'ping' });
    o.take(m => m.k === 'pong');
  });

  test('tras una ráfaga normal el ritmo se recupera', async () => {
    const a = account();
    const c = online(a);
    for (let i = 0; i < 100; i++) c.send({ k: 'ping' });       // dentro de lo permitido
    expect(c.closed).toBeNull();
    expect(c.msgs.filter(m => m.k === 'pong').length).toBe(100);
    // Se agota el cubo (180 de golpe): el siguiente se descarta, y un rato después vuelve a haber hueco (90 por segundo).
    for (let i = 0; i < 80; i++) c.send({ k: 'ping' });
    c.send({ k: 'ping' });
    expect(c.msgs.filter(m => m.k === 'pong').length).toBe(180);
    advance(1000);
    for (let i = 0; i < 90; i++) c.send({ k: 'ping' });
    expect(c.closed).toBeNull();
    expect(c.msgs.filter(m => m.k === 'pong').length).toBe(270);
  });

  test('la misma cuenta en otra pestaña: la nueva manda y la vieja se cierra (4001)', async () => {
    const a = account();
    const c1 = online(a);
    const c2 = online(a);
    expect(c1.closed?.code).toBe(4001);
    c2.send({ k: 'ping' });
    c2.take(m => m.k === 'pong');
  });
});

describe('presencia', () => {
  test('los amigos ven cuándo te conectas, juegas y te desconectas; los extraños no ven nada', async () => {
    const a = account(), b = account(), x = account();
    await befriend(a, b);
    const [cb, cx] = [online(b), online(x)];
    const ca = online(a);
    expect(cb.take(m => m.k === 'pres' && m.uid === a.uid)).toMatchObject({ online: true, play: false, room: '' });
    ca.send({ k: 'play', v: true });
    expect(cb.take(m => m.k === 'pres' && m.uid === a.uid && m.play)).toMatchObject({ online: true, play: true });
    expect((await friendsOf(b))[0]).toMatchObject({ online: true, play: true });
    ca.close();
    const off = cb.take(m => m.k === 'pres' && m.uid === a.uid && !m.online);
    expect(off.seen).toBe(E.clock.t);
    expect((await friendsOf(b))[0]).toMatchObject({ online: false, play: false });
    expect((await friendsOf(b))[0].seen).toBe(E.clock.t);
    cx.none(m => m.k === 'pres');
  });

  test('dejar de ser amigos corta la presencia', async () => {
    const a = account(), b = account();
    await befriend(a, b);
    const cb = online(b);
    await api(a, 'DELETE', '/api/social/friends/' + b.uid);
    cb.take(m => m.k === 'fr');
    const ca = online(a);
    cb.none(m => m.k === 'pres');
  });
});

describe('salas', () => {
  test('crear, invitar, entrar, salir', async () => {
    const h = account(), g = account();
    await befriend(h, g);
    const [hc, gc] = [online(h), online(g)];
    const room = hc.req({ k: 'room.new', dex: 25, shiny: true }).room;
    expect(room).toMatchObject({ host: h.uid, open: true, members: [{ uid: h.uid, name: h.name, dex: 25, shiny: true }] });
    expect(hc.req({ k: 'room.new', dex: 1, shiny: false }).room.id).toBe(room.id);   // idempotente
    expect(hc.req({ k: 'inv', to: g.uid })).toMatchObject({ ok: true });
    expect(gc.take(m => m.k === 'inv')).toMatchObject({ from: h.uid, name: h.name, room: room.id });
    const j = gc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false });
    expect(j.room.members.map((m: any) => m.uid)).toEqual([h.uid, g.uid]);                    // el anfitrión primero
    expect(hc.take(m => m.k === 'room' && m.room?.members.length === 2).room.members[1]).toMatchObject({ name: g.name, dex: 4 });
    expect((await friendsOf(g))[0].room).toBe(room.id);
    gc.req({ k: 'room.me', dex: 7, shiny: true });
    expect(hc.take(m => m.k === 'room' && m.room?.members[1].dex === 7).room.members[1].shiny).toBe(true);
    gc.req({ k: 'room.leave' });
    expect(hc.take(m => m.k === 'room' && m.room?.members.length === 1).room.host).toBe(h.uid);
  });

  test('entrar sin invitación, aun conociendo el id de la sala', async () => {
    const h = account(), friend = account(), stranger = account();
    await befriend(h, friend);
    const [hc, fc, sc] = [online(h), online(friend), online(stranger)];
    const room = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
    expect(fc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(false);   // amigo, pero sin invitación
    expect(sc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(false);
    expect(sc.req({ k: 'room.join', id: 'noexiste-0000', dex: 4, shiny: false }).ok).toBe(false);
    expect(sc.req({ k: 'room.join', id: "x' OR 1=1", dex: 4, shiny: false }).ok).toBe(false);
    hc.none(m => m.k === 'room' && m.room.members.length > 1);
  });

  test('invitar a quien no es tu amigo, a ti mismo, sin sala o con datos rotos', async () => {
    const h = account(), stranger = account(), pending = account();
    await api(h, 'POST', '/api/social/friends/request', { name: pending.name });           // solicitud sin aceptar
    const [hc, sc, pc] = [online(h), online(stranger), online(pending)];
    expect(hc.req({ k: 'inv', to: stranger.uid }).error).toContain('sala');          // aún sin sala
    hc.req({ k: 'room.new', dex: 25, shiny: false });
    for (const to of [stranger.uid, pending.uid, h.uid, '999999']) expect(hc.req({ k: 'inv', to }).ok).toBe(false);
    for (const to of [5, null, {}, '-1', 'abc']) expect(hc.req({ k: 'inv', to }).ok).toBe(false);
    sc.none(m => m.k === 'inv');
    pc.none(m => m.k === 'inv');
  });

  test('un invitado no puede gobernar la sala', async () => {
    const h = account(), g = account(), g2 = account();
    const { hc, gcs, room } = await roomWith(h, [g, g2]);
    const [gc, g2c] = gcs;
    expect(gc.req({ k: 'room.open', v: false }).ok).toBe(false);
    expect(gc.req({ k: 'inv', to: h.uid }).ok).toBe(false);
    // Tampoco puede mandar "empieza la partida" a los demás.
    gc.send({ k: 'g', d: { k: 'start', seed: 1, host: g.uid, members: [] } });
    gc.send({ k: 'g', to: h.uid, d: { k: 'start', seed: 1, host: g.uid, members: [] } });
    gc.take(m => m.k === 'err');
    hc.none(m => m.k === 'g' && m.d.k === 'start');
    g2c.none(m => m.k === 'g' && m.d.k === 'start');
    hc.none(m => m.k === 'room' && m.room?.open === false);   // la sala sigue abierta
    expect(room.id).toBeTruthy();
    // El anfitrión sí.
    hc.req({ k: 'room.open', v: false });
    expect(gc.take(m => m.k === 'room' && m.room?.open === false).room.open).toBe(false);
    hc.send({ k: 'g', d: { k: 'start', seed: 7, host: h.uid, members: [] } });
    expect(gc.take(m => m.k === 'g' && m.d.k === 'start').f).toBe(h.uid);
    expect(g2c.take(m => m.k === 'g' && m.d.k === 'start').d.seed).toBe(7);
  });

  test('quinto jugador en una sala llena', async () => {
    const h = account(), gs = [account(), account(), account()], fifth = account();
    const { hc, gcs, room } = await roomWith(h, gs);
    await befriend(h, fifth);
    const fc = online(fifth);
    expect(room.members.length).toBe(1);
    expect(hc.req({ k: 'inv', to: fifth.uid }).ok).toBe(false);                         // sala llena: ni se invita
    fc.none(m => m.k === 'inv');
    // Y si le invitaron cuando había sitio y se llenó antes de que entrara:
    const h2 = account(), a2 = account(), b2 = account(), c2 = account(), d2 = account(), late = account();
    for (const x of [a2, b2, c2, d2, late]) await befriend(h2, x);
    const h2c = online(h2);
    const r2 = h2c.req({ k: 'room.new', dex: 25, shiny: false }).room;
    const cs: Client[] = [];
    for (const x of [a2, b2, c2, late]) { const c = online(x); cs.push(c); h2c.req({ k: 'inv', to: x.uid }); c.take(m => m.k === 'inv'); }
    for (const c of cs.slice(0, 3)) expect(c.req({ k: 'room.join', id: r2.id, dex: 4, shiny: false }).ok).toBe(true);
    const late2 = cs[3].req({ k: 'room.join', id: r2.id, dex: 4, shiny: false });
    expect(late2.ok).toBe(false);
    expect(late2.error).toContain('llena');
    expect(h2c.take(m => m.k === 'room' && m.room?.members.length === 4).room.members.length).toBe(4);
    h2c.none(m => m.k === 'room' && m.room?.members.length > 4);
  });

  test('sala cerrada (partida empezada): nadie nuevo, ni con invitación', async () => {
    const h = account(), g = account(), late = account();
    const { hc, gcs } = await roomWith(h, [g]);
    await befriend(h, late);
    const lc = online(late);
    hc.req({ k: 'inv', to: late.uid });
    const inv = lc.take(m => m.k === 'inv');
    hc.req({ k: 'room.open', v: false });
    expect(hc.req({ k: 'inv', to: late.uid }).ok).toBe(false);
    const j = lc.req({ k: 'room.join', id: inv.room, dex: 4, shiny: false });
    expect(j.ok).toBe(false);
    expect(j.error).toContain('empezado');
  });

  test('hablar en una sala de la que no eres miembro', async () => {
    const h = account(), g = account(), outsider = account(), h2 = account(), g2 = account();
    const r1 = await roomWith(h, [g]);
    const r2 = await roomWith(h2, [g2]);
    const oc = online(outsider);
    // Sin sala: no llega nada a nadie.
    oc.send({ k: 'g', d: { k: 'f', p: [1] } });
    oc.send({ k: 'g', to: h.uid, d: { k: 'f', p: [1] } });
    // En otra sala, dirigido a un miembro de la primera (se conoce su uid): tampoco.
    r2.hc.send({ k: 'g', to: g.uid, d: { k: 'f', p: [2] } });
    r2.gcs[0].send({ k: 'g', to: h.uid, d: { k: 'f', p: [3] } });
    expect(typeof r2.hc.take(m => m.k === 'err').error).toBe('string');
    expect(typeof r2.gcs[0].take(m => m.k === 'err').error).toBe('string');
    r1.hc.none(m => m.k === 'g');
    r1.gcs[0].none(m => m.k === 'g');
    // Dentro de su sala sí llega, y sólo a los de su sala.
    r1.hc.send({ k: 'g', d: { k: 'f', p: [4] } });
    expect(r1.gcs[0].take(m => m.k === 'g').d.p).toEqual([4]);
    r2.hc.none(m => m.k === 'g' && m.f === h.uid);
    r2.gcs[0].none(m => m.k === 'g' && m.f === h.uid);
  });

  test('relé de partida: de uno a otro y a todos, con el remitente puesto por el servidor', async () => {
    const h = account(), gs = [account(), account()];
    const { hc, gcs } = await roomWith(h, gs);
    const [g1, g2] = gcs;
    // Un invitado no puede hacerse pasar por otro: el campo `f` lo pone el servidor.
    g1.send({ k: 'g', to: h.uid, f: gs[1].uid, d: { k: 'f', p: [1] } });
    expect(hc.take(m => m.k === 'g')).toEqual({ k: 'g', f: gs[0].uid, d: { k: 'f', p: [1] } });
    g2.none(m => m.k === 'g');                                  // dirigido: sólo al anfitrión
    hc.send({ k: 'g', d: { k: 'f', ev: [['ne', 1]] } });              // a todos
    for (const c of gcs) expect(c.take(m => m.k === 'g').d.ev).toEqual([['ne', 1]]);
    hc.none(m => m.k === 'g');                                  // y no se devuelve al remitente
    hc.send({ k: 'g', to: h.uid, d: { k: 'f' } });                    // a ti mismo no
    hc.take(m => m.k === 'err');
    hc.send({ k: 'g', to: '999999', d: { k: 'f' } });                 // a quien no está en la sala, no
    hc.take(m => m.k === 'err');
  });

  test('un mensaje de partida de buen tamaño pasa entero; los enormes (por bytes) se frenan', async () => {
    const h = account(), g = account();
    const { hc, gcs } = await roomWith(h, [g]);
    const e = Array.from({ length: 300 }, (_, i) => [i, 1000 + i, -2000 - i, 100, 1, 0, 0]);
    hc.send({ k: 'g', to: g.uid, d: { k: 'f', e } });
    expect(gcs[0].take(m => m.k === 'g').d.e.length).toBe(300);
    // 120 mensajes de 60 KB seguidos (7 MB): el cubo de bytes deja pasar sólo una parte.
    const pad = 'x'.repeat(60_000);
    for (let i = 0; i < 120; i++) gcs[0].send({ k: 'g', to: h.uid, d: { k: 'f', pad } });
    const got = hc.msgs.filter(m => m.k === 'g').length;
    expect(got).toBeGreaterThan(5);
    expect(got).toBeLessThan(70);
  });

  test('inundación dentro de una sala: no llega ni la décima parte y el que inunda se va', async () => {
    const h = account(), g = account();
    const { hc, gcs } = await roomWith(h, [g]);
    for (let i = 0; i < 4000; i++) gcs[0].send({ k: 'g', to: h.uid, d: { k: 'f', i } });
    expect(gcs[0].closed?.code).toBe(1008);
    expect(hc.msgs.filter(m => m.k === 'g').length).toBeLessThan(400);
    // El anfitrión sigue bien y la sala sigue viva sin el que inundaba (que, cortado, sale al acabarse su plazo).
    advance(GRACE);
    expect(hc.take(m => m.k === 'room' && m.room?.members.length === 1).room.host).toBe(h.uid);
    hc.send({ k: 'ping' });
    hc.take(m => m.k === 'pong');
  });
});

describe('invitaciones', () => {
  test('caducan: ya no se puede entrar y el invitado es avisado', async () => {
    fresh({ realtime: { inviteTtl: 400 } });
    const h = account(), g = account();
    await befriend(h, g);
    const [hc, gc] = [online(h), online(g)];
    const room = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
    hc.req({ k: 'inv', to: g.uid });
    gc.take(m => m.k === 'inv');
    advance(300);
    gc.none(m => m.k === 'invx');                                // aún vale
    advance(600);
    gc.take(m => m.k === 'invx' && m.from === h.uid);
    const j = gc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false });
    expect(j.ok).toBe(false);
    expect(hc.req({ k: 'inv', to: g.uid }).ok).toBe(true);      // se puede volver a invitar
    gc.take(m => m.k === 'inv');
    expect(gc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(true);
  });

  test('una invitación sólo vale una vez', async () => {
    const h = account(), g = account();
    const { hc, gcs, room } = await roomWith(h, [g]);
    gcs[0].req({ k: 'room.leave' });
    expect(gcs[0].req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(false);
  });

  test('si dejáis de ser amigos, la invitación se retira y no vale', async () => {
    const h = account(), g = account();
    await befriend(h, g);
    const [hc, gc] = [online(h), online(g)];
    const room = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
    hc.req({ k: 'inv', to: g.uid });
    gc.take(m => m.k === 'inv');
    await api(g, 'DELETE', '/api/social/friends/' + h.uid);
    gc.take(m => m.k === 'invx');
    expect(gc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(false);
  });

  test('invitaciones al por mayor: hay un tope por anfitrión', async () => {
    const h = account();
    const gs = Array.from({ length: 10 }, () => account());
    for (const g of gs) await befriend(h, g);
    const hc = online(h);
    hc.req({ k: 'room.new', dex: 25, shiny: false });
    const oks = [];
    for (const g of gs) oks.push(hc.req({ k: 'inv', to: g.uid }).ok);
    expect(oks.filter(Boolean).length).toBe(8);
  });

  test('rechazar retira la invitación', async () => {
    const h = account(), g = account();
    await befriend(h, g);
    const [hc, gc] = [online(h), online(g)];
    const room = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
    hc.req({ k: 'inv', to: h.uid === g.uid ? g.uid : g.uid });
    gc.take(m => m.k === 'inv');
    gc.req({ k: 'inv.no', from: h.uid });
    expect(gc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(false);
  });

  test('la invitación espera si el amigo no estaba conectado', async () => {
    const h = account(), g = account();
    await befriend(h, g);
    const hc = online(h);
    const room = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
    expect(hc.req({ k: 'inv', to: g.uid }).ok).toBe(true);
    const gc = online(g);
    expect(gc.take(m => m.k === 'inv').room).toBe(room.id);
  });
});

describe('caídas y cuentas borradas', () => {
  test('el anfitrión se cae de golpe y no vuelve: tras el plazo la sala se cierra para todos y sus amigos lo ven desconectado', async () => {
    const h = account(), gs = [account(), account()], watcher = account();
    await befriend(h, watcher);
    const wc = online(watcher);
    const { hc, gcs, room } = await roomWith(h, gs);
    hc.kill();
    expect(wc.take(m => m.k === 'pres' && m.uid === h.uid && !m.online).uid).toBe(h.uid);       // sus amigos lo ven desconectado en el acto
    for (const c of gcs) expect(c.take(m => m.k === 'room' && m.room?.members[0].away === true)).toBeTruthy();   // y los suyos, ausente
    advance(GRACE - 1);
    for (const c of gcs) c.none(m => m.k === 'room' && m.room === null);                          // aún tiene su plazo
    advance(1);
    for (const c of gcs) expect(c.take(m => m.k === 'room' && m.room === null)).toMatchObject({ why: 'timeout' });      // el anfitrión no volvió en el plazo
    expect(wc.take(m => m.k === 'pres' && m.uid === h.uid && !m.online).uid).toBe(h.uid);
    // La sala ya no existe: entrar con la invitación (retirada) no funciona.
    expect(gcs[0].req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(false);
    // Los invitados siguen conectados y pueden montar la suya.
    expect(gcs[0].req({ k: 'room.new', dex: 1, shiny: false }).ok).toBe(true);
  });

  test('un invitado se cae de golpe: la sala sigue con los demás', async () => {
    const h = account(), gs = [account(), account()];
    const { hc, gcs } = await roomWith(h, gs);
    hc.take(m => m.k === 'room' && m.room?.members.length === 3);
    gcs[0].kill();
    expect(hc.take(m => m.k === 'room' && m.room?.members.some((x: any) => x.uid === gs[0].uid && x.away)).room.members.length).toBe(3);   // ausente, aún en la sala
    advance(GRACE);
    const r = hc.take(m => m.k === 'room' && m.room?.members.length === 2 && !m.room.members.some((x: any) => x.uid === gs[0].uid));
    expect(r.room.members.map((m: any) => m.uid)).toEqual([h.uid, gs[1].uid]);
    expect(r.room.host).toBe(h.uid);
    hc.send({ k: 'g', d: { k: 'f' } });
    gcs[1].take(m => m.k === 'g');
  });

  test('el anfitrión sale por su pie: lo mismo, y le dice a los suyos que se cerró', async () => {
    const h = account(), g = account();
    const { hc, gcs } = await roomWith(h, [g]);
    expect(hc.req({ k: 'room.leave' }).ok).toBe(true);
    expect(gcs[0].take(m => m.k === 'room' && m.room === null).why).toBe('left');
    gcs[0].send({ k: 'g', d: { k: 'f' } });
    gcs[0].take(m => m.k === 'err');                       // ya no están en ninguna sala
  });

  test('borrar la cuenta de un invitado: desaparece de amistades y de la sala', async () => {
    const h = account(), g = account(), g2 = account();
    const { hc, gcs } = await roomWith(h, [g, g2]);
    expect((await friendsOf(h)).map(f => f.uid).sort()).toEqual([g.uid, g2.uid].sort());
    const del = await call('DELETE', '/api/account', { pass: 'secreta1' }, g.token);
    expect(del.status).toBe(200);
    expect(gcs[0].closed?.code).toBe(4002);
    const r = hc.take(m => m.k === 'room' && m.room?.members.length === 2 && !m.room.members.some((x: any) => x.uid === g.uid));
    expect(r.room.members.map((m: any) => m.uid)).toEqual([h.uid, g2.uid]);
    hc.take(m => m.k === 'fr');
    expect((await friendsOf(h)).map(f => f.uid)).toEqual([g2.uid]);
    expect((await api(h, 'GET', '/api/social/profile/' + g.uid)).status).toBe(404);
    expect((await api(h, 'POST', '/api/social/friends/request', { name: g.name })).status).toBe(404);
    expect((await call('POST', '/api/login', { name: g.name, pass: 'secreta1' })).status).toBe(401);
    expect((await fetch(`${E.base}/ws?token=${g.token}`)).status).toBe(401);
  });

  test('borrar la cuenta del anfitrión: la sala se cierra y sus invitaciones se retiran', async () => {
    const h = account(), g = account(), pending = account();
    const { hc, gcs } = await roomWith(h, [g]);
    await befriend(h, pending);
    const pc = online(pending);
    hc.req({ k: 'inv', to: pending.uid });
    pc.take(m => m.k === 'inv');
    expect((await call('DELETE', '/api/account', { pass: 'secreta1' }, h.token)).status).toBe(200);
    expect(gcs[0].take(m => m.k === 'room' && m.room === null).why).toBe('closed');
    pc.take(m => m.k === 'invx');
    expect(await friendsOf(g)).toEqual([]);
    expect(await friendsOf(pending)).toEqual([]);
  });

  test('borrar la cuenta con solicitudes pendientes no deja filas colgando', async () => {
    const a = account(), b = account(), c = account();
    await api(a, 'POST', '/api/social/friends/request', { name: b.name });
    await api(c, 'POST', '/api/social/friends/request', { name: a.name });
    await api(a, 'PUT', '/api/social/profile', { title: 'Hola' });
    await call('DELETE', '/api/account', { pass: 'secreta1' }, a.token);
    expect(await friendsOf(b)).toEqual([]);
    expect(await friendsOf(c)).toEqual([]);
    const raw = rawDb();
    expect(raw.query('SELECT COUNT(*) AS n FROM friendships WHERE a = ?1 OR b = ?1').get(Number(a.uid))).toEqual({ n: 0 });
    expect(raw.query('SELECT COUNT(*) AS n FROM profiles WHERE user_id = ?').get(Number(a.uid))).toEqual({ n: 0 });
  });
});

// ====================================================================
// Reconexión, persistencia en SQLite, reinicios y marcas de grupo
// ====================================================================

const roomRow = (id: string) => rawDb().query('SELECT id, host_id, open, started FROM rooms WHERE id = ?').get(id) as { id: string; host_id: number; open: number; started: number } | null;
const memberIds = (id: string) => (rawDb().query('SELECT user_id FROM room_members WHERE room_id = ? ORDER BY joined').all(id) as { user_id: number }[]).map(r => String(r.user_id));
const allAway = (m: any, away: boolean) => m.k === 'room' && m.room && m.room.members.every((x: any) => x.away === away);

describe('reconexión a la sala', () => {
  test('un invitado se corta y vuelve a tiempo: conserva su sitio y los demás lo ven ausente y de vuelta', async () => {
    const h = account(), g = account();
    const { hc, gcs, room } = await roomWith(h, [g]);
    gcs[0].kill();
    const gone = hc.take(m => m.k === 'room' && m.room?.members.some((x: any) => x.uid === g.uid && x.away));
    expect(gone.room.members.length).toBe(2);                       // sigue en la sala, sólo ausente
    hc.send({ k: 'g', to: g.uid, d: { k: 'f', p: [1] } });          // lo que se manda a un ausente se pierde
    advance(GRACE - 1);                                              // vuelve en el último momento
    const back = online(g);
    expect(back.hello.room).toMatchObject({ id: room.id, host: h.uid, open: true, started: false });
    expect(back.hello.room.members.map((m: any) => [m.uid, m.away])).toEqual([[h.uid, false], [g.uid, false]]);
    hc.take(m => allAway(m, false));
    back.none(m => m.k === 'g');
    back.send({ k: 'g', to: h.uid, d: { k: 'f', p: [2] } });
    expect(hc.take(m => m.k === 'g').d.p).toEqual([2]);
    // Pasado el plazo sigue dentro: ya no hay cuenta atrás.
    advance(GRACE);
    expect(back.req({ k: 'room.me', dex: 9, shiny: false }).ok).toBe(true);
    expect(hc.take(m => m.k === 'room' && m.room?.members[1]?.dex === 9).room.members.length).toBe(2);
  });

  test('un invitado que no vuelve en el plazo sale de la sala; si reconecta tarde, la sala ya no es suya', async () => {
    const h = account(), g = account(), g2 = account();
    const { hc, gcs, room } = await roomWith(h, [g, g2]);
    gcs[0].kill();
    advance(GRACE - 1);
    expect(memberIds(room.id)).toEqual([h.uid, g.uid, g2.uid]);      // aún no ha vencido
    advance(1);
    hc.take(m => m.k === 'room' && m.room?.members.length === 2 && !m.room.members.some((x: any) => x.uid === g.uid));
    expect(memberIds(room.id)).toEqual([h.uid, g2.uid]);
    const late = online(g);
    expect(late.hello.room).toBeNull();
    late.send({ k: 'g', to: h.uid, d: { k: 'f', p: [1] } });
    late.take(m => m.k === 'err');
    hc.none(m => m.k === 'g');
    expect(late.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(false);   // sin invitación nueva
    expect(late.req({ k: 'room.open', v: false }).ok).toBe(false);
    expect(late.req({ k: 'room.leave' }).ok).toBe(true);                                      // dejar lo que no tienes no rompe nada
    hc.none(m => m.k === 'room' && m.room === null);
    gcs[1].send({ k: 'ping' });
    gcs[1].take(m => m.k === 'pong');
  });

  test('el anfitrión se corta y vuelve a tiempo: la sala sigue con el mismo id y los invitados la ven viva', async () => {
    const h = account(), g = account();
    const { hc, gcs, room } = await roomWith(h, [g]);
    hc.kill();
    gcs[0].take(m => m.k === 'room' && m.room?.members[0].away === true);
    const back = online(h);
    expect(back.hello.room).toMatchObject({ id: room.id, host: h.uid });
    gcs[0].take(m => allAway(m, false));
    advance(GRACE);                                                  // pasa el plazo de antes: nadie lo cierra
    back.send({ k: 'g', d: { k: 'f', p: [3] } });
    expect(gcs[0].take(m => m.k === 'g').d.p).toEqual([3]);
    expect(back.req({ k: 'room.open', v: false }).ok).toBe(true);                             // y sigue siendo el anfitrión
    expect(roomRow(room.id)).toMatchObject({ host_id: Number(h.uid), open: 0 });
  });

  test('el anfitrión no vuelve: tras el plazo la sala desaparece de la base y, si reconecta, no tiene sala', async () => {
    const h = account(), g = account();
    const { hc, gcs, room } = await roomWith(h, [g]);
    hc.kill();
    advance(GRACE);
    expect(gcs[0].take(m => m.k === 'room' && m.room === null)).toMatchObject({ why: 'timeout' });
    expect(roomRow(room.id)).toBeNull();
    expect(memberIds(room.id)).toEqual([]);
    const late = online(h);
    expect(late.hello.room).toBeNull();
    expect(gcs[0].req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(false);
  });

  test('con el token de otra cuenta no se hereda nada: cada conexión es de su dueño', async () => {
    const h = account(), g = account(), x = account();
    const { hc, gcs, room } = await roomWith(h, [g]);
    gcs[0].kill();                                                    // g está ausente, su sitio está guardado
    const cx = online(x);
    expect(cx.hello).toMatchObject({ uid: x.uid, name: x.name, room: null });
    // x intenta colarse, hablar, gobernar o ocupar el sitio de g.
    expect(cx.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(false);
    expect(cx.req({ k: 'room.open', v: false }).ok).toBe(false);
    expect(cx.req({ k: 'room.me', dex: 1, shiny: false }).ok).toBe(false);
    expect(cx.req({ k: 'inv', to: h.uid }).ok).toBe(false);
    cx.send({ k: 'g', to: h.uid, d: { k: 'f' } });
    cx.take(m => m.k === 'err');
    hc.none(m => m.k === 'g');
    expect(memberIds(room.id)).toEqual([h.uid, g.uid]);              // el sitio de g sigue siendo de g
    const back = online(g);
    expect(back.hello.room.id).toBe(room.id);
  });

  test('con una partida en grupo en marcha, la pestaña nueva se rechaza (4003) y la partida sigue', async () => {
    const h = account(), g = account();
    const { hc, gcs, room } = await roomWith(h, [g]);
    hc.send({ k: 'play', v: true });
    gcs[0].send({ k: 'play', v: true });
    hc.send({ k: 'g', d: { k: 'start', seed: 7, host: h.uid, members: [{ uid: g.uid }] } });
    const extra = new Client(E, h);
    expect(extra.closed?.code).toBe(4003);
    expect(hc.closed).toBeNull();
    advance(GRACE);
    expect(memberIds(room.id)).toEqual([h.uid, g.uid]);
    hc.send({ k: 'g', to: g.uid, d: { k: 'f', p: [9] } });
    expect(gcs[0].take(m => m.k === 'g' && m.d.k === 'f').d.p).toEqual([9]);
  });

  test('la misma cuenta en otra pestaña hereda la sala sin que nadie se entere de una salida', async () => {
    const h = account(), g = account();
    const { hc, gcs, room } = await roomWith(h, [g]);
    const c2 = online(g);
    expect(gcs[0].closed?.code).toBe(4001);
    expect(c2.hello.room.id).toBe(room.id);
    advance(GRACE);                                                   // la pestaña vieja al cerrarse NO arranca la cuenta atrás
    expect(memberIds(room.id)).toEqual([h.uid, g.uid]);
    hc.none(m => m.k === 'room' && (m.room === null || m.room.members.length < 2));
    c2.send({ k: 'g', to: h.uid, d: { k: 'f', p: [4] } });
    expect(hc.take(m => m.k === 'g').d.p).toEqual([4]);
  });

  test('borrar la cuenta de alguien ausente lo quita de la sala y de la base', async () => {
    const h = account(), g = account();
    const { hc, gcs, room } = await roomWith(h, [g]);
    gcs[0].kill();
    hc.take(m => m.k === 'room' && m.room?.members.some((x: any) => x.away));
    expect((await call('DELETE', '/api/account', { pass: 'secreta1' }, g.token)).status).toBe(200);
    hc.take(m => m.k === 'room' && m.room?.members.length === 1);
    expect(memberIds(room.id)).toEqual([h.uid]);
    expect(rawDb().query('SELECT COUNT(*) AS n FROM room_members WHERE user_id = ?').get(Number(g.uid))).toEqual({ n: 0 });
  });

  test('una segunda caída, tras volver, tiene su plazo entero (el de la primera ya no cuenta)', async () => {
    const h = account(), g = account();
    const { hc, gcs, room } = await roomWith(h, [g]);
    gcs[0].kill();
    advance(GRACE - 15_000);
    const back = online(g);                                           // vuelve a tiempo...
    back.kill();                                                      // ...y se cae otra vez
    advance(GRACE - 1);                                               // pasado el plazo de la primera caída, no el de la segunda
    expect(memberIds(room.id)).toEqual([h.uid, g.uid]);
    advance(1);
    hc.take(m => m.k === 'room' && m.room?.members.length === 1);
    expect(memberIds(room.id)).toEqual([h.uid]);
  });

  test('reconexiones en bucle: la sala aguanta y no se duplica nadie', async () => {
    const h = account(), g = account();
    const { hc, gcs, room } = await roomWith(h, [g]);
    let c = gcs[0];
    for (let i = 0; i < 8; i++) { c.kill(); c = online(g); expect(c.hello.room.id).toBe(room.id); }
    advance(GRACE);
    expect(memberIds(room.id)).toEqual([h.uid, g.uid]);
  });
});

describe('la sala en SQLite', () => {
  test('se guarda al crearla, cambia con ella y se borra al cerrarse', async () => {
    const h = account(), g = account();
    const { hc, gcs, room } = await roomWith(h, [g]);
    expect(roomRow(room.id)).toEqual({ id: room.id, host_id: Number(h.uid), open: 1, started: 0 });
    expect(memberIds(room.id)).toEqual([h.uid, g.uid]);
    hc.req({ k: 'room.open', v: false });
    expect(roomRow(room.id)!.open).toBe(0);
    hc.send({ k: 'g', d: { k: 'start', seed: 1, host: h.uid, members: [{ uid: h.uid }, { uid: g.uid }] } });
    gcs[0].take(m => m.k === 'g' && m.d.k === 'start');
    expect(roomRow(room.id)!.started).toBe(E.clock.t);
    const snap = gcs[0].take(m => m.k === 'room' && m.room?.started === true);
    expect(snap.room.open).toBe(false);
    hc.req({ k: 'room.open', v: true });                        // la partida terminó y la sala se reabre
    expect(roomRow(room.id)).toMatchObject({ open: 1, started: 0 });
    gcs[0].req({ k: 'room.leave' });
    expect(memberIds(room.id)).toEqual([h.uid]);
    hc.req({ k: 'room.leave' });
    expect(roomRow(room.id)).toBeNull();
  });

  test('una sala se marca como viva cada minuto mientras alguien siga conectado', async () => {
    const h = account(), g = account();
    const { room } = await roomWith(h, [g]);
    const updated = () => (rawDb().query('SELECT updated FROM rooms WHERE id = ?').get(room.id) as { updated: number }).updated;
    const t0 = E.clock.t;
    expect(updated()).toBe(t0);
    advance(59_999);
    expect(updated()).toBe(t0);
    advance(1);
    expect(updated()).toBe(t0 + 60_000);
  });

  test('una cuenta no puede estar en dos salas ni una sala tener dos anfitriones (restricciones de la base)', async () => {
    const h1 = account(), g = account(), h2 = account();
    const r1 = await roomWith(h1, [g]);
    const hc2 = online(h2);
    const room2 = hc2.req({ k: 'room.new', dex: 25, shiny: false }).room;
    expect(() => rawDb().run('INSERT INTO room_members (room_id, user_id, dex, shiny, joined) VALUES (?, ?, 1, 0, 9)', [room2.id, Number(g.uid)])).toThrow();
    expect(() => rawDb().run('INSERT INTO rooms (id, host_id, open, started, created, updated) VALUES (?, ?, 1, 0, 0, 0)', ['otra-sala-1234', Number(h1.uid)])).toThrow();
  });

  test('entrar en otra sala deja la anterior', async () => {
    const h1 = account(), g = account(), h2 = account();
    const r1 = await roomWith(h1, [g]);
    await befriend(h2, g);
    const hc2 = online(h2);
    const room2 = hc2.req({ k: 'room.new', dex: 25, shiny: false }).room;
    hc2.req({ k: 'inv', to: g.uid });
    r1.gcs[0].take(m => m.k === 'inv' && m.room === room2.id);
    expect(r1.gcs[0].req({ k: 'room.join', id: room2.id, dex: 4, shiny: false }).ok).toBe(true);
    expect(memberIds(r1.room.id)).toEqual([h1.uid]);
    expect(memberIds(room2.id)).toEqual([h2.uid, g.uid]);
  });
});

describe('reinicio del servidor', () => {
  // Base en archivo, para que las salas sobrevivan al reinicio; el reloj sigue donde estaba.
  beforeEach(() => { fresh({ file: true }); });

  test('las salas vuelven: los miembros reconectan a la misma sala y la partida empezada sigue constando', async () => {
    const h = account(), g = account();
    const { hc, gcs, room } = await roomWith(h, [g]);
    hc.send({ k: 'g', d: { k: 'start', seed: 1, host: h.uid, members: [{ uid: h.uid }, { uid: g.uid }] } });
    gcs[0].take(m => m.k === 'g' && m.d.k === 'start');
    E.restart();
    expect(hc.closed?.code).toBeDefined();
    const hc2 = online(h);
    expect(hc2.hello.room).toMatchObject({ id: room.id, host: h.uid, started: true, open: false });
    expect(hc2.hello.room.members.map((m: any) => [m.uid, m.away])).toEqual([[h.uid, false], [g.uid, true]]);   // g aún no ha vuelto
    const gc2 = online(g);
    expect(gc2.hello.room.id).toBe(room.id);
    hc2.take(m => allAway(m, false));
    hc2.send({ k: 'g', to: g.uid, d: { k: 'f', p: [7] } });
    expect(gc2.take(m => m.k === 'g').d.p).toEqual([7]);
    // El equipo de la partida está en la base: la marca de grupo sigue siendo posible.
    expect(E.rt.verifyTeam(Number(h.uid), [Number(h.uid), Number(g.uid)], E.clock.t)).toBe(true);
    // Ya han vuelto los dos: nadie tiene cuenta atrás.
    advance(GRACE);
    expect(memberIds(room.id)).toEqual([h.uid, g.uid]);
    hc2.close(); gc2.close();
  });

  test('si el anfitrión no vuelve tras el reinicio, la sala se cierra para los que sí volvieron', async () => {
    const h = account(), g = account();
    const { room } = await roomWith(h, [g]);
    E.restart();
    const gc2 = online(g);
    expect(gc2.hello.room.id).toBe(room.id);
    expect(gc2.hello.room.members[0]).toMatchObject({ uid: h.uid, away: true });
    advance(GRACE - 1);                                              // tras el reinicio todos empiezan con el plazo entero
    gc2.none(m => m.k === 'room' && m.room === null);
    advance(1);
    expect(gc2.take(m => m.k === 'room' && m.room === null)).toMatchObject({ why: 'timeout' });
    expect(E.srv.db.raw.query('SELECT COUNT(*) AS n FROM rooms').get()).toEqual({ n: 0 });
    gc2.close();
  });

  test('las salas viejas, o sin anfitrión, se descartan al arrancar', async () => {
    const h = account(), g = account(), h2 = account();
    const { room } = await roomWith(h, [g]);
    E.restart(() => {
      const d = new Database(E.dbPath);
      d.run('UPDATE rooms SET updated = ? WHERE id = ?', [E.clock.t - 4 * 3600_000, room.id]);                   // lleva 4 h sin moverse
      d.run("INSERT INTO rooms (id, host_id, open, started, created, updated) VALUES ('huerfana-1234', ?, 1, 0, 0, ?)", [Number(h2.uid), E.clock.t]);   // sin miembros
      d.close();
    });
    expect(E.srv.db.raw.query('SELECT COUNT(*) AS n FROM rooms').get()).toEqual({ n: 0 });
    const gc2 = online(g);
    expect(gc2.hello.room).toBeNull();
    const hc2 = online(h2);
    expect(hc2.hello.room).toBeNull();
    gc2.close(); hc2.close();
  });
});

describe('marcas de grupo contra la sala real', () => {
  const rk = (a: Acc, method: string, path: string, body?: unknown) => api(a, method, '/api/ranking' + path, body);
  /** El anfitrión empieza la partida en grupo (con `listed` en el mensaje) y avisa al ranking. */
  async function played(h: Acc, gs: Acc[], listed: Acc[] = [h, ...gs]) {
    const room = await roomWith(h, gs);
    room.hc.send({ k: 'g', d: { k: 'start', seed: 1, host: h.uid, members: listed.map(m => ({ uid: m.uid, name: m.name, dex: 25, shiny: false })) } });
    room.gcs[0].take(m => m.k === 'g' && m.d.k === 'start');
    expect((await rk(h, 'POST', '/start', { mode: 'g' })).status).toBe(200);
    return room;
  }
  /** Como si la partida llevara `secs` s en marcha (en la sala y en el aviso al ranking). */
  const age = (h: Acc, secs: number) => {
    rawDb().run('UPDATE ranking_runs SET started = started - ? WHERE user_id = ?', [secs * 1000, Number(h.uid)]);
    rawDb().run('UPDATE group_starts SET started = started - ? WHERE host_id = ?', [secs * 1000, Number(h.uid)]);
  };
  const submit = (h: Acc, ms: Acc[], t = 70) => rk(h, 'POST', '/submit', { mode: 'g', t, lv: 5, kills: 100, members: ms.map((m, i) => ({ uid: m.uid, dex: 25 + i, shiny: false })) });
  const trio = async () => [account(), account(), account()] as const;

  test('el equipo que empezó junto puede subir su marca, y sólo una vez', async () => {
    const [h, g1, g2] = await trio();
    await played(h, [g1, g2]);
    age(h, 120);
    expect((await submit(h, [h, g1, g2])).status).toBe(200);
    expect([403, 409]).toContain((await submit(h, [h, g1, g2])).status);      // la partida ya se gastó
  });

  test('sigue constando aunque un miembro se haya ido o la sala ya no exista', async () => {
    const [h, g1, g2] = await trio();
    const room = await played(h, [g1, g2]);
    age(h, 120);
    room.gcs[1].kill();
    advance(GRACE);
    room.hc.take(m => m.k === 'room' && m.room?.members.length === 2 && !m.room.members.some((x: any) => x.uid === g2.uid));
    room.hc.kill();                                                  // y el anfitrión se cae: la sala se cierra
    advance(GRACE);
    room.gcs[0].take(m => m.k === 'room' && m.room === null);
    expect(roomRow(room.room.id)).toBeNull();
    expect((await submit(h, [h, g1, g2])).status).toBe(200);
  });

  test('equipo inventado: nunca empezaron una partida', async () => {
    const [h, g1] = [account(), account()];
    await rk(h, 'POST', '/start', { mode: 'g' });
    age(h, 120);
    expect((await submit(h, [h, g1])).status).toBe(403);
  });

  test('equipo con alguien que no estaba, a quien le falta alguien o con repetidos', async () => {
    const [h, g1, g2] = await trio();
    const intruso = account();
    await played(h, [g1]);                                           // en la sala sólo h y g1; g2 e intruso no
    age(h, 120);
    expect((await submit(h, [h, g1, intruso])).status).toBe(403);
    expect((await submit(h, [h, g1, g2])).status).toBe(403);
    expect((await submit(h, [h, intruso])).status).toBe(403);
    expect((await submit(h, [h, g1, g1])).status).toBe(400);
    expect((await submit(h, [h, g1, { ...g2, uid: '99999999' }])).status).toBe(400);
    expect((await submit(h, [h, g1])).status).toBe(200);             // el real, tras tanto intento, sigue valiendo
  });

  test('alguien que estaba en la sala pero no en el reparto del start no es del equipo', async () => {
    const [h, g1, g2] = await trio();
    await played(h, [g1, g2], [h, g1, { ...g2, uid: '99999999' } as Acc]);       // g2 no figura; un desconocido sí (se ignora)
    age(h, 120);
    expect((await submit(h, [h, g1, g2])).status).toBe(403);
    expect((await submit(h, [h, g1])).status).toBe(200);
  });

  test('un invitado no puede subir la marca del grupo', async () => {
    const [h, g1, g2] = await trio();
    await played(h, [g1, g2]);
    age(h, 120);
    await rk(g1, 'POST', '/start', { mode: 'g' });
    rawDb().run('UPDATE ranking_runs SET started = started - 120000 WHERE user_id = ?', [Number(g1.uid)]);
    expect((await submit(g1, [g1, h, g2])).status).toBe(403);
    expect((await submit(g1, [g1, g2])).status).toBe(403);
  });

  test('una partida de hace días no vale', async () => {
    const [h, g1] = [account(), account()];
    await played(h, [g1]);
    age(h, 3 * 24 * 3600);
    expect((await submit(h, [h, g1], 3000)).status).toBe(403);
  });

  test('subir antes del start de la sala, o con un aviso al ranking de antes de empezar, no vale', async () => {
    const [h, g1] = [account(), account()];
    const room = await roomWith(h, [g1]);
    await rk(h, 'POST', '/start', { mode: 'g' });                                  // avisa al ranking SIN haber empezado
    age(h, 120);
    expect((await submit(h, [h, g1])).status).toBe(403);
    // Empieza de verdad ahora, pero el aviso al ranking quedó de hace dos minutos: se ve que no es de esta partida.
    room.hc.send({ k: 'g', d: { k: 'start', seed: 1, host: h.uid, members: [{ uid: h.uid }, { uid: g1.uid }] } });
    room.gcs[0].take(m => m.k === 'g' && m.d.k === 'start');
    expect((await submit(h, [h, g1])).status).toBe(403);
    // Con el aviso hecho después del start (lo normal) y 2 minutos jugados, sí.
    await rk(h, 'POST', '/start', { mode: 'g' });
    age(h, 120);
    expect((await submit(h, [h, g1])).status).toBe(200);
  });

  test('el tiempo tiene que ser coherente con el start real: no se puede reclamar más de lo jugado', async () => {
    const [h, g1] = [account(), account()];
    await played(h, [g1]);
    age(h, 40);                                                      // llevan 40 s
    expect((await submit(h, [h, g1], 3000)).status).toBe(400);
    expect((await submit(h, [h, g1], 65)).status).toBe(200);         // 65 <= 40 + 30 de margen
  });

  test('una partida en solitario no sirve de equipo, ni al revés', async () => {
    const [h, g1] = [account(), account()];
    await played(h, [g1]);
    age(h, 120);
    expect((await rk(h, 'POST', '/submit', { mode: 's', t: 70, lv: 5, kills: 100, dex: 25, shiny: false })).status).toBe(409);   // el aviso era de grupo
  });

  test('empezar de nuevo sustituye al equipo anterior', async () => {
    const [h, g1, g2] = await trio();
    const room = await played(h, [g1]);
    room.hc.req({ k: 'room.open', v: true });
    await befriend(h, g2);
    room.hc.req({ k: 'inv', to: g2.uid });
    const gc = online(g2);
    const inv = gc.take(m => m.k === 'inv');
    expect(gc.req({ k: 'room.join', id: inv.room, dex: 4, shiny: false }).ok).toBe(true);
    room.hc.send({ k: 'g', d: { k: 'start', seed: 2, host: h.uid, members: [{ uid: h.uid }, { uid: g1.uid }, { uid: g2.uid }] } });
    gc.take(m => m.k === 'g' && m.d.k === 'start');
    await rk(h, 'POST', '/start', { mode: 'g' });
    age(h, 120);
    expect((await submit(h, [h, g1])).status).toBe(403);             // el equipo de antes ya no es el de esta partida
    expect((await submit(h, [h, g1, g2])).status).toBe(200);
  });
});

describe('salas públicas y espectadores', () => {
  /** Sala pública del anfitrión `h` (sin nadie más), con su modo y mapa. */
  function publicRoom(h: Acc, mode = 'td', map = 'zigzag') {
    const hc = online(h);
    const room = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
    expect(hc.req({ k: 'room.pub', v: true, mode, map }).ok).toBe(true);
    return { hc, room };
  }
  const listed = (c: Client) => c.req({ k: 'rooms.list' }).rooms as any[];
  /** El anfitrión empieza la partida con los que tenga en la sala. */
  const start = (hc: Client, h: Acc, members: Acc[], extra: Record<string, unknown> = {}) =>
    hc.send({ k: 'g', d: { k: 'start', seed: 77, host: h.uid, members: members.map(m => ({ uid: m.uid, name: 'falso', dex: 1 })), ...extra } });

  test('por defecto privada: no sale en la lista y no se entra sin invitación', async () => {
    const h = account(), x = account();
    const hc = online(h), xc = online(x);
    const room = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
    expect(room).toMatchObject({ pub: false, mode: 'survivor', watchers: [] });
    expect(listed(xc).some(r => r.id === room.id)).toBe(false);
    expect(xc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(false);
  });

  test('pública: sale en la lista y cualquiera entra sin invitación ni amistad (hasta llenarla)', async () => {
    const h = account();
    const { hc, room } = publicRoom(h, 'survivor', 'random');
    const others = [account(), account(), account(), account()].map(online);
    const row = listed(others[0]).find(r => r.id === room.id);
    expect(row).toMatchObject({ host: h.uid, hostName: h.name, mode: 'survivor', n: 1, max: 4, started: false, watchers: 0 });
    for (const c of others.slice(0, 3)) expect(c.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(true);
    const full = others[3].req({ k: 'room.join', id: room.id, dex: 4, shiny: false });
    expect(full.ok).toBe(false);
    expect(full.error).toContain('llena');
    expect(hc.take(m => m.k === 'room' && m.room?.members.length === 4).room.pub).toBe(true);
  });

  test('cuántos caben depende de a qué se juega: Survivor 4; Defensa, el mapa (Valle 6, Zigzag 8; al azar, 6)', async () => {
    const h = account();
    const { hc, room } = publicRoom(h, 'td', 'zigzag');
    expect(listed(hc).find(r => r.id === room.id).max).toBe(8);
    const others = Array.from({ length: 8 }, () => online(account()));
    for (const c of others.slice(0, 7)) expect(c.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(true);
    expect(others[7].req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).error).toContain('llena');
    expect(hc.msgs.filter(m => m.k === 'room').pop().room).toMatchObject({ max: 8 });
    // Cambiar a un mapa o modo más pequeño no echa a nadie: la sala dice cuántos caben (y no se puede empezar, ver la sala).
    hc.req({ k: 'room.pub', v: true, mode: 'td', map: 'valle' });
    expect(hc.msgs.filter(m => m.k === 'room').pop().room).toMatchObject({ max: 6, members: { length: 8 } });
    hc.req({ k: 'room.pub', v: true, mode: 'td', map: 'random' });
    expect(listed(hc).find(r => r.id === room.id).max).toBe(6);
    hc.req({ k: 'room.pub', v: false, mode: 'survivor', map: 'random' });
    expect(hc.msgs.filter(m => m.k === 'room').pop().room).toMatchObject({ max: 4, pub: false });
  });

  test('sólo el anfitrión la hace pública, y con datos válidos; al volver a privada sale de la lista', async () => {
    const h = account(), g = account(), x = account();
    const { hc, gcs, room } = await roomWith(h, [g]);
    expect(gcs[0].req({ k: 'room.pub', v: true, mode: 'td', map: 'valle' }).ok).toBe(false);          // un invitado no
    const malos: Record<string, unknown>[] = [{ v: 'si', mode: 'td', map: 'valle' }, { v: true, mode: 'otro', map: 'valle' },
      { v: true, mode: 'td', map: "x' OR 1" }, { v: true, mode: 'td', map: 'a'.repeat(30) }, { v: true, mode: 'td' }];
    for (const m of malos) expect(hc.req({ k: 'room.pub', ...m }).ok).toBe(false);
    const xc = online(x);
    expect(listed(xc).some(r => r.id === room.id)).toBe(false);
    expect(hc.req({ k: 'room.pub', v: true, mode: 'survivor', map: 'random' }).ok).toBe(true);
    expect(listed(xc).find(r => r.id === room.id)).toMatchObject({ mode: 'survivor', n: 2 });
    expect(hc.req({ k: 'room.pub', v: false, mode: 'survivor', map: 'random' }).ok).toBe(true);
    expect(listed(xc).some(r => r.id === room.id)).toBe(false);
    expect(xc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(false);
  });

  test('en juego no se entra: se mira. El espectador recibe la partida (con los nombres de verdad) y no ocupa sitio', async () => {
    const h = account(), g = account(), w = account();
    const { hc, room } = publicRoom(h);
    const gc = online(g), wc = online(w);
    expect(gc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(true);
    // Aún en la sala: no se puede mirar (se puede entrar).
    expect(wc.req({ k: 'room.watch', id: room.id }).error).toContain('aún no ha empezado');
    start(hc, h, [h, g], { mode: 'td', map: 'zigzag' });
    gc.take(m => m.k === 'g' && m.d.k === 'start');
    expect(listed(wc).find(r => r.id === room.id)).toMatchObject({ started: true, n: 2 });
    expect(wc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).error).toContain('empezado');
    const v = wc.req({ k: 'room.watch', id: room.id });
    expect(v.ok).toBe(true);
    expect(v.cfg).toMatchObject({ k: 'start', seed: 77, host: h.uid, mode: 'td', map: 'zigzag' });
    expect(v.cfg.members).toEqual([{ uid: h.uid, name: h.name, dex: 25, shiny: false }, { uid: g.uid, name: g.name, dex: 4, shiny: false }]);
    expect(v.room.members.length).toBe(2);
    expect(hc.take(m => m.k === 'room' && m.room?.watchers.length === 1).room.watchers).toEqual([{ uid: w.uid, name: w.name }]);
    expect(listed(wc).find(r => r.id === room.id).watchers).toBe(1);
    // Un jugador de la sala no puede mirar su propia partida.
    expect(gc.req({ k: 'room.watch', id: room.id }).ok).toBe(false);
  });

  test('el espectador sólo habla con el anfitrión, y sólo el anfitrión le habla a él', async () => {
    const h = account(), g = account(), w = account();
    const { hc, room } = publicRoom(h);
    const gc = online(g); gc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false });
    start(hc, h, [h, g]);
    gc.take(m => m.k === 'g' && m.d.k === 'start');
    const wc = online(w);
    wc.req({ k: 'room.watch', id: room.id });
    // Anfitrión -> espectador: llega.
    hc.send({ k: 'g', to: w.uid, d: { k: 'f', p: [1] } });
    expect(wc.take(m => m.k === 'g')).toEqual({ k: 'g', f: h.uid, d: { k: 'f', p: [1] } });
    // Un jugador que no es el anfitrión -> espectador: no.
    gc.send({ k: 'g', to: w.uid, d: { k: 'f', p: [2] } });
    gc.take(m => m.k === 'err');
    wc.none(m => m.k === 'g');
    // Espectador -> anfitrión: llega (con su uid puesto por el servidor). A otro, a todos o empezar: no.
    wc.send({ k: 'g', to: h.uid, f: g.uid, d: { k: 'f', p: [3] } });
    expect(hc.take(m => m.k === 'g')).toEqual({ k: 'g', f: w.uid, d: { k: 'f', p: [3] } });
    wc.send({ k: 'g', to: g.uid, d: { k: 'f', p: [4] } });
    wc.send({ k: 'g', d: { k: 'f', p: [5] } });
    wc.send({ k: 'g', to: h.uid, d: { k: 'start', seed: 1, host: w.uid, members: [] } });
    gc.none(m => m.k === 'g');
    hc.none(m => m.k === 'g');
    // Una difusión del anfitrión (sin `to`) es para los jugadores, no para los espectadores.
    hc.send({ k: 'g', d: { k: 'f', p: [6] } });
    expect(gc.take(m => m.k === 'g').d.p).toEqual([6]);
    wc.none(m => m.k === 'g');
  });

  test('tope de espectadores; quien está en otra sala no mira; al irse o al acabar la partida, fuera', async () => {
    const h = account(), g = account();
    const { hc, room } = publicRoom(h);
    const gc = online(g); gc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false });
    start(hc, h, [h, g]);
    const ws = Array.from({ length: 9 }, () => online(account()));
    for (const c of ws.slice(0, 8)) expect(c.req({ k: 'room.watch', id: room.id }).ok).toBe(true);
    expect(ws[8].req({ k: 'room.watch', id: room.id }).error).toContain('mirando');
    // Alguien con su propia sala no puede mirar otra.
    const oc = online(account());
    oc.req({ k: 'room.new', dex: 25, shiny: false });
    expect(oc.req({ k: 'room.watch', id: room.id }).ok).toBe(false);
    // Uno deja de mirar y otro se cae: el anfitrión lo ve.
    ws[0].req({ k: 'room.unwatch' });
    ws[1].kill();
    expect(hc.msgs.filter(m => m.k === 'room').pop().room.watchers.length).toBe(6);
    // Se acaba la partida (la sala se reabre): todos los espectadores salen, avisados.
    hc.req({ k: 'room.open', v: true });
    for (const c of ws.slice(2, 8)) expect(c.take(m => m.k === 'watch' && m.room === null).why).toBe('ended');
    expect(listed(ws[2]).find(r => r.id === room.id)).toMatchObject({ started: false, watchers: 0 });
    // Y ya se puede entrar a jugar.
    expect(ws[2].req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(true);
  });

  test('si el anfitrión cierra la sala, los espectadores se enteran', async () => {
    const h = account(), g = account(), w = account();
    const { hc, room } = publicRoom(h);
    const gc = online(g); gc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false });
    start(hc, h, [h, g]);
    const wc = online(w);
    wc.req({ k: 'room.watch', id: room.id });
    hc.req({ k: 'room.leave' });
    expect(wc.take(m => m.k === 'watch' && m.room === null).why).toBeDefined();
    expect(listed(wc).some(r => r.id === room.id)).toBe(false);
  });
});

describe('salas públicas tras un reinicio', () => {
  beforeEach(() => { fresh({ file: true }); });
  const listed = (c: Client) => c.req({ k: 'rooms.list' }).rooms as any[];
  test('siguen siendo públicas, con su modo y mapa, y la partida sigue pudiéndose mirar', async () => {
    const h = account(), g = account();
    const hc = online(h);
    const room = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
    hc.req({ k: 'room.pub', v: true, mode: 'td', map: 'espiral' });
    const gc = online(g); gc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false });
    hc.send({ k: 'g', d: { k: 'start', seed: 5, host: h.uid, members: [{ uid: h.uid }, { uid: g.uid }], mode: 'td', map: 'espiral' } });
    E.restart();
    const hc2 = online(h);
    expect(hc2.hello.room).toMatchObject({ id: room.id, pub: true, mode: 'td', map: 'espiral', started: true });
    const wc = online(account());
    expect(listed(wc).find(r => r.id === room.id)).toMatchObject({ mode: 'td', map: 'espiral', started: true });
    expect(wc.req({ k: 'room.watch', id: room.id }).cfg).toMatchObject({ seed: 5, mode: 'td', map: 'espiral' });
  });
});

// ====================================================================

describe('chat de la sala', () => {
  const chats = (c: Client) => { const out: any[] = []; for (;;) { try { out.push(c.take(m => m.k === 'chat')); } catch { return out; } } };

  test('un mensaje llega a todos los de la sala (también a quien lo manda), con su nombre', async () => {
    const h = account(), g = account();
    const { hc, gcs: [gc] } = await roomWith(h, [g]);
    expect(gc.req({ k: 'chat', t: '  hola   a todos ' }).ok).toBe(true);
    for (const c of [hc, gc]) expect(c.take(m => m.k === 'chat')).toMatchObject({ f: g.uid, n: g.name, t: 'hola a todos' });
  });

  test('chat libre: las palabras llegan tal cual (censurar es un ajuste de cada uno, en su juego)', async () => {
    const h = account(), g = account();
    const { hc, gcs: [gc] } = await roomWith(h, [g]);
    gc.req({ k: 'chat', t: 'eres un PUT0 idiota, mira www.ejemplo.com' });
    expect(hc.take(m => m.k === 'chat').t).toBe('eres un PUT0 idiota, mira www.ejemplo.com');
  });

  test('frases rápidas: sólo las que existen', async () => {
    const h = account(), g = account();
    const { hc, gcs: [gc] } = await roomWith(h, [g]);
    expect(gc.req({ k: 'chat', q: 'gg' }).ok).toBe(true);
    expect(hc.take(m => m.k === 'chat')).toMatchObject({ f: g.uid, q: 'gg' });
    expect(gc.req({ k: 'chat', q: 'insulto' }).ok).toBe(false);
    hc.none(m => m.k === 'chat');
  });

  test('vacío, invisible o fuera de sala: no sale; lo largo se corta', async () => {
    const h = account(), g = account(), x = account();
    const { hc, gcs: [gc] } = await roomWith(h, [g]);
    expect(gc.req({ k: 'chat', t: '   ' }).ok).toBe(false);
    expect(gc.req({ k: 'chat', t: '​​\n' }).ok).toBe(false);
    expect(online(x).req({ k: 'chat', t: 'hola' }).ok).toBe(false);
    gc.req({ k: 'chat', t: 'a'.repeat(500) });
    expect(hc.take(m => m.k === 'chat').t.length).toBe(120);
  });

  test('ritmo: 5 mensajes cada 8 s, y no el mismo texto dos veces seguidas', async () => {
    const h = account(), g = account();
    const { hc, gcs: [gc] } = await roomWith(h, [g]);
    for (let i = 0; i < 5; i++) expect(gc.req({ k: 'chat', t: 'm' + i }).ok).toBe(true);
    const r = gc.req({ k: 'chat', t: 'otro' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('deprisa');
    expect(chats(hc).length).toBe(5);
    advance(8_000);
    expect(gc.req({ k: 'chat', t: 'otro' }).ok).toBe(true);
    expect(gc.req({ k: 'chat', t: 'otro' }).error).toContain('Ya lo has dicho');
    advance(15_000);
    expect(gc.req({ k: 'chat', t: 'otro' }).ok).toBe(true);
    // Ir deprisa no es una falta: la conexión sigue abierta.
    expect(gc.req({ k: 'chat', q: 'hi' }).ok).toBe(true);
  });

  test('quien entra (o vuelve) recibe los últimos mensajes', async () => {
    const h = account(), g = account(), k = account();
    const { hc, room } = await roomWith(h, [g]);
    hc.req({ k: 'chat', t: 'primero' });
    hc.req({ k: 'chat', q: 'hi' });
    await befriend(h, k);
    const kc = online(k);
    hc.req({ k: 'inv', to: k.uid });
    kc.take(m => m.k === 'inv');
    expect(kc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(true);
    expect(kc.take(m => m.k === 'chat.h').m.map((x: any) => x.t || x.q)).toEqual(['primero', 'hi']);
    // Al reconectar, igual.
    kc.kill();
    const again = online(k);
    expect(again.take(m => m.k === 'chat.h').m.length).toBe(2);
  });

  test('los espectadores leen y escriben; quien no está en la sala, no', async () => {
    const h = account(), w = account(), out = account();
    const hc = online(h);
    const room = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
    hc.req({ k: 'room.pub', v: true, mode: 'survivor', map: 'random' });
    hc.send({ k: 'g', d: { k: 'start', seed: 1, host: h.uid, members: [{ uid: h.uid, name: h.name, dex: 25 }] } });
    const wc = online(w);
    expect(wc.req({ k: 'room.watch', id: room.id }).ok).toBe(true);
    expect(wc.req({ k: 'chat', t: '¡qué partida!' }).ok).toBe(true);
    expect(hc.take(m => m.k === 'chat')).toMatchObject({ f: w.uid, t: '¡qué partida!' });
    hc.req({ k: 'chat', q: 'thx' });
    expect(wc.take(m => m.k === 'chat' && m.q === 'thx').f).toBe(h.uid);
    const oc = online(out);
    oc.none(m => m.k === 'chat');
  });
});

// ====================================================================

describe('sólo mirar desde la sala', () => {
  /** Sala pública de Survivor (caben 4) con el anfitrión y `n` más dentro. */
  function room(n: number) {
    const h = account();
    const hc = online(h);
    const r = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
    hc.req({ k: 'room.pub', v: true, mode: 'survivor', map: 'random' });
    const gs = Array.from({ length: n }, () => account());
    const gcs = gs.map(g => { const c = online(g); expect(c.req({ k: 'room.join', id: r.id, dex: 4, shiny: false }).ok).toBe(true); return c; });
    return { h, hc, id: r.id as string, gs, gcs };
  }
  const lastRoom = (c: Client) => { let r: any = null; for (;;) { try { r = c.take(m => m.k === 'room').room; } catch { return r; } } };

  test('un invitado elige sólo mirar (y volver a jugar); el anfitrión no puede', async () => {
    const { hc, gs, gcs } = room(1);
    expect(gcs[0].req({ k: 'room.spec', v: true }).ok).toBe(true);
    expect(lastRoom(hc).members.find((m: any) => m.uid === gs[0].uid).spec).toBe(true);
    expect(hc.req({ k: 'room.spec', v: true }).ok).toBe(false);
    hc.none(m => m.k === 'room');                      // (rechazado: la sala no cambia)
    expect(gcs[0].req({ k: 'room.spec', v: false }).ok).toBe(true);
    expect(lastRoom(hc).members.find((m: any) => m.uid === gs[0].uid).spec).toBe(false);
  });

  test('quien sólo mira no ocupa plaza; para volver a jugar tiene que haber sitio', async () => {
    const { id, gcs } = room(1);
    expect(gcs[0].req({ k: 'room.spec', v: true }).ok).toBe(true);
    // Caben 4 que juegan: el anfitrión y 3 más, aunque ya haya uno mirando.
    for (let i = 0; i < 3; i++) expect(online(account()).req({ k: 'room.join', id, dex: 7, shiny: false }).ok).toBe(true);
    expect(online(account()).req({ k: 'room.join', id, dex: 7, shiny: false }).error).toContain('llena');
    const back = gcs[0].req({ k: 'room.spec', v: false });
    expect(back.ok).toBe(false);
    expect(back.error).toContain('sitio');
  });

  test('al empezar, los que sólo miran quedan fuera del equipo (y ya no pueden cambiar)', async () => {
    const { h, hc, gs, gcs } = room(2);
    gcs[1].req({ k: 'room.spec', v: true });
    // Aunque el anfitrión los apuntara a todos, el servidor sólo cuenta a los que juegan.
    hc.send({ k: 'g', d: { k: 'start', seed: 5, host: h.uid, members: [h, ...gs].map(a => ({ uid: a.uid, name: a.name, dex: 1 })) } });
    // El inicio les llega a todos (el que mira también lo necesita, para mirar).
    expect(gcs[1].take(m => m.k === 'g' && m.d.k === 'start')).toBeTruthy();
    const r = lastRoom(gcs[0]);
    expect(r.started).toBe(true);
    const team = String((rawDb().query('SELECT team FROM group_starts WHERE host_id = ?').get(Number(h.uid)) as { team: string }).team);
    expect(team).toContain(gs[0].uid);
    expect(team).not.toContain(gs[1].uid);
    expect(gcs[1].req({ k: 'room.spec', v: false }).error).toContain('empezado');
  });
});

// ====================================================================

describe('señales en el mapa', () => {
  test('sólo con la partida en marcha; llegan a todos (también a quien mira) con nombre y sitio, y con tope de ritmo', async () => {
    const h = account(), g = account(), w = account();
    const { hc, gcs: [gc], room } = await roomWith(h, [g]);
    expect(gc.req({ k: 'mark', x: 10, y: 20 }).ok).toBe(false);                 // aún en el vestíbulo
    hc.req({ k: 'room.pub', v: true, mode: 'survivor', map: 'random' });
    hc.send({ k: 'g', d: { k: 'start', seed: 1, host: h.uid, members: [h, g].map(a => ({ uid: a.uid, name: a.name, dex: 1 })) } });
    const wc = online(w);
    expect(wc.req({ k: 'room.watch', id: room.id }).ok).toBe(true);
    expect(gc.req({ k: 'mark', x: 10.4, y: -20.6 }).ok).toBe(true);
    for (const c of [hc, gc, wc]) expect(c.take(m => m.k === 'mark')).toMatchObject({ f: g.uid, n: g.name, x: 10, y: -21 });
    expect(gc.req({ k: 'mark', x: 'a', y: 0 }).ok).toBe(false);
    expect(gc.req({ k: 'mark', x: 1e9, y: 0 }).ok).toBe(false);
    for (let i = 0; i < 3; i++) expect(gc.req({ k: 'mark', x: i, y: 0 }).ok).toBe(true);
    expect(gc.req({ k: 'mark', x: 9, y: 9 }).error).toContain('Demasiadas');
    advance(3_000);
    expect(gc.req({ k: 'mark', x: 9, y: 9 }).ok).toBe(true);
    expect(wc.req({ k: 'mark', x: 5, y: 5 }).ok).toBe(true);                     // también quien mira
  });
});

describe('códigos de sala', () => {
  const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

  test('cada sala tiene un código; con él entra cualquiera (sin ser amigos, sala privada), escrito como sea', async () => {
    const h = account(), x = account();
    const hc = online(h), xc = online(x);
    const room = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
    expect(room.code).toMatch(CODE);
    expect(room.pub).toBe(false);
    // Sin código ni invitación, no.
    expect(xc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(false);
    const typed = room.code.slice(0, 3).toLowerCase() + ' - ' + room.code.slice(3);
    const j = xc.req({ k: 'room.join', code: typed, dex: 4, shiny: false });
    expect(j.ok).toBe(true);
    expect(j.room.id).toBe(room.id);
    expect(hc.take(m => m.k === 'room' && m.room.members.length === 2).room.code).toBe(room.code);
    // Otra sala, otro código.
    const y = account();
    expect(online(y).req({ k: 'room.new', dex: 1, shiny: false }).room.code).not.toBe(room.code);
  });

  test('probar códigos al azar: tras 8 fallos en un minuto, ni el bueno vale; pasado el minuto, sí', async () => {
    const h = account(), x = account();
    const room = online(h).req({ k: 'room.new', dex: 25, shiny: false }).room;
    const xc = online(x);
    for (let i = 0; i < 8; i++) expect(xc.req({ k: 'room.join', code: 'ZZZZZ' + (i + 2), dex: 4, shiny: false }).error).toBe('No hay ninguna sala con ese código.');
    expect(xc.req({ k: 'room.join', code: room.code, dex: 4, shiny: false }).error).toMatch(/espera un minuto/);
    expect(xc.closed).toBeNull();                         // un código equivocado no es una falta
    advance(60_000);
    expect(xc.req({ k: 'room.join', code: room.code, dex: 4, shiny: false }).ok).toBe(true);
  });

  test('cambiar el código: el viejo deja de valer; sólo el anfitrión', async () => {
    const h = account(), x = account(), y = account();
    const hc = online(h), xc = online(x), yc = online(y);
    const room = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
    expect(xc.req({ k: 'room.join', code: room.code, dex: 4, shiny: false }).ok).toBe(true);
    expect(xc.req({ k: 'room.recode' }).ok).toBe(false);
    const r = hc.req({ k: 'room.recode' });
    expect(r.ok).toBe(true);
    expect(r.code).toMatch(CODE);
    expect(r.code).not.toBe(room.code);
    expect(xc.take(m => m.k === 'room' && m.room.code === r.code)).toBeTruthy();       // los de dentro lo ven
    expect(yc.req({ k: 'room.join', code: room.code, dex: 4, shiny: false }).ok).toBe(false);
    expect(yc.req({ k: 'room.join', code: r.code, dex: 4, shiny: false }).ok).toBe(true);
  });

  test('sacar a alguien: se entera, no vuelve con el código ni desde la lista; con invitación, sí. Empezada la partida, no se saca', async () => {
    const h = account(), x = account(), y = account();
    const hc = online(h), xc = online(x), yc = online(y);
    const room = hc.req({ k: 'room.new', dex: 25, shiny: false }).room;
    hc.req({ k: 'room.pub', v: true, mode: 'survivor', map: 'random' });
    expect(xc.req({ k: 'room.join', code: room.code, dex: 4, shiny: false }).ok).toBe(true);
    expect(yc.req({ k: 'room.join', id: room.id, dex: 7, shiny: false }).ok).toBe(true);
    expect(xc.req({ k: 'room.kick', uid: y.uid }).ok).toBe(false);                     // sólo el anfitrión
    expect(hc.req({ k: 'room.kick', uid: h.uid }).ok).toBe(false);
    expect(hc.req({ k: 'room.kick', uid: x.uid }).ok).toBe(true);
    expect(xc.take(m => m.k === 'room' && m.room === null).why).toBe('kicked');
    expect(hc.take(m => m.k === 'room' && m.room.members.length === 2 && m.room.members.every((u: any) => u.uid !== x.uid)).room.members.map((m: any) => m.uid)).toEqual([h.uid, y.uid]);
    expect(xc.req({ k: 'room.join', code: room.code, dex: 4, shiny: false }).error).toBe('El anfitrión te ha sacado de esa sala.');
    expect(xc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(false);
    // Si el anfitrión le vuelve a invitar (son amigos), entra.
    await befriend(h, x);
    expect(hc.req({ k: 'inv', to: x.uid }).ok).toBe(true);
    expect(xc.req({ k: 'room.join', id: room.id, dex: 4, shiny: false }).ok).toBe(true);
    // Con la partida empezada, no.
    hc.req({ k: 'room.open', v: false });
    hc.send({ k: 'g', d: { k: 'start', seed: 1, host: h.uid, members: [] } });
    expect(hc.req({ k: 'room.kick', uid: y.uid }).error).toBe('La partida ya ha empezado.');
  });

  test('el enlace /s/<código> lleva al juego con ?sala=', async () => {
    const r = await fetch(E.base + '/s/k7qm4x', { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/?sala=K7QM4X');
    expect((await fetch(E.base + '/s/../../etc', { redirect: 'manual' })).status).not.toBe(302);
  });
});

describe('códigos de sala tras un reinicio', () => {
  beforeEach(() => { fresh({ file: true }); });

  test('la sala conserva su código y sigue valiendo; las salas guardadas sin código reciben uno', async () => {
    const h = account(), x = account();
    const room = online(h).req({ k: 'room.new', dex: 25, shiny: false }).room;
    E.restart(() => {
      // Una sala guardada antes de que existieran los códigos.
      const db = new Database(E.dbPath);
      db.run(`UPDATE rooms SET info = '{"pub":false,"mode":"survivor","map":"random"}' WHERE id = ?`, [room.id]);
      db.close();
    });
    const hc = online(h);
    const code = hc.hello.room.code;
    expect(code).toMatch(CODE_RE);
    expect(online(x).req({ k: 'room.join', code, dex: 4, shiny: false }).ok).toBe(true);
    E.restart();
    expect(online(h).hello.room.code).toBe(code);
  });
  const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
});
