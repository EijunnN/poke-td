/* ============ ranking.e2e.ts — el ranking en un navegador de verdad ============
 * Arranca server/index.ts (Bun, base de datos nueva en un temporal, con una cuenta de
 * moderación en ADMIN_USERS) y el juego con Vite, y juega con TRES navegadores
 * independientes: dos jugadores y la moderadora. Comprueba, mirando el DOM:
 * que el servidor rechaza una marca que dura más que la partida, que la marca válida sale en la
 * pantalla del ranking con el nombre y el puesto de cada uno, que un jugador corriente no
 * puede usar la moderación, que se reporta una marca (una sola vez), que la moderadora
 * la ve en Moderación y la quita, y que no salta ningún error en las páginas.
 *
 * No rebaja el anti-trampas: la marca más corta que se acepta es de 60 s y el servidor
 * no deja subir más tiempo del que ha pasado desde que empezó la partida (+30 s), así que
 * la prueba espera de verdad ~42 s.
 *
 *   node tests/ranking.e2e.ts
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
const DB_PATH = join(mkdtempSync(join(tmpdir(), 'poke-td-rk-e2e-')), 'test.sqlite');
const fails: string[] = [];
const check = (ok: unknown, what: string) => { if (!ok) fails.push(what); else console.log('  ok · ' + what); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 6);

const freePort = () => new Promise<number>(r => { const t = tcp(); t.listen(0, '127.0.0.1', () => { const p = (t.address() as any).port; t.close(() => r(p)); }); });

const MOD = 'Mod' + rnd(), ANA = 'Ana' + rnd(), BETO = 'Beto' + rnd(), PASS = 'pikachu123';

let api: ChildProcess | null = null;
async function startApi(port: number) {
  api = spawn('bun', ['server/index.ts'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DB_PATH, ADMIN_USERS: MOD.toUpperCase() + ', nadie' }, stdio: 'pipe' });
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

/** Un navegador con su propio localStorage (otro dispositivo, otra persona). */
async function device(browser: Browser, url: string, label: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => fails.push(`error en la página de ${label}: ${e.message}`));
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) fails.push(`${label}: ${r.status()} en ${r.url()}`); });
  page.on('dialog', d => d.accept());                    // el "¿Reportar la marca...?" del ranking
  await page.goto(url);
  await page.waitForFunction(() => typeof G === 'object' && G.DB && G.Flow && document.getElementById('boot').classList.contains('hidden'), null, { timeout: 90000 });
  // "Pulsa para empezar" (el navegador sin audio): tapa la pantalla y se come los clics.
  await page.locator('#tap-start:not(.hidden)').click({ timeout: 3000 }).catch(() => {});
  return page;
}

const register = (p: Page, name: string) => p.evaluate(([n, pw]) => G.DB.register(n, pw), [name, PASS]);

/** Las filas del ranking tal como las ve el jugador. */
const listRows = (p: Page) => p.$$eval('#rk-list .rk-row', rows => rows.map(r => ({
  mine: r.classList.contains('mine'),
  pos: (r.querySelector('.pos')?.textContent || '').trim(),
  who: (r.querySelector('.who b')?.textContent || '').trim(),
  time: (r.querySelector('.time')?.textContent || '').trim(),
  canReport: !!r.querySelector('.rk-rep'),
})));
const openRanking = async (p: Page, rows: number) => {
  await p.evaluate(() => G.RankingUI.open());
  await p.waitForFunction(n => document.querySelectorAll('#rk-list .rk-row').length >= n && !document.querySelector('#rk-list .sub'), rows, { timeout: 15000 });
};
/** Abre la pantalla y espera a que el texto de «tu puesto» cuadre con `re` (sirve cuando no hay filas). */
const openRankingMe = async (p: Page, re: RegExp) => {
  await p.evaluate(() => G.RankingUI.open());
  await p.waitForFunction(src => new RegExp(src).test(document.getElementById('rk-me').textContent), re.source, { timeout: 15000 });
};
const text = (p: Page, sel: string) => p.$eval(sel, e => (e.textContent || '').replace(/\s+/g, ' ').trim());

