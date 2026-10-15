import { G } from '../g';
import type { Player } from '../entities/player';
import type { Enemy } from '../entities/enemy';
import type { Pickup, PickupKind } from '../entities/pickup';
import type { TargetMode } from '../modes/td-geom';
import type { PokeType } from '../data/types';
/* ============ coop.js — partida cooperativa (hasta 4 jugadores) ============
 *
 * Quién manda en qué:
 *   ANFITRIÓN   enemigos (aparición, IA, vida, muerte), objetos del suelo,
 *               experiencia y nivel del equipo, reloj, fin de la partida.
 *   CADA UNO    su propio Pokémon: posición, vida, ataques y lo que le golpea.
 *               Sus golpes a enemigos se mandan al anfitrión, que los aplica.
 *
 * Los invitados ven COPIAS de los enemigos del anfitrión (enemy.remote) y los
 * ataques de los compañeros como "fantasmas" que no hacen daño (ver combat.js).
 *
 * Mensajes (por net.ts, unas 15 veces por segundo; 5 si la red va justa):
 *   invitado -> anfitrión  { k:'f', p:[estado], ev:[eventos] }
 *   anfitrión -> invitado  { k:'f', t, lv, xp, xn, ki, bo, co, p:{uid:[estado]},
 *                            e:[[id,x,y,vida,anim,dir,estados]], ev:[eventos],
 *                            ja:[x,y,anim,dir] (Arceus, sólo en la Sentencia) }
 *   anfitrión -> todos     { k:'start', seed, host, members:[{uid,name,dex,shiny}] }
 *
 * Cortes de conexión (o reinicio del servidor): los mensajes que se mandan mientras alguien no está
 * se pierden, pero el servidor le guarda el sitio en la sala (server/realtime.ts). Cuando vuelve
 * (Net avisa con el modo 'relay'), el anfitrión le reenvía el estado entero (resync): ['rs'] borra
 * las copias del invitado y siguen los enemigos, objetos y props rotos que hay ahora, más cómo está
 * la subida de nivel. El invitado guarda sus eventos (golpes, elegir carta...) hasta poder mandarlos.
 * El estado del mapa (Sentencia de Arceus, grieta/arena y clima) va en ['st', ...] justo después de ['rs'].
 *
 * ESPECTADORES (salas públicas; server/realtime.ts, room.watch): el anfitrión los añade como
 * compañeros "que miran" (`watcher`) cuando aparecen en la sala: les manda la partida igual
 * que a un invitado (los enemigos, cerca de donde miran), pero no son jugadores: no tienen
 * Pokémon en el mapa, no cuentan para la experiencia ni para las cartas, y de lo que mandan
 * sólo se mira dónde está su cámara. En el espectador (`watching`), todos los jugadores son
 * copias y se ignora lo que es de un jugador (cartas, objetos, curas...).
 *
 * Otros modos (el de Defensa, modes/td.ts) mandan sus propios eventos por el mismo
 * camino (broadcast / toHost) y los reciben en api.onEvent; los estados que añade
 * un enemigo con netBits() van en los bits 3 y siguientes de su estado.
 */
/** Un jugador de la partida (lo que manda el anfitrión al empezar). */
export interface CoopMember { uid: string; name: string; dex: number; shiny: boolean }
/** `watch`: entras como espectador (no eres uno de `members`). */
export interface CoopConfig {
  k?: string; seed: number; host: string; members: CoopMember[]; watch?: boolean;
  /** A qué se juega (por defecto, Survivor) y, en la Defensa, en qué mapa. */
  mode?: 'survivor' | 'td'; map?: string;
}
/** El equipo en una partida: lo que el anfitrión manda a los invitados en cada fotograma. */
export interface TeamState {
  time: number; level: number; xp: number; xpNext: number; kills: number; bosses: number; coins: number; t1: number; t10: number;
}
/** Lo que el modo de juego (modes/survivor.ts) le da a Coop para actuar sobre la partida. */
export interface CoopApi {
  team(): TeamState; summary?(): object; syncTeam(t: TeamState): void;
  levelStart(level: number): void; waiting(names: string[]): void; resume(): void;
  hold?(names: string[]): void; away?(name: string | null): void;
  shiny(dex: number): void; item(id: string): void;
  over(data: unknown): void; lost(msg: string): void; mateLeft?(m: Mate): void;
  /**
   * Eventos propios del modo (los que Coop no conoce): en el anfitrión, los de un
   * invitado (`from` = su uid); en el invitado, los del anfitrión. Ver modes/td.ts.
   */
  onEvent?(from: string, ev: TdHostEv | TdGuestEv): void;
  /** Anfitrión: eventos del modo que recuperan su estado tras un corte (van detrás de los enemigos). */
  resync?(u: string): HostEv[];
}
/**
 * Los eventos de red, [tipo, ...datos]. Viajan como JSON, con la forma de siempre; aquí sólo se
 * describen. Los datos que son de otro módulo (snapshots, la arena, los peligros) van como
 * `unknown`: quien los recibe los convierte a su tipo (ver applyHostEvent).
 */
