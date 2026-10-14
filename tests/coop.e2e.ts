/* ============ coop.e2e.ts — prueba de humo del cooperativo, con todo de verdad ============
 * Servidor Bun en otro proceso, Vite y DOS navegadores con red real: se hacen amigos, uno crea
 * la sala e invita, el otro acepta, el anfitrión empieza, el invitado ve los enemigos del
 * anfitrión y, al salir el anfitrión, la partida acaba para los dos. Sin errores en las páginas.
 *
 * Es sólo para comprobar el cableado real (WebSocket de verdad entre procesos). Todo lo demás del
 * cooperativo (reconexión, reinicio del servidor, premio de grietas, Sentencia...) está en
 * tests/coop.fast.test.ts, sin red y sin esperas.
 *
 *   node tests/coop.e2e.ts
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer as tcp } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const G: any;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = join(mkdtempSync(join(tmpdir(), 'poke-td-coop-')), 'test.sqlite');
const fails: string[] = [];
const check = (ok: unknown, what: string) => { if (!ok) fails.push(what); console.log((ok ? '  ok · ' : '  FALLA · ') + what); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise<number>(r => { const t = tcp(); t.listen(0, '127.0.0.1', () => { const p = (t.address() as any).port; t.close(() => r(p)); }); });

let api: ChildProcess | null = null;
async function startApi(port: number) {
  api = spawn('bun', ['server/index.ts'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DB_PATH }, stdio: 'pipe' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* aún no */ }
    await sleep(100);
  }
  throw new Error('el servidor no arranca');
}
function stopApi() {
  if (!api) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(api.pid), '/t', '/f']);
  else api.kill();
  api = null;
}

/** Errores de cada página. */
const pageErrors: string[] = [];

async function device(browser: Browser, url: string, label: string): Promise<Page> {
  const ctx = await browser.newContext();          // su propio localStorage: otro dispositivo
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(`${label}: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection to|net::ERR_/.test(m.text())) pageErrors.push(`${label} consola: ${m.text()}`);
  });
  // Con la máquina cargada, la primera carga de Vite (optimizar dependencias) a veces no acaba: se recarga una vez.
  for (let intento = 0; ; intento++) {
    try {
      await page.goto(url);
      await page.waitForFunction(() => typeof G === 'object' && G.DB && G.Flow && document.getElementById('boot').classList.contains('hidden'), null, { timeout: 60000 });
      return page;
    } catch (e) { if (intento >= 2) throw e; }
  }
}

const until = (page: Page, fn: string | ((arg: any) => any), arg?: any, timeout = 15000) =>
  page.waitForFunction(fn as any, arg, { timeout, polling: 50 }).then(() => true, () => false);

async function newPlayer(page: Page, name: string, dex: number) {
  const reg = await page.evaluate(([n, p]) => G.DB.register(n, p), [name, 'pikachu123']);
  if (!reg.ok) throw new Error('no se pudo crear la cuenta: ' + reg.error);
  await page.evaluate(d => { G.DB.save.partner = d; G.DB.grant(d, 'starter'); G.DB.commit(true); }, dex);
}

async function main() {
  const apiPort = await freePort();
  await startApi(apiPort);
  process.env.API_TARGET = `http://127.0.0.1:${apiPort}`;
  const { createServer } = await import('vite');
  const vite = await createServer({ root: ROOT, logLevel: 'error', server: { port: await freePort(), host: '127.0.0.1', hmr: false, watch: null } });
  await vite.listen();
  const url = vite.resolvedUrls!.local[0];
  const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ channel: 'msedge', headless: true }));
  const sfx = Math.random().toString(36).slice(2, 6);
  const nameA = 'Anfi' + sfx, nameB = 'Invi' + sfx;

  try {
    console.log('cuentas y amistad');
    const [a, b] = await Promise.all([device(browser, url, 'anfitrión'), device(browser, url, 'invitado')]);
    await Promise.all([newPlayer(a, nameA, 25), newPlayer(b, nameB, 4)]);
    check(await a.evaluate(() => G.Social.start()) === 'ok' && await b.evaluate(() => G.Social.start()) === 'ok', 'Social arranca con el nombre de la cuenta como apodo');
    const uidA = await a.evaluate(() => G.Social.uid), uidB = await b.evaluate(() => G.Social.uid);
    check((await a.evaluate(n => G.Social.request(n), nameB)).ok, 'solicitud enviada');
    check(await until(b, u => G.Social.friends.some(f => f.uid === u && f.status === 'in'), uidA), 'el otro la recibe sin recargar (por el WebSocket)');
    check((await b.evaluate(u => G.Social.accept(u), uidA)).ok, 'aceptada');
    check(await until(a, u => G.Social.friends.some(f => f.uid === u && f.status === 'ok' && f.online), uidB), 'el anfitrión ve a su amigo en línea');

    console.log('sala e invitación');
    check((await a.evaluate(u => G.Social.invite(u), uidB)).ok, 'invitación enviada');
    check(await until(b, u => G.Social.invites.some(i => i.from === u), uidA), 'el invitado recibe la invitación');
    check((await b.evaluate(u => G.Social.acceptInvite(u), uidA)).ok, 'invitación aceptada');
    check(await until(a, () => G.Social.room.members.length === 2), 'el anfitrión ve a los dos en la sala');
    await a.evaluate(() => G.LobbyUI.open());
    await b.evaluate(() => G.LobbyUI.open());
    check(await until(a, u => G.Net.open_ && G.Net.mode(u) === 'relay', uidB), 'Net conectado por el servidor');

    console.log('la partida en grupo');
    check(await until(a, () => !document.getElementById('lobby-start').disabled), 'el botón de empezar se habilita');
    await a.evaluate(() => document.getElementById('lobby-start').click());
    check(await until(a, () => G.Coop.active && G.Game.state === 'playing') && await until(b, () => G.Coop.active && G.Game.state === 'playing'), 'los dos juegan la misma partida');
    // Enemigos del anfitrión (puestos a mano, sin esperar a que nazcan) y sus copias en el invitado.
    await a.evaluate(() => {
      const def = G.Enemies.bagAt(60)[0], pl = G.Game.player;
      for (let i = 0; i < 4; i++) G.EnemyMgr.add(new G.Enemy(def, pl.x + Math.cos(i) * 220, pl.y + Math.sin(i) * 220, G.Enemies.scale(60)));
    });
    check(await until(b, () => G.EnemyMgr.all().filter(e => e.remote).length >= 2, undefined, 20000), 'el invitado ve copias de los enemigos del anfitrión');

    console.log('el anfitrión sale');
    await a.evaluate(() => G.Game.quit());
    check(await until(b, () => G.Game.state === 'over' && !G.Coop.active), 'la partida acaba también para el invitado');
    check(pageErrors.length === 0, 'sin errores en las páginas: ' + pageErrors.join(' | '));
  } finally {
    await browser.close();
    await vite.close();
    stopApi();
  }
  if (fails.length) { console.error(`FALLA (${fails.length}):\n  ` + fails.join('\n  ')); process.exit(1); }
  console.log('ok: amigos, sala y partida en grupo (humo)');
  process.exit(0);
}

main().catch(e => { console.error(e); stopApi(); process.exit(1); });
