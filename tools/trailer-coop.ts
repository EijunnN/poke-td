/* ============ trailer-coop.ts — los planos en grupo del tráiler (sala, chat, señales, tienda, Arena) ============
 * Cuatro jugadores de verdad contra el servidor de verdad, todo en este proceso y con el
 * reloj en la mano (como tests/coop.fast.test.ts, de donde sale el montaje de Rig y Dev):
 * cuentas, amistad, sala, Defensa en grupo. Se graba lo que ve el anfitrión, CON la
 * interfaz (la tienda, el chat, el minimapa), 30 imágenes por segundo de juego.
 *
 *   bun tools/trailer-coop.ts <carpeta>              todo
 *   bun tools/trailer-coop.ts <carpeta> --arena      sólo la Arena (cada uno su laberinto, envíos al rival; gana el último en pie)
 *   bun tools/trailer-coop.ts <carpeta> --no-arena   todo menos la Arena
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer as tcp } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import type { WsData } from '../server/realtime';
import { sha256 } from '../server/http';
import { FakeClock, installFakeNet, installHarness, type NetIn, type NetOut } from '../tests/fakes';
import { startServer } from '../tests/helpers';

declare const G: any;
declare const window: any;
declare const document: any;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || join(ROOT, 'trailer-out');
const T0 = Date.now(), START = 1_000_000, FRAME = 1000 / 60;

type Srv = ReturnType<typeof startServer>;
interface Sim { dev: Dev; c: number; ws: any; closed: boolean; rt: Srv['rt'] }

class Rig {
  readonly clock = new FakeClock(T0 + START);
  readonly dbPath = join(mkdtempSync(join(tmpdir(), 'poke-td-trailer-')), 'test.sqlite');
  srv: Srv | null = null;
  readonly devs: Dev[] = [];
  private closing: Sim[] = [];
  private closeCode = new Map<Sim, number>();
  /** Antes de cada paso, en cada página (los bots). */
  before: ((d: Dev) => Promise<unknown>) | null = null;
  constructor() { this.clock.after = () => this.settle(); }
  up() { this.srv = startServer({ port: 0, dbPath: this.dbPath, loginLimit: 10_000, realtime: { clock: this.clock.clock } }); }
  settle() {
    while (this.closing.length) { const sim = this.closing.shift()!; sim.rt.websocket.close!(sim.ws, this.closeCode.get(sim) ?? 1000, ''); }
  }
  private connect(dev: Dev, c: number, url: string) {
    const srv = this.srv;
    const token = new URL(url, 'http://x').searchParams.get('token');
    const user = (() => {
      if (!srv || !token || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
      const s = srv.db.session(sha256(token));
      return s ? srv.db.userById(s.user_id) : null;
    })();
    if (!srv || !user) { dev.inbox.push({ c, ev: 'c', code: 1006 }); return; }
    const sim: Sim = { dev, c, ws: null, closed: false, rt: srv.rt };
    sim.ws = {
      data: { user } as WsData,
      send: (s: string) => { if (!sim.closed) dev.inbox.push({ c, ev: 'm', d: s }); return s.length; },
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
  private take(dev: Dev, out: NetOut[]) {
    for (const o of out) {
      if (o.t === 'new') { this.connect(dev, o.c, o.url!); continue; }
      const sim = dev.socks.get(o.c);
      if (!sim || sim.closed) continue;
      if (o.t === 'send') sim.rt.websocket.message!(sim.ws, o.d!);
      else {
        sim.closed = true;
        dev.socks.delete(o.c);
        dev.inbox.push({ c: o.c, ev: 'c', code: o.code ?? 1000 });
        sim.rt.websocket.close!(sim.ws, o.code ?? 1000, '');
      }
      this.settle();
    }
  }
  async serve(route: Route) {
    const req = route.request(), srv = this.srv;
    if (!srv) { await route.abort('connectionrefused'); return; }
    const u = new URL(req.url());
    const body = req.postDataBuffer();
    const res = await srv.server.fetch(new Request(`http://127.0.0.1:${srv.server.port}${u.pathname}${u.search}`, {
      method: req.method(), headers: req.headers(),
      body: body && req.method() !== 'GET' && req.method() !== 'HEAD' ? body : undefined,
    }));
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    this.settle();
  }
  async round(frames = 4) {
    for (const d of this.devs) {
      if (this.before) await this.before(d);
      const inb = d.inbox.splice(0);
      const out = await d.page.evaluate(([e, f]) => window.__net.step(e, f, 0), [inb, frames] as [NetIn[], number]);
      this.take(d, out);
    }
    this.clock.advance(frames * FRAME);
    this.settle();
  }
  async until(what: string, cond: () => Promise<unknown> | unknown, max = 600, frames = 4) {
    for (let i = 0; i < max; i++) { if (await cond()) return; await this.round(frames); }
    if (await cond()) return;
    throw new Error('no se cumple: ' + what);
  }
  async run(n: number, frames = 4) { for (let i = 0; i < n; i++) await this.round(frames); }
}

class Dev {
  readonly inbox: NetIn[] = [];
  readonly socks = new Map<number, Sim>();
  page!: Page;
  ctx!: BrowserContext;
  private calls = 0;
  constructor(readonly rig: Rig, readonly label: string) {}
  async open(browser: Browser, url: string, scale = 1) {
    this.ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: scale, serviceWorkers: 'block' });
    this.page = await this.ctx.newPage();
    this.page.on('pageerror', e => console.error(`${this.label}: ${e.message}`));
    await this.page.route('**/api/**', route => this.rig.serve(route));
    await this.page.addInitScript(`window.__T0 = ${T0};`);
    await this.page.addInitScript(installHarness);
    await this.page.addInitScript(installFakeNet);
    await this.page.goto(url, { waitUntil: 'load' });
    await this.page.waitForFunction(() => typeof G === 'object' && G.Game && G.Flow && window.__h.ready(), null, { timeout: 240_000 });
    await this.page.waitForLoadState('networkidle');
    await this.page.evaluate(() => window.__h.freeze());
  }
  eval<A, R>(fn: (a: A) => R | Promise<R>, arg?: A): Promise<R> { return this.page.evaluate(fn as any, arg as any) as Promise<R>; }
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
}

