import { G } from '../g';
import { Run, type GameMode, type View } from '../run';
import { Enemy } from '../entities/enemy';
import {
  leadAngle, placementError, moveRange, towerCost, upgradeCost, sellValue, killReward, waveBonus,
  evolvesAt, START_MONEY, MAX_LEVEL, PATH_CLEAR, TOWER_GAP, ENDS_CLEAR,
  pathLengths, pathProgress, stepBack, pickTarget, TARGET_MODES, TARGET_NAME, type TargetMode,
  ROLES, roleHit, SUPPORT, AURAS, AURA_KINDS, auraStrength, auraRadius, aurasAt, type AuraKind, type AuraTotals,
  MAPS, mapById, randomMap, costFor, trophyCost, bossGate, arenaPlaces, type TdMap,
  mapHint,
} from './td-geom';
import { MAZE_COLS, MAZE_W, MAZE_H, CELL, FREE_ROWS, cellIx, cellAt, cellCenter, flow, stepFrom, stepBackFrom, routeFrom, blockError } from './td-maze';
import { START_LIVES, LAST_WAVE, MAX_WAVE, WIN_COINS, waveAt, waveHp, waveCount, waveGap, bossHpMul, leakCost, defenseCoins } from './td-waves';
import type { CoopConfig, HostEv, Mate, TdGuestEv, TdHostEv, TeamState } from '../net/coop';
import type { Pickup, PickupCollector } from '../entities/pickup';
import type { Player } from '../entities/player';
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
 * Hay cinco mapas (td-geom.ts, MAPS); Cruce y Tridente, con varias entradas: los normales salen
 * por todas a la vez y cada jefe por una (bossGate). Tras la oleada 30 (la victoria) sigue el modo
 * sin fin, hasta que caiga la base o abandones. Al acabar se cobran monedas de la
 * cuenta (td-waves.ts, defenseCoins), cuentan las misiones y logros (evento tdEnd) y
 * la marca sube al ranking de Defensa (modo 'd', o 'e' en grupo).
 *
 * Cooperativo (de 2 a 4, desde una sala; net/coop.ts lleva la red):
 *   ANFITRIÓN  lo simula todo: oleadas, enemigos, torres, vidas y la cartera de cada uno.
 *   CADA UNO   lleva a su héroe (sus golpes van al anfitrión, como en las hordas) y
 *              manda lo que quiere hacer (comprar, mejorar, vender...): lo aplica el
 *              anfitrión si se puede, y lo cuenta a todos.
 * Las vidas son de todos; las monedas, de cada uno (por cada enemigo cobráis todos, y
 * los enemigos tienen más vida cuantos más sois). Cada torre es de quien la compró:
 * sólo él la mejora o la vende. Los invitados ven copias de las torres que repiten
 * sus ataques sin hacer daño (G.Combat.ghostCast).
 *
 *   invitado -> anfitrión   ['tp', dex, x, y, shiny, trofeo] plantar · ['tu', id] mejorar · ['ts', id] vender
 *                           ['tm', id, modo] a quién ataca · ['te', id, dex] evolución elegida
 *                           ['th'] mejorar al héroe · ['tw'] adelantar la oleada · ['tl', id, mov] enseñarle un ataque
 *   anfitrión -> invitados  ['tt', id, dueño, dex, x, y, nivel, modo, shiny, base, gastado, [aprendidos]] una torre (nueva o cambiada)
 *                           ['tr', id] torre vendida · ['tc', id, mov, nivel, ángulo, evolucionado] ataque de una torre
 *                           ['tv', id, [dex...]] evolución por elegir (la ve su dueño)
 *                           ['tg', vidas, oleada, fase, segundos, quedan, ×2, superadas, ganada, {uid: monedas}, escapados]
 *                           ['tb', idEnemigo, 'boss'|'legend'] un jefe (más grande) · ['th', uid, nivel] héroe mejorado
 *                           ['tx', x, y, texto, color] un número o aviso flotante
 *                           ['tq', dex] un jefe o legendario derrotado pasa a la tienda (trofeo)
 *
 * Arena (sólo en grupo, de 2 a 8; coop.arena), al estilo de Line Tower Wars: cada jugador tiene su carril,
 * una cuadrícula vertical (td-maze.ts) sin camino fijo: los monstruos entran por arriba y van a la salida,
 * abajo, por la ruta más corta que quede. Las torres son obstáculos: con ellas se hace el laberinto (y con
 * Sudowoodo, un muro barato que no ataca). No se puede tapar el paso ni encerrar a un monstruo; al colocar
 * se ve la ruta que quedaría. Además de las oleadas (iguales para todos, una cada ARENA_WAVE_GAP s), cada
 * uno ENVÍA monstruos al carril de un rival (SENDS): cuestan monedas y suben tus ingresos de cada oleada.
 * Cada uno con sus vidas (ARENA_LIVES) y sus monedas; quien se queda sin vidas cae (fuera sus torres y sus
 * monstruos) y mira a los demás; gana el último en pie (arenaPlaces). Al acabar, el anfitrión sube el podio
 * (G.Ranking.submitArena) y cada uno cobra según su puesto.
 *   invitado -> anfitrión   ['tk', envío, a quién] envía monstruos a un rival
 *   anfitrión -> invitados  'tg' lleva además [[vidas, caído, ingresos], ...] de cada carril (en el orden de la sala)
 *
 * Espectador (sala pública ya en juego; net/spectate.ts): monta la partida como un invitado,
 * pero sin héroe propio (no se dibuja, no ataca ni recoge), sin tienda ni nada que comprar; la
 * cámara sigue al jugador que elijas (o donde mandes con el minimapa) y al acabar no cobra nada.
 *
 * Todo lo del modo vive aquí, en td-geom.ts y en td-waves.ts: no cambia nada
 * del modo de hordas.
 */