async function main() {
  const apiPort = await freePort();
  await startApi(apiPort);
  process.env.API_TARGET = `http://127.0.0.1:${apiPort}`;
  const { createServer } = await import('vite');
  const vite = await createServer({ root: ROOT, logLevel: 'error', server: { port: await freePort(), host: '127.0.0.1', hmr: false, watch: null } });
  await vite.listen();
  const url = vite.resolvedUrls!.local[0];
  const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ channel: 'msedge', headless: true }));

  try {
    console.log('cuentas');
    const ana = await device(browser, url, 'Ana'), beto = await device(browser, url, 'Beto'), mod = await device(browser, url, 'moderadora');
    for (const [p, n] of [[ana, ANA], [beto, BETO], [mod, MOD]] as const) check((await register(p, n)).ok, `crear la cuenta ${n}`);
    const betoUid = await beto.evaluate(() => G.DB.session.uid);
    check(await ana.evaluate(() => G.DB.online && G.DB.session.uid), 'con cuenta en el servidor, lo online está activo');

    console.log('sin marcas todavía');
    await openRankingMe(ana, /Aún no tienes marca/);
    check(/Todavía no hay marcas/.test(await text(ana, '#rk-list')), 'el ranking vacío lo dice y tu puesto aún no existe');

    console.log('anti-trampas desde el juego');
    await ana.evaluate(() => G.Ranking.runStarted('s'));
    await beto.evaluate(() => G.Ranking.runStarted('s'));
    const t0 = Date.now();
    await sleep(1500);                                                       // que el servidor haya apuntado la hora
    const impossible = (p: Page, t: number) => p.evaluate(t => G.DB.api('POST', '/ranking/submit', { mode: 's', t, lv: 3, kills: 20, dex: 25, shiny: false }), t);
    const early = await impossible(ana, 60);
    check(early.status === 400 && /imposible/.test(early.j.error), 'una marca de 60 s cuando la partida lleva 2 s se rechaza');
    const huge = await impossible(ana, 3000);
    check(huge.status === 400, 'una marca de 50 min se rechaza');
    check((await ana.evaluate(() => G.Ranking.submitSolo({ t: 3000, lv: 3, kills: 20, dex: 25, shiny: false }))).length === 0, 'submitSolo del juego devuelve [] y no mejora nada');
    check((await ana.evaluate(() => G.Ranking.myRank('s', 'a'))) === null, 'y no se ha apuntado nada');

    console.log('subir marcas válidas (se espera lo que exige el servidor)');
    await sleep(Math.max(0, 42_000 - (Date.now() - t0)));
    const betterAna = await ana.evaluate(() => G.Ranking.submitSolo({ t: 60, lv: 3, kills: 20, dex: 25, shiny: false }));
    const betterBeto = await beto.evaluate(() => G.Ranking.submitSolo({ t: 70, lv: 4, kills: 30, dex: 6, shiny: true }));
    check(JSON.stringify(betterAna) === '["d","w","m","a"]', `Ana mejora hoy, semana, mes e histórico (${JSON.stringify(betterAna)})`);
    check(JSON.stringify(betterBeto) === '["d","w","m","a"]', `Beto también (${JSON.stringify(betterBeto)})`);
    check(/Nueva mejor marca|nueva mejor marca/i.test(await ana.evaluate(() => document.body.textContent)), 'el juego avisa con un aviso de nueva mejor marca');
    const again = await ana.evaluate(() => G.Ranking.submitSolo({ t: 60, lv: 3, kills: 20, dex: 25, shiny: false }));
    check(again.length === 0, 'repetir la misma marca sin empezar otra partida no hace nada');

    console.log('la pantalla del ranking');
    await openRanking(ana, 2);
    const r1 = await listRows(ana);
    check(r1.length === 2, `Ana ve 2 marcas (${r1.length})`);
    check(r1[0].who === BETO && r1[0].time === '1:10' && r1[0].pos.endsWith('1') && !r1[0].mine, `primero Beto con 1:10 (${JSON.stringify(r1[0])})`);
    check(r1[1].who === ANA && r1[1].time === '1:00' && r1[1].pos.endsWith('2') && r1[1].mine, `segunda ella, con 1:00 y su fila marcada (${JSON.stringify(r1[1])})`);
    check(!r1[1].canReport && r1[0].canReport, 'no puede reportar su propia marca y sí la de Beto');
    check(/#2/.test(await text(ana, '#rk-me')) && /1:00/.test(await text(ana, '#rk-me')), `su puesto sale abajo: «${await text(ana, '#rk-me')}»`);
    await openRanking(beto, 2);
    const r2 = await listRows(beto);
    check(r2[0].who === BETO && r2[0].mine, 'Beto se ve el primero');
    check(/#1/.test(await text(beto, '#rk-me')), `y su puesto dice #1: «${await text(beto, '#rk-me')}»`);

    console.log('las pestañas');
    for (const label of ['Diario', 'Mensual', 'Histórico', 'Semanal']) {
      await ana.click(`#rk-period button:has-text("${label}")`);
      await ana.waitForFunction(() => document.querySelectorAll('#rk-list .rk-row').length === 2, null, { timeout: 10000 }).catch(() => {});
      check((await listRows(ana)).length === 2, `en «${label}» salen las 2 marcas`);
    }
    await ana.click('#rk-mode button:nth-child(2)');
    await ana.waitForFunction(() => /Todavía no hay marcas/.test(document.getElementById('rk-list').textContent), null, { timeout: 10000 });
    check(true, 'la pestaña Grupo está vacía y lo dice');
    await ana.click('#rk-mode button:nth-child(1)');
    await ana.waitForFunction(() => document.querySelectorAll('#rk-list .rk-row').length === 2, null, { timeout: 10000 });
    // El filtro por Pokémon (sólo histórico): Beto jugó con Charizard (6)
    const dexName = await ana.evaluate(() => G.DEX_BY[6].name);
    await ana.fill('#rk-poke', dexName);
    await ana.dispatchEvent('#rk-poke', 'change');
    await ana.waitForFunction(() => document.querySelectorAll('#rk-list .rk-row').length === 1, null, { timeout: 10000 });
    const f = await listRows(ana);
    check(f.length === 1 && f[0].who === BETO, `filtrando por ${dexName} sólo sale Beto`);
    await ana.click('#rk-clear');
    await ana.waitForFunction(() => document.querySelectorAll('#rk-list .rk-row').length === 2, null, { timeout: 10000 });

    console.log('moderación: quién puede');
    check(await ana.evaluate(() => document.getElementById('rk-mod').classList.contains('hidden')), 'a un jugador corriente no se le enseña el botón de Moderación');
    check(await ana.evaluate(() => G.Ranking.isAdmin()) === false, 'isAdmin() es false para ella');
    const hack = await ana.evaluate(async uid => { try { await G.Ranking.setMarked(uid, true); return 'ok'; } catch (e) { return e.message; } }, betoUid);
    check(/autorizado/i.test(hack), `si fuerza setMarked desde la consola, el servidor dice que no (${hack})`);
    const hack2 = await ana.evaluate(async uid => { try { await G.Ranking.removeEntry('s_all2', uid); return 'ok'; } catch (e) { return e.message; } }, betoUid);
    check(/autorizado/i.test(hack2), 'y removeEntry tampoco');
    check((await listRows(ana)).length === 2 && !!(await beto.evaluate(() => G.Ranking.myRank('s', 'a'))), 'nada ha cambiado');

    console.log('reportar');
    await ana.click('#rk-list .rk-row:not(.mine) .rk-rep');
    await ana.waitForFunction(() => G.Ranking.reported().size === 1, null, { timeout: 10000 });
    check(true, 'Ana reporta la marca de Beto desde la pantalla');
    await sleep(500);
    await ana.click('#rk-list .rk-row:not(.mine) .rk-rep');             // ya enviado: sólo avisa
    const dup = await ana.evaluate(uid => G.DB.api('POST', '/ranking/report', { board: G.Ranking.board('s', 'a'), e: uid }), betoUid);
    check(dup.status === 200 && dup.j.dup === true, 'y si el servidor recibe el mismo reporte otra vez, lo cuenta como repetido');
    const rep = await mod.evaluate(() => G.Ranking.reports());
    check(rep.length === 1 && rep[0].n === 1 && rep[0].e === betoUid && rep[0].names[0] === BETO, `la moderadora ve 1 reporte de la marca de Beto, una sola vez (${JSON.stringify(rep)})`);

    console.log('moderación en pantalla');
    await openRanking(mod, 2);
    await mod.waitForFunction(() => !document.getElementById('rk-mod').classList.contains('hidden'), null, { timeout: 10000 });
    check(true, 'a la moderadora sí se le enseña el botón de Moderación');
    await mod.click('#rk-mod');
    await mod.waitForSelector('#mod-list .rep', { timeout: 15000 });
    const repText = await text(mod, '#mod-list .rep');
    check(repText.includes(BETO) && repText.includes('1×') && repText.includes('1:10'), `Moderación enseña el reporte con el nombre, 1× y el tiempo (${repText.slice(0, 80)})`);
    await mod.click('#mod-list .rep button:has-text("Borrar marca")');
    await mod.waitForFunction(() => document.querySelectorAll('#mod-list .rep').length === 0, null, { timeout: 15000 });
    check(true, 'la moderadora borra la marca y el reporte desaparece de la lista');
    check((await mod.evaluate(() => G.Ranking.reports())).length === 0, 'y el servidor ya no tiene el reporte');

    console.log('después de moderar');
    check(await beto.evaluate(() => G.Ranking.myRank('s', 'a')) === null, 'Beto ya no tiene marca en el histórico');
    check(await beto.evaluate(() => G.Ranking.myRank('s', 'd')) === null && await beto.evaluate(() => G.Ranking.myRank('s', 'a', 6)) === null, 'ni hoy ni en la tabla de Charizard');
    await openRanking(ana, 1);
    await ana.waitForFunction(() => document.querySelectorAll('#rk-list .rk-row').length === 1, null, { timeout: 10000 });
    const left = await listRows(ana);
    check(left.length === 1 && left[0].who === ANA && /#1/.test(await text(ana, '#rk-me')), 'Ana ve su marca sola y sube al puesto 1');
    await openRankingMe(beto, /Aún no tienes marca/);
    check(true, 'Beto ve que ya no tiene marca');
    // Marcar a Beto desde el servidor: ya no puede subir
    await mod.evaluate(uid => G.Ranking.setMarked(uid, true), betoUid);
    check((await mod.evaluate(() => G.Ranking.markedAccounts())).some((a: any) => a.uid === betoUid && a.name === BETO), 'la moderadora lo ve entre las cuentas marcadas');
    await beto.evaluate(() => G.Ranking.runStarted('s'));
    await sleep(1000);
    const markedTry = await beto.evaluate(() => G.DB.api('POST', '/ranking/submit', { mode: 's', t: 60, lv: 3, kills: 20, dex: 25, shiny: false }));
    check(markedTry.status === 403, 'una cuenta marcada recibe 403 al subir');
    await mod.evaluate(uid => G.Ranking.setMarked(uid, false), betoUid);
    check((await mod.evaluate(() => G.Ranking.markedAccounts())).length === 0, 'y al desmarcarla deja de estar en la lista');
  } finally {
    await browser.close();
    await vite.close();
    stopApi();
  }
  if (fails.length) { console.error(`FALLA (${fails.length}):\n  ` + fails.join('\n  ')); process.exit(1); }
  console.log('ok: ranking en el navegador');
  process.exit(0);
}

main().catch(e => { console.error(e); stopApi(); process.exit(1); });
