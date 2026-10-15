/* ============ coop.fast.test.ts — el cooperativo en navegador, sin red real ni esperas ============
 * Lo mismo que tests/coop.e2e.ts (amigos, sala, invitación, partida en grupo, reconexión,
 * reinicio del servidor...), pero en un solo proceso y con todo bajo control de la prueba:
 *
 *  - El servidor es el de verdad (server/index.ts, base en un archivo temporal) dentro de este proceso,
 *    con un reloj falso (tests/fakes.ts) que sólo avanza cuando la prueba lo dice.
 *  - Las páginas (Vite, también en el proceso) no usan la red para hablar con el servidor:
 *      REST   `page.route('**\/api/**')` atiende cada petición con `server.fetch`.
 *      /ws    un WebSocket falso en la página (installFakeNet): lo que envía queda en un buzón
 *             y la prueba lo recoge al terminar cada paso; cada conexión es una conexión simulada
 *             que pasa por `rt.websocket.open/message/close`, y lo que el servidor le manda se entrega
 *             a la página en el paso siguiente.
 *  - El reloj, el azar y los fotogramas de cada página los lleva el arnés de tests/adversarial.ts
 *    (installHarness): la página sólo avanza cuando se le dan fotogramas.
 *
 * Un "paso" (`round`): se entrega a cada página lo que el servidor le tenía guardado, se juegan unos
 * fotogramas, se recoge lo que ha enviado y el servidor lo procesa; al final avanza el reloj del
 * servidor lo que han avanzado las páginas. Nada espera tiempo real.
 *
 *   bun test tests/coop.fast.test.ts
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer as tcp } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import type { ViteDevServer } from 'vite';
import type { WsData } from '../server/realtime';
import { sha256 } from '../server/http';
import { FakeClock, installFakeNet, installHarness, type NetIn, type NetOut } from './fakes';
import { startServer } from './helpers';

declare const G: any;
declare const window: any;
declare const document: any;
type HTMLElement = any;
type HTMLButtonElement = any;

setDefaultTimeout(300_000);   // el primer arranque en frío (Vite + Chrome) puede tardar más de un minuto

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.now();                         // la hora con que arrancan el reloj de cada página (installHarness) y el del servidor
const START = 1_000_000;                       // y su performance.now()
const FRAME = 1000 / 60;

// ---------------- el servidor y sus conexiones simuladas ----------------

type Srv = ReturnType<typeof startServer>;
interface Sim { dev: Dev; c: number; ws: any; closed: boolean; rt: Srv['rt'] }

class Rig {
  readonly clock = new FakeClock(T0 + START);
  readonly dbPath = join(mkdtempSync(join(tmpdir(), 'poke-td-coop-')), 'test.sqlite');
  srv: Srv | null = null;
  readonly devs: Dev[] = [];
  private closing: Sim[] = [];
  private closeCode = new Map<Sim, number>();
  private seq = 0;
  /** Cuántas peticiones REST se han atendido (para las pruebas que miran qué llamó la página). */
  readonly rest: string[] = [];

  constructor() { this.clock.after = () => this.settle(); }

  up() {
    this.srv = startServer({ port: 0, dbPath: this.dbPath, loginLimit: 10_000, realtime: { clock: this.clock.clock } });
  }
  /** Para el servidor: las conexiones se cortan (las páginas lo ven como un corte de red). */
  down() {
    const s = this.srv!;
    this.srv = null;
    s.stop();
    for (const d of this.devs) {
      for (const [c, sim] of d.socks) { sim.closed = true; d.inbox.push({ c, ev: 'c', code: 1006 }); }
      d.socks.clear();
    }
  }
  restart() { this.down(); this.up(); }

  /** Corte de red de una página: su conexión se cae y, mientras dure, no puede abrir otra. */
  cut(dev: Dev) {
    dev.offline = true;
    for (const [c, sim] of dev.socks) {
      if (sim.closed) continue;
      sim.closed = true;
      dev.inbox.push({ c, ev: 'c', code: 1006 });
      this.closeCode.set(sim, 1006);
      this.closing.push(sim);
    }
    dev.socks.clear();
    this.settle();
  }
  /** Vuelve la red: la página reconectará sola cuando le toque (su temporizador de reintento). */
  heal(dev: Dev) { dev.offline = false; }

  /** Lo que el servidor corta por su lado se da por cerrado (con el aviso a `rt.websocket.close`) al terminar la acción en curso. */
  settle() {
    while (this.closing.length) {
      const sim = this.closing.shift()!;
      sim.rt.websocket.close!(sim.ws, this.closeCode.get(sim) ?? 1000, '');
    }
  }

  /** Una conexión nueva de la página: valida el token igual que server/index.ts y la pasa a `rt.websocket`. */
  private connect(dev: Dev, c: number, url: string) {
    const srv = this.srv;
    const token = new URL(url, 'http://x').searchParams.get('token');
    const user = (() => {
      if (!srv || !token || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
      const s = srv.db.session(sha256(token));
      return s ? srv.db.userById(s.user_id) : null;
    })();
    // Servidor caído o sesión no válida: el navegador ve un fallo de conexión (1006).
    if (!srv || !user || dev.offline) { dev.inbox.push({ c, ev: 'c', code: 1006 }); return; }
    const sim: Sim = { dev, c, ws: null, closed: false, rt: srv.rt };
    sim.ws = {
      data: { user } as WsData,
      send: (s: string) => { if (!sim.closed) { dev.inbox.push({ c, ev: 'm', d: s }); dev.log?.push(s); } return s.length; },
      close: (code = 1000) => {
        if (sim.closed) return;
        sim.closed = true;
        dev.inbox.push({ c, ev: 'c', code });
        this.closeCode.set(sim, code);
        this.closing.push(sim);
      },
      getBufferedAmount: () => 0,
    };
    dev.socks.set(c, sim);
    dev.inbox.push({ c, ev: 'o' });
    srv.rt.websocket.open!(sim.ws);
    this.settle();
  }

  /** Procesa lo que una página ha sacado en un paso. */
  private take(dev: Dev, out: NetOut[]) {
    for (const o of out) {
      if (o.t === 'new') { this.connect(dev, o.c, o.url!); continue; }
      const sim = dev.socks.get(o.c);
      if (!sim || sim.closed) continue;
      if (o.t === 'send') sim.rt.websocket.message!(sim.ws, o.d!);
      else {                                                       // la página cierra
        sim.closed = true;
        dev.socks.delete(o.c);
        dev.inbox.push({ c: o.c, ev: 'c', code: o.code ?? 1000 });
        sim.rt.websocket.close!(sim.ws, o.code ?? 1000, '');
      }
      this.settle();
    }
  }

  /** REST: cada petición de una página se atiende dentro del proceso. */
  async serve(route: Route) {
    try { await this.serve1(route); }
    catch (e) { console.log('SERVE FALLA', route.request().method(), route.request().url(), e); await route.abort('failed').catch(() => {}); }
  }
  private async serve1(route: Route) {
    const req = route.request();
    const srv = this.srv;
    if (!srv) { await route.abort('connectionrefused'); return; }
    const u = new URL(req.url());
    this.rest.push(req.method() + ' ' + u.pathname);
    const body = req.postDataBuffer();
    const res = await srv.server.fetch(new Request(`http://127.0.0.1:${srv.server.port}${u.pathname}${u.search}`, {
      method: req.method(),
      headers: req.headers(),
      body: body && req.method() !== 'GET' && req.method() !== 'HEAD' ? body : undefined,
    }));
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    this.settle();
  }

  /**
   * Un paso: a cada página se le entrega lo que el servidor le tenía guardado y se le dan `frames` fotogramas
   * (más un salto de reloj de `jump` ms, sin simular); lo que envía lo procesa el servidor, y el reloj del
   * servidor avanza lo mismo que el de las páginas.
   */
  async round(frames = 4, jump = 0) {
    const t0 = performance.now();
    for (const d of this.devs) {
      const inb = d.inbox.splice(0);
      const out = await d.page.evaluate(([e, f, j]) => window.__net.step(e, f, j), [inb, frames, jump] as [NetIn[], number, number]);
      this.take(d, out);
    }
    this.clock.advance(frames * FRAME + jump);
    this.settle();
    this.stats.rounds++; this.stats.ms += performance.now() - t0;
  }
  readonly stats = { rounds: 0, ms: 0 };

  /** Pasos hasta que se cumpla `cond` (o falla con `what`). */
  async until(what: string, cond: () => Promise<unknown> | unknown, max = 300, frames = 4, jump = 0) {
    for (let i = 0; i < max; i++) {
      if (await cond()) return;
      await this.round(frames, jump);
    }
    if (await cond()) return;
    throw new Error('no se cumple: ' + what + ' | ' + await this.diag());
  }
  /** Cómo está cada página (para los mensajes de error). */
  async diag() {
    const out: string[] = [];
    for (const d of this.devs) {
      out.push(d.label + ': ' + JSON.stringify(await d.page.evaluate(() => ({
        st: G.Game.state, coop: G.Coop.active, arena: G.Rift.snapshot().arena && G.Rift.snapshot().arena.phase, net: G.Net.up,
        room: G.Social.room && G.Social.room.members.map((m: any) => m.away ? 'away' : 'ok'),
        open: ['scr-bond', 'scr-item', 'scr-levelup', 'scr-pause'].filter(x => G.UI.isOpen(x)), judg: G.Judgment.active,
      })).catch(e => String(e))));
    }
    return out.join(' | ');
  }
  /** `n` pasos seguidos. */
  async run(n: number, frames = 4) { for (let i = 0; i < n; i++) await this.round(frames); }
}