const freePort = () => new Promise<number>(r => { const t = tcp(); t.listen(0, '127.0.0.1', () => { const p = (t.address() as any).port; t.close(() => r(p)); }); });

/** Cuenta nueva con su compañero y una colección para la tienda. */
async function newPlayer(d: Dev, name: string, dex: number, team: number[]) {
  const reg = await d.eval(([n, p]) => G.DB.register(n, p), [name, 'pikachu123']);
  if (!reg.ok) throw new Error('no se pudo crear la cuenta: ' + reg.error);
  await d.eval(([x, t]) => { G.DB.save.partner = x; for (const k of [x, ...t]) G.DB.grant(k, 'starter'); G.DB.commit(true); }, [dex, team] as [number, number[]]);
}

/** En la página: un bot que planta torres de su colección junto al camino (cada uno por su zona) y las mejora. */
function botTick([zone, total]: [number, number]) {
  const w = window as any;
  const td = G.TD;
  if (!td || !G.Game || G.Game.state !== 'playing' || !td.route) return;
  w.__bf = (w.__bf || 0) + 1;
  const pl = G.Game.player; if (pl) pl.hp = pl.maxHp;              // los héroes aguantan (sin tocar la barra)
  // Los jefes, sin el destello blanco de cada golpe (les dan tantos que se quedaban en blanco).
  for (const e of G.EnemyMgr.all()) if ((e.chief || e.tdKind) && !e.__noFlash) { e.__noFlash = true; Object.defineProperty(e, 'flash', { get: () => 0, set() {} }); }
  if (w.__noPanel && td.info.selected != null) td.debugSelect(-1);  // sin el panel de la torre tapando el plano
  if (w.__bf % 24 || w.__hold) return;
  const info = td.info;
  if (!w.__spots) {
    // En la Arena, los caminos de su carril (y todos para él); en grupo, su tramo de cada uno.
    const net = td.net, lane = net.arena ? net.lanes.find((l: any) => l.uid === net.me) : null;
    // (De quién es cada camino: el carril más cerca de su base.)
    const near = (rt: any[]) => { const b = rt[rt.length - 1]; let best: any = null, bd = Infinity; for (const l of net.lanes) { const d = Math.hypot(b.x - l.cx, b.y - l.cy); if (d < bd) { bd = d; best = l; } } return best; };
    const routes = (td.routes as any[]).filter(rt => !lane || near(rt).uid === lane.uid);
    if (lane) { zone = 0; total = 1; }
    const out: { x: number; y: number }[] = [];
    const seg = (x: number, y: number, a: any, b: any) => {
      const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l)) : 0;
      return Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
    };
    // Cada jugador, su tramo del camino.
    for (const r of routes) {
      const n = r.length - 1, from = Math.floor(zone * n / total), to = Math.floor((zone + 1) * n / total);
      for (let i = Math.max(1, from); i <= to; i++) {
        for (const [dx, dy] of [[1, 1], [-1, -1], [1, -1], [-1, 1], [0, 1], [1, 0], [0, -1], [-1, 0]]) {
          const p = { x: r[i].x + dx * 64, y: r[i].y + dy * 64 };
          let dm = Infinity;
          for (const q of routes) for (let k = 1; k < q.length; k++) dm = Math.min(dm, seg(p.x, p.y, q[k - 1], q[k]));
          if (dm > 36) out.push(p);
        }
      }
    }
    // En la Arena, primero lo de cerca del centro de su carril (lo que sale en el plano).
    if (lane) out.sort((p, q) => Math.hypot(p.x - lane.cx, p.y - lane.cy) - Math.hypot(q.x - lane.cx, q.y - lane.cy));
    w.__spots = out; w.__buy = 0;
  }
  if (info.evo) { td.debugEvolve(info.evo[0]); return; }
  const mine = td.net.towers.map((t: any, i: number) => ({ t, i })).filter((x: any) => x.t.owner === td.net.me);
  const shop = td.shop.filter((c: any) => !c.trophy);
  const next = shop[w.__buy % Math.min(shop.length, 6)];
  if (mine.length < (td.net.arena ? 7 : 5) && next && info.money >= next.cost) {
    const s = w.__spots.find((p: any) => td.canPlace(p.x, p.y));
    if (s) { td.debugBuy(next.dex); td.debugPlace(s.x, s.y); w.__buy++; }
    return;
  }
  const low = mine.sort((a: any, b: any) => a.t.level - b.t.level)[0];
  if (low && info.money >= 80) td.debugUpgrade(low.i);
}

/** El laberinto de un experto (td-maze.ts: 11×26 casillas de 48): una fila de piezas cada dos, con el hueco a un lado
 *  y al otro, para que bajen en zigzag de pared a pared; casi todo torres (los muros, entre ellas). */
