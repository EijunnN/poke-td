import { G } from './g';
import { Run, type GameMode, type View } from './run';
/* ============ game.ts — flujo del juego y bucle principal ============
 *
 *   login ──> test de personalidad ──> menú ──> run ──> resumen ──> menú
 *                (sólo la 1ª vez)          │
 *                                          ├─ Pokémon (colección)
 *                                          ├─ Mejoras
 *                                          └─ Gacha
 *
 * Estados del bucle (Run.state): 'ui' (menús, con el mundo de fondo),
 * 'playing', 'levelup', 'paused', 'over'...
 *
 * Aquí están el bucle, el lienzo, la pausa y el fondo de los menús. Lo que
 * pasa dentro de una partida lo pone el modo de juego (Run.mode, ver run.ts):
 * modes/survivor.ts es el de hordas.
 */
export const Game = (() => {
  let cv, ctx, dpr = 1, w = 0, h = 0;
  let last = 0;

  /** Los modos de juego que se pueden empezar, por id. */
  const MODES: Record<string, () => GameMode> = { survivor: () => G.Survivor };

  /** Tu Pokémon en la partida en curso (null en los menús antes de jugar). */
  const player = () => Run.mode ? Run.mode.player : null;
  const st = { get time() { return Run.mode ? Run.mode.time : 0; } };

  /** Lo que se le presta al modo para dibujar (se rellena en init y en cada fotograma). */
  const view: View = { ctx: null, w: 0, h: 0, dpr: 1, frameDt: 0, fps: 60, drawScene };

  /** Empieza una partida del modo `id`. */
  function start(id: string, opts: any = null) {
    Run.mode = MODES[id]();
    Run.mode.start(opts);
  }

  // ---------------- arranque ----------------

  function init() {
    cv = document.getElementById('game');
    ctx = cv.getContext('2d');
    view.ctx = ctx;
    resize();
    addEventListener('resize', resize);
    G.Touch.init(cv);
    // En móvil: al cambiar de app o girarlo en vertical, la partida se pausa.
    document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
    G.RunUI.wirePause(() => { Run.state = 'playing'; G.UI.hideAll(); }, () => Run.mode.quit());
    Backdrop.init();
    last = performance.now();
    requestAnimationFrame(loop);
  }

  function resize() {
    // Resolución interna como mucho ×1,5: en pantallas ×2 dibujar el doble de
    // píxeles era de lo que más costaba, y con el pixel art no se nota.
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    w = cv.clientWidth; h = cv.clientHeight;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    view.w = w; view.h = h; view.dpr = dpr;
    G.Camera.resize(w, h, dpr);
    checkOrientation();
  }

  /** Móvil en vertical: aviso de girarlo (y pausa). */
  function checkOrientation() {
    const portrait = G.Touch.active && innerHeight > innerWidth;
    const el = document.getElementById('rotate');
    if (!el) return;
    if (portrait && !document.getElementById('rotate-ico').innerHTML) document.getElementById('rotate-ico').innerHTML = G.Icons.html('phone', 48);
    el.classList.toggle('hidden', !portrait);
    if (portrait) autoPause();
  }

  /** Pausa sola (sólo en solitario: en grupo los demás siguen). */
  function autoPause() {
    G.Touch.reset();
    if (Run.state === 'playing' && !G.Coop.active) { Run.state = 'paused'; G.RunUI.showPause(); }
  }

  /** Pausa/continúa (tecla Esc o P, o el botón de pausa del móvil). */
  function togglePause() {
    // En grupo la pausa no para el juego (los demás siguen jugando).
    if (G.Coop.active) {
      if (Run.state !== 'playing') return;
      if (G.UI.isOpen('scr-pause')) G.UI.hide('scr-pause');
      else { G.RunUI.showPause(true); G.Audio.sfx('pause'); }
      return;
    }
    if (Run.state === 'playing') { Run.state = 'paused'; G.RunUI.showPause(); G.Audio.sfx('pause'); }
    else if (Run.state === 'paused') { Run.state = 'playing'; G.UI.hideAll(); }
  }

  // ---------------- teclado ----------------

  function handleKeys() {
    if (G.SettingsUI.isOpen) { if (G.Input.tap('escape')) G.SettingsUI.close(); return; }
    // Las pantallas del modo (cartas de nivel, elegir objeto...) van antes que nada.
    if (Run.mode && Run.mode.keysModal()) return;
    if (Run.state === 'ui') {
      // Esc en una subpantalla del menú vuelve al menú.
      if (G.Input.tap('escape') && !G.UI.isOpen('scr-profile') && ['scr-dex', 'scr-upgrades', 'scr-gacha', 'scr-friends', 'scr-rank', 'scr-goals'].some(G.UI.isOpen)
          && document.getElementById('pull-fx').classList.contains('hidden')) G.MenuUI.open();
      return;
    }
    if (G.Input.tap('escape') || G.Input.tap('keyp')) { togglePause(); return; }
    if (Run.state !== 'playing' || !player()) return;
    Run.mode.keysPlay();
  }

  // ---------------- bucle ----------------

  let speedK = 1;
  let fpsAcc = 0, fpsN = 0;
  // El siguiente fotograma se pide ANTES de nada: si algo falla a mitad, el
  // juego sigue (antes se quedaba congelado para siempre y había que recargar;
  // así se perdió una partida enorme al abrirse una grieta).
  // Si falla fotograma tras fotograma (el juego ya no avanza ni se ve), la
  // partida se da por terminada a los ~3 s y se guarda: tiempo, derrotados,
  // récords y ranking. Mejor eso que una pantalla negra y perderlo todo.
  let loopErrs = 0, errRun = 0;
  function loop(ts) {
    requestAnimationFrame(loop);
    try { frame(ts); errRun = 0; }
    catch (e) {
      if (loopErrs++ < 5) console.error('[Game] fallo en un fotograma:', e);
      G.Input.endFrame();
      if (++errRun === 180 && player() && Run.state !== 'ui' && Run.state !== 'over') {
        try {
          G.UI.hideAll();
          Run.mode.quit();
          G.UI.toast('El juego ha fallado: tu partida se ha guardado hasta aquí', 5000);
        } catch (e2) { console.error('[Game] no se pudo cerrar la partida:', e2); }
      }
    }
  }

  function frame(ts) {
    const real = (ts - last) / 1000 || 0;
    const dt = Math.min(1 / 30, real) * speedK;
    last = ts;
    if (Run.state === 'playing') G.Settings.sample(real);
    fpsAcc += real; fpsN++;
    if (fpsAcc >= 0.5) { view.fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
    view.frameDt = Run.state === 'playing' ? dt : 0;

    handleKeys();

    if (Run.state === 'playing') Run.mode.update(dt);
    else if (player() && Run.state !== 'ui') Run.mode.idle(dt);
    // La red se atiende siempre (también con las cartas de nivel abiertas).
    if (G.Coop.active && player() && Run.state !== 'ui' && Run.state !== 'over') G.Coop.tick(dt);

    if (player() && Run.state !== 'ui') Run.mode.render(view); else Backdrop.render(ctx, w, h, dpr, dt);
    G.UI.tick(dt);

    G.Input.endFrame();
  }

  // ---------------- dibujo ----------------

  function drawScene(cam, extra) {
    const t = performance.now() / 1000;
    G.World.drawGround(ctx, cam);
    G.World.drawLiquid(ctx, cam, t);
    G.Hazards.draw(ctx);
    G.Combat.drawGroundFields(ctx);
    G.Pickups.draw(ctx);

    // Todo lo que tiene "pies" se ordena por Y: objetos, enemigos, jugador.
    const items = [];
    // Los planos (manantiales, trampas) siempre debajo de todo lo demás.
    for (const p of G.World.visibleProps(cam)) items.push({ y: p.flat ? p.y - 4000 : p.y, prop: p });
    for (const e of G.EnemyMgr.drawables(cam)) items.push({ y: e.y, ent: e });
    for (const e of extra) items.push({ y: e.y, ent: e });
    const rift = G.Rift.drawable();
    if (rift) items.push({ y: rift.y, ent: rift });
    if (player() && Run.state !== 'ui') for (const d of Run.mode.drawables()) items.push({ y: d.y, ent: d });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) {
      if (it.prop) G.World.drawProp(ctx, it.prop, t);
      else it.ent.draw(ctx);
    }
  }


  // ---------------- fondo de los menús ----------------

  /**
   * El mundo de verdad, con Pokémon salvajes paseando y la cámara a la deriva.
   * Así el menú enseña desde el primer segundo cómo se ve el juego.
   */
  const Backdrop = (() => {
    let wanderers = [], t = 0, ready = false, biomeT = 0, bi = 0;
    const CAST = [1, 4, 7, 25, 133, 52, 39, 35, 16, 43, 60, 69, 74, 92, 129, 147, 113, 143, 54, 79];

    function init() {
      G.World.reset(4242);
      G.World.setBiome(0, true);
      G.Camera.x = 0; G.Camera.y = 0;
      wanderers = CAST.map(dex => spawn(dex, true));
      ready = true;
    }

    function spawn(dex, anywhere) {
      const a = new G.Sprites.Animator(dex, 1);
      const r = G.Sprites.bodyRadius(dex);
      let x = 0, y = 0;
      for (let i = 0; i < 20; i++) {
        x = G.Camera.x + G.U.rand(-1, 1) * (anywhere ? G.Camera.w * 0.6 : G.Camera.w * 0.7);
        y = G.Camera.y + G.U.rand(-1, 1) * (anywhere ? G.Camera.h * 0.6 : G.Camera.h * 0.7);
        if (G.World.isFree(x, y, r)) break;
      }
      return { dex, anim: a, x, y, r, vx: 0, vy: 0, t: 0, draw(ctx) {
        G.Sprites.drawShadow(ctx, this.dex, this.x, this.y);
        this.anim.draw(ctx, this.x, this.y);
      } };
    }

    function step(dt) {
      t += dt;
      G.World.update(dt, G.Camera);
      // Deriva lenta de la cámara.
      G.Camera.x += Math.cos(t * 0.05) * 14 * dt;
      G.Camera.y += Math.sin(t * 0.037) * 10 * dt;
      G.Camera.follow(G.Camera.x, G.Camera.y, dt);

      biomeT += dt;
      if (biomeT > 30) { biomeT = 0; bi = (bi + 1) % 3; G.World.setBiome(bi); }

      for (const wd of wanderers) {
        wd.t -= dt;
        if (wd.t <= 0) {
          // Pasea, se para o "ataca" al aire de vez en cuando.
          wd.t = G.U.rand(1, 3.5);
          const r = Math.random();
          if (r < 0.55) {
            const a = Math.random() * 6.2832, s = G.U.rand(25, 55);
            wd.vx = Math.cos(a) * s; wd.vy = Math.sin(a) * s;
          } else {
            wd.vx = wd.vy = 0;
            if (r > 0.85) wd.anim.play(G.U.pick(['Attack', 'Shoot', 'Charge']));
          }
        }
        wd.x += wd.vx * dt; wd.y += wd.vy * dt;
        G.World.collide(wd);
        const moving = Math.abs(wd.vx) + Math.abs(wd.vy) > 1;
        if (moving) wd.anim.dir = G.Sprites.dirFromAngle(Math.atan2(wd.vy, wd.vx));
        wd.anim.loop(moving ? 'Walk' : 'Idle');
        wd.anim.update(dt);
        // Si se queda fuera de cámara, reaparece dentro.
        if (!G.Camera.sees(wd.x, wd.y, 120)) Object.assign(wd, spawn(wd.dex, false));
      }
    }

    function render(ctx, w, h, dpr, dt) {
      if (!ready) return;
      step(dt);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.save();
      ctx.scale(G.Camera.scale, G.Camera.scale);
      G.Camera.apply(ctx);
      drawScene(G.Camera, wanderers);
      ctx.restore();
      G.World.drawVignette(ctx, w, h);
    }

    /** Al volver de una run, recupera el mundo del menú. */
    function restore() {
      G.World.reset(4242);
      G.World.setBiome(bi, true);
      G.FX.clear(); G.Projectiles.clear(); G.Combat.clearFields(); G.EnemyMgr.clear(); G.Pickups.clear();
      wanderers = CAST.map(dex => spawn(dex, true));
    }

    return { init, render, restore };
  })();

  return {
    init, start, togglePause,
    /** Empieza una partida de hordas. @param coop  { seed, host, members } para una partida en grupo */
    startRun(coop = null) { start('survivor', coop); },
    /** Todos los jugadores de la partida (tú primero). */
    everyone() { return Run.mode ? Run.mode.everyone() : [null]; },
    // Lo que sigue es del modo de hordas; se llama desde aquí por comodidad.
    levelXp() { return G.Survivor.levelXp(); },
    flash(col, dur) { G.Survivor.flash(col, dur); },
    offerBond(quiet = false) { G.Survivor.offerBond(quiet); },
    /** Para pruebas: salta el reloj de la run. */
    debugTime(t) { G.Survivor.debugTime(t); },
    /** Para grabar vídeos: cámara lenta (0,5 = mitad de velocidad). */
    debugSpeed(k) { if (k > 1) G.Survivor.tamper(); speedK = k; },
    /** Abandona la partida en curso (p. ej. al cerrar sesión desde Ajustes). */
    quit() { if (Run.state !== 'ui' && Run.state !== 'over') Run.mode.quit(); },
    /** Para grabar vídeos: abre las cartas de subir de nivel. */
    debugLevelUp() { G.Survivor.debugLevelUp(); },
    toUI() { Run.state = 'ui'; Backdrop.restore(); },
    get state() { return Run.state; }, get player() { return player(); }, st
  };
})();
G.Game = Game;

