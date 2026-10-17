/* ============ trailer.ts — graba los planos del tráiler del modo Defensa ============
 * Un bot juega la Defensa con el azar y el reloj fijados; los planos que
 * interesan se guardan como PNG (30 por segundo de juego), sin la interfaz de
 * la tienda ni los paneles. La música se graba aparte, sonando de verdad.
 * El montaje (rótulos, fundidos, música) lo hace tools/trailer-cut.py.
 *
 *   node tools/trailer.ts <carpeta>            todos los planos + música
 *   node tools/trailer.ts <carpeta> --stills   sólo fotos sueltas, para mirar (de lejos)
 *   --map tridente                              en otro mapa: sólo sus planos (las tres entradas y un jefe "por el norte")
 *   --music boss,rift --secs 100                graba esos temas (por defecto, 60 s)
 * Los planos de la Defensa normal: colocar (la vista previa roja y verde), evolucionar, montar la
 * defensa, apoyos (auras), enseñar un ataque (con el panel), los tipos, jefes y legendarios, el
 * tablero entero, Mewtwo y la victoria.
 */
import { chromium, type Page } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { installHarness } from '../tests/fakes.ts';

declare const G: any;
declare const window: any;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || join(HERE, '..', 'trailer-out');
const STILLS = process.argv.includes('--stills');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
mkdirSync(OUT, { recursive: true });

/** Dentro de la página: prepara la partida y deja al bot a mano (window.__bot). */
function setup(seed: number, mapId: string) {
  const h = window.__h;
  h.freeze();
  if (G.Game.state !== 'ui') { G.Game.quit(); G.Game.toUI(); }
  G.UI.hideAll();
  h.seed(seed);
  G.DB.playAsGuest();
  G.DB.save.partner = 25;
  const buyList = [4, 7, 1, 92, 147, 63, 66, 74, 81, 220, 123, 175, 52];
  for (const d of [25, ...buyList]) G.DB.grant(d, 'starter');
  G.Game.start('td', { team: buyList.slice(0, 6), map: mapId });

  // Plano limpio: sin tienda, paneles, minimapa ni barras del héroe; sólo el rótulo de la oleada.
  const st = document.createElement('style');
  st.textContent = '#tap-start,#td-shop,#td-tip,#td-map,.td-team{display:none!important} body:not(.show-panel) #td-panel{display:none!important}';
  document.head.appendChild(st);
  G.HUD.draw = () => {};
  const say = G.Spawner.say.bind(G.Spawner);
  G.Spawner.say = (t: string, ...a: any[]) => { if (!/monedas|tienda|Compra|sitio|camino/i.test(t)) say(t, ...a); };

  // Junto a las esquinas de cada camino, por turnos (con varias entradas, todas defendidas).
  const routes: { x: number; y: number }[][] = G.TD.routes, route = routes[0];
  const spots: { x: number; y: number }[] = [];
  for (let i = 1; i < Math.max(...routes.map(r => r.length)) - 1; i++)
    for (const r of routes) if (i < r.length - 1)
      for (const [dx, dy] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) spots.push({ x: r[i].x + dx * 60, y: r[i].y + dy * 60 });
  let buy = 0, f = 0;
  const bot = window.__bot = {
    /** true: no compra ni mejora (para grabar una evolución). */
    hold: false,
    /** Última torre mejorada. */
    last: -1,
    /** Antes de cada fotograma (la cámara de cada plano). */
    each: null as null | (() => void),
    step(play = true) {
      const p = G.Game.player;
      if (p && p.hp < p.maxHp * 0.3) p.hp = p.maxHp;
      // (Es un vídeo: la base no cae, para llegar a Mewtwo aunque el bot se pare a grabar.)
      if (G.TD.info.lives < 10) G.TD.debugLives(30);
      const info = G.TD.info;
      if (play && !bot.hold && f % 15 === 0 && !G.TD.placing) {
        if (info.evo) G.TD.debugEvolve(info.evo[info.evo.length - 1]);
        else {
          const lowest = info.towers.map((t: any, i: number) => ({ i, l: t.level })).sort((a: any, b: any) => a.l - b.l)[0];
          const next = buyList[buy % buyList.length];
          const cost = (G.TD.shop.find((c: any) => c.dex === next) || { cost: 1e9 }).cost;
          if (info.towers.length < 16 && (!lowest || lowest.l >= 2 + Math.floor(info.towers.length / 4) || info.towers.length < 3)) { if (info.money >= cost) G.TD.debugBuy(next); }
          else if (lowest && info.money >= info.towers[lowest.i].spent * 0.8) { G.TD.debugUpgrade(lowest.i); bot.last = lowest.i; }
        }
      }
      if (play && !bot.hold && G.TD.placing) {
        const spot = spots.find(s => G.TD.canPlace(s.x, s.y));
        if (spot) { G.TD.debugPlace(spot.x, spot.y); buy++; } else G.TD.debugBuy(G.TD.placing.dex);
      }
      // Los jefes, sin el destello blanco de cada golpe (les dan tantos que se quedaban en blanco).
      for (const e of G.EnemyMgr.all()) if (e.chief && !e.__noFlash) { e.__noFlash = true; Object.defineProperty(e, 'flash', { get: () => 0, set() {} }); }
      if (bot.each) bot.each();
      f++;
      h.frame();
    },
    /** Acerca o aleja la cámara: `w` = ancho de mundo visible. */
    zoom(w: number) { G.Camera.VIEW_W = w; G.Camera.MIN_VIEW_H = w * 0.55; G.Camera.resize(1280, 720, G.Camera.dpr); },
    /** Dónde plantará la próxima torre. */
    nextSpot() { return spots.find(s => G.TD.canPlace(s.x, s.y)) || null; },
    /** El jefe o legendario vivo (o null). */
    chief() { return G.EnemyMgr.all().find((e: any) => e.chief && !e.dead) || null; },
  };
  return route;
}

