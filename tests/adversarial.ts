/* ============ adversarial.ts — pruebas diferenciales del juego ============
 * Juega partidas hostiles con el azar y el reloj fijados y compara el estado
 * resultante con el grabado en tests/golden.json. Si un cambio de código no
 * debía tocar la jugabilidad (migración, refactor), el estado tiene que salir
 * idéntico; si la toca a propósito, se regraba con --record.
 *
 *   node tests/adversarial.ts            compara con golden.json
 *   node tests/adversarial.ts --record   regraba golden.json
 *   --url http://host:puerto/pagina      contra un servidor ya abierto
 *                                        (si no, arranca Vite él solo)
 *   --only 3                             sólo el caso nº 3
 *   --record-only td                     regraba sólo ese caso (los demás se comparan)
 *
 * Además, en cualquier modo falla si: salta un error en la página, aparece un
 * NaN en el estado, la partida no llega a 'over' al morir, o dos pasadas
 * seguidas del mismo caso no dan lo mismo (el juego dejó de ser reproducible).
 */
import { chromium, type Page } from 'playwright-core';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

declare const G: any;
declare const window: any;

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden.json');
const arg = (k: string) => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1]; };
const RECORD = process.argv.includes('--record');
const ONLY = arg('--only');
const RECORD_ONLY = arg('--record-only');

/** Compañeros de tipos y familias de ataque distintas; cada caso con su semilla. */
const CASES = [25, 6, 9, 3, 94, 149, 448, 282, 143, 376, 130, 700].map((dex, i) => ({ dex, seed: 1000 + i * 7919 }));

/** Fases de cada caso: [salto de reloj en segundos o null, fotogramas a jugar]. */
const PHASES: [number | null, number][] = [
  [null, 600],   // arranque
  [175, 600],    // primer jefe (minuto 3)
  [238, 300],    // cambio de bioma (minuto 4)
  [535, 600],    // tercer jefe (minuto 9), enemigos duros
  [895, 300],    // último jefe (minuto 15)
];