/** Anfitrión -> invitados: lo que lleva Coop. */
type CoreHostEv =
  | ['rs'] | ['st', unknown, unknown, unknown]
  | ['ne', id: number, dex: number, x: number, y: number, boss: number, shiny: number, hp: number, dmg: number, behavior: string]
  | ['ed', id: number] | ['eg', id: number]
  | ['hn', id: number, dmg: number, color: string]
  | ['es', x: number, y: number, vx: number, vy: number, dmg: number, r: number, life: number, type: PokeType]
  | ['c', uid: string, move: string, lvl: number, aim: number, evolved: number]
  | ['item', id: string]
  | ['pk', id: number, kind: PickupKind, x: number, y: number, value: number | string] | ['pc', id: number]
  | ['mag'] | ['bomb', x: number, y: number] | ['pb', tx: number, ty: number]
  | ['say', text: string, secs?: number] | ['heal', fraction: number]
  | ['lu', level: number] | ['lw', names: string[]] | ['lr'] | ['hp', names: string[]]
  | ['ha', away: number] | ['sh', dex: number] | ['ov', summary: unknown]
  | ['hz', hazard: unknown] | ['fxr', x: number, y: number, r: number, color: string];
/** Anfitrión -> invitados: lo de los sistemas del Survivor (grieta, Sentencia, clima, eventos). */
export type SystemHostEv =
  | ['rift', x: number, y: number, ttl: number] | ['riftx'] | ['arena', cfg: unknown] | ['aw'] | ['al']
  | ['jd', cfg: unknown] | ['jk']
  | ['wx', kind: string, dur: number]
  | ['ev', 's', id: string, type: string] | ['ev', 'e']
  | ['ev', 'lp', dex: number, x: number, y: number, hp: number, follow: number, tx: number, ty: number, dir: number, moving: number]
  | ['ev', 'rw', dex: number, grant: number] | ['ev', 'lx', msg: string];
/** Anfitrión -> invitados: lo de la Defensa (modes/td.ts). */
export type TdHostEv =
  | ['tq', dex: number] | ['tx', x: number, y: number, text: string, color: string]
  | ['tb', id: number, kind: string] | ['tv', id: number, options: number[]] | ['tr', id: number] | ['tz']
  | ['th', uid: string, level: number]
  | ['tc', id: number, move: string, lvl: number, aim: number, evolved: number]
  | ['tn', uid: string, why: string]
  | ['tt', id: number, owner: string, dex: number, x: number, y: number, level: number, mode: TargetMode, shiny: number, base: number, spent: number, learned: string[]]
  | ['tg', lives: number, wave: number, inWave: number, phaseT: number, left: number, fast: number, cleared: number, won: number,
         purse: Record<string, number>, leaked: number, kills: number];
export type HostEv = CoreHostEv | SystemHostEv | TdHostEv;
/** Invitado -> anfitrión. */
type CoreGuestEv =
  | ['h', id: number, dmg: number, color: string, dx: number, dy: number, knock: number]
  | ['s', id: number, kind: string, value: number]
  | ['c', move: string, lvl: number, aim: number, evolved: number]
  | ['pb', tx: number, ty: number]
  | ['lp'] | ['hs'] | ['he'] | ['re'] | ['bye'] | ['ws'];
export type TdGuestEv =
  | ['tw'] | ['th'] | ['tp', dex: number, x: number, y: number, shiny: number, trophy: number]
  | ['tu', id: number] | ['ts', id: number] | ['tl', id: number, move: string] | ['te', id: number, to: number]
  | ['tm', id: number, mode: TargetMode];
export type GuestEv = CoreGuestEv | TdGuestEv;
export type Ev = HostEv | GuestEv;
/** Estado de un jugador por la red (ver myState / readState). */
type StateArr = [x: number, y: number, ang: number, walk: number, hp: number, maxHp: number, dead: number, mv: string, ml: number,
               mag: number, aim: number, xpMul: number, rev: number];
/** Un enemigo en el fotograma del anfitrión: id, x, y, vida, animación, dirección, estados. */
type EnemyRow = [id: number, x: number, y: number, hp: number, anim: number, dir: number, st: number];
/** Fotograma del anfitrión a un invitado. */
interface HostFrame { k: string; t: number; lv: number; xp: number; xn: number; ki: number; bo: number; co: number; tk?: number[];
                    p?: Record<string, StateArr>; e?: EnemyRow[]; ev?: HostEv[]; ja?: number[] }
/** Fotograma de un invitado al anfitrión. */
interface ClientFrame { k: string; p?: StateArr; ev?: GuestEv[] }
/** Lo mínimo que Coop lee de un disparo enemigo. */
interface ShotLike { x: number; y: number; vx: number; vy: number; dmg: number; r: number; life: number }
/** Un compañero de la partida (lo que lleva el anfitrión de cada uno). */
export interface Mate {
  uid: string; name: string; color: string; pl: Player; connected: boolean; watcher?: boolean;
  q: HostEv[]; owed: HostEv[]; flushT: number; xpMul: number; state?: StateArr;
}

