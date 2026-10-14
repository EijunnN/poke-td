import { G } from '../g';
import { Run, type GameMode, type View } from '../run';
import { Enemy } from '../entities/enemy';
import {
  leadAngle, placementError, moveRange, towerCost, upgradeCost, sellValue, killReward, waveBonus,
  evolvesAt, START_MONEY, MAX_LEVEL, PATH_CLEAR, TOWER_GAP, ENDS_CLEAR,
  pathLengths, pathProgress, stepBack, pickTarget, TARGET_MODES, TARGET_NAME, type TargetMode,
  ROLES, roleHit, SUPPORT, AURAS, AURA_KINDS, auraStrength, auraRadius, aurasAt, type AuraKind, type AuraTotals
} from './td-geom';
import { START_LIVES, LAST_WAVE, waveAt, waveHp, waveCount, waveGap, bossHpMul, leakCost } from './td-waves';
/* ============ td.ts — modo Defensa (tower defense) ============
 * Los enemigos entran por un camino fijo y van hacia la base; cada uno que
 * llega te quita vidas. Tú sigues llevando a tu compañero (el héroe).
 *
 * Las oleadas son un calendario fijo de 30 (td-waves.ts): cada una tiene un
 * tema ("Voladores", "Fantasmas"...) que se anuncia antes, para preparar las
 * torres. Cada 5 sale un jefe y cada 10 un legendario.
 *
 * En la partida ganas monedas por cada enemigo y por cada oleada superada, y con
 * ellas compras en la tienda (izquierda) cualquier Pokémon de tu colección; los
 * favoritos (los que eliges antes de empezar) salen primero. Clic sobre una torre:
 *   - mejorarla: sube de nivel su ataque y, en los niveles 3 y 5, evoluciona;
 *   - elegir a quién ataca (el primero, el último, el más fuerte, el más cercano);
 *   - venderla y recuperar parte de lo gastado.
 * Los Pokémon de apoyo (Scyther, Togekiss, Lucario, Meowth, Noctowl...) no atacan:
 * dan un aura a las torres cercanas (+daño, +velocidad, +crítico, +monedas,
 * +alcance; td-geom.ts, SUPPORT). Las de la misma clase no se suman.
 * Cada tipo tiene su poder además de su daño (td-geom.ts, ROLES): Hielo congela,
 * Fuego quema, Eléctrico paraliza, Psíquico confunde... La tabla de tipos de los
 * juegos se aplica como siempre (Tierra no le hace nada a un volador).
 *
 * Una torre es un G.Player que no se mueve: apunta y ataca con sus movimientos
 * igual que el héroe (G.Combat.tick), así cualquier Pokémon sirve de torre. Sólo
 * ataca a enemigos dentro de su alcance, y apunta a donde VAN a estar. Los
 * enemigos son de la clase Walker: van al siguiente punto del camino en vez de
 * perseguir al jugador, y en ellos se aplican los poderes de cada tipo.
 *
 * Todo lo del modo vive aquí, en td-geom.ts y en td-waves.ts: no cambia nada
 * del modo de hordas. Sin recompensas de cuenta, ranking ni cooperativo (aún).
 */
