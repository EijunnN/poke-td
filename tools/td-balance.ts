/* ============ td-balance.ts — ¿se puede ganar la Defensa? ============
 * Un bot sensato juega una partida entera del modo Defensa (a ×2, con el azar y
 * el reloj fijados) y enseña cómo acaba cada oleada: vidas, monedas, torres y
 * los poderes de tipo que han salido. Sirve para afinar td-waves.ts.
 *
 *   node tools/td-balance.ts                  semilla 4242
 *   node tools/td-balance.ts --seed 7 --seed 8
 *   node tools/td-balance.ts --support        también compra Pokémon de apoyo (Scyther, Togepi, Meowth)
 *   node tools/td-balance.ts --map espiral    en otro mapa (td-geom.ts, MAPS; por defecto, valle)
 *   node tools/td-balance.ts --smart          juega con cabeza: apoyos bien puestos, enseña ataques a sus
 *                                             mejores torres, compra los trofeos y mejora al héroe
 * La dificultad se afina para que el --smart sufra (gane justo o caiga cerca del final) y el
 * normal (que no sabe nada de tipos ni de estrategia) caiga hacia la mitad.
 * En cada oleada, las torres con un * reciben el aura de algún apoyo.
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
const smart = process.argv.includes('--smart');
const support = smart || process.argv.includes('--support');
const mapId = process.argv.includes('--map') ? process.argv[process.argv.indexOf('--map') + 1] : 'valle';

/** Dentro de la página: juega hasta ganar o perder y devuelve una línea por oleada. */
async function play(seed: number, hpMul: number, support: boolean, mapId: string, smart: boolean) {
  const h = window.__h;
  h.freeze();
  if (G.Game.state !== 'ui') { G.Game.quit(); G.Game.toUI(); }
  G.UI.hideAll();
  h.seed(seed);
  G.DB.playAsGuest();
  G.DB.save.partner = 25;
  // Una colección variada: un poco de cada tipo.
  // Con --support, cada cuatro compras una es de apoyo (las auras: más daño, más velocidad, más monedas).
  const team = support ? [4, 7, 123, 1, 92, 175, 66, 74, 52, 81, 63, 147, 220] : [4, 7, 1, 92, 66, 74, 81, 63, 147, 220];
  for (const d of [25, ...team]) G.DB.grant(d, 'starter');
  G.Game.start('td', { team: team.slice(0, 6), map: mapId });
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
  /**
   * Lo que haría alguien que sabe: un trofeo si llega el dinero; enseñar un ataque a la mejor torre
   * que aún pueda (desde el nivel 3); mejorar al héroe si sobra. → true si ha hecho algo
   */
  function smartMove(info: any): boolean {
    const net = G.TD.net;
    const trophy = G.TD.shop.find((c: any) => c.trophy && info.money >= c.cost + 40);
    if (trophy && info.towers.length < 16) { G.TD.debugBuy(trophy.dex); return true; }
    const best = net.towers.map((t: any, i: number) => ({ i, t })).filter((x: any) => !info.towers[x.i].support && x.t.level >= 3 && x.t.learned.length < 2)
      .sort((a: any, b: any) => b.t.level - a.t.level || a.t.learned.length - b.t.learned.length)[0];
    if (best && info.money >= info.towers[best.i].spent * 0.9) { const before = net.towers[best.i].learned.length; G.TD.debugLearn(best.i); return G.TD.net.towers[best.i].learned.length > before; }
    if (info.money > 400 && info.heroLevel < 5) { G.TD.debugHero(); return true; }
    return false;
  }
  for (let f = 0; f < 200000 && G.Game.state === 'playing'; f++) {
    // Ganada: se termina (si no, seguiría el sin fin).
    if (G.TD.net.won) { G.TD.finishWon(); break; }
    await null;
    const p = G.Game.player;
    if (p && p.hp < p.maxHp * 0.3) p.hp = p.maxHp;
    const info = G.TD.info;
    if (f % 15 === 0 && !G.TD.placing) {
      if (info.evo) G.TD.debugEvolve(info.evo[0]);
      else if (smart && f % 45 === 0 && smartMove(info)) { /* ya ha hecho algo */ }
      else {
        // Primero, hasta 8 torres (una de cada tipo del equipo); después, mejora la de menos nivel.
        const lowest = info.towers.map((t: any, i: number) => ({ i, l: t.level })).sort((a: any, b: any) => a.l - b.l)[0];
        if (info.towers.length < 16 && (!lowest || lowest.l >= 2 + Math.floor(info.towers.length / 4) || info.towers.length < 3)) G.TD.debugBuy(team[buy % team.length]);
        else if (lowest) G.TD.debugUpgrade(lowest.i);
      }
    }
    if (G.TD.placing) {
      // Un apoyo va donde su aura alcanza a más torres (como lo pondría alguien que sabe); el resto, en las esquinas.
      let spot = spots.find(s => G.TD.canPlace(s.x, s.y));
      if (info.towers.length && [123, 175, 52].includes(G.TD.placing.dex)) {
        let best = -1;
        for (let x = -620; x <= 620; x += 20) for (let y = -620; y <= 620; y += 20) {
          if (!G.TD.canPlace(x, y)) continue;
          const n = info.towers.filter((t: any) => !t.support && Math.hypot(t.x - x, t.y - y) < 170).length;
          if (n > best) { best = n; spot = { x, y }; }
        }
      }
      if (spot) { G.TD.debugPlace(spot.x, spot.y); buy++; }
      else G.TD.debugBuy(G.TD.placing.dex);        // no queda sitio: la suelta
    }
    if (info.wave !== lastWave && info.phase === 'wave') lastWave = info.wave;
    if (info.phase === 'break' && rows.length < info.wave) {
      rows.push({ wave: info.wave, lives: info.lives, reach: info.reach, leaked: info.leaked, money: info.money,
        towers: info.towers.map((t: any) => G.DEX_BY[t.dex].name + ' ' + t.level + (t.buff.dmg || t.buff.haste ? '*' : '')).join(', ') });
    }
    h.frame();
  }
  const info = G.TD.info;
  rows.push({ end: G.Game.state, wave: info.wave, lives: info.lives, won: info.won, time: Math.round(G.Game.st.time), powers: info.powers,
              towers: info.towers.map((t: any) => G.DEX_BY[t.dex].name + ' ' + t.level).join(', ') });
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
    const rows = await page.evaluate(`(${play})(${seed}, ${hpMul}, ${support}, ${JSON.stringify(mapId)}, ${smart})`) as any[];
    console.log(`\n== semilla ${seed}, vida ×${hpMul}, mapa ${mapId}${smart ? ', con cabeza' : support ? ', con apoyos' : ''} (${Math.round((Date.now() - t0) / 1000)} s) ==`);
    for (const r of rows) console.log(r.end ? JSON.stringify(r) : `oleada ${String(r.wave).padStart(2)} · vidas ${String(r.lives).padStart(2)} · llega al ${String(Math.round(r.reach * 100)).padStart(3)}% · monedas ${String(r.money).padStart(4)} · ${r.towers}`);
  }
  await browser.close();
  await vite.close();
}
main().catch(e => { console.error(e); process.exit(1); });
