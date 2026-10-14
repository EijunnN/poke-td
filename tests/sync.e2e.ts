/* ============ sync.e2e.ts — el juego contra el servidor de verdad ============
 * Arranca server/index.ts (Bun, base de datos nueva en un temporal) y el juego
 * con Vite, y juega con DOS navegadores independientes (dos dispositivos):
 * cuentas, partida que viaja entre ellos, guardados cruzados que no se pisan,
 * sesión que se recupera al recargar, cerrar sesión, contraseña mala y el
 * servidor caído a mitad de partida.
 *
 *   node tests/sync.e2e.ts
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
const DB_PATH = join(mkdtempSync(join(tmpdir(), 'poke-td-e2e-')), 'test.sqlite');
const fails: string[] = [];
const check = (ok: unknown, what: string) => { if (!ok) fails.push(what); else console.log('  ok · ' + what); };

const freePort = () => new Promise<number>(r => { const t = tcp(); t.listen(0, '127.0.0.1', () => { const p = (t.address() as any).port; t.close(() => r(p)); }); });

let api: ChildProcess | null = null;
async function startApi(port: number) {
  api = spawn('bun', ['server/index.ts'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DB_PATH }, stdio: 'pipe' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* aún no */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('el servidor no arranca');
}
function stopApi() {
  if (!api) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(api.pid), '/t', '/f']);
  else api.kill();
  api = null;
}

async function device(browser: Browser, url: string): Promise<Page> {
  const ctx = await browser.newContext();          // su propio localStorage: otro dispositivo
  const page = await ctx.newPage();
  page.on('pageerror', e => fails.push('error en la página: ' + e.message));
  await page.goto(url);
  await page.waitForFunction(() => typeof G === 'object' && G.DB && G.Flow && document.getElementById('boot').classList.contains('hidden'), null, { timeout: 30000 });
  return page;
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
  const name = 'Ash' + Math.random().toString(36).slice(2, 7), pass = 'pikachu123';

  try {
    console.log('cuentas');
    const a = await device(browser, url);
    check(await a.evaluate(() => G.DB.mode) === 'cloud', 'con servidor, el juego entra en modo nube');
    const reg = await a.evaluate(([n, p]) => G.DB.register(n, p), [name, pass]);
    check(reg.ok && reg.isNew, 'crear cuenta desde el juego');
    const dup = await a.evaluate(([n, p]) => G.DB.register(n.toUpperCase(), p), [name, pass]);
    check(!dup.ok && /existe/.test(dup.error), 'el mismo nombre en mayúsculas no se puede volver a crear');

    console.log('la partida viaja entre dispositivos');
    await a.evaluate(async () => {
      const s = G.DB.save; s.partner = 25; G.DB.grant(25, 'starter'); s.coins = 777;
      G.DB.commit(true); await G.DB.flush();
    });
    check(await a.evaluate(() => G.DB.syncState) === 'ok', 'tras subir, sincronizado');
    const b = await device(browser, url);
    const log = await b.evaluate(([n, p]) => G.DB.login(n, p), [name, pass]);
    check(log.ok && !log.isNew, 'entrar en el segundo dispositivo');
    check(await b.evaluate(() => G.DB.save.partner === 25 && G.DB.owns(25) && G.DB.save.coins === 777), 'el segundo dispositivo ve compañero, colección y monedas');

    console.log('guardados cruzados: no se pisan');
    // Cada dispositivo consigue un Pokémon distinto sin saber del otro; B sube primero.
    await b.evaluate(async () => { G.DB.grant(4, 'gacha'); G.DB.commit(true); await G.DB.flush(); });
    await a.evaluate(async () => { G.DB.grant(1, 'gacha'); G.DB.grantShiny(7, 'wild'); G.DB.commit(true); await G.DB.flush(); });
    check(await a.evaluate(() => [1, 4, 7, 25].every(d => G.DB.owns(d)) && G.DB.ownsShiny(7)), 'A, al chocar con lo de B, fusiona: tiene los de los dos');
    const c = await device(browser, url);
    await c.evaluate(([n, p]) => G.DB.login(n, p), [name, pass]);
    check(await c.evaluate(() => [1, 4, 7, 25].every(d => G.DB.owns(d)) && G.DB.ownsShiny(7)), 'en el servidor queda la unión: un tercer dispositivo ve los 4 y el shiny');

    console.log('sesión');
    await a.reload();
    await a.waitForFunction(() => typeof G === 'object' && G.DB && document.getElementById('boot').classList.contains('hidden'), null, { timeout: 30000 });
    await a.evaluate(() => G.DB.ready());
    check(await a.evaluate(n => G.DB.loggedIn && G.DB.user === n, name), 'al recargar, la sesión sigue abierta');
    const oldToken = await a.evaluate(() => JSON.parse(localStorage.getItem('ps.token')).token);
    await a.evaluate(() => G.DB.logout());
    const me = await fetch(`http://127.0.0.1:${apiPort}/api/me`, { headers: { Authorization: 'Bearer ' + oldToken } });
    check(me.status === 401 && await a.evaluate(() => !G.DB.loggedIn && !localStorage.getItem('ps.token')), 'cerrar sesión la invalida también en el servidor');
    const bad = await a.evaluate(n => G.DB.login(n, 'mala-mala'), name);
    check(!bad.ok && /incorrect/.test(bad.error), 'contraseña mala: error claro y sin entrar');

    console.log('servidor caído a mitad de partida');
    stopApi();
    await new Promise(r => setTimeout(r, 500));
    await b.evaluate(async () => { G.DB.grant(150, 'wild'); G.DB.commit(true); await G.DB.flush(); });
    const st = await b.evaluate(() => G.DB.syncState);
    check(['offline', 'pending'].includes(st) && await b.evaluate(() => G.DB.owns(150)), `sin servidor: no se pierde nada y queda pendiente (${st})`);
    await startApi(apiPort);
    await b.evaluate(async () => { await G.DB.flush(); });
    check(await b.evaluate(() => G.DB.syncState) === 'ok', 'al volver el servidor, sube lo pendiente');
    await c.evaluate(async () => { await G.DB.logout(); });
    await c.evaluate(([n, p]) => G.DB.login(n, p), [name, pass]);
    check(await c.evaluate(() => G.DB.owns(150)), 'y lo conseguido sin conexión llega a los demás');

    console.log('borrar la cuenta');
    const del1 = await c.evaluate(() => G.DB.deleteAccount('mala-mala'));
    check(!del1.ok, 'borrar con contraseña mala no borra');
    const del2 = await c.evaluate(p => G.DB.deleteAccount(p), pass);
    const after = await b.evaluate(([n, p]) => G.DB.login(n, p), [name, pass]);
    check(del2.ok && !after.ok, 'borrar con la contraseña buena: ya no se puede entrar');
  } finally {
    await browser.close();
    await vite.close();
    stopApi();
  }
  if (fails.length) { console.error(`FALLA (${fails.length}):\n  ` + fails.join('\n  ')); process.exit(1); }
  console.log('ok: juego + servidor');
  process.exit(0);
}

main().catch(e => { console.error(e); stopApi(); process.exit(1); });