async function frames(page: Page, n: number) {
  await page.evaluate(`(async()=>{for(let i=0;i<${n};i++){await null;window.__bot.step();}})()`);
}
/** Juega sin grabar (a ×2) hasta que se cumpla `cond` (JS con `info` = G.TD.info). */
async function until(page: Page, cond: string, max = 60 * 60 * 40) {
  const ok = await page.evaluate(`(async()=>{G.TD.debugFast(true);let ok=false;for(let i=0;i<${max};i++){const info=G.TD.info;if(${cond}){ok=true;break;}if(G.Game.state!=='playing')break;await null;window.__bot.step();}G.TD.debugFast(false);return ok;})()`);
  if (!ok) throw new Error('no se ha llegado a: ' + cond + ' · ' + JSON.stringify(await page.evaluate(`({ st: G.Game.state, wave: G.TD.info.wave, lives: G.TD.info.lives, phase: G.TD.info.phase, kinds: G.EnemyMgr.all().map(e => e.kind + ':' + e.dex) })`)));
}
/** Graba `sec` segundos en <OUT>/<name>/ (30 fps: dos fotogramas de juego por imagen). */
async function rec(page: Page, name: string, sec: number) {
  if (ONLY && !ONLY.includes(name)) { await frames(page, Math.round(sec * 60)); return; }
  const dir = join(OUT, name); mkdirSync(dir, { recursive: true });
  const n = Math.round(sec * 30);
  for (let i = 0; i < n; i++) {
    await frames(page, 2);
    await page.screenshot({ path: join(dir, String(i).padStart(5, '0') + '.png') });
  }
  console.log('plano', name, n, 'imágenes · oleada', await page.evaluate('G.TD.info.wave'));
}
const js = (page: Page, s: string) => page.evaluate(s);
let nStill = 0;
async function still(page: Page, name: string) { await page.screenshot({ path: join(OUT, `still-${String(nStill++).padStart(2, '0')}-${name}.png`) }); }