export const TD = (() => {
  /** Radio del claro sin obstáculos, en tiles: ahí cabe todo el camino. */
  const CLEAR = 24;
  /** El camino, en tiles: de la entrada (oeste) a la base (este). */
  const ROUTE: [number, number][] = [[-20, -8], [-8, -8], [-8, 6], [4, 6], [4, -6], [14, -6], [14, 8], [19, 8]];
  /** Segundos de descanso entre oleadas (se pueden adelantar con el botón). */
  const BREAK = 12;
  /** Antes de la primera oleada, más rato para plantar las primeras torres. */
  const FIRST_BREAK = 25;
  /** Velocidad de los enemigos en el camino (unidades por segundo) en la oleada 1. */
  const WALK = 95;
  /** Favoritos como mucho (los que salen primero en la tienda). */
  const TEAM_MAX = 6;
  /**
   * Alcance máximo de una torre. Los proyectiles vuelan hasta 520, pero con eso una
   * torre cubría medio mapa y daba igual dónde ponerla.
   */
  const RANGE_MAX = 340;
  /** Cuántos Pokémon enseña la tienda a la vez (con más, se filtra por tipo). */
  const SHOP_MAX = 60;

  /** Una torre: el Pokémon que ataca, lo gastado y a quién apunta. */
  /**
   * Una torre: el Pokémon, lo gastado, a quién apunta, su ataque sin auras (`atk`)
   * y las auras que recibe ahora (`buff`).
   */
  interface Tower { p: any; dex: number; level: number; base: number; spent: number; mode: TargetMode; atk: number; buff: AuraTotals }

  let time = 0;
  let pl = null;                     // el héroe
  let heroLevel = 1;                 // mejoras del ataque del héroe compradas con monedas
  let towers: Tower[] = [];
  /** Favoritos (salen primero en la tienda). */
  let team: number[] = [];
  /** Todo lo que se puede comprar: tu colección y, si es corta, iniciales prestados. */
  let pool: { dex: number; lent: boolean }[] = [];
  let money = START_MONEY;
  let lives = START_LIVES, wave = 0, leaked = 0;
  /** 'break' = descanso antes de la oleada, 'wave' = saliendo y peleando. */
  let phase: 'break' | 'wave' = 'break';
  let phaseT = 0;
  let toSpawn = 0, spawnT = 0;
  /** Jefe de la oleada que aún no ha salido. */
  let bossLeft = 0;
  let downT = 0;                     // héroe caído: segundos hasta levantarse
  let won = false;
  /** Oleadas superadas (lo que cuenta para el ranking). */
  let cleared = 0;
  /** La partida se ha tocado desde la consola (debugHpMul): no sube al ranking. */
  let tampered = false;
  /** ×1 o ×2: todo pasa el doble de deprisa. */
  let fast = false;
  /** Puntos del camino en unidades de mundo (los comparten todos los enemigos como destino). */
  let path: { x: number; y: number; r: number; level: number }[] = [];
  let lens: number[] = [];
  /** El héroe no sale de este radio (unidades de mundo): el mapa es el claro. */
  let bound = 0;
  /** Poderes de tipo que se han disparado (para las pruebas). */
  let powers: Record<string, number> = {};
  /** Lo más lejos que ha llegado un enemigo en la oleada (0 = entrada, 1 = base; para afinar). */
  let reach = 0;
  /** Multiplica la vida de los enemigos (sólo para afinar, con tools/td-balance.ts). */
  let hpMul = 1;

  // ---------------- enemigos ----------------

  /** De qué tipo es un golpe, por su color (los ataques se pintan del color de su tipo). */
  let colorType: Map<string, string> | null = null;
  function typeOfColor(c: string) {
    if (!colorType) colorType = new Map(Object.entries(G.U.TYPE_COLOR).map(([t, col]) => [col as string, t]));
    return colorType.get(c) || '';
  }

  /** Enemigo del camino: camina hacia su siguiente punto en vez de hacia el jugador. */
  class Walker extends Enemy {
    /** Índice en `path` del punto al que va. */
    wp = 1;
    /** 'boss' (jefe de cada 5) o 'legend' (legendario de cada 10). */
    kind: 'normal' | 'boss' | 'legend' = 'normal';
    /** Oleada en la que salió (para su recompensa). */
    wave = 1;
    chill = 0; chillCd = 0; frozenT = 0; stunT = 0; confuseT = 0; curseT = 0;
    /** Tipo del último golpe (el Hada da más monedas si es ella quien lo derrota). */
    lastType = '';
    textCd = 0;

    get chief() { return this.kind !== 'normal'; }

    update(dt: number) {
      // Nunca cuenta como rezagado (en las hordas, los rezagados reaparecen junto al jugador).
      this.lagT = -1e9;
      if (!this.dead) {
        this.chillCd -= dt; this.frozenT -= dt; this.stunT -= dt; this.confuseT -= dt; this.curseT -= dt; this.textCd -= dt;
      }
      // Confundido: anda hacia atrás.
      const to = this.confuseT > 0 && this.wp > 1 ? path[this.wp - 1] : path[this.wp];
      super.update(dt, to);
    }

    hurt(amount: number, color = '#fff', dirX = 0, dirY = 0, knock = 0, eff: string | null = null) {
      if (this.dead) return;
      const type = typeOfColor(color);
      // Sin empujones: sacarían a los enemigos del camino (el Agua los arrastra POR el camino).
      if (!type) { super.hurt(amount, color, dirX, dirY, 0, eff); return; }
      const fx = roleHit(type, { hp: this.hp, maxHp: this.maxHp, boss: this.chief, flying: this.flying, cursed: this.curseT > 0 }, Math.random);
      this.lastType = type;
      super.hurt(amount * fx.mul, color, dirX, dirY, 0, fx.crit ? 'crit' : eff);
      if (this.dead) return;
      const r = ROLES[type];
      if (!r) return;
      if (r.burn) this.applyBurn(r.burn);
      if (r.poison) this.applyPoison(r.poison);
      if (r.slow) this.applySlow(r.slow[0], r.slow[1]);
      if (r.curse) this.curseT = r.curse[0];
      if (r.chill && this.chillCd <= 0 && ++this.chill >= r.chill[0]) {
        this.chill = 0; this.chillCd = 2.5;
        this.freeze(r.chill[1] * (this.chief ? 0.5 : 1), 'frozen', '¡Congelado!', '#9fe8ff');
      }
      if (fx.stun > 0) this.freeze(fx.stun, 'stun', type === 'electric' ? '¡Paralizado!' : '¡Aturdido!', '#ffe14d');
      if (fx.confuse > 0) { this.confuseT = Math.max(this.confuseT, fx.confuse); this.say('¡Confuso!', '#ff8ac4'); note('psychic'); }
      if (fx.push > 0) {
        const b = stepBack(this.x, this.y, this.wp, fx.push, path);
        this.x = b.x; this.y = b.y; this.wp = b.wp;
        note('water');
      }
      if (r.burn || r.poison || r.slow || r.curse) note(type);
    }

    /** Lo deja quieto `dur` segundos (congelado o paralizado). */
    freeze(dur: number, how: 'frozen' | 'stun', text: string, col: string) {
      this.applySlow(1, dur);
      if (how === 'frozen') this.frozenT = dur; else this.stunT = dur;
      this.say(text, col);
      note(how === 'frozen' ? 'ice' : 'stun');
    }
    say(text: string, col: string) {
      if (this.textCd > 0) return;
      this.textCd = 0.8;
      G.FX.dmgText(this.x, this.y - this.bodyH - 18, text, col);
    }

    die() {
      if (this.dead) return;
      super.die();
      const n = killReward(this.wave) * (this.kind === 'legend' ? 20 : this.kind === 'boss' ? 10 : 1);
      // Hada (si es ella quien lo derrota) y Día de Pago (si cae cerca de un Meowth...).
      const fairy = this.lastType === 'fairy' ? ROLES.fairy.bounty || 0 : 0;
      const pay = aurasAt(this.x, this.y, auraSources()).bounty;
      const bonus = Math.ceil(n * (fairy + pay));
      if (fairy) note('fairy');
      if (pay) note('bounty');
      money += n + bonus;
      if (this.chief) {
        G.FX.dmgText(this.x, this.y - this.bodyH - 10, '+' + (n + bonus), '#ffd23f', true);
        G.Spawner.say('¡' + this.name + ' derrotado!', 2.4, true);
      }
    }

    draw(ctx: CanvasRenderingContext2D) {
      super.draw(ctx);
      if (this.dead) return;
      const cy = this.y - this.bodyH * 0.5, top = this.y - this.bodyH - 6;
      ctx.save();
      if (this.frozenT > 0) {
        // Bloque de hielo encima.
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = '#bff3ff'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(this.x, cy, this.r * 1.3, this.bodyH * 0.65, 0, 0, 6.2832); ctx.fill(); ctx.stroke();
      } else if (this.slow > 0.2) {
        ctx.globalAlpha = 0.35; ctx.fillStyle = '#7fe0e0';
        ctx.beginPath(); ctx.ellipse(this.x, this.y, this.r * 1.3, this.r * 0.5, 0, 0, 6.2832); ctx.fill();
      }
      if (this.stunT > 0) {
        // Chispas amarillas dando vueltas sobre la cabeza.
        ctx.globalAlpha = 0.9; ctx.fillStyle = '#ffe14d';
        for (let i = 0; i < 3; i++) { const a = time * 8 + i * 2.1; ctx.fillRect(this.x + Math.cos(a) * 10 - 2, top + Math.sin(a) * 3 - 2, 4, 4); }
      }
      if (this.confuseT > 0) {
        ctx.globalAlpha = 0.9; ctx.strokeStyle = '#ff8ac4'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(this.x, top - 2, 5, time * 6, time * 6 + 4.5); ctx.stroke();
      }
      if (this.curseT > 0) {
        ctx.globalAlpha = 0.3 + Math.sin(time * 5) * 0.08; ctx.fillStyle = '#7a6bc4';
        ctx.beginPath(); ctx.ellipse(this.x, this.y, this.r * 1.5, this.r * 0.6, 0, 0, 6.2832); ctx.fill();
      }
      ctx.restore();
    }
  }

  /** Poderes de tipo que han salido (para las pruebas). */
  function note(k: string) { powers[k] = (powers[k] || 0) + 1; }

  /** Torre que se está colocando: una vista previa que sigue al ratón o al héroe. */
  let placing: { dex: number; preview: any; range: number } | null = null;
  const ghost = { x: 0, y: 0 };
  /** ¿Se ha movido el ratón desde que empezó la colocación? Si no, la torre fantasma va con el héroe. */
  let ghostByPointer = false;
  /** Lo que tiene abierto el panel: una torre, el héroe, o nada. */
  let selected: Tower | 'hero' | null = null;
  /** Torre que ha llegado a un nivel de evolución con varias opciones: espera a que elijas. */
  let pendingEvo: { tower: Tower; options: number[] } | null = null;
  /** Velocidad de cada enemigo (para apuntarle a donde va a estar). */
  const vel = new WeakMap<object, { x: number; y: number; px: number; py: number }>();
  /** Ataques lanzados por cada torre (para las pruebas). */
  const shots = new WeakMap<object, number>();

  const st = { get time() { return time; } };

  // ---------------- tienda y favoritos ----------------

  /** Los Pokémon que puedes comprar: tu colección (sin tu compañero) y, si es corta, iniciales prestados. */
  function candidates(): { dex: number; lent: boolean }[] {
    const save = G.DB.save;
    const owned = Object.keys(save.owned || {}).map(Number).filter(d => G.DEX_BY[d] && d !== save.partner);
    owned.sort((a, b) => a - b);
    const out = owned.map(dex => ({ dex, lent: false }));
    if (out.length < TEAM_MAX) {
      for (const s of G.STARTERS) {
        if (G.DEX_BY[s.dex] && s.dex !== save.partner && !out.some(o => o.dex === s.dex)) out.push({ dex: s.dex, lent: true });
      }
    }
    return out;
  }

  /** Favoritos válidos: Pokémon que se pueden comprar, sin repetir y como mucho TEAM_MAX. */
  function cleanTeam(list: unknown): number[] {
    const ok = new Set(candidates().map(c => c.dex));
    const out: number[] = [];
    if (Array.isArray(list)) for (const d of list) if (ok.has(d as number) && !out.includes(d as number) && out.length < TEAM_MAX) out.push(d as number);
    return out;
  }

  /** El tipo del ataque de un Pokémon (el de su movimiento): decide su poder. */
  function attackType(dex: number): string {
    const m = G.Moves.BY_ID[G.startMoveOf(dex)];
    return (m && m.type) || G.DEX_BY[dex].types[0];
  }
  const typeName = (t: string) => G.U.TYPE_NAME[t] || t;
  const auraChip = (k: AuraKind) => `<i class="td-type" style="background:${AURAS[k].color}">Apoyo</i>`;
  const typeChip = (t: string) => `<i class="td-type" style="background:${G.U.TYPE_COLOR[t] || '#888'}">${typeName(t)}</i>`;

  /** Pantalla de favoritos antes de empezar: salen primero en la tienda. */
  function openTeam() {
    styles();
    const cands = candidates();
    let chosen = cleanTeam(G.DB.save.tdTeam);
    if (!chosen.length) chosen = cands.slice(0, TEAM_MAX).map(c => c.dex);
    const el = document.createElement('section');
    el.className = 'scr dim';
    el.id = 'td-team';
    el.innerHTML = `<div class="box wide" style="max-width:720px;width:100%">
      <div class="row between"><h2>Defensa · tus favoritos</h2><span class="row" style="gap:6px"><button class="btn small ghost" data-a="guide">¿Cómo se juega?</button><button class="btn small ghost" data-a="back">Volver</button></span></div>
      <p class="sub">En la partida puedes comprar cualquier Pokémon de tu colección. Los favoritos (hasta ${TEAM_MAX}) salen primero en la tienda.</p>
      <div class="td-grid"></div>
      <div class="row" style="margin-top:12px;gap:8px"><button class="btn gold grow" data-a="go">Empezar</button></div>
    </div>`;
    document.body.appendChild(el);
    const grid = el.querySelector('.td-grid') as HTMLElement;
    const go = el.querySelector('[data-a=go]') as HTMLButtonElement;
    const paint = () => {
      grid.querySelectorAll<HTMLElement>('.td-pick').forEach(b => b.classList.toggle('on', chosen.includes(+b.dataset.dex)));
      go.textContent = 'Empezar · ' + chosen.length + '/' + TEAM_MAX + ' favoritos';
    };
    for (const c of cands) {
      const mon = G.DEX_BY[c.dex];
      const b = document.createElement('button');
      b.className = 'td-pick';
      b.dataset.dex = String(c.dex);
      const pw = powerOf(c.dex);
      b.title = pw ? pw.name + ': ' + pw.desc : '';
      b.appendChild(G.UI.spriteCanvas(c.dex, 64, 56, { scale: 1 }));
      b.insertAdjacentHTML('beforeend', `<small>${mon.name}</small>${SUPPORT[c.dex] ? auraChip(SUPPORT[c.dex]) : typeChip(attackType(c.dex))}<small class="gold">${towerCost(mon.rarity)}</small>${c.lent ? '<small class="lent">préstamo</small>' : ''}`);
      b.onclick = () => {
        if (chosen.includes(c.dex)) chosen = chosen.filter(d => d !== c.dex);
        else if (chosen.length < TEAM_MAX) chosen.push(c.dex);
        paint();
      };
      grid.appendChild(b);
    }
    paint();
    (el.querySelector('[data-a=back]') as HTMLElement).onclick = () => el.remove();
    (el.querySelector('[data-a=guide]') as HTMLElement).onclick = () => G.GuideUI.open('td');
    go.onclick = () => {
      el.remove();
      G.DB.save.tdTeam = chosen.slice();
      G.DB.commit();
      G.Game.start('td', { team: chosen });
    };
  }

  // ---------------- partida ----------------

  function start(opts: { team?: number[] } | null = null) {
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
    lens = pathLengths(path);
    bound = 20 * TS;
    time = 0; lives = START_LIVES; wave = 0; leaked = 0; downT = 0; won = false; fast = false; cleared = 0; tampered = false;
    money = START_MONEY; heroLevel = 1; reach = 0; hpMul = 1; bossLeft = 0; toSpawn = 0;
    towers = []; placing = null; selected = null; pendingEvo = null; powers = {};
    pool = candidates();
    team = cleanTeam(opts && opts.team);
    if (!opts || !Array.isArray(opts.team)) { if (!team.length) team = cleanTeam(save.tdTeam); }
    shopFilter = team.length ? 'fav' : 'all';
    G.Sprites.preload(team, 4000);
    preloadWave(1);
    listenPointer();

    pl = new G.Player(mon, perks, !!save.partnerShiny && G.DB.ownsShiny(mon.dex));
    pl.addMove(G.startMoveOf(mon.dex));
    G.Camera.x = pl.x; G.Camera.y = pl.y; G.Camera.shake = 0;
    G.Sprites.preload([mon.dex], 8000, pl.shiny);
    G.Audio.music(G.BIOME_MUSIC[0]);

    Run.state = 'playing';
    G.Ranking.runStarted('d');
    phase = 'break'; phaseT = FIRST_BREAK;
    buildUI();
    G.Spawner.say('Compra torres en la tienda y plántalas junto al camino', 4, true);
  }

  function end(dead: boolean) {
    if (Run.state === 'over' || !pl) return;
    Run.state = 'over';
    hideUI();
    G.Audio.music(null);
    G.Audio.sfx(dead ? 'gameover' : won ? 'legend' : 'back');
    // Ranking de Defensa: oleadas superadas y, a igualdad, vidas que quedaban.
    if (!tampered && cleared > 0) {
      G.Ranking.submitDefense({ waves: cleared, lives: Math.max(0, lives), secs: Math.floor(time), kills: pl.kills, dex: pl.dex, shiny: pl.shiny });
    }
    G.RunUI.showOver({
      dead, time, level: pl.level, kills: pl.kills, bosses: 0, coins: 0, record: false, t1: 0, t10: 0, judge: null,
      moves: pl.moves, caught: [],
      breakdown: 'La Defensa todavía no da recompensas de cuenta'
    }, () => { pl = null; towers = []; G.EnemyMgr.clear(); G.Flow.afterRun(); });
    document.getElementById('over-title').textContent =
      dead ? 'La base ha caído · oleada ' + wave : won ? '¡Victoria! · las ' + LAST_WAVE + ' oleadas' : 'Defensa terminada · oleada ' + wave;
  }

  function everyone() { return [pl]; }

  // ---------------- oleadas ----------------

  /** Carga antes de tiempo los sprites de la oleada n (si no, salen tarde). */
  function preloadWave(n: number) {
    if (n > LAST_WAVE) return;
    const w = waveAt(n);
    G.Sprites.preload(w.boss ? [...w.pool, w.boss] : w.pool, 4000);
  }

  function startWave() {
    wave++;
    const w = waveAt(wave);
    toSpawn = waveCount(wave); spawnT = 0; reach = 0;
    bossLeft = w.boss ? 1 : 0;
    phase = 'wave';
    G.Audio.sfx('biome');
    G.Spawner.say('Oleada ' + wave + ' · ' + w.theme, 3, true);
    preloadWave(wave + 1);
  }

  /** "Siguiente oleada" antes de tiempo: más monedas cuanto antes. */
  function callWave() {
    if (phase !== 'break' || Run.state !== 'playing') return;
    if (wave > 0) earn(Math.max(0, Math.floor(phaseT)) * 2, pl.x, pl.y - 40);
    startWave();
  }

  /** Saca un enemigo de la oleada (los normales primero; el jefe, al final). */
  function spawnEnemy(chief: boolean) {
    const w = waveAt(wave);
    const dex = chief ? w.boss! : w.pool[Math.floor(Math.random() * w.pool.length)];
    const mon = G.DEX_BY[dex];
    const kind = !chief ? 'normal' : w.legend ? 'legend' : 'boss';
    // Vida y velocidad: la curva de la oleada, ajustadas un poco con los stats del Pokémon.
    const hpK = G.U.clamp(mon.hp / 95, 0.85, 1.25), spdK = G.U.clamp(mon.spd / 105, 0.85, 1.2);
    let hp = waveHp(wave) * hpK * hpMul, spd = WALK * (1 + wave * 0.025) * spdK;
    if (chief) { hp *= bossHpMul(kind === 'legend'); spd *= 0.7; }
    const def = { dex, name: mon.name, behavior: 'chase' as const, hp: Math.round(hp), spd, dmg: 10, xp: 3 + Math.floor(wave / 2) };
    const e = new Walker(def, path[0].x + G.U.rand(-10, 10), path[0].y + G.U.rand(-10, 10), { hp: 1, spd: 1, dmg: 1 });
    e.kind = kind;
    e.wave = wave;
    if (chief) {
      // Más grande, para que se vea que es el jefe.
      const s = kind === 'legend' ? 1.9 : 1.55;
      e.scale = s;
      e.anim = new G.Sprites.Animator(dex, s);
      e.r = G.Sprites.bodyRadius(dex, s);
      e.bodyH = G.Sprites.bodyHeight(dex, s);
      G.Spawner.say('¡Llega ' + mon.name + '!', 2.6, true);
      G.Audio.sfx('legend');
    }
    G.EnemyMgr.add(e);
  }

  /** Avanza a cada enemigo por el camino; el que llega a la base te quita vidas. */
  function march() {
    const list = G.EnemyMgr.all();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.dead || !(e instanceof Walker)) continue;
      reach = Math.max(reach, pathProgress(e.x, e.y, e.wp, path, lens) / lens[lens.length - 1]);
      const to = path[e.wp];
      if (G.U.dist2(e.x, e.y, to.x, to.y) > 18 * 18) continue;
      if (e.wp + 1 < path.length) { e.wp++; continue; }
      // Ha llegado a la base: fuera, sin botín ni animación.
      list.splice(i, 1);
      lives -= leakCost(e.kind === 'boss', e.kind === 'legend'); leaked++;
      G.FX.burst(e.x, e.y - 10, '#ff5f6d', 14, 160);
      G.Camera.kick(0.5);
      G.Audio.sfx('hurt');
      if (e.chief) G.Spawner.say(e.name + ' ha llegado a la base', 2.4, true);
    }
  }

  function tickPhase(dt: number) {
    if (phase === 'wave') {
      if (toSpawn > 0 || bossLeft > 0) {
        spawnT -= dt;
        if (spawnT <= 0) {
          if (toSpawn > 0) { spawnEnemy(false); toSpawn--; spawnT = toSpawn > 0 ? waveGap(wave) : 2; }
          else { spawnEnemy(true); bossLeft = 0; }
        }
      } else if (!G.EnemyMgr.all().some(e => !e.dead)) {
        earn(waveBonus(wave), pl.x, pl.y - 40);
        cleared = wave;
        if (wave >= LAST_WAVE) { won = true; G.Spawner.say('¡Has defendido la base!', 3, true); end(false); return; }
        G.Spawner.say('¡Oleada ' + wave + ' superada!', 2.2, true);
        phase = 'break'; phaseT = BREAK;
      }
    } else if ((phaseT -= dt) <= 0) startWave();
  }

  // ---------------- monedas ----------------

  function earn(n: number, x: number, y: number) {
    if (!(n > 0)) return;
    money += n;
    G.FX.dmgText(x, y, '+' + n, '#ffd23f');
  }
  function pay(n: number) {
    if (!(n >= 0) || money < n) return false;
    money -= n;
    return true;
  }

  // ---------------- torres ----------------

  /** Un Pokémon como torre (un G.Player que no lee el mando: sólo apunta y ataca). */
  function makeTower(dex: number) {
    const t = new G.Player(G.DEX_BY[dex], {}, G.DB.ownsShiny(dex));
    t.frozen = true;
    t.addMove(G.startMoveOf(dex));
    return t;
  }
  const costOf = (dex: number) => towerCost(G.DEX_BY[dex].rarity);
  const inPool = (dex: number) => pool.some(c => c.dex === dex);

  /** Empieza a colocar una torre de la tienda (si te llega el dinero): sale una vista previa con su alcance. */
  function startPlacing(dex: number) {
    if (!inPool(dex) || Run.state !== 'playing') return;
    if (placing && placing.dex === dex) { cancelPlacing(); return; }      // pulsarla otra vez la suelta
    if (money < costOf(dex)) { G.Spawner.say('Te faltan monedas', 1.4, true); G.Audio.sfx('back'); return; }
    const preview = makeTower(dex);
    placing = { dex, preview, range: SUPPORT[dex] ? auraRadius(1) : rangeOf(preview) };
    selected = null; pendingEvo = null;
    ghostByPointer = false;
    ghost.x = pl.x; ghost.y = pl.y;
    G.Sprites.preload([dex], 4000, preview.shiny);
    refreshUI();
  }
  function cancelPlacing() { placing = null; refreshUI(); }

  /** Motivo por el que no se puede plantar en (x, y), o '' si se puede. */
  const whyNot = (x: number, y: number) => placementError(x, y, { path, towers: towers.map(t => t.p), bound });

  /** Intenta plantar la torre que se está colocando en (x, y). */
  function tryPlace(x: number, y: number) {
    if (!placing || Run.state !== 'playing') return;
    const err = whyNot(x, y);
    if (err) { G.Spawner.say(err, 1.6, true); G.Audio.sfx('back'); return; }
    const dex = placing.dex, cost = costOf(dex);
    if (!pay(cost)) { G.Spawner.say('Te faltan monedas', 1.4, true); cancelPlacing(); return; }
    placing = null;
    const p = makeTower(dex);
    p.x = x; p.y = y;
    const t: Tower = { p, dex, level: 1, base: cost, spent: cost, mode: 'first', atk: p.atkMul, buff: noBuff() };
    towers.push(t);
    G.FX.ring(x, y, 8, 110, G.U.TYPE_COLOR[G.DEX_BY[dex].types[0]], 0.6, 5);
    G.Audio.sfx('confirm');
    selected = t;                 // queda seleccionada: se ve su alcance y cómo mejorarla
    refreshUI();
  }

  /** Sube un nivel la torre: más ataque y, en los niveles de evolución, evoluciona. */
  function upgrade(t: Tower) {
    const c = upgradeCost(t.base, t.level);
    if (c == null || pendingEvo || !pay(c)) return;
    t.spent += c;
    t.level++;
    levelMove(t.p);
    t.atk *= 1.12;
    G.FX.ring(t.p.x, t.p.y, 8, 90, G.U.TYPE_COLOR[G.DEX_BY[t.dex].types[0]], 0.6, 5);
    G.Audio.sfx('levelup');
    if (evolvesAt(t.level)) {
      const options = evolutionsOf(t.dex);
      if (options.length === 1) evolve(t, options[0]);
      else if (options.length > 1) pendingEvo = { tower: t, options };
    }
    refreshUI();
  }

  /** Sube un nivel el movimiento activo (hasta el 5) y un poco el ataque. */
  function levelMove(p) {
    const m = p.activeMove();
    if (m && m.lvl < 5) G.Moves.levelUp(m);
    p.atkMul *= 1.12;
  }

  /** En qué puede evolucionar `dex` (datos de data/evolutions; sólo los que tienen sprite). */
  function evolutionsOf(dex: number): number[] {
    const E = G.EVOLUTIONS as Record<number, number[]> | undefined;
    return ((E && E[dex]) || []).filter(d => G.DEX_BY[d]);
  }

  /** La torre pasa a ser `to`, con su nivel, su posición y lo gastado. */
  function evolve(t: Tower, to: number) {
    const from = G.DEX_BY[t.dex].name;
    const old = t.p;
    const p = makeTower(to);
    p.x = old.x; p.y = old.y;
    p.atkMul = old.atkMul;
    for (let l = 1; l < t.level; l++) { const m = p.activeMove(); if (m && m.lvl < 5) G.Moves.levelUp(m); }
    G.Projectiles.clearOrbs(old);
    t.p = p; t.dex = to;
    pendingEvo = null;
    G.Sprites.preload([to], 4000, p.shiny);
    G.FX.ring(p.x, p.y, 10, 140, '#ffffff', 0.8, 6);
    G.FX.burst(p.x, p.y - 20, '#ffffff', 30, 200);
    G.Audio.sfx('legend');
    G.Spawner.say('¡' + from + ' ha evolucionado a ' + G.DEX_BY[to].name + '!', 2.8, true);
    refreshUI();
  }

  function sell(t: Tower) {
    const i = towers.indexOf(t);
    if (i < 0 || (pendingEvo && pendingEvo.tower === t)) return;
    towers.splice(i, 1);
    earn(sellValue(t.spent), t.p.x, t.p.y - 30);
    G.Projectiles.clearOrbs(t.p);
    if (selected === t) selected = null;
    G.Audio.sfx('coin');
    refreshUI();
  }

  function cycleMode(t: Tower) {
    t.mode = TARGET_MODES[(TARGET_MODES.indexOf(t.mode) + 1) % TARGET_MODES.length];
    G.Audio.sfx('confirm');
    refreshUI();
  }

  /** Mejora del ataque del héroe con monedas (su movimiento activo sube de nivel). */
  const HERO_BASE = 100;
  function upgradeHero() {
    const c = upgradeCost(HERO_BASE, heroLevel);
    if (c == null || !pay(c)) return;
    heroLevel++;
    levelMove(pl);
    G.FX.ring(pl.x, pl.y, 8, 90, '#ffd23f', 0.6, 5);
    G.Audio.sfx('levelup');
    refreshUI();
  }

  // ---------------- puntero ----------------

  let listening = false;
  /** Del punto de la pantalla al del mundo. */
  function toWorld(e: PointerEvent) {
    const r = (e.target as HTMLElement).getBoundingClientRect();
    return { x: G.Camera.left() + (e.clientX - r.left) / G.Camera.scale, y: G.Camera.top() + (e.clientY - r.top) / G.Camera.scale };
  }
  /** Lo que hay bajo (x, y): una torre, el héroe o nada. */
  function pickAt(x: number, y: number): Tower | 'hero' | null {
    let best: Tower | null = null, bd = 30 * 30;
    for (const t of towers) { const d = G.U.dist2(t.p.x, t.p.y - 12, x, y); if (d < bd) { bd = d; best = t; } }
    if (best) return best;
    return pl && G.U.dist2(pl.x, pl.y - 12, x, y) < 30 * 30 ? 'hero' : null;
  }
  function listenPointer() {
    if (listening) return;
    const cv = document.getElementById('game');
    if (!cv) return;
    listening = true;
    let down: { id: number; x: number; y: number; t: number; button: number } | null = null;
    cv.addEventListener('pointermove', e => {
      if (!placing || Run.mode !== TD) return;
      // Con el dedo, mover es usar el joystick: la torre fantasma sólo sigue al ratón.
      if (e.pointerType !== 'mouse') return;
      const p = toWorld(e); ghost.x = p.x; ghost.y = p.y; ghostByPointer = true;
    });
    cv.addEventListener('contextmenu', e => { if (Run.mode === TD && Run.state === 'playing') e.preventDefault(); });
    cv.addEventListener('pointerdown', e => { down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), button: e.button }; });
    cv.addEventListener('pointerup', e => {
      const d = down; down = null;
      if (Run.mode !== TD || Run.state !== 'playing' || !d || d.id !== e.pointerId) return;
      // Un toque o clic corto y sin arrastrar; arrastrar es mover al héroe.
      if (performance.now() - d.t > 350 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 14) return;
      const p = toWorld(e);
      if (placing) {
        if (d.button === 2) { cancelPlacing(); return; }                      // clic derecho: la suelta
        ghost.x = p.x; ghost.y = p.y; ghostByPointer = true;
        tryPlace(p.x, p.y);
        return;
      }
      if (pendingEvo) return;                                                  // primero, elegir la evolución
      selected = pickAt(p.x, p.y);
      refreshUI();
    });
  }

  // ---------------- apuntar ----------------

  /**
   * El héroe y las torres disparan a donde VA a estar su blanco (los enemigos del
   * camino son rápidos: apuntando a donde están, casi todo fallaba).
   */
  function trackEnemies(dt: number) {
    if (!(dt > 0)) return;
    for (const e of G.EnemyMgr.all()) {
      const v = vel.get(e);
      if (!v) { vel.set(e, { x: 0, y: 0, px: e.x, py: e.y }); continue; }
      const k = Math.min(1, dt * 12);
      v.x += ((e.x - v.px) / dt - v.x) * k; v.y += ((e.y - v.py) / dt - v.y) * k;
      v.px = e.x; v.py = e.y;
    }
  }
  /**
   * Hasta dónde ataca un Pokémon: el de su movimiento activo, con el tope de las
   * torres. Vista Lince sube el tope, pero nunca más allá de lo que llega su ataque.
   */
  function rangeOf(p) {
    const m = p.activeMove();
    return m ? Math.min(RANGE_MAX * (1 + (p.tdRange || 0)), moveRange(m)) : 0;
  }

  // ---------------- auras ----------------

  const noBuff = (): AuraTotals => ({ dmg: 0, haste: 0, crit: 0, bounty: 0, range: 0 });
  const isSupport = (t: Tower) => !!SUPPORT[t.dex];
  function auraSources() {
    const out: { x: number; y: number; kind: AuraKind; level: number }[] = [];
    for (const t of towers) { const k = SUPPORT[t.dex]; if (k) out.push({ x: t.p.x, y: t.p.y, kind: k, level: t.level }); }
    return out;
  }
  /** Cada torre recibe las auras de los apoyos que la alcanzan: más ataque, recarga, crítico y alcance. */
  function applyAuras() {
    const src = auraSources();
    for (const t of towers) {
      if (isSupport(t)) { t.buff = noBuff(); continue; }
      t.buff = src.length ? aurasAt(t.p.x, t.p.y, src) : noBuff();
      t.buff.bounty = 0;                          // Día de Pago va por dónde cae el enemigo, no por la torre
      t.p.atkMul = t.atk * (1 + t.buff.dmg);
      t.p.cdMul = 1 / (1 + t.buff.haste);
      t.p.critChance = t.buff.crit;
      t.p.tdRange = t.buff.range;
    }
  }
  /**
   * Foco Energía en los proyectiles: el combate decide sus críticos con el héroe
   * (no con quien los lanza), así que aquí se tira por cada disparo nuevo de una
   * torre con crítico (los golpes directos ya lo hacen con su critChance).
   */
  const rolled = new WeakSet<object>();
  function critShots() {
    for (const pr of G.Projectiles.all()) {
      if (rolled.has(pr)) continue;
      rolled.add(pr);
      const c = pr.owner && pr.owner !== pl ? pr.owner.critChance || 0 : 0;
      if (c > 0 && !pr.orb && Math.random() < c) { pr.dmg *= 1.5; note('crit'); }
    }
  }
  /** Lo que da el aura de un apoyo, en palabras. */
  function auraText(kind: AuraKind, level: number) {
    return '+' + Math.round(auraStrength(kind, level) * 100) + '% ' + AURAS[kind].what;
  }
  /** El poder de un Pokémon en la tienda o el panel: su aura si es de apoyo, o el de su tipo. */
  function powerOf(dex: number, level = 1): { name: string; desc: string } | null {
    const k = SUPPORT[dex];
    if (k) return { name: AURAS[k].move, desc: 'Apoyo: no ataca; ' + auraText(k, level) + ' a las torres cercanas' };
    return ROLES[attackType(dex)] || null;
  }
  /** El blanco de una torre entre los vivos a su alcance, según su modo; o null. */
  function targetFor(p, mode: TargetMode) {
    const r = rangeOf(p);
    const inRange: any[] = [], cands: { d2: number; progress: number; hp: number }[] = [];
    for (const e of G.EnemyMgr.all()) {
      if (e.dead) continue;
      const d2 = G.U.dist2(e.x, e.y, p.x, p.y), reach = r + (e.r || 0);
      if (d2 > reach * reach) continue;
      inRange.push(e);
      cands.push({ d2, hp: e.hp, progress: e instanceof Walker ? pathProgress(e.x, e.y, e.wp, path, lens) : 0 });
    }
    const i = pickTarget(cands, mode);
    return i < 0 ? null : inRange[i];
  }
  /** El alcance en palabras. */
  const reachWord = (r: number) => r <= 130 ? 'corto' : r <= 300 ? 'medio' : 'largo';

  const LEADS = new Set(['projectile', 'boomerang', 'cone']);
  function aimAhead(p) {
    const m = p.activeMove(), tg = p.target;
    if (!m || !tg || !LEADS.has(m.kind) || !(m.speed > 0)) return;
    const v = vel.get(tg);
    if (!v) return;
    p.aim = leadAngle(p.x, p.y, tg.x, tg.y, v.x, v.y, m.speed);
  }

  // ---------------- recogida ----------------

  function onCollect(p, who = pl) {
    if (p.kind === 'xp' || p.kind === 'xpBig') { G.Audio.sfx('xp'); pl.gainXp(p.value); return; }
    if (p.kind === 'coin') { G.Audio.sfx('coin'); earn(p.value, who.x, who.y - who.bodyH - 6); return; }
    if (p.kind === 'heal') {
      G.Audio.sfx('heal');
      pl.heal(pl.maxHp * 0.3);
      G.FX.ring(who.x, who.y, 6, 60, '#5fe08a', 0.4, 3);
    }
  }

  // ---------------- bucle ----------------

  let shownMoney = -1;
  function update(dt: number) {
    // ×2: dos pasos por fotograma.
    const n = fast ? 2 : 1;
    for (let i = 0; i < n && Run.state === 'playing'; i++) step(dt);
    if (money !== shownMoney) refreshUI();
  }

  function step(dt: number) {
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
    if (Run.state !== 'playing') return;
    G.Spawner.tickBanner(dt);
    G.EnemyMgr.update(dt, [pl]);
    G.EnemyMgr.rebuildGrid();
    march();
    trackEnemies(dt);
    if (placing && !ghostByPointer) { ghost.x = pl.x; ghost.y = pl.y; }

    aimAhead(pl);
    G.Combat.tick(dt, pl, time);
    applyAuras();
    for (const t of towers) {
      const p = t.p;
      p.update(dt);
      if (isSupport(t)) continue;                 // los de apoyo no atacan
      // Sólo apunta a enemigos a su alcance (la lógica del héroe buscaba hasta 520
      // de distancia, y rocas o hierba si no había nadie), y elige según su modo.
      const tg = targetFor(p, t.mode);
      p.target = tg;
      if (tg) p.aim = Math.atan2(tg.y - p.y, tg.x - p.x);
      aimAhead(p);
      const m = p.activeMove(), was = m && m.castAt;
      // Sin nadie a su alcance no ataca (las de área se lanzaban solas). Las órbitas sí: giran siempre.
      if (tg || (m && m.kind === 'orbit')) G.Combat.tick(dt, p, time);
      if (m && m.castAt !== was) shots.set(p, (shots.get(p) || 0) + 1);
    }
    critShots();
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

  /** Esc mientras colocas: suelta la torre (en vez de pausar). */
  function keysModal() {
    if (placing && Run.state === 'playing' && G.Input.tap('escape')) { cancelPlacing(); return true; }
    return false;
  }

  function keysPlay() {
    if (placing && (G.Input.tap('enter') || G.Input.tap('space') || G.Input.tap('numpadenter'))) tryPlace(ghost.x, ghost.y);
    if (G.Input.tap('keyn')) callWave();
    if (G.Input.tap('keyf')) toggleFast();
    for (let i = 0; i < 4; i++) {
      if (G.Input.tap('digit' + (i + 1)) || G.Input.tap('numpad' + (i + 1))) pl.setActive(i);
    }
    if (G.Input.tap('keyq')) pl.cycle(-1);
    if (G.Input.tap('keye') || G.Input.tap('tab')) pl.cycle(1);
  }

  function toggleFast() { fast = !fast; G.Audio.sfx('confirm'); hudKey = ''; }

  // ---------------- interfaz ----------------
  // Arriba: oleada, vidas y monedas. Izquierda: la tienda. Derecha: la torre
  // seleccionada. Abajo: qué se está colocando y por qué no se puede ahí.

  let hud: HTMLElement | null = null, shop: HTMLElement | null = null, panel: HTMLElement | null = null, tip: HTMLElement | null = null;
  /** Qué enseña la tienda: favoritos, todos, o un tipo. */
  let shopFilter = 'fav';
  let shopOpen = true;

  function styles() {
    if (document.getElementById('td-style')) return;
    const s = document.createElement('style');
    s.id = 'td-style';
    s.textContent = `
      #td-hud { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 30; display: flex; align-items: center; gap: 10px;
                padding: 6px 10px; max-width: calc(100vw - 16px); flex-wrap: wrap; justify-content: center; }
      #td-hud .td-stat { display: flex; flex-direction: column; align-items: center; line-height: 1.05; min-width: 54px; }
      #td-hud .td-stat b { font-size: 22px; }
      #td-hud .td-stat small { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
      #td-hud .td-money b { color: var(--gold); }
      #td-hud .td-money.bump b { animation: td-bump .35s; }
      #td-hud .td-lives.low b { color: #ff5f6d; }
      #td-hud .td-wave { max-width: 260px; text-align: center; line-height: 1.15; }
      #td-hud .td-wave b { display: block; font-size: 15px; }
      #td-hud .td-wave small { color: var(--muted); font-size: 12px; }
      @keyframes td-bump { 0% { transform: scale(1); } 40% { transform: scale(1.35); } 100% { transform: scale(1); } }
      #td-shop { position: fixed; left: 8px; top: 96px; z-index: 30; width: 214px; padding: 8px; display: flex; flex-direction: column; gap: 6px; max-height: calc(100vh - 150px); }
      #td-shop h3 { margin: 0; font-size: 16px; display: flex; justify-content: space-between; align-items: center; }
      #td-shop .td-filters { display: flex; flex-wrap: wrap; gap: 4px; }
      #td-shop .td-filters button, #td-shop select { font: inherit; font-size: 12px; padding: 2px 6px; border-radius: 6px; background: rgba(10,20,48,.6);
                color: inherit; border: 1px solid rgba(244,248,255,.25); cursor: pointer; }
      #td-shop .td-filters button.on { border-color: var(--gold); color: var(--gold); }
      #td-shop .td-list { overflow-y: auto; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
      #td-shop.closed .td-list, #td-shop.closed .td-filters { display: none; }
      .td-slot { display: flex; align-items: center; gap: 6px; padding: 3px 6px 3px 3px; text-align: left; width: 100%; }
      .td-slot.on { outline: 3px solid var(--gold); }
      .td-slot canvas { width: 40px; height: 35px; image-rendering: pixelated; flex: none; }
      .td-slot span { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.15; font-size: 13px; min-width: 0; }
      .td-slot span b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 130px; }
      .td-slot .td-cost { color: var(--gold); font-weight: 700; }
      .td-type { display: inline-block; font-style: normal; font-size: 10px; padding: 0 5px; border-radius: 6px; color: #10131c; font-weight: 700; line-height: 15px; }
      #td-shop .td-more { font-size: 12px; color: var(--muted); text-align: center; }
      #td-panel { position: fixed; right: 8px; top: 96px; z-index: 30; width: min(270px, 46vw); padding: 12px; }
      #td-panel h3 { margin: 0 0 4px; }
      #td-panel p { margin: 3px 0; font-size: 14px; color: var(--muted); }
      #td-panel p.role { color: inherit; }
      #td-panel .btn { width: 100%; margin-top: 6px; }
      #td-tip { position: fixed; bottom: 96px; left: 50%; transform: translateX(-50%); z-index: 30; padding: 8px 12px; display: flex; gap: 10px;
                align-items: center; max-width: calc(100vw - 16px); flex-wrap: wrap; justify-content: center; font-size: 14px; }
      #td-tip .bad { color: #ff7d88; font-weight: 700; }
      #td-tip .good { color: #7ff0a6; font-weight: 700; }
      .td-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; max-height: 52vh; overflow: auto; padding: 4px; }
      .td-pick { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px; border-radius: 10px;
                 background: rgba(10, 20, 48, .6); border: 2px solid rgba(244, 248, 255, .2); color: inherit; font: inherit; cursor: pointer; }
      .td-pick.on { border-color: var(--gold); background: rgba(255, 210, 63, .15); }
      .td-pick canvas { image-rendering: pixelated; }
      .td-pick .lent { color: var(--muted); font-size: 11px; }
      @media (max-width: 720px) {
        #td-shop { width: 168px; top: 120px; }
        .td-slot span b { max-width: 96px; }
        #td-hud { gap: 6px; }
        #td-hud .td-wave { max-width: 160px; }
        #td-panel { top: 120px; }
      }
    `;
    document.head.appendChild(s);
  }

  function buildUI() {
    styles();
    hideUI();
    hud = document.createElement('div');
    hud.id = 'td-hud';
    hud.className = 'box';
    hud.innerHTML = `<div class="td-stat td-lives"><b data-k="lives"></b><small>Vidas</small></div>
      <div class="td-stat td-money"><b data-k="money"></b><small>Monedas</small></div>
      <div class="td-wave"><b data-k="wave"></b><small data-k="hint"></small></div>
      <button class="btn small gold" data-a="next"></button>
      <button class="btn small" data-a="fast" title="Velocidad (F)"></button>`;
    (hud.querySelector('[data-a=next]') as HTMLElement).onclick = () => callWave();
    (hud.querySelector('[data-a=fast]') as HTMLElement).onclick = () => toggleFast();

    shop = document.createElement('div');
    shop.id = 'td-shop';
    shop.className = 'box' + (shopOpen ? '' : ' closed');
    shop.innerHTML = `<h3>Tienda <button class="btn small ghost" data-a="toggle"></button></h3>
      <div class="td-filters"></div><div class="td-list"></div>`;
    (shop.querySelector('[data-a=toggle]') as HTMLElement).onclick = () => {
      shopOpen = !shopOpen;
      shop!.classList.toggle('closed', !shopOpen);
      paintToggle();
    };
    paintToggle();

    panel = document.createElement('div');
    panel.id = 'td-panel';
    panel.className = 'box';
    tip = document.createElement('div');
    tip.id = 'td-tip';
    tip.className = 'box';
    for (const el of [hud, shop, panel, tip]) {
      // Lo que se pulsa en la interfaz no llega al mapa.
      el.addEventListener('pointerdown', e => e.stopPropagation());
      document.body.appendChild(el);
    }
    buildShop();
    hudKey = '';
    refreshUI();
  }
  function paintToggle() {
    const b = shop && shop.querySelector('[data-a=toggle]');
    if (b) b.textContent = shopOpen ? 'Ocultar' : 'Abrir';
  }

  /** Rellena la tienda según el filtro (se rehace sólo al cambiar el filtro). */
  function buildShop() {
    if (!shop) return;
    const filters = shop.querySelector('.td-filters') as HTMLElement;
    const list = shop.querySelector('.td-list') as HTMLElement;
    const types = [...new Set(pool.map(c => attackType(c.dex)))].sort((a, b) => typeName(a).localeCompare(typeName(b)));
    filters.innerHTML = `${team.length ? '<button data-f="fav">Favoritos</button>' : ''}<button data-f="all">Todos</button>
      <select aria-label="Filtrar por tipo"><option value="">Tipo…</option><option value="support">Apoyo</option>${types.map(t => `<option value="${t}">${typeName(t)}</option>`).join('')}</select>`;
    filters.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
      b.classList.toggle('on', b.dataset.f === shopFilter);
      b.onclick = () => { shopFilter = b.dataset.f!; buildShop(); };
    });
    const sel = filters.querySelector('select') as HTMLSelectElement;
    if (types.includes(shopFilter) || shopFilter === 'support') sel.value = shopFilter;
    sel.onchange = () => { shopFilter = sel.value || 'all'; buildShop(); };

    const fav = (d: number) => team.indexOf(d);
    let items = shopFilter === 'fav' ? team.map(dex => ({ dex, lent: false }))
              : shopFilter === 'all' ? pool.slice()
              : shopFilter === 'support' ? pool.filter(c => SUPPORT[c.dex])
              : pool.filter(c => attackType(c.dex) === shopFilter);
    // Favoritos primero; luego, de más barato a más caro.
    items.sort((a, b) => (fav(a.dex) < 0 ? 99 : fav(a.dex)) - (fav(b.dex) < 0 ? 99 : fav(b.dex)) || costOf(a.dex) - costOf(b.dex) || a.dex - b.dex);
    const more = items.length - SHOP_MAX;
    items = items.slice(0, SHOP_MAX);
    list.innerHTML = '';
    for (const c of items) {
      const mon = G.DEX_BY[c.dex], t = attackType(c.dex), r = powerOf(c.dex), k = SUPPORT[c.dex];
      const b = document.createElement('button');
      b.className = 'btn small td-slot';
      b.dataset.dex = String(c.dex);
      b.title = mon.name + (r ? ' · ' + r.name + ': ' + r.desc : '');
      b.appendChild(G.UI.spriteCanvas(c.dex, 40, 35, { scale: 1 }));
      b.insertAdjacentHTML('beforeend', `<span><b>${mon.name}</b><em style="font-style:normal">${k ? auraChip(k) : typeChip(t)} <span class="td-cost" style="display:inline">${costOf(c.dex)}</span></em></span>`);
      b.onclick = e => { e.stopPropagation(); startPlacing(c.dex); };
      list.appendChild(b);
    }
    if (more > 0) list.insertAdjacentHTML('beforeend', `<p class="td-more">y ${more} más: filtra por tipo</p>`);
    refreshUI();
  }

  function hideUI() {
    for (const id of ['td-hud', 'td-shop', 'td-panel', 'td-tip', 'td-bar']) { const el = document.getElementById(id); if (el) el.remove(); }
    hud = shop = panel = tip = null;
  }

  /** Vuelve a pintar la tienda (qué se puede pagar), el panel y el marcador de monedas. */
  function refreshUI() {
    const gained = shownMoney >= 0 && money > shownMoney;
    shownMoney = money;
    if (!shop || !panel || !hud) return;
    const mEl = hud.querySelector('[data-k=money]') as HTMLElement;
    mEl.textContent = String(money);
    if (gained) { const box = mEl.parentElement!; box.classList.remove('bump'); void box.offsetWidth; box.classList.add('bump'); }
    shop.querySelectorAll<HTMLButtonElement>('.td-slot').forEach(b => {
      const dex = +b.dataset.dex;
      b.disabled = money < costOf(dex) && !(placing && placing.dex === dex);
      b.classList.toggle('on', !!placing && placing.dex === dex);
    });
    paintPanel();
    tipKey = '-';                 // se repinta el aviso de abajo en el próximo fotograma
  }

  /** Panel de la derecha: elegir evolución > torre seleccionada > héroe > nada. */
  function paintPanel() {
    if (!panel) return;
    if (pendingEvo) {
      const t = pendingEvo.tower;
      panel.style.display = '';
      panel.innerHTML = `<h3>${G.DEX_BY[t.dex].name} va a evolucionar</h3><p>Elige en qué:</p>`;
      for (const d of pendingEvo.options) {
        const b = document.createElement('button');
        b.className = 'btn small gold';
        const r = powerOf(d, t.level);
        b.innerHTML = `${G.DEX_BY[d].name} ${SUPPORT[d] ? auraChip(SUPPORT[d]) : typeChip(attackType(d))}${r ? ' · ' + r.name : ''}`;
        b.onclick = () => evolve(t, d);
        panel.appendChild(b);
      }
      return;
    }
    if (selected && selected !== 'hero' && !towers.includes(selected)) selected = null;
    if (!selected) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
    panel.style.display = '';
    if (selected === 'hero') {
      const c = upgradeCost(HERO_BASE, heroLevel);
      const m = pl.activeMove();
      panel.innerHTML = `<h3>${G.DEX_BY[pl.dex].name} (tú)</h3>
        <p>Ataque: nivel ${heroLevel}/${MAX_LEVEL}${m ? ' · ' + m.name : ''}</p>
        <button class="btn small gold" data-a="up"${c == null || money < c ? ' disabled' : ''}>${c == null ? 'Al máximo' : 'Mejorar ataque · ' + c}</button>
        <button class="btn small ghost" data-a="close">Cerrar</button>`;
      (panel.querySelector('[data-a=up]') as HTMLElement).onclick = () => upgradeHero();
    } else {
      const t = selected;
      const c = upgradeCost(t.base, t.level);
      const m = t.p.activeMove();
      const at = attackType(t.dex), r = powerOf(t.dex, t.level), k = SUPPORT[t.dex];
      const evo = evolutionsOf(t.dex);
      const nextEvo = evo.length && t.level < MAX_LEVEL && evolvesAt(t.level + 1);
      // Las auras que recibe, en palabras.
      const got = AURA_KINDS.filter(a => t.buff[a] > 0).map(a => '+' + Math.round(t.buff[a] * 100) + '% ' + AURAS[a].what);
      panel.innerHTML = `<h3>${G.DEX_BY[t.dex].name}</h3>
        <p>${k ? auraChip(k) : typeChip(at)} Nivel ${t.level}/${MAX_LEVEL}${k ? ' · radio ' + auraRadius(t.level) : (m ? ' · ' + m.name : '') + ' · alcance ' + reachWord(rangeOf(t.p))}</p>
        ${r ? `<p class="role"><b>${r.name}:</b> ${r.desc}</p>` : ''}
        ${k && t.level < MAX_LEVEL ? `<p>Al mejorarlo: ${auraText(k, t.level + 1)}</p>` : ''}
        ${got.length ? `<p class="role" style="color:var(--gold)">Reforzada: ${got.join(', ')}</p>` : ''}
        ${nextEvo ? `<p class="gold">La próxima mejora lo hace evolucionar${evo.length > 1 ? ' (eliges en qué)' : ' a ' + G.DEX_BY[evo[0]].name}</p>` : ''}
        <button class="btn small gold" data-a="up"${c == null || money < c ? ' disabled' : ''}>${c == null ? 'Al máximo' : 'Mejorar · ' + c}</button>
        ${k ? '' : `<button class="btn small" data-a="mode">Ataca a: ${TARGET_NAME[t.mode]}</button>`}
        <button class="btn small" data-a="sell">Vender · +${sellValue(t.spent)}</button>
        <button class="btn small ghost" data-a="close">Cerrar</button>`;
      (panel.querySelector('[data-a=up]') as HTMLElement).onclick = () => upgrade(t);
      if (!k) (panel.querySelector('[data-a=mode]') as HTMLElement).onclick = () => cycleMode(t);
      (panel.querySelector('[data-a=sell]') as HTMLElement).onclick = () => sell(t);
    }
    (panel.querySelector('[data-a=close]') as HTMLElement).onclick = () => { selected = null; refreshUI(); };
  }

  /** Marcador y aviso de abajo: se repintan sólo si cambia lo que dicen. */
  let hudKey = '', tipKey = '';
  function paintHud() {
    if (!hud || !tip) return;
    const left = toSpawn + bossLeft + G.EnemyMgr.all().filter(e => !e.dead).length;
    const next = waveAt(wave + 1), cur = waveAt(Math.max(1, wave));
    const title = phase === 'wave' ? `Oleada ${wave}/${LAST_WAVE} · ${cur.theme}` : `Oleada ${wave + 1}/${LAST_WAVE} en ${Math.max(1, Math.ceil(phaseT))} s · ${next.theme}`;
    const hint = phase === 'wave' ? `Quedan ${left} · ${cur.hint}` : next.hint;
    const key = [lives, title, hint, phase, wave, fast].join('|');
    if (key !== hudKey) {
      hudKey = key;
      (hud.querySelector('[data-k=lives]') as HTMLElement).textContent = String(Math.max(0, lives));
      (hud.querySelector('.td-lives') as HTMLElement).classList.toggle('low', lives <= 8);
      (hud.querySelector('[data-k=wave]') as HTMLElement).textContent = title;
      (hud.querySelector('[data-k=hint]') as HTMLElement).textContent = hint;
      const nb = hud.querySelector('[data-a=next]') as HTMLElement;
      nb.style.display = phase === 'break' ? '' : 'none';
      nb.textContent = wave === 0 ? '¡Empezar! (N)' : 'Ya (N)';
      (hud.querySelector('[data-a=fast]') as HTMLElement).textContent = fast ? '×2' : '×1';
    }
    // Abajo: qué estás colocando, y si el sitio vale.
    const err = placing ? whyNot(ghost.x, ghost.y) : '';
    const tkey = placing ? placing.dex + '|' + err + '|' + G.Touch.active : '';
    if (tkey === tipKey) return;
    tipKey = tkey;
    if (!placing) { tip.style.display = 'none'; tip.innerHTML = ''; return; }
    const mon = G.DEX_BY[placing.dex], r = powerOf(placing.dex);
    tip.style.display = '';
    tip.innerHTML = `<span>Colocando <b>${mon.name}</b>${r ? ' · ' + r.name : ''} · ${costOf(placing.dex)} monedas</span>
      ${err ? `<span class="bad">✖ ${err}</span>` : `<span class="good">✔ ${G.Touch.active ? 'Toca para plantar aquí' : 'Clic para plantar aquí'}</span>`}
      <button class="btn small ghost" data-a="cancel">Cancelar (Esc)</button>`;
    (tip.querySelector('[data-a=cancel]') as HTMLElement).onclick = () => cancelPlacing();
  }

  // ---------------- dibujo ----------------

  /** El camino, la base, y los alcances (al colocar o con una torre seleccionada). */
  function drawGround(ctx: CanvasRenderingContext2D) {
    if (path.length < 2) return;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const trace = () => { ctx.beginPath(); ctx.moveTo(path[0].x, path[0].y); for (const p of path) ctx.lineTo(p.x, p.y); };
    // Al colocar: lo que no se puede ocupar, sombreado en rojo (camino y su borde, entrada, base y junto a otras torres).
    if (placing) {
      trace(); ctx.strokeStyle = 'rgba(255, 95, 109, 0.22)'; ctx.lineWidth = PATH_CLEAR * 2; ctx.stroke();
      ctx.fillStyle = 'rgba(255, 95, 109, 0.22)';
      for (const e of [path[0], path[path.length - 1]]) { ctx.beginPath(); ctx.arc(e.x, e.y, ENDS_CLEAR, 0, 6.2832); ctx.fill(); }
      for (const t of towers) { ctx.beginPath(); ctx.arc(t.p.x, t.p.y, TOWER_GAP, 0, 6.2832); ctx.fill(); }
      // El borde del mapa.
      ctx.strokeStyle = 'rgba(255, 95, 109, 0.5)'; ctx.lineWidth = 3; ctx.setLineDash([12, 10]);
      ctx.beginPath(); ctx.arc(0, 0, bound, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
    }
    trace(); ctx.strokeStyle = 'rgba(60, 44, 28, 0.55)'; ctx.lineWidth = 50; ctx.stroke();
    trace(); ctx.strokeStyle = 'rgba(214, 186, 132, 0.85)'; ctx.lineWidth = 42; ctx.stroke();
    // Flechas en el camino: hacia dónde van.
    ctx.fillStyle = 'rgba(120, 90, 50, 0.45)';
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], len = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
      for (let d = 60; d < len - 30; d += 120) {
        const x = a.x + Math.cos(ang) * d, y = a.y + Math.sin(ang) * d;
        ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
        ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-6, -7); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }
    // La base: lo que defiendes.
    const b = path[path.length - 1];
    ctx.fillStyle = 'rgba(79, 180, 255, 0.35)';
    ctx.beginPath(); ctx.arc(b.x, b.y, 34, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = '#4fb4ff'; ctx.lineWidth = 4; ctx.stroke();
    // La entrada.
    const a = path[0];
    ctx.fillStyle = 'rgba(255, 95, 109, 0.35)';
    ctx.beginPath(); ctx.arc(a.x, a.y, 26, 0, 6.2832); ctx.fill();
    if (placing) {
      // El alcance de las torres que ya tienes, para ver qué queda cubierto.
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1.5;
      for (const t of towers) {
        const r = SUPPORT[t.dex] ? 0 : rangeOf(t.p);
        if (r > 0) { ctx.beginPath(); ctx.arc(t.p.x, t.p.y, r, 0, 6.2832); ctx.stroke(); }
      }
      // La que se coloca: verde si el sitio vale y roja si no (la X va encima de su sprite: drawables).
      ring(ctx, ghost.x, ghost.y, placing.range, whyNot(ghost.x, ghost.y) ? '255, 95, 109' : SUPPORT[placing.dex] ? '255, 210, 63' : '95, 224, 138');
    } else if (selected && selected !== 'hero') {
      const k = SUPPORT[selected.dex];
      ring(ctx, selected.p.x, selected.p.y, k ? auraRadius(selected.level) : rangeOf(selected.p), '255, 210, 63');
    }
    // Las auras de los apoyos, siempre a la vista (flojito), y bajo cada torre reforzada, sus colores.
    for (const t of towers) {
      const k = SUPPORT[t.dex];
      if (k) {
        ctx.globalAlpha = 0.5; ctx.strokeStyle = AURAS[k].color; ctx.lineWidth = 2; ctx.setLineDash([4, 8]);
        ctx.beginPath(); ctx.arc(t.p.x, t.p.y, auraRadius(t.level), 0, 6.2832); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        continue;
      }
      const on = AURA_KINDS.filter(a => t.buff[a] > 0);
      on.forEach((a, i) => {
        ctx.fillStyle = AURAS[a].color;
        ctx.beginPath(); ctx.arc(t.p.x - (on.length - 1) * 5 + i * 10, t.p.y + 12, 3.5, 0, 6.2832); ctx.fill();
      });
    }
    ctx.restore();
  }
  function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string) {
    ctx.fillStyle = `rgba(${rgb}, 0.16)`;
    ctx.strokeStyle = `rgba(${rgb}, 0.85)`;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.arc(x, y, Math.max(20, r), 0, 6.2832); ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Las torres (y la que se está colocando, medio transparente) se ordenan por Y con el resto de la escena. */
  function drawables() {
    const out: { y: number; draw(ctx: CanvasRenderingContext2D): void }[] = towers.map(t => t.p);
    if (placing) {
      const p = placing.preview;
      p.x = ghost.x; p.y = ghost.y;
      out.push({ y: p.y + 1000, draw(ctx: CanvasRenderingContext2D) {
        ctx.save(); ctx.globalAlpha = 0.6; p.draw(ctx); ctx.restore();
        if (!whyNot(ghost.x, ghost.y)) return;
        // Aquí no se puede: una X roja bien visible encima.
        ctx.save();
        ctx.strokeStyle = '#ff3b4e'; ctx.lineWidth = 6; ctx.lineCap = 'round';
        const s = 13, y = ghost.y - 18;
        ctx.beginPath(); ctx.moveTo(ghost.x - s, y - s); ctx.lineTo(ghost.x + s, y + s); ctx.moveTo(ghost.x + s, y - s); ctx.lineTo(ghost.x - s, y + s); ctx.stroke();
        ctx.restore();
      } });
    }
    return out;
  }

  function render(v: View) {
    const { ctx, w, h, dpr } = v;
    // La interfaz sólo se ve con la partida en marcha (no en la pausa ni en el resumen).
    const show = Run.state === 'playing';
    for (const el of [hud, shop, panel, tip]) if (el) el.style.visibility = show ? '' : 'hidden';
    if (show) paintHud();

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
    G.Touch.draw(ctx);
  }

  return {
    id: 'td',
    start, update, idle, keysModal, keysPlay, drawables, drawGround, render, everyone,
    quit() { end(false); },
    /** El menú abre aquí la elección de favoritos antes de empezar. */
    openTeam,
    // ---- para las pruebas ----
    debugBuy(dex: number) { startPlacing(dex); },
    debugPlace(x: number, y: number) { tryPlace(x, y); },
    debugUpgrade(i: number) { if (towers[i]) upgrade(towers[i]); },
    debugEvolve(to: number) { if (pendingEvo && pendingEvo.options.includes(to)) evolve(pendingEvo.tower, to); },
    debugSell(i: number) { if (towers[i]) sell(towers[i]); },
    debugMode(i: number, mode: TargetMode) { if (towers[i] && TARGET_MODES.includes(mode)) towers[i].mode = mode; },
    debugCallWave() { callWave(); },
    debugFast(on: boolean) { fast = !!on; },
    debugHpMul(k: number) { hpMul = k > 0 ? k : 1; if (hpMul !== 1) tampered = true; },
    canPlace(x: number, y: number) { return !whyNot(x, y); },
    get route() { return path.map(p => ({ x: p.x, y: p.y })); },
    get placing() { return placing ? { dex: placing.dex, x: ghost.x, y: ghost.y } : null; },
    get info() {
      return {
        wave, lives, leaked, phase, money, reach: Math.round(reach * 100) / 100, team: team.slice(), shop: pool.map(c => c.dex), heroLevel, won,
        evo: pendingEvo ? pendingEvo.options.slice() : null,
        selected: selected === 'hero' ? 'hero' : selected ? towers.indexOf(selected) : null,
        powers: { ...powers },
        next: wave < LAST_WAVE ? { ...waveAt(wave + 1) } : null,
        towers: towers.map(t => ({ dex: t.dex, level: t.level, spent: t.spent, mode: t.mode, support: SUPPORT[t.dex] || null, buff: { ...t.buff }, x: t.p.x, y: t.p.y, shots: shots.get(t.p) || 0 }))
      };
    },
    get player() { return pl; }, get time() { return time; }
  } satisfies GameMode & Record<string, unknown>;
})();
G.TD = TD;

declare module '../g' {
  interface Registry { TD: typeof TD }
}
