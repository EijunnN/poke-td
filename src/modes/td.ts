import { G } from '../g';
import { Run, type GameMode, type View } from '../run';
import { Enemy } from '../entities/enemy';
/* ============ td.ts — modo Defensa (tower defense) · PROTOTIPO ============
 * Los enemigos entran por un camino fijo y van hacia la base; cada uno que
 * llega te quita vidas. Tú sigues llevando a tu compañero (el héroe) y, entre
 * oleadas, eliges 1 de 3 cartas: plantar a otro Pokémon como torre donde estás,
 * mejorar una torre o mejorar al héroe.
 *
 * Una torre es un G.Player que no se mueve: apunta y ataca con sus movimientos
 * igual que el héroe (G.Combat.tick), así cualquier Pokémon sirve de torre.
 * Los enemigos son los de siempre, pero de la clase Walker (aquí abajo): van al
 * siguiente punto del camino en vez de perseguir al jugador.
 *
 * Todo lo del modo vive en este archivo: no cambia nada del modo de hordas.
 *
 * Prototipo: un solo mapa, sin recompensas, sin ranking y sin cooperativo.
 */
export const TD = (() => {
  const LIVES = 20;
  /** Radio del claro sin obstáculos, en tiles: ahí cabe todo el camino. */
  const CLEAR = 24;
  /** El camino, en tiles: de la entrada (oeste) a la base (este). */
  const ROUTE: [number, number][] = [[-20, -8], [-8, -8], [-8, 6], [4, 6], [4, -6], [14, -6], [14, 8], [19, 8]];
  /** Segundos entre que eliges carta y sale la siguiente oleada. */
  const BREAK = 3;
  /** Los enemigos recorren el camino más deprisa que en las hordas (si no, una oleada dura un minuto). */
  const SPEED = 1.7;

  let time = 0;
  let pl = null;                     // el héroe
  let towers = [];                   // G.Player quietos
  let lives = LIVES, wave = 0, leaked = 0;
  /** 'break' = cuenta atrás, 'wave' = saliendo y peleando, 'cards' = eligiendo carta. */
  let phase: 'break' | 'wave' | 'cards' = 'cards';
  let phaseT = 0;
  let toSpawn = 0, spawnT = 0;
  let downT = 0;                     // héroe caído: segundos hasta levantarse
  /** Puntos del camino en unidades de mundo (los comparten todos los enemigos como destino). */
  let path: { x: number; y: number; r: number; level: number }[] = [];
  /** El héroe no sale de este radio (unidades de mundo): el mapa es el claro. */
  let bound = 0;

  /** Enemigo del camino: camina hacia su siguiente punto en vez de hacia el jugador. */
  class Walker extends Enemy {
    /** Índice en `path` del punto al que va. */
    wp = 1;
    update(dt: number) {
      // Nunca cuenta como rezagado (en las hordas, los rezagados reaparecen junto al jugador).
      this.lagT = -1e9;
      super.update(dt, path[this.wp]);
    }
  }

  /** Ataques lanzados por cada torre (para las pruebas). */
  const shots = new WeakMap<object, number>();

  const st = { get time() { return time; } };

  // ---------------- partida ----------------

  function start() {
    const save = G.DB.save;
    const mon = G.DEX_BY[save.partner];
    const perks = G.Upgrades.perks(G.DB.upgradesOf(mon.dex));

    G.UI.hideAll();
    G.UI.chrome(false);
    G.FX.clear();
    G.Projectiles.clear();
    G.Combat.clearFields();
    G.EnemyMgr.clear();
    G.Pickups.clear();
    G.Spawner.reset();
    G.Rift.reset();
    G.Judgment.reset();
    G.Events.reset();
    G.Weather.reset();
    G.Path.clear();
    G.Hazards.clear();
    G.World.reset(Math.floor(Math.random() * 1e6), CLEAR);
    G.World.setBiome(0, true);

    const TS = G.World.TS;
    path = ROUTE.map(([tx, ty]) => ({ x: tx * TS, y: ty * TS, r: 0, level: 1 }));
    bound = 20 * TS;
    time = 0; lives = LIVES; wave = 0; leaked = 0; downT = 0;
    towers = [];

    pl = new G.Player(mon, perks, !!save.partnerShiny && G.DB.ownsShiny(mon.dex));
    pl.addMove(G.startMoveOf(mon.dex));
    // Aquí las cartas no se cambian (no son las de subir de nivel).
    pl.rerolls = 99;
    G.Camera.x = pl.x; G.Camera.y = pl.y; G.Camera.shake = 0;
    G.Sprites.preload([mon.dex], 8000, pl.shiny);
    G.Audio.music(G.BIOME_MUSIC[0]);

    Run.state = 'playing';
    G.Spawner.say('Defiende la base: planta a tus Pokémon junto al camino', 4, true);
    // La primera carta sale antes de la primera oleada: así empiezas con una torre.
    phase = 'cards'; phaseT = 0.8;
  }

  function end(dead: boolean) {
    if (Run.state === 'over' || !pl) return;
    Run.state = 'over';
    G.Audio.music(null);
    G.Audio.sfx(dead ? 'gameover' : 'back');
    G.RunUI.showOver({
      dead, time, level: pl.level, kills: pl.kills, bosses: 0, coins: 0, record: false, t1: 0, t10: 0, judge: null,
      moves: pl.moves, caught: [],
      breakdown: 'Prototipo: la Defensa todavía no da recompensas'
    }, () => { pl = null; towers = []; G.EnemyMgr.clear(); G.Flow.afterRun(); });
    document.getElementById('over-title').textContent =
      (dead ? 'La base ha caído' : 'Defensa terminada') + ' · oleada ' + wave;
  }

  function everyone() { return [pl]; }

  // ---------------- oleadas ----------------

  /** Cuántos salen en la oleada n y cada cuánto. */
  const waveSize = (n: number) => 6 + n * 2;
  const waveGap = (n: number) => Math.max(0.35, 1 - n * 0.04);
  /** Los enemigos se eligen y escalan como si la run de hordas llevara este tiempo. */
  const waveClock = (n: number) => n * 28;

  function startWave() {
    wave++;
    toSpawn = waveSize(wave); spawnT = 0;
    phase = 'wave';
    G.Audio.sfx('biome');
    G.Spawner.say('— Oleada ' + wave + ' —', 2.4, true);
  }

  function spawnEnemy() {
    const t = waveClock(wave);
    const def = G.U.pick(G.Enemies.bagAt(t));
    const sc = G.Enemies.scale(t);
    // Cada 5 oleadas, el último que sale es un grandullón.
    const big = wave % 5 === 0 && toSpawn === 1;
    const e = new Walker(def, path[0].x + G.U.rand(-10, 10), path[0].y + G.U.rand(-10, 10),
                          { hp: sc.hp * (2 + wave * 0.25) * (big ? 9 : 1), spd: sc.spd * SPEED, dmg: sc.dmg * 2 });
    // Sólo caminan: sin disparos, saltos ni explosiones (apuntarían al camino, no a ti).
    e.behavior = 'chase';
    e.xp = Math.round(e.xp * 3);
    G.EnemyMgr.add(e);
  }

  /** Avanza a cada enemigo por el camino; el que llega a la base te quita vidas. */
  function march() {
    const list = G.EnemyMgr.all();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.dead || !(e instanceof Walker)) continue;
      const to = path[e.wp];
      if (G.U.dist2(e.x, e.y, to.x, to.y) > 18 * 18) continue;
      if (e.wp + 1 < path.length) { e.wp++; continue; }
      // Ha llegado a la base: fuera, sin botín ni animación.
      list.splice(i, 1);
      lives--; leaked++;
      G.FX.burst(e.x, e.y - 10, '#ff5f6d', 14, 160);
      G.Camera.kick(0.5);
      G.Audio.sfx('hurt');
    }
  }

  function tickPhase(dt: number) {
    if (phase === 'wave') {
      if (toSpawn > 0) {
        spawnT -= dt;
        if (spawnT <= 0) { spawnEnemy(); toSpawn--; spawnT = waveGap(wave); }
      } else if (!G.EnemyMgr.all().some(e => !e.dead)) {
        phase = 'cards'; phaseT = 1.2;
      }
    } else if (phase === 'cards') {
      phaseT -= dt;
      if (phaseT <= 0 && !pl.dead) offerCards();
    } else if ((phaseT -= dt) <= 0) startWave();
  }

  // ---------------- cartas y torres ----------------

  /** Pokémon que puedes plantar: tu colección; si es corta, se completa con iniciales. */
  function roster(): number[] {
    const owned = Object.keys(G.DB.save.owned || {}).map(Number).filter(d => G.DEX_BY[d]);
    const pool = new Set(owned);
    if (pool.size < 8) for (const s of G.STARTERS) { if (G.DEX_BY[s.dex]) pool.add(s.dex); }
    pool.delete(pl.dex);
    return [...pool];
  }

  function towerCard(dex: number) {
    const mon = G.DEX_BY[dex];
    const move = G.Moves.BY_ID[G.startMoveOf(dex)];
    const have = towers.find(t => t.dex === dex);
    const color = G.U.TYPE_COLOR[mon.types[0]];
    if (have) {
      return {
        type: 'up', key: 'tower-up:' + dex, icon: 'move:' + move.id, color, tag: 'Mejora',
        title: mon.name, desc: 'Tu torre de ' + mon.name + ' pega un 40% más fuerte.',
        apply: () => { have.atkMul *= 1.4; G.FX.ring(have.x, have.y, 8, 90, color, 0.6, 5); }
      };
    }
    return {
      type: 'new', key: 'tower:' + dex, icon: 'move:' + move.id, color, tag: 'Torre',
      title: mon.name, desc: 'Se queda donde estás ahora y ataca con ' + move.name + '.',
      apply: () => plant(dex)
    };
  }

  function offerCards() {
    const cards = G.U.pickN(roster(), 2).map(towerCard);
    const hero = G.LevelUp.offer(pl, 1)[0];
    if (hero) cards.push(hero);
    if (!cards.length) { phase = 'break'; phaseT = BREAK; return; }
    Run.state = 'levelup';
    G.Audio.sfx('levelup');
    G.RunUI.showLevelUp(wave + 1, cards, card => {
      G.Audio.sfx('confirm');
      card.apply(pl);
      Run.state = 'playing';
      phase = 'break'; phaseT = BREAK;
    });
  }

  /** Planta a `dex` como torre donde está el héroe (un poco al lado si ya hay otra). */
  function plant(dex: number) {
    const mon = G.DEX_BY[dex];
    const t = new G.Player(mon, {}, G.DB.ownsShiny(dex));
    t.frozen = true;                 // no lee el mando: sólo apunta y ataca
    t.addMove(G.startMoveOf(dex));
    let x = pl.x, y = pl.y;
    for (let i = 0; i < 12 && towers.some(o => G.U.dist2(o.x, o.y, x, y) < 44 * 44); i++) {
      const a = i * 2.4;
      x = pl.x + Math.cos(a) * (46 + i * 6); y = pl.y + Math.sin(a) * (46 + i * 6);
    }
    t.x = x; t.y = y;
    towers.push(t);
    G.Sprites.preload([dex], 4000, t.shiny);
    G.FX.ring(x, y, 8, 110, G.U.TYPE_COLOR[mon.types[0]], 0.6, 5);
    G.Spawner.say('¡' + mon.name + ' defiende el camino!', 2.2, true);
  }

  // ---------------- recogida ----------------

  function onCollect(p, who = pl) {
    if (p.kind === 'xp' || p.kind === 'xpBig') { G.Audio.sfx('xp'); pl.gainXp(p.value); return; }
    if (p.kind === 'coin') {
      G.Audio.sfx('coin');
      pl.coins += p.value;
      G.FX.dmgText(who.x, who.y - who.bodyH - 6, '+' + p.value, '#ffd23f');
      return;
    }
    if (p.kind === 'heal') {
      G.Audio.sfx('heal');
      pl.heal(pl.maxHp * 0.3);
      G.FX.ring(who.x, who.y, 6, 60, '#5fe08a', 0.4, 3);
    }
  }

  // ---------------- bucle ----------------

  function update(dt: number) {
    time += dt;
    for (const p of path) p.level = pl.level;

    // Héroe caído: se levanta solo al rato (la base aguanta mientras con las torres).
    if (pl.dead) {
      downT += dt;
      if (downT > 5) { downT = 0; pl.revive(0.5); }
    }
    pl.update(dt);
    // El mapa es el claro: el héroe no se va más allá.
    const far = Math.hypot(pl.x, pl.y);
    if (far > bound) { pl.x *= bound / far; pl.y *= bound / far; }
    G.Camera.follow(pl.x, pl.y, dt);
    G.World.update(dt, G.Camera);

    tickPhase(dt);
    G.Spawner.tickBanner(dt);
    G.EnemyMgr.update(dt, [pl]);
    G.EnemyMgr.rebuildGrid();
    march();

    G.Combat.tick(dt, pl, time);
    for (const t of towers) {
      t.update(dt);
      const m = t.activeMove(), was = m && m.castAt;
      G.Combat.tick(dt, t, time);
      if (m && m.castAt !== was) shots.set(t, (shots.get(t) || 0) + 1);
    }
    G.Projectiles.update(dt, pl, G.EnemyMgr.all());
    G.Combat.resolve(dt, pl, time);
    G.Combat.updateFields(dt);
    G.Pickups.update(dt, [pl], onCollect);
    G.Hazards.update(dt);
    G.FX.update(dt);

    if (lives <= 0) end(true);
  }

  function idle(dt: number) { G.FX.update(dt * 0.25); pl.anim.update(dt * 0.25); }

  // ---------------- teclado ----------------

  function keysModal() {
    if (Run.state !== 'levelup') return false;
    for (let i = 0; i < 3; i++) {
      if (G.Input.tap('digit' + (i + 1)) || G.Input.tap('numpad' + (i + 1))) G.RunUI.pick(i);
    }
    return true;
  }

  function keysPlay() {
    for (let i = 0; i < 4; i++) {
      if (G.Input.tap('digit' + (i + 1)) || G.Input.tap('numpad' + (i + 1))) pl.setActive(i);
    }
    if (G.Input.tap('keyq')) pl.cycle(-1);
    if (G.Input.tap('keye') || G.Input.tap('tab')) pl.cycle(1);
  }

  // ---------------- dibujo ----------------

  /** El camino y la base, pintados en el suelo. */
  function drawGround(ctx: CanvasRenderingContext2D) {
    if (path.length < 2) return;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const trace = () => { ctx.beginPath(); ctx.moveTo(path[0].x, path[0].y); for (const p of path) ctx.lineTo(p.x, p.y); };
    trace(); ctx.strokeStyle = 'rgba(60, 44, 28, 0.55)'; ctx.lineWidth = 50; ctx.stroke();
    trace(); ctx.strokeStyle = 'rgba(214, 186, 132, 0.85)'; ctx.lineWidth = 42; ctx.stroke();
    // La base: lo que defiendes.
    const b = path[path.length - 1];
    ctx.fillStyle = 'rgba(79, 180, 255, 0.35)';
    ctx.beginPath(); ctx.arc(b.x, b.y, 34, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = '#4fb4ff'; ctx.lineWidth = 4; ctx.stroke();
    // La entrada.
    const a = path[0];
    ctx.fillStyle = 'rgba(255, 95, 109, 0.35)';
    ctx.beginPath(); ctx.arc(a.x, a.y, 26, 0, 6.2832); ctx.fill();
    ctx.restore();
  }

  /** Las torres se ordenan por Y con el resto de la escena. */
  function drawables() { return towers; }

  function render(v: View) {
    const { ctx, w, h, dpr } = v;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;

    ctx.save();
    ctx.scale(G.Camera.scale, G.Camera.scale);
    G.Camera.apply(ctx);
    v.drawScene(G.Camera, [pl]);
    G.Projectiles.draw(ctx);
    G.Combat.drawAirFields(ctx);
    G.FX.draw(ctx);
    ctx.restore();

    G.World.drawVignette(ctx, w, h);
    G.HUD.draw(ctx, w, h, pl, st);
    drawStatus(ctx, w);
    G.Touch.draw(ctx);
  }

  /** Oleada, vidas y lo que falta, arriba en el centro. */
  function drawStatus(ctx: CanvasRenderingContext2D, w: number) {
    const left = toSpawn + G.EnemyMgr.all().filter(e => !e.dead).length;
    const text = phase === 'wave' ? 'Oleada ' + wave + ' · quedan ' + left
               : phase === 'break' ? 'Oleada ' + (wave + 1) + ' en ' + Math.max(1, Math.ceil(phaseT))
               : 'Elige carta';
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '700 15px Pixelify, monospace';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8, 14, 32, 0.85)';
    const line = text + '   ·   Vidas ' + Math.max(0, lives) + '   ·   Torres ' + towers.length;
    ctx.strokeText(line, w / 2, 78);
    ctx.fillStyle = lives <= 5 ? '#ff5f6d' : '#ffffff';
    ctx.fillText(line, w / 2, 78);
    ctx.restore();
  }

  return {
    id: 'td',
    start, update, idle, keysModal, keysPlay, drawables, drawGround, render, everyone,
    quit() { end(false); },
    /** Para las pruebas: cómo va la defensa. */
    get info() { return { wave, lives, leaked, phase, towers: towers.map(t => ({ dex: t.dex, x: t.x, y: t.y, shots: shots.get(t) || 0 })) }; },
    get player() { return pl; }, get time() { return time; }
  } satisfies GameMode & Record<string, unknown>;
})();
G.TD = TD;

declare module '../g' {
  interface Registry { TD: typeof TD }
}