/** Se inyecta antes que cualquier script del juego: azar con semilla, reloj falso y fotogramas a mano. */
function installHarness() {
  let s = 1;
  const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  Math.random = rnd;
  let now = 1_000_000;
  const T0 = 1_760_000_000_000;
  performance.now = () => now;
  Date.now = () => T0 + now;
  let queue: ((ts: number) => void)[] = [];
  window.requestAnimationFrame = (cb: any) => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  // Temporizadores: reales durante el arranque; desde freeze() van con el reloj
  // falso (saltan dentro de frame()), para que no dependan de la carga de la máquina.
  type Timer = { id: number; due: number; fn: any; args: any[]; every: number };
  let frozen = false, tid = 1_000_000_000, timers: Timer[] = [];
  const real = { st: window.setTimeout.bind(window), si: window.setInterval.bind(window), ct: window.clearTimeout.bind(window), ci: window.clearInterval.bind(window) };
  const add = (fn: any, ms: any, args: any[], repeat: boolean) => {
    const d = Math.max(0, +ms || 0);
    timers.push({ id: ++tid, due: now + d, fn, args, every: repeat ? Math.max(1, d) : 0 });
    return tid;
  };
  const drop = (id: any) => { timers = timers.filter(t => t.id !== id); };
  window.setTimeout = (fn: any, ms: any, ...a: any[]) => frozen ? add(fn, ms, a, false) : real.st(fn, ms, ...a);
  window.setInterval = (fn: any, ms: any, ...a: any[]) => frozen ? add(fn, ms, a, true) : real.si(fn, ms, ...a);
  window.clearTimeout = (id: any) => { drop(id); real.ct(id); };
  window.clearInterval = (id: any) => { drop(id); real.ci(id); };
  const runTimers = () => {
    for (let guard = 0; guard < 10000; guard++) {
      let best: Timer | null = null;
      for (const t of timers) if (t.due <= now && (!best || t.due < best.due || (t.due === best.due && t.id < best.id))) best = t;
      if (!best) return;
      if (best.every) best.due += best.every; else drop(best.id);
      if (typeof best.fn === 'function') best.fn(...best.args);
    }
  };
  window.__errors = [];
  addEventListener('error', (e: any) => window.__errors.push('error: ' + (e.message || e)));
  addEventListener('unhandledrejection', (e: any) => window.__errors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
  window.__h = {
    seed(n: number) { s = n; },
    rnd,
    /** Avanza un fotograma de 1/60 s. */
    frame() { now += 1000 / 60; runTimers(); const q = queue; queue = []; for (const cb of q) cb(now); },
    freeze() { frozen = true; },
    ready() { return queue.length > 0; },
  };
}

/** Dentro de la página: juega un caso entero y devuelve una foto del estado tras cada fase. */
async function playCase(c: { dex: number; seed: number }, phases: [number | null, number][]) {
  const h = window.__h;
  h.freeze();
  const key = (type: string, code: string) => dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
  const DIRS = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const nums = (o: any, out: Record<string, number> = {}) => {
    for (const k of Object.keys(o).sort()) if (typeof o[k] === 'number') out[k] = round((out[k] || 0) + o[k]);
    return out;
  };
  const len = (m: any) => { try { const a = m.all ? m.all() : m.list; return a ? a.length : -1; } catch { return -1; } };
  function snap() {
    const pl = G.Game.player, en = G.EnemyMgr.all();
    const sum: Record<string, number> = {};
    for (const e of en) nums(e, sum);
    return {
      state: G.Game.state, time: round(G.Game.st.time),
      player: pl ? nums(pl) : null,
      moves: pl && pl.moves ? pl.moves.map((m: any) => ({ id: m.id, ...nums(m) })) : [],
      item: pl ? pl.item || null : null,
      enemies: en.length, enemySum: sum,
      bosses: en.filter((e: any) => e.boss).map((e: any) => e.def && e.def.dex).join(','),
      pickups: len(G.Pickups), projectiles: len(G.Projectiles),
    };
  }

  // Sale de lo que hubiera (pone a prueba la limpieza entre partidas) y empieza.
  if (G.Game.state !== 'ui') { G.Game.quit(); G.Game.toUI(); }
  G.UI.hideAll();
  h.seed(c.seed);
  G.DB.playAsGuest();
  if (!G.DEX_BY[c.dex]) throw new Error('no existe el Pokémon ' + c.dex);
  G.DB.save.partner = c.dex;
  G.DB.grant(c.dex, 'starter');
  G.Flow.play();

  const snaps: any[] = [];
  let held: string | null = null, f = 0;
  let immortal = true;
  const play = async (frames: number) => {
    for (let i = 0; i < frames; i++, f++) {
      // Deja correr las promesas pendientes (no la red ni los sprites: esos
      // sólo llegan entre un caso y el siguiente, ver main()).
      await null;
      // Hasta la fase de muerte se le repone la vida cuando va a caer: el daño
      // se calcula igual, pero la partida llega a los jefes de todas las fases.
      const p = G.Game.player;
      if (immortal && p && p.hp < p.maxHp * 0.3) p.hp = p.maxHp;
      if (G.Game.state === 'playing') {
        // Cambia de rumbo cada segundo y medio y de ataque cada cinco.
        if (f % 90 === 0) { if (held) key('keyup', held); held = DIRS[Math.floor(h.rnd() * 4)]; key('keydown', held); }
        if (f % 300 === 150) { const d = 'Digit' + (1 + Math.floor(h.rnd() * 4)); key('keydown', d); key('keyup', d); }
      } else if (G.Game.state !== 'over' && f % 20 === 0) {
        // Cartas de nivel, elegir objeto...: pulsa una opción al azar.
        const d = 'Digit' + (1 + Math.floor(h.rnd() * 3)); key('keydown', d); key('keyup', d);
      }
      h.frame();
    }
  };
  for (const [jump, frames] of phases) {
    if (jump != null && G.Game.state !== 'over') {
      G.Game.debugTime(jump);
      // Con el reloj suben los enemigos: unos niveles de golpe (cartas, evoluciones).
      for (let i = 0; i < 5; i++) G.Game.debugLevelUp();
    }
    await play(frames);
    snaps.push(snap());
  }
  // Muerte: sin vida, la partida tiene que acabar sola y limpiamente.
  immortal = false;
  const pl = G.Game.player;
  if (pl && G.Game.state !== 'over') {
    for (let i = 0; i < 1800 && G.Game.state !== 'over'; i++) { pl.hp = Math.min(pl.hp, 1); pl.shield = 0; await play(1); }
  }
  if (held) key('keyup', held);
  snaps.push(snap());
  return snaps;
}

/** Dentro de la página: una partida del modo Defensa (tower defense), 90 s. */
async function playTD(seed: number) {
  const h = window.__h;
  h.freeze();
  const key = (type: string, code: string) => dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
  const DIRS = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const nums = (o: any, out: Record<string, number> = {}) => {
    for (const k of Object.keys(o).sort()) if (typeof o[k] === 'number') out[k] = round((out[k] || 0) + o[k]);
    return out;
  };
  function snap() {
    const pl = G.Game.player, en = G.EnemyMgr.all();
    const sum: Record<string, number> = {};
    for (const e of en) nums(e, sum);
    const info = G.TD.info;
    return {
      state: G.Game.state, time: round(G.Game.st.time), wave: info.wave, lives: info.lives, leaked: info.leaked, phase: info.phase,
      towers: info.towers.map((t: any) => ({ dex: t.dex, x: round(t.x), y: round(t.y), shots: t.shots })),
      player: pl ? nums(pl) : null, enemies: en.length, enemySum: sum,
    };
  }
  if (G.Game.state !== 'ui') { G.Game.quit(); G.Game.toUI(); }
  G.UI.hideAll();
  h.seed(seed);
  G.DB.playAsGuest();
  G.DB.save.partner = 25;
  G.DB.grant(25, 'starter');
  G.Game.start('td');

  const snaps: any[] = [];
  let held: string | null = null;
  for (let f = 0; f < 5400; f++) {
    await null;
    const p = G.Game.player;
    if (p && p.hp < p.maxHp * 0.3) p.hp = p.maxHp;
    if (G.Game.state === 'playing') {
      // El héroe da pasos cortos junto al camino, así
      // las torres quedan plantadas donde alcanzan a los enemigos.
      if (f % 30 === 0) {
        if (held) { key('keyup', held); held = null; }
        // (100, 120) queda pegado a un tramo del camino.
        const ox = p.x - 100, oy = p.y - 120, far = Math.hypot(ox, oy) > 70;
        const d = far ? (Math.abs(ox) > Math.abs(oy) ? (ox > 0 ? 'KeyA' : 'KeyD') : (oy > 0 ? 'KeyW' : 'KeyS')) : DIRS[Math.floor(h.rnd() * 4)];
        if (f % 60 === 0) { held = d; key('keydown', held); }
      }
    } else if (G.Game.state !== 'over' && f % 20 === 0) {
      // Las dos primeras cartas son torres: casi siempre una torre, a veces la del héroe.
      const d = 'Digit' + (h.rnd() < 0.8 ? 1 + Math.floor(h.rnd() * 2) : 3); key('keydown', d); key('keyup', d);
    }
    h.frame();
    if (f % 1800 === 1799) snaps.push(snap());
  }
  if (held) key('keyup', held);
  // Abandonar tiene que cerrar la partida limpiamente.
  G.Game.quit();
  snaps.push(snap());
  return snaps;
}

function findNaN(v: any, path = ''): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? null : path;
  if (v && typeof v === 'object') for (const k of Object.keys(v)) { const r = findNaN(v[k], path + '/' + k); if (r) return r; }
  return null;
}

