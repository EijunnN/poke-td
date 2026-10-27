import { G } from '../g';
import { Run, type GameMode, type View } from '../run';
import type { Player } from '../entities/player';
import type { CoopApi, CoopConfig } from '../net/coop';
import type { Pickup, PickupCollector } from '../entities/pickup';
/* ============ survivor.ts — modo Survivor: la partida de hordas ============
 * Todo lo que es de este modo: empezar y acabar la run, el paso de simulación,
 * cartas de nivel, vínculos, objetos, recogida y el pegamento del cooperativo.
 * El bucle, el lienzo y el fondo de los menús son de game.ts (ver run.ts).
 *
 * Cooperativo (G.Coop.active): el anfitrión lleva enemigos, objetos y
 * experiencia; cada uno su Pokémon. La pausa no para el juego, las cartas de
 * nivel esperan a que elijan todos y un compañero caído se levanta si otro
 * se queda a su lado. Ver net/coop.ts.
 */
/** Resumen de la partida que se manda por red al acabar (ver summary). */
interface RunSummary { t: number; ki: number; bo: number; co: number; lv: number; t1: number; t10: number; why?: string }

export const Survivor = (() => {
  let time = 0, pendingLevels = 0;
  let pl: Player = null!;   // (null fuera de partida, ver endRun)
  let caught: { dex: number; isNew: boolean }[] = [];          // shinies conseguidos en esta run
  let biome = -1;
  // Tu mejor tiempo (en solitario o en grupo, según la partida) al empezar; al pasarlo suena el tema
  // del récord hasta el final, aunque salga un jefe. Sin marca anterior (o mirando) no hay récord.
  let recordAt = 0, recordOn = false;

  const st = { get time() { return time; } };

  let holdBy: string[] = [];                   // grupo: quién está eligiendo fusión (todo parado)
  let ownHold = false;               // grupo: este ordenador ha pedido pausa (holdStart) y aún no la ha quitado
  // Elecciones (cartas, objeto, vínculo): UI.show oculta las demás pantallas, así que sólo hay una a la
  // vez; las que llegan con otra abierta esperan aquí a que se cierre (cada una con su propio cierre).
  const CHOICE_SCR = ['scr-levelup', 'scr-item', 'scr-bond'];
  const choiceOpen = () => CHOICE_SCR.some(G.UI.isOpen);
  let choiceQ: ((() => void) & { lv?: boolean })[] = [];
  let bondQueued = false;

  // ---------------- run ----------------

  /**
   * Espectador (sala pública ya en juego; net/spectate.ts): su Pokémon no juega (no se dibuja,
   * no ataca, no recoge, no le dan), está donde mira la cámara, y al acabar no cobra nada.
   */
  let spectating = false;
  /**
   * Caído en grupo: adónde mira la cámara. Se mueve con las teclas de andar (o el joystick);
   * Tab / E / Q (LB / RB en el mando) o el botón del HUD la llevan a seguir a un compañero vivo o a tu Pokémon.
   * null mientras estás en pie.
   */
  let look: { x: number; y: number; who: Player | null } | null = null;
  const LOOK_SPEED = 520;

  /** @param coop  { seed, host, members } para una partida en grupo (con `watch`, como espectador) */
  function start(coop: CoopConfig | null = null) {
    holdBy = []; awayBy = null; look = null;
    ownHold = false; choiceQ = []; bondQueued = false; flashT = 0;
    spectating = !!(coop && coop.watch);
    const save = G.DB.save!;
    const mon = G.DEX_BY[save.partner!];
    const perks = G.Upgrades.perks(G.DB.upgradesOf(mon.dex));

    G.UI.hideAll();
    G.UI.chrome(false);
    G.FX.clear();
    G.Projectiles.clear();
    G.Combat.clearFields();
    G.EnemyMgr.clear();
    G.Pickups.clear();
    G.Spawner.reset();
    G.Recount.reset();
    crewSnap = [];
    G.Rift.reset();
    G.Judgment.reset();
    G.Events.reset();
    G.Weather.reset();
    G.Path.clear();
    G.Hazards.clear();
    G.World.reset(coop ? coop.seed : Math.floor(Math.random() * 1e6));
    G.World.setBiome(0, true);
    biome = 0;
    time = 0; pendingLevels = 0;
    recordAt = spectating ? 0 : (coop ? save.stats.bestGroupTime : save.stats.bestSoloTime) || 0;
    recordOn = false;
    runReal = performance.now(); tampered = false;

    pl = new G.Player(mon, perks, !!save.partnerShiny && G.DB.ownsShiny(mon.dex));
    G.Mons.apply(pl);                       // su naturaleza y su habilidad (antes que los movimientos: la habilidad puede cambiar la recarga o la vida)
    banked = { t1: 0, t10: 0 };
    caught = [];
    // Atajos: movimientos con hueco fijo (save.pbind[dex] = [id del 1, id del 2, ...]),
    // antes de aprender nada: addMove ya los coloca.
    (save.pbind && save.pbind[mon.dex] || []).forEach((id, i) => { if (id) pl.bind[id] = i; });
    pl.addMove(G.startMoveOf(mon.dex));
    // Mejora "Veto": movimientos que no quieres que te salgan.
    pl.banned = new Set((save.pban && save.pban[mon.dex] || []).slice(0, perks.bans));
    // Mejora "Repertorio": un segundo movimiento de ataque, el elegido con "Segundo movimiento inicial" o, si no, al azar.
    if (perks.startMoves >= 2) {
      const pick2 = G.startMove2Of(mon.dex);
      const pool = G.Moves.poolFor(mon, true).filter(id => !pl.hasMove(id) && !pl.banned.has(id) && G.Moves.BY_ID[id].kind !== 'buff');
      if (pick2 && !pl.hasMove(pick2)) pl.addMove(pick2);
      else if (pool.length) pl.addMove(G.U.pick(pool));
      pl.setActive(0);
    }

    if (coop) {
      G.Coop.begin(coop, pl, coopApi);
      if (!spectating) G.Social.setPlaying(true);
      else pl.hurt = () => 0;                       // al espectador no le hace nada nadie
    }
    G.Camera.x = pl.x; G.Camera.y = pl.y; G.Camera.shake = 0;
    // Hojas de sprites locales: el compañero y los primeros enemigos.
    G.Sprites.preload([mon.dex], 8000, pl.shiny);
    G.Audio.music(G.BIOME_MUSIC[0]);
    // Para el ranking: el servidor apunta cuándo empieza la partida (anti-trampas).
    if (!coop || G.Coop.isHost) G.Ranking.runStarted(coop ? 'g' : 's');
    deathT = 0;

    Run.state = 'playing';
  }

  /** El daño del grupo al irte (al salir de la partida ya no se puede preguntar, y el resumen lo enseña). */
  let crewSnap: ReturnType<typeof G.Coop.damage> = [];

  function quitRun() {
    if (G.Coop.active) { crewSnap = G.Coop.damage(); G.Coop.leave(); }
    endRun(false);
  }

  /** Todos los jugadores de la partida (tú primero). */
  function everyone() { return G.Coop.active ? G.Coop.players() : [pl]; }

  /** Experiencia que hace falta para el siguiente nivel (cofres con candado). */
  function levelXp() {
    if (!pl) return 20;
    const k = (G.Coop.active ? G.Coop.xpFactor() : 1) * (pl.xpMul || 1);
    return Math.ceil((pl.xpNext - pl.xp + 1) / k);
  }

  // Destello de pantalla completa (viaje a la grieta).
  let flashT = 0, flashDur = 1, flashCol = '#fff';
  function flash(col: string, dur: number) { flashCol = col; flashDur = dur; flashT = dur; }

  function teamState() {
    return { time, level: pl.level, xp: pl.xp, xpNext: pl.xpNext, kills: pl.kills, bosses: pl.bosses, coins: pl.coins, t1: pl.t1, t10: pl.t10 };
  }
  function summary(): RunSummary { return { t: time, ki: pl.kills, bo: pl.bosses, co: pl.coins, lv: pl.level, t1: pl.t1, t10: pl.t10 }; }

  /** Lo que el cooperativo necesita del juego. */
  /**
   * Los tickets recogidos se guardan en cuanto los coges (como los shinies):
   * antes sólo al acabar, y si la pestaña se cerraba de golpe se perdían.
   * `banked` = los de esta partida que ya están en la partida guardada.
   */
  let banked = { t1: 0, t10: 0 };
  function bankTickets(save_ = true) {
    const sv = G.DB.save;
    if (!sv || !pl) return;
    sv.tickets = sv.tickets || { t1: 0, t10: 0 };
    const d1 = Math.max(0, pl.t1 - banked.t1), d10 = Math.max(0, pl.t10 - banked.t10);
    if (!d1 && !d10) return;
    sv.tickets.t1 += d1; sv.tickets.t10 += d10;
    banked = { t1: pl.t1, t10: pl.t10 };
    if (save_) G.DB.commit('run');
  }

  const coopApi: CoopApi = {
    team: teamState,
    summary,
    // Invitado: el anfitrión manda el reloj y lo del equipo.
    syncTeam(t) {
      if (Math.abs(t.time - time) > 0.4) time = t.time;
      if (t.level > pl.level) G.Audio.sfx('xp');
      pl.level = t.level; pl.xp = t.xp; pl.xpNext = t.xpNext;
      pl.kills = t.kills; pl.bosses = t.bosses; pl.coins = t.coins;
      if (t.t1 > pl.t1 || t.t10 > pl.t10) G.Audio.sfx('shiny');
      pl.t1 = t.t1 || 0; pl.t10 = t.t10 || 0;
      if (!spectating) bankTickets();               // mirar no da tickets
    },
    levelStart(level) {
      choiceQ = choiceQ.filter(f => !f.lv);          // (un 'lu' repetido tras un corte no abre dos veces)
      queueChoice(Object.assign(() => openLevelUp(level), { lv: true }));
    },
    waiting(names) { G.RunUI.setWaiting(names); },
    resume() {
      G.RunUI.closeLevelUp();
      choiceQ = choiceQ.filter(f => !f.lv);          // se acabó la ronda: unas cartas que no llegaron a salir ya no tocan
      if (Run.state === 'levelup') Run.state = holdBy.length || awayBy ? 'held' : 'playing';
      drainChoices();
    },
    shiny(dex) { G.onShinyCaught({ dex, name: (G.DEX_BY[dex] || {}).name || '' }); },
    over(d: RunSummary | null) {
      if (d) Object.assign(pl, { kills: d.ki, bosses: d.bo, coins: d.co, level: Math.max(pl.level, d.lv || 1), t1: d.t1 || pl.t1, t10: d.t10 || pl.t10 });
      if (d && d.t) time = d.t;
      if (d && d.why === 'host') G.UI.toast('El anfitrión ha terminado la partida', 3200);
      endRun(!(d && d.why === 'host'));
    },
    lost(msg) { G.UI.toast(msg, 3600); endRun(false); },
    item(id) { offerItem(id); },
    mateLeft() {},
    /** Grupo: quién está eligiendo fusión. Mientras haya alguien, todo parado. */
    hold(names) {
      holdBy = names || [];
      // Invitado: tras un corte, el anfitrión puede conservar mi pausa sin que yo elija nada (o haberla
      // perdido estando yo eligiendo): se corrige aquí.
      const me = G.Social.me && G.Social.me.name;
      if (G.Coop.active && !G.Coop.isHost && me) {
        const listed = holdBy.includes(me);
        if (listed && !ownHold) G.Coop.holdEnd();
        else if (!listed && ownHold) G.Coop.holdStart();
      }
      const mine = G.UI.isOpen('scr-bond');
      if (holdBy.length) {
        if (Run.state === 'playing') Run.state = 'held';
        if (pl && pl.bonds > 0) offerBond(true);      // si tú también tienes vínculo, eliges a la vez
        const others = holdBy.filter(n => n !== (G.Social.me && G.Social.me.name) && n !== 'Tú');
        if (!mine && others.length) G.Spawner.say('Pausa: ' + others.join(', ') + ' ' + (others.length > 1 ? 'están eligiendo…' : 'está eligiendo…'), 999, true);
      } else {
        if (Run.state === 'held' && !awayBy) Run.state = 'playing';
        G.Spawner.say(awayBy ? awayText() : '', awayBy ? 999 : 0, true);
      }
    },
    /** Grupo (invitado): el anfitrión se ha ido de la pestaña o no responde: todo parado. */
    away(name) {
      awayBy = name || null;
      if (awayBy) {
        if (Run.state === 'playing') Run.state = 'held';
        G.Spawner.say(awayText(), 999, true);
      } else if (!holdBy.length) {
        if (Run.state === 'held') Run.state = 'playing';
        G.Spawner.say('', 0, true);
      }
    }
  };
  let awayBy: string | null = null;
  const awayText = () => 'Pausa: esperando a ' + awayBy + ' (anfitrión)…';

  /** Has llevado a casa a un Pokémon perdido y se une a ti (events.js). */
  G.onRescue = (dex: number, name: string) => {
    if (!G.DB.save || !pl) return;
    const isNew = !G.DB.owns(dex);
    if (isNew) { G.DB.grant(dex, 'rescue'); G.DB.commit(true); }
    else pl.coins += 150;
    G.Spawner.say(isNew ? '¡' + name + ' se une a tu equipo!' : '¡' + name + ' te da las gracias! (+150 monedas, ya lo tenías)', 4);
    G.Audio.sfx('shinyGet');
  };

  /** Un shiny salvaje cae: te lo quedas (y la versión normal si no la tenías). */
  G.onShinyCaught = (e: { dex: number; name: string }) => {
    if (!G.DB.save || !pl) return;
    if (G.Coop.isHost) G.Coop.shinyCaught(e);
    const isNew = G.DB.grantShiny(e.dex, 'wild');
    G.DB.save.stats.shinies++;
    G.DB.commit(true);
    caught.push({ dex: e.dex, isNew });
    G.Spawner.say(isNew ? '¡Has conseguido a ' + e.name + ' shiny!' : '¡Otro ' + e.name + ' shiny! (+300 monedas)', 4);
    if (!isNew) pl.coins += 300;
    G.Audio.sfx('shinyGet');
  };

  function endRun(dead = true) {
    if (Run.state === 'over' || !pl) return;
    // Espectador: ni premio ni resumen; de vuelta a la lista de salas.
    if (spectating) {
      spectating = false;
      Run.state = 'over';
      G.Audio.music(null);
      G.RunUI.closeLevelUp();
      pl = null!;
      G.Spectate.ended('La partida que mirabas ha terminado');
      return;
    }
    const coop = !!pl.uid;                    // sólo las partidas en grupo le ponen uid
    const wasHost = !!pl.coopHost;
    const team = coop ? G.Coop.members.slice() : [];
    const crew = G.Coop.active ? G.Coop.damage() : crewSnap;
    if (G.Coop.active) G.Coop.end();
    if (coop) G.Social.setPlaying(false);
    Run.state = 'over';
    G.Audio.music(null);
    G.Audio.sfx(dead ? 'gameover' : 'back');
    const save = G.DB.save;
    const mul = pl.coinMul;
    const parts = {
      tiempo: Math.floor(time / 5),
      derrotados: Math.floor(pl.kills * 0.25),
      jefes: pl.bosses * 80,
      recogidas: pl.coins
    };
    const coins = Math.round((parts.tiempo + parts.derrotados + parts.jefes + parts.recogidas) * mul);
    const record = time > save.stats.bestTime;

    save.coins += coins;
    bankTickets(false);
    save.stats.runs++;
    save.stats.totalKills += pl.kills;
    save.stats.bestTime = Math.max(save.stats.bestTime, Math.floor(time));
    if (coop) save.stats.bestGroupTime = Math.max(save.stats.bestGroupTime || 0, Math.floor(time));
    else save.stats.bestSoloTime = Math.max(save.stats.bestSoloTime || 0, Math.floor(time));
    save.stats.bestLevel = Math.max(save.stats.bestLevel, pl.level);
    save.stats.coinsEarned += coins;
    const judge = G.Judgment.summary();
    if (judge) G.Progress.event('judgeEnd', judge);
    G.Judgment.reset();
    G.Progress.event('runEnd', { time, level: pl.level, coins: pl.coins, types: pl.mon.types, group: coop });
    G.Progress.checkAch();
    // A la nube: un récord, enseguida; si no, al acabar la partida (como mucho cada 20 min).
    G.DB.commit(record ? true : 'run');
    if (G.Social.me) G.Social.publishProfile();

    // Ranking: en solitario cada uno lo suyo; en grupo lo sube el anfitrión.
    const mark = { t: Math.floor(time), lv: pl.level, kills: pl.kills, arceus: judge ? judge.dmg : 0 };
    // Si la partida se ha tocado (ver clean()), no sube al ranking (sin avisar); lo demás, sí.
    const ok = clean();
    if (ok && !coop) G.Ranking.submitSolo(Object.assign(mark, { dex: pl.dex, shiny: pl.shiny }));
    else if (ok && wasHost) G.Ranking.submitGroup(Object.assign(mark, { members: team }));

    const back = () => { pl = null!; G.Flow.afterRun(); };
    G.RunUI.showOver({
      dead, time, level: pl.level, kills: pl.kills, bosses: pl.bosses, coins, record, t1: pl.t1, t10: pl.t10, judge,
      moves: pl.moves, caught, dmg: G.StatsUI.damageReport(pl, time, crew),
      breakdown: Object.entries(parts).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(' · ') +
                 (mul > 1 ? ` · ×${mul.toFixed(2)} Fortuna` : '')
    }, back, G.Flow.retry(coop, dead, back, () => { pl = null!; G.Flow.play(); }));
    // En grupo, sólo si habéis caído todos (no si el anfitrión se fue o se cortó): la cuenta de quién quiere otra.
    if (coop) G.Flow.overGroup(dead);
  }

  /*
   * ¿Partida limpia? Sólo cosas que ningún jugador legal puede hacer, con
   * márgenes enormes (el sistema del 10-10 daba falsos positivos):
   *   - el reloj de la partida va más deprisa que el real (trucos de velocidad)
   *   - funciones de tu Pokémon sustituidas (así se hace uno invencible)
   *   - vida, ataque, velocidad o recarga muy por encima de lo posible
   *   - se han usado las funciones de pruebas (saltar el reloj...)
   * Si algo salta, esa partida no sube al ranking (sin avisar) y nada más.
   */
  let runReal = 0, tampered = false;
  function clean() {
    if (tampered) return false;
    if (time > (performance.now() - runReal) / 1000 + 10) return false;
    for (const k of ['hurt', 'update', 'heal', 'gainXp']) if (Object.prototype.hasOwnProperty.call(pl, k)) return false;
    if (!isFinite(pl.hp) || !isFinite(pl.maxHp) || pl.hp > pl.maxHp + 1 || pl.maxHp > 50000) return false;
    if (pl.atkMul > 2000 || pl.spdMul > 25 || pl.cdMul < 0.03 || pl.level > 20 + time / 3) return false;
    return true;
  }

  // ---------------- subida de nivel ----------------

  function maybeLevelUp() {
    if (pendingLevels <= 0 || Run.state !== 'playing') return;
    if (G.Coop.active) {
      // En grupo, las cartas salen a la vez para todos y se espera a que elijan.
      if (G.Coop.players().every(p => p.dead)) return;
      pendingLevels--;
      G.Coop.levelStart(pl.level);
      return;
    }
    // Nunca abras cartas con el Pokémon caído (morir y recoger XP en el mismo frame).
    if (pl.dead) return;
    pendingLevels--;
    Run.state = 'levelup';
    G.Audio.sfx('levelup');
    G.RunUI.showLevelUp(pl.level, G.LevelUp.offer(pl), card => {
      G.Audio.sfx('confirm');
      card.apply(pl);
      Run.state = 'playing';
    });
  }

  // ---------------- vínculos ----------------

  /**
   * Vínculo de un legendario: eliges qué movimientos se fusionan.
   * Si ahora no se puede (no hay dos sueltos), se guarda hasta que aprendas
   * otro movimiento. Se mira en cada fotograma: si otra pantalla la tapa (cartas
   * de nivel en grupo, pausa), vuelve a salir al cerrarla.
   * @param quiet  no avisar si todavía no se puede
   */
  function offerBond(quiet = false) {
    if (!pl || pl.bonds <= 0 || pl.dead || (Run.state !== 'playing' && Run.state !== 'held') || G.Rift.inArena) return;
    if (G.UI.isOpen('scr-pause')) return;
    if (choiceOpen()) {                 // otra elección a la vista: espera a que se cierre (una sola vez)
      if (!bondQueued) { bondQueued = true; choiceQ.push(() => { bondQueued = false; offerBond(quiet); }); }
      return;
    }
    const opt = pl.bondOptions();
    if (!opt) {
      if (!quiet) G.Spawner.say('Guardas el vínculo: aprende otro movimiento para usarlo', 3, true);
      return;
    }
    beginChoice();
    G.Audio.sfx('levelup');
    G.RunUI.showBond(opt, picked => {
      try {
        const group = pl.fuse(picked, opt.group);
        G.Audio.sfx('legend');
        G.FX.ring(pl.x, pl.y, 8, 130, '#ff8ad8', 0.8, 6);
        G.FX.burst(pl.x, pl.y - pl.bodyH * 0.5, '#ffb3e6', 40, 240);
        G.Spawner.say('¡Vínculo! ' + group.length + ' movimientos a la vez', 2.6, true);
      } finally { endChoice(); }
    });
  }

  // ---------------- cola de elecciones ----------------

  /** Se para el juego; en grupo, para todos hasta que cada uno elige (G.Coop.holdStart). */
  function beginChoice() {
    Run.state = 'choice';
    if (G.Coop.active) { ownHold = true; G.Coop.holdStart(); }
  }

  /** Cierre de una elección de objeto o vínculo: el juego sigue (o espera a quien aún elige) y sale la siguiente. */
  function endChoice() {
    if (Run.state === 'choice') Run.state = holdBy.length ? 'held' : 'playing';
    if (ownHold) { ownHold = false; if (G.Coop.active) G.Coop.holdEnd(); }
    drainChoices();
  }

  /** Cartas de nivel en grupo: eligen todos a la vez y se espera a los demás. */
  function openLevelUp(level: number) {
    Run.state = 'levelup';
    G.UI.hide('scr-pause');
    G.Audio.sfx('levelup');
    G.RunUI.showLevelUp(level, G.LevelUp.offer(pl), card => {
      G.Audio.sfx('confirm');
      try { card.apply(pl); } finally { G.Coop.localPicked(); }     // sin esto, un fallo dejaría a todos esperando
    }, true);
  }

  function queueChoice(open: () => void) {
    choiceQ.push(open);
    drainChoices();
  }

  /** Abre las elecciones pendientes de una en una (una que no abre pantalla deja paso a la siguiente). */
  function drainChoices() {
    while (choiceQ.length && !choiceOpen() && (Run.state === 'playing' || Run.state === 'held')) choiceQ.shift()!();
  }

  /**
   * Cada fotograma (también con la partida parada): saca la siguiente elección y repara los cuelgues:
   * una pausa o un estado 'choice' sin pantalla de objeto o vínculo que lo justifique se quita.
   */
  function choiceTick() {
    if (!pl || Run.state === 'over') return;
    if (!G.UI.isOpen('scr-item') && !G.UI.isOpen('scr-bond')) {
      if (ownHold) endChoice();
      else if (Run.state === 'choice') Run.state = holdBy.length ? 'held' : 'playing';
    }
    drainChoices();
  }

  // ---------------- recogida ----------------

  const PICK_SFX: Record<string, string> = { xp: 'xp', xpBig: 'xp', coin: 'coin', heal: 'heal', bomb: 'break', magnet: 'confirm', ticket: 'shiny', ticket10: 'legend', item: 'legend' };

  /** Has cogido un objeto: eliges (equiparlo o seguir sin objeto si no llevas ninguno; quedarte o cambiar si ya llevas uno). */
  function offerItem(id: string) {
    if (!pl || !G.Items.BY[id]) return;
    // Se para el juego mientras eliges; en grupo, para todos (como con las
    // fusiones). Si ya hay otra elección abierta, espera a que se cierre.
    queueChoice(() => openItem(id));
  }

  /** @param got  el objeto elegido, o null si sigues sin objeto (el recogido se descarta) */
  function equipItem(got: string | null) {
    if (!got) { if (!pl.item) G.Spawner.say('Sigues sin objeto', 2, true); return; }
    if (got === pl.item) return;
    pl.equip(got);
    G.Spawner.say('¡Llevas ' + G.Items.BY[got].name + '!', 2.6, true);
    G.Progress.event('item', { id: got });
  }

  /** Se mira al abrirla, no al cogerlo: lo que llevas puede haber cambiado mientras esperaba. */
  function openItem(id: string) {
    if (pl.item === id) { G.Spawner.say('Ya llevas ' + G.Items.BY[id].name, 2, true); return; }
    beginChoice();
    G.RunUI.showItemChoice(pl.item, id, got => {
      try { equipItem(got); } finally { endChoice(); }
    });
  }

  /** @param who  quien lo ha cogido (en cooperativo puede ser un compañero) */
  function onCollect(p: Pickup, collector: PickupCollector = pl) {
    const who = collector as Player;
    const mine = who === pl;
    if (G.Coop.active && !G.Coop.isHost) {
      // Copia de un objeto del anfitrión: el efecto lo decide él.
      if (mine) G.Audio.sfx(PICK_SFX[p.kind]);
      return;
    }
    if (G.Coop.active) G.Coop.collected(p, who);
    if (mine || p.kind === 'bomb') G.Audio.sfx(PICK_SFX[p.kind]);
    if (p.kind === 'xp' || p.kind === 'xpBig') {
      pendingLevels += pl.gainXp((p.value as number) * (G.Coop.active ? G.Coop.xpFactor() : 1));
      return;
    }
    if (p.kind === 'coin') {
      pl.coins += p.value as number;
      G.FX.dmgText(who.x, who.y - who.bodyH - 6, '+' + p.value, '#ffd23f');
      return;
    }
    if (p.kind === 'item') {
      if (mine) offerItem(p.value as string);
      return;
    }
    if (p.kind === 'ticket' || p.kind === 'ticket10') {
      if (p.kind === 'ticket') pl.t1++; else pl.t10++;
      bankTickets();
      G.FX.dmgText(who.x, who.y - who.bodyH - 8, p.kind === 'ticket' ? '+1 ticket' : '¡Ticket ×10!', p.kind === 'ticket' ? '#ffd23f' : '#d9a6ff', true);
      G.FX.ring(who.x, who.y, 6, 50, p.kind === 'ticket' ? '#ffd23f' : '#c47bff', 0.4, 3);
      return;
    }
    if (p.kind === 'heal') {
      if (mine) pl.heal(pl.maxHp * 0.3);
      G.FX.ring(who.x, who.y, 6, 60, '#5fe08a', 0.4, 3);
      return;
    }
    if (p.kind === 'magnet') {
      G.Pickups.pullAll();
      G.FX.ring(who.x, who.y, 10, 420, '#ff9ed8', 0.6, 4);
      return;
    }
    if (p.kind === 'bomb') {
      if (G.U.dist2(who.x, who.y, pl.x, pl.y) < 500 * 500) G.Camera.kick(0.8);
      const R = G.Camera.outerRadius();
      G.FX.ring(who.x, who.y, 20, R, '#ff7b3d', 0.5, 6);
      for (const e of G.EnemyMgr.all()) {
        if (mine ? !G.Camera.sees(e.x, e.y, 0) : G.U.dist2(e.x, e.y, who.x, who.y) > R * R) continue;
        e.hurt(60 + pl.level * 14, '#ff7b3d', e.x - who.x, e.y - who.y, 160);
      }
    }
  }

  let deathT = 0;

  function update(dt: number) {
    const coop = G.Coop.active;
    if (flashT > 0) flashT -= dt;
    choiceTick();
    // La Sentencia de Arceus: mientras dura la animación, todo lo demás se para.
    if (G.Judgment.cinematic) {
      G.Judgment.cineTick(dt);
      pl.anim.update(dt);
      if (coop) for (const p of G.Coop.puppets()) p.netUpdate(dt);
      G.World.update(dt, G.Camera);
      G.FX.update(dt);
      G.Audio.music(G.Judgment.music);
      return;
    }
    // Tras caer, deja que se vea la animación de Faint antes del resumen.
    // (En la arena de la grieta no: allí caer sólo te echa de vuelta.)
    if (pl.dead && !coop && !G.Rift.inArena) {
      deathT += dt;
      pl.update(dt);
      G.EnemyMgr.update(dt * 0.3, pl);
      G.FX.update(dt);
      G.Camera.follow(pl.x, pl.y, dt);
      if (deathT > 1.3) { deathT = 0; endRun(true); }
      return;
    }
    time += dt;

    const b = Math.floor(time / 240);
    if (b !== biome && !G.Rift.inArena && !G.Judgment.active) {
      biome = b;
      G.World.setBiome(b);
      G.Audio.sfx('biome');
      G.Spawner.say('— ' + G.World.biomeName() + ' —', 3);
      G.FX.ring(pl.x, pl.y, 10, G.Camera.outerRadius(), '#ffffff', 0.7, 6);
    }

    pl.frozen = coop && (G.UI.isOpen('scr-pause') || G.UI.isOpen('scr-item'));
    if (spectating) {
      // Donde mira la cámara: con el jugador al que sigue (el anfitrión le manda los enemigos de ahí).
      const t = G.Spectate.target();
      if (t) { pl.x = t.x; pl.y = t.y; }
      pl.frozen = true; pl.dead = false; pl.hp = pl.maxHp;
      G.Spectate.tick();
    }
    pl.update(dt);
    if (coop) {
      for (const p of G.Coop.puppets()) { p.netUpdate(dt); G.Combat.ghostOrbit(p, dt, time); }
      if (pl.dead) reviveTick(dt);
    }
    if (coop && pl.dead && !spectating) lookTick(dt);
    else { look = null; G.Camera.follow(pl.x, pl.y, dt); }
    G.World.update(dt, G.Camera);

    const all = everyone();
    if (!coop || G.Coop.isHost) { G.Path.update(dt, all); G.Spawner.update(dt, all, time); }
    else G.Spawner.tickBanner(dt);
    G.EnemyMgr.update(dt, all);
    G.EnemyMgr.rebuildGrid();
    if (!spectating) G.Combat.tick(dt, pl, time);
    G.Projectiles.update(dt, pl, G.EnemyMgr.all());
    G.Combat.resolve(dt, pl, time);
    G.Combat.updateFields(dt);
    G.Pickups.update(dt, all, onCollect);
    G.Hazards.update(dt);
    if (!spectating) G.Interact.update(dt, pl);
    G.Rift.update(dt, pl, time);
    G.Judgment.update(dt, pl, time);
    G.Events.update(dt, all, time);
    G.Weather.update(dt, time, pl);
    G.FX.update(dt);

    if (!recordOn && recordAt > 0 && time > recordAt) {
      recordOn = true;
      G.UI.toast('¡Nuevo récord! Has pasado tu mejor tiempo', 3600);
      G.Audio.sfx('levelup');
    }
    G.Audio.music(G.Judgment.active ? G.Judgment.music : recordOn ? 'record' : G.Rift.inArena ? 'rift' : G.EnemyMgr.bossAlive() ? 'boss' : G.BIOME_MUSIC[biome % G.BIOME_MUSIC.length]);
    if (!coop || G.Coop.isHost) maybeLevelUp();
    if (pl.bonds > 0) offerBond(true);
    if (G.Coop.isHost) checkAllDown(dt);
  }

  /** Caído en grupo: un compañero a tu lado te va levantando. */
  function reviveTick(dt: number) {
    const helper = G.Coop.puppets().some(p => !p.dead && G.U.dist2(p.x, p.y, pl.x, pl.y) < 56 * 56);
    pl.reviveT = helper ? (pl.reviveT || 0) + dt : Math.max(0, (pl.reviveT || 0) - dt * 0.5);
    if (pl.reviveT >= G.Player.REVIVE_TIME) pl.revive(0.5);
  }

  /** Caído en grupo: la cámara va libre (el anfitrión te manda los enemigos de donde miras, net/coop.ts). */
  function lookTick(dt: number) {
    if (!look) look = { x: pl.x, y: pl.y, who: pl };
    // El compañero al que seguías ha caído (o se ha ido): vuelves a ti.
    if (look.who && look.who !== pl && (look.who.dead || !G.Coop.puppets().includes(look.who))) look.who = pl;
    const [ax, ay] = pl.frozen ? [0, 0] : G.Input.axis();
    if (ax || ay) { look.who = null; look.x += ax * LOOK_SPEED * dt; look.y += ay * LOOK_SPEED * dt; }
    else if (look.who) { look.x = look.who.x; look.y = look.who.y; }
    G.Camera.follow(look.x, look.y, dt);
  }

  /** A quién se puede mirar estando caído: tu Pokémon y los compañeros que siguen en pie. */
  const lookList = () => [pl, ...G.Coop.puppets().filter(p => !p.dead)];

  /** Caído en grupo: la cámara al siguiente compañero vivo (-1: al anterior); tu Pokémon va en la lista. */
  function cycleLook(d: number) {
    if (!look || !pl.dead || !G.Coop.active) return;
    const list = lookList();
    if (list.length < 2) return;
    const i = look.who ? list.indexOf(look.who) : -1;
    look.who = list[((i < 0 ? 0 : i) + d + list.length) % list.length];
    G.Audio.sfx('click');
  }

  /** Caído en grupo: Tab / E (LB / RB), la cámara al siguiente compañero; Q, al anterior. */
  function lookKeys() {
    const d = G.Input.tap('tab') || G.Input.tap('keye') ? 1 : G.Input.tap('keyq') ? -1 : 0;
    if (d) cycleLook(d);
  }

  /** Anfitrión: si caéis todos, se acaba (tras ver caer al último). */
  function checkAllDown(dt: number) {
    if (G.Rift.inArena || !G.Coop.players().every(p => p.dead)) { deathT = 0; return; }
    deathT += dt;
    if (deathT > 1.6) {
      deathT = 0;
      G.Coop.over(summary());
      endRun(true);
    }
  }

  /** La viñeta de la niebla, guardada por tamaño de pantalla (ver render). */
  let fogG: CanvasGradient | null = null, fogW = 0, fogH = 0;
  function render(v: View) {
    const { ctx, w, h, dpr, frameDt, fps: fpsShown } = v;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;

    ctx.save();
    ctx.scale(G.Camera.scale, G.Camera.scale);
    G.Camera.apply(ctx);
    v.drawScene(G.Camera, G.Coop.active ? (spectating ? G.Coop.puppets() : [pl, ...G.Coop.puppets()]) : [pl]);
    G.Projectiles.draw(ctx);
    G.Combat.drawAirFields(ctx);
    G.FX.draw(ctx);
    G.Judgment.drawAir(ctx);
    G.Pings.drawWorld(ctx);
    ctx.restore();

    G.Weather.draw(ctx, w, h, frameDt);
    G.World.drawVignette(ctx, w, h);
    // Niebla: la viñeta se cierra un poco (sin tapar el centro).
    const fog = G.Weather.vignette;
    if (fog > 0) {
      // (El degradado se guarda por tamaño; lo espesa de la niebla va en globalAlpha.)
      if (!fogG || fogW !== w || fogH !== h) {
        fogG = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.62);
        fogG.addColorStop(0, 'rgba(200,205,220,0)');
        fogG.addColorStop(1, 'rgba(200,205,220,0.45)');
        fogW = w; fogH = h;
      }
      ctx.globalAlpha = Math.min(1, fog);
      ctx.fillStyle = fogG;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    if (!G.Judgment.cinematic) { G.HUD.draw(ctx, w, h, spectating ? G.Spectate.target() || pl : pl, st); G.Pings.drawHud(ctx, w, h); }
    G.Judgment.drawOverlay(ctx, w, h);
    G.Touch.draw(ctx);
    if (G.Settings.get('fps')) {
      ctx.save();
      ctx.font = '700 11px Pixelify, monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = fpsShown >= 50 ? '#5fe08a' : fpsShown >= 30 ? '#ffd23f' : '#ff5f6d';
      ctx.fillText(fpsShown + ' FPS', w - 10, h - 8);
      ctx.restore();
    }
    if (flashT > 0) {
      ctx.save();
      // "Menos destellos": el fogonazo de pantalla se queda en un tercio.
      ctx.globalAlpha = Math.min(1, flashT / flashDur * 1.4) * (G.Settings.get('calm') ? 0.3 : 1);
      ctx.fillStyle = flashCol;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  // ---------------- teclado ----------------

  function keysModal() {
    // La Sentencia de Arceus: Espacio, Intro o Esc saltan la animación (si se puede).
    if (G.Judgment.cinematic && Run.state === 'playing') {
      if (['space', 'enter', 'escape'].some(k => G.Input.tap(k))) G.Judgment.skip();
      return true;
    }
    if (Run.state === 'levelup') {
      for (let i = 0; i < 3; i++) {
        if (G.Input.tap('digit' + (i + 1)) || G.Input.tap('numpad' + (i + 1))) G.RunUI.pick(i);
      }
      if (G.Input.tap('keyr')) G.RunUI.reroll();
      return true;
    }
    if (G.UI.isOpen('scr-bond')) {
      for (let i = 0; i < 4; i++) {
        if (G.Input.tap('digit' + (i + 1)) || G.Input.tap('numpad' + (i + 1))) G.RunUI.pickBond(i);
      }
      return true;
    }
    if (G.UI.isOpen('scr-item')) {
      for (let i = 0; i < 2; i++) {
        if (G.Input.tap('digit' + (i + 1)) || G.Input.tap('numpad' + (i + 1))) (document.querySelectorAll('#item-cards .card')[i] as HTMLElement).click();
      }
      return true;
    }
    return false;
  }

  function keysPlay() {
    if (spectating) { G.Spectate.keys(); return; }
    if (look) { lookKeys(); return; }
    for (let i = 0; i < 4; i++) {
      if (G.Input.tap('digit' + (i + 1)) || G.Input.tap('numpad' + (i + 1))) pl.setActive(i);
    }
    if (G.Input.tap('keyq')) pl.cycle(-1);
    if (G.Input.tap('keye') || G.Input.tap('tab')) pl.cycle(1);
  }

  function idle(dt: number) {
    if (flashT > 0) flashT -= dt;                   // el destello no puede quedarse si la partida está parada
    choiceTick();
    G.FX.update(dt * 0.25); pl.anim.update(dt * 0.25);
  }

  function drawables() {
    const out = [];
    const arceus = G.Judgment.drawable();
    if (arceus) out.push(arceus);
    for (const d of G.Events.drawables()) out.push(d);
    return out;
  }

  return {
    id: 'survivor',
    start, update, idle, keysModal, keysPlay, drawables, render, everyone,
    quit: quitRun,
    levelXp, flash, offerBond, cycleLook,
    /** El compañero al que miras estando caído (null si miras tu cuerpo o la cámara va libre). */
    get watching(): Player | null { return look && look.who && look.who !== pl ? look.who : null; },
    /** ¿Hay algún compañero vivo al que mirar? */
    canWatch() { return !!pl && pl.dead && G.Coop.active && G.Coop.puppets().some(p => !p.dead); },
    /** Para pruebas: salta el reloj de la run. */
    debugTime(t: number) { tampered = true; time = t; },
    /** La partida se ha tocado con herramientas de prueba: no sube al ranking. */
    tamper() { tampered = true; },
    /** Para grabar vídeos: abre las cartas de subir de nivel. */
    debugLevelUp() { tampered = true; pl.level++; pendingLevels++; },
    get player() { return pl; }, get time() { return time; }
  } satisfies GameMode & Record<string, unknown>;
})();
G.Survivor = Survivor;

declare module '../g' {
  interface Registry { Survivor: typeof Survivor }
}