// ---------------- una página (un dispositivo) ----------------

class Dev {
  readonly inbox: NetIn[] = [];
  readonly socks = new Map<number, Sim>();
  offline = false;
  /** Si hay lista, aquí se apunta (texto) todo lo que el servidor le manda a esta página. */
  log: string[] | null = null;
  readonly errors: string[] = [];
  page!: Page;
  ctx!: BrowserContext;
  private calls = 0;
  constructor(readonly rig: Rig, readonly label: string) {}

  async open(browser: Browser, url: string) {
    this.ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    this.page = await this.ctx.newPage();
    this.page.on('pageerror', e => this.errors.push(`${this.label}: ${e.message}`));
    this.page.on('console', m => {
      if (m.type() === 'error' && !/favicon|net::ERR|Failed to load resource|^\[vite\]/.test(m.text())) this.errors.push(`${this.label} consola: ${m.text()}`);
    });
    await this.page.route('**/api/**', route => this.rig.serve(route));
    await this.page.addInitScript(`window.__T0 = ${T0};`);
    await this.page.addInitScript(installHarness);
    await this.page.addInitScript(installFakeNet);
    await this.page.goto(url, { waitUntil: 'load' });
    await this.page.waitForFunction(() => typeof G === 'object' && G.Game && G.Flow && window.__h.ready(), null, { timeout: 240_000 });
    await this.page.waitForLoadState('networkidle');
    await this.page.evaluate(() => window.__h.freeze());       // desde aquí los temporizadores de la página son los del arnés
  }

  /** Ejecuta `fn` en la página y devuelve su resultado (sin esperar a la red del servidor). */
  eval<A, R>(fn: (a: A) => R | Promise<R>, arg?: A): Promise<R> { return this.page.evaluate(fn as any, arg as any) as Promise<R>; }

  /**
   * Ejecuta `fn` en la página y, mientras no acabe, da pasos (para lo que espera una respuesta del WebSocket).
   * Devuelve lo que devuelva, o lanza si falla.
   */
  async call<A, R>(fn: (a: A) => R | Promise<R>, arg?: A): Promise<R> {
    const id = ++this.calls;
    await this.page.evaluate(`(() => { const r = (window.__calls ||= {}); Promise.resolve((${fn})(${JSON.stringify(arg ?? null)})).then(v => { r[${id}] = { v }; }, e => { r[${id}] = { e: String(e && e.stack || e) }; }); })()`);
    for (let i = 0; i < 400; i++) {
      const r = await this.page.evaluate(`window.__calls[${id}]`) as { v?: R; e?: string } | undefined;
      if (r) { if (r.e) throw new Error(this.label + ': ' + r.e); return r.v as R; }
      await this.rig.round();
    }
    throw new Error(this.label + ': la llamada no termina');
  }

  /** Errores de la página hasta ahora (los de consola y los de excepciones sin atrapar). */
  async allErrors() { return [...this.errors, ...(await this.page.evaluate(() => window.__errors)) as string[]]; }
}

// ---------------- el entorno ----------------

let vite: ViteDevServer;
let browser: Browser;
let rig: Rig;
let A: Dev, B: Dev, C: Dev;

const freePort = () => new Promise<number>(r => { const t = tcp(); t.listen(0, '127.0.0.1', () => { const p = (t.address() as any).port; t.close(() => r(p)); }); });

beforeAll(async () => {
  const { createServer } = await import('vite');
  vite = await createServer({ root: ROOT, mode: 'test', logLevel: 'error', server: { port: await freePort(), strictPort: true, host: '127.0.0.1', hmr: false, watch: null } });
  await vite.listen();
  const url = vite.resolvedUrls!.local[0];
  browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ channel: 'msedge', headless: true }));
  rig = new Rig();
  rig.up();
  A = new Dev(rig, 'anfitrión'); B = new Dev(rig, 'invitado'); C = new Dev(rig, 'espectador');
  rig.devs.push(A, B, C);
  await Promise.all([A.open(browser, url), B.open(browser, url), C.open(browser, url)]);
});
afterAll(async () => {
  await browser?.close();
  await vite?.close();
  rig?.srv?.stop();
});

/** Cuenta nueva en la página, con el Pokémon `dex` de compañero. */
async function newPlayer(d: Dev, name: string, dex: number) {
  const reg = await d.eval(([n, p]) => G.DB.register(n, p), [name, 'pikachu123']);
  if (!reg.ok) throw new Error('no se pudo crear la cuenta: ' + reg.error);
  await d.eval(x => { G.DB.save.partner = x; G.DB.grant(x, 'starter'); G.DB.commit(true); }, dex);
}

// ====================================================================

// ---------------- utilidades de las pruebas ----------------

const click = (d: Dev, sel: string) => d.eval(q => { (document.querySelector(q) as HTMLElement).click(); }, sel);
const state = (d: Dev) => d.eval(() => G.Game.state as string);
/** Juega `n` pasos y comprueba que una condición de la página se cumple al final. */
const waitPage = (d: Dev, what: string, fn: (a: any) => any, arg?: any, max = 300) => rig.until(what, () => d.eval(fn as any, arg), max);

/** Cierra las pantallas que salen al ganar una arena: el objeto del legendario y la fusión del vínculo (que tiene parada la partida de todos). */
async function dismiss(d: Dev) {
  for (let i = 0; i < 6; i++) {
    const open = await d.eval(() => [G.UI.isOpen('scr-bond'), G.UI.isOpen('scr-item')]);
    if (!open[0] && !open[1]) return;
    if (open[0]) await click(d, '#bond-cards .card');
    if (open[1]) await click(d, '#item-cards > *');
    await rig.run(3);
  }
}
/** Cuenta los vínculos que se gastan en fusionar (para poder contar los que se han dado, se hayan gastado o no). */
const hookFuse = (d: Dev) => d.eval(() => {
  const P = G.Player.prototype;
  if (P.__hooked) return;
  P.__hooked = true; window.__fused = 0;
  const f = P.fuse;
  P.fuse = function (...a: any[]) { window.__fused++; return f.apply(this, a); };
});
/** Lo que da ganar una arena (y lo que un invitado no puede perderse). */
const stat = (d: Dev) => d.eval(() => {
  const s = G.DB.save, pl = G.Game.player;
  return { bonds: pl.bonds + (window.__fused || 0), wins: s.stats.riftWins || 0, bosses: s.stats.bossesTotal || 0, legends: Object.keys(s.legends || {}).length, arenas: Object.keys(s.arenas || {}).length };
});
type Stat = Awaited<ReturnType<typeof stat>>;
const diff = (x: Stat, y: Stat) => ({ bonds: x.bonds - y.bonds, wins: x.wins - y.wins, bosses: x.bosses - y.bosses, legends: x.legends - y.legends, arenas: x.arenas - y.arenas });
/** B se corta y vuelve (con el tiempo que haga falta para reconectar) y los dos están de nuevo en la sala. */
async function dropAndReturn(during: () => Promise<unknown>) {
  rig.cut(B);
  await waitPage(A, 'A ve a B ausente', u => G.Net.mode(u) === 'connecting', uidB);
  await during();
  rig.heal(B);
  await rig.until('B vuelve a su sala', async () => (await A.eval(u => G.Social.room.members.every((m: any) => !m.away) && G.Net.mode(u) === 'relay', uidB)) && (await B.eval(() => G.Social.room && G.Social.room.members.every((m: any) => !m.away) && G.Net.mode(G.Net.hostUid) === 'relay')), 80, 4, 1000);
}