/* ============ Flow — transiciones entre pantallas ============ */
export const Flow = {
  boot() {
    G.UI.initChrome();
    G.LoginUI.init(); G.TestUI.init(); G.MenuUI.init(); G.GachaUI.init();
    G.SocialUI.init(); G.RankingUI.init(); G.ModUI.init(); G.GoalsUI.init(); G.ProfileUI.init(); G.SettingsUI.init(); G.SupportUI.init(); G.NewsUI.init(); G.Updater.init();
    // Tu nombre arriba a la derecha abre tu perfil.
    document.getElementById('user-pill').onclick = () => G.GoalsUI.open('profile');
    G.Audio.music('village');     // suena tras el primer clic (lo exige el navegador)
    G.Game.init();
    // La base de datos (nube o local) recupera la sesión anterior.
    G.DB.ready().then(restored => {
      document.getElementById('boot').classList.add('hidden');
      // En otra tarea: crear el sonido para comprobarlo cuesta ~60 ms y no debe bloquear la carga.
      setTimeout(() => this.tapToStart(() => { if (restored) this.afterLogin(); else this.toLogin(); }), 0);
    });
  },
  /**
   * "Pulsa para empezar": los navegadores no dejan que una web suene hasta
   * que se toca algo. Con esta pantalla la música empieza en cuanto entras.
   * (Si el navegador ya deja sonar, no sale.)
   */
  tapToStart(then) {
    G.Audio.unlock();
    if (G.Audio.canPlay()) { then(); return; }
    const el = document.getElementById('tap-start');
    el.classList.remove('hidden');
    const go = e => {
      if (e.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      G.Audio.unlock();
      el.classList.add('hidden');
      el.removeEventListener('click', go); removeEventListener('keydown', go, true);
      then();
    };
    el.addEventListener('click', go);
    addEventListener('keydown', go, true);
  },
  toLogin() { G.Audio.music('village'); G.LoginUI.open(); },
  afterLogin() {
    G.Audio.music('village');
    if (!G.DB.save.partner) G.TestUI.start();
    else this.goMenu();
  },
  goMenu() {
    if (G.Game.state !== 'ui') G.Game.toUI();
    G.Audio.music('village');
    G.MenuUI.open();
    G.LoginUI.offerRecovery();
  },
  /** Al cerrar el resumen: a la sala si sigues en una, si no al menú. */
  afterRun() {
    if (G.Social.room) {
      if (G.Game.state !== 'ui') G.Game.toUI();
      G.Audio.music('village');
      if (G.Social.room.isHost) G.Social.setOpen(true);
      G.LobbyUI.open();
    } else this.goMenu();
  },
  play() { G.Game.startRun(); },
  /** Empieza la partida en grupo (el anfitrión la manda a todos). */
  startCoop(cfg) {
    if (G.Game.state !== 'ui' || !G.Social.room) return;
    G.LobbyUI.close();
    G.Game.startRun(cfg);
  }
};
G.Flow = Flow;

declare module './g' {
  interface Registry { Game: typeof Game; Flow: typeof Flow }
}
