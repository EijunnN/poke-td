import { G } from '../g';
import type { Player } from '../entities/player';
import type { Enemy } from '../entities/enemy';
import type { HazardInit } from './hazards';
import type { PokeType } from '../data/types';
/* ============ judgment.js — La Sentencia de Arceus (minuto 30) ============
 *
 * Al llegar al minuto 30 se acaba la partida "normal" (como la Muerte de
 * Vampire Survivors):
 *
 *   1. Animación: la pantalla se oscurece, aparece "LA SENTENCIA DE ARCEUS"
 *      con su rueda dorada, destello y viaje a una arena enorme y arrasada
 *      (Ruinas del Juicio). Arceus baja del cielo por un pilar de luz y cae
 *      con una onda de choque. La primera vez se ve entera; después se puede
 *      saltar (en cooperativo sólo el anfitrión).
 *   2. Pelea: a Arceus se le puede pegar, pero NO cae. Es un blanco más de los
 *      ataques (un Enemy sin vida que baje, ver `body`): lo que le haces se suma
 *      al "daño a Arceus" de la partida (en grupo, el del equipo, que lleva el
 *      anfitrión), que se ve bajo el reloj y entra en el ranking. Te persigue cada
 *      vez más deprisa; tocarle quita el 40 % de la vida y lanza la Sentencia
 *      (pilares de luz), rayos en cruz y ondas, todo con aviso en el suelo. Ese
 *      daño ignora tipos y defensa.
 *   3. Placas: desde que empieza cambia de tipo cada PLATE_EVERY s (los 17 que no
 *      son Normal). Su tipo decide cuánto le hacen tus ataques (tabla de tipos de
 *      siempre) y el color de los suyos (sólo el aspecto: el daño sigue siendo un %).
 *   4. Minuto 35 de la partida: rompe el objeto de todos (una vez, con aviso).
 *   5. Cada 5 s acude un legendario al azar, cada uno un 25 % más fuerte (vida y
 *      daño) que el anterior. El primero, según el daño que hacíais antes de la
 *      Sentencia a UN enemigo (unos 3 s), para que no caiga al momento.
 *      Dan experiencia, pero nada más (ni monedas, ni tickets, ni objetos).
 *      Veneno y quemadura les quitan siempre lo mismo, poco (enemy.ts).
 *   6. Sin límite de tiempo: los legendarios se acumulan, cada uno más fuerte, y
 *      acaban contigo. Nadie sale de la arena (ni tú ni Arceus ni los legendarios).
 *
 * Mientras dura no sale nada más (ni oleadas, ni eventos, ni grietas; desde
 * el 28:00 ya no se abren grietas). Si a las 30:00 estás en una grieta o
 * eligiendo una carta, empieza al terminar.
 *
 * Cooperativo: lo decide el anfitrión. Mensajes (ver coop.js):
 *   'jd' cfg (empieza) · 'jk' (salta la animación)
 *   y en cada envío del anfitrión, ja: [x, y, animación, dirección, daño del equipo, placa] de Arceus.
 *   Invitado -> anfitrión: ['jh', daño] (lo que ha hecho a Arceus desde el último aviso).
 */
type Phase = 'cine' | 'fight';
/** Arena y legendarios que decide el anfitrión. */
interface JudgeCfg { tx: number; ty: number; q: number[] }
type CastId = 'rain' | 'cross' | 'nova';
/** Ataque de Arceus en curso. */
interface ArceusCast { id: CastId; t: number; wind: number; done?: boolean }
/** Última posición de Arceus que mandó el anfitrión (invitados). */
interface ArceusNet { x: number; y: number; anim: number; dir: number }
/** Arceus no es un Enemy: lo lleva este módulo. */
interface Arceus {
  x: number; y: number;
  lift: number;
  anim: InstanceType<typeof G.Sprites.Animator>;
  r: number; bodyH: number;
  cd: number;
  cast: ArceusCast | null;
  touchCd: number;
  spin: number;
  net: ArceusNet | null;
  glow: number;
  last?: CastId;
  lastNetAnim?: number;
}
/** Ceniza o chispa que cae por la pantalla. */
interface Ember { x: number; y: number; vx: number; vy: number; life: number; s: number; a: number; c: string }
/** Estado que el anfitrión reenvía a quien vuelve tras un corte (ver snapshot/restore). */
interface JudgeSnapshot { cfg: JudgeCfg; phase: Phase; ct: number; arenaT: number; downs: number; dmg?: number; plate?: number }
type JudgeEvent = ['jd', JudgeCfg] | ['jk'];
/** Lo que manda el anfitrión de Arceus en cada envío: x, y, animación, dirección, daño del equipo y placa. */
type ArceusWire = [number, number, number, number, number?, number?];