export const Coop = (() => {
  const ANIMS = ['Idle', 'Walk', 'Attack', 'Shoot', 'Charge', 'Hurt', 'Faint'];
  // Un color por jugador (el Survivor usa los 4 primeros; la Defensa, hasta 8).
  const COLORS = ['#ffcb3d', '#5fc8ff', '#7ee07a', '#ff8ad8', '#ff9a3d', '#b48cff', '#7fe0e0', '#ff6b6b'];
  // Ritmo de los estados, por el servidor (net.ts): 15 por segundo, lo que la
  // interpolación del invitado (enemigos y compañeros) ya tenía ajustado cuando iba
  // directo. Por un WebSocket no hay motivo para menos: el servidor no cobra por GB
  // y un fotograma ronda unos pocos KB (unos 50 KB/s por invitado). Más de 15 no se
  // nota con la interpolación y gasta más datos móviles. Si la red de ese jugador va
  // justa (los mensajes se acumulan sin salir; Net.slow), baja a 5 en vez de seguir
  // apilando: el WebSocket es fiable y ordenado, y la cola sólo añadiría retraso.
  const RATE_FAST = 1 / 15, RATE_SLOW = 1 / 5;
  const rateFor = (u: string) => (G.Net.slow(u) ? RATE_SLOW : RATE_FAST);
  const NEAR = 950;                     // radio de enemigos que se mandan a cada uno
  /** Eventos por fotograma como mucho: un reenvío de estado (cientos) va repartido en varios y no pasa de 64 KB. */
  const MAX_EV = 150;
  /** Eventos del invitado que se guardan mientras no hay conexión. */
  const MAX_OUT = 300;
  /** Enemigos por fotograma como mucho (~35 B cada uno: el fotograma entero se queda muy por debajo de los 64 KB del servidor). */
  const MAX_E = 900;

  let active = false, host = false, me: string | null = null, hostUid: string | null = null;
  /** Eres espectador en esta partida. */
  let watching = false;
  let local: Player | null = null;                     // tu Player
  const mates = new Map<string, Mate>();              // uid -> { uid, name, color, pl, connected, q:[], flushT, xpMul }
  let outEv: GuestEv[] = [];                       // invitado: eventos para el anfitrión
  let flushT = 0;
  let hitFrom: string | null = null;                   // invitado cuyo golpe se está aplicando (no repetirle el número)
  let api = {} as CoopApi;             // callbacks del juego (modes/survivor.ts)
  let waiting = new Set<string>();              // subida de nivel: quién falta por elegir
  let holds = new Set<string>();                // quién está eligiendo una fusión (la partida se para para todos)
  // El anfitrión mueve a los enemigos: si cambia de pestaña (o se le congela),
  // todo se para para todos. Antes los enemigos se quedaban quietos y los demás
  // seguían jugando con una ventaja enorme.
  let hostAway = false, stalled = false, lastHostAt = 0;
  const STALL_MS = 2500;
  let members: CoopMember[] = [];
  let broken: string[] = [];            // anfitrión: props rotos en esta partida ("tx,ty"), para reenviarlos

  // ---------------- escalado de dificultad ----------------

  const scaleRate = (n: number) => 1 + 0.75 * Math.max(0, n - 1);
  const scaleHp = (n: number) => 1 + 0.3 * Math.max(0, n - 1);

  // ---------------- arranque / fin ----------------

  /**
   * @param cfg   { seed, host, members }
   * @param pl    tu Player (ya creado)
   * @param cb    { levelStart(lv), resume(), waiting(names), over(data), lost(msg), team(t), shiny(dex) }
   */
  function begin(cfg: CoopConfig, pl: Player, cb: CoopApi) {
    active = true;
    me = G.Net.uid; hostUid = cfg.host;
    host = me === hostUid;
    watching = !!cfg.watch && !host;
    local = pl;
    api = cb;
    members = cfg.members;
    mates.clear();
    outEv = []; flushT = 0; waiting = new Set(); holds = new Set(); broken = [];
    hostAway = false; stalled = false; lastHostAt = performance.now();
    // Espectador: en cuanto tiene la partida montada, pide el estado entero (lo que el anfitrión
    // le mandó al verlo llegar pudo llegar antes de esto, y entonces se perdió).
    if (cfg.watch && cfg.host !== me) outEv.push(['ws']);
    cfg.members.forEach((m, i) => {
      const x = (i - (cfg.members.length - 1) / 2) * 34, y = 0;
      if (m.uid === me) { pl.x = x; pl.y = y; pl.uid = me; pl.coopHost = host; pl.tagColor = COLORS[i]; return; }
      const mon = G.DEX_BY[m.dex] || G.DEX_BY[25];
      const p = new G.Player(mon, {}, !!m.shiny);
      p.remote = true; p.uid = m.uid; p.tag = m.name; p.tagColor = COLORS[i]; p.revLabel = 'Quédate a su lado';
      p.x = x; p.y = y;
      p.net = { x, y, ang: Math.PI / 2, walk: 0, hp: p.maxHp, maxHp: p.maxHp, dead: 0, mv: G.startMoveOf(mon.dex), ml: 1, mag: 78, aim: Math.PI / 2, rev: 0 };
      G.Sprites.preload([mon.dex], 8000, p.shiny);
      mates.set(m.uid, { uid: m.uid, name: m.name, color: COLORS[i], pl: p, connected: true, q: [], owed: [], flushT: 0, xpMul: 1 });
    });
  }

  function end() {
    active = false; host = false; local = null; watching = false;
    mates.clear(); outEv = []; waiting = new Set(); holds = new Set();
  }

  /** Te vas de la partida (los demás siguen). */
  function leave() {
    if (!active) return;
    if (host) {
      // Si se va el anfitrión, la partida termina para todos.
      emit(['ov', Object.assign(api.summary ? api.summary() : {}, { why: 'host' })]);
      flushAll();
    } else {
      outEv.push(['bye']);
      flushClient(true);
    }
    end();
  }

  // ---------------- lista de jugadores ----------------

  /** Los jugadores de la partida (tú primero; el espectador no es jugador, ni los que miran). */
  function players() {
    const out: Player[] = watching ? [] : [local!];
    for (const m of mates.values()) if (m.connected && !m.watcher) out.push(m.pl);
    return out;
  }
  function puppets() { const out: Player[] = []; for (const m of mates.values()) if (m.connected && !m.watcher) out.push(m.pl); return out; }

  // ---------------- espectadores (anfitrión) ----------------

  /** Alguien empieza a mirar: se le trata como a un invitado que vuelve (se le manda todo). */
  function addWatcher(u: string, name: string) {
    if (!host || !active || mates.has(u)) return;
    mates.set(u, { uid: u, name, color: '#ffffff', pl: { x: 0, y: 0 } as Player, connected: true, watcher: true, q: [], owed: [], flushT: 0, xpMul: 1 });
    resync(u);
  }
  /** Anfitrión: los que miran según la sala (server/realtime.ts los cuenta en la sala). */
  function syncWatchers(list: { uid: string; name: string }[]) {
    if (!host || !active) return;
    const ids = new Set(list.map(w => w.uid));
    for (const [u, m] of [...mates]) if (m.watcher && !ids.has(u)) mates.delete(u);
    for (const w of list) if (!mates.has(w.uid) && G.Net.mode(w.uid) === 'relay') addWatcher(w.uid, w.name);
  }

  /**
   * Multiplicador de la experiencia del equipo: la media de los bonus de
   * cada uno, y repartida entre los que sois (en grupo cae mucho más, y si no
   * se subiría de nivel el triple de rápido que en solitario).
   */
  function xpFactor() {
    let s = local!.xpMul, n = 1;
    for (const m of mates.values()) if (m.connected && !m.watcher) { s += m.xpMul || 1; n++; }
    return (s / n) / local!.xpMul / (1 + 0.6 * (n - 1));
  }

  // ---------------- estado de un jugador ----------------

  const r1 = (v: number) => Math.round(v), r2 = (v: number) => Math.round(v * 100) / 100;

  function myState(): StateArr {
    // Con un vínculo se manda la órbita si la hay (es lo único que los demás no ven por los 'c').
    const g = local!.activeGroup();
    const m = g.find(x => x.kind === 'orbit') || g[0];
    return [r1(local!.x), r1(local!.y), r2(local!.moveAngle), local!.walking ? 1 : 0, r1(local!.hp), r1(local!.maxHp),
            local!.dead ? 1 : 0, m ? m.id : '', m ? m.lvl : 1, r1(local!.magnet), r2(local!.aim), r2(local!.xpMul),
            r2(local!.reviveT || 0)];
  }

  function readState(a: StateArr) {
    return { x: a[0], y: a[1], ang: a[2], walk: a[3], hp: a[4], maxHp: a[5], dead: a[6], mv: a[7], ml: a[8],
             mag: a[9], aim: a[10], xpMul: a[11], rev: a[12] };
  }

  // ---------------- envío ----------------

  /** Anfitrión: evento para todos los invitados (menos `except`). */
  function emit(ev: HostEv, except?: string) {
    if (!host) return;
    for (const m of mates.values()) if (m.connected && m.uid !== except) m.q.push(ev);
  }

  /** Anfitrión: evento sólo para los que están cerca (números de daño). */
  function emitNear(ev: HostEv, x: number, y: number, except?: string | null) {
    for (const m of mates.values()) {
      if (!m.connected || m.uid === except) continue;
      if (G.U.dist2(m.pl.x, m.pl.y, x, y) > 700 * 700) continue;
      if (m.q.length > 400) continue;
      m.q.push(ev);
    }
  }

  function enemyList(near: { x: number; y: number }): EnemyRow[] {
    const out: EnemyRow[] = [];
    const r2n = NEAR * NEAR;
    for (const e of G.EnemyMgr.all()) {
      if (e.dead || G.U.dist2(e.x, e.y, near.x, near.y) > r2n) continue;
      if (out.length >= MAX_E) break;
      const a = ANIMS.indexOf(e.anim.cur);
      out.push([e.id, r1(e.x), r1(e.y), Math.ceil(e.hp), a < 0 ? 0 : a, e.anim.dir,
                (e.burn > 0 ? 1 : 0) | (e.poison > 0 ? 2 : 0) | (e.shield > 0 ? 4 : 0) | ((e.netBits ? e.netBits() : 0) << 3)]);
    }
    return out;
  }

  function hostFrame(m: Mate) {
    const st = api.team();
    const p: Record<string, StateArr> = { [me!]: myState() };
    for (const o of mates.values()) {
      if (o.connected && !o.watcher && o.uid !== m.uid && o.state) p[o.uid] = o.state;
    }
    const ev = m.q.splice(0, MAX_EV);
    const f: HostFrame = { k: 'f', t: r2(st.time), lv: st.level, xp: r2(st.xp), xn: st.xpNext, ki: st.kills, bo: st.bosses, co: st.coins, tk: [st.t1, st.t10],
                p, e: enemyList(m.pl), ev };
    const ja = G.Judgment.netState();       // Arceus en la Sentencia
    if (ja) f.ja = ja;
    return f;
  }

  /** Sin conexión con el servidor no sale nada: se tira lo pendiente (al volver, resync). */
  function frameFor(m: Mate) {
    if (G.Net.up) return hostFrame(m);
    m.q.length = 0;
    return null;
  }

  function flushAll() {
    for (const m of mates.values()) {
      if (!m.connected) continue;
      const f = frameFor(m);
      if (f) G.Net.send(m.uid, f);
    }
  }

  /** Invitado: manda sus eventos; si no ha podido, los guarda (con tope) para el siguiente intento. */
  function sendOut() {
    if (G.Net.toHost({ k: 'f', p: myState(), ev: outEv })) outEv = [];
    else if (outEv.length > MAX_OUT) outEv.splice(0, outEv.length - MAX_OUT);
  }

  function flushClient(force?: boolean) {
    if (!force && !outEv.length && flushT > 0) return;
    sendOut();
  }

  /** Cada fotograma (también en la pantalla de subida de nivel). */
  function tick(dt: number) {
    if (!active) return;
    if (host) {
      for (const m of mates.values()) {
        if (!m.connected) continue;
        m.flushT -= dt;
        if (m.flushT > 0) continue;
        m.flushT = rateFor(m.uid);
        const f = frameFor(m);
        if (f) G.Net.send(m.uid, f);
      }
    } else {
      if (!stalled && performance.now() - lastHostAt > STALL_MS) { stalled = true; updateAway(); }
      flushT -= dt;
      if (flushT <= 0) {
        flushT = rateFor(hostUid!);
        sendOut();
      }
    }
  }

  // ---------------- recepción ----------------

  G.Net.on((from, msg) => {
    if (!msg) return;
    // Empezar la partida sólo vale si lo manda el anfitrión de la sala (el servidor también lo exige).
    if (msg.k === 'start') { if (from === G.Net.hostUid && G.Flow.startCoop) G.Flow.startCoop(msg as CoopConfig); return; }
    if (!active || msg.k !== 'f') return;
    if (host) onClientFrame(from, msg); else if (from === hostUid) onHostFrame(msg as HostFrame);
  });

  G.Net.onPeer((u, mode) => {
    if (!active) return;
    // Un compañero que vuelve tras un corte: se le reenvía todo lo que se ha perdido. Alguien que
    // empieza a mirar (está entre los espectadores de la sala): se le añade y se le manda todo.
    if (mode === 'relay') {
      if (!host) return;
      if (mates.has(u)) { resync(u); return; }
      const w = G.Social.room && (G.Social.room.watchers || []).find(x => x.uid === u);
      if (w) addWatcher(u, w.name);
      return;
    }
    if (mode !== 'closed') return;
    if (host) mateGone(u);
    else if (u === hostUid) { const cb = api.lost; end(); if (cb) cb('Se ha perdido la conexión con el anfitrión.'); }
  });

  /** Anfitrión: el estado de la partida para `u`, que ha estado sin conexión (sustituye a lo que tuviera pendiente). */
  function resync(u: string) {
    const m = mates.get(u);
    if (!host || !m || !m.connected) return;
    // Primero lo que cambia el mapa (Sentencia, grieta, clima), luego lo que hay en él.
    const evs: HostEv[] = [['rs'], ['st', G.Judgment.snapshot(), G.Rift.snapshot(), G.Weather.snapshot()]];
    for (const e of G.EnemyMgr.all()) if (!e.dead && !e.remote) evs.push(enemyEv(e));
    for (const o of G.Pickups.all()) if (o.id != null) evs.push(['pk', o.id, o.kind, r1(o.x), r1(o.y), o.value]);
    for (const k of broken) { const [x, y] = k.split(','); evs.push(['pb', +x, +y]); }
    if (waiting.size) {
      if (waiting.has(u)) evs.push(['lu', api.team().level]);
      evs.push(['lw', [...waiting].map(nameOf)]);
    } else evs.push(['lr']);
    evs.push(['hp', holdNames()]);
    if (api.resync) evs.push(...api.resync(u));
    evs.push(...m.owed.splice(0));
    m.q = evs;
  }

  function mateGone(u: string) {
    const m = mates.get(u);
    if (!m || !m.connected) return;
    // Quien miraba se va sin más.
    if (m.watcher) { mates.delete(u); return; }
    m.connected = false;
    G.Projectiles.clearOrbs(m.pl);
    G.Spawner.say(m.name + ' ha dejado la partida', 2.6);
    if (waiting.has(u)) picked(u);
    if (holds.has(u)) holdOff(u);
    if (api.mateLeft) api.mateLeft(m);
  }

  // --- en el anfitrión ---

  function onClientFrame(from: string, msg: ClientFrame) {
    const m = mates.get(from);
    if (!m || !m.connected) return;
    // Un espectador sólo dice dónde mira (para mandarle los enemigos de cerca); y si se va.
    if (m.watcher) {
      if (Array.isArray(msg.p) && Number.isFinite(msg.p[0]) && Number.isFinite(msg.p[1])) { m.pl.x = msg.p[0]; m.pl.y = msg.p[1]; }
      if ((msg.ev || []).some(e => e && e[0] === 'bye')) { mates.delete(from); return; }
      if ((msg.ev || []).some(e => e && e[0] === 'ws')) resync(from);
      return;
    }
    if (msg.p) { m.state = msg.p; m.pl.net = readState(msg.p); m.xpMul = m.pl.net.xpMul || 1; }
    for (const ev of msg.ev || []) {
      switch (ev[0]) {
        case 'h': {
          const e = G.EnemyMgr.get(ev[1]);
          if (!e || e.dead || e.remote) break;
          hitFrom = from;
          e.hurt(ev[2], ev[3], ev[4], ev[5], ev[6]);
          hitFrom = null;
          break;
        }
        case 's': {
          const e = G.EnemyMgr.get(ev[1]);
          if (!e || e.dead) break;
          if (ev[2] === 'b') e.applyBurn(ev[3]);
          else if (ev[2] === 'p') e.applyPoison(ev[3]);
          else if (ev[2] === 's') e.applySlow(ev[3]);
          break;
        }
        case 'c':
          G.Combat.ghostCast(m.pl, ev[1], ev[2], ev[3], !!ev[4]);
          emit(['c', from, ev[1], ev[2], ev[3], ev[4]], from);
          break;
        case 'pb':
          G.World.breakAt(ev[1], ev[2]);
          noteBroken(ev[1], ev[2]);
          emit(['pb', ev[1], ev[2]], from);
          break;
        case 'lp': picked(from); break;
        case 'hs': holdOn(from); break;
        case 'he': holdOff(from); break;
        case 're': G.Rift.enterRequest(); break;
        case 'bye': mateGone(from); break;
        default: if (api.onEvent) api.onEvent(from, ev as TdGuestEv);
      }
    }
  }

  // --- en el invitado ---

  /** Invitado: se para (o sigue) según si el anfitrión está. */
  function updateAway() { if (api.away) api.away(hostAway || stalled ? nameOf(hostUid!) : null); }

  // Anfitrión: al irse de la pestaña avisa a todos al momento (después ya no
  // podrá mandar nada) y al volver, que sigue.
  document.addEventListener('visibilitychange', () => {
    if (!active || !host) return;
    emit(['ha', document.hidden ? 1 : 0]);
    flushAll();
  });

  function onHostFrame(msg: HostFrame) {
    lastHostAt = performance.now();
    if (stalled) { stalled = false; updateAway(); }
    for (const ev of msg.ev || []) { applyHostEvent(ev); if (!active) return; }    // ('ov' acaba la partida: lo demás ya sobra)
    if (msg.ja) G.Judgment.netApply(msg.ja as Parameters<typeof G.Judgment.netApply>[0]);
    api.syncTeam({ time: msg.t, level: msg.lv, xp: msg.xp, xpNext: msg.xn, kills: msg.ki, bosses: msg.bo, coins: msg.co,
                   t1: (msg.tk || [])[0], t10: (msg.tk || [])[1] });
    for (const u in msg.p || {}) {
      const m = mates.get(u);
      if (m) m.pl.net = readState(msg.p![u]);
    }
    const now = performance.now();
    for (const a of msg.e || []) {
      const e = G.EnemyMgr.get(a[0]);
      if (!e || !e.remote || e.dead) continue;
      const n = e.net as typeof e.net & { last?: number };
      const dts = (now - (n.last || now)) / 1000;
      if (dts > 0.02 && dts < 1) {
        n.vx = G.U.clamp((a[1] - n.x) / dts, -600, 600);
        n.vy = G.U.clamp((a[2] - n.y) / dts, -600, 600);
      } else { n.vx = 0; n.vy = 0; }
      n.x = a[1]; n.y = a[2]; n.age = 0; n.last = now;
      e.hp = Math.min(e.maxHp, a[3]);
      n.anim = a[4]; n.dir = a[5]; n.st = a[6];
    }
  }

  /** Lo que es de un jugador (cartas, objetos, curas, imán...): el espectador no lo tiene. */
  const PLAYER_ONLY = new Set(['item', 'heal', 'mag', 'lu', 'lw', 'lr', 'hp', 'sh']);
  function applyHostEvent(ev: HostEv) {
    if (watching && PLAYER_ONLY.has(ev[0])) return;
    switch (ev[0]) {
      case 'rs': G.EnemyMgr.clearRemote(); G.Pickups.clear(); break;       // el anfitrión va a reenviar todo
      case 'st':
        G.Judgment.restore(ev[1] as Parameters<typeof G.Judgment.restore>[0]);
        G.Rift.restore(ev[2] as Parameters<typeof G.Rift.restore>[0]);
        G.Weather.restore(ev[3] as Parameters<typeof G.Weather.restore>[0]);
        break;
      case 'ne':
        G.EnemyMgr.addRemote({ id: ev[1], dex: ev[2], x: ev[3], y: ev[4], boss: !!ev[5], shiny: !!ev[6], hp: ev[7], dmg: ev[8], beh: ev[9] });
        break;
      case 'ed': G.EnemyMgr.removeRemote(ev[1], true); break;
      case 'eg': G.EnemyMgr.removeRemote(ev[1], false); break;
      case 'hn': { const e = G.EnemyMgr.get(ev[1]); if (e && !e.dead) e.showHurt(ev[2], ev[3]); break; }
      case 'es':
        G.Projectiles.spawn({ x: ev[1], y: ev[2], vx: ev[3], vy: ev[4], dmg: ev[5], r: ev[6], life: ev[7],
                              friendly: false, color: '#ff7a9e', vis: G.VFX.forType(ev[8]), mtype: ev[8] });
        break;
      case 'c': {
        const [, uid, id, lvl, aim, evolved] = ev as Extract<HostEv, { 0: 'c' }>;
        const m = mates.get(uid); if (m) G.Combat.ghostCast(m.pl, id, lvl, aim, !!evolved); break;
      }
      case 'item': api.item(ev[1]); break;
      case 'pk': G.Pickups.addRemote(ev[1], ev[2], ev[3], ev[4], ev[5]); break;
      case 'pc': G.Pickups.removeId(ev[1]); break;
      case 'mag': G.Pickups.pullAll(); G.FX.ring(local!.x, local!.y, 10, 420, '#ff9ed8', 0.6, 4); break;
      case 'bomb':
        G.FX.ring(ev[1], ev[2], 20, G.Camera.outerRadius(), '#ff7b3d', 0.5, 6);
        if (G.U.dist2(ev[1], ev[2], local!.x, local!.y) < 500 * 500) G.Camera.kick(0.8);
        G.Audio.sfx('break');
        break;
      case 'pb': G.World.breakAt(ev[1], ev[2]); break;
      case 'say': G.Spawner.say(ev[1], ev[2]); break;
      case 'heal': if (!local!.dead) { local!.heal(local!.maxHp * ev[1]); G.FX.ring(local!.x, local!.y, 6, 60, '#5fe08a', 0.4, 3); } break;
      case 'lu': api.levelStart(ev[1]); break;
      case 'lw': api.waiting(ev[1]); break;
      case 'lr': api.resume(); break;
      case 'hp': api.hold && api.hold(ev[1]); break;
      case 'ha': hostAway = !!ev[1]; updateAway(); break;
      case 'sh': api.shiny(ev[1]); break;
      case 'ov': { const cb = api.over; const d = ev[1]; end(); cb(d); break; }
      case 'rift': case 'riftx': case 'arena': case 'aw': case 'al': G.Rift.onEvent(ev as Parameters<typeof G.Rift.onEvent>[0]); break;
      case 'jd': case 'jk': G.Judgment.onEvent(ev as Parameters<typeof G.Judgment.onEvent>[0]); break;
      case 'wx': G.Weather.onEvent(ev); break;
      case 'ev': G.Events.onNet(ev); break;
      case 'hz': G.Hazards.add(ev[1] as Parameters<typeof G.Hazards.add>[0], true); break;
      case 'fxr': G.FX.ring(ev[1], ev[2], 8, ev[3], ev[4], 0.5, 3); break;
      default: if (api.onEvent) api.onEvent(hostUid!, ev as TdHostEv);
    }
  }

  // ---------------- ganchos que llaman los módulos del juego ----------------

  /** Tu ataque: los demás lo repiten como fantasma. */
  function cast(pl: Player, m: Player['moves'][number]) {
    if (!active || pl !== local || watching) return;
    if (host) emit(['c', me!, m.id, m.lvl, r2(pl.aim), m.evolved ? 1 : 0]);
    else outEv.push(['c', m.id, m.lvl, r2(pl.aim), m.evolved ? 1 : 0]);
  }

  // invitado
  function hit(e: Enemy, d: number, color: string, dx: number, dy: number, knock?: number) { outEv.push(['h', e.id, d, color, r1(dx), r1(dy), knock || 0]); }
  function status(e: Enemy, kind: string, val: number) { outEv.push(['s', e.id, kind, val]); }

  // anfitrión
  function hurtShown(e: Enemy, d: number, color: string) { emitNear(['hn', e.id, d, color], e.x, e.y, hitFrom); }
  const enemyEv = (e: Enemy): HostEv => ['ne', e.id, e.dex, r1(e.x), r1(e.y), e.boss ? 1 : 0, e.shiny ? 1 : 0, Math.ceil(e.maxHp), r2(e.dmg), e.behavior];
  function enemyAdded(e: Enemy) { emit(enemyEv(e)); }
  function enemyGone(e: Enemy, died: boolean) { emit([died ? 'ed' : 'eg', e.id]); }
  function enemyShot(p: ShotLike, type: PokeType) { emit(['es', r1(p.x), r1(p.y), r1(p.vx), r1(p.vy), r2(p.dmg), p.r, p.life, type]); }
  function pickupAdded(o: Pickup) { emit(['pk', o.id, o.kind, r1(o.x), r1(o.y), o.value]); }
  function pickupGone(id: number) { emit(['pc', id]); }
  function say(text: string, secs?: number) { emit(['say', text, secs]); }

  function noteBroken(tx: number, ty: number) { if (broken.length < 3000) broken.push(tx + ',' + ty); }
  function propBroken(p: { tx: number; ty: number }) {
    if (host) { noteBroken(p.tx, p.ty); emit(['pb', p.tx, p.ty]); }
    else outEv.push(['pb', p.tx, p.ty]);
  }

  /** Anfitrión: alguien ha cogido un objeto. Devuelve true si es para ti. */
  function collected(p: Pickup, who: Player) {
    emit(['pc', p.id]);
    if (p.kind === 'magnet') emit(['mag']);
    if (p.kind === 'bomb') emit(['bomb', r1(who.x), r1(who.y)]);
    if ((p.kind === 'heal' || p.kind === 'item') && who !== local) {
      const m = mates.get(who.uid);
      if (m) {
        m.q.push(p.kind === 'heal' ? ['heal', 0.3] : ['item', p.value as string]);
        // Un objeto para alguien sin conexión no se pierde: se le da al volver (resync).
        if (p.kind === 'item' && G.Net.mode(who.uid) !== 'relay' && m.owed.length < 20) m.owed.push(['item', p.value as string]);
      }
    }
  }

  function shinyCaught(e: { dex: number }) { emit(['sh', e.dex]); }

  // ---------------- subida de nivel compartida ----------------

  function levelStart(level: number) {
    waiting = new Set([me!]);
    for (const m of mates.values()) if (m.connected && !m.watcher) waiting.add(m.uid);
    emit(['lu', level]);
    flushAll();
    api.levelStart(level);
    sendWaiting();
  }

  function nameOf(u: string) { return u === me ? (G.Social.me ? G.Social.me.name : 'Tú') : (mates.get(u) || {}).name || '?'; }

  function sendWaiting() {
    const names = [...waiting].map(nameOf);
    emit(['lw', names]);
    api.waiting(names);
  }

  /** Alguien ha elegido carta (anfitrión). */
  function picked(u: string) {
    if (!waiting.delete(u)) return;
    if (waiting.size) { sendWaiting(); return; }
    emit(['lr']);
    flushAll();
    api.resume();
  }

  // ---------------- fusiones: pausa para todos ----------------
  // Mientras alguien elige qué movimientos fusiona (vínculo de un legendario),
  // la partida se para para todos, como con las cartas de nivel.

  function holdNames() { return [...holds].map(nameOf); }

  /** Anfitrión: `u` empieza a elegir. */
  function holdOn(u: string) {
    holds.add(u);
    emit(['hp', holdNames()]); flushAll();
    api.hold && api.hold(holdNames());
  }

  /** Anfitrión: `u` ha terminado (o se ha ido). */
  function holdOff(u: string) {
    if (!holds.delete(u)) return;
    emit(['hp', holdNames()]); flushAll();
    api.hold && api.hold(holdNames());
  }

  /** Tú empiezas / terminas de elegir fusión. */
  function holdStart() { if (host) holdOn(me!); else { outEv.push(['hs']); flushClient(true); } }
  function holdEnd() { if (host) holdOff(me!); else { outEv.push(['he']); flushClient(true); } }

  /** Has elegido tu carta. */
  function localPicked() {
    if (host) picked(me!);
    else { outEv.push(['lp']); flushClient(true); }
  }

  /** Anfitrión: se acabó para todos. */
  function over(data: unknown) {
    emit(['ov', data]);
    flushAll();
    end();
  }

  return {
    ANIMS, COLORS, begin, end, leave, tick, players, puppets, xpFactor, scaleRate, scaleHp, addWatcher, syncWatchers,
    cast, hit, status, hurtShown, enemyAdded, enemyGone, enemyShot, pickupAdded, pickupGone, say,
    propBroken, collected, shinyCaught, levelStart, localPicked, over, holdStart, holdEnd,
    /** Anfitrión: evento para todos. Invitado: evento para el anfitrión. */
    broadcast(ev: HostEv) { emit(ev); },
    toHost(ev: GuestEv) { if (active && !host) { outEv.push(ev); flushClient(true); } },
    mate(u: string) { return mates.get(u); },
    /** Los compañeros que juegan (no los que miran). */
    get mates() { return [...mates.values()].filter(m => !m.watcher); },
    /** Los que miran la partida (anfitrión). */
    get watchers() { return [...mates.values()].filter(m => m.watcher).map(m => ({ uid: m.uid, name: m.name })); },
    get watching() { return active && watching; },
    get members() { return members; },
    get active() { return active; },
    get isHost() { return active && host; },
    get local() { return local; }
  };
})();
G.Coop = Coop;

declare module '../g' {
  interface Registry { Coop: typeof Coop }
}
