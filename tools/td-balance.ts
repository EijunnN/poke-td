/* ============ td-balance.ts — ¿se puede ganar la Defensa? ============
 * Un bot sensato juega una partida entera del modo Defensa (a ×2, con el azar y
 * el reloj fijados) y enseña cómo acaba cada oleada: vidas, monedas, torres y
 * los poderes de tipo que han salido. Sirve para afinar td-waves.ts.
 *
 *   node tools/td-balance.ts                  semilla 4242
 *   node tools/td-balance.ts --seed 7 --seed 8
 *
 * No es una prueba (no falla): es una herramienta para mirar. Tarda un par de
 * minutos por semilla.
 */
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installHarness } from '../tests/fakes.ts';

declare const G: any;
declare const window: any;

const HERE = dirname(fileURLToPath(import.meta.url));
const seeds = process.argv.flatMap((a, i) => a === '--seed' ? [+process.argv[i + 1]] : []);
if (!seeds.length) seeds.push(4242);
/** --hp 1,2,4: repite con la vida de los enemigos multiplicada (para ver dónde empieza a costar). */
const hpMuls = (process.argv.includes('--hp') ? process.argv[process.argv.indexOf('--hp') + 1] : '1').split(',').map(Number);

/** Dentro de la página: juega hasta ganar o perder y devuelve una línea por oleada. */
async function play(seed: number, hpMul: number) {
  const h = window.__h;
  h.freeze();
  if (G.Game.state !== 'ui') { G.Game.quit(); G.Game.toUI(); }
  G.UI.hideAll();
  h.seed(seed);
  G.DB.playAsGuest();
  G.DB.save.partner = 25;
  // Una colección variada: un poco de cada tipo.
  const team = [4, 7, 1, 92, 66, 74, 81, 63, 147, 220];
  for (const d of [25, ...team]) G.DB.grant(d, 'starter');
  G.Game.start('td', { team: team.slice(0, 6) });
  G.TD.debugFast(true);
  G.TD.debugHpMul(hpMul);

  const route = G.TD.route;
  // Sitios junto a las esquinas del camino (por dentro de la curva cubren dos tramos).
  const spots: { x: number; y: number }[] = [];
  for (let i = 1; i < route.length - 1; i++) {
    for (const [dx, dy] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) spots.push({ x: route[i].x + dx * 60, y: route[i].y + dy * 60 });
  }
  const rows: any[] = [];
  let lastWave = 0, buy = 0;
  for (let f = 0; f < 200000 && G.Game.state === 'playing'; f++) {
    await null;
    const p = G.Game.player;
    if (p && p.hp < p.maxHp * 0.3) p.hp = p.maxHp;
    const info = G.TD.info;
    if (f % 15 === 0 && !G.TD.placing) {
      if (info.evo) G.TD.debugEvolve(info.evo[0]);
      else {
        // Primero, hasta 8 torres (una de cada tipo del equipo); después, mejora la de menos nivel.
        const lowest = info.towers.map((t: any, i: number) => ({ i, l: t.level })).sort((a: any, b: any) => a.l - b.l)[0];
        if (info.towers.length < 16 && (!lowest || lowest.l >= 2 + Math.floor(info.towers.length / 4) || info.towers.length < 3)) G.TD.debugBuy(team[buy % team.length]);
        else if (lowest) G.TD.debugUpgrade(lowest.i);
      }
    }
    if (G.TD.placing) {
      const spot = spots.find(s => G.TD.canPlace(s.x, s.y));
      if (spot) { G.TD.debugPlace(spot.x, spot.y); buy++; }
      else G.TD.debugBuy(G.TD.placing.dex);        // no queda sitio: la suelta
    }
    if (info.wave !== lastWave && info.phase === 'wave') lastWave = info.wave;
    if (info.phase === 'break' && rows.length < info.wave) {
      rows.push({ wave: info.wave, lives: info.lives, reach: info.reach, leaked: info.leaked, money: info.money,
        towers: info.towers.map((t: any) => G.DEX_BY[t.dex].name + ' ' + t.level).join(', ') });
    }
    h.frame();
  }
  const info = G.TD.info;
  rows.push({ end: G.Game.state, wave: info.wave, lives: info.lives, won: info.won, time: Math.round(G.Game.st.time), powers: info.powers });
  if (G.Game.state === 'playing') G.Game.quit();
  return rows;
}

async function main() {
  const { createServer } = await import('vite');
  const { createServer: tcp } = await import('node:net');
  const port = await new Promise<number>(r => { const t = tcp(); t.listen(0, '127.0.0.1', () => { const p = (t.address() as any).port; t.close(() => r(p)); }); });
  const vite = await createServer({ root: join(HERE, '..'), mode: 'test', logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null } });
  await vite.listen();
  const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ channel: 'msedge', headless: true }));
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', e => console.error('pageerror:', e.message));
  await page.addInitScript(installHarness);
  await page.goto(vite.resolvedUrls!.local[0], { waitUntil: 'load' });
  await page.waitForFunction(() => typeof G === 'object' && G.Game && G.Flow && window.__h.ready(), null, { timeout: 90000 });
  for (const hpMul of hpMuls) for (const seed of seeds) {
    await page.waitForLoadState('networkidle');
    const t0 = Date.now();
    const rows = await page.evaluate(`(${play})(${seed}, ${hpMul})`) as any[];
    console.log(`\n== semilla ${seed}, vida ×${hpMul} (${Math.round((Date.now() - t0) / 1000)} s) ==`);
    for (const r of rows) console.log(r.end ? JSON.stringify(r) : `oleada ${String(r.wave).padStart(2)} · vidas ${String(r.lives).padStart(2)} · llega al ${String(Math.round(r.reach * 100)).padStart(3)}% · monedas ${String(r.money).padStart(4)} · ${r.towers}`);
  }
  await browser.close();
  await vite.close();
}
main().catch(e => { console.error(e); process.exit(1); });