const MAZE_ROWS_PLAN = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21];
function mazePlan(l: { cx: number; cy: number }) {
  const out: { x: number; y: number; tower: boolean; k: number }[] = [];
  MAZE_ROWS_PLAN.forEach((r, k) => {
    const gap = k % 2 ? 0 : 10;
    for (let c = 0; c < 11; c++) if (c !== gap) out.push({ x: l.cx + (c + 0.5) * 48 - 264, y: l.cy + (r + 0.5) * 48 - 624, tower: c % 2 === 0, k: out.length });
  });
  return out;
}

/** En la página, en la Arena: levanta su laberinto (window.__plan) con muros y torres, luego mejora; con __war, envía monstruos. */
function arenaBot(doomed: string[]) {
  const w = window as any, td = G.TD;
  if (!td || !G.Game || G.Game.state !== 'playing' || !td.net || !td.net.arena) return;
  w.__bf = (w.__bf || 0) + 1;
  const pl = G.Game.player; if (pl) pl.hp = pl.maxHp;
  for (const e of G.EnemyMgr.all()) if ((e.chief || e.tdKind) && !e.__noFlash) { e.__noFlash = true; Object.defineProperty(e, 'flash', { get: () => 0, set() {} }); }
  if (w.__noPanel && td.info.selected != null) td.debugSelect(-1);
  const net = td.net;
  // (Es un vídeo: nadie cae sin querer; el anfitrión les devuelve las vidas, salvo a los que el vídeo hace caer.)
  for (const l of net.lanes) if (!l.out && l.lives < 8 && !doomed.includes(l.uid)) td.debugLaneLives(l.uid, 20);
  const me = net.lanes.find((l: any) => l.uid === net.me);
  if (!me || me.out) return;
  if (w.__war && w.__bf % 14 === 0 && td.info.money >= 120) {
    const rivals = net.lanes.filter((l: any) => !l.out && l.uid !== net.me);
    if (rivals.length) td.debugSend([0, 0, 1, 3][Math.floor(Math.random() * 4)], rivals[Math.floor(Math.random() * rivals.length)].uid);
  }
  if (w.__bf % 4 || w.__hold || !w.__plan) return;
  const info = td.info;
  if (info.evo) { td.debugEvolve(info.evo[0]); return; }
  const shop = td.shop.filter((c: any) => !c.trophy && c.dex !== 185);
  for (const p of w.__plan) {
    if (p.done) continue;
    if (net.towers.some((t: any) => Math.abs(t.x - p.x) < 12 && Math.abs(t.y - p.y) < 12)) { p.done = true; continue; }
    const card = p.tower ? shop[p.k % Math.min(5, shop.length)] : td.shop.find((c: any) => c.dex === 185);
    if (!card || info.money < card.cost) return;
    if (!td.canPlace(p.x, p.y)) continue;                 // (un monstruo encima: luego)
    td.debugBuy(card.dex); td.debugPlace(p.x, p.y); if (td.placing) td.debugCancel();
    return;
  }
  const mine = net.towers.map((t: any, i: number) => ({ t, i })).filter((x: any) => x.t.owner === net.me && x.t.dex !== 185);
  const low = mine.sort((a: any, b: any) => a.t.level - b.t.level)[0];
  if (low && info.money >= 120) td.debugUpgrade(low.i);
  // (Un experto no ahorra: dos mejoras por vuelta si le llega.)
  const low2 = mine.sort((a: any, b: any) => a.t.level - b.t.level)[0];
  if (low2 && info.money >= 400) td.debugUpgrade(low2.i);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { createServer } = await import('vite');
  const vite = await createServer({ root: ROOT, mode: 'test', logLevel: 'error', server: { port: await freePort(), strictPort: true, host: '127.0.0.1', hmr: false, watch: null } });
  await vite.listen();
  const url = vite.resolvedUrls!.local[0];
  const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ channel: 'msedge', headless: true }));
  const rig = new Rig();
  rig.up();
  const A = new Dev(rig, 'A'), B = new Dev(rig, 'B'), C = new Dev(rig, 'C'), D = new Dev(rig, 'D');
  rig.devs.push(A, B, C, D);
  // (B y D también en alta: B gana el duelo final y D cae y mira a los demás, y se graba lo que ven.)
  await Promise.all([A.open(browser, url, 1.5), B.open(browser, url, 1.5), C.open(browser, url), D.open(browser, url, 1.5)]);
  const all = [A, B, C, D];
  const ARENA_ONLY = process.argv.includes('--arena');

  let shot = 0;
  /** Graba `sec` segundos de lo que ve A (o `who`) en <OUT>/<name>/. */
  async function rec(name: string, sec: number, during?: (i: number) => Promise<unknown>, who: Dev = A) {
    const dir = join(OUT, name); mkdirSync(dir, { recursive: true });
    const n = Math.round(sec * 30);
    for (let i = 0; i < n; i++) {
      if (during) await during(i);
      await rig.round(2);
      await who.page.screenshot({ path: join(dir, String(i).padStart(5, '0') + '.png') });
    }
    console.log('plano', name, n, 'imágenes');
    shot++;
  }

  // ---- cuentas, amigos y sala ----
  const names = ['Eijun', 'Lucia', 'Leo', 'Mia'];
  await newPlayer(A, names[0], 25, [7, 1, 92, 147, 63, 81, 220, 123]);
  await newPlayer(B, names[1], 133, [4, 74, 66, 175, 52, 37]);
  await newPlayer(C, names[2], 4, [1, 7, 25, 92, 147, 129]);
  await newPlayer(D, names[3], 7, [152, 155, 158, 133, 175, 63]);
  for (const d of all) if (await d.eval(() => G.Social.start()) !== 'ok') throw new Error('sin social');
  for (const d of all) await rig.until('conectado', () => d.eval(() => G.Net.up));
  const uid = await Promise.all(all.map(d => d.eval(() => G.Social.uid)));
  for (const k of [1, 2, 3]) {
    await A.eval(n => G.Social.request(n), names[k]);
    await rig.until('solicitud', () => all[k].eval(u => G.Social.friends.some((f: any) => f.uid === u && f.status === 'in'), uid[0]));
    await all[k].eval(u => G.Social.accept(u), uid[0]);
  }
  for (const k of [1, 2, 3]) {
    await rig.until('amigos en línea', () => A.eval(u => G.Social.friends.some((f: any) => f.uid === u && f.status === 'ok' && f.online), uid[k]));
    await A.call(u => G.Social.invite(u), uid[k]);
    await rig.until('invitación', () => all[k].eval(u => G.Social.invites.some((i: any) => i.from === u), uid[0]));
    await all[k].call(u => G.Social.acceptInvite(u), uid[0]);
  }
  await rig.until('sala de cuatro', () => A.eval(() => G.Social.room && G.Social.room.members.length === 4));
  for (const d of all) await d.eval(() => { G.LobbyUI.open(); const t = document.getElementById('tap-start'); if (t) t.style.display = 'none'; });
  await A.eval(() => G.LobbyUI.setGame('td', 'valle'));
  await rig.until('se puede empezar', () => A.eval(() => !document.getElementById('lobby-start').disabled));
  await rig.run(30);
  if (ARENA_ONLY) { await arena(); await browser.close(); await vite.close(); rig.srv?.stop(); process.exit(0); }

  // 1 · La sala: los tres, la Defensa elegida, y el chat.
  await rec('lobby', 3.2, async i => {
    if (i === 10) await B.eval(() => { G.Chat.quick('hi'); });
    if (i === 35) await C.eval(() => { G.Chat.send('¿Vamos a por Mewtwo? 😎'); });
    if (i === 62) await A.eval(() => { G.Chat.quick('ready'); });
  });

  // ---- a jugar ----
  await A.eval(() => document.getElementById('lobby-start').click());
  for (const d of all) await rig.until('en la Defensa', () => d.eval(() => G.Run.mode && G.Run.mode.id === 'td' && G.Coop.active && G.Game.state === 'playing'));
  for (const d of all) await d.eval(() => {
    const t = document.getElementById('tap-start'); if (t) t.style.display = 'none';
    G.Game.player.atkMul = 0.05;
  });
  // Los héroes, repartidos por el mapa (cada uno por su tramo).
  const route = await A.eval(() => G.TD.route) as { x: number; y: number }[];
  rig.before = async d => d.eval(botTick, [all.indexOf(d), all.length] as [number, number]);
  await rig.run(60, 2);
  await A.eval(() => G.TD.debugCallWave());
  await rig.until('oleada en marcha', () => A.eval(() => G.TD.info.wave >= 1 && G.EnemyMgr.all().length > 3));
  await rig.until('oleada 2', () => A.eval(() => G.TD.info.wave >= 2 && G.TD.info.phase === 'wave' && G.EnemyMgr.all().length > 4), 3000);

  // 2 · Partida en grupo, de lejos: los tres héroes con su nombre, las torres de cada uno, el chat y una señal.
  // El plano, donde más torres hay; los tres héroes, dentro.
  const mid = await A.eval(() => {
    const ts = G.TD.info.towers; let best = ts[0], bn = -1;
    for (const t of ts) { const n = ts.filter((u: any) => Math.hypot(u.x - t.x, u.y - t.y) < 330).length; if (n > bn) { bn = n; best = t; } }
    return { x: best.x, y: best.y };
  });
  const heroAt = [[mid.x - 230, mid.y + 120], [mid.x + 40, mid.y - 130], [mid.x + 260, mid.y + 90], [mid.x - 60, mid.y + 230]];
  for (const [k, d] of all.entries()) await d.eval(([x, y]) => { const pl = G.Game.player; pl.x = x; pl.y = y; }, heroAt[k]);
  await A.eval(([x, y]) => {
    G.TD.debugCam(x, y);
    G.Camera.VIEW_W = 900; G.Camera.MIN_VIEW_H = 490; G.Camera.resize(1280, 720, G.Camera.dpr);
    (window as any).__noPanel = true;
    const h = [...document.querySelectorAll('#td-shop button')].find((b: any) => /Ocultar/.test(b.textContent)) as any; if (h) h.click();
  }, [mid.x, mid.y]);
  await rig.run(20, 2);
  await rec('coop', 5, async i => {
    if (i === 15) await B.eval(() => { G.Chat.send('Yo cubro esta curva 💪'); });
    if (i === 45) await C.eval(([x, y]) => { G.Pings.send(x + 150, y + 30); }, [mid.x, mid.y]);
    if (i === 55) await C.eval(() => { G.Chat.quick('watch'); });
    if (i === 100) await A.eval(() => { G.Chat.quick('omw'); });
  });

  // 3 · La tienda de A: toda su colección; elige uno y lo planta con el ratón donde quiere.
  for (const d of [B, C, D]) await d.eval(() => { (window as any).__hold = true; });   // (que nadie le quite el sitio)
  await A.eval(() => {
    (window as any).__hold = true;
    const h = [...document.querySelectorAll('#td-shop button')].find((b: any) => /Abrir/.test(b.textContent)) as any; if (h) h.click();
  });
  await rig.until('A ahorra', () => A.eval(() => G.TD.info.money >= 140), 3000);
  const spot = await A.eval(() => {
    const r = G.TD.route;
    for (let i = 2; i < r.length - 1; i++) for (const [dx, dy] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const x = r[i].x + dx * 70, y = r[i].y + dy * 70;
      if (G.TD.canPlace(x, y) && G.TD.info.towers.every((t: any) => Math.hypot(t.x - x, t.y - y) > 120)) return { x, y };
    }
    return null;
  });
  if (!spot) throw new Error('A no tiene sitio');
  await A.eval(([x, y]) => { G.Camera.VIEW_W = 768; G.Camera.MIN_VIEW_H = 420; G.Camera.resize(1280, 720, G.Camera.dpr); G.TD.debugCam(x, y); }, [spot.x, spot.y]);
  await rig.run(40, 2);
  const toScreen = (x: number, y: number) => A.eval(([x, y]) => {
    const cam = G.Camera, cv = document.getElementById('game').getBoundingClientRect();
    return { sx: cv.left + (x - cam.left()) * cam.scale, sy: cv.top + (y - cam.top()) * cam.scale };
  }, [x, y]);
  const item = await A.eval(() => {
    const b = [...document.querySelectorAll('#td-list button, #td-shop .td-list > *')].find((e: any) => e.textContent.includes('Dratini')) as any;
    if (!b) return null;
    const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const target = await toScreen(spot.x, spot.y);
  let mouse = { x: 640, y: 420 };
  await A.page.mouse.move(mouse.x, mouse.y);
  await rec('shop', 4, async i => {
    if (i === 12 && item) await A.page.mouse.move(item.x, item.y, { steps: 1 });
    if (i === 20 && item) await A.page.mouse.click(item.x, item.y);
    if (i > 24 && i <= 60) {                                     // lleva el Pokémon hasta su sitio
      const k = (i - 24) / 36, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const from = item || mouse;
      mouse = { x: from.x + (target.sx - from.x) * e, y: from.y + (target.sy - from.y) * e };
      await A.page.mouse.move(mouse.x, mouse.y);
    }
    if (i === 70) await A.page.mouse.click(target.sx, target.sy);
    if (i === 78) await A.page.mouse.move(target.sx + 400, target.sy - 300);
  });
  for (const d of all) await d.eval(() => { (window as any).__hold = false; });
  if (process.argv.includes('--no-arena')) { await browser.close(); await vite.close(); rig.srv?.stop(); process.exit(0); }

  // De vuelta a la sala (el anfitrión termina la partida) y, a la Arena.
  rig.before = null;
  await A.eval(() => G.Game.quit());
  for (const d of all) await rig.until('resumen', () => d.eval(() => G.Game.state === 'over'));
  for (const d of all) await d.eval(() => document.getElementById('btn-again').click());
  for (const d of all) await rig.until('en la sala', () => d.eval(() => G.Game.state === 'ui' && G.Social.room));
  await arena();

  /** La Arena (Line Tower Wars): cada uno su laberinto, envíos al carril de los rivales; gana el último en pie. */
  async function arena() {
    const cam = (d: Dev, x: number, y: number, w: number) => d.eval(([x, y, w]) => {
      G.Camera.VIEW_W = w; G.Camera.MIN_VIEW_H = w * 0.5625; G.Camera.resize(1280, 720, G.Camera.dpr); G.TD.debugCam(x, y);
    }, [x, y, w]);
    const rowY = (l: { cy: number }, r: number) => l.cy + (r + 0.5) * 48 - 624;
    const cell = (l: { cx: number; cy: number }, c: number, r: number) => ({ x: l.cx + (c + 0.5) * 48 - 264, y: rowY(l, r) });
    const ease = (k: number) => { k = Math.min(1, Math.max(0, k)); return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
    for (const d of all) await d.eval(() => { const w = window as any; w.__plan = null; w.__hold = false; w.__war = false; w.__noPanel = true; G.LobbyUI.open(); });
    await A.eval(() => G.LobbyUI.setGame('td', 'valle', true));
    await rig.until('todos ven la Arena', async () => (await Promise.all(all.map(d => d.eval(() => G.LobbyUI.game.arena === true)))).every(Boolean));
    await rig.until('se puede empezar', () => A.eval(() => !document.getElementById('lobby-start').disabled));
    await rig.run(20);
    // · La sala: Defensa → Arena, cuatro jugadores, y el pique en el chat.
    await rec('arena-lobby', 4.4, async i => {
      if (i === 8) await C.eval(() => { G.Chat.send('El último en pie gana 👑'); });
      if (i === 45) await D.eval(() => { G.Chat.send('Mi laberinto es imposible 😈'); });
      if (i === 90) await B.eval(() => { G.Chat.quick('gg'); });
    });
    await A.eval(() => document.getElementById('lobby-start').click());
    for (const d of all) await rig.until('en la Arena', () => d.eval(() => G.Game.state === 'playing' && G.TD.net.arena));
    for (const d of all) await d.eval(() => {
      const t = document.getElementById('tap-start'); if (t) t.style.display = 'none';
      G.Game.player.atkMul = 0.05;
    });
    for (const d of [B, C, D]) await d.eval(() => { const h = [...document.querySelectorAll('#td-shop button')].find((b: any) => /Ocultar/.test(b.textContent)) as any; if (h) h.click(); });
    const lanes = await A.eval(() => G.TD.net.lanes) as { uid: string; cx: number; cy: number }[];
    const L = lanes[0];
    const plans = lanes.map(mazePlan);
    for (const [k, d] of all.entries()) await d.eval(p => { (window as any).__plan = p; }, plans[k]);
    await A.eval(() => { (window as any).__hold = true; });
    for (const l of lanes) await A.eval(u => G.TD.debugMoney(u, 25000), l.uid);
    // (Monstruos duros: con torres de experto, si no, no llegan a recorrer el zigzag.)
    await A.eval(() => G.TD.debugHpMul(150, true));
    const doomed: string[] = [];
    rig.before = async d => d.eval(arenaBot, doomed);
    // (Los demás levantan su laberinto mientras tanto, fuera de plano.)
    await rig.run(40, 2);
    await A.eval(() => G.TD.debugCallWave());
    await cam(A, L.cx, rowY(L, 7), 1150);
    await rig.until('monstruos en el carril de A', () => A.eval(l => G.EnemyMgr.all().filter((e: any) => !e.dead && Math.abs(e.x - l.cx) < 300).length >= 3, L), 600, 2);
    await rig.run(15, 2);

    // 1 · Sin camino: el carril vacío, bajan rectos.
    await rec('maze-empty', 4.4);

    // 2 · Tú haces el laberinto: muros y torres, uno tras otro; la ruta se rehace y los que bajan la siguen.
    const sendTo = (d: Dev, k: number, to: string) => d.eval(([k, to]) => G.TD.debugSend(k, to), [k, to] as [number, string]);
    await sendTo(B, 0, L.uid); await sendTo(C, 1, L.uid); await sendTo(D, 0, L.uid);
    await rig.run(30, 2);
    let k = 0;
    const put = (p: { x: number; y: number; tower: boolean; k: number }, dex?: number) => A.eval(([p, dex]) => {
      const shop = G.TD.shop.filter((c: any) => !c.trophy && c.dex !== 185);
      G.TD.debugBuy(dex || (p.tower ? shop[p.k % Math.min(5, shop.length)].dex : 185)); G.TD.debugPlace(p.x, p.y); if (G.TD.placing) G.TD.debugCancel();
    }, [p, dex || 0] as [typeof p, number]);
    await rec('maze-build', 6.2, async i => { if (i >= 12 && i % 3 === 0 && k < 40) await put(plans[0][k++]); });
    while (k < 40) await put(plans[0][k++]);

    // 3 · Nunca lo cierres: la vista previa de la ruta al colocar; tapar el último hueco, no se puede.
    for (let c = 0; c < 8; c++) await put(plans[0][40 + c]);
    await sendTo(B, 0, L.uid); await sendTo(C, 0, L.uid);
    await cam(A, L.cx, rowY(L, 12), 1150);
    await rig.run(20, 2);
    const at = (c: number, r: number) => cell(L, c, r);
    const ghost = (q: { x: number; y: number }) => A.eval(q => { if (!G.TD.placing) G.TD.debugBuy(185); G.TD.debugGhost(q.x, q.y); }, q);
    const glide = async (i: number, i0: number, i1: number, a: { x: number; y: number }, b: { x: number; y: number }) => {
      if (i < i0 || i > i1) return false;
      const e = ease((i - i0) / (i1 - i0));
      await ghost({ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e });
      return true;
    };
    await rec('maze-preview', 7, async i => {
      if (i === 0) await ghost(at(5, 14));
      if (await glide(i, 12, 42, at(5, 14), at(8, 11))) return;
      if (i === 52) { await A.eval(q => G.TD.debugPlace(q.x, q.y), at(8, 11)); await ghost(at(9, 11)); }
      if (i === 72) { await A.eval(q => G.TD.debugPlace(q.x, q.y), at(9, 11)); await ghost(at(10, 11)); }
      if (await glide(i, 132, 160, at(10, 11), at(4, 13))) return;
      if (i === 172) await A.eval(q => G.TD.debugPlace(q.x, q.y), at(4, 13));
      if (i > 180 && i % 3 === 0) { const p = plans[0].find((p, n) => n >= 50 && n < 60 && !(p.x === at(4, 13).x && p.y === at(4, 13).y) && !(p as any).used); if (p) { (p as any).used = true; await put(p); } }
    });
    await A.eval(() => { G.TD.debugCancel(); (window as any).__hold = false; });

    // (A termina su laberinto: los que faltan, con torres; y le llegan más monstruos.)
    await rig.until('el laberinto de A', () => A.eval(u => G.TD.net.lanes.find((l: any) => l.uid === u).walls >= 95, L.uid), 1500, 2);
    // (Y lo mejora como un experto antes de enseñarlo.)
    await A.eval(u => G.TD.debugMoney(u, 25000), L.uid);
    await rig.run(200, 2);
    // (Los expertos se mandan monstruos sin parar: siempre hay alguno recorriendo el zigzag.)
    for (const l of lanes) await A.eval(u => G.TD.debugMoney(u, 25000), l.uid);
    for (const d of all) await d.eval(() => { (window as any).__war = true; });
    for (const d of [B, C, D]) { await sendTo(d, 0, L.uid); await sendTo(d, 1, L.uid); await sendTo(d, 3, L.uid); }
    await rig.run(150, 2);
    // (Desde aquí A ya no gasta solo: lo que envía, lo envía el vídeo.)
    await A.eval(() => { (window as any).__hold = true; });
    // Sin paneles, para los planos de lejos.
    const wide = (on: boolean) => A.eval(on => {
      let st = document.getElementById('trailer-wide');
      if (!st) { st = document.createElement('style'); st.id = 'trailer-wide'; document.head.appendChild(st); }
      st.textContent = on ? '#td-send,#td-shop,#td-map{display:none!important}' : '';
    }, on);

    // 4 · Cuanto más largo, mejor: de arriba abajo por el laberinto de A.
    await rec('maze-pan', 6, async i => { const e = ease(i / 179); await cam(A, L.cx, rowY(L, 4 + 17 * e), 1150); });

    // 5 · Cada uno, su laberinto: de A a los cuatro carriles.
    const mx = lanes.reduce((a, l) => a + l.cx, 0) / lanes.length, my = lanes.reduce((a, l) => a + l.cy, 0) / lanes.length;
    await cam(A, L.cx, L.cy, 1500);
    await wide(true);
    await rig.run(10, 2);
    await rec('arena-zoom', 7.4, async i => { const e = ease((i - 15) / 170); await cam(A, L.cx + (mx - L.cx) * e, L.cy + (my - L.cy) * e, 1500 + (5600 - 1500) * e); });

    // 6 · La siguiente oleada, la misma en todos los carriles (los dos del medio).
    const w0 = await A.eval(() => G.TD.info.wave) as number;
    await rig.until('la siguiente oleada', () => A.eval(w => G.TD.info.wave > w, w0), 3000, 2);
    await cam(A, (lanes[1].cx + lanes[2].cx) / 2, rowY(L, 9), 2900);
    await rig.run(30, 2);
    await rec('arena-wave', 4.6);
    await wide(false);

    // 7 · Envíos: A elige a Lucía y le manda un Snorlax, un Machoke y Rattatas (con el ratón, en su panel). B los recibe.
    await A.eval(u => G.TD.debugMoney(u, 2000), L.uid);
    await cam(A, L.cx, rowY(L, 11), 1150);
    await cam(B, lanes[1].cx, rowY(lanes[1], 5), 1000);
    await rig.run(10, 2);
    const box = (sel: string, text: string) => A.eval(([sel, text]) => {
      const b = [...document.querySelectorAll(sel)].find((e: any) => e.textContent.includes(text)) as any;
      if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, [sel, text]);
    const chip = await box('#td-send .td-send-to button', 'Lucia');
    const clicks = [await box('#td-send .td-slot', 'Snorlax'), await box('#td-send .td-slot', 'Machoke'), await box('#td-send .td-slot', 'Rattata')];
    let mouse = { x: 700, y: 400 };
    const moveTo = async (to: { x: number; y: number } | null, k: number) => { if (!to) return; const e = ease(k); await A.page.mouse.move(mouse.x + (to.x - mouse.x) * e, mouse.y + (to.y - mouse.y) * e); };
    await A.page.mouse.move(mouse.x, mouse.y);
    const sentB = (d: Dev) => A.eval(l => {
      const es = G.EnemyMgr.all().filter((e: any) => !e.dead && e.sent && Math.abs(e.x - l.cx) < 300);
      const big = es.find((e: any) => e.dex === 143) || es[0]; return big ? { x: big.x, y: big.y } : null;
    }, lanes[1]);
    {
      const da = join(OUT, 'arena-send'), db = join(OUT, 'arena-incoming');
      mkdirSync(da, { recursive: true }); mkdirSync(db, { recursive: true });
      const steps: [number, { x: number; y: number } | null][] = [[0, chip], [30, clicks[0]], [62, clicks[1]], [86, clicks[2]], [104, clicks[2]]];
      for (let i = 0; i < 270; i++) {
        for (let s2 = 0; s2 < steps.length - 1; s2++) {
          const [i0, to] = steps[s2], i1 = i0 + 16;
          if (i >= i0 && i <= i1) await moveTo(to, (i - i0) / 16);
          if (i === i1 && to) { await A.page.mouse.click(to.x, to.y); mouse = to; }
        }
        if (i >= 60) { const b = await sentB(B); if (b) await cam(B, b.x, Math.max(b.y, rowY(lanes[1], 5)), 1000); }
        await rig.round(2);
        if (i < 140) await A.page.screenshot({ path: join(da, String(i).padStart(5, '0') + '.png') });
        if (i >= 40) await B.page.screenshot({ path: join(db, String(i - 40).padStart(5, '0') + '.png') });
      }
      console.log('plano arena-send y arena-incoming');
    }
    await A.page.mouse.move(1270, 700);
    // 8 · El Snorlax, por el laberinto de Lucía.
    await rec('arena-snorlax', 4.6, async () => { const b = await sentB(B); if (b) await cam(B, b.x, b.y, 820); }, B);

    // 9 · Zubat vuela: no sigue el laberinto (A se los manda a Leo).
    await A.eval(u => G.TD.debugMoney(u, 1000), L.uid);
    await rig.run(2, 2);
    await sendTo(A, 2, lanes[2].uid); await sendTo(A, 2, lanes[2].uid);
    const zubat = () => A.eval(l => { const z = G.EnemyMgr.all().find((e: any) => !e.dead && e.dex === 41 && Math.abs(e.x - l.cx) < 300); return z ? { x: z.x, y: z.y } : null; }, lanes[2]);
    await rig.until('Zubat en el carril de Leo', async () => !!(await zubat()), 300, 2);
    await rec('arena-fly', 4, async () => { const z = await zubat(); if (z) await cam(A, lanes[2].cx, z.y + 120, 1150); });

    // 10 · Todos contra todos: se mandan monstruos unos a otros.
    for (const l of lanes) await A.eval(u => G.TD.debugMoney(u, 1500), l.uid);
    for (const d of all) await d.eval(() => { (window as any).__war = true; });
    await rig.run(150, 2);
    await cam(A, (lanes[1].cx + lanes[2].cx) / 2, rowY(L, 12), 2900);
    await wide(true);
    await rig.run(10, 2);
    await rec('arena-war', 4.6);
    await wide(false);
    for (const d of all) await d.eval(() => { (window as any).__war = false; });

    // 11 · En tu carril, con el panel: las vidas de los rivales bajan (a Mia se le escapan).
    doomed.push(lanes[3].uid);
    await cam(A, L.cx, rowY(L, 12), 1150);
    await rig.run(10, 2);
    await rec('arena-hud', 3.4, async i => {
      if (i === 15) await A.eval(u => G.TD.debugLaneLives(u, 11), lanes[3].uid);
      if (i === 45) await A.eval(u => G.TD.debugLaneLives(u, 4), lanes[3].uid);
      if (i === 70) await A.eval(u => G.TD.debugLaneLives(u, 1), lanes[3].uid);
    });

    // 12 · Mia cae: su laberinto desaparece y se avisa a todos.
    await cam(A, lanes[3].cx, lanes[3].cy, 2300);
    await rig.run(10, 2);
    await rec('arena-fall', 4, async i => { if (i === 24) await A.eval(u => G.TD.debugLaneLives(u, 0), lanes[3].uid); });

    // 13 · Lo que ve Mia, ya fuera: mira el carril de los demás y cambia con Q/E.
    await D.eval(() => { G.Camera.VIEW_W = 1300; G.Camera.MIN_VIEW_H = 730; G.Camera.resize(1280, 720, G.Camera.dpr); });
    await rig.run(10, 2);
    await rec('arena-spectate', 3.6, async i => { if (i === 40 || i === 75) await D.eval(() => G.TD.debugWatch(1)); }, D);

    // 14 · El duelo, en pantalla partida: Leo cae fuera de plano; Eijun contra Groudon y Lucía contra Kyogre, cada uno en su laberinto.
    doomed.push(lanes[2].uid);
    await A.eval(u => G.TD.debugLaneLives(u, 0), lanes[2].uid);
    await rig.run(20, 2);
    await A.eval(() => { G.TD.debugBossAt(383, 0, true); G.TD.debugBossAt(382, 1, true); });
    // (Dónde está el legendario de cada carril lo sabe el anfitrión: a los demás sólo les llega lo que tienen cerca.)
    const follow = async (d: Dev, k: number) => {
      const at = await A.eval(k => {
        const l = G.TD.net.lanes[k];
        const c = G.EnemyMgr.all().find((e: any) => !e.dead && e.chief && Math.abs(e.x - l.cx) < 400);
        return c ? { x: c.x, y: c.y + 40 } : { x: l.cx, y: l.cy };
      }, k);
      await cam(d, at.x, at.y, 820);
    };
    for (let i = 0; i < 40; i++) { await follow(A, 0); await follow(B, 1); await rig.round(2); }
    {
      const da = join(OUT, 'arena-duel-a'), db = join(OUT, 'arena-duel-b');
      mkdirSync(da, { recursive: true }); mkdirSync(db, { recursive: true });
      for (let i = 0; i < Math.round(6 * 30); i++) {
        await follow(A, 0); await follow(B, 1);
        await rig.round(2);
        await A.page.screenshot({ path: join(da, String(i).padStart(5, '0') + '.png') });
        await B.page.screenshot({ path: join(db, String(i).padStart(5, '0') + '.png') });
      }
      console.log('plano arena-duel (a y b)');
    }
    // (Para el ranking: las cuentas del vídeo ganan muy deprisa con el reloj falso y el guardado las marca.)
    rig.srv!.db.raw.run('DELETE FROM ranking_marked');

    // 15 · Lucía cae y Eijun gana: el podio. Y el ranking de la Arena.
    doomed.push(lanes[1].uid);
    await A.eval(u => G.TD.debugLaneLives(u, 0), lanes[1].uid);
    await rig.until('se acaba la Arena', () => A.eval(() => G.Game.state === 'over'), 400);
    rig.before = null;
    await rig.run(30, 2);
    await rec('arena-podium', 4.4);
    await rig.until('el podio llega al ranking', async () => { await rig.run(5); return rig.srv!.db.raw.query('SELECT COUNT(*) AS n FROM arena_places').get() as any; }, 40);
    await A.eval(() => { document.getElementById('btn-again').click(); G.RankingUI.open(); });
    await rig.run(20, 2);
    await A.eval(() => { const b = [...document.querySelectorAll('#scr-rank button, #scr-rank .tab, #scr-rank [data-k]')].find((x: any) => /Arena/.test(x.textContent)) as any; if (b) b.click(); });
    await rig.run(40, 2);
    await rec('arena-rank', 3);
  }

  await browser.close();
  await vite.close();
  rig.srv?.stop();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