export const Judgment = (() => {
  const AT = 30 * 60;
  const ARENA_R = 24;                 // en tiles (la arena de la grieta: 11)
  const BOSS_EVERY = 5;               // sin tope: siguen saliendo mientras aguantes
  const TOUCH = 0.4;                  // vida que quita tocar a Arceus
  const GROW = 1.25;                  // cada legendario, un 25 % más fuerte (vida y daño) que el anterior
  const PLATE_EVERY = 20;             // segundos que lleva cada Placa (su tipo)
  const BREAK_AT = 35 * 60;           // minuto 35 de la partida: rompe el objeto de todos
  const BREAK_WARN = 10;              // y avisa tantos segundos antes
  const SEND_EVERY = 0.5;             // invitado: cada cuánto le cuenta al anfitrión el daño que ha hecho a Arceus
  const BODY_ID = -493;               // id del blanco de Arceus (negativo: no choca con los del anfitrión)
  const ARCEUS = 493, SCALE = 1.5;
  // Línea de tiempo de la animación (segundos).
  const T_TITLE = 1.3, T_FLASH = 4.7, T_PORT = 5.1, T_DESC = 5.7, T_LAND = 7.9, T_BACK = 9.1, T_END = 10.1;
  const GOLD = '#ffd25e';
  const authority = () => !G.Coop.active || G.Coop.isHost;
  const TS = () => G.Tiles.T * G.Sprites.PX;

  let phase: Phase | null = null;
  let ct = 0;                         // reloj de la animación
  let cfg: JudgeCfg | null = null;     // q: dex de los legendarios
  let ported = false, landed = false, canSkip = false, cues: Record<string, boolean> = {};
  let A: Arceus | null = null;
  let center: { x: number; y: number } | null = null;   // centro de la arena (mundo)
  let arenaT = 0, bossT = 0, bossN = 0, base = 0, downs = 0;
  // Arceus como blanco: un Enemy local (en EnemyMgr, así lo ven los ataques y la puntería) cuya vida no baja.
  let body: Enemy | null = null;
  let plate = 0, plateT = 0, plateFx = 0;               // Placa de ahora (índice en plates()), segundos con ella y destello al cambiar
  let dmgTotal = 0;                                     // daño a Arceus (quien manda: el del equipo)
  let dmgHost = 0, dmgPend = 0, dmgShown = 0, sendT = 0; // invitado: lo último que dijo el anfitrión, lo aún sin contar y lo que se enseña
  let warned = false, broke = false;                    // aviso y rotura del minuto 35
  // Daño a un solo enemigo por segundo (el que más recibe en cada segundo; con
  // ataques en área, sumar todo daría una vida enorme). Se guardan los últimos
  // 30 s y vale la media de los 6 mejores.
  let hits = new Map<number, number>(), hitT = 0, samples: number[] = [];
  let embers: Ember[] = [];
  let cineAnim: InstanceType<typeof G.Sprites.Animator> | null = null;

  function reset() {
    phase = null; ct = 0; cfg = null; ported = landed = canSkip = false; cues = {};
    A = null; center = null; arenaT = bossT = 0; bossN = 0; base = 0; downs = 0;
    body = null; plate = 0; plateT = plateFx = 0; dmgTotal = dmgHost = dmgPend = dmgShown = sendT = 0; warned = broke = false;
    hits = new Map(); hitT = 0; samples = []; embers = []; cam = null;
  }

  /** Daño hecho a un enemigo (lo llama Enemy.hurt en quien manda). */
  function noteDmg(d: number, e: Enemy) { if (!phase) hits.set(e.id, (hits.get(e.id) || 0) + d); }

  function sampleDps(dt: number) {
    hitT += dt;
    if (hitT < 1) return;
    let best = 0;
    for (const v of hits.values()) if (v > best) best = v;
    samples.push(best / hitT);
    if (samples.length > 30) samples.shift();
    hits.clear(); hitT = 0;
  }
  function singleDps() {
    const top = samples.slice().sort((a, b) => b - a).slice(0, 6);
    return top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0;
  }

  // ---------------- arranque ----------------

  /** Quien manda: elige la arena y los legendarios, y avisa a todos. */
  function start() {
    const pool = G.DEX.filter(p => p.leg && p.dex !== ARCEUS && G.SPRITE_META[p.dex]);
    const q: number[] = [];
    for (let i = 0; i < 40; i++) q.push(G.U.pick(pool).dex);
    const c = { tx: -6000 - Math.floor(Math.random() * 2000), ty: -6000 - Math.floor(Math.random() * 2000), q };
    if (G.Coop.isHost) G.Coop.broadcast(['jd', c]);
    begin(c);
  }

  /** En cada ordenador: empieza la animación. */
  function begin(c: JudgeCfg) {
    if (phase) return;
    cfg = c;
    phase = 'cine'; ct = 0; cues = {};
    const s = G.DB.save;
    // La primera vez se ve entera; en grupo la salta el anfitrión.
    canSkip = !!(s && s.stats && s.stats.judged! > 0) && authority();
    G.Sprites.preload([ARCEUS, ...new Set(c.q.slice(0, 12))], 12000);
    cineAnim = new G.Sprites.Animator(ARCEUS, 1);
    G.Touch.reset();
    G.Audio.music('judgment');
  }

  /** Salta la animación (tecla o toque; en grupo, el anfitrión). */
  function skip() {
    if (phase !== 'cine' || !canSkip || ct >= T_BACK) return;
    if (G.Coop.isHost) G.Coop.broadcast(['jk']);
    doSkip();
  }
  function doSkip() {
    if (phase !== 'cine') return;
    if (!ported) port();
    land(true);
    ct = T_BACK;
  }

  /** Viaje a la arena (a mitad de la animación, tapado por el destello). */
  function port() {
    ported = true;
    const pl = G.Game.player, ts = TS();
    const cf = cfg!;
    G.Rift.reset(true);
    if (authority()) G.EnemyMgr.stash(); else G.EnemyMgr.clearRemote();
    G.Projectiles.clear();
    G.Combat.clearFields();
    G.Hazards.clear();
    G.Pickups.clear();
    G.Events.reset();
    G.Weather.clear();
    G.World.setArena({ tx: cf.tx, ty: cf.ty, r: ARENA_R, type: 'judgment' });
    G.World.setBiome(G.Tiles.arenaBiome('judgment'), true);
    const ctr = { x: cf.tx * ts + ts / 2, y: cf.ty * ts + ts / 2 };
    center = ctr;
    const ps = G.Game.everyone();
    ps.forEach((p, i) => { p.x = ctr.x + (i - (ps.length - 1) / 2) * 34; p.y = ctr.y + ts * 3; });
    G.Camera.x = pl.x; G.Camera.y = pl.y;
    const anim = new G.Sprites.Animator(ARCEUS, SCALE);
    A = { x: ctr.x, y: ctr.y - ts * 5, lift: 900, anim, r: G.Sprites.bodyRadius(ARCEUS, SCALE) * 0.9,
          bodyH: G.Sprites.bodyHeight(ARCEUS, SCALE), cd: 2.2, cast: null, touchCd: 0, spin: 0,
          net: null, glow: 0 };
    anim.dir = 0;
  }

  /** Arceus toca el suelo. */
  function land(quiet = false) {
    if (landed || !A) return;
    landed = true;
    A.lift = 0;
    A.anim.play('Attack', { speed: 0.8 });
    if (quiet) return;
    G.Camera.kick(1.2);
    G.Game.flash('#fff3c8', 0.7);
    G.Audio.sfx('land');
    for (let i = 0; i < 4; i++) G.FX.ring(A.x, A.y, 10 + i * 20, 260 + i * 140, i % 2 ? '#fff3c8' : GOLD, 0.5 + i * 0.25, 8 - i);
    G.FX.burst(A.x, A.y - 20, GOLD, 60, 360);
    G.FX.burst(A.x, A.y - 10, '#ffffff', 30, 240);
  }

  /** Fin de la animación: empieza la pelea. */
  function fight() {
    phase = 'fight';
    if (!ported) port();
    land(true);
    arenaT = 0; bossT = 1.2; bossN = 0; downs = 0;
    dmgTotal = dmgHost = dmgPend = dmgShown = 0; sendT = SEND_EVERY;
    makeBody();
    // La primera Placa la elige quien manda (los invitados la reciben con la posición de Arceus).
    setPlate(authority() ? Math.floor(Math.random() * plates().length) : plate, false);
    G.Progress.event('judge');
    // Vida del primer legendario: unos 3 s de vuestro daño a un enemigo (y un mínimo).
    const n = G.Game.everyone().length, t = G.Game.st.time;
    const floor = (3200 + t * 9) * 0.35 * G.Coop.scaleHp(n);
    base = Math.max(floor, singleDps() * 3);
    G.Spawner.say('¡Arceus no cae! Hazle todo el daño que puedas', 3, true);
  }

  // ---------------- Arceus como blanco ----------------

  const plates = (): PokeType[] => (Object.keys(G.U.TYPE_NAME) as PokeType[]).filter(t => t !== 'normal');
  const plateType = () => plates()[plate];
  const plateColor = () => G.U.TYPE_COLOR[plateType()];

  /** El blanco de Arceus: un Enemy de este ordenador que no pierde vida (Enemy.hurt llama a hitArceus). */
  function makeBody() {
    const ar = A!;
    const e = new G.Enemy({ dex: ARCEUS, name: 'Arceus', hp: 1e12, spd: 0, dmg: 0, xp: 0, behavior: 'arceus' }, ar.x, ar.y, { hp: 1, spd: 1, dmg: 1 });
    e.id = BODY_ID;
    e.arceus = true; e.judge = true;
    e.touchCd = Infinity;                // (tocarle ya lo cuenta touch(): que combat.ts no lo trate como un enemigo que golpea)
    e.r = ar.r; e.bodyH = ar.bodyH;
    body = G.EnemyMgr.addLocal(e);
  }

  /** Cambia la Placa de Arceus (su tipo): el blanco lo lleva y sus ataques lo usan. */
  function setPlate(i: number, announce: boolean) {
    const n = plates().length;
    plate = ((Math.floor(i) % n) + n) % n;
    plateT = 0;
    const ty = plateType();
    if (body) { body.types = [ty]; body.atkType = ty; }
    if (!announce || !A) return;
    plateFx = 1.4;
    G.Spawner.say('¡Arceus cambia a tipo ' + G.U.TYPE_NAME[ty] + '!', 2.4, true);
    G.FX.ring(A.x, A.y, A.r, A.r * 4, plateColor(), 0.7, 6);
    G.FX.burst(A.x, A.y - A.bodyH * 0.5, plateColor(), 26, 240);
    G.Audio.sfx('rift');
  }

  /** Un golpe a Arceus (lo llama Enemy.hurt): número en pantalla y daño apuntado; la vida no baja. */
  function hitArceus(e: Enemy, d: number, color: string, dirX: number, dirY: number, eff: string | null) {
    if (phase !== 'fight') return;
    e.showHurt(d, color, dirX, dirY, eff);
    if (authority()) {
      dmgTotal += d;
      if (G.Coop.isHost) G.Coop.hurtShown(e, d, color);      // (los invitados ven también el número de los golpes del anfitrión)
    } else dmgPend += d;
  }

  /** Anfitrión: lo que un invitado le ha hecho a Arceus. */
  function guestHit(d: number) { if (phase === 'fight' && authority() && d > 0) dmgTotal += d; }

  /** Daño a Arceus que se enseña (el del equipo; en un invitado nunca baja aunque el anfitrión aún no haya contado lo suyo). */
  function shownDmg() {
    dmgShown = Math.max(dmgShown, authority() ? dmgTotal : dmgHost + dmgPend);
    return dmgShown;
  }

  /** Invitado: cuenta al anfitrión el daño que ha hecho a Arceus, de vez en cuando. */
  function sendDmg(dt: number) {
    sendT -= dt;
    if (sendT > 0) return;
    sendT = SEND_EVERY;
    if (dmgPend < 1) return;
    G.Coop.toHost(['jh', Math.round(dmgPend)]);
    dmgPend = 0;
  }

  /** Minuto 35: aviso antes y, a la hora, se rompe el objeto de quien juega aquí (cada ordenador, el suyo). */
  function breakTick(time: number, pl: Player) {
    if (!warned && time >= BREAK_AT - BREAK_WARN) {
      warned = true;
      G.Spawner.say('¡Arceus romperá vuestros objetos en ' + BREAK_WARN + ' s!', 3.2, true);
    }
    if (broke || time < BREAK_AT) return;
    broke = true;
    G.Spawner.say('¡Minuto 35! Arceus rompe el objeto de todos', 3.4, true);
    G.Game.flash('#ffe9b0', 0.5);
    G.Camera.kick(0.7);
    G.Audio.sfx('judge');
    if (!pl || !pl.item) return;
    const name = G.Items.BY[pl.item].name;
    pl.equip(null);
    G.FX.dmgText(pl.x, pl.y - pl.bodyH - 18, '¡' + name + ' roto!', '#ff6b6b', true);
    G.FX.ring(pl.x, pl.y, 6, 90, GOLD, 0.5, 4);
    G.FX.burst(pl.x, pl.y - pl.bodyH * 0.5, '#ffd25e', 22, 220);
  }

  // ---------------- cada fotograma ----------------

  /** Durante la animación (el resto del juego está parado). */
  function cineTick(dt: number) {
    const prev = ct;
    ct += dt;
    const at = (x: number) => prev < x && ct >= x;
    const pl = G.Game.player;
    if (cineAnim) cineAnim.update(dt);
    if (at(0.01)) { G.Audio.sfx('quake'); G.Camera.kick(0.9); }
    if (ct < T_FLASH && Math.random() < dt * 3) G.Camera.kick(0.15);
    if (at(T_TITLE)) G.Audio.sfx('toll');
    if (at(T_TITLE + 1.7)) G.Audio.sfx('toll');
    if (at(T_FLASH)) G.Game.flash('#ffffff', 0.9);
    if (at(T_PORT) && !ported) port();
    if (at(T_DESC)) G.Audio.sfx('descend');
    if (A && !landed) {
      // Bajada: lenta al principio y frenando al final (como si se posara).
      const k = G.U.clamp((ct - T_DESC) / (T_LAND - T_DESC), 0, 1);
      A.lift = 900 * Math.pow(1 - k, 2.2);
      A.anim.loop('Idle');
      if (ct > T_DESC && Math.random() < dt * 30) G.FX.px(A.x + G.U.rand(-60, 60), A.y - A.lift - G.U.rand(0, 200), Math.random() < 0.5 ? GOLD : '#fff3c8', { vy: G.U.rand(60, 160), life: 0.9 });
      if (at(T_LAND)) land();
    }
    if (A) { A.anim.update(dt); A.spin += dt; }
    // Cámara: tu Pokémon; sube despacio hacia Arceus mientras baja y vuelve.
    let tx = pl.x, ty = pl.y;
    if (ported && A && ct < T_BACK) { tx = A.x; ty = A.y - 60; }
    if (!cam || at(T_PORT) || (ported && !cam.ported)) cam = { x: G.Camera.x, y: G.Camera.y, ported };
    cam.x = G.U.damp(cam.x, tx, 2.2, dt); cam.y = G.U.damp(cam.y, ty, 2.2, dt);
    G.Camera.follow(cam.x, cam.y, dt);
    if (ct >= T_END) { cam = null; fight(); }
  }
  let cam: { x: number; y: number; ported: boolean } | null = null;

  /** En la pelea (lo llama game.js en cada fotograma de juego). */
  function update(dt: number, pl: Player, time: number) {
    if (!phase) {
      sampleDps(dt);                        // (para la vida del primer legendario)
      if (time >= AT - 90) G.Audio.preloadJudgment();   // su canción, a tiempo para cuando empiece
      if (authority() && time >= AT && !G.Rift.inArena) start();
      return;
    }
    if (phase !== 'fight') return;
    const ar = A!;
    arenaT += dt;
    ar.touchCd -= dt; ar.spin += dt;
    if (authority()) {
      arceusTick(dt);
      keepInside();
      bossT -= dt;
      if (bossT <= 0) { bossT = BOSS_EVERY; spawnBoss(); }
      plateT += dt;
      if (plateT >= PLATE_EVERY) setPlate(plate + 1 + Math.floor(Math.random() * (plates().length - 1)), true);
    } else {
      netTick(dt);
      plateT = Math.min(PLATE_EVERY, plateT + dt);
      sendDmg(dt);
    }
    holdPlayers();
    if (body) { body.x = ar.x; body.y = ar.y; }
    if (plateFx > 0) plateFx -= dt;
    ar.anim.update(dt);
    touch(pl);
    breakTick(time, pl);
    ember(dt);
  }

  // ---------------- Arceus ----------------

  function target() {
    const ar = A!;
    let best = null, bd = Infinity;
    for (const p of G.Game.everyone()) {
      if (p.dead || (G.Coop.active && G.Coop.quiet(p))) continue;
      const d = G.U.dist2(p.x, p.y, ar.x, ar.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  function arceusTick(dt: number) {
    const ar = A!;
    const tg = target();
    if (ar.cast) { castTick(dt, tg); return; }
    if (!tg) { ar.anim.loop('Idle'); return; }
    // Más lento que tú al principio; a los ~35 s ya te alcanza.
    const k = Math.min(1.22, 0.74 + arenaT * 0.013);
    const spd = Math.max(70, (tg.spd || 100) * k);
    const [dx, dy] = G.U.norm(tg.x - ar.x, tg.y - ar.y);
    ar.x += dx * spd * dt; ar.y += dy * spd * dt;
    ar.anim.dir = G.Sprites.dirFromAngle(Math.atan2(dy, dx));
    ar.anim.loop('Walk', Math.max(0.8, spd / 90));
    if (Math.random() < dt * 14) G.FX.px(ar.x + G.U.rand(-20, 20), ar.y - G.U.rand(0, ar.bodyH), GOLD, { vy: -30, life: 0.6 });
    ar.cd -= dt;
    if (ar.cd <= 0) {
      const d = G.U.dist(ar.x, ar.y, tg.x, tg.y);
      const id = d < 210 && Math.random() < 0.6 ? 'nova' : (ar.last === 'rain' ? 'cross' : 'rain');
      cast(id, tg);
    }
  }

  /** Ataques de Arceus: todos avisan en el suelo y quitan un % de la vida. */
  function cast(id: CastId, tg: Player) {
    const ar = A!;
    ar.last = id;
    const c = ar.cast = { id, t: 0, wind: 0.7 };
    const col = plateColor(), vt = plateType();
    const H = (o: Pick<HazardInit, 'kind' | 'x' | 'y' | 'delay'> & Partial<HazardInit>) => G.Hazards.add(Object.assign({ type: null, pure: true, dmg: 1, color: col, vt }, o));
    if (id === 'rain') {
      // La Sentencia: pilares de luz sobre cada uno (más cuanto más dura).
      const n = 4 + Math.min(6, Math.floor(arenaT / 10));
      for (const p of G.Game.everyone()) {
        if (p.dead) continue;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * 6.2832, d = i ? G.U.rand(40, 150) : 0;
          H({ kind: 'zone', x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d * 0.8, r: 44, delay: 1.25 + i * 0.09, pct: 0.3, vis: 'pillar' });
        }
      }
      ar.anim.play('Shoot', { speed: 0.9 });
    } else if (id === 'cross') {
      // Rayos en cruz que barren la arena.
      const a0 = Math.atan2(tg.y - ar.y, tg.x - ar.x) + (Math.random() < 0.5 ? 0 : Math.PI / 4);
      const n = arenaT > 30 ? 8 : 4;
      for (let i = 0; i < n; i++) H({ kind: 'beam', x: ar.x, y: ar.y, angle: a0 + i * 6.2832 / n, len: 1700, w: 34, delay: 1.1, pct: 0.35 });
      c.wind = 1.1;
      ar.anim.play('Charge', { speed: 0.9 });
    } else {
      // Onda alrededor de él (si estás demasiado cerca).
      H({ kind: 'zone', x: ar.x, y: ar.y, r: 170, delay: 0.85, pct: 0.4 });
      c.wind = 0.85;
      ar.anim.play('Charge', { speed: 1.2 });
    }
    G.FX.ring(ar.x, ar.y, ar.r, ar.r * 3, col, c.wind, 3);
  }

  function castTick(dt: number, tg: Player | null) {
    const ar = A!;
    const c = ar.cast!;
    c.t += dt;
    if (tg) ar.anim.dir = G.Sprites.dirFromAngle(Math.atan2(tg.y - ar.y, tg.x - ar.x));
    if (c.t >= c.wind && !c.done) {
      c.done = true;
      ar.anim.play(c.id === 'nova' ? 'Attack' : 'Shoot', { speed: 1.2 });
    }
    if (c.t >= c.wind + 0.35) {
      ar.cast = null;
      ar.cd = Math.max(1.4, 3.2 - arenaT * 0.025);
    }
  }

  /** Invitado: Arceus va a donde dice el anfitrión. */
  function netTick(dt: number) {
    const ar = A!;
    const n = ar.net;
    if (!n) return;
    const ox = ar.x, oy = ar.y;
    if (G.U.dist2(ar.x, ar.y, n.x, n.y) > 300 * 300) { ar.x = n.x; ar.y = n.y; }
    else { ar.x = G.U.damp(ar.x, n.x, 10, dt); ar.y = G.U.damp(ar.y, n.y, 10, dt); }
    ar.anim.dir = n.dir;
    if (n.anim !== ar.lastNetAnim) {
      ar.lastNetAnim = n.anim;
      const a = G.Coop.ANIMS[n.anim];
      if (a === 'Charge' || a === 'Shoot' || a === 'Attack') ar.anim.play(a);
    }
    ar.anim.loop(Math.abs(ar.x - ox) + Math.abs(ar.y - oy) > 0.5 ? 'Walk' : 'Idle');
  }

  /** Tocar a Arceus (cada uno mira el suyo). */
  function touch(pl: Player | null | undefined) {
    const ar = A!;
    if (!pl || pl.dead || ar.touchCd > 0) return;
    const rr = ar.r + pl.r;
    if (G.U.dist2(ar.x, ar.y, pl.x, pl.y) > rr * rr) return;
    ar.touchCd = 0.9;
    pl.invuln = 0;
    pl.hurt(pl.maxHp * TOUCH, null, true);
    G.Camera.kick(0.6);
    G.FX.ring(pl.x, pl.y, 6, 70, GOLD, 0.4, 4);
    if (authority()) ar.anim.play('Attack', { speed: 1.4 });
  }

  /** Mete en el círculo de la arena a lo que se haya salido de él. */
  function clampIn(o: { x: number; y: number }) {
    const ctr = center!;
    const max = (ARENA_R - 1.4) * TS();
    const dx = o.x - ctr.x, dy = o.y - ctr.y, d = Math.hypot(dx, dy);
    if (d > max) { o.x = ctr.x + dx / d * max; o.y = ctr.y + dy / d * max; }
  }

  /** Quien manda: Arceus y los legendarios no salen de la arena. */
  function keepInside() {
    clampIn(A!);
    for (const e of G.EnemyMgr.all()) if (!e.remote && !e.arceus) clampIn(e);
  }

  /**
   * Tampoco los jugadores (tú y los compañeros, en cada ordenador): con la velocidad muy alta se
   * atravesaba el muro de la arena, que sólo para a quien va despacio; el círculo no se puede cruzar.
   */
  function holdPlayers() {
    for (const p of G.Game.everyone()) clampIn(p);
  }

  // ---------------- legendarios ----------------

  function spawnBoss() {
    const cf = cfg!, ctr = center!;
    const dex = cf.q[bossN % cf.q.length];
    const mon = G.DEX_BY[dex];
    if (!mon) return;
    const t = G.Game.st.time, ts = TS();
    // Lejos de todos (en el borde de la arena).
    let x = ctr.x, y = ctr.y;
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * 6.2832, d = (ARENA_R - G.U.rand(3, 6)) * ts;
      x = ctr.x + Math.cos(a) * d; y = ctr.y + Math.sin(a) * d;
      if (G.Game.everyone().every(p => G.U.dist2(p.x, p.y, x, y) > 280 * 280)) break;
    }
    const k = Math.pow(GROW, Math.min(bossN, 60));       // cada uno, un 25 % más fuerte que el anterior
    const def = {
      dex, name: mon.name,
      hp: Math.round(base * k),
      spd: Math.round(G.U.clamp(48 + (mon.spd - 78) * 0.6, 48, 105)),
      dmg: Math.round((36 + t / 20) * k), xp: Math.round(500 + t * 1.2),
      behavior: mon.types.some(x => ['psychic', 'electric', 'ghost', 'fairy', 'fire', 'water', 'ice', 'dragon'].includes(x)) ? 'ranged' : 'charger',
      shotDmg: Math.round((18 + t / 40) * k), shotCd: 0.9, range: 300
    };
    const e = new G.Enemy(def, x, y, { hp: 1, spd: 1, dmg: 1 }, true);
    e.judge = true;
    e.flying = false;
    G.EnemyMgr.add(e);
    bossN++;
    G.Sprites.preload([cf.q[(bossN + 4) % cf.q.length]], 8000);
    G.FX.ring(x, y, 8, 120, GOLD, 0.6, 5);
    G.FX.burst(x, y - 30, '#fff3c8', 24, 200);
    G.Spawner.say('¡' + e.name + ' acude a la Sentencia!', 1.8);
    G.Audio.sfx('rift');
  }

  /** Ha caído un legendario de la arena (en cada ordenador). */
  function bossDown() { if (phase === 'fight') downs++; }

  // ---------------- dibujo ----------------

  /** Arceus, ordenado por Y con el resto de la escena. */
  function drawable() {
    if (!A || !ported) return null;
    return { y: A.y, draw: drawArceus };
  }

  function drawArceus(ctx: CanvasRenderingContext2D) {
    const ar = A!;
    const lift = ar.lift;
    const now = performance.now() / 1000;
    const hue = phase === 'fight' ? plateColor() : GOLD;         // (la Placa tiñe su aura y su rueda)
    // Sombra que crece mientras baja.
    const near = G.U.clamp(1 - lift / 900, 0, 1);
    ctx.save();
    ctx.globalAlpha = 0.15 + near * 0.3;
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(ar.x, ar.y, 44 * (0.4 + near * 0.6), 16 * (0.4 + near * 0.6), 0, 0, 6.2832); ctx.fill();
    // Aura dorada en el suelo.
    if (lift < 40) {
      ctx.globalAlpha = 0.22 + Math.sin(now * 3) * 0.06 + Math.max(0, plateFx) * 0.25;
      ctx.fillStyle = hue;
      ctx.beginPath(); ctx.ellipse(ar.x, ar.y, ar.r * 2.2, ar.r * 0.8, 0, 0, 6.2832); ctx.fill();
    }
    ctx.restore();
    // La rueda dorada detrás de él.
    wheel(ctx, ar.x, ar.y - lift - ar.bodyH * 0.55, ar.bodyH * 0.62, ar.spin * 0.6, 0.55, hue);
    ar.anim.draw(ctx, ar.x, ar.y - lift, { flash: !!body && body.flash > 0 });
  }

  /** La rueda de Arceus: aro dorado con 12 joyas que gira. */
  function wheel(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, rot: number, alpha: number, color = GOLD) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    // El brillo es un trazo ancho y suave debajo (shadowBlur desenfocaba los 14 trazos en cada fotograma).
    ctx.strokeStyle = color === GOLD ? '#ffcf4a' : color;
    ctx.globalAlpha = alpha * 0.22; ctx.lineWidth = Math.max(4, R * 0.2);
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 6.2832); ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, R * 0.07);
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 6.2832); ctx.stroke();
    ctx.lineWidth = Math.max(1, R * 0.025);
    ctx.beginPath(); ctx.arc(0, 0, R * 0.82, 0, 6.2832); ctx.stroke();
    const GEMS = ['#ff6b4d', '#4fa8ff', '#5fe08a', '#ffe14d', '#b37bff', '#c9d2de'];
    for (let i = 0; i < 12; i++) {
      ctx.rotate(6.2832 / 12);
      ctx.fillStyle = GEMS[i % GEMS.length];
      ctx.beginPath(); ctx.moveTo(R * 1.02, 0); ctx.lineTo(R * 0.91, -R * 0.07); ctx.lineTo(R * 0.8, 0); ctx.lineTo(R * 0.91, R * 0.07); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  /** Por encima de todo (en el mundo): el pilar de luz por el que baja. */
  function drawAir(ctx: CanvasRenderingContext2D) {
    if (!A || !ported) return;
    const cam = G.Camera;
    let a = 0;
    if (phase === 'cine') a = G.U.clamp((ct - T_PORT) / 0.6, 0, 1) * G.U.clamp((T_LAND + 0.6 - ct) / 0.6, 0, 1);
    if (a <= 0) return;
    const top = cam.top() - 40, bot = A.y + 6;
    const near = G.U.clamp(1 - A.lift / 900, 0, 1);
    const w = 40 + near * 40 + Math.sin(ct * 9) * 6;
    ctx.save();
    const g = ctx.createLinearGradient(A.x - w, 0, A.x + w, 0);
    g.addColorStop(0, 'rgba(255,210,94,0)');
    g.addColorStop(0.5, 'rgba(255,248,220,0.7)');
    g.addColorStop(1, 'rgba(255,210,94,0)');
    ctx.globalAlpha = a;
    ctx.fillStyle = g;
    ctx.fillRect(A.x - w, top, w * 2, Math.max(0, bot - top));
    // Resplandor en el suelo, donde va a caer.
    ctx.globalAlpha = a * (0.35 + near * 0.55);
    ctx.translate(A.x, A.y); ctx.scale(1, 0.36);
    const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 1.5);
    rg.addColorStop(0, 'rgba(255,243,200,0.9)'); rg.addColorStop(0.5, 'rgba(255,210,94,0.35)'); rg.addColorStop(1, 'rgba(255,210,94,0)');
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(0, 0, w * 1.5, 0, 6.2832); ctx.fill();
    ctx.restore();
  }

  const F = (wt: number, s: number) => `${wt} ${s}px Pixelify,"Segoe UI",system-ui,sans-serif`;

  /** En pantalla: la animación, o el aviso de la pelea. */
  function drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (phase === 'cine') drawCine(ctx, w, h);
    else if (phase === 'fight') drawFight(ctx, w, h);
  }

  function drawCine(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const t = ct;
    G.Touch.clearButtons();             // (el HUD no se dibuja durante la animación)
    ctx.save();
    // Se oscurece todo (hasta el viaje).
    if (t < T_PORT + 0.1) {
      ctx.fillStyle = `rgba(10,6,2,${(G.U.clamp(t / 1.1, 0, 1) * 0.86).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }
    // "LA SENTENCIA DE ARCEUS"
    const a = G.U.clamp((t - T_TITLE + 0.3) / 0.5, 0, 1) * G.U.clamp((T_FLASH + 0.2 - t) / 0.35, 0, 1);
    if (a > 0) {
      const cx = w / 2, cy = h * 0.34, R = Math.min(w, h) * 0.24;
      // Rayos de luz que giran.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.18);
      ctx.globalAlpha = a * 0.35;
      // (todos los rayos comparten el degradado: está en coordenadas del propio rayo)
      const reach = Math.max(w, h);
      const g = ctx.createLinearGradient(0, 0, reach, 0);
      g.addColorStop(0, 'rgba(255,214,110,0.9)'); g.addColorStop(1, 'rgba(255,214,110,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      for (let i = 0; i < 16; i++) {
        ctx.rotate(6.2832 / 16);
        ctx.moveTo(0, 0); ctx.lineTo(reach, -R * 0.16); ctx.lineTo(reach, R * 0.16); ctx.closePath();
      }
      ctx.fill();
      ctx.restore();
      // Arceus en silueta de luz, detrás de su rueda.
      wheel(ctx, cx, cy - R * 0.05, R, t * 0.35, a * 0.9);
      const idle = G.Sprites.sheet(ARCEUS, 'Idle');
      if (cineAnim && idle && idle.ready) {
        // Silueta de luz que llena la rueda (en múltiplos de 0,5: píxeles enteros).
        const body = (G.Sprites.animMeta(ARCEUS, 'Idle')!.ay || 47) * G.Sprites.PX;
        cineAnim.scale = Math.max(1, Math.round(R * 1.7 / body * 2) / 2);
        const rise = (1 - G.U.clamp((t - T_TITLE + 0.3) / 0.8, 0, 1)) * R * 0.3;
        ctx.save();
        const hy = cy + rise - body * cineAnim.scale * 0.05, hr = body * cineAnim.scale * 0.75;
        const halo = ctx.createRadialGradient(cx, hy, hr * 0.2, cx, hy, hr);
        halo.addColorStop(0, 'rgba(255,207,74,0.5)'); halo.addColorStop(1, 'rgba(255,207,74,0)');
        ctx.globalAlpha = a * 0.85;
        ctx.fillStyle = halo;
        ctx.fillRect(cx - hr, hy - hr, hr * 2, hr * 2);
        cineAnim.draw(ctx, cx, cy + body * cineAnim.scale * 0.5 + rise, { flash: true });
        ctx.restore();
      }
      // El título, letra a letra, debajo de la rueda.
      const size = Math.round(G.U.clamp(Math.min(w / 13, h / 9), 24, 64));
      const ty = cy + R + size * 1.15;
      title(ctx, 'LA SENTENCIA', cx, ty, size, T_TITLE, a);
      title(ctx, 'DE ARCEUS', cx, ty + size * 0.95, Math.round(size * 0.8), T_TITLE + 0.75, a);
      ctx.globalAlpha = a * G.U.clamp((t - T_TITLE - 1.6) / 0.6, 0, 1);
      ctx.font = F(700, Math.round(size * 0.32));
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f3e2b0';
      ctx.fillText('El tiempo se ha agotado…', cx, ty + size * 1.7);
    }
    // Franjas negras de cine durante la bajada.
    if (t > T_PORT) {
      const k = G.U.clamp((t - T_PORT) / 0.5, 0, 1) * G.U.clamp((T_END - t) / 0.6, 0, 1);
      const bh = Math.round(h * 0.11 * k);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, bh); ctx.fillRect(0, h - bh, w, bh);
    }
    // ¡Ha descendido!
    const b = G.U.clamp((t - T_LAND - 0.15) / 0.3, 0, 1) * G.U.clamp((T_END - t) / 0.5, 0, 1);
    if (b > 0) {
      const size = Math.round(G.U.clamp(w / 20, 20, 40));
      const pop = 1 + (1 - G.U.clamp((t - T_LAND - 0.15) / 0.25, 0, 1)) * 0.6;
      ctx.save();
      ctx.globalAlpha = b;
      ctx.translate(w / 2, h * 0.24);
      ctx.scale(pop, pop);
      goldText(ctx, '¡ARCEUS HA DESCENDIDO!', 0, 0, size);
      ctx.restore();
      ctx.globalAlpha = b;
      ctx.font = F(700, Math.round(size * 0.45));
      ctx.textAlign = 'center';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.8)';
      const sub = 'No cae, pero puedes herirle: aguanta y hazle todo el daño que puedas';
      ctx.strokeText(sub, w / 2, h * 0.24 + size * 1.1);
      ctx.fillStyle = '#ffe9b0';
      ctx.fillText(sub, w / 2, h * 0.24 + size * 1.1);
    }
    if (canSkip && t < T_BACK) {
      ctx.globalAlpha = 0.55 + Math.sin(t * 4) * 0.2;
      ctx.font = F(700, 11);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#f3e2b0';
      ctx.fillText(G.Touch.active ? 'Toca la pantalla para saltar' : 'Pulsa Espacio para saltar', w - 16, h - 14);
      // Toda la pantalla es un botón (móvil y ratón).
      G.Touch.addButton(0, 0, w, h, skip, 0);
    }
    ctx.restore();
  }

  /**
   * Texto dorado con borde y brillo. Lleva degradado, desenfoque y borde, y el título lo pide letra a
   * letra en cada fotograma: se pinta una sola vez en un lienzo aparte (por texto, tamaño y densidad de
   * píxeles) y luego sólo se estampa.
   */
  const goldCache = new Map<string, { c: HTMLCanvasElement; ox: number; oy: number; k: number }>();
  function goldText(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number) {
    const k = G.Camera.dpr || 1, key = k + '|' + size + '|' + s;
    let e = goldCache.get(key);
    if (!e) {
      if (goldCache.size > 120) goldCache.clear();
      const c = document.createElement('canvas'), g = c.getContext('2d')!;
      g.font = F(800, size * k);
      const tw = Math.ceil(g.measureText(s).width), pad = Math.ceil(size * k * 0.7);
      c.width = tw + pad * 2; c.height = Math.ceil(size * k * 1.3) + pad * 2;
      const ox = c.width / 2, oy = pad + Math.ceil(size * k * 0.9);
      g.font = F(800, size * k);
      g.textAlign = 'center';
      g.lineJoin = 'round';
      g.lineWidth = Math.max(4, size * 0.16) * k;
      g.strokeStyle = '#2a1500';
      g.strokeText(s, ox, oy);
      const gr = g.createLinearGradient(0, oy - size * k * 0.8, 0, oy + size * k * 0.1);
      gr.addColorStop(0, '#fff8d8'); gr.addColorStop(0.5, '#ffd25e'); gr.addColorStop(1, '#c7771a');
      g.shadowColor = '#ffcf4a'; g.shadowBlur = size * k * 0.4;
      g.fillStyle = gr;
      g.fillText(s, ox, oy);
      e = { c, ox, oy, k };
      goldCache.set(key, e);
    }
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(e.c, x - e.ox / k, y - e.oy / k, e.c.width / k, e.c.height / k);
    ctx.imageSmoothingEnabled = smooth;
  }

  /** Título que aparece letra a letra (cada una cae y se asienta). */
  function title(ctx: CanvasRenderingContext2D, raw: string, cx: number, y: number, size: number, t0: number, alpha: number) {
    const s = G.I18n ? G.I18n.t(raw) : raw;
    ctx.save();
    ctx.font = F(800, size);
    // (los anchos se miden una vez: la animación pide el título entero en cada fotograma)
    const wid = (t: string) => {
      const key = size + '|' + t;
      let v = widths.get(key);
      if (v == null) { v = ctx.measureText(t).width; widths.set(key, v); }
      return v;
    };
    const total = wid(s);
    let x = cx - total / 2;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const cw = wid(ch);
      const p = G.U.clamp((ct - t0 - i * 0.055) / 0.28, 0, 1);
      if (p > 0 && ch !== ' ') {
        const k = 1 + (1 - p) * 1.8;
        ctx.save();
        ctx.globalAlpha = alpha * p;
        ctx.translate(x + cw / 2, y);
        ctx.scale(k, k);
        goldText(ctx, ch, 0, 0, size);
        ctx.restore();
      }
      x += cw;
    }
    ctx.restore();
  }
  const widths = new Map<string, number>();

  /** El cielo rojizo de la pelea, guardado por tamaño de pantalla. */
  let skyG: CanvasGradient | null = null, skyW = 0, skyH = 0;

  /** Pelea: cielo rojizo, ceniza, flecha a Arceus y el contador. */
  function drawFight(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const ar = A!;
    ctx.save();
    if (!skyG || skyW !== w || skyH !== h) {
      skyG = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
      skyG.addColorStop(0, 'rgba(120,40,10,0)');
      skyG.addColorStop(1, 'rgba(120,40,10,0.35)');
      skyW = w; skyH = h;
    }
    ctx.fillStyle = skyG;
    ctx.fillRect(0, 0, w, h);
    for (const e of embers) {
      ctx.globalAlpha = Math.min(1, e.life) * e.a;
      ctx.fillStyle = e.c;
      ctx.fillRect(Math.round(e.x), Math.round(e.y), e.s, e.s);
    }
    ctx.globalAlpha = 1;
    // Contador bajo el reloj.
    const boss = G.EnemyMgr.all().some(e => e.boss && !e.dead);
    ctx.textAlign = 'center';
    ctx.font = F(800, 12);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)';
    const txt = 'SENTENCIA · ' + G.U.mmss(arenaT) + ' · JEFES ' + downs;
    const y0 = boss ? 98 : 76;
    ctx.strokeText(txt, w / 2, y0);
    ctx.fillStyle = GOLD;
    ctx.fillText(txt, w / 2, y0);
    drawPlate(ctx, w, y0 + 8);
    // Flecha hacia Arceus si no se ve.
    const cam = G.Camera;
    const sx = (ar.x - cam.left()) * cam.scale, sy = (ar.y - ar.bodyH * 0.5 - cam.top()) * cam.scale;
    if (sx < 0 || sx > w || sy < 0 || sy > h) {
      const M = 46, ex = G.U.clamp(sx, M, w - M), ey = G.U.clamp(sy, M + 70, h - M - 80);
      const an = Math.atan2(sy - ey, sx - ex);
      const pl = G.Game.player;
      const beat = 0.5 + Math.sin(performance.now() / 120) * 0.5;
      ctx.translate(ex, ey);
      ctx.globalAlpha = 0.2 + beat * 0.25;
      ctx.fillStyle = '#ff6a3d';
      ctx.beginPath(); ctx.arc(0, 0, 26 + beat * 6, 0, 6.2832); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = beat > 0.5 ? '#fff3c8' : GOLD;
      ctx.beginPath();
      ctx.moveTo(Math.cos(an) * 34, Math.sin(an) * 34);
      ctx.lineTo(Math.cos(an + 2.45) * 17, Math.sin(an + 2.45) * 17);
      ctx.lineTo(Math.cos(an - 2.45) * 17, Math.sin(an - 2.45) * 17);
      ctx.closePath(); ctx.fill();
      ctx.font = F(800, 11);
      ctx.textAlign = Math.cos(an) > 0.3 ? 'right' : Math.cos(an) < -0.3 ? 'left' : 'center';
      const lbl = 'ARCEUS · ' + Math.round(G.U.dist(pl.x, pl.y, ar.x, ar.y) / 32) + ' m';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.strokeText(lbl, -Math.cos(an) * 30, -Math.sin(an) * 26 + 4);
      ctx.fillStyle = GOLD;
      ctx.fillText(lbl, -Math.cos(an) * 30, -Math.sin(an) * 26 + 4);
    }
    ctx.restore();
  }

  /** Número con separadores en el idioma del jugador. */
  const fmtNum = (n: number) => Math.round(n).toLocaleString(G.I18n.lang === 'en' ? 'en-US' : 'es-ES');

  /** Bajo el contador: la Placa de Arceus (con lo que falta para el cambio) y el daño que le lleváis hecho. */
  function drawPlate(ctx: CanvasRenderingContext2D, w: number, y: number) {
    const ty = plateType(), col = plateColor();
    const name = G.I18n.t(G.U.TYPE_NAME[ty]).toUpperCase();
    const dmgTxt = G.I18n.t('DAÑO A ARCEUS') + ' · ' + fmtNum(shownDmg());
    ctx.save();
    ctx.font = F(800, 12);
    ctx.textAlign = 'left';
    const cw = ctx.measureText(name).width + 18, dw = ctx.measureText(dmgTxt).width, gap = 8;
    let x = Math.round((w - (cw + gap + dw)) / 2);
    const left = Math.max(0, PLATE_EVERY - plateT);
    // Chip del tipo y barrita del tiempo que le queda (parpadea justo antes de cambiar).
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(x - 1, y - 1, cw + 2, 22);
    ctx.fillStyle = col;
    ctx.globalAlpha = left < 4 && Math.sin(performance.now() / 70) > 0 ? 0.45 : 1;
    ctx.fillRect(x, y, cw, 17);
    ctx.fillRect(x, y + 18, cw * left / PLATE_EVERY, 2);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#12100a';
    ctx.fillText(name, x + 9, y + 13);
    x += cw + gap;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.strokeText(dmgTxt, x, y + 13);
    ctx.fillStyle = '#ffe9b0';
    ctx.fillText(dmgTxt, x, y + 13);
    ctx.restore();
  }

  let gameCv: HTMLElement | null = null;

  /** Ceniza y chispas que caen (en pantalla). */
  function ember(dt: number) {
    const cv = gameCv && gameCv.isConnected ? gameCv : (gameCv = document.getElementById('game'));
    const w = cv ? cv.clientWidth : 800, h = cv ? cv.clientHeight : 600;
    if (embers.length < 70 && Math.random() < dt * 40) {
      const spark = Math.random() < 0.3;
      embers.push({ x: Math.random() * w, y: -6, vx: G.U.rand(-25, 10), vy: G.U.rand(20, 55), life: G.U.rand(5, 10),
                    s: spark ? 2 : 3, a: spark ? 0.9 : 0.45, c: spark ? '#ffb347' : '#8a8078' });
    }
    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i];
      e.x += e.vx * dt; e.y += e.vy * dt; e.life -= dt;
      if (e.life <= 0 || e.y > h + 10) embers.splice(i, 1);
    }
  }

  // ---------------- red ----------------

  function onEvent(ev: JudgeEvent) {
    if (ev[0] === 'jd') begin(ev[1]);
    else if (ev[0] === 'jk') doSkip();
  }

  /** Anfitrión: dónde está Arceus (va en cada envío). */
  function netState() {
    if (phase !== 'fight' || !A) return null;
    const a = G.Coop.ANIMS.indexOf(A.anim.cur);
    return [Math.round(A.x), Math.round(A.y), a < 0 ? 0 : a, A.anim.dir, Math.round(dmgTotal), plate];
  }
  function netApply(a: ArceusWire) {
    if (!A || phase !== 'fight') return;
    A.net = { x: a[0], y: a[1], anim: a[2], dir: a[3] };
    if (Number.isFinite(a[4])) dmgHost = Math.max(0, a[4]!);
    if (Number.isInteger(a[5]) && a[5] !== plate) setPlate(a[5]!, true);
  }

  return {
    AT, reset, noteDmg, hitArceus, guestHit, update, cineTick, skip, bossDown, drawable, drawAir, drawOverlay, onEvent, netState, netApply,
    /** Cooperativo: cómo va la Sentencia (para reenviársela a quien vuelve tras un corte). */
    snapshot(): JudgeSnapshot | null {
      return phase ? { cfg: cfg!, phase, ct: Math.round(ct * 10) / 10, arenaT: Math.round(arenaT * 10) / 10, downs,
                       dmg: Math.round(dmgTotal), plate } : null;
    },
    /** Cooperativo: se une a la Sentencia que ya está en marcha en el anfitrión (si no la tenía). */
    restore(s: JudgeSnapshot | null | undefined) {
      const c = s && s.cfg;
      if (phase || !c || !Number.isFinite(c.tx) || !Number.isFinite(c.ty) || !Array.isArray(c.q) || c.q.length > 60
          || !c.q.every(d => G.DEX_BY[d])) return;
      begin(c);
      if (s.phase === 'fight') {
        doSkip(); ct = T_END; cineTick(0);
        arenaT = Math.max(0, +s.arenaT || 0); downs = s.downs | 0;
        dmgHost = dmgShown = Math.max(0, Number(s.dmg) || 0);
        if (Number.isInteger(s.plate)) setPlate(s.plate!, false);
        return;
      }
      ct = Math.max(0, Math.min(T_END - 0.1, +s.ct || 0));
      if (ct >= T_PORT) port();
      if (ct >= T_LAND) land(true);
    },
    get active() { return !!phase; },
    get cinematic() { return phase === 'cine'; },
    /** Celeste - True Love desde el inicio de la Sentencia y durante la pelea. */
    get music() { return 'judgment'; },
    /** Para el resumen de la partida: { time, bosses } o null. */
    summary() { return phase === 'fight' ? { time: arenaT, bosses: downs, dmg: Math.round(shownDmg()) } : null; },
    /** Para pruebas: vida del primer legendario y daño medido. */
    get debug() { return { base, single: singleDps(), samples: samples.length, dmg: dmgTotal, plate: phase === 'fight' ? plateType() : null }; },
    /** Para pruebas: la Sentencia ya. */
    debugStart() { if (!phase && authority()) start(); }
  };
})();
G.Judgment = Judgment;

declare module '../g' {
  interface Registry { Judgment: typeof Judgment }
}