export const TD = (() => {
  /** Radio del claro sin obstáculos, en tiles: ahí cabe todo el camino (los de td-geom.ts, MAPS). */
  const CLEAR = 24;
  /** Segundos de descanso entre oleadas (se pueden adelantar con el botón). */
  const BREAK = 12;
  /** Antes de la primera oleada, más rato para plantar las primeras torres. */
  const FIRST_BREAK = 25;
  /** Probabilidad de que un enemigo suelte una baya al caer. */
  const HEAL_DROP = 0.012;
  /** Segundos de inmunidad a otro control fuerte tras uno (×1,5 en jefes y legendarios). */
  const CC_IMMUNE = 2;
  /** Velocidad de los enemigos en el camino (unidades por segundo) en la oleada 1. */
  const WALK = 95;
  /** Favoritos como mucho (los que salen primero en la tienda). */
  const TEAM_MAX = 6;
  /** La animación de herido, sólo con golpes de al menos esta parte de la vida del enemigo (o críticos): con muchas torres pegando, parecía que retrocedían. */
  const HURT_ANIM_MIN = 0.1;
  /** Arena: vidas de cada carril. */
  const ARENA_LIVES = 20;
  /** Arena: entre carril y carril (unidades de mundo): más que cualquier alcance o lo que vuela un proyectil. */
  const ARENA_SPACING = MAZE_W + 720;
  /** Arena: segundos entre oleada y oleada (no esperan a que se vacíe el carril: con los envíos no se vaciaría). */
  const ARENA_WAVE_GAP = 30;
  /** Arena: Sudowoodo es el muro (en los juegos, el árbol falso que corta el paso): no ataca y es barato. */
  const WALL_DEX = 185, WALL_COST = 10;
  /**
   * Arena: lo que se puede enviar a un rival. `cost` monedas (fijo); `income`, lo que sube tus ingresos de
   * cada oleada; `hp` y `spd`, respecto a un enemigo normal de la oleada; `n`, cuántos salen; `fly`, vuela:
   * no sigue el laberinto, baja recto (las torres sí le pegan); `boss`, grande y caro de dejar pasar.
   */
  const SENDS = [
    { dex: 19, cost: 20, income: 1, hp: 0.6, spd: 1.45, n: 3 },
    { dex: 74, cost: 45, income: 3, hp: 2.6, spd: 0.7, n: 1 },
    { dex: 41, cost: 60, income: 4, hp: 1.1, spd: 1.1, n: 2, fly: true },
    { dex: 67, cost: 110, income: 8, hp: 4.5, spd: 0.95, n: 1 },
    { dex: 143, cost: 320, income: 25, hp: 22, spd: 0.6, n: 1, boss: true },
  ];
  /** Arena: monedas de la cuenta por puesto (1.º, 2.º, 3.º), además de las de siempre. */
  const ARENA_PRIZE = [300, 150, 75];
  /**
   * Alcance máximo de una torre. Los proyectiles vuelan hasta 520, pero con eso una
   * torre cubría medio mapa y daba igual dónde ponerla.
   */
  const RANGE_MAX = 340;
  /** El apoyo que se presta de cada clase si no tienes ninguno: Scyther, Togepi, Riolu, Meowth y Hoothoot. */
  const LENT_SUPPORT = [123, 175, 447, 52, 163];
  /** Cuántos Pokémon enseña la tienda a la vez (con más, se filtra por tipo). */
  const SHOP_MAX = 60;

  /** El Pokémon de una torre: un Player con el alcance extra que le dan las auras (tdRange). */
  type TowerMon = Player & { tdRange?: number };

  /**
   * Una torre: su id (el mismo en todos los ordenadores), de quién es, el Pokémon, lo
   * gastado, a quién apunta, su ataque sin auras (`atk`) y las auras que recibe ahora (`buff`).
   */
  interface Tower {
    id: number; owner: string; p: TowerMon; dex: number; shiny: boolean; level: number; base: number; spent: number;
    mode: TargetMode; atk: number; buff: AuraTotals;
    /** Ataques que le has enseñado con monedas (además del suyo). */
    learned: string[];
  }

  let time = 0;
  let pl: Player = null!;            // el héroe (null fuera de partida, ver finish)
  let heroLevel = 1;                 // mejoras del ataque del héroe compradas con monedas
  let towers: Tower[] = [];
  let nextTowerId = 1;
  /** Favoritos (salen primero en la tienda). */
  let team: number[] = [];
  /** Todo lo que se puede comprar: tu colección y, si es corta, iniciales prestados. */
  /** lent: prestado (iniciales, apoyos) · trophy: jefe o legendario derrotado en esta partida (más caro). */
  let pool: { dex: number; lent: boolean; trophy?: boolean }[] = [];
  /** Trofeos de esta partida, en el orden en que se ganaron (para el invitado que vuelve tras un corte). */
  let trophies: number[] = [];
  /** Quién eres en la partida: 'me' en solitario, tu uid en grupo. */
  let me = 'me';
  /** Las monedas de cada jugador (en solitario, sólo las tuyas). Las lleva el anfitrión. */
  let purse: Record<string, number> = {};
  /** Mejoras del héroe de cada jugador (anfitrión: para cobrarlas). */
  let heroLv: Record<string, number> = {};
  /** La partida en grupo (o null en solitario): lo que mandó el anfitrión al empezar, con el mapa. */
  let coop: (CoopConfig & { map?: string }) | null = null;
  /** Anfitrión: cuánto falta para volver a mandar el estado de la partida a los invitados. */
  let stateT = 0;
  /** Invitado: el anfitrión no responde (cambió de pestaña o se le paró el juego): su nombre, o null. */
  let hostAway: string | null = null;
  /** Lo que el anfitrión cuenta de la oleada (en el invitado: los enemigos que quedan). */
  let leftShown = 0;
  /** El mapa de la partida. */
  let map: TdMap = MAPS[0];
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
  /** La partida se ha tocado desde la consola (debugHpMul): no sube al ranking ni da premio. */
  let tampered = false;
  /** Se ganó sin que llegara ningún enemigo a la base (logro "Muralla"). */
  let flawless = false;
  /** ×1 o ×2: todo pasa el doble de deprisa. */
  let fast = false;
  /**
   * Los caminos en unidades de mundo, uno por entrada (todos acaban en la base). Sus puntos los
   * comparten como destino los enemigos de esa entrada. `lens`: lo que mide cada uno hasta cada punto.
   */
  type PathPt = { x: number; y: number; r: number; level: number };
  let paths: PathPt[][] = [];
  let lens: number[][] = [];
  /** Lo que mide el camino más largo (para comparar quién va primero entre caminos distintos). */
  let longest = 0;
  /**
   * Cuánto ha avanzado `e` hacia la base, comparable entre entradas: lo más largo que hay menos
   * lo que le falta (con un solo camino, lo andado, como siempre).
   */
  function progressOf(e: Walker) {
    // Arena: lo que le falta para la salida (los que vuelan, en línea recta).
    if (arena) {
      const ln = lanes[e.lane];
      if (!ln) return 0;
      if (e.fly) return 1e6 - (ln.cy + MAZE_H / 2 - e.y) * 10 / CELL;
      const i = cellAt(e.x - ln.cx, e.y - ln.cy);
      return 1e6 - (i >= 0 ? Math.min(ln.dist[i], 1e5) : 1e5);
    }
    const p = paths[e.lane], l = lens[e.lane], done = pathProgress(e.x, e.y, e.wp, p, l);
    return paths.length === 1 ? done : longest - (l[l.length - 1] - done);
  }
  /** El héroe no sale de este radio (unidades de mundo) alrededor del centro de su mapa: el mapa es el claro. */
  let bound = 0;
  /** ¿Es una Arena? (ver la cabecera) */
  let arena = false;
  /**
   * Arena: el carril de cada jugador (en el orden de la sala): su centro, sus vidas y, si ha caído,
   * cuántos habían caído ya contándole (`out`; 0 = sigue en pie) y en qué oleada (`outWave`).
   * `kills`: los enemigos de su carril derrotados (lo lleva el anfitrión).
   */
  interface Lane {
    uid: string; cx: number; cy: number; lives: number; out: number; outWave: number; kills: number;
    /** El laberinto: casillas ocupadas, lo que le falta a cada una para la salida y la ruta desde la entrada. */
    blocked: Uint8Array; dist: Float64Array; route: number[];
    /** Lo que cobra en cada oleada además del premio de la oleada (sube con cada envío). */
    income: number;
  }
  let lanes: Lane[] = [];
  /** Arena: envíos por salir (uno cada poco, para que no salgan amontonados). */
  let sendQ: { L: number; k: number; from: string; t: number }[] = [];
  /** Arena: a quién envías ('' = al siguiente que siga en pie). */
  let sendTo = '';
  /** Arena: rehace el laberinto del carril L con las torres de su dueño (al plantar, vender o caer). */
  function rebuildMaze(L: number) {
    const ln = lanes[L];
    if (!ln) return;
    ln.blocked = new Uint8Array(ln.blocked.length);
    for (const t of towers) if (t.owner === ln.uid) { const i = cellAt(t.p.x - ln.cx, t.p.y - ln.cy); if (i >= 0) ln.blocked[i] = 1; }
    ln.dist = flow(ln.blocked);
    ln.route = routeFrom(cellIx(Math.floor(MAZE_COLS / 2), 0), ln.dist, ln.blocked);
  }
  function rebuildMazes() { if (arena) lanes.forEach((_, L) => rebuildMaze(L)); }
  /** Arena: (x, y) en el centro de su casilla (si cae en tu carril). */
  function snap(x: number, y: number) {
    const ln = myLane();
    if (!ln) return { x, y };
    const i = cellAt(x - ln.cx, y - ln.cy);
    if (i < 0) return { x, y };
    const c = cellCenter(i);
    return { x: ln.cx + c.x, y: ln.cy + c.y };
  }
  /** Arena: las casillas de los monstruos del carril L (y a la que van): ahí no se planta, y ninguno puede quedar encerrado. */
  function monsterCells(L: number) {
    const ln = lanes[L], out: number[] = [];
    if (!ln) return out;
    for (const e of G.EnemyMgr.all()) {
      if (e.dead || (e instanceof Walker && (e.lane !== L || e.fly))) continue;
      const i = cellAt(e.x - ln.cx, e.y - ln.cy);
      if (i < 0) continue;
      out.push(i);
      const n = stepFrom(i, ln.dist, ln.blocked);
      if (n >= 0) out.push(n);
    }
    return out;
  }
  /** ¿Es un muro? (Sudowoodo en la Arena) */
  const isWall = (t: { dex: number }) => arena && t.dex === WALL_DEX;
  /** Arena: cuántas veces ha caído alguien (cada tanda de caídos a la vez cuenta una). */
  let outs = 0;
  /** Arena: el carril de cada jugador (su índice en `lanes`), o -1. */
  const laneIx = (uid: string) => lanes.findIndex(l => l.uid === uid);
  /** Arena: el tuyo (o null si no juegas en ella). */
  const myLane = () => (arena ? lanes[laneIx(me)] || null : null);
  /** Arena: ¿has caído? (sigues mirando a los demás) */
  const knockedOut = () => { const l = myLane(); return !!l && l.out > 0; };
  /** El centro del mapa donde juegas (en la Arena, el de tu carril). */
  const home = () => { const l = myLane(); return l ? { x: l.cx, y: l.cy } : { x: 0, y: 0 }; };
  /** Arena, ya fuera: el carril que miras (Q/E o Tab cambian). */
  let watchLane = 0;
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
  /** Un enemigo de la Defensa; `tdKind` lo marca como jefe o legendario (ver bigger). */
  type TdEnemy = Enemy & { tdKind?: string };

  class Walker extends Enemy {
    /** Por qué entrada ha salido (su camino es paths[lane]). */
    lane = 0;
    /** Índice en su camino del punto al que va. */
    wp = 1;
    /** 'boss' (jefe de cada 5) o 'legend' (legendario de cada 10). */
    kind: 'normal' | 'boss' | 'legend' = 'normal';
    /** Oleada en la que salió (para su recompensa). */
    wave = 1;
    chill = 0; chillCd = 0; frozenT = 0; stunT = 0; confuseT = 0; curseT = 0;
    pinned = true;
    /**
     * Inmune a otro control fuerte (congelar, paralizar, confundir, empujar) mientras dure: con
     * muchas torres se podía tener a un enemigo parado para siempre, y el final era un paseo.
     */
    ccT = 0;
    /** Tipo del último golpe (el Hada da más monedas si es ella quien lo derrota). */
    lastType = '';
    textCd = 0;

    /** Arena: vuela (no sigue el laberinto: baja recto) · de quién es el envío ('' = de la oleada). */
    fly = false;
    sent = '';

    get chief() { return this.kind !== 'normal'; }
    /** Arena: a dónde va ahora (el centro de la casilla siguiente de su ruta, o recto abajo si vuela). */
    mazeTarget(): { x: number; y: number } {
      const ln = lanes[this.lane];
      if (!ln) return { x: this.x, y: this.y + 50 };
      const exit = { x: this.x, y: ln.cy + MAZE_H / 2 + CELL };
      if (this.fly) return exit;
      const i = cellAt(this.x - ln.cx, this.y - ln.cy);
      if (i < 0) return { x: ln.cx, y: ln.cy - MAZE_H / 2 + CELL / 2 };              // fuera: de vuelta a la entrada
      if (ln.dist[i] === 0 && this.confuseT <= 0) return exit;                         // la última fila: sale por abajo
      const n = this.confuseT > 0 ? stepBackFrom(i, ln.dist, ln.blocked) : stepFrom(i, ln.dist, ln.blocked);
      const c = cellCenter(n >= 0 ? n : i);
      return { x: ln.cx + c.x, y: ln.cy + c.y };
    }
    /** Sus estados para las copias del cooperativo (ver drawStatus). */
    netBits = () => (this.frozenT > 0 ? 1 : 0) | (this.stunT > 0 ? 2 : 0) | (this.confuseT > 0 ? 4 : 0) | (this.curseT > 0 ? 8 : 0) | (this.slow > 0.2 ? 16 : 0);

    update(dt: number) {
      // Nunca cuenta como rezagado (en las hordas, los rezagados reaparecen junto al jugador).
      this.lagT = -1e9;
      // Sin rebotes: al tocar a un héroe, en las hordas salen despedidos (G.Combat); aquí, un héroe plantado
      // en el camino frenaba así a cualquiera, jefes incluidos. Lo que los hace retroceder es el Agua (por el camino).
      this.kx = 0; this.ky = 0;
      if (!this.dead) {
        this.chillCd -= dt; this.frozenT -= dt; this.stunT -= dt; this.confuseT -= dt; this.curseT -= dt; this.textCd -= dt; this.ccT -= dt;
      }
      // Arena: por el laberinto (confundido, hacia atrás). (Con el nivel del héroe, como los puntos del camino:
      // de él sale lo que quitan las quemaduras.)
      if (arena) { const to = this.mazeTarget(); super.update(dt, { x: to.x, y: to.y, r: 0, level: pl ? pl.level : 1 }); return; }
      // Confundido: anda hacia atrás.
      const path = paths[this.lane];
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
      // Control fuerte: uno cada vez, y luego un rato de inmunidad (más largo en los jefes).
      const cc = () => { if (this.ccT > 0) return false; this.ccT = CC_IMMUNE * (this.chief ? 1.5 : 1); return true; };
      if (r.chill && this.chillCd <= 0 && ++this.chill >= r.chill[0]) {
        this.chill = 0; this.chillCd = 2.5;
        if (cc()) this.freeze(r.chill[1] * (this.chief ? 0.5 : 1), 'frozen', '¡Congelado!', '#9fe8ff');
      }
      if (fx.stun > 0 && cc()) this.freeze(fx.stun, 'stun', type === 'electric' ? '¡Paralizado!' : '¡Aturdido!', '#ffe14d');
      if (fx.confuse > 0 && cc()) { this.confuseT = Math.max(this.confuseT, fx.confuse); this.say('¡Confuso!', '#ff8ac4'); note('psychic'); }
      if (fx.push > 0 && cc()) {
        if (arena) {
          // Arena: una casilla atrás en su ruta (los que vuelan, un poco hacia arriba).
          const ln = lanes[this.lane], i = ln ? cellAt(this.x - ln.cx, this.y - ln.cy) : -1;
          const b = ln && !this.fly && i >= 0 ? stepBackFrom(i, ln.dist, ln.blocked) : -1;
          if (b >= 0) { const c = cellCenter(b); this.x = ln.cx + c.x; this.y = ln.cy + c.y; }
          else if (this.fly) this.y -= fx.push;
        } else {
          const b = stepBack(this.x, this.y, this.wp, fx.push, paths[this.lane]);
          this.x = b.x; this.y = b.y; this.wp = b.wp;
        }
        note('water');
      }
      if (r.burn || r.poison || r.slow || r.curse) note(type);
    }

    /** Aturdir de los ataques (Onda Trueno, Tumba Rocas...): cuenta como control fuerte, con su inmunidad. */
    applyDaze(dur: number) {
      if (this.dead || this.ccT > 0) return;
      this.ccT = CC_IMMUNE * (this.chief ? 1.5 : 1);
      this.freeze(dur * (this.chief ? 0.5 : 1), 'stun', '¡Aturdido!', '#ffe14d');
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
      // (Un envío de un rival da la mitad: si no, enviar le regalaría monedas.)
      const n = Math.ceil(killReward(this.wave) * (this.kind === 'legend' ? 20 : this.kind === 'boss' ? 10 : 1) * (this.sent ? 0.5 : 1));
      // Hada (si es ella quien lo derrota) y Día de Pago (si cae cerca de un Meowth...).
      const fairy = this.lastType === 'fairy' ? ROLES.fairy.bounty || 0 : 0;
      const pay = aurasAt(this.x, this.y, auraSources()).bounty;
      const bonus = Math.ceil(n * (fairy + pay));
      if (fairy) note('fairy');
      if (pay) note('bounty');
      // Cobráis todos (en grupo, cada uno en su cartera); en la Arena, sólo el dueño del carril.
      const ln = arena ? lanes[this.lane] : null;
      if (ln) { ln.kills++; if (ln.uid in purse) purse[ln.uid] += n + bonus; }
      else for (const u of Object.keys(purse)) purse[u] += n + bonus;
      // De vez en cuando, una baya que cura al héroe (como antes, cuando soltaban gemas).
      if (!this.remote && Math.random() < HEAL_DROP) G.Pickups.drop('heal', this.x, this.y);
      if (this.chief) {
        floatText(this.x, this.y - this.bodyH - 10, '+' + (n + bonus), '#ffd23f');
        // (En la Arena cae uno en cada carril: el aviso grande sería uno por jugador.)
        if (!arena) announce('¡' + this.name + ' derrotado!', 2.4);
        // Derrotarlo lo desbloquea: pasa a la tienda (de todos) para el resto de la partida.
        unlockTrophy(this.dex);
        if (coop) G.Coop.broadcast(['tq', this.dex]);
      }
    }

    draw(ctx: CanvasRenderingContext2D) {
      super.draw(ctx);
      if (!this.dead) drawStatus(ctx, this, this.netBits());
    }
  }

  /**
   * Lo que le pasa a un enemigo, encima de él: bloque de hielo (bit 1), chispas de
   * parálisis (2), confusión (4), maldición (8) y frenado (16). Los bits son los de
   * Walker.netBits: así se dibuja igual en las copias del cooperativo.
   */
  function drawStatus(ctx: CanvasRenderingContext2D, e: Enemy, bits: number) {
    if (!bits) return;
    const cy = e.y - e.bodyH * 0.5, top = e.y - e.bodyH - 6;
    ctx.save();
    if (bits & 1) {
      // Bloque de hielo encima.
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#bff3ff'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(e.x, cy, e.r * 1.3, e.bodyH * 0.65, 0, 0, 6.2832); ctx.fill(); ctx.stroke();
    } else if (bits & 16) {
      ctx.globalAlpha = 0.35; ctx.fillStyle = '#7fe0e0';
      ctx.beginPath(); ctx.ellipse(e.x, e.y, e.r * 1.3, e.r * 0.5, 0, 0, 6.2832); ctx.fill();
    }
    if (bits & 2) {
      // Chispas amarillas dando vueltas sobre la cabeza.
      ctx.globalAlpha = 0.9; ctx.fillStyle = '#ffe14d';
      for (let i = 0; i < 3; i++) { const a = time * 8 + i * 2.1; ctx.fillRect(e.x + Math.cos(a) * 10 - 2, top + Math.sin(a) * 3 - 2, 4, 4); }
    }
    if (bits & 4) {
      ctx.globalAlpha = 0.9; ctx.strokeStyle = '#ff8ac4'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(e.x, top - 2, 5, time * 6, time * 6 + 4.5); ctx.stroke();
    }
    if (bits & 8) {
      ctx.globalAlpha = 0.3 + Math.sin(time * 5) * 0.08; ctx.fillStyle = '#7a6bc4';
      ctx.beginPath(); ctx.ellipse(e.x, e.y, e.r * 1.5, e.r * 0.6, 0, 0, 6.2832); ctx.fill();
    }
    ctx.restore();
  }

  /** Poderes de tipo que han salido (para las pruebas). */
  function note(k: string) { powers[k] = (powers[k] || 0) + 1; }

  /** Torre que se está colocando: una vista previa que sigue al ratón o al héroe. */
  let placing: { dex: number; preview: TowerMon; range: number } | null = null;
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

  /** Para el HUD del juego (ui/hud.ts): el reloj; sin el de arriba (la Defensa tiene su marcador). */
  const st = { get time() { return time; }, noClock: true, noLevel: true, noDown: true };

  // ---------------- quién lleva la partida ----------------

  /** ¿Simulas tú la partida? En solitario sí; en grupo, sólo el anfitrión. */
  const hosting = () => !coop || G.Coop.isHost;
  /** ¿Eres invitado en una partida en grupo? (el espectador también lo es) */
  const guest = () => !!coop && !G.Coop.isHost;
  /** ¿Sólo miras la partida (espectador)? */
  const watching = () => !!coop && !!coop.watch;
  /** Tus monedas. */
  const cash = () => purse[me] || 0;
  /** Texto de un jugador (su apodo) dentro de HTML. */
  const esc = (v: string) => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  /** El nombre de un jugador de la partida. */
  function nameOf(uid: string) {
    if (uid === me) return 'Tú';
    const m = coop && coop.members.find(x => x.uid === uid);
    return m ? m.name : '?';
  }
  /** El color de un jugador (el de su etiqueta), o null en solitario. */
  function colorOf(uid: string): string | null {
    if (!coop) return null;
    const i = coop.members.findIndex(m => m.uid === uid);
    return i >= 0 ? G.Coop.COLORS[i] : null;
  }
  /** Un aviso grande para todos (en grupo, el anfitrión se lo manda a los invitados). */
  function announce(text: string, secs = 2.4) {
    G.Spawner.say(text, secs, true);
    if (coop && G.Coop.isHost) G.Coop.broadcast(['say', text, secs]);
  }
  /** Un número o aviso flotante para todos. */
  function floatText(x: number, y: number, text: string, col: string) {
    G.FX.dmgText(x, y, text, col, true);
    if (coop && G.Coop.isHost) G.Coop.broadcast(['tx', Math.round(x), Math.round(y), text, col]);
  }

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
    // Apoyos: de cada clase de aura que no tengas, uno prestado (si no, quien empieza no los ve nunca).
    for (const dex of LENT_SUPPORT) {
      const kind = SUPPORT[dex];
      if (!G.DEX_BY[dex] || dex === save.partner || out.some(o => SUPPORT[o.dex] === kind)) continue;
      out.push({ dex, lent: true });
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

  // ---------------- el ataque de cada torre ----------------

  /** Formas de ataque que no sirven quieto: embestir (te mueve), el rastro al andar, los potenciadores y las que sólo pegan pegadas al Pokémon (girar, empujar, cargar). */
  const NOT_FOR_TOWERS = new Set(['buff', 'dash', 'trail', 'spin', 'shove', 'charge']);
  const towerMoves = new Map<number, string>();
  let parentOf: Map<number, number> | null = null;
  /** De qué evoluciona `dex` (o undefined). */
  function preEvo(dex: number) {
    if (!parentOf) {
      parentOf = new Map();
      const E = (G.EVOLUTIONS || {}) as Record<number, number[]>;
      for (const [from, tos] of Object.entries(E)) for (const to of tos) if (!parentOf.has(to)) parentOf.set(to, +from);
    }
    return parentOf.get(dex);
  }
  /**
   * El ataque de un Pokémon como torre. Antes era el inicial de su tipo, así que todos los de
   * Fuego lanzaban Ascuas y todos los de Agua, Pistola Agua. Ahora cada especie tiene uno de
   * los de sus tipos (siempre el mismo), y al evolucionar cambia a otro distinto. Los iniciales
   * conservan el suyo.
   */
  /** Todos los ataques de sus tipos que sirven en una torre (los Normal sólo si es de tipo Normal), en orden fijo. */
  function towerPool(dex: number): string[] {
    const mon = G.DEX_BY[dex];
    if (!mon) return [];
    return (G.Moves.poolFor(mon, true, false) as string[]).filter(m => {
      const d = G.Moves.BY_ID[m];
      return d && mon.types.includes(d.type) && !NOT_FOR_TOWERS.has(d.kind);
    }).sort();
  }
  function towerMoveOf(dex: number): string {
    const got = towerMoves.get(dex);
    if (got) return got;
    const mon = G.DEX_BY[dex];
    let id = G.startMoveOf(dex, false);
    if (mon && !G.STARTER_BY[dex]) {
      const usable = towerPool(dex);
      // Primero los de su tipo principal (Zapdos, Eléctrico; Moltres, Fuego); los del segundo, sólo si del
      // principal hay uno nada más (Dragonite: Dragón sólo tiene Furia Dragón).
      const main = usable.filter(m => G.Moves.BY_ID[m].type === mon.types[0]);
      let ids = main.length >= 2 ? main : usable;
      // Una evolución final o un legendario no se queda con el ataque básico de su tipo (el inicial).
      const final = !((G.EVOLUTIONS || {})[dex] || []).length && (preEvo(dex) || mon.leg);
      if (final) { const strong = ids.filter(m => m !== G.Moves.startFor({ types: [G.Moves.BY_ID[m].type] })); if (strong.length) ids = strong; }
      if (ids.length) {
        let i = (Math.imul(dex, 2654435761) >>> 0) % ids.length;
        // Al evolucionar, un ataque distinto del de su forma anterior (si hay de dónde elegir).
        const from = preEvo(dex);
        if (from && ids.length > 1 && ids[i] === towerMoveOf(from)) i = (i + 1) % ids.length;
        id = ids[i];
      }
    }
    towerMoves.set(dex, id);
    return id;
  }

  /** El tipo del ataque de un Pokémon (el de su movimiento): decide su poder. */
  function attackType(dex: number): string {
    const m = G.Moves.BY_ID[towerMoveOf(dex)];
    return (m && m.type) || G.DEX_BY[dex].types[0];
  }
  const typeName = (t: string) => (G.U.TYPE_NAME as Record<string, string>)[t] || t;
  const typeColor = (t: string): string | undefined => (G.U.TYPE_COLOR as Record<string, string>)[t];
  /** Etiqueta de color (tipo o apoyo), con el texto oscuro o blanco según se lea mejor sobre su fondo. */
  const tag = (bg: string, text: string) => `<i class="td-type" style="background:${bg};color:${G.U.inkOn(bg)}">${text}</i>`;
  const auraChip = (k: AuraKind) => tag(AURAS[k].color, 'Apoyo');
  const typeChip = (t: string) => tag(typeColor(t) || '#888', typeName(t));

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
      <input type="search" class="td-find" placeholder="Buscar por nombre o número…" aria-label="Buscar Pokémon">
      <div class="td-grid"></div>
      <div class="row td-maps" style="margin-top:10px;gap:6px;flex-wrap:wrap;align-items:center"><b>Mapa:</b></div>
      <div class="row" style="margin-top:12px;gap:8px"><button class="btn gold grow" data-a="go">Empezar</button></div>
    </div>`;
    document.body.appendChild(el);
    // El mapa: uno de los de td-geom.ts o al azar (se recuerda el último).
    let mapPick = G.DB.save.tdMap === 'random' || MAPS.some(m => m.id === G.DB.save.tdMap) ? G.DB.save.tdMap : MAPS[0].id;
    const maps = el.querySelector('.td-maps') as HTMLElement;
    // (Debajo, para cuántos va mejor el elegido: con un amigo o más, mejor uno de varias entradas.)
    const hint = document.createElement('p');
    hint.className = 'sub td-map-hint';
    hint.style.cssText = 'margin:6px 0 0;width:100%';
    const showHint = () => { hint.textContent = mapHint(mapPick) || 'Un mapa al azar'; };
    for (const [id, name] of [...MAPS.map(m => [m.id, m.name]), ['random', 'Al azar']]) {
      const b = document.createElement('button');
      b.className = 'btn small' + (id === mapPick ? ' gold' : '');
      b.dataset.map = id;
      b.textContent = name;
      b.onclick = () => {
        mapPick = id;
        maps.querySelectorAll<HTMLElement>('[data-map]').forEach(x => x.classList.toggle('gold', x.dataset.map === id));
        showHint();
      };
      maps.appendChild(b);
    }
    maps.appendChild(hint);
    showHint();
    const grid = el.querySelector('.td-grid') as HTMLElement;
    const go = el.querySelector('[data-a=go]') as HTMLButtonElement;
    const paint = () => {
      grid.querySelectorAll<HTMLElement>('.td-pick').forEach(b => b.classList.toggle('on', chosen.includes(+b.dataset.dex!)));
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
      b.insertAdjacentHTML('beforeend', `<small>${mon.name}</small>${SUPPORT[c.dex] ? auraChip(SUPPORT[c.dex]) : typeChip(attackType(c.dex))}<small class="gold">${costOf(c.dex)}</small>${c.lent ? '<small class="lent">préstamo</small>' : ''}`);
      b.onclick = () => {
        if (chosen.includes(c.dex)) chosen = chosen.filter(d => d !== c.dex);
        else if (chosen.length < TEAM_MAX) chosen.push(c.dex);
        paint();
      };
      grid.appendChild(b);
    }
    // Buscador: esconde los que no casan (los elegidos se quedan elegidos aunque no se vean).
    const find = el.querySelector('.td-find') as HTMLInputElement;
    find.oninput = () => {
      grid.querySelectorAll<HTMLElement>('.td-pick').forEach(b => { b.style.display = matches(+b.dataset.dex!, find.value) ? '' : 'none'; });
    };
    paint();
    (el.querySelector('[data-a=back]') as HTMLElement).onclick = () => el.remove();
    (el.querySelector('[data-a=guide]') as HTMLElement).onclick = () => G.GuideUI.open('td');
    go.onclick = () => {
      el.remove();
      G.DB.save.tdTeam = chosen.slice();
      G.DB.save.tdMap = mapPick;
      G.DB.commit();
      G.Game.start('td', { team: chosen, map: mapPick === 'random' ? randomMap(Math.random).id : mapPick });
    };
  }

  // ---------------- partida ----------------

  /**
   * @param opts  team: favoritos · map: id del mapa (td-geom.ts, MAPS) · coop: la partida en
   *              grupo que manda el anfitrión al empezar ({ seed, host, members, map })
   */
  function start(opts: { team?: number[]; map?: string; coop?: CoopConfig } | null = null) {
    const save = G.DB.save!;
    const mon = G.DEX_BY[save.partner!];
    const perks = G.Upgrades.perks(G.DB.upgradesOf(mon.dex));
    coop = opts && opts.coop ? opts.coop : null;
    me = coop ? G.Net.uid! : 'me';

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
    const TS = G.World.TS;
    map = mapById(coop ? coop.map : opts && opts.map);
    // Arena: un carril (un laberinto) por jugador, en fila; si no, el mapa en el centro.
    arena = !!(coop && coop.arena && coop.members.length >= 2);
    const n = arena ? coop!.members.length : 0;
    lanes = arena ? coop!.members.map((m, i) => {
      const blocked = new Uint8Array(MAZE_COLS * Math.round(MAZE_H / CELL));
      return { uid: m.uid, cx: (i - (n - 1) / 2) * ARENA_SPACING, cy: 0, lives: ARENA_LIVES, out: 0, outWave: 0, kills: 0,
               blocked, dist: flow(blocked), route: [], income: 0 };
    }) : [];
    outs = 0; watchLane = 0; sendQ = []; sendTo = '';
    paths = arena ? [] : map.routes.map(r => r.map(([tx, ty]) => ({ x: tx * TS, y: ty * TS, r: 0, level: 1 })));
    // En grupo, el mismo mundo para todos (la semilla del anfitrión); en la Arena, el claro cubre todos los carriles.
    const far = arena ? Math.hypot((n - 1) / 2 * ARENA_SPACING + MAZE_W, MAZE_H / 2) : 0;
    G.World.reset(coop ? coop.seed : Math.floor(Math.random() * 1e6), CLEAR + Math.ceil(far / TS));
    G.World.setBiome(0, true);
    lens = paths.map(p => pathLengths(p));
    longest = Math.max(...lens.map(l => l[l.length - 1]));
    bound = 20 * TS;
    time = 0; lives = START_LIVES; wave = 0; leaked = 0; downT = 0; won = false; flawless = false; fast = false; cleared = 0; tampered = false; hostAway = null;
    heroLevel = 1; reach = 0; hpMul = 1; bossLeft = 0; toSpawn = 0; leftShown = 0; stateT = 0; camFree = null;
    // Cada jugador empieza con lo mismo (en solitario, sólo tú).
    purse = {}; heroLv = {};
    for (const u of coop ? coop.members.map(m => m.uid) : [me]) { purse[u] = START_MONEY; heroLv[u] = 1; }
    towers = []; nextTowerId = 1; placing = null; selected = null; pendingEvo = null; powers = {}; trophies = [];
    pool = candidates();
    // Arena: el muro (Sudowoodo), siempre a mano.
    if (arena) { pool = pool.filter(c => c.dex !== WALL_DEX); pool.unshift({ dex: WALL_DEX, lent: true }); }
    team = cleanTeam(opts && opts.team);
    if (!opts || !Array.isArray(opts.team)) { if (!team.length) team = cleanTeam(save.tdTeam); }
    shopFilter = 'all';                // empieza en Todos (los favoritos salen primero igual)
    shopText = '';
    G.Sprites.preload(team, 4000);
    preloadWave(1);
    listenPointer();

    pl = new G.Player(mon, perks, !!save.partnerShiny && G.DB.ownsShiny(mon.dex));
    pl.cats = false;                        // la Defensa está afinada sin ataques físicos y especiales
    pl.addMove(G.startMoveOf(mon.dex, false));
    if (coop) {
      G.Coop.begin(coop, pl, coopApi);
      if (!coop.watch) G.Social.setPlaying(true);
    }
    // Arena: cada héroe empieza en el centro de su carril.
    if (arena) {
      rebuildMazes();
      const h = home(); pl.x = h.x; pl.y = h.y;
      for (const p of G.Coop.puppets()) { const l = lanes[laneIx(p.uid || '')]; if (l) { p.x = l.cx; p.y = l.cy; } }
    }
    G.Camera.x = pl.x; G.Camera.y = pl.y; G.Camera.shake = 0;
    G.Sprites.preload([mon.dex], 8000, pl.shiny);
    G.Audio.music(G.BIOME_MUSIC[0]);

    Run.state = 'playing';
    // Ranking: el servidor apunta cuándo empieza (en grupo, el anfitrión).
    if (hosting()) G.Ranking.runStarted(arena ? 'a' : coop ? 'e' : 'd');
    phase = 'break'; phaseT = FIRST_BREAK;
    buildUI();
    G.Spawner.say(arena ? 'Arena: defiende tu carril; gana el último en pie' : coop ? 'Defended juntos: cada uno compra sus torres con sus monedas' : 'Compra torres en la tienda y plántalas junto al camino', 4, true);
  }

  /** Cómo ha ido la partida (lo que el anfitrión manda a todos al acabar). */
  function summary(dead: boolean) {
    return { dead, w: cleared, l: Math.max(0, lives), k: pl ? pl.kills : 0, s: Math.floor(time), won, flawless, wave, map: map.id,
             // Arena: el puesto de cada uno (por uid), la oleada en la que cayó y lo que derrotó en su carril.
             arena: arena ? podium() : undefined };
  }
  /** Arena: los puestos de ahora (el que sigue en pie, 1.º; quien cayó antes, peor). */
  function podium() {
    const places = arenaPlaces(lanes.map(l => l.out));
    return lanes.map((l, i) => ({ uid: l.uid, place: places[i], wave: l.out ? l.outWave : wave, kills: l.kills, lives: Math.max(0, l.lives) }));
  }

  /** Se acaba la partida (la base cae, se abandona o, en grupo, el anfitrión la termina). */
  function end(dead: boolean, quitting = false) {
    if (Run.state === 'over' || !pl) return;
    const d = summary(dead);
    // En grupo, el anfitrión la acaba para todos (Coop les manda el resumen y ellos llaman a finish).
    if (coop && G.Coop.isHost) G.Coop.over(d);
    finish(d, !quitting);
  }

  /** Resumen, premios de la cuenta y ranking. `d`: el de summary(), el tuyo o el del anfitrión. */
  /** @param normal  ha acabado para todos a la vez; si el anfitrión se fue o se cortó, en grupo no hay "Volver a intentarlo" */
  function finish(d: ReturnType<typeof summary>, normal = true) {
    if (Run.state === 'over' || !pl) return;
    Run.state = 'over';
    // Espectador: ni premio ni resumen; de vuelta a la lista de salas.
    if (watching()) {
      hideUI();
      G.Audio.music(null);
      pl = null!; towers = []; G.EnemyMgr.clear();
      G.Spectate.ended(d.won ? '¡Han defendido la base!' : 'La partida que mirabas ha terminado');
      return;
    }
    // (Si el anfitrión abandona, Coop ya se ha cerrado: quién era el anfitrión lo dice la partida.)
    const group = !!coop, wasHost = !coop || coop.host === me, members = coop ? coop.members.slice() : [];
    if (coop) {
      if (G.Coop.active) G.Coop.end();
      G.Social.setPlaying(false);
    }
    hideUI();
    G.Audio.music(null);
    G.Audio.sfx(d.dead && !d.won ? 'gameover' : d.won ? 'legend' : 'back');

    // Arena: lo tuyo sale de tu fila del podio (el resumen es el del anfitrión).
    const mineA = d.arena ? d.arena.find(r => r.uid === me) || null : null;
    if (mineA) { d = { ...d, w: mineA.place === 1 ? d.w : Math.max(0, mineA.wave - 1), k: mineA.kills, l: mineA.lives, won: false, flawless: false }; }
    // La cuenta: monedas, estadísticas, misiones y logros (en grupo, cada uno los suyos).
    const save = G.DB.save;
    const prize = mineA && d.arena!.length >= 2 ? ARENA_PRIZE[mineA.place - 1] || 0 : 0;
    const coins = tampered ? 0 : defenseCoins(d.w, d.k, d.won) + prize;
    save.coins += coins;
    save.stats.coinsEarned += coins;
    save.stats.totalKills += d.k;
    G.Progress.event('tdEnd', { waves: d.w, won: d.won, lives: d.l, group, perfect: d.won && d.flawless });
    G.Progress.checkAch();
    G.DB.commit(true);

    // Arena: el anfitrión sube el podio (victorias y podios, net/ranking.ts).
    if (d.arena && wasHost && !tampered) {
      G.Ranking.submitArena({ map: d.map, waves: d.wave, secs: d.s,
        places: d.arena.map(r => { const m = members.find(x => x.uid === r.uid); return { uid: r.uid, place: r.place, wave: r.wave, dex: m ? m.dex : 25, shiny: !!(m && m.shiny) }; }) });
    }
    // Ranking de Defensa: oleadas superadas y, a igualdad, vidas que quedaban (en grupo lo sube el anfitrión).
    else if (!d.arena && !tampered && d.w > 0) {
      const mark = { waves: d.w, lives: d.l, secs: d.s, kills: d.k };
      if (!group) G.Ranking.submitDefense(Object.assign(mark, { dex: pl.dex, shiny: pl.shiny }));
      else if (wasHost) G.Ranking.submitDefenseGroup(Object.assign(mark, { members: members.map(m => ({ uid: m.uid, dex: m.dex, shiny: m.shiny })) }));
    }

    const back = () => { pl = null!; towers = []; G.EnemyMgr.clear(); G.Flow.afterRun(); };
    G.RunUI.showOver({
      dead: d.dead, time: d.s, level: pl.level, kills: d.k, bosses: 0, coins, record: false, t1: 0, t10: 0, judge: null,
      cells: mineA ? [['Puesto', mineA.place + '.º de ' + d.arena!.length], ['Oleada', mineA.wave], ['Derrotados', d.k], ['Tiempo', G.U.mmss(d.s)]]
        : [['Oleadas superadas', d.w], ['Vidas', d.l], ['Derrotados', d.k], ['Tiempo', G.U.mmss(d.s)]],
      moves: pl.moves, caught: [],
      breakdown: tampered ? 'Partida tocada desde la consola: sin premio'
        : d.arena ? podiumText(d.arena) + (prize ? ' · premio ' + prize : '')
        : `oleadas ${d.w * 10} · derrotados ${Math.floor(d.k / 5)}${d.won ? ' · victoria ' + WIN_COINS : ''}`
    }, back, G.Flow.retry(group, normal, back, () => {
      // Mismo mapa y mismo equipo; el mismo Pokémon es el de la cuenta.
      const again = { team: team.slice(), map: map.id };
      pl = null!; towers = []; G.EnemyMgr.clear();
      G.Game.start('td', again);
    }));
    if (group) G.Flow.overGroup(normal);
    document.getElementById('over-title')!.textContent = mineA
      ? (mineA.place === 1 ? '¡Has ganado la Arena!' : 'Arena · ' + mineA.place + '.º puesto')
      : d.won ? (d.wave > LAST_WAVE ? '¡Victoria! · y en el sin fin, hasta la oleada ' + d.wave : '¡Victoria! · las ' + LAST_WAVE + ' oleadas')
      : d.dead ? 'La base ha caído · oleada ' + d.wave : 'Defensa terminada · oleada ' + d.wave;
  }

  /** Arena: "1.º Ana · 2.º Beto · 3.º Tú" (los nombres de la sala). */
  function podiumText(rows: { uid: string; place: number }[]) {
    return rows.slice().sort((a, b) => a.place - b.place).map(r => r.place + '.º ' + nameOf(r.uid)).join(' · ');
  }

  function everyone() { return coop && G.Coop.active ? G.Coop.players() : [pl]; }

  // ---------------- oleadas ----------------
  // Sólo las lleva quien simula la partida (en grupo, el anfitrión).

  /** Carga antes de tiempo los sprites de la oleada n (si no, salen tarde). */
  function preloadWave(n: number) {
    if (n > MAX_WAVE) return;
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
    announce('Oleada ' + wave + ' · ' + w.theme, 3);
    preloadWave(wave + 1);
    sendState();
  }

  /** "Siguiente oleada" antes de tiempo: más monedas cuanto antes (para todos). */
  function callWave() {
    // Arena: el ritmo es el mismo para todos (adelantarla sería adelantársela a los demás); sólo la primera.
    if (phase !== 'break' || Run.state !== 'playing' || (arena && wave > 0)) return;
    if (guest()) { G.Coop.toHost(['tw']); return; }
    if (wave > 0) payAll(Math.max(0, Math.floor(phaseT)) * 2, pl.x, pl.y - 40);
    startWave();
  }

  /** Vida de los enemigos en grupo: cuantos más sois (y más torres hay), más aguantan. */
  const groupHp = () => (coop && G.Coop.active && !arena ? 1 + 0.85 * (G.Coop.players().length - 1) : 1);

  /** Saca un enemigo de la oleada (los normales primero; el jefe, al final). */
  /**
   * @param bossDex  (pruebas) el jefe que sale, en vez del de la oleada
   * @param lane     por qué entrada (el jefe, por la que le toque: bossGate)
   * @param quiet    sin el aviso de que llega (la Arena lo da una vez para todos los carriles)
   */
  /** @param lane  en la Arena, el carril (en `lanes`); si no, por qué camino */
  function spawnEnemy(chief: boolean, bossDex = 0, lane = chief ? bossGate(wave, paths.length) : 0, quiet = false) {
    const w = waveAt(wave);
    // (`bossDex` también fija el normal: en la Arena sale el mismo en cada carril.)
    const dex = bossDex || (chief ? w.boss! : w.pool[Math.floor(Math.random() * w.pool.length)]);
    const mon = G.DEX_BY[dex];
    const kind = !chief ? 'normal' : w.legend ? 'legend' : 'boss';
    // Vida y velocidad: la curva de la oleada, ajustadas un poco con los stats del Pokémon.
    const hpK = G.U.clamp(mon.hp / 95, 0.85, 1.25), spdK = G.U.clamp(mon.spd / 105, 0.85, 1.2);
    let hp = waveHp(wave) * hpK * hpMul * groupHp(), spd = WALK * (1 + wave * 0.025) * spdK;
    if (chief) { hp *= bossHpMul(kind === 'legend'); spd *= 0.7; }
    // Sin experiencia: en la Defensa no sueltan gemas (no servían para nada); se cobra en monedas.
    const def = { dex, name: mon.name, behavior: 'chase' as const, hp: Math.round(hp), spd, dmg: 10, xp: 0 };
    const at = spawnPoint(lane);
    const e = new Walker(def, at.x, at.y, { hp: 1, spd: 1, dmg: 1 });
    e.kind = kind;
    e.wave = wave;
    e.lane = lane;
    e.hurtAnimMin = HURT_ANIM_MIN;
    G.EnemyMgr.add(e);
    if (chief) {
      bigger(e, kind);
      // Con varias entradas, por cuál: que vaya a ayudar quien no la defiende.
      if (!quiet) announce(paths.length > 1 && map.gates ? '¡Llega ' + mon.name + ' por ' + map.gates[lane] + '!' : '¡Llega ' + mon.name + '!', 2.6);
      if (!quiet) G.Audio.sfx('legend');
      if (coop) G.Coop.broadcast(['tb', e.id, kind]);
    }
  }

  /** Dónde sale un enemigo: la entrada de su camino; en la Arena, una casilla al azar de la fila de arriba de su carril. */
  function spawnPoint(lane: number) {
    if (arena) {
      const ln = lanes[lane], c = cellCenter(cellIx(Math.floor(Math.random() * MAZE_COLS), 0));
      return { x: ln.cx + c.x, y: ln.cy + c.y - CELL * 0.3 };
    }
    const path = paths[lane];
    return { x: path[0].x + G.U.rand(-10, 10), y: path[0].y + G.U.rand(-10, 10) };
  }
  /** Arena: sale un monstruo enviado por `from` en el carril L. */
  function spawnSent(L: number, k: number, from: string) {
    const s = SENDS[k], mon = G.DEX_BY[s.dex], ln = lanes[L];
    if (!s || !mon || !ln || ln.out) return;
    const wv = Math.max(1, wave);
    const def = { dex: s.dex, name: mon.name, behavior: 'chase' as const, hp: Math.round(waveHp(wv) * s.hp * hpMul), spd: WALK * (1 + wv * 0.025) * s.spd, dmg: 10, xp: 0 };
    const at = spawnPoint(L);
    const e = new Walker(def, at.x, at.y, { hp: 1, spd: 1, dmg: 1 });
    e.kind = s.boss ? 'boss' : 'normal'; e.wave = wv; e.lane = L; e.fly = !!s.fly; e.sent = from;
    e.hurtAnimMin = HURT_ANIM_MIN;
    G.EnemyMgr.add(e);
    if (s.boss) { bigger(e, 'boss'); if (coop) G.Coop.broadcast(['tb', e.id, 'boss']); }
  }

  /** Un jefe o legendario se ve más grande (también su copia en los invitados). */
  function bigger(e: TdEnemy, kind: string) {
    const s = kind === 'legend' ? 1.9 : 1.55;
    e.scale = s;
    e.anim = new G.Sprites.Animator(e.dex, s);
    e.r = G.Sprites.bodyRadius(e.dex, s);
    e.bodyH = G.Sprites.bodyHeight(e.dex, s);
    e.tdKind = kind;
  }

  /** Avanza a cada enemigo por el camino; el que llega a la base os quita vidas. */
  function march() {
    const list = G.EnemyMgr.all();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.dead || !(e instanceof Walker)) continue;
      if (arena) {
        // Arena: ha llegado abajo (más allá del centro de la última fila).
        const ln = lanes[e.lane];
        if (!ln || e.y < ln.cy + MAZE_H / 2 - CELL * 0.4) continue;
      } else {
        const path = paths[e.lane], l = lens[e.lane];
        reach = Math.max(reach, pathProgress(e.x, e.y, e.wp, path, l) / l[l.length - 1]);
        const to = path[e.wp];
        if (G.U.dist2(e.x, e.y, to.x, to.y) > 18 * 18) continue;
        if (e.wp + 1 < path.length) { e.wp++; continue; }
      }
      // Ha llegado a la base: fuera, sin botín ni animación.
      list.splice(i, 1);
      if (coop && G.Coop.isHost) G.Coop.enemyGone(e, false);
      const cost = leakCost(e.kind === 'boss', e.kind === 'legend');
      leaked++;
      G.FX.burst(e.x, e.y - 10, '#ff5f6d', 14, 160);
      // Arena: le cuesta a quien defiende ese carril (y sólo él lo nota).
      const ln = arena ? lanes[e.lane] : null;
      if (ln) {
        ln.lives -= cost;
        floatText(e.x, e.y - 30, '-' + cost, '#ff5f6d');
        if (ln.uid === me) { G.Camera.kick(0.5); G.Audio.sfx('hurt'); }
      } else {
        lives -= cost;
        G.Camera.kick(0.5);
        G.Audio.sfx('hurt');
        if (e.chief) announce(e.name + ' ha llegado a la base', 2.4);
      }
      sendState();
    }
  }

  function tickPhase(dt: number) {
    if (arena) { arenaTick(dt); return; }
    if (phase === 'wave') {
      if (toSpawn > 0 || bossLeft > 0) {
        spawnT -= dt;
        if (spawnT <= 0) {
          // Los normales salen por todas las entradas a la vez (uno por cada una).
          if (toSpawn > 0) {
            for (let lane = 0; lane < paths.length && toSpawn > 0; lane++) { spawnEnemy(false, 0, lane); toSpawn--; }
            spawnT = toSpawn > 0 ? waveGap(wave) : 2;
          }
          else { spawnEnemy(true); bossLeft = 0; }
        }
      } else if (!G.EnemyMgr.all().some(e => !e.dead)) {
        payAll(waveBonus(wave), pl.x, pl.y - 40);
        cleared = wave;
        if (wave === LAST_WAVE) {
          // La victoria: cuenta como ganada, y sigue el sin fin hasta que caiga la base o lo dejéis.
          won = true; flawless = leaked === 0;
          G.Audio.sfx('legend');
          announce('¡Habéis defendido la base! Ahora, sin fin: ¿hasta dónde llegáis?', 4);
        } else announce('¡Oleada ' + wave + ' superada!', 2.2);
        if (wave >= MAX_WAVE) { end(false); return; }
        phase = 'break'; phaseT = BREAK;
        sendState();
      }
    } else if ((phaseT -= dt) <= 0) startWave();
  }

  /**
   * Anfitrión, Arena: las oleadas van por tiempo (una cada ARENA_WAVE_GAP s, iguales para todos: el mismo
   * Pokémon en cada carril a la vez); al empezar cada una, cada uno cobra el premio de la oleada y sus
   * ingresos. Y salen los envíos pendientes.
   */
  function arenaTick(dt: number) {
    const up = lanes.map((l, i) => (l.out ? -1 : i)).filter(i => i >= 0);
    for (const q of sendQ) q.t -= dt;
    for (const q of sendQ.filter(q => q.t <= 0)) spawnSent(q.L, q.k, q.from);
    sendQ = sendQ.filter(q => q.t > 0);
    if (phase === 'break') { if ((phaseT -= dt) <= 0) { startWave(); phaseT = ARENA_WAVE_GAP; } return; }
    if (toSpawn > 0 || bossLeft > 0) {
      spawnT -= dt;
      if (spawnT <= 0) {
        const w = waveAt(wave);
        if (toSpawn > 0) {
          const dex = w.pool[Math.floor(Math.random() * w.pool.length)];
          for (const L of up) spawnEnemy(false, dex, L);
          toSpawn--;
          spawnT = toSpawn > 0 ? waveGap(wave) : 2;
        } else {
          for (const L of up) spawnEnemy(true, 0, L, true);
          announce('¡Llega ' + G.DEX_BY[w.boss!].name + '!', 2.6);
          G.Audio.sfx('legend');
          bossLeft = 0;
        }
      }
    }
    if ((phaseT -= dt) > 0) return;
    // La siguiente oleada: premio e ingresos para los que siguen en pie.
    cleared = wave;
    for (const L of up) { const ln = lanes[L]; purse[ln.uid] = (purse[ln.uid] || 0) + waveBonus(wave) + ln.income; }
    if (!knockedOut()) { const ln = myLane(); if (ln) G.FX.dmgText(pl.x, pl.y - 40, '+' + (waveBonus(wave) + ln.income), '#ffd23f'); }
    if (wave >= MAX_WAVE) { end(false); return; }
    startWave();
    phaseT = ARENA_WAVE_GAP;
  }

  // ---------------- envíos (Arena) ----------------

  /** A quién va un envío de `from`: a `want` si sigue en pie (y no es él); si no, al siguiente que siga en pie. */
  function sendTarget(from: string, want = '') {
    const ok = (u: string) => u !== from && lanes[laneIx(u)] && !lanes[laneIx(u)].out;
    if (want && ok(want)) return want;
    const k = laneIx(from);
    for (let d = 1; d < lanes.length; d++) { const l = lanes[(k + d) % lanes.length]; if (ok(l.uid)) return l.uid; }
    return '';
  }
  /** Envías el monstruo `k` (de SENDS) a tu rival elegido. */
  function send(k: number) {
    const s = SENDS[k];
    if (!arena || !s || knockedOut() || Run.state !== 'playing' || watching()) return;
    if (cash() < s.cost) { G.Spawner.say('Te faltan monedas', 1.4, true); G.Audio.sfx('back'); return; }
    const to = sendTarget(me, sendTo);
    if (!to) return;
    G.Audio.sfx('confirm');
    if (guest()) { G.Coop.toHost(['tk', k, to]); return; }
    doSend(me, k, to);
  }
  /** Anfitrión: `from` envía el monstruo `k` a `to` (si le llega y los dos siguen en pie): sube sus ingresos. */
  function doSend(from: string, k: number, to: string) {
    const s = SENDS[k], fl = lanes[laneIx(from)], tl = lanes[laneIx(to)];
    if (!s || !fl || fl.out || !tl || tl.out || from === to) return;
    if (!pay(from, s.cost)) return;
    fl.income += s.income;
    const L = laneIx(to);
    for (let i = 0; i < s.n; i++) sendQ.push({ L, k, from, t: 0.35 * i });
    floatText(tl.cx, tl.cy - MAZE_H / 2 - 30, memberName(from) + ' → ' + (s.n > 1 ? s.n + '× ' : '') + G.DEX_BY[s.dex].name, colorOf(from) || '#ffffff');
    sendState();
    refreshUI();
  }

  // ---------------- monedas ----------------

  /** Cobráis todos (por oleada, por adelantarla): cada uno en su cartera. */
  function payAll(n: number, x: number, y: number) {
    if (!(n > 0)) return;
    // (En la Arena, sólo los que siguen en pie.)
    for (const u of Object.keys(purse)) if (!arena || (lanes[laneIx(u)] && !lanes[laneIx(u)].out)) purse[u] += n;
    if (!knockedOut()) G.FX.dmgText(x, y, '+' + n, '#ffd23f');
  }
  /** Cobra `uid` (lo que devuelve una torre vendida). */
  function earn(uid: string, n: number, x: number, y: number) {
    if (!(n > 0)) return;
    purse[uid] = (purse[uid] || 0) + n;
    if (uid === me) G.FX.dmgText(x, y, '+' + n, '#ffd23f');
  }
  /** Paga `uid` si le llega. */
  function pay(uid: string, n: number) {
    if (!(n >= 0) || (purse[uid] || 0) < n) return false;
    purse[uid] -= n;
    return true;
  }

  // ---------------- torres ----------------
  // Lo que pulsas pasa por aquí: en solitario (y si eres el anfitrión) se aplica
  // en el momento; si eres invitado, se le pide al anfitrión, que lo comprueba,
  // lo aplica y os lo cuenta a todos (ver la cabecera y "cooperativo", más abajo).

  /** Un Pokémon como torre (un G.Player que no lee el mando: sólo apunta y ataca). */
  function makeTower(dex: number, shiny = G.DB.ownsShiny(dex)): TowerMon {
    const t = new G.Player(G.DEX_BY[dex], {}, shiny);
    t.cats = false;
    t.frozen = true;
    t.addMove(towerMoveOf(dex));
    return t;
  }
  /** Lo que cuesta como trofeo (el jefe o legendario derrotado, si no lo tienes). */
  const trophyCostOf = (dex: number) => trophyCost(G.DEX_BY[dex].rarity, !!G.DEX_BY[dex].leg);
  const isTrophy = (dex: number) => pool.some(c => c.dex === dex && c.trophy);
  const costOf = (dex: number) => (arena && dex === WALL_DEX ? WALL_COST : isTrophy(dex) ? trophyCostOf(dex) : costFor(dex, G.DEX_BY[dex].rarity));

  /** Un jefe o legendario derrotado pasa a tu tienda (si no lo tenías ya). */
  function unlockTrophy(dex: number) {
    if (!G.DEX_BY[dex] || !G.startMoveOf(dex) || trophies.includes(dex)) return;
    trophies.push(dex);
    if (pool.some(c => c.dex === dex)) return;               // ya lo tienes: se compra a su precio de siempre
    pool.push({ dex, lent: false, trophy: true });
    G.Sprites.preload([dex], 4000);
    G.Spawner.say('¡' + G.DEX_BY[dex].name + ' se une a la tienda!', 3, true);
    buildShop();
  }
  const inPool = (dex: number) => pool.some(c => c.dex === dex);
  const towerById = (id: number) => towers.find(t => t.id === id) || null;
  /** ¿Es tuya? (sólo su dueño la mejora, la vende o cambia a quién ataca) */
  const mine = (t: Tower) => t.owner === me;

  /** La última torre que has empezado a colocar (R la vuelve a coger). */
  let lastDex = 0;

  /**
   * Empieza a colocar una torre de la tienda (si te llega el dinero): sale una vista previa con su alcance.
   * @param again  sigues plantando la misma (Mayús): la vista previa se queda donde estaba el ratón
   */
  function startPlacing(dex: number, again = false) {
    if (!inPool(dex) || Run.state !== 'playing' || knockedOut()) return;
    if (placing && placing.dex === dex && !again) { cancelPlacing(); return; }      // pulsarla otra vez la suelta
    if (cash() < costOf(dex)) { G.Spawner.say('Te faltan monedas', 1.4, true); G.Audio.sfx('back'); return; }
    const preview = makeTower(dex);
    placing = { dex, preview, range: arena && dex === WALL_DEX ? 0 : SUPPORT[dex] ? auraRadius(1) : rangeOf(preview) };
    lastDex = dex;
    selected = null; pendingEvo = null;
    if (!again) { ghostByPointer = false; ghost.x = pl.x; ghost.y = pl.y; }
    G.Sprites.preload([dex], 4000, preview.shiny);
    refreshUI();
  }
  function cancelPlacing() { placing = null; refreshUI(); }

  /**
   * Motivo por el que `owner` no puede plantar en (x, y), o '' si se puede. En la Arena, sólo en su
   * carril: se mira como si su mapa estuviera en el centro (sus caminos y sus torres).
   */
  function whyNotFor(owner: string, x: number, y: number) {
    if (!arena) return placementError(x, y, { paths, towers: towers.map(t => t.p), bound });
    // Arena: en una casilla de su carril que no tape el paso ni encierre a nadie (td-maze.ts).
    const L = laneIx(owner), ln = lanes[L];
    if (!ln || ln.out) return 'Ya no juegas';
    return blockError(cellAt(x - ln.cx, y - ln.cy), ln.blocked, monsterCells(L));
  }
  /** Motivo por el que no puedes plantar en (x, y), o '' si se puede. */
  const whyNot = (x: number, y: number) => whyNotFor(me, x, y);

  /**
   * Intenta plantar la torre que se está colocando en (x, y).
   * @param keep  con Mayús: tras plantarla, sigues con otra igual (si te llega el dinero)
   */
  function tryPlace(x: number, y: number, keep = false) {
    if (!placing || Run.state !== 'playing') return;
    const err = whyNot(x, y);
    if (err) { G.Spawner.say(err, 1.6, true); G.Audio.sfx('back'); return; }
    const dex = placing.dex, shiny = !!placing.preview.shiny, cost = costOf(dex);
    if (cash() < cost) { G.Spawner.say('Te faltan monedas', 1.4, true); cancelPlacing(); return; }
    placing = null;
    if (guest()) {
      // El anfitrión la planta (si aún se puede) y os la manda a todos.
      G.Coop.toHost(['tp', dex, Math.round(x), Math.round(y), shiny ? 1 : 0, isTrophy(dex) ? 1 : 0]);
      wantSelect = keep ? null : { x, y };
      G.Audio.sfx('confirm');
      // (Su cartera aún no ha bajado: lo que queda tras esta es lo que tiene menos lo que cuesta.)
      if (keep && cash() - cost >= cost) startPlacing(dex, true);
      refreshUI();
      return;
    }
    const t = plant(me, dex, x, y, shiny);
    if (t && keep && cash() >= cost) startPlacing(dex, true);         // Mayús: a por la siguiente
    else if (t) selected = t;         // queda seleccionada: se ve su alcance y cómo mejorarla
    refreshUI();
  }
  /** ¿Mayús pulsada? (para plantar seguidas) */
  const shiftHeld = () => G.Input.held('shiftleft') || G.Input.held('shiftright');
  /** Invitado: la torre que has pedido plantar; al llegar, se selecciona. */
  let wantSelect: { x: number; y: number } | null = null;

  /**
   * Planta una torre de `owner` si el sitio vale y le llega el dinero. → la torre, o null
   * @param trophy  (de un invitado) si para él es un trofeo: el precio depende de su tienda, no de la tuya
   */
  function plant(owner: string, dex: number, x: number, y: number, shiny: boolean, trophy?: boolean): Tower | null {
    if (!G.DEX_BY[dex] || !G.startMoveOf(dex) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    // Arena: en el centro de su casilla.
    if (arena) { const ln = lanes[laneIx(owner)], i = ln ? cellAt(x - ln.cx, y - ln.cy) : -1; if (i >= 0) { const c = cellCenter(i); x = ln.cx + c.x; y = ln.cy + c.y; } }
    if (whyNotFor(owner, x, y)) return null;
    // Un trofeo sólo se puede pedir si de verdad se ha ganado en esta partida.
    if (trophy && !trophies.includes(dex)) return null;
    const cost = arena && dex === WALL_DEX ? WALL_COST : trophy === undefined ? costOf(dex) : trophy ? trophyCostOf(dex) : costFor(dex, G.DEX_BY[dex].rarity);
    if (!pay(owner, cost)) { if (owner === me) G.Spawner.say('Te faltan monedas', 1.4, true); return null; }
    const p = makeTower(dex, shiny);
    p.x = x; p.y = y;
    const t: Tower = { id: nextTowerId++, owner, p, dex, shiny, level: 1, base: cost, spent: cost, mode: 'first', atk: p.atkMul, buff: noBuff(), learned: [] };
    towers.push(t);
    if (arena) rebuildMaze(laneIx(owner));
    G.FX.ring(x, y, 8, 110, G.U.TYPE_COLOR[G.DEX_BY[dex].types[0]], 0.6, 5);
    if (owner === me) G.Audio.sfx('confirm');
    sendTower(t);
    return t;
  }

  /** Sube un nivel la torre: más ataque y, en los niveles de evolución, evoluciona. */
  function upgrade(t: Tower) {
    if (isWall(t)) return;                         // (un muro no se mejora)
    if (guest()) { G.Coop.toHost(['tu', t.id]); return; }
    const c = upgradeCost(t.base, t.level);
    if (c == null || evoOf(t) || !pay(t.owner, c)) return;
    t.spent += c;
    t.level++;
    levelMove(t.p);
    t.atk *= 1.12;
    G.FX.ring(t.p.x, t.p.y, 8, 90, G.U.TYPE_COLOR[G.DEX_BY[t.dex].types[0]], 0.6, 5);
    if (mine(t)) G.Audio.sfx('levelup');
    if (evolvesAt(t.level)) {
      const options = evolutionsOf(t.dex);
      if (options.length === 1) evolve(t, options[0]);
      else if (options.length > 1) {
        // Elige su dueño: tú aquí; un invitado en su pantalla (y te manda la elegida).
        evoWait.set(t.id, options);
        if (mine(t)) pendingEvo = { tower: t, options };
        else G.Coop.broadcast(['tv', t.id, options]);
      }
    }
    sendTower(t);
    refreshUI();
  }
  /** Anfitrión: evoluciones por elegir de cada torre (id -> opciones). */
  const evoWait = new Map<number, number[]>();
  const evoOf = (t: Tower) => evoWait.get(t.id) || null;

  /** Sube un nivel sus ataques (hasta el 5; los aprendidos también) y un poco el ataque. */
  function levelMove(p: Player) {
    for (const m of p.activeGroup()) if (m.lvl < 5) G.Moves.levelUp(m);
    p.atkMul *= 1.12;
  }

  // ---------------- enseñar ataques ----------------
  // Como subir una habilidad en Dota: con monedas, la torre aprende otro de los ataques de sus
  // tipos. Van en el mismo hueco que el suyo (como un vínculo de las hordas: G.Combat los lanza
  // todos, cada uno con su recarga) y suben de nivel con ella.

  /** Ataques que se pueden enseñar como mucho a cada torre (además del suyo). */
  const LEARN_MAX = 2;
  /** Lo que cuesta enseñarle el siguiente: 1,5 veces lo que costó la torre, y medio más por cada uno ya aprendido. */
  const learnCost = (t: Tower) => Math.round(t.base * (1.5 + 0.5 * t.learned.length));
  /** Lo que le falta por aprender (de sus tipos); vacío si no puede aprender más. */
  function learnable(t: Tower): string[] {
    if (SUPPORT[t.dex] || isWall(t) || t.learned.length >= LEARN_MAX) return [];
    const known = new Set(t.p.activeGroup().map(m => m.id));
    return towerPool(t.dex).filter(id => !known.has(id));
  }
  /** Mete el ataque `id` en el hueco de la torre, al nivel de la torre. */
  function teach(p: Player, id: string, level: number) {
    const def = G.Moves.BY_ID[id];
    if (!def || p.activeGroup().some(m => m.id === id)) return;
    const m = G.Moves.instance(id, Math.max(1, Math.min(level, def.maxLvl || 5, 5)));
    p.moves.push(m);
    p.activeGroup().push(m);
  }
  /** Enseña a la torre el ataque `id` (si es suyo, si puede y si le llega). */
  function learn(t: Tower, id: string) {
    if (guest()) { G.Coop.toHost(['tl', t.id, id]); return; }
    if (!learnable(t).includes(id)) return;
    const c = learnCost(t);
    if (!pay(t.owner, c)) { if (mine(t)) G.Spawner.say('Te faltan monedas', 1.4, true); return; }
    t.spent += c;
    t.learned.push(id);
    teach(t.p, id, t.level);
    G.FX.ring(t.p.x, t.p.y, 8, 100, G.U.TYPE_COLOR[G.Moves.BY_ID[id].type] || '#ffffff', 0.7, 5);
    if (mine(t)) { G.Audio.sfx('levelup'); G.Spawner.say('¡' + G.DEX_BY[t.dex].name + ' ha aprendido ' + G.Moves.BY_ID[id].name + '!', 2.4, true); }
    sendTower(t);
    refreshUI();
  }

  /** En qué puede evolucionar `dex` (datos de data/evolutions; sólo los que tienen sprite). */
  function evolutionsOf(dex: number): number[] {
    const E = G.EVOLUTIONS as Record<number, number[]> | undefined;
    return ((E && E[dex]) || []).filter(d => G.DEX_BY[d]);
  }

  /** Eliges en qué evoluciona una torre tuya. */
  function chooseEvo(t: Tower, to: number) {
    pendingEvo = null;
    if (guest()) { G.Coop.toHost(['te', t.id, to]); refreshUI(); return; }
    const opts = evoOf(t);
    if (opts && opts.includes(to)) evolve(t, to);
  }

  /** La torre pasa a ser `to`, con su nivel, su posición y lo gastado. */
  function evolve(t: Tower, to: number) {
    const from = G.DEX_BY[t.dex].name;
    const old = t.p;
    // El shiny de la evolución: el tuyo, si lo tienes; el de un compañero, si su torre ya lo era.
    const p = makeTower(to, mine(t) ? G.DB.ownsShiny(to) : t.shiny);
    p.x = old.x; p.y = old.y;
    p.atkMul = old.atkMul;
    for (let l = 1; l < t.level; l++) { const m = p.activeMove(); if (m && m.lvl < 5) G.Moves.levelUp(m); }
    // Lo aprendido no se olvida al evolucionar.
    for (const id of t.learned) teach(p, id, t.level);
    G.Projectiles.clearOrbs(old);
    t.p = p; t.dex = to; t.shiny = !!p.shiny;
    evoWait.delete(t.id);
    if (pendingEvo && pendingEvo.tower === t) pendingEvo = null;
    G.Sprites.preload([to], 4000, p.shiny);
    evolveFx(p);
    announce('¡' + from + ' ha evolucionado a ' + G.DEX_BY[to].name + '!', 2.8);
    sendTower(t);
    refreshUI();
  }
  function evolveFx(p: Player) {
    G.FX.ring(p.x, p.y, 10, 140, '#ffffff', 0.8, 6);
    G.FX.burst(p.x, p.y - 20, '#ffffff', 30, 200);
    G.Audio.sfx('legend');
  }

  function sell(t: Tower) {
    if (guest()) { G.Coop.toHost(['ts', t.id]); return; }
    const i = towers.indexOf(t);
    if (i < 0 || evoOf(t)) return;
    towers.splice(i, 1);
    if (arena) rebuildMaze(laneIx(t.owner));
    earn(t.owner, sellValue(t.spent), t.p.x, t.p.y - 30);
    G.Projectiles.clearOrbs(t.p);
    if (selected === t) selected = null;
    if (mine(t)) G.Audio.sfx('coin');
    if (coop) G.Coop.broadcast(['tr', t.id]);
    refreshUI();
  }

  function cycleMode(t: Tower) {
    const next = TARGET_MODES[(TARGET_MODES.indexOf(t.mode) + 1) % TARGET_MODES.length];
    G.Audio.sfx('confirm');
    if (guest()) { G.Coop.toHost(['tm', t.id, next]); return; }
    t.mode = next;
    sendTower(t);
    refreshUI();
  }

  /** Mejora del ataque del héroe con monedas (su movimiento activo sube de nivel). */
  const HERO_BASE = 100;
  function upgradeHero() {
    if (guest()) { G.Coop.toHost(['th']); return; }
    heroUp(me);
  }
  /** Anfitrión: el héroe de `uid` sube un nivel si le llega el dinero. */
  function heroUp(uid: string) {
    const lv = heroLv[uid] || 1;
    const c = upgradeCost(HERO_BASE, lv);
    if (c == null || !pay(uid, c)) return;
    heroLv[uid] = lv + 1;
    if (uid === me) heroGot(lv + 1);
    else G.Coop.broadcast(['th', uid, lv + 1]);
    refreshUI();
  }
  /** Tu héroe llega al nivel de ataque `lv`. */
  function heroGot(lv: number) {
    while (heroLevel < Math.min(lv, MAX_LEVEL)) { heroLevel++; levelMove(pl); }
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
      const p = toWorld(e), g = snap(p.x, p.y); ghost.x = g.x; ghost.y = g.y; ghostByPointer = true;
    });
    cv.addEventListener('contextmenu', e => { if (Run.mode === TD && Run.state === 'playing') e.preventDefault(); });
    cv.addEventListener('pointerdown', e => { down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), button: e.button }; });
    cv.addEventListener('pointerup', e => {
      const d = down; down = null;
      if (Run.mode !== TD || Run.state !== 'playing' || !d || d.id !== e.pointerId) return;
      // Un toque o clic corto y sin arrastrar; arrastrar es mover al héroe.
      if (performance.now() - d.t > 350 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 14) return;
      // Un icono de ataque del HUD ya ha hecho lo suyo: no es un toque en el mapa.
      if (G.Touch.onButton(d.x, d.y)) return;
      const p = toWorld(e);
      if (placing) {
        if (d.button === 2) { cancelPlacing(); return; }                      // clic derecho: la suelta
        ghost.x = p.x; ghost.y = p.y; ghostByPointer = true;
        tryPlace(p.x, p.y, e.shiftKey);
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
  function rangeOf(p: TowerMon) {
    const ms = p.activeGroup();
    return ms.length ? Math.min(RANGE_MAX * (1 + (p.tdRange || 0)), Math.max(...ms.map(m => moveRange(m)))) : 0;
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
  function targetFor(p: TowerMon, mode: TargetMode) {
    const r = rangeOf(p);
    const inRange: Enemy[] = [], cands: { d2: number; progress: number; hp: number }[] = [];
    for (const e of G.EnemyMgr.all()) {
      if (e.dead) continue;
      const d2 = G.U.dist2(e.x, e.y, p.x, p.y), reach = r + (e.r || 0);
      if (d2 > reach * reach) continue;
      inRange.push(e);
      cands.push({ d2, hp: e.hp, progress: e instanceof Walker ? progressOf(e) : 0 });
    }
    const i = pickTarget(cands, mode);
    return i < 0 ? null : inRange[i];
  }
  /** El alcance en palabras. */
  const reachWord = (r: number) => r <= 130 ? 'corto' : r <= 300 ? 'medio' : 'largo';

  const LEADS = new Set(['projectile', 'boomerang', 'cone']);
  function aimAhead(p: Player) {
    const m = p.activeMove(), tg = p.target;
    if (!m || !tg || !LEADS.has(m.kind) || !(m.speed! > 0)) return;
    const v = vel.get(tg);
    if (!v) return;
    p.aim = leadAngle(p.x, p.y, tg.x, tg.y, v.x, v.y, m.speed!);
  }

  // ---------------- recogida ----------------

  /** @param who  quien lo ha cogido (en grupo puede ser un compañero) */
  function onCollect(p: Pickup, collector: PickupCollector = pl) {
    const who = collector as Player;
    const own = who === pl;
    // Invitado: son copias de los objetos del anfitrión; el efecto lo decide él.
    if (guest()) { if (own) G.Audio.sfx(p.kind === 'coin' ? 'coin' : p.kind === 'heal' ? 'heal' : 'xp'); return; }
    if (coop && G.Coop.active) G.Coop.collected(p, who);
    if (p.kind === 'xp' || p.kind === 'xpBig') { if (own) { G.Audio.sfx('xp'); pl.gainXp(p.value as number); } return; }
    if (p.kind === 'coin') {
      if (own) G.Audio.sfx('coin');
      earn(own ? me : who.uid, p.value as number, who.x, who.y - who.bodyH - 6);
      return;
    }
    if (p.kind === 'heal') {
      if (own) { G.Audio.sfx('heal'); pl.heal(pl.maxHp * 0.3); }
      G.FX.ring(who.x, who.y, 6, 60, '#5fe08a', 0.4, 3);
    }
  }

  // ---------------- bucle ----------------

  let shownMoney = -1;
  function update(dt: number) {
    if (guest()) { if (Run.state === 'playing') stepGuest(dt); }
    else {
      // ×2: dos pasos por fotograma (en grupo lo decide el anfitrión).
      const n = fast ? 2 : 1;
      for (let i = 0; i < n && Run.state === 'playing'; i++) step(dt);
    }
    if (cash() !== shownMoney) refreshUI();
  }

  /** Tu héroe: se levanta solo al caer y no sale del claro. Y los compañeros (copias). */
  function heroStep(dt: number) {
    // Espectador: su "héroe" no juega; está donde mira (el anfitrión le manda los enemigos de ahí).
    if (watching()) {
      const t = G.Spectate.target();
      const fx = camFree ? camFree.x : t ? t.x : pl.x, fy = camFree ? camFree.y : t ? t.y : pl.y;
      pl.x = fx; pl.y = fy; pl.hp = pl.maxHp; pl.dead = false; pl.frozen = true;
      for (const p of G.Coop.puppets()) { p.netUpdate(dt); G.Combat.ghostOrbit(p, dt, time); }
      G.Camera.follow(fx, fy, dt);
      G.World.update(dt, G.Camera);
      G.Spectate.tick();
      return;
    }
    // Arena, ya fuera: el héroe no juega (caído, sin levantarse) y la cámara mira el carril de otro.
    if (knockedOut()) {
      pl.dead = true; pl.hp = 0;
      if (coop && G.Coop.active) for (const p of G.Coop.puppets()) { p.netUpdate(dt); G.Combat.ghostOrbit(p, dt, time); }
      const l = lanes[watchLane] && !lanes[watchLane].out ? lanes[watchLane] : lanes.find(x => !x.out) || lanes[watchLane];
      G.Camera.follow(camFree ? camFree.x : l.cx, camFree ? camFree.y : l.cy, dt);
      G.World.update(dt, G.Camera);
      return;
    }
    // Héroe caído: se levanta solo al rato (la base aguanta mientras con las torres).
    if (pl.dead) {
      downT += dt;
      if (downT > 5) { downT = 0; pl.revive(0.5); }
    }
    pl.update(dt);
    // El mapa es el claro: el héroe no se va más allá (en la Arena, de su carril).
    const h = home();
    if (arena) {
      // Arena: dentro de su carril (con un poco de margen a los lados).
      pl.x = G.U.clamp(pl.x, h.x - MAZE_W / 2 - 80, h.x + MAZE_W / 2 + 80);
      pl.y = G.U.clamp(pl.y, h.y - MAZE_H / 2 - 80, h.y + MAZE_H / 2 + 80);
    } else {
      const far = Math.hypot(pl.x - h.x, pl.y - h.y);
      if (far > bound) { pl.x = h.x + (pl.x - h.x) * bound / far; pl.y = h.y + (pl.y - h.y) * bound / far; }
    }
    if (coop && G.Coop.active) for (const p of G.Coop.puppets()) { p.netUpdate(dt); G.Combat.ghostOrbit(p, dt, time); }
    // La cámara sigue al héroe, salvo si la has llevado a otro sitio con el minimapa (al mover al héroe, vuelve).
    if (pl.walking) camFree = null;
    G.Camera.follow(camFree ? camFree.x : pl.x, camFree ? camFree.y : pl.y, dt);
    G.World.update(dt, G.Camera);
  }

  /** Un paso de la partida entera (en solitario, o el anfitrión). */
  function step(dt: number) {
    time += dt;
    for (const path of paths) for (const p of path) p.level = pl.level;
    heroStep(dt);

    tickPhase(dt);
    if (Run.state !== 'playing') return;
    G.Spawner.tickBanner(dt);
    G.EnemyMgr.update(dt, everyone());
    G.EnemyMgr.rebuildGrid();
    march();
    trackEnemies(dt);
    if (placing && !ghostByPointer) { const g = snap(pl.x, pl.y); ghost.x = g.x; ghost.y = g.y; }

    aimAhead(pl);
    G.Combat.tick(dt, pl, time);
    applyAuras();
    for (const t of towers) {
      const p = t.p;
      p.update(dt);
      if (isSupport(t) || isWall(t)) continue;    // los de apoyo (y los muros de la Arena) no atacan
      // Sólo apunta a enemigos a su alcance (la lógica del héroe buscaba hasta 520
      // de distancia, y rocas o hierba si no había nadie), y elige según su modo.
      const tg = targetFor(p, t.mode);
      p.target = tg;
      if (tg) p.aim = Math.atan2(tg.y - p.y, tg.x - p.x);
      aimAhead(p);
      const group = p.activeGroup(), was = group.map(m => m.castAt);
      // Sin nadie a su alcance no ataca (las de área se lanzaban solas). Las órbitas sí: giran siempre.
      if (tg || group.some(m => m.kind === 'orbit')) G.Combat.tick(dt, p, time);
      group.forEach((m, i) => {
        if (m.castAt === was[i]) return;
        shots.set(p, (shots.get(p) || 0) + 1);
        // Los invitados lo repiten sin daño.
        if (coop) G.Coop.broadcast(['tc', t.id, m.id, m.lvl, Math.round(p.aim * 100) / 100, m.evolved ? 1 : 0]);
      });
    }
    critShots();
    G.Projectiles.update(dt, pl, G.EnemyMgr.all());
    G.Combat.resolve(dt, pl, time);
    G.Combat.updateFields(dt);
    G.Pickups.update(dt, everyone(), onCollect);
    G.Hazards.update(dt);
    G.FX.update(dt);

    if (coop && (stateT -= dt) <= 0) sendState();
    if (arena) arenaCheck();
    else if (lives <= 0) end(true);
  }

  /**
   * Anfitrión, Arena: caen a la vez todos los que se han quedado sin vidas (comparten puesto): fuera
   * sus torres y los enemigos de su carril. Si queda uno (o ninguno), se acaba.
   */
  function arenaCheck() {
    const down = lanes.filter(l => !l.out && l.lives <= 0);
    if (down.length) {
      outs++;
      for (const ln of down) {
        ln.lives = 0; ln.out = outs; ln.outWave = Math.max(1, wave);
        for (const t of towers.slice()) if (t.owner === ln.uid) {
          towers.splice(towers.indexOf(t), 1);
          G.Projectiles.clearOrbs(t.p);
          if (selected === t) selected = null;
          if (coop) G.Coop.broadcast(['tr', t.id]);
        }
        const L = lanes.indexOf(ln), list = G.EnemyMgr.all();
        for (let i = list.length - 1; i >= 0; i--) {
          const e = list[i];
          if (!(e instanceof Walker) || e.lane !== L) continue;
          list.splice(i, 1);
          if (coop && G.Coop.isHost) G.Coop.enemyGone(e, false);
        }
      }
      rebuildMazes();
      sendQ = sendQ.filter(q => !lanes[q.L].out);
      const left = lanes.filter(l => !l.out).length;
      const who = down.map(l => memberName(l.uid)).join(' y ');
      announce(left ? '¡' + who + (down.length > 1 ? ' han caído' : ' ha caído') + '! Quedan ' + left : '¡' + who + ' han caído a la vez!', 3);
      if (knockedOut()) { cancelPlacing(); selected = null; watchLane = Math.max(0, lanes.findIndex(l => !l.out)); }
      sendState();
      refreshUI();
    }
    if (lanes.filter(l => !l.out).length <= 1) end(true);
  }
  /** El apodo de un jugador de la sala (también el tuyo, no "Tú": el aviso lo ven todos). */
  function memberName(uid: string) { const m = coop && coop.members.find(x => x.uid === uid); return m ? m.name : '?'; }

  /**
   * Un paso en el invitado: tu héroe (sus golpes van al anfitrión), las copias de los
   * enemigos y de las torres (sus ataques llegan como 'tc'), y la cuenta atrás del descanso
   * (el anfitrión la corrige con cada 'tg').
   */
  function stepGuest(dt: number) {
    time += dt;
    // (Las copias de los enemigos las crea el cooperativo: también, sólo con golpes fuertes.)
    for (const e of G.EnemyMgr.all()) e.hurtAnimMin = HURT_ANIM_MIN;
    heroStep(dt);
    G.Spawner.tickBanner(dt);
    G.EnemyMgr.update(dt, everyone());
    G.EnemyMgr.rebuildGrid();
    trackEnemies(dt);
    if (placing && !ghostByPointer) { const g = snap(pl.x, pl.y); ghost.x = g.x; ghost.y = g.y; }
    if (!watching()) { aimAhead(pl); G.Combat.tick(dt, pl, time); }
    applyAuras();
    for (const t of towers) {
      t.p.update(dt);
      const m = t.p.activeMove();
      if (m && m.kind === 'orbit') G.Combat.ghostOrbit(t.p, dt, time);
    }
    G.Projectiles.update(dt, pl, G.EnemyMgr.all());
    G.Combat.resolve(dt, pl, time);
    G.Combat.updateFields(dt);
    if (!watching()) G.Pickups.update(dt, [pl], onCollect);
    G.Hazards.update(dt);
    G.FX.update(dt);
    if (phase === 'break' || arena) phaseT = Math.max(0, phaseT - dt);
  }

  function idle(dt: number) { G.FX.update(dt * 0.25); pl.anim.update(dt * 0.25); }

  // ---------------- cooperativo ----------------
  // Ver la cabecera: qué manda cada uno y los mensajes.

  /** Anfitrión: una torre para los invitados (nueva o cambiada). */
  const towerEv = (t: Tower): TdHostEv => ['tt', t.id, t.owner, t.dex, Math.round(t.p.x), Math.round(t.p.y), t.level, t.mode, t.shiny ? 1 : 0, t.base, t.spent, t.learned.slice()];
  function sendTower(t: Tower) { if (coop && G.Coop.isHost) G.Coop.broadcast(towerEv(t)); }
  /** Anfitrión: vidas, oleada, cuenta atrás, monedas de cada uno... */
  const stateEv = (): TdHostEv => ['tg', lives, wave, phase === 'wave' ? 1 : 0, Math.round(phaseT * 10) / 10,
                         toSpawn + bossLeft + G.EnemyMgr.all().filter(e => !e.dead).length,
                         fast ? 1 : 0, cleared, won ? 1 : 0, { ...purse }, leaked, pl.kills, lanes.map(l => [l.lives, l.out, l.income])];
  function sendState() {
    if (!coop || !G.Coop.isHost) return;
    stateT = 0.25;
    G.Coop.broadcast(stateEv());
  }

  /** Anfitrión: lo que pide un invitado. Se comprueba aquí (que sea suya, que le llegue...). */
  function onGuestEvent(from: string, ev: TdGuestEv) {
    if (Run.state !== 'playing' || !(from in purse)) return;
    const t = typeof ev[1] === 'number' ? towerById(ev[1]) : null;
    const his = !!t && t.owner === from;
    switch (ev[0]) {
      case 'tp': {
        const x = +ev[2], y = +ev[3];
        const why = Number.isFinite(x) && Number.isFinite(y) ? whyNotFor(from, x, y) : 'Ahí no';
        if (why) { G.Coop.broadcast(['tn', from, why]); break; }
        if (!plant(from, ev[1] | 0, x, y, !!ev[4], !!ev[5])) G.Coop.broadcast(['tn', from, 'Te faltan monedas']);
        break;
      }
      case 'tu': if (his) upgrade(t!); break;
      case 'ts': if (his) sell(t!); break;
      case 'tm': if (his && TARGET_MODES.includes(ev[2])) { t!.mode = ev[2]; sendTower(t!); refreshUI(); } break;
      case 'te': if (his) { const o = evoOf(t!); if (o && o.includes(ev[2])) evolve(t!, ev[2]); } break;
      case 'th': heroUp(from); break;
      case 'tw': callWave(); break;
      case 'tl': if (his && typeof ev[2] === 'string') learn(t!, ev[2]); break;
      case 'tk': if (arena && typeof ev[2] === 'string') doSend(from, ev[1] | 0, ev[2]); break;
    }
  }

  /** Invitado: lo que cuenta el anfitrión. */
  function onHostEvent(ev: TdHostEv) {
    switch (ev[0]) {
      case 'tt': upsertTower(ev); break;
      case 'tr': dropTower(ev[1]); break;
      case 'tz': for (const t of towers.slice()) dropTower(t.id); break;
      case 'tc': {
        const t = towerById(ev[1]);
        if (t) { G.Combat.ghostCast(t.p, ev[2], ev[3], ev[4], !!ev[5]); shots.set(t.p, (shots.get(t.p) || 0) + 1); }
        break;
      }
      case 'tv': {
        const t = towerById(ev[1]);
        if (t && mine(t) && Array.isArray(ev[2])) { pendingEvo = { tower: t, options: ev[2] }; selected = null; refreshUI(); }
        break;
      }
      case 'tg': {
        const was = wave;
        lives = ev[1]; wave = ev[2]; phase = ev[3] ? 'wave' : 'break'; phaseT = ev[4]; leftShown = ev[5];
        fast = !!ev[6]; cleared = ev[7]; won = !!ev[8]; purse = ev[9] || {}; leaked = ev[10]; pl.kills = ev[11] || 0;
        // Arena: las vidas de cada carril y quién ha caído.
        if (arena && Array.isArray(ev[12])) {
          const wasOut = knockedOut();
          ev[12].forEach((a: unknown, i: number) => {
            const l = lanes[i];
            if (l && Array.isArray(a)) { l.lives = +a[0] || 0; l.out = +a[1] || 0; l.income = +a[2] || 0; }
          });
          if (!wasOut && knockedOut()) { cancelPlacing(); selected = null; watchLane = Math.max(0, lanes.findIndex(l => !l.out)); hudKey = ''; }
        }
        if (wave !== was) preloadWave(wave + 1);
        break;
      }
      case 'tb': { const e = G.EnemyMgr.get(ev[1]); if (e) bigger(e, ev[2]); break; }
      case 'th': if (ev[1] === me) heroGot(ev[2]); break;
      case 'tn': if (ev[1] === me) { G.Spawner.say(ev[2], 1.6, true); G.Audio.sfx('back'); wantSelect = null; } break;
      case 'tx': G.FX.dmgText(ev[1], ev[2], ev[3], ev[4], true); break;
      case 'tq': unlockTrophy(ev[1]); break;
    }
  }

  /** Invitado: una torre nueva o que ha cambiado (nivel, evolución, dueño, modo). */
  function upsertTower(a: Extract<TdHostEv, [kind: 'tt', ...unknown[]]>) {
    const [, id, owner, dex, x, y, level, mode, shiny, base, spent] = a;
    const learned: string[] = Array.isArray(a[11]) ? a[11].filter((m: unknown) => typeof m === 'string' && G.Moves.BY_ID[m as string]) : [];
    if (!G.DEX_BY[dex]) return;
    let t = towerById(id);
    if (!t) {
      const p = makeTower(dex, !!shiny);
      p.x = x; p.y = y;
      t = { id, owner, p, dex, shiny: !!shiny, level: 1, base, spent, mode, atk: p.atkMul, buff: noBuff(), learned: [] };
      towers.push(t);
      G.Sprites.preload([dex], 4000, p.shiny);
      G.FX.ring(x, y, 8, 110, G.U.TYPE_COLOR[G.DEX_BY[dex].types[0]], 0.6, 5);
      // La que acabas de pedir: queda seleccionada, como en solitario.
      if (owner === me && wantSelect && G.U.dist2(x, y, wantSelect.x, wantSelect.y) < 4) { selected = t; wantSelect = null; }
    } else if (t.dex !== dex) {
      // Ha evolucionado.
      const p = makeTower(dex, !!shiny);
      p.x = t.p.x; p.y = t.p.y;
      G.Projectiles.clearOrbs(t.p);
      t.p = p; t.dex = dex; t.level = 1; t.atk = p.atkMul;
      t.learned = [];                                  // se le vuelven a enseñar abajo, al nivel de ahora
      G.Sprites.preload([dex], 4000, p.shiny);
      evolveFx(p);
      if (pendingEvo && pendingEvo.tower === t) pendingEvo = null;
    } else if (level > t.level) G.FX.ring(t.p.x, t.p.y, 8, 90, G.U.TYPE_COLOR[G.DEX_BY[dex].types[0]], 0.6, 5);
    while (t.level < level) { t.level++; levelMove(t.p); t.atk *= 1.12; }
    t.owner = owner; t.mode = mode; t.base = base; t.spent = spent; t.shiny = !!shiny;
    rebuildMazes();
    // Los ataques aprendidos (la copia sólo los necesita para las órbitas y el panel).
    for (const m of learned) if (!t.learned.includes(m)) { t.learned.push(m); teach(t.p, m, t.level); }
    refreshUI();
  }
  function dropTower(id: number) {
    const t = towerById(id);
    if (!t) return;
    towers.splice(towers.indexOf(t), 1);
    rebuildMazes();
    G.Projectiles.clearOrbs(t.p);
    if (selected === t) selected = null;
    if (pendingEvo && pendingEvo.tower === t) pendingEvo = null;
    refreshUI();
  }

  /** Anfitrión: lo que necesita un invitado que vuelve tras un corte (va detrás de los enemigos). */
  function resyncFor(u: string): HostEv[] {
    const evs: HostEv[] = [['tz'], ...trophies.map((d): TdHostEv => ['tq', d])];
    for (const t of towers) evs.push(towerEv(t));
    for (const e of G.EnemyMgr.all()) if (!e.dead && e instanceof Walker && e.chief) evs.push(['tb', e.id, e.kind]);
    for (const t of towers) { const o = evoOf(t); if (o && t.owner === u) evs.push(['tv', t.id, o]); }
    if ((heroLv[u] || 1) > 1) evs.push(['th', u, heroLv[u]]);
    evs.push(stateEv());
    return evs;
  }

  /** Lo que el cooperativo (net/coop.ts) necesita de este modo. */
  const coopApi = {
    team: () => ({ time, level: pl.level, xp: 0, xpNext: 1, kills: pl.kills, bosses: 0, coins: 0, t1: 0, t10: 0 }),
    summary: () => summary(false),
    // Invitado: el reloj del anfitrión.
    syncTeam(t: TeamState) { if (Math.abs(t.time - time) > 0.4) time = t.time; },
    // (Sin cartas de nivel, ni objetos, ni shinies en la Defensa.)
    levelStart() {}, waiting() {}, resume() {}, shiny() {}, item() {},
    // Invitado: el anfitrión no responde; mientras, los enemigos están parados (los mueve él).
    away(name: string | null) { hostAway = name; hudKey = ''; },
    over(d: Partial<ReturnType<typeof summary>> & { why?: string } | null) {
      if (d && d.why === 'host') G.UI.toast('El anfitrión ha terminado la partida', 3000);
      finish(d && typeof d.w === 'number' ? d as ReturnType<typeof summary> : summary(false), !(d && d.why === 'host'));
    },
    lost(msg: string) { G.UI.toast(msg, 3000); finish(summary(false), false); },
    /** Anfitrión: un compañero se ha ido para siempre; sus torres pasan a ser tuyas (siguen defendiendo). */
    mateLeft(m: Mate) {
      // Arena: quien se va cae (sus torres y sus enemigos, fuera; la comprobación lo hace en el paso).
      if (arena) { const l = lanes[laneIx(m.uid)]; if (l && !l.out) l.lives = 0; return; }
      let n = 0;
      for (const t of towers) {
        if (t.owner !== m.uid) continue;
        t.owner = me; n++;
        const o = evoOf(t);
        if (o && !pendingEvo) pendingEvo = { tower: t, options: o };
        sendTower(t);
      }
      if (n) announce('Las torres de ' + m.name + ' pasan al anfitrión', 3);
      refreshUI();
    },
    onEvent(from: string, ev: TdHostEv | TdGuestEv) { if (G.Coop.isHost) onGuestEvent(from, ev as TdGuestEv); else onHostEvent(ev as TdHostEv); },
    resync: resyncFor,
  };

  // ---------------- teclado ----------------

  /** Esc mientras colocas: suelta la torre (en vez de pausar). */
  function keysModal() {
    if (placing && Run.state === 'playing' && G.Input.tap('escape')) { cancelPlacing(); return true; }
    return false;
  }

  function keysPlay() {
    // Espectador: cambiar a quién mira, y el minimapa.
    if (watching()) {
      G.Spectate.keys();
      if (G.Input.tap('keyc')) camFree = null;
      if (G.Input.tap('keym')) toggleMap();
      return;
    }
    // Arena, ya fuera: Q/E o Tab cambian de carril (los que siguen en pie); M, el minimapa.
    if (knockedOut()) {
      const up = lanes.map((l, i) => (l.out ? -1 : i)).filter(i => i >= 0);
      const step = G.Input.tap('keyq') ? -1 : G.Input.tap('keye') || G.Input.tap('tab') ? 1 : 0;
      if (step && up.length) { const k = up.indexOf(watchLane); watchLane = up[((k < 0 ? 0 : k + step) + up.length) % up.length]; camFree = null; hudKey = ''; }
      if (G.Input.tap('keym')) toggleMap();
      return;
    }
    if (placing && (G.Input.tap('enter') || G.Input.tap('space') || G.Input.tap('numpadenter'))) tryPlace(ghost.x, ghost.y, shiftHeld());
    // R: otra vez la última torre que compraste, sin ir a la tienda.
    if (G.Input.tap('keyr') && lastDex && !placing) startPlacing(lastDex);
    if (G.Input.tap('keyn')) callWave();
    if (G.Input.tap('keyf')) toggleFast();
    if (G.Input.tap('keyc')) camFree = null;                                  // la cámara, de vuelta al héroe
    if (G.Input.tap('keym')) toggleMap();
    for (let i = 0; i < 4; i++) {
      if (G.Input.tap('digit' + (i + 1)) || G.Input.tap('numpad' + (i + 1))) pl.setActive(i);
    }
    if (G.Input.tap('keyq')) pl.cycle(-1);
    if (G.Input.tap('keye') || G.Input.tap('tab')) pl.cycle(1);
  }

  /** ×1 / ×2 (en grupo, sólo el anfitrión: la partida va a su ritmo). */
  function toggleFast() {
    if (guest()) return;
    fast = !fast; G.Audio.sfx('confirm'); hudKey = '';
    sendState();
  }
  /** Tras la victoria (en el sin fin): terminar y cobrar. En grupo la termina el anfitrión. */
  function finishWon() { if (won && hosting() && Run.state === 'playing') end(false); }

  // ---------------- interfaz ----------------
  // Arriba: oleada, vidas y monedas. Izquierda: la tienda. Derecha: la torre
  // seleccionada. Abajo: qué se está colocando y por qué no se puede ahí.

  let hud: HTMLElement | null = null, shop: HTMLElement | null = null, panel: HTMLElement | null = null, tip: HTMLElement | null = null;
  /** Arena: el panel de envíos (a quién, qué y tus ingresos). */
  let sendBox: HTMLElement | null = null;
  /** El minimapa (abajo a la derecha) y su lienzo. */
  let mapBox: HTMLElement | null = null, mapCv: HTMLCanvasElement | null = null;
  let mapOpen = true;
  /** Punto del mundo al que has llevado la cámara con el minimapa, o null (sigue al héroe). */
  let camFree: { x: number; y: number } | null = null;
  /** Qué enseña la tienda: favoritos, todos, o un tipo. */
  let shopFilter = 'all';
  /** Lo escrito en el buscador de la tienda. */
  let shopText = '';
  /** ¿El Pokémon `dex` casa con lo buscado? Por nombre (sin tildes ni mayúsculas) o por número ("25", "#025"). */
  function matches(dex: number, text: string) {
    const q = G.DexQuery.norm(text.trim()).replace(/^#/, '');
    if (!q) return true;
    if (/^\d+$/.test(q)) return String(dex).includes(String(+q));
    const mon = G.DEX_BY[dex];
    return !!mon && G.DexQuery.norm(mon.name).includes(q);
  }
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
      #td-send { position: fixed; right: 8px; top: 64px; z-index: 30; width: 214px; padding: 8px; max-height: calc(100vh - 260px); overflow: auto; }
      #td-send h3 { margin: 0 0 6px; font-size: 15px; }
      #td-send .td-send-list { display: flex; flex-direction: column; gap: 4px; }
      #td-send .td-slot { display: flex; align-items: center; gap: 6px; text-align: left; width: 100%; }
      #td-send .td-slot span { display: flex; flex-direction: column; line-height: 1.1; }
      #td-send .td-send-to { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
      #td-send .td-send-to button { padding: 2px 7px; font-size: 12px; }
      #td-send .td-send-to button.on { outline: 2px solid var(--gold); }
      #td-send p { margin: 6px 0 0; font-size: 12px; }
      #td-hud .td-money.bump b { animation: td-bump .35s; }
      #td-hud .td-lives.low b { color: #ff5f6d; }
      #td-hud .td-wave { max-width: 260px; text-align: center; line-height: 1.15; }
      #td-hud .td-wave b { display: block; font-size: 15px; }
      #td-hud .td-wave small { color: var(--muted); font-size: 12px; }
      #td-hud .td-team { display: flex; flex-direction: column; font-size: 12px; line-height: 1.2; }
      #td-hud .td-team b { color: var(--gold); }
      #td-hud .td-watch-hide { display: none !important; }
      @keyframes td-bump { 0% { transform: scale(1); } 40% { transform: scale(1.35); } 100% { transform: scale(1); } }
      #td-shop { position: fixed; left: 8px; top: 96px; z-index: 30; width: 214px; padding: 8px; display: flex; flex-direction: column; gap: 6px; max-height: calc(100vh - 150px); }
      #td-shop h3 { margin: 0; font-size: 16px; display: flex; justify-content: space-between; align-items: center; }
      #td-shop .td-filters { display: flex; flex-wrap: wrap; gap: 4px; }
      .td-find { font: inherit; font-size: 13px; padding: 5px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,.25);
        background: rgba(10,20,48,.6); color: var(--ink); width: 100%; box-sizing: border-box; }
      #td-team .td-find { margin: 8px 0 4px; }
      #td-shop.closed .td-find { display: none; }
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
      .td-slot .td-trophy { color: #ffb03b; font-size: 11px; }
      .td-type { display: inline-block; font-style: normal; font-size: 11px; padding: 1px 6px; border-radius: 6px; font-weight: 700; line-height: 15px;
                 text-shadow: none; letter-spacing: .3px; white-space: nowrap; }
      #td-shop .td-more { font-size: 12px; color: var(--muted); text-align: center; }
      #td-panel { position: fixed; right: 8px; top: 96px; z-index: 30; width: min(270px, 46vw); padding: 12px;
                  max-height: calc(100vh - 110px); overflow-y: auto; }
      #td-map { position: fixed; right: 8px; bottom: 90px; z-index: 30; padding: 6px; display: flex; flex-direction: column; gap: 4px; align-items: stretch; }
      #td-map canvas { width: 170px; height: 170px; cursor: crosshair; touch-action: none; display: block; }
      #td-map button { font-size: 11px; padding: 2px 6px; }
      #td-map.closed { padding: 4px; }
      #td-map.closed canvas, #td-map.closed button:not(.td-map-toggle) { display: none !important; }
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
        #td-map canvas { width: 120px; height: 120px; }
      }
      /* Móvil en horizontal: poco alto, el minimapa pequeño y pegado abajo. */
      @media (max-height: 520px) {
        #td-map { bottom: 8px; padding: 4px; }
        #td-map canvas { width: 96px; height: 96px; }
        #td-map button { font-size: 10px; padding: 1px 4px; }
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
      <button class="btn small" data-a="fast" title="Velocidad (F)"></button>
      <button class="btn small" data-a="won" title="Terminar y cobrar el premio">Terminar</button>
      <div class="td-team" data-k="team"></div>`;
    (hud.querySelector('[data-a=next]') as HTMLElement).onclick = () => callWave();
    (hud.querySelector('[data-a=fast]') as HTMLElement).onclick = () => toggleFast();
    (hud.querySelector('[data-a=won]') as HTMLElement).onclick = () => finishWon();

    shop = document.createElement('div');
    shop.id = 'td-shop';
    shop.className = 'box' + (shopOpen ? '' : ' closed');
    shop.innerHTML = `<h3>Tienda <button class="btn small ghost" data-a="toggle"></button></h3>
      <input type="search" class="td-find" placeholder="Buscar…" aria-label="Buscar Pokémon"><div class="td-filters"></div><div class="td-list"></div>`;
    const find = shop.querySelector('.td-find') as HTMLInputElement;
    find.value = shopText;
    find.oninput = () => { shopText = find.value; buildShop(); };
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
    buildMap();
    // Arena: el panel de envíos.
    sendBox = null;
    if (arena && !watching()) {
      sendBox = document.createElement('div');
      sendBox.id = 'td-send';
      sendBox.className = 'box';
      sendBox.innerHTML = `<h3>Enviar</h3><div class="td-send-to" data-k="to"></div><div class="td-send-list"></div><p class="sub" data-k="inc"></p>`;
      const list = sendBox.querySelector('.td-send-list') as HTMLElement;
      SENDS.forEach((sd, k) => {
        const b = document.createElement('button');
        b.className = 'btn small td-slot'; b.dataset.send = String(k);
        b.title = G.DEX_BY[sd.dex].name + (sd.fly ? ' · vuela: no sigue el laberinto' : '') + ' · +' + sd.income + ' de ingresos por oleada';
        b.appendChild(G.UI.spriteCanvas(sd.dex, 34, 30, { scale: 1 }));
        b.insertAdjacentHTML('beforeend', `<span><b>${sd.n > 1 ? sd.n + '× ' : ''}${G.DEX_BY[sd.dex].name}</b><em style="font-style:normal"><span class="td-cost" style="display:inline">${sd.cost}</span> · +${sd.income}${sd.fly ? ' · vuela' : ''}</em></span>`);
        b.onclick = e => { e.stopPropagation(); send(k); };
        list.appendChild(b);
      });
      G.Sprites.preload(SENDS.map(sd => sd.dex), 4000);
    }
    // Espectador: sólo se mira (sin tienda ni panel ni monedas propias).
    if (watching()) {
      shop.style.display = 'none'; panel.style.display = 'none'; tip.style.display = 'none';
      for (const sel of ['.td-money', '[data-a=next]', '[data-a=fast]', '[data-a=won]']) {
        const el = hud.querySelector(sel) as HTMLElement | null;
        if (el) el.classList.add('td-watch-hide');
      }
    }
    for (const el of [hud, shop, panel, tip, mapBox!, ...(sendBox ? [sendBox] : [])]) {
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
    // Con texto en el buscador se busca en toda la tienda (el filtro de tipo no cuenta).
    // En favoritos salen también los trofeos que vas ganando.
    let items = shopText.trim() ? pool.filter(c => matches(c.dex, shopText))
              : shopFilter === 'fav' ? [...team.map(dex => ({ dex, lent: false, trophy: false })), ...pool.filter(c => c.trophy)]
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
      const chip = arena && c.dex === WALL_DEX ? tag('#8a7a5a', 'Muro') : k ? auraChip(k) : typeChip(t);
      if (arena && c.dex === WALL_DEX) b.title = mon.name + ' · Muro: no ataca, sólo corta el paso (para hacer el laberinto)';
      b.insertAdjacentHTML('beforeend', `<span><b>${mon.name}</b><em style="font-style:normal">${chip} <span class="td-cost" style="display:inline">${costOf(c.dex)}</span>${c.trophy ? ' <small class="td-trophy">trofeo</small>' : ''}</em></span>`);
      b.onclick = e => { e.stopPropagation(); startPlacing(c.dex); };
      list.appendChild(b);
    }
    if (more > 0) list.insertAdjacentHTML('beforeend', `<p class="td-more">y ${more} más: busca o filtra por tipo</p>`);
    else if (!items.length) list.insertAdjacentHTML('beforeend', '<p class="td-more">Ninguno se llama así</p>');
    refreshUI();
  }

  function hideUI() {
    for (const id of ['td-hud', 'td-shop', 'td-panel', 'td-tip', 'td-bar', 'td-map', 'td-send']) { const el = document.getElementById(id); if (el) el.remove(); }
    hud = shop = panel = tip = mapBox = sendBox = null; mapCv = null;
  }

  // ---------------- minimapa ----------------
  // Todo el claro de un vistazo: el camino, las torres, los enemigos y los héroes, y un recuadro
  // con lo que ves. Pulsando (o arrastrando) en él, la cámara va allí sin mover al héroe; vuelve
  // al mover al héroe, con C o con el botón. M lo esconde.

  /** Radio del mundo que cabe en el minimapa (el claro entero: la entrada queda un poco fuera del borde). */
  const mapR = () => (arena ? MAZE_H / 2 + 100 : CLEAR * G.World.TS);
  /** El centro del minimapa: el del mapa; en la Arena, el del carril más cerca de la cámara (el que miras). */
  function mapCenter() {
    if (!arena) return { x: 0, y: 0 };
    let best = lanes[0], bd = Infinity;
    for (const l of lanes) { const d = G.U.dist2(l.cx, l.cy, G.Camera.x, G.Camera.y); if (d < bd) { bd = d; best = l; } }
    return best ? { x: best.cx, y: best.cy } : { x: 0, y: 0 };
  }

  function buildMap() {
    mapBox = document.createElement('div');
    mapBox.id = 'td-map';
    mapBox.className = 'box';
    mapCv = document.createElement('canvas');
    mapCv.title = 'Pulsa para mirar allí (M esconde el mapa)';
    const back = document.createElement('button');
    back.className = 'btn small ghost';
    back.textContent = G.Touch.active ? 'Volver al héroe' : 'Volver al héroe (C)';
    back.onclick = () => { camFree = null; };
    // Esconderlo y volver a sacarlo con un botón (en el móvil no hay tecla M).
    const hide = document.createElement('button');
    hide.className = 'btn small ghost td-map-toggle';
    hide.onclick = () => toggleMap();
    mapBox.append(mapCv, back, hide);
    paintMap();
    mapBox.addEventListener('pointerdown', e => e.stopPropagation());
    // Pulsar o arrastrar: la cámara a ese punto.
    let dragging = false;
    const go = (e: PointerEvent) => {
      const r = mapCv!.getBoundingClientRect(), R = mapR(), c = mapCenter();
      let x = ((e.clientX - r.left) / r.width * 2 - 1) * R, y = ((e.clientY - r.top) / r.height * 2 - 1) * R;
      const d = Math.hypot(x, y);
      if (d > R) { x *= R / d; y *= R / d; }
      camFree = { x: c.x + x, y: c.y + y };
    };
    mapCv.addEventListener('pointerdown', e => {
      if (G.Pings.available() && (G.Pings.armed || e.altKey)) {
        const r = mapCv!.getBoundingClientRect(), R = mapR(), c = mapCenter();
        G.Pings.send(c.x + ((e.clientX - r.left) / r.width * 2 - 1) * R, c.y + ((e.clientY - r.top) / r.height * 2 - 1) * R);
        return;
      }
      dragging = true; mapCv!.setPointerCapture(e.pointerId); go(e);
    });
    mapCv.addEventListener('pointermove', e => { if (dragging) go(e); });
    const stop = () => { dragging = false; };
    mapCv.addEventListener('pointerup', stop);
    mapCv.addEventListener('pointercancel', stop);
  }

  /** Abre o esconde el minimapa: escondido, sólo queda un botón «Mapa». */
  function toggleMap() { mapOpen = !mapOpen; paintMap(); }
  function paintMap() {
    if (!mapBox) return;
    mapBox.classList.toggle('closed', !mapOpen);
    const b = mapBox.querySelector('.td-map-toggle');
    if (b) b.textContent = (mapOpen ? 'Ocultar mapa' : 'Mapa') + (G.Touch.active ? '' : ' (M)');
  }

  /** Pinta el minimapa (cada fotograma: son unos pocos puntos). */
  function drawMap() {
    if (!mapCv || !mapOpen || !pl) return;
    const css = mapCv.getBoundingClientRect().width || 170, dpr = Math.min(2, window.devicePixelRatio || 1);
    const S = Math.round(css * dpr);
    if (mapCv.width !== S) { mapCv.width = S; mapCv.height = S; }
    const ctx = mapCv.getContext('2d')!, R = mapR(), k = S / (2 * R), c = mapCenter();
    const X = (x: number) => S / 2 + (x - c.x) * k, Y = (y: number) => S / 2 + (y - c.y) * k;
    ctx.clearRect(0, 0, S, S);
    if (arena) {
      // Arena: los carriles (el que miras, en el centro): su laberinto y la ruta de ahora.
      for (const l of lanes) {
        ctx.globalAlpha = l.out ? 0.35 : 1;
        ctx.fillStyle = 'rgba(150, 118, 76, 0.9)'; ctx.fillRect(X(l.cx - MAZE_W / 2), Y(l.cy - MAZE_H / 2), MAZE_W * k, MAZE_H * k);
        ctx.fillStyle = '#ff5f6d'; ctx.fillRect(X(l.cx - MAZE_W / 2), Y(l.cy - MAZE_H / 2), MAZE_W * k, 3 * dpr);
        ctx.fillStyle = '#4fb4ff'; ctx.fillRect(X(l.cx - MAZE_W / 2), Y(l.cy + MAZE_H / 2) - 3 * dpr, MAZE_W * k, 3 * dpr);
      }
      ctx.globalAlpha = 1;
    } else {
      // El claro y su borde (hasta donde se puede construir).
      ctx.fillStyle = 'rgba(40, 90, 50, 0.9)';
      ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'; ctx.lineWidth = 1; ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.arc(S / 2, S / 2, bound * k, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
      // Los caminos, sus entradas y la base.
      for (const path of paths) {
        if (path.length < 2) continue;
        ctx.strokeStyle = 'rgba(214, 186, 132, 0.95)'; ctx.lineWidth = Math.max(2, 42 * k); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(X(path[0].x), Y(path[0].y)); for (const p of path) ctx.lineTo(X(p.x), Y(p.y)); ctx.stroke();
      }
      for (const path of paths) {
        if (path.length < 2) continue;
        const a = path[0], b = path[path.length - 1];
        ctx.fillStyle = '#ff5f6d'; ctx.beginPath(); ctx.arc(X(a.x), Y(a.y), 3.5 * dpr, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#4fb4ff'; ctx.beginPath(); ctx.arc(X(b.x), Y(b.y), 4.5 * dpr, 0, 6.2832); ctx.fill();
      }
    }
    // Las torres: del color de su ataque (los apoyos, dorados) y, en grupo, con el de su dueño alrededor.
    for (const t of towers) {
      const x = X(t.p.x), y = Y(t.p.y), s = 3 * dpr;
      const oc = colorOf(t.owner);
      if (oc) { ctx.fillStyle = oc; ctx.fillRect(x - s - dpr, y - s - dpr, (s + dpr) * 2, (s + dpr) * 2); }
      ctx.fillStyle = SUPPORT[t.dex] ? '#ffd23f' : typeColor(attackType(t.dex)) || '#ffffff';
      ctx.fillRect(x - s, y - s, s * 2, s * 2);
    }
    // Los enemigos (los jefes, más grandes).
    for (const e of G.EnemyMgr.all() as TdEnemy[]) {
      if (e.dead) continue;
      const big = !!e.tdKind || (e instanceof Walker && e.chief);
      ctx.fillStyle = big ? '#ffcb3d' : '#ff3b4e';
      ctx.beginPath(); ctx.arc(X(e.x), Y(e.y), (big ? 4 : 2) * dpr, 0, 6.2832); ctx.fill();
    }
    // Los héroes: tú en blanco; los compañeros, de su color.
    for (const h of everyone()) {
      if (!h) continue;
      ctx.fillStyle = h === pl ? '#ffffff' : (h.tagColor || '#9ae6ff');
      ctx.strokeStyle = '#10131c'; ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.arc(X(h.x), Y(h.y), 3.5 * dpr, 0, 6.2832); ctx.fill(); ctx.stroke();
    }
    // Las señales de los compañeros (net/ping.ts): un anillo que late, de su color.
    const beat = (performance.now() % 600) / 600;
    for (const g of G.Pings.list) {
      ctx.strokeStyle = g.color; ctx.lineWidth = 2 * dpr; ctx.globalAlpha = 1 - beat * 0.6;
      ctx.beginPath(); ctx.arc(X(g.x), Y(g.y), (4 + beat * 6) * dpr, 0, 6.2832); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Lo que se ve ahora.
    ctx.strokeStyle = camFree ? '#ffd23f' : 'rgba(255, 255, 255, 0.8)'; ctx.lineWidth = 1.5 * dpr;
    ctx.strokeRect(X(G.Camera.left()), Y(G.Camera.top()), G.Camera.w * k, G.Camera.h * k);
    // Con el panel de una torre abierto, el minimapa se pone a su izquierda (si no, lo tapaba); en una
    // pantalla estrecha (móvil) no cabe al lado: se esconde hasta que cierras el panel.
    const open = !!panel && panel.style.display !== 'none';
    const side = open ? panel!.offsetWidth + 16 : 8;
    if (mapBox) {
      if (mapBox.style.right !== side + 'px') mapBox.style.right = side + 'px';
      const hide = open && window.innerWidth < 1000;
      mapBox.style.opacity = hide ? '0' : '';
      mapBox.style.pointerEvents = hide ? 'none' : '';
    }
    // El botón de volver, sólo si la cámara no está en el héroe.
    const back = mapBox && mapBox.querySelector('button') as HTMLElement | null;
    if (back) back.style.display = camFree ? '' : 'none';
  }

  /** Vuelve a pintar la tienda (qué se puede pagar), el panel y el marcador de monedas. */
  function refreshUI() {
    const money = cash();
    const gained = shownMoney >= 0 && money > shownMoney;
    shownMoney = money;
    if (!shop || !panel || !hud) return;
    const mEl = hud.querySelector('[data-k=money]') as HTMLElement;
    mEl.textContent = String(money);
    if (gained) { const box = mEl.parentElement!; box.classList.remove('bump'); void box.offsetWidth; box.classList.add('bump'); }
    shop.querySelectorAll<HTMLButtonElement>('.td-slot').forEach(b => {
      const dex = +b.dataset.dex!;
      b.disabled = money < costOf(dex) && !(placing && placing.dex === dex);
      b.classList.toggle('on', !!placing && placing.dex === dex);
    });
    paintPanel();
    paintSend();
    tipKey = '-';                 // se repinta el aviso de abajo en el próximo fotograma
  }

  /** Arena: el panel de envíos (qué se puede pagar, a quién y tus ingresos). */
  let sendKey = '';
  function paintSend() {
    if (!sendBox) return;
    sendBox.style.display = knockedOut() ? 'none' : '';
    const money = cash();
    sendBox.querySelectorAll<HTMLButtonElement>('[data-send]').forEach(b => { b.disabled = money < SENDS[+b.dataset.send!].cost; });
    const to = sendTarget(me, sendTo), ln = myLane();
    const key = to + '|' + lanes.map(l => l.out + ':' + l.lives).join(',') + '|' + (ln ? ln.income : 0) + '|' + wave;
    if (key === sendKey) return;
    sendKey = key;
    const box = sendBox.querySelector('[data-k=to]') as HTMLElement;
    box.innerHTML = '<span class="sub">A:</span>';
    for (const l of lanes) {
      if (l.uid === me || l.out) continue;
      const b = document.createElement('button');
      b.className = 'btn small' + (l.uid === to ? ' on' : '');
      b.style.color = colorOf(l.uid) || '';
      b.textContent = memberName(l.uid) + ' ♥' + l.lives;
      b.onclick = e => { e.stopPropagation(); sendTo = l.uid; sendKey = ''; paintSend(); };
      box.appendChild(b);
    }
    (sendBox.querySelector('[data-k=inc]') as HTMLElement).textContent =
      G.I18n.f('Cada oleada cobras {x} + {x} de ingresos', waveBonus(Math.max(1, wave)), ln ? ln.income : 0);
  }

  /** Botones para enseñar a la torre los ataques que le faltan (o por qué no puede). */
  function learnButtons(t: Tower, money: number) {
    if (t.learned.length >= LEARN_MAX) return `<p>Ya sabe todos los ataques que puede aprender</p>`;
    const can = learnable(t);
    if (!can.length) return `<p>No tiene más ataques que aprender</p>`;
    const c = learnCost(t);
    return `<p class="role"><b>Enseñarle (${t.learned.length}/${LEARN_MAX}):</b></p>` + can.map(id => {
      const d = G.Moves.BY_ID[id];
      return `<button class="btn small" data-learn="${id}"${money < c ? ' disabled' : ''} title="${d.desc || ''}">${d.name} · ${c}</button>`;
    }).join('');
  }

  /** Panel de la derecha: elegir evolución > torre seleccionada > héroe > nada. */
  function paintPanel() {
    if (!panel) return;
    const money = cash();
    if (pendingEvo) {
      const t = pendingEvo.tower;
      panel.style.display = '';
      panel.innerHTML = `<h3>${G.DEX_BY[t.dex].name} va a evolucionar</h3><p>Elige en qué:</p>`;
      for (const d of pendingEvo.options) {
        const b = document.createElement('button');
        b.className = 'btn small gold';
        const r = powerOf(d, t.level);
        b.innerHTML = `${G.DEX_BY[d].name} ${SUPPORT[d] ? auraChip(SUPPORT[d]) : typeChip(attackType(d))}${r ? ' · ' + r.name : ''}`;
        b.onclick = () => chooseEvo(t, d);
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
    } else if (isWall(selected)) {
      // Arena: un muro (Sudowoodo) sólo estorba: se vende, y nada más.
      const t = selected;
      panel.innerHTML = `<h3>${G.DEX_BY[t.dex].name} · muro</h3>
        <p>No ataca: corta el paso para alargar el laberinto.</p>
        ${mine(t) ? `<button class="btn small" data-a="sell">Vender · +${sellValue(t.spent)}</button>` : ''}
        <button class="btn small ghost" data-a="close">Cerrar</button>`;
      if (mine(t)) (panel.querySelector('[data-a=sell]') as HTMLElement).onclick = () => sell(t);
    } else {
      const t = selected;
      const c = upgradeCost(t.base, t.level);
      const m = t.p.activeMove();
      const at = attackType(t.dex), r = powerOf(t.dex, t.level), k = SUPPORT[t.dex];
      const evo = evolutionsOf(t.dex);
      const nextEvo = evo.length && t.level < MAX_LEVEL && evolvesAt(t.level + 1);
      // En grupo: sólo su dueño la mejora, la vende o cambia a quién ataca.
      const own = mine(t), col = colorOf(t.owner);
      // Las auras que recibe, en palabras.
      const got = AURA_KINDS.filter(a => t.buff[a] > 0).map(a => '+' + Math.round(t.buff[a] * 100) + '% ' + AURAS[a].what);
      panel.innerHTML = `<h3>${G.DEX_BY[t.dex].name}</h3>
        ${coop ? `<p>${own ? 'Es tuya' : `Dueño: <b translate="no" style="color:${col || 'inherit'}">${esc(nameOf(t.owner))}</b>`}</p>` : ''}
        <p>${k ? auraChip(k) : typeChip(at)} Nivel ${t.level}/${MAX_LEVEL}${k ? ' · radio ' + auraRadius(t.level) : (m ? ' · ' + m.name : '') + ' · alcance ' + reachWord(rangeOf(t.p))}</p>
        ${r ? `<p class="role"><b>${r.name}:</b> ${r.desc}</p>` : ''}
        ${k && t.level < MAX_LEVEL ? `<p>Al mejorarlo: ${auraText(k, t.level + 1)}</p>` : ''}
        ${got.length ? `<p class="role" style="color:var(--gold)">Reforzada: ${got.join(', ')}</p>` : ''}
        ${own && nextEvo ? `<p class="gold">La próxima mejora lo hace evolucionar${evo.length > 1 ? ' (eliges en qué)' : ' a ' + G.DEX_BY[evo[0]].name}</p>` : ''}
        ${k ? '' : `<p>Ataques: ${t.p.activeGroup().map(x => x.name).join(', ')}</p>`}
        ${own && !k ? learnButtons(t, money) : ''}
        ${own ? `<button class="btn small gold" data-a="up"${c == null || money < c ? ' disabled' : ''}>${c == null ? 'Al máximo' : 'Mejorar · ' + c}</button>
        ${k ? '' : `<button class="btn small" data-a="mode">Ataca a: ${TARGET_NAME[t.mode]}</button>`}
        <button class="btn small" data-a="sell">Vender · +${sellValue(t.spent)}</button>` : (k ? '' : `<p>Ataca a: ${TARGET_NAME[t.mode]}</p>`)}
        <button class="btn small ghost" data-a="close">Cerrar</button>`;
      if (own) {
        panel.querySelectorAll<HTMLElement>('[data-learn]').forEach(b => { b.onclick = () => learn(t, b.dataset.learn!); });
        (panel.querySelector('[data-a=up]') as HTMLElement).onclick = () => upgrade(t);
        if (!k) (panel.querySelector('[data-a=mode]') as HTMLElement).onclick = () => cycleMode(t);
        (panel.querySelector('[data-a=sell]') as HTMLElement).onclick = () => sell(t);
      }
    }
    (panel.querySelector('[data-a=close]') as HTMLElement).onclick = () => { selected = null; refreshUI(); };
  }

  /** Marcador y aviso de abajo: se repintan sólo si cambia lo que dicen. */
  let hudKey = '', tipKey = '';
  function paintHud() {
    if (!hud || !tip) return;
    // En el invitado, los que quedan los cuenta el anfitrión.
    const left = guest() ? leftShown : toSpawn + bossLeft + G.EnemyMgr.all().filter(e => !e.dead).length;
    const next = waveAt(wave + 1), cur = waveAt(Math.max(1, wave));
    // Hasta la victoria, "oleada n/30"; en el sin fin, sólo el número.
    const of = (n: number) => n > LAST_WAVE || arena ? String(n) : n + '/' + LAST_WAVE;       // (la Arena no acaba en la 30)
    const myLives = arena ? Math.max(0, (myLane() || { lives: 0 }).lives) : lives;
    const watched = knockedOut() && lanes[watchLane] ? memberName(lanes[watchLane].uid) : '';
    const title = guest() && hostAway ? `Esperando a ${hostAway}…`
      : knockedOut() ? `Has caído · mirando a ${watched}` + (G.Touch.active ? '' : ' (Q/E)')
      : arena && phase === 'wave' ? `Oleada ${wave} · la siguiente en ${Math.max(1, Math.ceil(phaseT))} s`
      : phase === 'wave' ? `Oleada ${of(wave)} · ${cur.theme}` : `Oleada ${of(wave + 1)} en ${Math.max(1, Math.ceil(phaseT))} s · ${next.theme}`;
    const hint = phase === 'wave' ? `Quedan ${left} · ${cur.hint}` : next.hint;
    // En grupo, las monedas de cada compañero (con su color).
    // (En la Arena, sus vidas, o que ha caído.)
    const laneOf = (uid: string) => lanes[laneIx(uid)];
    const mates = coop ? coop.members.filter(m => m.uid !== me).map(m => m.uid + ':' + (arena ? (laneOf(m.uid) ? laneOf(m.uid).lives + '/' + laneOf(m.uid).out : '') : purse[m.uid] || 0)).join(',') : '';
    const key = [myLives, title, hint, phase, wave, fast, won, mates, knockedOut()].join('|');
    if (key !== hudKey) {
      hudKey = key;
      (hud.querySelector('[data-k=lives]') as HTMLElement).textContent = String(myLives);
      (hud.querySelector('.td-lives') as HTMLElement).classList.toggle('low', myLives <= (arena ? 5 : 8));
      (hud.querySelector('[data-k=wave]') as HTMLElement).textContent = title;
      (hud.querySelector('[data-k=hint]') as HTMLElement).textContent = hint;
      const nb = hud.querySelector('[data-a=next]') as HTMLElement;
      // (En la Arena, sólo para la primera: después el ritmo es el mismo para todos.)
      nb.style.display = phase === 'break' && !(arena && wave > 0) && !knockedOut() ? '' : 'none';
      nb.textContent = wave === 0 ? '¡Empezar! (N)' : 'Ya (N)';
      const fb = hud.querySelector('[data-a=fast]') as HTMLButtonElement;
      fb.textContent = fast ? '×2' : '×1';
      fb.disabled = guest();
      fb.title = guest() ? 'La velocidad la elige el anfitrión' : 'Velocidad (F)';
      (hud.querySelector('[data-a=won]') as HTMLElement).style.display = won && hosting() ? '' : 'none';
      const tm = hud.querySelector('[data-k=team]') as HTMLElement;
      tm.style.display = coop ? '' : 'none';
      if (coop) {
        tm.innerHTML = coop.members.filter(m => m.uid !== me).map(m => {
          const l = arena ? laneOf(m.uid) : null;
          const v = l ? (l.out ? 'fuera' : '♥ ' + Math.max(0, l.lives)) : String(purse[m.uid] || 0);
          return `<span translate="no" style="color:${colorOf(m.uid)}${l && l.out ? ';opacity:.5' : ''}">${esc(m.name)} <b>${v}</b></span>`;
        }).join('');
      }
      // Arena, ya fuera: sin tienda ni panel (no se compra), y sin monedas.
      if (shop) shop.style.display = knockedOut() || watching() ? 'none' : '';
      const money = hud.querySelector('.td-money') as HTMLElement | null;
      if (money && !watching()) money.style.display = knockedOut() ? 'none' : '';
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
      ${G.Touch.active ? '' : '<span class="sub">Mayús + clic: plantar varias · R: repetir la última</span>'}
      <button class="btn small ghost" data-a="cancel">Cancelar (Esc)</button>`;
    (tip.querySelector('[data-a=cancel]') as HTMLElement).onclick = () => cancelPlacing();
  }

  // ---------------- dibujo ----------------

  /** El camino, la base, y los alcances (al colocar o con una torre seleccionada). */
  function drawGround(ctx: CanvasRenderingContext2D) {
    if (!arena && (!paths.length || paths[0].length < 2)) return;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (arena) drawArenaFloor(ctx);
    // Todos los caminos en un solo trazo (así el tramo que comparten no se oscurece dos veces).
    const trace = () => { ctx.beginPath(); for (const path of paths) { ctx.moveTo(path[0].x, path[0].y); for (const p of path) ctx.lineTo(p.x, p.y); } };
    const path = paths[0];
    // Al colocar: lo que no se puede ocupar, sombreado en rojo (camino y su borde, entrada, base y junto a otras torres).
    if (placing) {
      trace(); ctx.strokeStyle = 'rgba(255, 95, 109, 0.22)'; ctx.lineWidth = PATH_CLEAR * 2; ctx.stroke();
      ctx.fillStyle = 'rgba(255, 95, 109, 0.22)';
      for (const e of [...paths.map(p => p[0]), ...bases()]) { ctx.beginPath(); ctx.arc(e.x, e.y, ENDS_CLEAR, 0, 6.2832); ctx.fill(); }
      for (const t of towers) { ctx.beginPath(); ctx.arc(t.p.x, t.p.y, TOWER_GAP, 0, 6.2832); ctx.fill(); }
      // Lo que ocupa cada torre (no hay casillas: es un círculo; dos torres no pueden solaparse).
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'; ctx.lineWidth = 1.5;
      for (const t of towers) { ctx.beginPath(); ctx.arc(t.p.x, t.p.y, TOWER_GAP / 2, 0, 6.2832); ctx.stroke(); }
      // El borde del mapa.
      if (!arena) {
        ctx.strokeStyle = 'rgba(255, 95, 109, 0.5)'; ctx.lineWidth = 3; ctx.setLineDash([12, 10]);
        const h = home();
        ctx.beginPath(); ctx.arc(h.x, h.y, bound, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    trace(); ctx.strokeStyle = 'rgba(60, 44, 28, 0.55)'; ctx.lineWidth = 50; ctx.stroke();
    trace(); ctx.strokeStyle = 'rgba(214, 186, 132, 0.85)'; ctx.lineWidth = 42; ctx.stroke();
    // Flechas en el camino: hacia dónde van.
    // (El tramo que comparten varios caminos, una sola vez.)
    ctx.fillStyle = 'rgba(120, 90, 50, 0.45)';
    const done = new Set<string>();
    for (const path of paths) for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], len = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
      const key = a.x + ',' + a.y + ',' + b.x + ',' + b.y;
      if (done.has(key)) continue;
      done.add(key);
      for (let d = 60; d < len - 30; d += 120) {
        const x = a.x + Math.cos(ang) * d, y = a.y + Math.sin(ang) * d;
        ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
        ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-6, -7); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }
    // La base: lo que defiendes (en la Arena, la de cada carril).
    for (const b of bases()) {
      ctx.fillStyle = 'rgba(79, 180, 255, 0.35)';
      ctx.beginPath(); ctx.arc(b.x, b.y, 34, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = '#4fb4ff'; ctx.lineWidth = 4; ctx.stroke();
    }
    // Las entradas.
    ctx.fillStyle = 'rgba(255, 95, 109, 0.35)';
    for (const p of paths) { const a = p[0]; ctx.beginPath(); ctx.arc(a.x, a.y, 26, 0, 6.2832); ctx.fill(); }
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
      // Y lo que ocupará la nueva.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)'; ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ghost.x, ghost.y, TOWER_GAP / 2, 0, 6.2832); ctx.fill(); ctx.stroke();
    } else if (selected && selected !== 'hero') {
      const k = SUPPORT[selected.dex];
      ring(ctx, selected.p.x, selected.p.y, k ? auraRadius(selected.level) : rangeOf(selected.p), '255, 210, 63');
    }
    // Las auras de los apoyos, siempre a la vista (flojito), y bajo cada torre reforzada, sus colores.
    for (const t of towers) {
      // En grupo, de quién es: un anillo de su color.
      const oc = colorOf(t.owner);
      if (oc) {
        ctx.globalAlpha = 0.6; ctx.strokeStyle = oc; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.ellipse(t.p.x, t.p.y + 2, 17, 7, 0, 0, 6.2832); ctx.stroke();
        ctx.globalAlpha = 1;
      }
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
  /**
   * Arena: cada carril, su cuadrícula, la entrada (arriba, roja) y la salida (abajo, azul), la ruta que siguen
   * ahora los monstruos y, encima, de quién es y sus vidas. Al colocar: la casilla (verde o roja) y la ruta
   * que quedaría con la torre ahí.
   */
  function drawArenaFloor(ctx: CanvasRenderingContext2D) {
    const fs = Math.max(30, 22 / (G.Camera.scale || 1)), rows = Math.round(MAZE_H / CELL);
    lanes.forEach(l => {
      const x0 = l.cx - MAZE_W / 2, y0 = l.cy - MAZE_H / 2, col = colorOf(l.uid) || '#ffffff';
      ctx.globalAlpha = l.out ? 0.35 : 1;
      ctx.fillStyle = 'rgba(150, 118, 76, 0.55)'; ctx.fillRect(x0, y0, MAZE_W, MAZE_H);
      ctx.fillStyle = 'rgba(255, 95, 109, 0.28)'; ctx.fillRect(x0, y0, MAZE_W, CELL * FREE_ROWS);
      ctx.fillStyle = 'rgba(79, 180, 255, 0.32)'; ctx.fillRect(x0, y0 + MAZE_H - CELL * FREE_ROWS, MAZE_W, CELL * FREE_ROWS);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 1; c < MAZE_COLS; c++) { ctx.moveTo(x0 + c * CELL, y0); ctx.lineTo(x0 + c * CELL, y0 + MAZE_H); }
      for (let r = 1; r < rows; r++) { ctx.moveTo(x0, y0 + r * CELL); ctx.lineTo(x0 + MAZE_W, y0 + r * CELL); }
      ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.strokeRect(x0, y0, MAZE_W, MAZE_H);
      ctx.font = '800 ' + Math.round(fs) + 'px Pixelify,"Segoe UI",system-ui,sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = col;
      ctx.fillText(memberName(l.uid) + (l.out ? ' · ' + G.I18n.t('fuera') : ' · ♥ ' + l.lives), l.cx, y0 - fs * 0.5);
    });
    ctx.globalAlpha = 1;
    const ln = myLane();
    if (!placing || !ln) return;
    const i = cellAt(ghost.x - ln.cx, ghost.y - ln.cy);
    if (i < 0) return;
    const err = whyNot(ghost.x, ghost.y), c = cellCenter(i);
    ctx.fillStyle = err ? 'rgba(255, 95, 109, 0.4)' : 'rgba(95, 224, 138, 0.35)';
    ctx.fillRect(ln.cx + c.x - CELL / 2, ln.cy + c.y - CELL / 2, CELL, CELL);
    if (err) return;
    const b = ln.blocked.slice(); b[i] = 1;
    const d = flow(b);
    drawRoute(ctx, ln, routeFrom(cellIx(Math.floor(MAZE_COLS / 2), 0), d, b), 'rgba(95, 224, 138, 0.95)', true);
  }
  /** Arena: una ruta (casillas) dibujada sobre su carril. */
  function drawRoute(ctx: CanvasRenderingContext2D, ln: Lane, route: number[], color: string, dash: boolean) {
    if (route.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = dash ? 5 : 7; ctx.setLineDash(dash ? [12, 9] : []);
    ctx.beginPath();
    route.forEach((i, k) => { const c = cellCenter(i); if (k) ctx.lineTo(ln.cx + c.x, ln.cy + c.y); else ctx.moveTo(ln.cx + c.x, ln.cy + c.y); });
    ctx.lineTo(ln.cx + cellCenter(route[route.length - 1]).x, ln.cy + MAZE_H / 2);
    ctx.stroke(); ctx.setLineDash([]);
  }
  /** Las bases (el final de los caminos; con varias entradas es la misma, y en la Arena, una por carril). */
  function bases() {
    const out: { x: number; y: number }[] = [];
    for (const p of paths) { const b = p[p.length - 1]; if (!out.some(o => o.x === b.x && o.y === b.y)) out.push(b); }
    return out;
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
    // Invitado: lo que le pasa a cada enemigo (congelado, paralizado...) lo cuenta el anfitrión en su estado.
    if (guest()) {
      for (const e of G.EnemyMgr.all()) {
        const bits = e.remote && !e.dead && e.net ? e.net.st >> 3 : 0;
        if (bits) out.push({ y: e.y + 0.5, draw: (ctx: CanvasRenderingContext2D) => drawStatus(ctx, e, bits) });
      }
    }
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
    for (const el of [hud, shop, panel, tip, mapBox, sendBox]) if (el) el.style.visibility = show ? '' : 'hidden';
    if (show) paintHud();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;

    ctx.save();
    ctx.scale(G.Camera.scale, G.Camera.scale);
    G.Camera.apply(ctx);
    v.drawScene(G.Camera, coop && G.Coop.active ? (watching() ? G.Coop.puppets() : [pl, ...G.Coop.puppets()]) : [pl]);
    G.Projectiles.draw(ctx);
    G.Combat.drawAirFields(ctx);
    G.FX.draw(ctx);
    G.Pings.drawWorld(ctx);
    ctx.restore();

    G.World.drawVignette(ctx, w, h);
    G.HUD.draw(ctx, w, h, watching() ? G.Spectate.target() || pl : pl, st);
    G.Pings.drawHud(ctx, w, h);
    G.Touch.draw(ctx);
    if (show) drawMap();
  }

  return {
    id: 'td',
    start, update, idle, keysModal, keysPlay, drawables, drawGround, render, everyone,
    /** Abandonar: en grupo, sales tú (si eres el anfitrión, se acaba para todos). Lo conseguido se cobra. */
    quit() {
      if (coop && G.Coop.active) G.Coop.leave();
      end(false, true);
    },
    /** El menú abre aquí la elección de favoritos antes de empezar. */
    openTeam,
    // ---- para las pruebas ----
    debugBuy(dex: number) { startPlacing(dex); },
    debugCancel() { cancelPlacing(); },
    debugPlace(x: number, y: number) { tryPlace(x, y); },
    /** La vista previa de la torre que se coloca, a (x, y), como si la llevara el ratón (vídeos y pruebas). */
    debugGhost(x: number, y: number) { const g = snap(x, y); ghost.x = g.x; ghost.y = g.y; ghostByPointer = true; },
    /** Arena, ya fuera: mira el carril del siguiente (1) o del anterior (-1) que sigue en pie (como Q/E). */
    debugWatch(step: number) {
      const up = lanes.map((l, i) => (l.out ? -1 : i)).filter(i => i >= 0);
      if (!knockedOut() || !up.length) return;
      const k = up.indexOf(watchLane); watchLane = up[((k < 0 ? 0 : k + Math.sign(step)) + up.length) % up.length]; camFree = null; hudKey = '';
    },
    /** (Vídeos) saca ya un jefe por el camino `path` (en la Arena, cada carril tiene los suyos). → su id */
    debugBossAt(dex: number, path: number, legend = false) {
      if (!hosting() || !G.DEX_BY[dex] || !(arena ? lanes[path] : paths[path])) return null;
      spawnEnemy(true, dex, path, true);
      const e = G.EnemyMgr.all().filter((x): x is Walker => x instanceof Walker && x.chief).pop();
      if (e && legend && e.kind !== 'legend') { e.kind = 'legend'; bigger(e, 'legend'); }
      return e ? e.id : null;
    },
    debugUpgrade(i: number) { if (towers[i]) upgrade(towers[i]); },
    debugEvolve(to: number) { if (pendingEvo && pendingEvo.options.includes(to)) chooseEvo(pendingEvo.tower, to); },
    debugSelect(i: number) { selected = towers[i] || null; refreshUI(); },
    debugCycleMode(i: number) { if (towers[i]) cycleMode(towers[i]); },
    debugHero() { upgradeHero(); },
    debugLives(n: number) { if (hosting()) { lives = n; tampered = true; sendState(); } },
    /** Arena: envía el monstruo `k` (de SENDS) a `to` (o al de siempre), como con su botón. */
    debugSend(k: number, to = '') { const was = sendTo; if (to) sendTo = to; send(k); sendTo = was; },
    /** (Vídeos y pruebas) las monedas de `uid` (anfitrión; sin marcar la partida: el vídeo enseña el podio y el ranking). */
    debugMoney(uid: string, n: number) { if (hosting() && uid in purse && n >= 0) { purse[uid] = n; sendState(); refreshUI(); } },
    /** Arena: las vidas del carril de `uid` (sin marcar la partida: las pruebas miran el podio y el ranking). */
    debugLaneLives(uid: string, n: number) { const l = lanes[laneIx(uid)]; if (hosting() && l) { l.lives = n; sendState(); } },
    debugWin() { if (hosting()) { wave = LAST_WAVE; phase = 'wave'; toSpawn = 0; bossLeft = 0; G.EnemyMgr.clear(); tampered = true; } },
    finishWon,
    debugSell(i: number) { if (towers[i]) sell(towers[i]); },
    debugMode(i: number, mode: TargetMode) { if (towers[i] && TARGET_MODES.includes(mode)) towers[i].mode = mode; },
    debugCallWave() { callWave(); },
    /** Saca ya un jefe (`dex`); con `legend`, un legendario. → su id */
    debugBoss(dex: number, legend = false) {
      if (!hosting() || !G.DEX_BY[dex]) return null;
      spawnEnemy(true, dex);
      const e = G.EnemyMgr.all().filter((x): x is Walker => x instanceof Walker && x.chief).pop();
      if (e && legend && e.kind !== 'legend') { e.kind = 'legend'; bigger(e, 'legend'); }
      return e ? e.id : null;
    },
    get shop() { return pool.map(c => ({ dex: c.dex, lent: c.lent, trophy: !!c.trophy, cost: costOf(c.dex) })); },
    /** El ataque que tendría `dex` como torre (pruebas). */
    towerMove: (dex: number) => towerMoveOf(dex),
    /** Enseña a la torre `i` el primer ataque que le falte (o `id`). → el ataque, o null */
    debugLearn(i: number, id?: string) {
      const t = towers[i];
      if (!t) return null;
      const m = id || learnable(t)[0];
      if (m) learn(t, m);
      return m || null;
    },
    debugFast(on: boolean) { if (hosting()) { fast = !!on; sendState(); } },
    /** La vida de los enemigos (×k). Marca la partida, salvo con `video` (el tráiler enseña el podio y el ranking). */
    debugHpMul(k: number, video = false) { hpMul = k > 0 ? k : 1; if (hpMul !== 1 && !video) tampered = true; },
    canPlace(x: number, y: number) { return !whyNot(x, y); },
    /** La cámara a (x, y), como al pulsar en el minimapa (null: de vuelta al héroe). */
    debugCam(x: number | null, y = 0) { camFree = x == null ? null : { x, y }; },
    get cam() { return { x: G.Camera.x, y: G.Camera.y, free: !!camFree }; },
    /** El camino de la primera entrada; `routes`, todos. */
    get route() { return paths[0].map(p => ({ x: p.x, y: p.y })); },
    get routes() { return paths.map(path => path.map(p => ({ x: p.x, y: p.y }))); },
    get placing() { return placing ? { dex: placing.dex, x: ghost.x, y: ghost.y } : null; },
    get info() {
      return {
        // (En la Arena, las de tu carril.)
        wave, lives: arena ? Math.max(0, (myLane() || { lives: 0 }).lives) : lives, leaked, phase, money: cash(), reach: Math.round(reach * 100) / 100, team: team.slice(), shop: pool.map(c => c.dex), heroLevel, won,
        evo: pendingEvo ? pendingEvo.options.slice() : null,
        selected: selected === 'hero' ? 'hero' : selected ? towers.indexOf(selected) : null,
        powers: { ...powers },
        next: wave < LAST_WAVE ? { ...waveAt(wave + 1) } : null,
        towers: towers.map(t => ({ dex: t.dex, level: t.level, spent: t.spent, mode: t.mode, support: SUPPORT[t.dex] || null, buff: { ...t.buff }, x: t.p.x, y: t.p.y, shots: shots.get(t.p) || 0 }))
      };
    },
    /** Lo del grupo y lo nuevo (mapa, sin fin), aparte de `info` para no cambiar las pruebas grabadas. */
    get net() {
      return {
        coop: !!coop, host: hosting(), me, map: map.id, purse: { ...purse }, cleared, won, flawless, fast, heroLv: { ...heroLv },
        left: guest() ? leftShown : toSpawn + bossLeft + G.EnemyMgr.all().filter(e => !e.dead).length,
        towers: towers.map(t => ({ id: t.id, owner: t.owner, dex: t.dex, level: t.level, mode: t.mode, x: Math.round(t.p.x), y: Math.round(t.p.y), shots: shots.get(t.p) || 0,
                                   moves: t.p.activeGroup().map(m => m.id), learned: t.learned.slice(), spent: t.spent })),
        evo: pendingEvo ? { id: pendingEvo.tower.id, options: pendingEvo.options.slice() } : null,
        arena, out: knockedOut(),
        lanes: lanes.map(l => ({ uid: l.uid, cx: l.cx, cy: l.cy, lives: l.lives, out: l.out, income: l.income, route: l.route.length, len: l.dist[cellIx(Math.floor(MAZE_COLS / 2), 0)], walls: l.blocked.reduce((a, b) => a + b, 0) })),
      };
    },
    get player() { return pl; }, get time() { return time; }
  } satisfies GameMode & Record<string, unknown>;
})();
G.TD = TD;
/** Los mapas de la Defensa (los elige también el anfitrión en la sala, ui/social-ui.ts). */
G.TD_MAPS = MAPS;

declare module '../g' {
  interface Registry { TD: typeof TD; TD_MAPS: typeof MAPS }
}