/** Los dos de vuelta en su sala con la conexión por el servidor. */
const bothBack = async () =>
  (await A.eval(u => G.Social.room && G.Social.room.members.every((m: any) => !m.away) && G.Net.mode(u) === 'relay', uidB))
  && (await B.eval(() => G.Social.room && G.Social.room.members.every((m: any) => !m.away) && G.Net.mode(G.Net.hostUid) === 'relay'));
/** Se cae el servidor, pasa `during`, y vuelve (misma base, mismo reloj): los dos navegadores reconectan solos. */
async function serverRestart(during: () => Promise<unknown>) {
  rig.down();
  await rig.run(3);
  await during();
  rig.up();
  await rig.until('los dos vuelven a la sala', bothBack, 80, 4, 1000);
}

let nameA = '', nameB = '', uidA = '', uidB = '';

describe('cooperativo', () => {
  test('cuentas y amistad', async () => {
    const sfx = Math.random().toString(36).slice(2, 6);
    nameA = 'Anfi' + sfx; nameB = 'Invi' + sfx;
    await newPlayer(A, nameA, 25);
    await newPlayer(B, nameB, 4);
    expect(await A.eval(() => G.DB.online) && await B.eval(() => G.DB.online)).toBe(true);   // con cuenta en el servidor, lo online está encendido
    expect(await A.eval(() => G.Social.start())).toBe('ok');
    expect(await B.eval(() => G.Social.start())).toBe('ok');
    expect(await A.eval(n => G.Social.me.name === n, nameA)).toBe(true);                    // el apodo es el nombre de la cuenta
    const nick = await A.eval(n => G.Social.claimNick(n), nameA);
    const nick2 = await A.eval(() => G.Social.claimNick('OtroNombre'));
    expect(nick.ok && !nick2.ok).toBe(true);
    await waitPage(A, 'A conectado', () => G.Net.up);
    await waitPage(B, 'B conectado', () => G.Net.up);

    uidA = await A.eval(() => G.Social.uid); uidB = await B.eval(() => G.Social.uid);
    expect((await A.eval(n => G.Social.request(n), nameA)).ok).toBe(false);                // a ti mismo no
    expect((await A.eval(() => G.Social.request('NadieAsi99'))).ok).toBe(false);           // ni a un nombre que no existe
    const rq = await A.eval(n => G.Social.request(n), nameB);
    expect(rq.ok).toBe(true);
    await waitPage(B, 'B recibe la solicitud por el WebSocket', u => G.Social.friends.some((f: any) => f.uid === u && f.status === 'in'), uidA);
    expect((await B.eval(u => G.Social.accept(u), uidA)).ok).toBe(true);
    await waitPage(A, 'A ve a B en línea', u => G.Social.friends.some((f: any) => f.uid === u && f.status === 'ok' && f.online), uidB);
    await waitPage(B, 'B ve a A en línea', u => G.Social.friends.some((f: any) => f.uid === u && f.status === 'ok' && f.online), uidA);

    // Perfil público: se publica tras 0,8 s de página y se lee desde el otro.
    await A.eval(() => { G.DB.save.profile = G.DB.save.profile || {}; G.DB.save.profile.title = ''; G.DB.save.profile.favs = [{ dex: 25, shiny: false }]; G.Social.publishProfile(true); });
    await rig.run(60, 1);
    const prof = await B.eval(u => G.Social.getProfile(u), uidA);
    expect(prof && prof.name === nameA && prof.favs.length === 1 && prof.favs[0].dex === 25).toBe(true);
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
  });

  test('sala, invitación y partida en grupo', async () => {
    const inv = await A.call(u => G.Social.invite(u), uidB);
    expect(inv.ok).toBe(true);
    await waitPage(A, 'A tiene su sala', () => G.Social.room && G.Social.room.isHost);
    await waitPage(B, 'B recibe la invitación', u => G.Social.invites.some((i: any) => i.from === u), uidA);
    expect((await B.call(u => G.Social.acceptInvite(u), uidA)).ok).toBe(true);
    await waitPage(A, 'A ve a los dos en la sala', () => G.Social.room.members.length === 2);
    await waitPage(B, 'B ve la sala', () => G.Social.room && G.Social.room.members.length === 2 && !G.Social.room.isHost);
    // Net se conecta cuando se abre la sala (LobbyUI), en los dos.
    await A.eval(() => G.LobbyUI.open());
    await B.eval(() => G.LobbyUI.open());
    await waitPage(A, 'Net de A por el servidor', u => G.Net.open_ && G.Net.mode(u) === 'relay', uidB);
    await waitPage(B, 'Net de B por el servidor', u => G.Net.open_ && G.Net.mode(u) === 'relay', uidA);
    expect(await A.eval(() => G.Social.room.members.map((m: any) => [m.name, m.dex]))).toEqual([[nameA, 25], [nameB, 4]]);

    await waitPage(A, 'el botón de empezar se habilita', () => !(document.getElementById('lobby-start') as HTMLButtonElement).disabled);
    expect(await B.eval(() => document.getElementById('lobby-start').classList.contains('hidden'))).toBe(true);   // el invitado no empieza
    await click(A, '#lobby-start');
    await waitPage(A, 'A juega en grupo', () => G.Coop.active && G.Game.state === 'playing');
    await waitPage(B, 'B entra en la misma partida', () => G.Coop.active && G.Game.state === 'playing');
    expect(await A.eval(() => G.Coop.isHost && G.Coop.members.length === 2)).toBe(true);
    expect(await B.eval(() => !G.Coop.isHost && G.Coop.members.length === 2)).toBe(true);
    await waitPage(A, 'A ve que B juega', u => G.Social.friends.find((f: any) => f.uid === u).play, uidB);
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
  });

  test('enemigos del anfitrión en el invitado, compañeros y golpes', async () => {
    // Los dos aguantan lo que haga falta: la prueba no va de sobrevivir.
    for (const d of [A, B]) await d.eval(() => { const p = G.Game.player; p.maxHp = p.hp = 1e7; });
    await A.eval(() => {
      const def = G.Enemies.bagAt(60)[0], pl = G.Game.player;
      for (let i = 0; i < 6; i++) {
        const e = new G.Enemy(def, pl.x + Math.cos(i) * 220, pl.y + Math.sin(i) * 220, G.Enemies.scale(60));
        G.EnemyMgr.add(e);
      }
    });
    await waitPage(B, 'B ve copias de los enemigos', () => G.EnemyMgr.all().filter((e: any) => e.remote).length >= 4);
    const guest: number[] = await B.eval(() => G.EnemyMgr.all().filter((e: any) => e.remote).map((e: any) => e.id));
    expect(guest.length).toBeGreaterThan(0);
    const hostIds: number[] = await A.eval(() => G.EnemyMgr.all().map((e: any) => e.id));
    expect(guest.filter(i => hostIds.includes(i)).length).toBe(guest.length);               // las copias son de enemigos del anfitrión

    // Compañeros: cada uno ve moverse al otro.
    await A.eval(() => { const p = G.Game.player; p.x += 400; p.y -= 250; });
    await waitPage(B, 'B ve moverse a A', () => { const m = G.Coop.mates[0]; return m && m.pl.net.x > 300; });
    await B.eval(() => { const p = G.Game.player; p.x -= 500; });
    await waitPage(A, 'A ve moverse a B', () => { const m = G.Coop.mates[0]; return m && m.pl.net.x < -300; });

    // Los golpes del invitado llegan al anfitrión, que los aplica (un daño marcado, 7,77).
    const target = await B.eval(() => {
      const e = G.EnemyMgr.all().find((x: any) => x.remote && !x.dead && !x.boss);
      if (e) G.Coop.hit(e, 7.77, '#ffffff', 0, 0, 0);
      return e ? e.id : null;
    });
    expect(target).not.toBeNull();
    await A.eval(id => {
      const e = G.EnemyMgr.get(id);
      window.__got = false;
      const orig = e.hurt.bind(e);
      e.hurt = (...args: any[]) => { if (args[0] === 7.77) window.__got = true; return orig(...args); };
    }, target);
    await B.eval(id => { G.Coop.hit(G.EnemyMgr.get(id), 7.77, '#ffffff', 0, 0, 0); }, target);
    await waitPage(A, 'el golpe del invitado llega al anfitrión', () => window.__got === true);
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
  });

  test('cartas de nivel: esperan a los dos', async () => {
    await A.eval(() => G.Game.debugLevelUp());
    await waitPage(A, 'cartas en A', () => G.Game.state === 'levelup');
    await waitPage(B, 'cartas en B', () => G.Game.state === 'levelup');
    await click(A, '#cards .card');
    await rig.run(30);
    expect(await state(A)).toBe('levelup');                                   // con uno solo que elija, la partida sigue parada para los dos
    expect(await state(B)).toBe('levelup');
    expect(await A.eval(() => document.getElementById('lvl-wait').textContent)).toMatch(/Esperando|Faltan/);
    await click(B, '#cards .card');
    await waitPage(A, 'A sigue', () => G.Game.state === 'playing');
    await waitPage(B, 'B sigue', () => G.Game.state === 'playing');
  });

  test('el invitado se corta y vuelve: recupera enemigos, clima, grieta y las cartas que se perdió', async () => {
    const hostRoom = await A.eval(() => G.Social.room.id);
    rig.cut(B);
    await waitPage(A, 'A ve a B ausente', u => G.Net.mode(u) === 'connecting', uidB);
    // Sin B, el anfitrión pone nieve, abre una grieta, hace nacer enemigos y sube de nivel: avisos que B se pierde.
    await A.eval(() => G.Weather.debugStart('snow', 600));
    for (let i = 0; i < 8 && !(await A.eval(() => G.Rift.snapshot().rift)); i++) await A.eval(() => G.Rift.debugOpen());
    const hostRift: number[] = await A.eval(() => G.Rift.snapshot().rift);
    expect(hostRift).toBeTruthy();
    await A.eval(() => {
      const def = G.Enemies.bagAt(60)[0], pl = G.Game.player;
      for (let i = 0; i < 8; i++) G.EnemyMgr.add(new G.Enemy(def, pl.x + Math.cos(i * 0.8) * 240, pl.y + Math.sin(i * 0.8) * 240, G.Enemies.scale(60)));
      G.Game.debugLevelUp();
    });
    await waitPage(A, 'A sube de nivel (las cartas esperan al otro)', () => G.Game.state === 'levelup');
    await rig.run(10);
    expect(await B.eval(() => G.Coop.active)).toBe(true);                       // B sigue en su partida, sin conexión

    rig.heal(B);
    await rig.until('B vuelve a su sala', async () => (await A.eval(() => G.Social.room.members.every((m: any) => !m.away))) && (await B.eval(() => G.Social.room && G.Social.room.members.every((m: any) => !m.away) && G.Net.mode(G.Net.hostUid) === 'relay')), 60, 4, 1000);
    expect(await B.eval(() => G.Social.room.id)).toBe(hostRoom);                 // es la misma sala
    await waitPage(B, 'B recibe las cartas que se perdió', () => G.Game.state === 'levelup');
    await click(B, '#cards .card');
    await click(A, '#cards .card');
    await waitPage(A, 'A sigue', () => G.Game.state === 'playing');
    await waitPage(B, 'B sigue', () => G.Game.state === 'playing');
    const wxA = await A.eval(() => G.Weather.snapshot()), wxB = await B.eval(() => G.Weather.snapshot());
    expect(wxB && wxA && wxB.kind === 'snow' && wxB.dur === wxA.dur && Math.abs(wxB.t - wxA.t) < 15).toBe(true);   // recupera el clima en curso
    const riftB: number[] = await B.eval(() => G.Rift.snapshot().rift);
    expect(riftB && Math.hypot(riftB[0] - hostRift[0], riftB[1] - hostRift[1]) < 2).toBe(true);                 // y la grieta, en el mismo sitio
    // Ve los enemigos del anfitrión que tiene cerca, y no le quedan fantasmas.
    await rig.run(20);
    const hostNear: number[] = await A.eval(() => {
      const m = G.Coop.mates[0].pl.net;
      return G.EnemyMgr.all().filter((e: any) => !e.dead && Math.hypot(e.x - m.x, e.y - m.y) < 800).map((e: any) => e.id);
    });
    const guestSeen: number[] = await B.eval(() => G.EnemyMgr.all().filter((e: any) => e.remote).map((e: any) => e.id));
    expect(hostNear.length).toBeGreaterThan(0);
    expect(hostNear.filter(i => !guestSeen.includes(i))).toEqual([]);
    const hostAll: number[] = await A.eval(() => G.EnemyMgr.all().filter((e: any) => !e.dead).map((e: any) => e.id));
    expect(guestSeen.filter(i => !hostAll.includes(i)).length).toBeLessThanOrEqual(2);
    // Sus golpes vuelven a llegar.
    await A.eval(() => { window.__got = false; });
    const t2 = await B.eval(() => { const e = G.EnemyMgr.all().find((x: any) => x.remote && !x.dead && !x.boss); return e ? e.id : null; });
    await A.eval(id => { const e = G.EnemyMgr.get(id); const orig = e.hurt.bind(e); e.hurt = (...a: any[]) => { if (a[0] === 8.88) window.__got = true; return orig(...a); }; }, t2);
    await B.eval(id => { G.Coop.hit(G.EnemyMgr.get(id), 8.88, '#ffffff', 0, 0, 0); }, t2);
    await waitPage(A, 'los golpes del invitado vuelven a llegar', () => window.__got === true);
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
  });

  // El premio de una grieta ganada mientras el invitado está fuera (src/systems/rift.ts: paid / last / payLast).
  for (const acabada of [true, false]) {
    test(acabada ? 'arena ganada con B fuera, ya acabada al volver: B recibe el premio una sola vez' : 'arena ganada con B fuera, A aún dentro al volver: B entra, la ve ganada y recibe el premio una sola vez', async () => {
      await hookFuse(A); await hookFuse(B);
      await dismiss(A); await dismiss(B);
      await A.eval(() => G.Rift.debugArena('fire'));
      await waitPage(B, 'B dentro de la arena', () => G.Rift.inArena);
      const w0 = await stat(B), h0 = await stat(A);
      const legendDex: number = await A.eval(() => G.Rift.snapshot().arena.cfg.dex);
      await dropAndReturn(async () => {
        await A.eval(() => {
          G.Game.player.xpNext = 1e9;                                           // sin subidas de nivel que esperen al invitado
          G.EnemyMgr.all().find((e: any) => e.legend).hurt(1e9);                       // A vence al legendario
        });
        await rig.until('A ha ganado', () => A.eval(() => { const s = G.Rift.snapshot().arena; return !s || s.phase === 'won'; }));
        if (acabada) {
          // Gana, recoge el botín y sale de la arena con B fuera.
          await rig.until('A sale de la arena', async () => { await dismiss(A); return A.eval(() => !G.Rift.inArena); }, 200, 30);
        } else {
          await A.eval(() => G.Game.debugLevelUp());                            // la partida se para con la arena ya ganada
          await waitPage(A, 'A con cartas', () => G.Game.state === 'levelup');
        }
      });
      if (acabada) expect(await A.eval(() => !G.Rift.inArena)).toBe(true);
      else {
        expect(await A.eval(() => G.Rift.inArena && G.Rift.snapshot().arena.phase === 'won')).toBe(true);
        await waitPage(B, 'B entra y la ve ganada', () => G.Rift.inArena && G.Rift.snapshot().arena.phase === 'won');
        await waitPage(B, 'las cartas que quedaron esperando también le salen', () => G.Game.state === 'levelup');
        await click(B, '#cards .card'); await click(A, '#cards .card');
        await waitPage(A, 'A sigue', () => G.Game.state === 'playing');
      }
      await rig.until('los dos fuera de la arena', async () => { await dismiss(A); await dismiss(B); return (await A.eval(() => !G.Rift.inArena)) && (await B.eval(() => !G.Rift.inArena)); }, 300, 30);
      await rig.run(5);
      await dismiss(A); await dismiss(B);
      const h1 = await stat(A), w1 = await stat(B);
      expect(diff(h1, h0)).toMatchObject({ bonds: 1, wins: 1 });                // A: su vínculo y su victoria de grieta
      expect(diff(w1, w0)).toEqual(diff(h1, h0));                               // B recibe exactamente lo mismo
      expect(await B.eval(dx => !!G.DB.save.legends[dx], legendDex)).toBe(true);
      // Reconectar otra vez no repite el premio.
      const paid = await B.eval(() => G.Rift.debugPaid.paid.length);
      await dropAndReturn(async () => { await rig.run(5); });
      await rig.run(20);
      expect(await stat(B)).toEqual(w1);
      expect(await stat(A)).toEqual(h1);
      expect(await B.eval(() => G.Rift.debugPaid.paid.length)).toBe(paid);
      expect(await A.allErrors()).toEqual([]);
      expect(await B.allErrors()).toEqual([]);
    });
  }

  test('arena perdida con B fuera: al volver sale de la arena sin ningún premio', async () => {
    await A.eval(() => G.Rift.debugArena('ice'));
    await waitPage(B, 'B dentro de la arena', () => G.Rift.inArena);
    const cfg = await A.eval(() => G.Rift.snapshot().arena.cfg);
    const w0 = await stat(B);
    await dropAndReturn(async () => {
      await A.eval(c => G.Rift.restore({ rift: null, arena: { cfg: c, phase: 'fight', t: 999 } }), cfg);      // se agota el tiempo en A
      await rig.until('A sale de la arena', async () => { await dismiss(A); return A.eval(() => !G.Rift.inArena); }, 200, 30);
    });
    await waitPage(B, 'B también sale de la arena (no se queda atrapado)', () => !G.Rift.inArena);
    await rig.run(10);
    expect(await stat(B)).toEqual(w0);
    expect(await B.eval(() => G.Rift.debugPaid.last?.won)).toBe(false);
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
  });

  test('el servidor se reinicia a mitad de la partida: 600 enemigos y 400 objetos que el invitado no conoce', async () => {
    const hostRoom = await A.eval(() => G.Social.room.id);
    await A.eval(() => { G.Game.player.xpNext = 1e9; G.EnemyMgr.clear(); G.Pickups.clear(); });   // matar tantos enemigos no debe subir de nivel
    await B.eval(() => { G.EnemyMgr.clearRemote(); G.Pickups.clear(); });
    let made: number[] = [];
    B.log = [];
    await serverRestart(async () => {
      expect(await A.eval(() => G.Coop.active)).toBe(true);                    // sin servidor la partida sigue en los dos navegadores
      expect(await B.eval(() => G.Coop.active)).toBe(true);
      made = await A.eval(() => {
        const def = G.Enemies.bagAt(60)[0], pl = G.Game.player, ids: number[] = [];
        for (let i = 0; i < 600; i++) {
          const ang = i * 0.7, d = 150 + (i % 40) * 12;
          const e = new G.Enemy(def, pl.x + Math.cos(ang) * d, pl.y + Math.sin(ang) * d, G.Enemies.scale(60));
          G.EnemyMgr.add(e); ids.push(e.id);
        }
        for (let i = 0; i < 400; i++) G.Pickups.drop('coin', pl.x + (i % 20) * 10, pl.y + Math.floor(i / 20) * 10);
        return ids;
      });
    });
    expect(await B.eval(() => G.Social.room.id)).toBe(hostRoom);                // la misma sala, guardada en SQLite
    await waitPage(B, 'B acaba teniendo los 600 enemigos', () => G.EnemyMgr.all().filter((e: any) => e.remote).length >= 590);
    await rig.run(10);
    const alive: number[] = await A.eval(ids => ids.filter(id => { const e = G.EnemyMgr.get(id); return e && !e.dead; }), made);
    const seen: number[] = await B.eval(ids => ids.filter(id => G.EnemyMgr.get(id)), alive);
    expect(alive.length).toBeGreaterThan(500);
    expect(seen.length).toBe(alive.length);                                     // sin faltar ninguno
    expect(await B.eval(() => G.Pickups.all().length)).toBeGreaterThanOrEqual(300);
    // Lo que llegó por el cable: ningún mensaje pasa de 64 KB ni ningún fotograma de 150 eventos, y en orden.
    const log = B.log!;
    B.log = null;
    expect(Math.max(...log.map(m => m.length))).toBeLessThan(64 * 1024);
    const frames = log.map(m => JSON.parse(m)).filter(m => m.k === 'g' && m.d && m.d.k === 'f');
    expect(frames.every(f => (f.d.ev || []).length <= 150)).toBe(true);
    const evs: any[][] = [];
    let started = false;
    for (const f of frames) for (const ev of f.d.ev || []) { if (ev[0] === 'rs') started = true; if (started) evs.push(ev); }
    const batch = evs.slice(0, evs.findIndex(e => e[0] === 'hp') + 1);
    const kinds = batch.map(e => e[0]).filter((k, i, arr) => k !== arr[i - 1]);
    expect(batch.length).toBeGreaterThan(900);
    expect(batch.filter(e => e[0] === 'ne').length).toBeGreaterThanOrEqual(590);
    expect(batch.filter(e => e[0] === 'pk').length).toBeGreaterThanOrEqual(300);
    expect(['rs,st,ne,pk,lr,hp', 'rs,st,ne,pk,pb,lr,hp']).toContain(kinds.join(','));
    await A.eval(() => { G.EnemyMgr.clear(); G.Pickups.clear(); });
    await B.eval(() => { G.EnemyMgr.clearRemote(); G.Pickups.clear(); });
    // La partida sigue: los golpes de B vuelven a llegar a A.
    await A.eval(() => { const e = new G.Enemy(G.Enemies.bagAt(60)[0], G.Game.player.x + 150, G.Game.player.y, G.Enemies.scale(60)); G.EnemyMgr.add(e); window.__got = false; const o = e.hurt.bind(e); e.hurt = (...a: any[]) => { if (a[0] === 9.99) window.__got = true; return o(...a); }; });
    await waitPage(B, 'B ve el enemigo nuevo', () => G.EnemyMgr.all().some((e: any) => e.remote));
    await B.eval(() => { G.Coop.hit(G.EnemyMgr.all().find((e: any) => e.remote), 9.99, '#ffffff', 0, 0, 0); });
    await waitPage(A, 'el golpe llega tras el reinicio', () => window.__got === true);
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
  });

  test('la Sentencia de Arceus que empieza con B fuera: al volver está también en ella', async () => {
    await A.eval(() => { G.EnemyMgr.clear(); });
    await dropAndReturn(async () => {
      await A.eval(() => G.Judgment.debugStart());
      expect(await A.eval(() => G.Judgment.active)).toBe(true);
      await rig.until('A llega a la pelea con Arceus', () => A.eval(() => !!G.Judgment.summary()), 100, 30);
    });
    await waitPage(B, 'B también está en la Sentencia', () => G.Judgment.active);
    await waitPage(B, 'y en la misma fase', () => { const s = G.Judgment.snapshot(); return s && s.phase === 'fight'; });
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
  });

  test('el anfitrión sale: la partida acaba para los dos', async () => {
    await A.eval(() => G.Game.quit());
    await waitPage(B, 'la partida acaba también para B', () => G.Game.state === 'over' && !G.Coop.active);
    expect(await state(A)).toBe('over');
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
  });

  // ---------------- Defensa en grupo (modes/td.ts) ----------------

  test('Defensa en grupo: el anfitrión elige modo y mapa en la sala, y empieza para los dos', async () => {
    await click(A, '#btn-again');
    await click(B, '#btn-again');
    await waitPage(A, 'A de vuelta en la sala', () => G.Social.room && G.Social.room.members.length === 2 && G.Game.state === 'ui');
    await waitPage(B, 'B de vuelta en la sala', () => G.Social.room && G.Game.state === 'ui');
    await A.eval(() => G.LobbyUI.setGame('td', 'zigzag'));
    await waitPage(B, 'B ve que se juega a Defensa en Zigzag', () => G.LobbyUI.game.mode === 'td' && G.LobbyUI.game.map === 'zigzag');
    expect(await B.eval(() => document.getElementById('lobby-mode').textContent)).toContain('Defensa');
    await waitPage(A, 'A puede empezar', () => !(document.getElementById('lobby-start') as HTMLButtonElement).disabled);
    await click(A, '#lobby-start');
    for (const d of [A, B]) await waitPage(d, 'en la Defensa en grupo', () => G.Run.mode && G.Run.mode.id === 'td' && G.Coop.active && G.Game.state === 'playing');
    const a = await A.eval(() => G.TD.net), b = await B.eval(() => G.TD.net);
    expect([a.coop, a.host, a.map, b.coop, b.host, b.map]).toEqual([true, true, 'zigzag', true, false, 'zigzag']);
    // Cada uno con su cartera (las lleva el anfitrión; el invitado recibe la suya).
    expect(a.purse).toEqual({ [uidA]: 150, [uidB]: 150 });
    await waitPage(B, 'B recibe el estado del anfitrión', u => G.TD.net.purse[u] === 150, uidB);
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
  });

  /** Un sitio libre junto al camino (el n-ésimo, por cercanía al camino), según lo que ve esa página. */
  const freeSpot = (d: Dev, n = 0) => d.eval(k => {
    const r = G.TD.route, out: { x: number; y: number; d: number }[] = [];
    const seg = (x: number, y: number, a: any, b: any) => {
      const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l)) : 0;
      return Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
    };
    for (let x = -600; x <= 600; x += 24) for (let y = -600; y <= 600; y += 24) {
      if (!G.TD.canPlace(x, y)) continue;
      let dm = Infinity;
      for (let i = 1; i < r.length; i++) dm = Math.min(dm, seg(x, y, r[i - 1], r[i]));
      if (dm < 110) out.push({ x, y, d: Math.abs(x) + Math.abs(y) });
    }
    out.sort((p, q) => p.d - q.d);
    return out[k * 7];
  }, n);
  /** Planta en esa página la primera torre que se pueda comprar de su tienda, en un sitio libre. */
  async function plantOn(d: Dev, n: number) {
    const s = await freeSpot(d, n);
    expect(s).toBeTruthy();
    await d.eval(p => { const dex = G.TD.info.shop[0]; G.TD.debugBuy(dex); G.TD.debugPlace(p.x, p.y); }, s);
    return s;
  }

  test('Defensa en grupo: cada uno planta con sus monedas, y sólo el dueño toca su torre', async () => {
    // B (invitado) pide plantar: lo hace el anfitrión con el dinero de B.
    const sb = await plantOn(B, 0);
    await waitPage(A, 'A ve la torre de B', u => G.TD.net.towers.some((t: any) => t.owner === u), uidB);
    await waitPage(B, 'B ve su torre', u => G.TD.net.towers.some((t: any) => t.owner === u), uidB);
    const cost = await A.eval(u => 150 - G.TD.net.purse[u], uidB);
    expect(cost).toBeGreaterThan(0);
    expect(await A.eval(u => G.TD.net.purse[u], uidA)).toBe(150);                // la de A no se toca
    await waitPage(B, 'a B le cobran lo suyo', c => G.TD.info.money === 150 - c, cost);
    expect(await B.eval(() => G.TD.net.towers[0])).toMatchObject({ x: sb.x, y: sb.y, level: 1 });
    // A planta la suya; B la ve, de A.
    await plantOn(A, 3);
    await waitPage(B, 'B ve la torre de A', u => G.TD.net.towers.some((t: any) => t.owner === u), uidA);
    expect(await A.eval(() => G.TD.net.towers.map((t: any) => [t.id, t.owner]))).toEqual(await B.eval(() => G.TD.net.towers.map((t: any) => [t.id, t.owner])));

    // B intenta mejorar y vender la de A: el anfitrión no le hace caso.
    const iA = await B.eval(u => G.TD.net.towers.findIndex((t: any) => t.owner === u), uidA);
    const moneyB = await A.eval(u => G.TD.net.purse[u], uidB);
    await B.eval(i => { G.TD.debugUpgrade(i); G.TD.debugSell(i); G.TD.debugCycleMode(i); }, iA);
    await rig.run(10);
    const ta = await A.eval(u => G.TD.net.towers.find((t: any) => t.owner === u), uidA);
    expect([ta.level, ta.mode]).toEqual([1, 'first']);
    expect(await A.eval(u => G.TD.net.purse[u], uidB)).toBe(moneyB);
    // En el panel, la de un compañero no tiene botones.
    await B.eval(i => G.TD.debugSelect(i), iA);
    expect(await B.eval(() => [!!document.querySelector('#td-panel [data-a=up]'), document.getElementById('td-panel').textContent.includes(G.Coop.members[0].name)])).toEqual([false, true]);

    // B no puede plantar encima de una torre: el anfitrión se lo dice y no cobra.
    await B.eval(p => { G.TD.debugBuy(G.TD.info.shop[0]); }, null);
    await B.eval(p => { G.TD.debugPlace(p.x, p.y); }, sb);
    await rig.run(10);
    expect(await A.eval(u => G.TD.net.towers.filter((t: any) => t.owner === u).length, uidB)).toBe(1);
    expect(await A.eval(u => G.TD.net.purse[u], uidB)).toBe(moneyB);

    // B mejora la suya (y cambia a quién ataca): se ve igual en los dos.
    const iB = await B.eval(u => G.TD.net.towers.findIndex((t: any) => t.owner === u), uidB);
    await B.eval(i => { G.TD.debugUpgrade(i); G.TD.debugCycleMode(i); }, iB);
    await waitPage(A, 'la torre de B sube de nivel en el anfitrión', u => { const t = G.TD.net.towers.find((x: any) => x.owner === u); return t.level === 2 && t.mode === 'last'; }, uidB);
    await waitPage(B, 'y en B', u => { const t = G.TD.net.towers.find((x: any) => x.owner === u); return t.level === 2 && t.mode === 'last'; }, uidB);
    expect(await A.eval(u => G.TD.net.purse[u], uidB)).toBeLessThan(moneyB);

    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
  });

  test('Defensa en grupo: las oleadas, los ataques de las torres en los dos y las monedas para los dos', async () => {
    // Los héroes aguantan y casi no pegan: así los enemigos llegan a las torres (si no, los héroes los barren antes).
    for (const d of [A, B]) await d.eval(() => { const p = G.Game.player; p.maxHp = p.hp = 1e7; p.atkMul = 0.001; });
    const before = await A.eval(() => ({ ...G.TD.net.purse }));
    await B.eval(() => G.TD.debugCallWave());                       // el invitado también puede adelantarla
    await waitPage(A, 'empieza la oleada 1', () => G.TD.info.wave === 1);
    await waitPage(B, 'B ve copias de los enemigos', () => G.EnemyMgr.all().some((e: any) => e.remote));
    await rig.until('se supera la oleada 1', () => A.eval(() => G.TD.net.cleared >= 1), 600);
    // Las torres del anfitrión han atacado, y el invitado ha visto esos ataques en sus copias.
    expect(await A.eval(() => G.TD.net.towers.some((t: any) => t.shots > 0))).toBe(true);
    await waitPage(B, 'B ve atacar a las torres', () => G.TD.net.towers.some((t: any) => t.shots > 0));
    // Por cada enemigo y por la oleada cobran los dos lo mismo.
    const after = await A.eval(() => ({ ...G.TD.net.purse }));
    expect(after[uidA] - before[uidA]).toBeGreaterThan(0);
    expect(after[uidA] - before[uidA]).toBe(after[uidB] - before[uidB]);
    await waitPage(B, 'B ve sus monedas', ([u, m]) => G.TD.info.money === m, [uidB, after[uidB]]);
    // Enseñar un ataque (como subir una habilidad): B a la suya sí; a la de A, no.
    const iA2 = await B.eval(u => G.TD.net.towers.findIndex((t: any) => t.owner === u), uidA);
    const iB2 = await B.eval(u => G.TD.net.towers.findIndex((t: any) => t.owner === u), uidB);
    await B.eval(i => G.TD.debugLearn(i), iA2);
    await rig.run(8);
    expect(await A.eval(u => G.TD.net.towers.find((t: any) => t.owner === u).learned, uidA)).toEqual([]);
    const moneyL = await A.eval(u => G.TD.net.purse[u], uidB);
    const spentL = await A.eval(u => G.TD.net.towers.find((t: any) => t.owner === u).spent, uidB);
    const learnt = await B.eval(i => G.TD.debugLearn(i), iB2);
    expect(typeof learnt).toBe('string');
    await waitPage(A, 'el anfitrión enseña el ataque a la torre de B', ([u, m]) => G.TD.net.towers.find((t: any) => t.owner === u).moves.includes(m), [uidB, learnt]);
    await waitPage(B, 'y B lo ve en su copia', ([u, m]) => G.TD.net.towers.find((t: any) => t.owner === u).learned.includes(m), [uidB, learnt]);
    const paid = moneyL - await A.eval(u => G.TD.net.purse[u], uidB);
    expect(paid).toBeGreaterThan(0);
    expect(await A.eval(u => G.TD.net.towers.find((t: any) => t.owner === u).spent, uidB)).toBe(spentL + paid);
    expect(await B.eval(() => [G.TD.info.wave, G.TD.net.cleared, G.TD.info.lives])).toEqual(await A.eval(() => [G.TD.info.wave, G.TD.net.cleared, G.TD.info.lives]));
    // Un legendario derrotado se une a la tienda de los dos (trofeo, caro) y el invitado lo puede plantar.
    await A.eval(() => { const id = G.TD.debugBoss(484, true); G.EnemyMgr.get(id).hurt(1e12, '#ffffff'); });
    for (const d of [A, B]) await waitPage(d, 'Palkia pasa a la tienda', () => G.TD.shop.some((c: any) => c.dex === 484 && c.trophy && c.cost === 300));
    // El anfitrión no se deja engañar: ni un trofeo que nadie ha ganado (Dialga) ni uno que no se puede pagar.
    const pb = await A.eval(u => G.TD.net.purse[u], uidB);
    expect(pb).toBeLessThan(300);
    const sp = await freeSpot(B, 2);
    await B.eval(p => { G.Coop.toHost(['tp', 483, p.x, p.y, 0, 1]); G.Coop.toHost(['tp', 484, p.x, p.y, 0, 1]); }, sp);
    await rig.run(10);
    expect(await A.eval(() => G.TD.net.towers.some((t: any) => t.dex === 483 || t.dex === 484))).toBe(false);
    expect(await A.eval(u => G.TD.net.purse[u], uidB)).toBe(pb);
    // La velocidad la elige el anfitrión (el invitado no puede).
    await B.eval(() => G.TD.debugFast(true));
    await rig.run(5);
    expect(await A.eval(() => G.TD.net.fast)).toBe(false);
    await A.eval(() => G.TD.debugFast(true));
    await waitPage(B, 'B ve el ×2 del anfitrión', () => G.TD.net.fast === true);
    await A.eval(() => G.TD.debugFast(false));
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
  });

  test('Defensa en grupo: el invitado se corta y vuelve con las torres y el estado de ahora', async () => {
    await dropAndReturn(async () => {
      // Mientras B no está: A planta otra, vende la primera suya y la de B sube de nivel... no (sólo B la toca).
      await plantOn(A, 6);
      await rig.run(5);
      const iA = await A.eval(u => G.TD.net.towers.findIndex((t: any) => t.owner === u), uidA);
      await A.eval(i => G.TD.debugSell(i), iA);
      await rig.run(5);
    });
    const want = await A.eval(() => G.TD.net.towers.map((t: any) => [t.id, t.owner, t.dex, t.level, t.mode]));
    await waitPage(B, 'B tiene las mismas torres que el anfitrión', w => JSON.stringify(G.TD.net.towers.map((t: any) => [t.id, t.owner, t.dex, t.level, t.mode])) === w, JSON.stringify(want));
    await waitPage(B, 'y las mismas monedas y vidas', ([u, m, l]) => G.TD.info.money === m && G.TD.info.lives === l,
      [uidB, await A.eval(u => G.TD.net.purse[u], uidB), await A.eval(() => G.TD.info.lives)]);
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
  });

  test('Defensa en grupo: al acabar, premio para los dos y la marca del equipo en el ranking', async () => {
    const s0 = await Promise.all([A, B].map(d => d.eval(() => ({ coins: G.DB.save.coins, runs: G.DB.save.stats.tdRuns || 0, group: G.DB.save.stats.groupRuns || 0 }))));
    const sum = await A.eval(() => ({ w: G.TD.net.cleared, k: G.Game.player.kills }));
    expect(sum.w).toBeGreaterThanOrEqual(1);
    // Las pruebas de arena de antes marcan las dos cuentas (ganan premios en muy poco tiempo de reloj falso, ver
    // server/save-rules.ts); una cuenta marcada no sube marcas. Aquí se desmarcan para poder ver la del equipo.
    rig.srv!.db.raw.run('DELETE FROM ranking_marked');
    // El anfitrión termina: se acaba para los dos.
    await A.eval(() => G.Game.quit());
    await waitPage(B, 'la Defensa acaba también para B', () => G.Game.state === 'over' && !G.Coop.active);
    expect(await state(A)).toBe('over');
    const s1 = await Promise.all([A, B].map(d => d.eval(() => ({ coins: G.DB.save.coins, runs: G.DB.save.stats.tdRuns || 0, group: G.DB.save.stats.groupRuns || 0 }))));
    for (const i of [0, 1]) {
      expect(s1[i].runs - s0[i].runs).toBe(1);
      expect(s1[i].group - s0[i].group).toBe(1);
      expect(s1[i].coins - s0[i].coins).toBeGreaterThanOrEqual(sum.w * 10);
    }
    // El anfitrión sube la marca del equipo (modo 'e', con los dos).
    const id = [Number(uidA), Number(uidB)].sort((x, y) => x - y).join('_');
    await rig.until('la marca del equipo llega al ranking', () => (rig.srv!.db.raw.query("SELECT COUNT(*) AS n FROM ranking_entries WHERE board LIKE 'e!_%' ESCAPE '!' AND id = ?").get(id) as any).n > 0, 80);
    const row = rig.srv!.db.raw.query("SELECT t, lv FROM ranking_entries WHERE board = 'e_all2' AND id = ?").get(id) as any;
    expect(row.lv).toBe(sum.w);
    // Para la prueba de después (una de hordas), la sala vuelve a las hordas.
    await A.eval(() => G.LobbyUI.setGame('hordas'));
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
  });

  // ---------------- salas públicas y espectadores (net/spectate.ts) ----------------

  let nameC = '', roomId = '';
  /** Lo que C tiene en su cuenta (para ver que mirar no da nada). */
  // (Antes se cobran los logros pendientes, como el de tener tu primer Pokémon: no tienen que ver con mirar.)
  const cAccount = () => C.eval(() => (G.Progress.checkAch(), { coins: G.DB.save.coins, td: G.DB.save.stats.tdRuns || 0, runs: G.DB.save.stats.runs || 0, kills: G.DB.save.stats.totalKills || 0 }));

  test('sala pública: sale en la lista de otro jugador (sin ser amigos) y se puede mirar en cuanto empieza', async () => {
    nameC = 'Mira' + Math.random().toString(36).slice(2, 6);
    await newPlayer(C, nameC, 7);
    expect(await C.eval(() => G.Social.start())).toBe('ok');
    await waitPage(C, 'C conectado', () => G.Net.up);
    // "Crear sala pública" (sin invitar a nadie): se crea, sale en la lista y se abre la sala.
    await C.eval(() => G.RoomsUI.open());
    await click(C, '#rooms-create');
    await waitPage(C, 'C tiene su sala pública', () => G.Social.room && G.Social.room.isHost && G.Social.room.pub && G.UI.isOpen('scr-lobby'));
    expect(await A.call(n => G.Social.listRooms().then((l: any[]) => l.some(r => r.hostName === n)), nameC)).toBe(true);
    await C.call(() => G.Social.leaveRoom());
    await waitPage(C, 'y la deja', () => !G.Social.room);
    await click(A, '#btn-again');
    await click(B, '#btn-again');
    await waitPage(A, 'A de vuelta en la sala', () => G.Social.room && G.Social.room.members.length === 2 && G.Game.state === 'ui');
    await A.eval(() => { G.LobbyUI.setGame('td', 'valle'); G.Social.setPublic(true, 'td', 'valle'); });
    await waitPage(A, 'la sala es pública', () => G.Social.room.pub === true);
    const list = await C.call(() => G.Social.listRooms());
    const row = list.find((r: any) => r.host === uidA);
    expect(row).toMatchObject({ hostName: nameA, mode: 'td', map: 'valle', n: 2, started: false });
    roomId = row.id;
    // Aún no han empezado: mirar no se puede (se podría entrar).
    expect(await C.call(id => G.Spectate.start(id), roomId)).toBe(false);
    await waitPage(A, 'A puede empezar', () => !(document.getElementById('lobby-start') as HTMLButtonElement).disabled);
    await click(A, '#lobby-start');
    for (const d of [A, B]) await waitPage(d, 'en la Defensa', () => G.Run.mode && G.Run.mode.id === 'td' && G.Game.state === 'playing');
    expect((await C.call(() => G.Social.listRooms())).find((r: any) => r.id === roomId).started).toBe(true);
    const before = await cAccount();
    expect(await C.call(id => G.Spectate.start(id), roomId)).toBe(true);
    await waitPage(C, 'C mira la Defensa', () => G.Coop.watching && G.Run.mode.id === 'td' && G.Game.state === 'playing');
    await waitPage(A, 'el anfitrión tiene un espectador (que no es jugador)', () => G.Coop.watchers.length === 1 && G.Coop.players().length === 2);
    expect(await C.eval(() => [G.Coop.puppets().length, G.Coop.players().length, !!document.getElementById('spec-bar')])).toEqual([2, 2, true]);
    // A planta y lanza la oleada: C ve las torres y los enemigos.
    await plantOn(A, 1);
    await A.eval(() => G.TD.debugCallWave());
    await waitPage(C, 'C ve las torres', () => G.TD.net.towers.length >= 1);
    await waitPage(C, 'C ve copias de los enemigos', () => G.EnemyMgr.all().some((e: any) => e.remote));
    // C no tiene tienda ni monedas, y no puede comprar: nada llega al anfitrión.
    expect(await C.eval(() => [(window as any).getComputedStyle(document.getElementById('td-shop')).display, (window as any).getComputedStyle(document.querySelector('#td-hud .td-money')).display])).toEqual(['none', 'none']);
    const n0 = await A.eval(() => G.TD.net.towers.length);
    await C.eval(() => { G.Coop.toHost(['tp', 4, 0, 0, 0, 0]); G.Coop.toHost(['tw']); });
    await rig.run(8);
    expect(await A.eval(() => G.TD.net.towers.length)).toBe(n0);
    // Cambiar a quién mira.
    const t0 = await C.eval(() => G.Spectate.target().uid);
    await C.eval(() => G.Spectate.next(1));
    expect(await C.eval(() => G.Spectate.target().uid)).not.toBe(t0);
    // C sale: vuelve a la lista y el anfitrión deja de tenerlo.
    await C.eval(() => G.Game.quit());
    await waitPage(C, 'C de vuelta a la lista', () => G.Game.state === 'ui' && G.UI.isOpen('scr-rooms') && !G.Coop.active);
    await waitPage(A, 'el anfitrión ya no tiene espectador', () => G.Coop.watchers.length === 0);
    expect(await cAccount()).toEqual(before);                          // mirar no da nada
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
    expect(await C.allErrors()).toEqual([]);
  });

  test('el espectador que vuelve a mirar ve la partida de ahora; al acabar, vuelve a la lista sin premio', async () => {
    const before = await cAccount();
    expect(await C.call(id => G.Spectate.start(id), roomId)).toBe(true);
    await waitPage(C, 'C mira otra vez', () => G.Coop.watching && G.Game.state === 'playing');
    const want = JSON.stringify(await A.eval(() => G.TD.net.towers.map((t: any) => [t.id, t.dex])));
    await waitPage(C, 'C tiene las torres de ahora', w => JSON.stringify(G.TD.net.towers.map((t: any) => [t.id, t.dex])) === w, want);
    await A.eval(() => G.Game.quit());
    await waitPage(B, 'la partida acaba para B', () => G.Game.state === 'over' && !G.Coop.active);
    await waitPage(C, 'y C vuelve a la lista', () => G.Game.state === 'ui' && !G.Coop.active && !G.Social.watching);
    expect(await cAccount()).toEqual(before);
    expect(await C.allErrors()).toEqual([]);
  });

  test('Survivor: también se mira, y las cartas de nivel no esperan al espectador', async () => {
    await click(A, '#btn-again');
    await click(B, '#btn-again');
    await waitPage(A, 'A de vuelta en la sala', () => G.Social.room && G.Social.room.members.length === 2 && G.Game.state === 'ui');
    await A.eval(() => G.LobbyUI.setGame('hordas'));
    await waitPage(A, 'la lista dice Survivor', () => G.Social.room.mode === 'survivor');
    await waitPage(A, 'A puede empezar', () => !(document.getElementById('lobby-start') as HTMLButtonElement).disabled);
    await click(A, '#lobby-start');
    for (const d of [A, B]) await waitPage(d, 'en el Survivor', () => G.Run.mode && G.Run.mode.id === 'survivor' && G.Game.state === 'playing' && G.Coop.active);
    const before = await cAccount();
    expect(await C.call(id => G.Spectate.start(id), roomId)).toBe(true);
    await waitPage(C, 'C mira el Survivor', () => G.Coop.watching && G.Run.mode.id === 'survivor' && G.Game.state === 'playing');
    await waitPage(A, 'el anfitrión lo tiene como espectador', () => G.Coop.watchers.length === 1 && G.Coop.players().length === 2);
    for (const d of [A, B]) await d.eval(() => { const p = G.Game.player; p.maxHp = p.hp = 1e7; });
    await A.eval(() => {
      const def = G.Enemies.bagAt(60)[0], pl = G.Game.player;
      for (let i = 0; i < 6; i++) G.EnemyMgr.add(new G.Enemy(def, pl.x + Math.cos(i) * 220, pl.y + Math.sin(i) * 220, G.Enemies.scale(60)));
    });
    await waitPage(C, 'C ve copias de los enemigos', () => G.EnemyMgr.all().some((e: any) => e.remote));
    // Cartas de nivel: esperan a A y a B, no a C (que ni las ve).
    await A.eval(() => G.Game.debugLevelUp());
    await waitPage(A, 'cartas en A', () => G.Game.state === 'levelup');
    await waitPage(B, 'cartas en B', () => G.Game.state === 'levelup');
    expect(await C.eval(() => G.Game.state)).toBe('playing');
    await click(A, '#cards .card');
    await click(B, '#cards .card');
    await waitPage(A, 'sigue la partida', () => G.Game.state === 'playing');
    // El anfitrión termina: C vuelve a la lista, sin premio.
    await A.eval(() => G.Game.quit());
    await waitPage(B, 'acaba para B', () => G.Game.state === 'over' && !G.Coop.active);
    await waitPage(C, 'y C vuelve a la lista', () => G.Game.state === 'ui' && !G.Coop.active && !G.Social.watching);
    expect(await cAccount()).toEqual(before);
    await A.eval(() => G.Social.setPublic(false, 'survivor', 'random'));
    expect(await A.allErrors()).toEqual([]);
    expect(await B.allErrors()).toEqual([]);
    expect(await C.allErrors()).toEqual([]);
  });

  test('segunda partida: el anfitrión desaparece y no vuelve', async () => {
    await click(A, '#btn-again');
    await click(B, '#btn-again');
    await waitPage(A, 'tras el resumen, vuelven a la sala', () => G.Social.room && G.Social.room.members.length === 2 && G.Game.state === 'ui');
    await waitPage(A, 'A puede empezar otra', () => !(document.getElementById('lobby-start') as HTMLButtonElement).disabled);
    await click(A, '#lobby-start');
    await waitPage(A, 'otra partida (A)', () => G.Game.state === 'playing' && G.Coop.active);
    await waitPage(B, 'otra partida (B)', () => G.Game.state === 'playing' && G.Coop.active);
    await rig.run(20);
    // A cierra la pestaña de golpe: su conexión se corta y no vuelve.
    rig.cut(A);
    rig.devs.splice(rig.devs.indexOf(A), 1);
    await A.ctx.close();
    await rig.run(5);
    expect(await B.eval(() => G.Coop.active)).toBe(true);                       // aún tiene su plazo
    await rig.until('al acabarse el plazo de la sala, la partida acaba para B', () => B.eval(() => G.Game.state === 'over' && !G.Coop.active), 5, 4, 46_000);
    await waitPage(B, 'y la sala se cierra', () => !G.Social.room);
    expect(await B.allErrors()).toEqual([]);
  });

  test('cerrar sesión: lo social se apaga', async () => {
    await click(B, '#btn-again');
    await B.eval(() => G.DB.logout());
    await rig.run(5);
    expect(await B.eval(() => [G.Social.started, G.Social.friends.length, G.Net.open_])).toEqual([false, 0, false]);
    expect(await B.allErrors()).toEqual([]);
  });
});
