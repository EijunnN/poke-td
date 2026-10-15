import { G } from '../g';
import { Run, type GameMode, type View } from '../run';
import { Enemy } from '../entities/enemy';
import {
  leadAngle, placementError, moveRange, towerCost, upgradeCost, sellValue, killReward, waveBonus,
  evolvesAt, START_MONEY, MAX_LEVEL, PATH_CLEAR, TOWER_GAP, ENDS_CLEAR,
  pathLengths, pathProgress, stepBack, pickTarget, TARGET_MODES, TARGET_NAME, type TargetMode,
  ROLES, roleHit, SUPPORT, AURAS, AURA_KINDS, auraStrength, auraRadius, aurasAt, type AuraKind, type AuraTotals,
  MAPS, mapById, randomMap, costFor, trophyCost, type TdMap
} from './td-geom';
import { START_LIVES, LAST_WAVE, MAX_WAVE, WIN_COINS, waveAt, waveHp, waveCount, waveGap, bossHpMul, leakCost, defenseCoins } from './td-waves';
import type { CoopConfig } from '../net/coop';
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
 * Hay tres mapas (td-geom.ts, MAPS). Tras la oleada 30 (la victoria) sigue el modo
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
  /**
   * Alcance máximo de una torre. Los proyectiles vuelan hasta 520, pero con eso una
   * torre cubría medio mapa y daba igual dónde ponerla.
   */
  const RANGE_MAX = 340;
  /** El apoyo que se presta de cada clase si no tienes ninguno: Scyther, Togepi, Riolu, Meowth y Hoothoot. */
  const LENT_SUPPORT = [123, 175, 447, 52, 163];
  /** Cuántos Pokémon enseña la tienda a la vez (con más, se filtra por tipo). */
  const SHOP_MAX = 60;

  /**
   * Una torre: su id (el mismo en todos los ordenadores), de quién es, el Pokémon, lo
   * gastado, a quién apunta, su ataque sin auras (`atk`) y las auras que recibe ahora (`buff`).
   */
  interface Tower {
    id: number; owner: string; p: any; dex: number; shiny: boolean; level: number; base: number; spent: number;
    mode: TargetMode; atk: number; buff: AuraTotals;
    /** Ataques que le has enseñado con monedas (además del suyo). */
    learned: string[];
  }

  let time = 0;
  let pl = null;                     // el héroe
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
    /**
     * Inmune a otro control fuerte (congelar, paralizar, confundir, empujar) mientras dure: con
     * muchas torres se podía tener a un enemigo parado para siempre, y el final era un paseo.
     */
    ccT = 0;
    /** Tipo del último golpe (el Hada da más monedas si es ella quien lo derrota). */
    lastType = '';
    textCd = 0;

    get chief() { return this.kind !== 'normal'; }
    /** Sus estados para las copias del cooperativo (ver drawStatus). */
    netBits = () => (this.frozenT > 0 ? 1 : 0) | (this.stunT > 0 ? 2 : 0) | (this.confuseT > 0 ? 4 : 0) | (this.curseT > 0 ? 8 : 0) | (this.slow > 0.2 ? 16 : 0);

    update(dt: number) {
      // Nunca cuenta como rezagado (en las hordas, los rezagados reaparecen junto al jugador).
      this.lagT = -1e9;
      if (!this.dead) {
        this.chillCd -= dt; this.frozenT -= dt; this.stunT -= dt; this.confuseT -= dt; this.curseT -= dt; this.textCd -= dt; this.ccT -= dt;
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
      // Control fuerte: uno cada vez, y luego un rato de inmunidad (más largo en los jefes).
      const cc = () => { if (this.ccT > 0) return false; this.ccT = CC_IMMUNE * (this.chief ? 1.5 : 1); return true; };
      if (r.chill && this.chillCd <= 0 && ++this.chill >= r.chill[0]) {
        this.chill = 0; this.chillCd = 2.5;
        if (cc()) this.freeze(r.chill[1] * (this.chief ? 0.5 : 1), 'frozen', '¡Congelado!', '#9fe8ff');
      }
      if (fx.stun > 0 && cc()) this.freeze(fx.stun, 'stun', type === 'electric' ? '¡Paralizado!' : '¡Aturdido!', '#ffe14d');
      if (fx.confuse > 0 && cc()) { this.confuseT = Math.max(this.confuseT, fx.confuse); this.say('¡Confuso!', '#ff8ac4'); note('psychic'); }
      if (fx.push > 0 && cc()) {
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
      // Cobráis todos (en grupo, cada uno en su cartera).
      for (const u of Object.keys(purse)) purse[u] += n + bonus;
      // De vez en cuando, una baya que cura al héroe (como antes, cuando soltaban gemas).
      if (!this.remote && Math.random() < HEAL_DROP) G.Pickups.drop('heal', this.x, this.y);
      if (this.chief) {
        floatText(this.x, this.y - this.bodyH - 10, '+' + (n + bonus), '#ffd23f');
        announce('¡' + this.name + ' derrotado!', 2.4);
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
  function drawStatus(ctx: CanvasRenderingContext2D, e: any, bits: number) {
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

  /** Para el HUD del juego (ui/hud.ts): el reloj; sin el de arriba (la Defensa tiene su marcador). */
  const st = { get time() { return time; }, noClock: true, noLevel: true };

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

  /** Formas de ataque que no sirven quieto: embestir (te mueve), el rastro al andar y los potenciadores. */
  const NOT_FOR_TOWERS = new Set(['buff', 'dash', 'trail']);
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
    return (G.Moves.poolFor(mon) as string[]).filter(m => {
      const d = G.Moves.BY_ID[m];
      return d && mon.types.includes(d.type) && !NOT_FOR_TOWERS.has(d.kind);
    }).sort();
  }
  function towerMoveOf(dex: number): string {
    const got = towerMoves.get(dex);
    if (got) return got;
    const mon = G.DEX_BY[dex];
    let id = G.startMoveOf(dex);
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
  const typeName = (t: string) => G.U.TYPE_NAME[t] || t;
  /** Etiqueta de color (tipo o apoyo), con el texto oscuro o blanco según se lea mejor sobre su fondo. */
  const tag = (bg: string, text: string) => `<i class="td-type" style="background:${bg};color:${G.U.inkOn(bg)}">${text}</i>`;
  const auraChip = (k: AuraKind) => tag(AURAS[k].color, 'Apoyo');
  const typeChip = (t: string) => tag(G.U.TYPE_COLOR[t] || '#888', typeName(t));

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
      <div class="row td-maps" style="margin-top:10px;gap:6px;flex-wrap:wrap;align-items:center"><b>Mapa:</b></div>
      <div class="row" style="margin-top:12px;gap:8px"><button class="btn gold grow" data-a="go">Empezar</button></div>
    </div>`;
    document.body.appendChild(el);
    // El mapa: uno de los de td-geom.ts o al azar (se recuerda el último).
    let mapPick = G.DB.save.tdMap === 'random' || MAPS.some(m => m.id === G.DB.save.tdMap) ? G.DB.save.tdMap : MAPS[0].id;
    const maps = el.querySelector('.td-maps') as HTMLElement;
    for (const [id, name] of [...MAPS.map(m => [m.id, m.name]), ['random', 'Al azar']]) {
      const b = document.createElement('button');
      b.className = 'btn small' + (id === mapPick ? ' gold' : '');
      b.dataset.map = id;
      b.textContent = name;
      b.onclick = () => {
        mapPick = id;
        maps.querySelectorAll<HTMLElement>('[data-map]').forEach(x => x.classList.toggle('gold', x.dataset.map === id));
      };
      maps.appendChild(b);
    }
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
      b.insertAdjacentHTML('beforeend', `<small>${mon.name}</small>${SUPPORT[c.dex] ? auraChip(SUPPORT[c.dex]) : typeChip(attackType(c.dex))}<small class="gold">${costOf(c.dex)}</small>${c.lent ? '<small class="lent">préstamo</small>' : ''}`);
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
  function start(opts: { team?: number[]; map?: string; coop?: CoopConfig & { map?: string } } | null = null) {
    const save = G.DB.save;
    const mon = G.DEX_BY[save.partner];
    const perks = G.Upgrades.perks(G.DB.upgradesOf(mon.dex));
    coop = opts && opts.coop ? opts.coop : null;
    me = coop ? G.Net.uid : 'me';

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
    // En grupo, el mismo mundo para todos (la semilla del anfitrión).
    G.World.reset(coop ? coop.seed : Math.floor(Math.random() * 1e6), CLEAR);
    G.World.setBiome(0, true);

    const TS = G.World.TS;
    map = mapById(coop ? coop.map : opts && opts.map);
    path = map.route.map(([tx, ty]) => ({ x: tx * TS, y: ty * TS, r: 0, level: 1 }));
    lens = pathLengths(path);
    bound = 20 * TS;
    time = 0; lives = START_LIVES; wave = 0; leaked = 0; downT = 0; won = false; flawless = false; fast = false; cleared = 0; tampered = false; hostAway = null;
    heroLevel = 1; reach = 0; hpMul = 1; bossLeft = 0; toSpawn = 0; leftShown = 0; stateT = 0; camFree = null;
    // Cada jugador empieza con lo mismo (en solitario, sólo tú).
    purse = {}; heroLv = {};
    for (const u of coop ? coop.members.map(m => m.uid) : [me]) { purse[u] = START_MONEY; heroLv[u] = 1; }
    towers = []; nextTowerId = 1; placing = null; selected = null; pendingEvo = null; powers = {}; trophies = [];
    pool = candidates();
    team = cleanTeam(opts && opts.team);
    if (!opts || !Array.isArray(opts.team)) { if (!team.length) team = cleanTeam(save.tdTeam); }
    shopFilter = 'all';                // empieza en Todos (los favoritos salen primero igual)
    G.Sprites.preload(team, 4000);
    preloadWave(1);
    listenPointer();

    pl = new G.Player(mon, perks, !!save.partnerShiny && G.DB.ownsShiny(mon.dex));
    pl.addMove(G.startMoveOf(mon.dex));
    if (coop) {
      G.Coop.begin(coop, pl, coopApi);
      if (!coop.watch) G.Social.setPlaying(true);
    }
    G.Camera.x = pl.x; G.Camera.y = pl.y; G.Camera.shake = 0;
    G.Sprites.preload([mon.dex], 8000, pl.shiny);
    G.Audio.music(G.BIOME_MUSIC[0]);

    Run.state = 'playing';
    // Ranking: el servidor apunta cuándo empieza (en grupo, el anfitrión).
    if (hosting()) G.Ranking.runStarted(coop ? 'e' : 'd');
    phase = 'break'; phaseT = FIRST_BREAK;
    buildUI();
    G.Spawner.say(coop ? 'Defended juntos: cada uno compra sus torres con sus monedas' : 'Compra torres en la tienda y plántalas junto al camino', 4, true);
  }

  /** Cómo ha ido la partida (lo que el anfitrión manda a todos al acabar). */
  function summary(dead: boolean) {
    return { dead, w: cleared, l: Math.max(0, lives), k: pl ? pl.kills : 0, s: Math.floor(time), won, flawless, wave, map: map.id };
  }

  /** Se acaba la partida (la base cae, se abandona o, en grupo, el anfitrión la termina). */
  function end(dead: boolean) {
    if (Run.state === 'over' || !pl) return;
    const d = summary(dead);
    // En grupo, el anfitrión la acaba para todos (Coop les manda el resumen y ellos llaman a finish).
    if (coop && G.Coop.isHost) G.Coop.over(d);
    finish(d);
  }

  /** Resumen, premios de la cuenta y ranking. `d`: el de summary(), el tuyo o el del anfitrión. */
  function finish(d: ReturnType<typeof summary>) {
    if (Run.state === 'over' || !pl) return;
    Run.state = 'over';
    // Espectador: ni premio ni resumen; de vuelta a la lista de salas.
    if (watching()) {
      hideUI();
      G.Audio.music(null);
      pl = null; towers = []; G.EnemyMgr.clear();
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

    // La cuenta: monedas, estadísticas, misiones y logros (en grupo, cada uno los suyos).
    const save = G.DB.save;
    const coins = tampered ? 0 : defenseCoins(d.w, d.k, d.won);
    save.coins += coins;
    save.stats.coinsEarned += coins;
    save.stats.totalKills += d.k;
    G.Progress.event('tdEnd', { waves: d.w, won: d.won, lives: d.l, group, perfect: d.won && d.flawless });
    G.Progress.checkAch();
    G.DB.commit(true);

    // Ranking de Defensa: oleadas superadas y, a igualdad, vidas que quedaban (en grupo lo sube el anfitrión).
    if (!tampered && d.w > 0) {
      const mark = { waves: d.w, lives: d.l, secs: d.s, kills: d.k };
      if (!group) G.Ranking.submitDefense(Object.assign(mark, { dex: pl.dex, shiny: pl.shiny }));
      else if (wasHost) G.Ranking.submitDefenseGroup(Object.assign(mark, { members: members.map(m => ({ uid: m.uid, dex: m.dex, shiny: m.shiny })) }));
    }

    G.RunUI.showOver({
      dead: d.dead, time: d.s, level: pl.level, kills: d.k, bosses: 0, coins, record: false, t1: 0, t10: 0, judge: null,
      cells: [['Oleadas superadas', d.w], ['Vidas', d.l], ['Derrotados', d.k], ['Tiempo', G.U.mmss(d.s)]],
      moves: pl.moves, caught: [],
      breakdown: tampered ? 'Partida tocada desde la consola: sin premio'
        : `oleadas ${d.w * 10} · derrotados ${Math.floor(d.k / 5)}${d.won ? ' · victoria ' + WIN_COINS : ''}`
    }, () => { pl = null; towers = []; G.EnemyMgr.clear(); G.Flow.afterRun(); });
    document.getElementById('over-title').textContent =
      d.won ? (d.wave > LAST_WAVE ? '¡Victoria! · y en el sin fin, hasta la oleada ' + d.wave : '¡Victoria! · las ' + LAST_WAVE + ' oleadas')
      : d.dead ? 'La base ha caído · oleada ' + d.wave : 'Defensa terminada · oleada ' + d.wave;
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
    if (phase !== 'break' || Run.state !== 'playing') return;
    if (guest()) { G.Coop.toHost(['tw']); return; }
    if (wave > 0) payAll(Math.max(0, Math.floor(phaseT)) * 2, pl.x, pl.y - 40);
    startWave();
  }

  /** Vida de los enemigos en grupo: cuantos más sois (y más torres hay), más aguantan. */
  const groupHp = () => (coop && G.Coop.active ? 1 + 0.85 * (G.Coop.players().length - 1) : 1);

  /** Saca un enemigo de la oleada (los normales primero; el jefe, al final). */
  /** @param bossDex  (pruebas) el jefe que sale, en vez del de la oleada */
  function spawnEnemy(chief: boolean, bossDex = 0) {
    const w = waveAt(wave);
    const dex = chief ? bossDex || w.boss! : w.pool[Math.floor(Math.random() * w.pool.length)];
    const mon = G.DEX_BY[dex];
    const kind = !chief ? 'normal' : w.legend ? 'legend' : 'boss';
    // Vida y velocidad: la curva de la oleada, ajustadas un poco con los stats del Pokémon.
    const hpK = G.U.clamp(mon.hp / 95, 0.85, 1.25), spdK = G.U.clamp(mon.spd / 105, 0.85, 1.2);
    let hp = waveHp(wave) * hpK * hpMul * groupHp(), spd = WALK * (1 + wave * 0.025) * spdK;
    if (chief) { hp *= bossHpMul(kind === 'legend'); spd *= 0.7; }
    // Sin experiencia: en la Defensa no sueltan gemas (no servían para nada); se cobra en monedas.
    const def = { dex, name: mon.name, behavior: 'chase' as const, hp: Math.round(hp), spd, dmg: 10, xp: 0 };
    const e = new Walker(def, path[0].x + G.U.rand(-10, 10), path[0].y + G.U.rand(-10, 10), { hp: 1, spd: 1, dmg: 1 });
    e.kind = kind;
    e.wave = wave;
    G.EnemyMgr.add(e);
    if (chief) {
      bigger(e, kind);
      announce('¡Llega ' + mon.name + '!', 2.6);
      G.Audio.sfx('legend');
      if (coop) G.Coop.broadcast(['tb', e.id, kind]);
    }
  }

  /** Un jefe o legendario se ve más grande (también su copia en los invitados). */
  function bigger(e: any, kind: string) {
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
      reach = Math.max(reach, pathProgress(e.x, e.y, e.wp, path, lens) / lens[lens.length - 1]);
      const to = path[e.wp];
      if (G.U.dist2(e.x, e.y, to.x, to.y) > 18 * 18) continue;
      if (e.wp + 1 < path.length) { e.wp++; continue; }
      // Ha llegado a la base: fuera, sin botín ni animación.
      list.splice(i, 1);
      if (coop && G.Coop.isHost) G.Coop.enemyGone(e, false);
      lives -= leakCost(e.kind === 'boss', e.kind === 'legend'); leaked++;
      G.FX.burst(e.x, e.y - 10, '#ff5f6d', 14, 160);
      G.Camera.kick(0.5);
      G.Audio.sfx('hurt');
      if (e.chief) announce(e.name + ' ha llegado a la base', 2.4);
      sendState();
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

  // ---------------- monedas ----------------

  /** Cobráis todos (por oleada, por adelantarla): cada uno en su cartera. */
  function payAll(n: number, x: number, y: number) {
    if (!(n > 0)) return;
    for (const u of Object.keys(purse)) purse[u] += n;
    G.FX.dmgText(x, y, '+' + n, '#ffd23f');
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
  function makeTower(dex: number, shiny = G.DB.ownsShiny(dex)) {
    const t = new G.Player(G.DEX_BY[dex], {}, shiny);
    t.frozen = true;
    t.addMove(towerMoveOf(dex));
    return t;
  }
  /** Lo que cuesta como trofeo (el jefe o legendario derrotado, si no lo tienes). */
  const trophyCostOf = (dex: number) => trophyCost(G.DEX_BY[dex].rarity, !!G.DEX_BY[dex].leg);
  const isTrophy = (dex: number) => pool.some(c => c.dex === dex && c.trophy);
  const costOf = (dex: number) => (isTrophy(dex) ? trophyCostOf(dex) : costFor(dex, G.DEX_BY[dex].rarity));

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
    if (!inPool(dex) || Run.state !== 'playing') return;
    if (placing && placing.dex === dex && !again) { cancelPlacing(); return; }      // pulsarla otra vez la suelta
    if (cash() < costOf(dex)) { G.Spawner.say('Te faltan monedas', 1.4, true); G.Audio.sfx('back'); return; }
    const preview = makeTower(dex);
    placing = { dex, preview, range: SUPPORT[dex] ? auraRadius(1) : rangeOf(preview) };
    lastDex = dex;
    selected = null; pendingEvo = null;
    if (!again) { ghostByPointer = false; ghost.x = pl.x; ghost.y = pl.y; }
    G.Sprites.preload([dex], 4000, preview.shiny);
    refreshUI();
  }
  function cancelPlacing() { placing = null; refreshUI(); }

  /** Motivo por el que no se puede plantar en (x, y), o '' si se puede. */
  const whyNot = (x: number, y: number) => placementError(x, y, { path, towers: towers.map(t => t.p), bound });

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
    if (whyNot(x, y)) return null;
    // Un trofeo sólo se puede pedir si de verdad se ha ganado en esta partida.
    if (trophy && !trophies.includes(dex)) return null;
    const cost = trophy === undefined ? costOf(dex) : trophy ? trophyCostOf(dex) : costFor(dex, G.DEX_BY[dex].rarity);
    if (!pay(owner, cost)) { if (owner === me) G.Spawner.say('Te faltan monedas', 1.4, true); return null; }
    const p = makeTower(dex, shiny);
    p.x = x; p.y = y;
    const t: Tower = { id: nextTowerId++, owner, p, dex, shiny, level: 1, base: cost, spent: cost, mode: 'first', atk: p.atkMul, buff: noBuff(), learned: [] };
    towers.push(t);
    G.FX.ring(x, y, 8, 110, G.U.TYPE_COLOR[G.DEX_BY[dex].types[0]], 0.6, 5);
    if (owner === me) G.Audio.sfx('confirm');
    sendTower(t);
    return t;
  }

  /** Sube un nivel la torre: más ataque y, en los niveles de evolución, evoluciona. */
  function upgrade(t: Tower) {
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
  function levelMove(p) {
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
    if (SUPPORT[t.dex] || t.learned.length >= LEARN_MAX) return [];
    const known = new Set((t.p.activeGroup() as any[]).map(m => m.id));
    return towerPool(t.dex).filter(id => !known.has(id));
  }
  /** Mete el ataque `id` en el hueco de la torre, al nivel de la torre. */
  function teach(p, id: string, level: number) {
    const def = G.Moves.BY_ID[id];
    if (!def || (p.activeGroup() as any[]).some(m => m.id === id)) return;
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
  function evolveFx(p) {
    G.FX.ring(p.x, p.y, 10, 140, '#ffffff', 0.8, 6);
    G.FX.burst(p.x, p.y - 20, '#ffffff', 30, 200);
    G.Audio.sfx('legend');
  }

  function sell(t: Tower) {
    if (guest()) { G.Coop.toHost(['ts', t.id]); return; }
    const i = towers.indexOf(t);
    if (i < 0 || evoOf(t)) return;
    towers.splice(i, 1);
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
  function rangeOf(p) {
    const ms = p.activeGroup() as any[];
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

  /** @param who  quien lo ha cogido (en grupo puede ser un compañero) */
  function onCollect(p, who = pl) {
    const own = who === pl;
    // Invitado: son copias de los objetos del anfitrión; el efecto lo decide él.
    if (guest()) { if (own) G.Audio.sfx(p.kind === 'coin' ? 'coin' : p.kind === 'heal' ? 'heal' : 'xp'); return; }
    if (coop && G.Coop.active) G.Coop.collected(p, who);
    if (p.kind === 'xp' || p.kind === 'xpBig') { if (own) { G.Audio.sfx('xp'); pl.gainXp(p.value); } return; }
    if (p.kind === 'coin') {
      if (own) G.Audio.sfx('coin');
      earn(own ? me : who.uid, p.value, who.x, who.y - who.bodyH - 6);
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
    // Héroe caído: se levanta solo al rato (la base aguanta mientras con las torres).
    if (pl.dead) {
      downT += dt;
      if (downT > 5) { downT = 0; pl.revive(0.5); }
    }
    pl.update(dt);
    // El mapa es el claro: el héroe no se va más allá.
    const far = Math.hypot(pl.x, pl.y);
    if (far > bound) { pl.x *= bound / far; pl.y *= bound / far; }
    if (coop && G.Coop.active) for (const p of G.Coop.puppets()) { p.netUpdate(dt); G.Combat.ghostOrbit(p, dt, time); }
    // La cámara sigue al héroe, salvo si la has llevado a otro sitio con el minimapa (al mover al héroe, vuelve).
    if (pl.walking) camFree = null;
    G.Camera.follow(camFree ? camFree.x : pl.x, camFree ? camFree.y : pl.y, dt);
    G.World.update(dt, G.Camera);
  }

  /** Un paso de la partida entera (en solitario, o el anfitrión). */
  function step(dt: number) {
    time += dt;
    for (const p of path) p.level = pl.level;
    heroStep(dt);

    tickPhase(dt);
    if (Run.state !== 'playing') return;
    G.Spawner.tickBanner(dt);
    G.EnemyMgr.update(dt, everyone());
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
      const group = p.activeGroup() as any[], was = group.map(m => m.castAt);
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
    if (lives <= 0) end(true);
  }

  /**
   * Un paso en el invitado: tu héroe (sus golpes van al anfitrión), las copias de los
   * enemigos y de las torres (sus ataques llegan como 'tc'), y la cuenta atrás del descanso
   * (el anfitrión la corrige con cada 'tg').
   */
  function stepGuest(dt: number) {
    time += dt;
    heroStep(dt);
    G.Spawner.tickBanner(dt);
    G.EnemyMgr.update(dt, everyone());
    G.EnemyMgr.rebuildGrid();
    trackEnemies(dt);
    if (placing && !ghostByPointer) { ghost.x = pl.x; ghost.y = pl.y; }
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
    if (phase === 'break') phaseT = Math.max(0, phaseT - dt);
  }

  function idle(dt: number) { G.FX.update(dt * 0.25); pl.anim.update(dt * 0.25); }

  // ---------------- cooperativo ----------------
  // Ver la cabecera: qué manda cada uno y los mensajes.

  /** Anfitrión: una torre para los invitados (nueva o cambiada). */
  const towerEv = (t: Tower) => ['tt', t.id, t.owner, t.dex, Math.round(t.p.x), Math.round(t.p.y), t.level, t.mode, t.shiny ? 1 : 0, t.base, t.spent, t.learned.slice()];
  function sendTower(t: Tower) { if (coop && G.Coop.isHost) G.Coop.broadcast(towerEv(t)); }
  /** Anfitrión: vidas, oleada, cuenta atrás, monedas de cada uno... */
  const stateEv = () => ['tg', lives, wave, phase === 'wave' ? 1 : 0, Math.round(phaseT * 10) / 10,
                         toSpawn + bossLeft + G.EnemyMgr.all().filter(e => !e.dead).length,
                         fast ? 1 : 0, cleared, won ? 1 : 0, { ...purse }, leaked, pl.kills];
  function sendState() {
    if (!coop || !G.Coop.isHost) return;
    stateT = 0.25;
    G.Coop.broadcast(stateEv());
  }

  /** Anfitrión: lo que pide un invitado. Se comprueba aquí (que sea suya, que le llegue...). */
  function onGuestEvent(from: string, ev: any[]) {
    if (Run.state !== 'playing' || !(from in purse)) return;
    const t = typeof ev[1] === 'number' ? towerById(ev[1]) : null;
    const his = !!t && t.owner === from;
    switch (ev[0]) {
      case 'tp': {
        const x = +ev[2], y = +ev[3];
        const why = Number.isFinite(x) && Number.isFinite(y) ? whyNot(x, y) : 'Ahí no';
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
    }
  }

  /** Invitado: lo que cuenta el anfitrión. */
  function onHostEvent(ev: any[]) {
    switch (ev[0]) {
      case 'tt': upsertTower(ev); break;
      case 'tr': dropTower(ev[1]); break;
      case 'tz': for (const t of towers.slice()) dropTower(t.id); break;
      case 'tc': {
        const t = towerById(ev[1]);
        if (t) { G.Combat.ghostCast(t.p, ev[2], ev[3], ev[4], ev[5]); shots.set(t.p, (shots.get(t.p) || 0) + 1); }
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
  function upsertTower(a: any[]) {
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
    // Los ataques aprendidos (la copia sólo los necesita para las órbitas y el panel).
    for (const m of learned) if (!t.learned.includes(m)) { t.learned.push(m); teach(t.p, m, t.level); }
    refreshUI();
  }
  function dropTower(id: number) {
    const t = towerById(id);
    if (!t) return;
    towers.splice(towers.indexOf(t), 1);
    G.Projectiles.clearOrbs(t.p);
    if (selected === t) selected = null;
    if (pendingEvo && pendingEvo.tower === t) pendingEvo = null;
    refreshUI();
  }

  /** Anfitrión: lo que necesita un invitado que vuelve tras un corte (va detrás de los enemigos). */
  function resyncFor(u: string): any[][] {
    const evs: any[][] = [['tz'], ...trophies.map(d => ['tq', d])];
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
    syncTeam(t: any) { if (Math.abs(t.time - time) > 0.4) time = t.time; },
    // (Sin cartas de nivel, ni objetos, ni shinies en la Defensa.)
    levelStart() {}, waiting() {}, resume() {}, shiny() {}, item() {},
    // Invitado: el anfitrión no responde; mientras, los enemigos están parados (los mueve él).
    away(name: string | null) { hostAway = name; hudKey = ''; },
    over(d: any) {
      if (d && d.why === 'host') G.UI.toast('El anfitrión ha terminado la partida', 3000);
      finish(d && typeof d.w === 'number' ? d : summary(false));
    },
    lost(msg: string) { G.UI.toast(msg, 3000); finish(summary(false)); },
    /** Anfitrión: un compañero se ha ido para siempre; sus torres pasan a ser tuyas (siguen defendiendo). */
    mateLeft(m: any) {
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
    onEvent(from: string, ev: any[]) { if (G.Coop.isHost) onGuestEvent(from, ev); else onHostEvent(ev); },
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
  /** El minimapa (abajo a la derecha) y su lienzo. */
  let mapBox: HTMLElement | null = null, mapCv: HTMLCanvasElement | null = null;
  let mapOpen = true;
  /** Punto del mundo al que has llevado la cámara con el minimapa, o null (sigue al héroe). */
  let camFree: { x: number; y: number } | null = null;
  /** Qué enseña la tienda: favoritos, todos, o un tipo. */
  let shopFilter = 'all';
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
      #td-hud .td-team { display: flex; flex-direction: column; font-size: 12px; line-height: 1.2; }
      #td-hud .td-team b { color: var(--gold); }
      #td-hud .td-watch-hide { display: none !important; }
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
    buildMap();
    // Espectador: sólo se mira (sin tienda ni panel ni monedas propias).
    if (watching()) {
      shop.style.display = 'none'; panel.style.display = 'none'; tip.style.display = 'none';
      for (const sel of ['.td-money', '[data-a=next]', '[data-a=fast]', '[data-a=won]']) {
        const el = hud.querySelector(sel) as HTMLElement | null;
        if (el) el.classList.add('td-watch-hide');
      }
    }
    for (const el of [hud, shop, panel, tip, mapBox!]) {
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
    // En favoritos salen también los trofeos que vas ganando.
    let items = shopFilter === 'fav' ? [...team.map(dex => ({ dex, lent: false, trophy: false })), ...pool.filter(c => c.trophy)]
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
      b.insertAdjacentHTML('beforeend', `<span><b>${mon.name}</b><em style="font-style:normal">${k ? auraChip(k) : typeChip(t)} <span class="td-cost" style="display:inline">${costOf(c.dex)}</span>${c.trophy ? ' <small class="td-trophy">trofeo</small>' : ''}</em></span>`);
      b.onclick = e => { e.stopPropagation(); startPlacing(c.dex); };
      list.appendChild(b);
    }
    if (more > 0) list.insertAdjacentHTML('beforeend', `<p class="td-more">y ${more} más: filtra por tipo</p>`);
    refreshUI();
  }

  function hideUI() {
    for (const id of ['td-hud', 'td-shop', 'td-panel', 'td-tip', 'td-bar', 'td-map']) { const el = document.getElementById(id); if (el) el.remove(); }
    hud = shop = panel = tip = mapBox = null; mapCv = null;
  }

  // ---------------- minimapa ----------------
  // Todo el claro de un vistazo: el camino, las torres, los enemigos y los héroes, y un recuadro
  // con lo que ves. Pulsando (o arrastrando) en él, la cámara va allí sin mover al héroe; vuelve
  // al mover al héroe, con C o con el botón. M lo esconde.

  /** Radio del mundo que cabe en el minimapa (el claro entero: la entrada queda un poco fuera del borde). */
  const mapR = () => CLEAR * G.World.TS;

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
      const r = mapCv!.getBoundingClientRect(), R = mapR();
      let x = ((e.clientX - r.left) / r.width * 2 - 1) * R, y = ((e.clientY - r.top) / r.height * 2 - 1) * R;
      const d = Math.hypot(x, y);
      if (d > R) { x *= R / d; y *= R / d; }
      camFree = { x, y };
    };
    mapCv.addEventListener('pointerdown', e => { dragging = true; mapCv!.setPointerCapture(e.pointerId); go(e); });
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
    const ctx = mapCv.getContext('2d')!, R = mapR(), k = S / (2 * R);
    const X = (x: number) => S / 2 + x * k, Y = (y: number) => S / 2 + y * k;
    ctx.clearRect(0, 0, S, S);
    // El claro y su borde (hasta donde se puede construir).
    ctx.fillStyle = 'rgba(40, 90, 50, 0.9)';
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'; ctx.lineWidth = 1; ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.arc(S / 2, S / 2, bound * k, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
    // El camino, la entrada y la base.
    if (path.length > 1) {
      ctx.strokeStyle = 'rgba(214, 186, 132, 0.95)'; ctx.lineWidth = Math.max(2, 42 * k); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(X(path[0].x), Y(path[0].y)); for (const p of path) ctx.lineTo(X(p.x), Y(p.y)); ctx.stroke();
      const a = path[0], b = path[path.length - 1];
      ctx.fillStyle = '#ff5f6d'; ctx.beginPath(); ctx.arc(X(a.x), Y(a.y), 3.5 * dpr, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#4fb4ff'; ctx.beginPath(); ctx.arc(X(b.x), Y(b.y), 4.5 * dpr, 0, 6.2832); ctx.fill();
    }
    // Las torres: del color de su ataque (los apoyos, dorados) y, en grupo, con el de su dueño alrededor.
    for (const t of towers) {
      const x = X(t.p.x), y = Y(t.p.y), s = 3 * dpr;
      const oc = colorOf(t.owner);
      if (oc) { ctx.fillStyle = oc; ctx.fillRect(x - s - dpr, y - s - dpr, (s + dpr) * 2, (s + dpr) * 2); }
      ctx.fillStyle = SUPPORT[t.dex] ? '#ffd23f' : G.U.TYPE_COLOR[attackType(t.dex)] || '#ffffff';
      ctx.fillRect(x - s, y - s, s * 2, s * 2);
    }
    // Los enemigos (los jefes, más grandes).
    for (const e of G.EnemyMgr.all() as any[]) {
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
      const dex = +b.dataset.dex;
      b.disabled = money < costOf(dex) && !(placing && placing.dex === dex);
      b.classList.toggle('on', !!placing && placing.dex === dex);
    });
    paintPanel();
    tipKey = '-';                 // se repinta el aviso de abajo en el próximo fotograma
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
        ${k ? '' : `<p>Ataques: ${(t.p.activeGroup() as any[]).map(x => x.name).join(', ')}</p>`}
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
    const of = (n: number) => n > LAST_WAVE ? String(n) : n + '/' + LAST_WAVE;
    const title = guest() && hostAway ? `Esperando a ${hostAway}…`
      : phase === 'wave' ? `Oleada ${of(wave)} · ${cur.theme}` : `Oleada ${of(wave + 1)} en ${Math.max(1, Math.ceil(phaseT))} s · ${next.theme}`;
    const hint = phase === 'wave' ? `Quedan ${left} · ${cur.hint}` : next.hint;
    // En grupo, las monedas de cada compañero (con su color).
    const mates = coop ? coop.members.filter(m => m.uid !== me).map(m => m.uid + ':' + (purse[m.uid] || 0)).join(',') : '';
    const key = [lives, title, hint, phase, wave, fast, won, mates].join('|');
    if (key !== hudKey) {
      hudKey = key;
      (hud.querySelector('[data-k=lives]') as HTMLElement).textContent = String(Math.max(0, lives));
      (hud.querySelector('.td-lives') as HTMLElement).classList.toggle('low', lives <= 8);
      (hud.querySelector('[data-k=wave]') as HTMLElement).textContent = title;
      (hud.querySelector('[data-k=hint]') as HTMLElement).textContent = hint;
      const nb = hud.querySelector('[data-a=next]') as HTMLElement;
      nb.style.display = phase === 'break' ? '' : 'none';
      nb.textContent = wave === 0 ? '¡Empezar! (N)' : 'Ya (N)';
      const fb = hud.querySelector('[data-a=fast]') as HTMLButtonElement;
      fb.textContent = fast ? '×2' : '×1';
      fb.disabled = guest();
      fb.title = guest() ? 'La velocidad la elige el anfitrión' : 'Velocidad (F)';
      (hud.querySelector('[data-a=won]') as HTMLElement).style.display = won && hosting() ? '' : 'none';
      const tm = hud.querySelector('[data-k=team]') as HTMLElement;
      tm.style.display = coop ? '' : 'none';
      if (coop) {
        tm.innerHTML = coop.members.filter(m => m.uid !== me).map(m =>
          `<span translate="no" style="color:${colorOf(m.uid)}">${esc(m.name)} <b>${purse[m.uid] || 0}</b></span>`).join('');
      }
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
      // Lo que ocupa cada torre (no hay casillas: es un círculo; dos torres no pueden solaparse).
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'; ctx.lineWidth = 1.5;
      for (const t of towers) { ctx.beginPath(); ctx.arc(t.p.x, t.p.y, TOWER_GAP / 2, 0, 6.2832); ctx.stroke(); }
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
    for (const el of [hud, shop, panel, tip, mapBox]) if (el) el.style.visibility = show ? '' : 'hidden';
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
    ctx.restore();

    G.World.drawVignette(ctx, w, h);
    G.HUD.draw(ctx, w, h, watching() ? G.Spectate.target() || pl : pl, st);
    G.Touch.draw(ctx);
    if (show) drawMap();
  }

  return {
    id: 'td',
    start, update, idle, keysModal, keysPlay, drawables, drawGround, render, everyone,
    /** Abandonar: en grupo, sales tú (si eres el anfitrión, se acaba para todos). Lo conseguido se cobra. */
    quit() {
      if (coop && G.Coop.active) G.Coop.leave();
      end(false);
    },
    /** El menú abre aquí la elección de favoritos antes de empezar. */
    openTeam,
    // ---- para las pruebas ----
    debugBuy(dex: number) { startPlacing(dex); },
    debugPlace(x: number, y: number) { tryPlace(x, y); },
    debugUpgrade(i: number) { if (towers[i]) upgrade(towers[i]); },
    debugEvolve(to: number) { if (pendingEvo && pendingEvo.options.includes(to)) chooseEvo(pendingEvo.tower, to); },
    debugSelect(i: number) { selected = towers[i] || null; refreshUI(); },
    debugCycleMode(i: number) { if (towers[i]) cycleMode(towers[i]); },
    debugHero() { upgradeHero(); },
    debugLives(n: number) { if (hosting()) { lives = n; tampered = true; sendState(); } },
    debugWin() { if (hosting()) { wave = LAST_WAVE; phase = 'wave'; toSpawn = 0; bossLeft = 0; G.EnemyMgr.clear(); tampered = true; } },
    finishWon,
    debugSell(i: number) { if (towers[i]) sell(towers[i]); },
    debugMode(i: number, mode: TargetMode) { if (towers[i] && TARGET_MODES.includes(mode)) towers[i].mode = mode; },
    debugCallWave() { callWave(); },
    /** Saca ya un jefe (`dex`); con `legend`, un legendario. → su id */
    debugBoss(dex: number, legend = false) {
      if (!hosting() || !G.DEX_BY[dex]) return null;
      spawnEnemy(true, dex);
      const e = G.EnemyMgr.all().filter((x: any) => x instanceof Walker && x.chief).pop() as any;
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
    debugHpMul(k: number) { hpMul = k > 0 ? k : 1; if (hpMul !== 1) tampered = true; },
    canPlace(x: number, y: number) { return !whyNot(x, y); },
    /** La cámara a (x, y), como al pulsar en el minimapa (null: de vuelta al héroe). */
    debugCam(x: number | null, y = 0) { camFree = x == null ? null : { x, y }; },
    get cam() { return { x: G.Camera.x, y: G.Camera.y, free: !!camFree }; },
    get route() { return path.map(p => ({ x: p.x, y: p.y })); },
    get placing() { return placing ? { dex: placing.dex, x: ghost.x, y: ghost.y } : null; },
    get info() {
      return {
        wave, lives, leaked, phase, money: cash(), reach: Math.round(reach * 100) / 100, team: team.slice(), shop: pool.map(c => c.dex), heroLevel, won,
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
                                   moves: (t.p.activeGroup() as any[]).map(m => m.id), learned: t.learned.slice(), spent: t.spent })),
        evo: pendingEvo ? { id: pendingEvo.tower.id, options: pendingEvo.options.slice() } : null,
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