function diff(a: any, b: any, path = ''): string | null {
  if (a === b) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const r = diff(a[k], b[k], path + '/' + k); if (r) return r; }
    return null;
  }
  return `${path}: esperado ${JSON.stringify(a)}, sale ${JSON.stringify(b)}`;
}

async function openPage(browser: any, url: string): Promise<{ page: Page; errors: string[] }> {
  const page: Page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|net::ERR|Failed to load resource|^\[vite\]/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.addInitScript(installHarness);
  await page.goto(url, { waitUntil: 'load' });
  // Sólo para el diagnóstico del arranque: una carga cancelada después no es un fallo.
  const boot: string[] = [];
  page.on('requestfailed', r => boot.push('no carga: ' + r.url()));
  page.on('response', r => { if (r.status() >= 400) boot.push(r.status() + ': ' + r.url()); });
  await page.waitForFunction(() => typeof G === 'object' && G.Game && G.Flow && window.__h.ready(), null, { timeout: 30000 })
    .catch(e => { throw new Error('el juego no arranca en ' + url + '\n  ' + [...errors, ...boot].slice(0, 8).join('\n  ') + '\n' + e.message); });
  return { page, errors };
}

async function main() {
  let url = arg('--url'), vite: any = null;
  const staticDir = arg('--static');
  if (staticDir) {
    // Servidor de archivos a secas (para grabar contra una copia del código antiguo, sin Vite).
    const { createServer } = await import('node:http');
    const TYPES: Record<string, string> = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', png: 'image/png', ttf: 'font/ttf', ico: 'image/x-icon', webmanifest: 'application/manifest+json' };
    const srv = createServer((req, res) => {
      const p = join(staticDir, decodeURIComponent(new URL(req.url!, 'http://x').pathname));
      if (!p.startsWith(staticDir) || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[p.split('.').pop()!] || 'application/octet-stream' }).end(readFileSync(p));
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    vite = { close: () => new Promise(r => srv.close(r)) };
    srv.unref();
    url = `http://127.0.0.1:${(srv.address() as any).port}/${arg('--path') || 'index.html'}`;
  }
  if (!url) {
    const { createServer } = await import('vite');
    // Sin recarga en caliente: si alguien edita un archivo a mitad de prueba, la página no se reinicia.
    // Un puerto libre de verdad (con el 0, el cliente de Vite se lía con su websocket).
    const { createServer: tcp } = await import('node:net');
    const port = await new Promise<number>(r => { const t = tcp(); t.listen(0, '127.0.0.1', () => { const p = (t.address() as any).port; t.close(() => r(p)); }); });
    vite = await createServer({ root: join(HERE, '..'), logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null } });
    await vite.listen();
    url = vite.resolvedUrls.local[0] + (arg('--path') || '');
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ channel: 'msedge', headless: true }));
  const fails: string[] = [];
  const golden = !RECORD && existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : null;
  if (!RECORD && !golden) { console.error('No hay tests/golden.json: graba primero con --record'); process.exit(2); }
  const cases = CASES.filter((_, i) => ONLY == null || +ONLY === i);

  // Dos pasadas en páginas distintas: la segunda comprueba que el juego es reproducible.
  const runs: any[][] = [];
  const td: any[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const { page, errors } = await openPage(browser, url!);
    const out: any[] = [];
    for (const c of cases) {
      // Antes de cada caso, que termine de llegar todo lo pedido (sprites):
      // así lo que hay cargado al empezar no depende de la velocidad de la máquina.
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(150);
      try { out.push(await page.evaluate(`(${playCase})(${JSON.stringify(c)}, ${JSON.stringify(PHASES)})`)); }
      catch (e: any) { out.push(null); fails.push(`caso dex ${c.dex}: revienta — ${String(e.message).split('\n')[0]}`); }
      const pageErrs = await page.evaluate(() => window.__errors.splice(0));
      for (const e of [...errors.splice(0), ...pageErrs]) fails.push(`caso dex ${c.dex} (pasada ${pass + 1}): ${e}`);
    }
    // Modo Defensa (sólo en la pasada completa).
    if (ONLY == null) {
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(150);
      try { td.push(await page.evaluate(`(${playTD})(4242)`)); }
      catch (e: any) { td.push(null); fails.push(`caso td: revienta — ${String(e.message).split('\n')[0]}`); }
      const pageErrs = await page.evaluate(() => window.__errors.splice(0));
      for (const e of [...errors.splice(0), ...pageErrs]) fails.push(`caso td (pasada ${pass + 1}): ${e}`);
    }
    runs.push(out);
    await page.close();
  }
  await browser.close();
  if (vite) await vite.close();

  cases.forEach((c, i) => {
    const a = runs[0][i], b = runs[1][i];
    if (!a || !b) return;
    const nan = findNaN(a); if (nan) fails.push(`caso dex ${c.dex}: número no válido en ${nan}`);
    if (a[a.length - 1].state !== 'over') fails.push(`caso dex ${c.dex}: al morir la partida no acaba (estado '${a[a.length - 1].state}')`);
    const rep = diff(a, b); if (rep) fails.push(`caso dex ${c.dex}: no es reproducible — ${rep}`);
    if (golden) {
      const g = golden[c.dex];
      const d = g ? diff(g, a) : 'no está grabado';
      if (d) fails.push(`caso dex ${c.dex}: distinto del grabado — fase${d}`);
    }
  });

  // Modo Defensa: reproducible, avanza, las torres pegan y abandonar cierra la partida.
  if (td.length === 2 && td[0] && td[1]) {
    const a = td[0], last = a[a.length - 1], mid = a[a.length - 2];
    if (process.argv.includes('--verbose')) for (const s of a) console.log('td', JSON.stringify({ ...s, player: undefined, enemySum: undefined, hp: s.player && s.player.hp, kills: s.player && s.player.kills, x: s.player && s.player.x, y: s.player && s.player.y }));
    const nan = findNaN(a); if (nan) fails.push('caso td: número no válido en ' + nan);
    const rep = diff(a, td[1]); if (rep) fails.push('caso td: no es reproducible — ' + rep);
    if (mid.wave < 3) fails.push('caso td: en 90 s sólo llega a la oleada ' + mid.wave);
    if (mid.towers.length < 2) fails.push('caso td: tras 90 s hay ' + mid.towers.length + ' torres');
    if (!(mid.player.kills > 0)) fails.push('caso td: no ha caído ningún enemigo');
    if (!mid.towers.some((t: any) => t.shots > 0)) fails.push('caso td: ninguna torre ha atacado');
    if (last.state !== 'over') fails.push(`caso td: al abandonar la partida no acaba (estado '${last.state}')`);
    if (golden && RECORD_ONLY !== 'td') {
      const d = golden.td ? diff(golden.td, a) : 'no está grabado (graba con --record-only td)';
      if (d) fails.push('caso td: distinto del grabado — fase' + d);
    }
  }
  if (RECORD_ONLY === 'td' && !fails.length && golden && td[0]) {
    golden.td = td[0];
    writeFileSync(GOLDEN, JSON.stringify(golden, null, 1) + '\n');
    console.log('grabado: caso td en tests/golden.json');
  }

  if (RECORD && !fails.length) {
    const out: any = {}; cases.forEach((c, i) => out[c.dex] = runs[0][i]);
    if (td[0]) out.td = td[0];
    writeFileSync(GOLDEN, JSON.stringify(out, null, 1) + '\n');
    console.log(`grabado: ${cases.length} casos en tests/golden.json`);
  }
  if (fails.length) { console.error(`FALLA (${fails.length}):\n  ` + fails.slice(0, 40).join('\n  ')); process.exit(1); }
  if (!RECORD) console.log(`ok: ${cases.length} casos × ${PHASES.length + 1} fases idénticos al grabado`);
}

main().catch(e => { console.error(e); process.exit(1); });