/** La música del juego, sonando de verdad (otra página, reloj real) → <OUT>/music.webm */
async function recordMusic(browser: any, url: string, track: string, sec: number) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof G === 'object' && G.Audio, null, { timeout: 90000 });
  await page.mouse.click(10, 10);
  const b64 = await page.evaluate(async ([track, sec]: [string, number]) => {
    G.Audio.unlock();
    G.Audio.setVolume('sfx', 0);
    G.Audio.setVolume('music', 1);
    const stream = G.Audio.debugStream(true);
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    const parts: Blob[] = [];
    rec.ondataavailable = (e: any) => parts.push(e.data);
    const done = new Promise(r => rec.onstop = r);
    rec.start();
    G.Audio.music(track);
    await new Promise(r => setTimeout(r, sec * 1000));
    rec.stop(); await done;
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, [track, sec]);
  writeFileSync(join(OUT, `music-${track}.webm`), Buffer.from(b64, 'base64'));
  await page.close();
  console.log('música', track, sec, 's');
}

async function main() {
  const { createServer } = await import('vite');
  const { createServer: tcp } = await import('node:net');
  const port = await new Promise<number>(r => { const t = tcp(); t.listen(0, '127.0.0.1', () => { const p = (t.address() as any).port; t.close(() => r(p)); }); });
  const vite = await createServer({ root: join(HERE, '..'), mode: 'test', logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null } });
  await vite.listen();
  const url = vite.resolvedUrls!.local[0];
  const args = ['--autoplay-policy=no-user-gesture-required'];
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args }).catch(() => chromium.launch({ channel: 'msedge', headless: true, args }));

  if (process.argv.includes('--music')) {
    const secs = process.argv.includes('--secs') ? +process.argv[process.argv.indexOf('--secs') + 1] : 60;
    for (const t of process.argv[process.argv.indexOf('--music') + 1].split(',')) await recordMusic(browser, url, t, secs);
    await browser.close(); await vite.close(); return;
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  page.on('pageerror', e => console.error('pageerror:', e.message));
  await page.addInitScript(installHarness);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof G === 'object' && G.Game && G.Flow && window.__h.ready(), null, { timeout: 90000 });
  await page.waitForLoadState('networkidle');
  const mapId = process.argv.includes('--map') ? process.argv[process.argv.indexOf('--map') + 1] : 'valle';
  await js(page, `(${setup})(4242, ${JSON.stringify(mapId)})`);
  await js(page, `G.TD.debugHpMul(0.4)`);

  if (STILLS) {
    await js(page, `window.__bot.zoom(1500); G.TD.debugCam(0, 0)`);
    await frames(page, 60); await still(page, mapId + '-inicio');
    for (const w of [3, 10]) {
      await until(page, `info.wave>=${w}&&info.phase==='wave'`);
      await frames(page, 400); await still(page, mapId + '-oleada' + w);
    }
    await browser.close(); await vite.close(); return;
  }

  if (mapId !== 'valle') {
    // Un jefe, anunciado por su entrada ("¡Llega ... por el norte!"), siguiéndolo.
    await until(page, `info.wave === 5 && info.phase === 'wave' && window.__bot.chief()`);
    await js(page, `window.__bot.zoom(820); window.__bot.each = () => { const c = window.__bot.chief(); if (c) G.TD.debugCam(c.x, c.y + 60); }`);
    await rec(page, 'gate-' + mapId, 3.5);
    await js(page, 'window.__bot.each = null');
    // Las tres entradas a la vez, de lejos.
    await until(page, `info.wave >= 3 && info.phase === 'wave' && G.EnemyMgr.all().length > 9`);
    await js(page, `window.__bot.zoom(1700); G.TD.debugCam(-60, 0)`);
    await frames(page, 60);
    await rec(page, 'map-' + mapId, 4);
    await browser.close(); await vite.close(); return;
  }

  const route = await js(page, 'G.TD.route') as { x: number; y: number }[];

  // 0 · Colocar: la vista previa con su alcance; sobre el camino, roja con su X; junto a él, verde. Y se planta.
  await until(page, `info.wave >= 2`);
  await js(page, 'window.__bot.hold = true');
  await until(page, `info.money >= 70`);
  await until(page, `info.phase === 'wave' && G.EnemyMgr.all().length > 5`);
  const place = await js(page, `(() => {
    const s = window.__bot.nextSpot(), r = G.TD.route;
    let best = r[1], bd = Infinity;
    for (let i = 1; i < r.length; i++) { const p = { x: (r[i - 1].x + r[i].x) / 2, y: (r[i - 1].y + r[i].y) / 2 }, d = Math.hypot(p.x - s.x, p.y - s.y); if (d < bd) { bd = d; best = p; } }
    return { from: best, to: s };
  })()`) as { from: { x: number; y: number }; to: { x: number; y: number } };
  await js(page, `window.__bot.zoom(560); G.TD.debugCam(${(place.from.x + place.to.x) / 2}, ${(place.from.y + place.to.y) / 2}); G.TD.debugBuy(4); G.TD.debugGhost(${place.from.x}, ${place.from.y})`);
  await frames(page, 30);
  await js(page, `window.__glide = (k) => { const a = ${JSON.stringify(place)}, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; G.TD.debugGhost(a.from.x + (a.to.x - a.from.x) * e, a.from.y + (a.to.y - a.from.y) * e); }`);
  await js(page, `{ let i = 0; window.__bot.each = () => { i++; if (i > 40 && i <= 110) window.__glide((i - 40) / 70); if (i === 140) G.TD.debugPlace(${place.to.x}, ${place.to.y}); }; }`);
  await rec(page, 'place', 3.2);
  await js(page, 'window.__bot.each = null; window.__bot.hold = false');
  const mid = (i: number) => ({ x: (route[i].x + route[i + 1].x) / 2, y: (route[i].y + route[i + 1].y) / 2 });

  // 2 · Una evolución, de cerca.
  // (Charmander, Squirtle o Bulbasaur en nivel 2: la próxima mejora lo hace evolucionar.)
  const starter = `info.towers.findIndex(t => t.level === 2 && [4, 7, 1].includes(t.dex))`;
  await until(page, `info.wave >= 2 && ${starter} >= 0`);
  await js(page, `{ const info = G.TD.info; window.__evo = ${starter}; window.__bot.hold = true; }`);
  await until(page, `info.money >= 120`);           // (quieto, ahorrando para la mejora)
  await js(page, `{ const t = G.TD.info.towers[window.__evo]; window.__bot.zoom(460); G.TD.debugCam(t.x, t.y - 20); }`);
  await frames(page, 90);
  await rec(page, 'evo-a', 1.2);
  await js(page, `G.TD.debugUpgrade(window.__evo)`);
  await rec(page, 'evo-b', 2.8);
  await js(page, 'window.__bot.hold = false');

  // 1 · Montando la defensa: en plena oleada (después de la evolución), una torre nueva junto al camino.
  await until(page, `info.wave >= 5 && window.__bot.nextSpot()`);
  await js(page, 'window.__bot.hold = true');
  await until(page, `info.money >= 90 && info.phase === 'wave' && G.EnemyMgr.all().length > 4`);
  await js(page, `{ const s = window.__bot.nextSpot(); window.__bot.zoom(620); G.TD.debugCam(s.x, s.y - 30); }`);
  await frames(page, 60);
  await rec(page, 'build-a', 1);
  await js(page, 'window.__bot.hold = false');
  await rec(page, 'build', 3.5);

  // 1b · Apoyos: un Scyther entre las torres; su aura (Danza Espada) refuerza a las de alrededor.
  await js(page, 'window.__bot.hold = true');
  await until(page, `info.money >= (G.TD.shop.find(c => c.dex === 123) || { cost: 1e9 }).cost && info.phase === 'wave'`);
  const aura = await js(page, `(() => {
    const ts = G.TD.info.towers.filter(t => !t.support); let best = null, bn = -1;
    for (let x = -620; x <= 620; x += 20) for (let y = -620; y <= 620; y += 20) {
      if (!G.TD.canPlace(x, y)) continue;
      const n = ts.filter(t => Math.hypot(t.x - x, t.y - y) < 160).length;
      if (n > bn) { bn = n; best = { x, y }; }
    }
    return best;
  })()`) as { x: number; y: number };
  await js(page, `window.__bot.zoom(640); G.TD.debugCam(${aura.x}, ${aura.y})`);
  await frames(page, 30);
  await js(page, `{ let i = 0; window.__bot.each = () => { if (++i === 25) { G.TD.debugBuy(123); G.TD.debugPlace(${aura.x}, ${aura.y}); } }; }`);
  await rec(page, 'aura', 3.4);
  await js(page, 'window.__bot.each = null');


  // 4 · Legendario: Articuno, siguiéndolo.
  await until(page, `info.wave === 10 && window.__bot.chief()`);
  await js(page, `window.__bot.zoom(600); window.__bot.each = () => { const c = window.__bot.chief(); if (c) G.TD.debugCam(c.x, c.y); }`);
  await frames(page, 90);
  await rec(page, 'articuno', 3.5);

  // 1c · Enseñar un ataque: el panel de su mejor torre, y aprende otro de sus tipos.
  await js(page, 'window.__bot.each = null; window.__bot.hold = true');
  await until(page, `info.towers.some(t => !t.support && t.level >= 3) && info.money >= 200`);
  const best = await js(page, `(() => { const ts = G.TD.info.towers; let b = -1; ts.forEach((t, i) => { if (!t.support && (b < 0 || t.level > ts[b].level)) b = i; }); return b; })()`) as number;
  await js(page, `{ const t = G.TD.info.towers[${best}]; document.body.classList.add('show-panel'); G.TD.debugSelect(${best}); window.__bot.zoom(560); G.TD.debugCam(t.x + 150, t.y); }`);
  await frames(page, 30);
  await js(page, `{ let i = 0; window.__bot.each = () => { if (++i === 45) G.TD.debugLearn(${best}); }; }`);
  await rec(page, 'learn', 3.4);
  await js(page, `window.__bot.each = null; document.body.classList.remove('show-panel'); G.TD.debugSelect(-1); window.__bot.hold = false`);
  await js(page, `window.__bot.zoom(600); window.__bot.each = () => { const c = window.__bot.chief(); if (c) G.TD.debugCam(c.x, c.y); }`);

  // 5 · Jefe: Gyarados.
  await until(page, `info.wave === 15 && window.__bot.chief()`);
  await frames(page, 90);
  await rec(page, 'gyarados', 3);

  // 6 · Zapdos.
  await until(page, `info.wave === 20 && window.__bot.chief()`);
  await frames(page, 90);
  await rec(page, 'zapdos', 3);
  await js(page, 'window.__bot.each = null');

  // 3 · Los tipos en acción: en plena oleada 21-23 (se graba después de Zapdos).
  await until(page, `info.wave >= 21 && info.phase === 'wave' && G.EnemyMgr.all().length > 8`);
  await js(page, `window.__bot.zoom(640); window.__bot.each = () => { const e = G.EnemyMgr.all().filter(e => !e.dead); if (e.length) { const a = e[Math.floor(e.length / 2)]; G.TD.debugCam(a.x, a.y); } }`);
  await frames(page, 60);
  await rec(page, 'types', 4);
  await js(page, 'window.__bot.each = null');

  // 7 · Todo el tablero, a lo bruto.
  await until(page, `info.wave >= 27 && info.phase === 'wave' && G.EnemyMgr.all().length > 15`);
  await js(page, `window.__bot.zoom(1500); G.TD.debugCam(0, 0)`);
  await frames(page, 120);
  await rec(page, 'wide', 4);

  // 8 · Mewtwo.
  await until(page, `info.wave === 30 && window.__bot.chief()`);
  await js(page, `window.__bot.zoom(560); window.__bot.each = () => { const c = window.__bot.chief(); if (c) G.TD.debugCam(c.x, c.y); }`);
  await frames(page, 16);                           // (en cuanto entra, antes de que lo tapen los ataques)
  await rec(page, 'mewtwo', 4.5);

  // 9 · La victoria: la oleada 30 superada, de lejos (el aviso de la base defendida).
  await js(page, 'window.__bot.each = null');
  await until(page, `info.won`);
  await js(page, `window.__bot.zoom(1300); G.TD.debugCam(0, 0)`);
  await rec(page, 'victory', 3.5);

  await browser.close();
  await vite.close();
}
main().catch(e => { console.error(e); process.exit(1); });
