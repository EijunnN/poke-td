import { G } from './g';
import { Run, type GameMode, type View } from './run';
import type { CameraT } from './core/camera';
import type { CoopConfig } from './net/coop';
import type { Player } from './entities/player';
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
/** Pokémon salvaje que pasea por el fondo de los menús. */
interface Wanderer {
  dex: number; anim: InstanceType<typeof G.Sprites.Animator>;
  x: number; y: number; r: number; vx: number; vy: number; t: number;
  draw(ctx: CanvasRenderingContext2D): void;
}
/** Algo que se dibuja ordenado por Y: un objeto del mundo o una entidad con draw. */
interface DrawItem { y: number; prop?: ReturnType<typeof G.World.visibleProps>[number]; ent?: { draw(ctx: CanvasRenderingContext2D): void } }

export const Game = (() => {
  let cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D, dpr = 1, w = 0, h = 0;
  let last = 0;

  /** Los modos de juego que se pueden empezar, por id. */
  const MODES: Record<string, () => GameMode> = { survivor: () => G.Survivor, td: () => G.TD };

  /** Tu Pokémon en la partida en curso (null en los menús antes de jugar). */
  // (null sin partida, como siempre; quien lo usa lo hace con partida.)
  const player = (): Player => Run.mode ? Run.mode.player : null!;
  const st = { get time() { return Run.mode ? Run.mode.time : 0; } };

  /** Lo que se le presta al modo para dibujar (se rellena en init y en cada fotograma). */
  const view: View = { ctx: null!, w: 0, h: 0, dpr: 1, frameDt: 0, fps: 60, drawScene };

  /** Empieza una partida del modo `id`. */
  function start(id: string, opts: unknown = null) {
    Run.mode = MODES[id]();
    Run.mode.start(opts);
  }

  // ---------------- arranque ----------------

  function init() {
    cv = document.getElementById('game') as HTMLCanvasElement;
    ctx = cv.getContext('2d')!;
    view.ctx = ctx;
    resize();
    // WebKit (iPhone, PWA) a veces avisa del giro con las medidas viejas: se
    // vuelve a medir al momento y un poco después, y el bucle lo vigila.
    addEventListener('resize', settle);
    addEventListener('orientationchange', settle);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', settle);
    if (window.ResizeObserver) new ResizeObserver(settle).observe(cv);
    G.Settings.on(k => { if (k === 'res') resize(); });
    G.Touch.init(cv);
    // En móvil: al cambiar de app o girarlo en vertical, la partida se pausa.
    document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); else settle(); });
    // Y al perder el foco (bajar la cortinilla de avisos del móvil, Alt+Tab a otra ventana visible).
    addEventListener('blur', autoPause);
    trapBack();
    // Recargar o cerrar la pestaña sin querer en mitad de una partida la pierde: aviso estándar del
    // navegador (en móvil casi nunca sale). Sólo en partida: ni en menús ni en el resumen ('over'); el
    // actualizador (updater.ts) y el cambio de idioma sólo recargan en menús, así que no lo disparan.
    addEventListener('beforeunload', e => {
      if (!player() || Run.state === 'ui' || Run.state === 'over') return;
      e.preventDefault();
      e.returnValue = '';
    });
    G.RunUI.wirePause(() => { Run.state = 'playing'; G.UI.hideAll(); }, () => Run.mode!.quit());
    Backdrop.init();
    last = performance.now();
    requestAnimationFrame(loop);
  }

  // Resolución interna: "Alta" (por defecto) hasta ×1,5; "Normal", ×1. En
  // pantallas ×2 dibujar el doble de píxeles era de lo que más costaba, y con
  // el pixel art no se nota.
  const calcDpr = () => {
    const dev = window.devicePixelRatio || 1, res = G.Settings.get('res');
    if (res !== 'auto') return Math.min(res === 'normal' ? 1 : 1.5, dev);
    // Auto: en pantallas grandes (portátil, monitor) ×1, que con el pixel art no se nota y es menos de la
    // mitad de píxeles que ×1,5; en las pequeñas (móvil) hasta ×1,5 mientras no pase de AUTO_PX píxeles.
    const css = innerWidth * innerHeight;
    if (css >= AUTO_BIG) return 1;
    return Math.max(1, Math.min(1.5, dev, Math.sqrt(AUTO_PX / Math.max(1, css))));
  };
  /** Pantallas de al menos tantos píxeles CSS cuentan como grandes; y los píxeles reales que se permiten en las pequeñas. */
  const AUTO_BIG = 850_000, AUTO_PX = 1_300_000;
  let iw = 0, ih = 0, checkAt = 0, redraw = true;
  let settleTimers: ReturnType<typeof setTimeout>[] = [];

  function resize() {
    dpr = calcDpr();
    w = cv.clientWidth; h = cv.clientHeight;
    iw = innerWidth; ih = innerHeight;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    // (cambiar width/height borra el lienzo: sólo si cambia de verdad)
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    view.w = w; view.h = h; view.dpr = dpr;
    G.Camera.resize(w, h, dpr);
    checkOrientation();
    redraw = true;
  }

  /** Mide ahora y otra vez a los 150 y 500 ms (los navegadores móviles tardan en dar la medida nueva). */
  function settle() {
    resize();
    settleTimers.forEach(clearTimeout);
    settleTimers = [setTimeout(resize, 150), setTimeout(resize, 500)];
  }

  /** Red de seguridad: si el lienzo, la ventana o la densidad ya no cuadran con lo medido, se mide de nuevo. */
  function watchSize() {
    if (cv.clientWidth !== w || cv.clientHeight !== h || innerWidth !== iw || innerHeight !== ih || calcDpr() !== dpr) resize();
  }

  /** Móvil en vertical: aviso de girarlo (y pausa). */
  function checkOrientation() {
    const portrait = G.Touch.active && innerHeight > innerWidth;
    const el = document.getElementById('rotate');
    if (!el) return;
    if (portrait && !document.getElementById('rotate-ico')!.innerHTML) document.getElementById('rotate-ico')!.innerHTML = G.Icons.html('phone', 48);
    el.classList.toggle('hidden', !portrait);
    if (portrait) autoPause();
  }

  /** Pausa sola (sólo en solitario: en grupo los demás siguen). */
  function autoPause() {
    G.Touch.reset();
    if (Run.state === 'playing' && !G.Coop.active) { Run.state = 'paused'; G.RunUI.showPause(); }
  }

  /**
   * Botón «atrás» del móvil (y del navegador): en partida pausa, en una subpantalla vuelve
   * al menú y sólo desde el menú principal sale de la web. Se deja una entrada de más en
   * el historial; al consumirla se vuelve a poner. Los navegadores ignoran las entradas
   * puestas sin que el jugador haya tocado nada, por eso se pone en el primer toque o tecla.
   */
  function trapBack() {
    let armed = false;
    const arm = () => { if (!armed) { armed = true; history.pushState({ back: 1 }, ''); } };
    addEventListener('pointerdown', arm, true);
    addEventListener('keydown', arm, true);
    addEventListener('popstate', () => {
      armed = false;
      if (onBack()) arm(); else history.back();
    });
  }

  /** Lo que hace «atrás»; false si toca salir de la web. */
  function onBack() {
    if (G.SettingsUI.isOpen) { G.SettingsUI.close(); return true; }
    if (G.UI.isOpen('scr-profile')) { G.UI.hide('scr-profile'); return true; }
    if (Run.state === 'playing') {
      if (G.Coop.active) { if (!G.UI.isOpen('scr-pause')) G.RunUI.showPause(true); }
      else { G.Touch.reset(); Run.state = 'paused'; G.RunUI.showPause(); }
      return true;
    }
    if (Run.state !== 'ui') return true;     // pausa, resumen: se queda donde está
    if (['scr-dex', 'scr-upgrades', 'scr-shop', 'scr-gacha', 'scr-friends', 'scr-rooms', 'scr-rank', 'scr-goals'].some(G.UI.isOpen)
        && document.getElementById('pull-fx')!.classList.contains('hidden')) { G.MenuUI.open(); return true; }
    return false;
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
      if (G.Input.tap('escape') && !G.UI.isOpen('scr-profile') && ['scr-dex', 'scr-upgrades', 'scr-shop', 'scr-gacha', 'scr-friends', 'scr-rooms', 'scr-rank', 'scr-goals'].some(G.UI.isOpen)
          && document.getElementById('pull-fx')!.classList.contains('hidden')) G.MenuUI.open();
      return;
    }
    if (Run.state === 'over') { G.RunUI.keysOver(); return; }   // resumen: Esc menú · Intro otra vez
    if (G.Input.tap('escape') || G.Input.tap('keyp')) { togglePause(); return; }
    if (Run.state !== 'playing' || !player()) return;
    Run.mode!.keysPlay();
  }

  // ---------------- bucle ----------------

  let speedK = 1;
  let fpsAcc = 0, fpsN = 0;
  // Dibujo a ritmo bajo en menús y pausa: tiempo desde el último fotograma dibujado.
  const SLOW_STEP = 1 / 30 - 0.004;
  let slowAcc = 0, lastTag = '';
  // El siguiente fotograma se pide ANTES de nada: si algo falla a mitad, el
  // juego sigue (antes se quedaba congelado para siempre y había que recargar;
  // así se perdió una partida enorme al abrirse una grieta).
  // Si falla fotograma tras fotograma (el juego ya no avanza ni se ve), la
  // partida se da por terminada a los ~3 s y se guarda: tiempo, derrotados,
  // récords y ranking. Mejor eso que una pantalla negra y perderlo todo.
  let loopErrs = 0, errRun = 0;
  function loop(ts: number) {
    requestAnimationFrame(loop);
    try { frame(ts); errRun = 0; }
    catch (e) {
      if (loopErrs++ < 5) console.error('[Game] fallo en un fotograma:', e);
      G.Input.endFrame();
      if (++errRun === 180 && player() && Run.state !== 'ui' && Run.state !== 'over') {
        try {
          G.UI.hideAll();
          Run.mode!.quit();
          G.UI.toast('El juego ha fallado: tu partida se ha guardado hasta aquí', 5000);
        } catch (e2) { console.error('[Game] no se pudo cerrar la partida:', e2); }
      }
    }
  }

  function frame(ts: number) {
    const real = (ts - last) / 1000 || 0;
    const dt = Math.min(1 / 30, real) * speedK;
    last = ts;
    if (ts - checkAt > 250) { checkAt = ts; watchSize(); }
    if (Run.state === 'playing') G.Settings.sample(real);
    fpsAcc += real; fpsN++;
    if (fpsAcc >= 0.5) { view.fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
    view.frameDt = Run.state === 'playing' ? dt : 0;

    handleKeys();

    if (Run.state === 'playing') Run.mode!.update(dt);
    else if (player() && Run.state !== 'ui') Run.mode!.idle(dt);
    // La red se atiende siempre (también con las cartas de nivel abiertas).
    if (G.Coop.active && player() && Run.state !== 'ui' && Run.state !== 'over') G.Coop.tick(dt);

    // Menús y pausa: nada se mueve deprisa, basta con ~30 FPS (en 120 Hz era gastar GPU a lo tonto).
    const inRun = !!player() && Run.state !== 'ui';
    const lazy = !inRun || Run.state === 'paused';
    const tag = (inRun ? 'run:' : 'menu:') + Run.state;
    slowAcc += real;
    if (!lazy || redraw || tag !== lastTag || slowAcc >= SLOW_STEP) {
      if (inRun) Run.mode!.render(view); else Backdrop.render(ctx, w, h, dpr, Math.min(slowAcc, 1 / 15) * speedK);
      slowAcc = 0; lastTag = tag; redraw = false;
    }
    G.UI.tick(dt);

    G.Input.endFrame();
  }

  // ---------------- dibujo ----------------

  function drawScene(cam: CameraT, extra: { y: number; draw(ctx: CanvasRenderingContext2D): void }[]) {
    const t = performance.now() / 1000;
    G.World.drawGround(ctx, cam);
    G.World.drawLiquid(ctx, cam, t);
    if (player() && Run.state !== 'ui' && Run.mode!.drawGround) Run.mode!.drawGround(ctx);
    G.Hazards.draw(ctx);
    G.Combat.drawGroundFields(ctx);
    G.Pickups.draw(ctx);

    // Todo lo que tiene "pies" se ordena por Y: objetos, enemigos, jugador.
    const items: DrawItem[] = [];
    // Los planos (manantiales, trampas) siempre debajo de todo lo demás.
    for (const p of G.World.visibleProps(cam)) items.push({ y: p.flat ? p.y - 4000 : p.y, prop: p });
    for (const e of G.EnemyMgr.drawables(cam)) items.push({ y: e.y, ent: e });
    for (const e of extra) items.push({ y: e.y, ent: e });
    const rift = G.Rift.drawable();
    if (rift) items.push({ y: rift.y, ent: rift });
    if (player() && Run.state !== 'ui') for (const d of Run.mode!.drawables()) items.push({ y: d.y, ent: d });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) {
      if (it.prop) G.World.drawProp(ctx, it.prop, t);
      else it.ent!.draw(ctx);
    }
  }


  // ---------------- fondo de los menús ----------------

  /**
   * El mundo de verdad, con Pokémon salvajes paseando y la cámara a la deriva.
   * Así el menú enseña desde el primer segundo cómo se ve el juego.
   */
  const Backdrop = (() => {
    let wanderers: Wanderer[] = [], t = 0, ready = false, biomeT = 0, bi = 0;
    const CAST = [1, 4, 7, 25, 133, 52, 39, 35, 16, 43, 60, 69, 74, 92, 129, 147, 113, 143, 54, 79];

    function init() {
      G.World.reset(4242);
      G.World.setBiome(0, true);
      G.Camera.x = 0; G.Camera.y = 0;
      wanderers = CAST.map(dex => spawn(dex, true));
      ready = true;
    }

    function spawn(dex: number, anywhere: boolean): Wanderer {
      const a = new G.Sprites.Animator(dex, 1);
      const r = G.Sprites.bodyRadius(dex);
      let x = 0, y = 0;
      for (let i = 0; i < 20; i++) {
        x = G.Camera.x + G.U.rand(-1, 1) * (anywhere ? G.Camera.w * 0.6 : G.Camera.w * 0.7);
        y = G.Camera.y + G.U.rand(-1, 1) * (anywhere ? G.Camera.h * 0.6 : G.Camera.h * 0.7);
        if (G.World.isFree(x, y, r)) break;
      }
      return { dex, anim: a, x, y, r, vx: 0, vy: 0, t: 0, draw(ctx: CanvasRenderingContext2D) {
        G.Sprites.drawShadow(ctx, this.dex, this.x, this.y);
        this.anim.draw(ctx, this.x, this.y);
      } };
    }

    function step(dt: number) {
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

    function render(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, dt: number) {
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
    startRun(coop: CoopConfig | null = null) { start('survivor', coop); },
    /** Todos los jugadores de la partida (tú primero). */
    // (Sin partida, [null] como siempre: sólo se usa con partida.)
    everyone(): Player[] { return Run.mode ? Run.mode.everyone() : [null!]; },
    // Lo que sigue es del modo de hordas; se llama desde aquí por comodidad.
    levelXp() { return G.Survivor.levelXp(); },
    flash(col: string, dur: number) { G.Survivor.flash(col, dur); },
    offerBond(quiet = false) { G.Survivor.offerBond(quiet); },
    /** Para pruebas: salta el reloj de la run. */
    debugTime(t: number) { G.Survivor.debugTime(t); },
    /** Para grabar vídeos: cámara lenta (0,5 = mitad de velocidad). */
    debugSpeed(k: number) { if (k > 1) G.Survivor.tamper(); speedK = k; },
    /** Abandona la partida en curso (p. ej. al cerrar sesión desde Ajustes). */
    quit() { if (Run.state !== 'ui' && Run.state !== 'over') Run.mode!.quit(); },
    /** Para grabar vídeos: abre las cartas de subir de nivel. */
    debugLevelUp() { G.Survivor.debugLevelUp(); },
    toUI() { Run.state = 'ui'; Backdrop.restore(); },
    get state() { return Run.state; }, get player() { return player(); }, st
  };
})();
G.Game = Game;

/* ============ Flow — transiciones entre pantallas ============ */
/** Se está cerrando el resumen para empezar otra partida en grupo (startCoop): afterRun no lleva a la sala. */
let chaining = false;
export const Flow = {
  boot() {
    G.UI.initChrome();
    G.LoginUI.init(); G.TestUI.init(); G.MenuUI.init(); G.GachaUI.init();
    G.SocialUI.init(); G.RoomsUI.init(); G.RankingUI.init(); G.ModUI.init(); G.GoalsUI.init(); G.ProfileUI.init(); G.SettingsUI.init(); G.SupportUI.init(); G.NewsUI.init(); G.GuideUI.init(); G.Updater.init();
    // Tu nombre arriba a la derecha abre tu perfil.
    document.getElementById('user-pill')!.onclick = () => G.GoalsUI.open('profile');
    G.Audio.music('village');     // suena tras el primer clic (lo exige el navegador)
    G.Game.init();
    // La base de datos (nube o local) recupera la sesión anterior.
    G.DB.ready().then((restored: boolean) => {
      document.getElementById('boot')!.classList.add('hidden');
      // En otra tarea: crear el sonido para comprobarlo cuesta ~60 ms y no debe bloquear la carga.
      setTimeout(() => this.tapToStart(() => { if (restored) this.afterLogin(); else this.toLogin(); }), 0);
    });
  },
  /**
   * "Pulsa para empezar": los navegadores no dejan que una web suene hasta
   * que se toca algo. Con esta pantalla la música empieza en cuanto entras.
   * (Si el navegador ya deja sonar, no sale.)
   */
  tapToStart(then: () => void) {
    G.Audio.unlock();
    if (G.Audio.canPlay()) { then(); return; }
    const el = document.getElementById('tap-start')!;
    el.classList.remove('hidden');
    const go = (e: Event) => {
      if (e.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes((e as KeyboardEvent).key)) return;
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
    if (!G.DB.save!.partner) G.TestUI.start();
    else this.goMenu();
  },
  goMenu() {
    if (G.Game.state !== 'ui') G.Game.toUI();
    G.Audio.music('village');
    G.MenuUI.open();
  },
  /** Al cerrar el resumen: a la sala si sigues en una, si no al menú. */
  afterRun() {
    if (chaining) return;                          // otra partida en grupo desde el resumen (startCoop): no se pasa por la sala
    G.Coop.againSet(false);                        // (si estabas listo para otra, ya no)
    if (G.Social.room) {
      if (G.Game.state !== 'ui') G.Game.toUI();
      G.Audio.music('village');
      if (G.Social.room.isHost) G.Social.setOpen(true);
      G.LobbyUI.open();
    } else this.goMenu();
  },
  play() { G.Game.startRun(); },
  /**
   * "Volver a intentarlo" del resumen: `again` empieza otra partida igual sin pasar por el menú.
   * Si hay versión nueva pendiente, va al menú (o a la sala), que es donde se recarga (updater.ts): no se
   * encadenan partidas con la vieja. `back`: lo que hace "Volver al menú"; `again` y `back` valen una sola vez.
   * En grupo no se empieza aquí: quedas listo y, cuando lo están todos, el anfitrión empieza (Coop.againSet →
   * startCoop). `normal`: ha acabado para todos a la vez; si el anfitrión se fue o se cortó, no hay botón.
   * Sin grupo pero con sala, tampoco: ahí se vuelve a la sala.
   */
  retry(group: boolean, normal: boolean, back: () => void, again: () => void): (() => void) | null {
    if (group) {
      if (!normal || !G.Social.room) return null;
      return () => {
        if (G.Game.state !== 'over') return;
        if (G.Updater.pending) { back(); return; }
        G.RunUI.againReady();
        G.Coop.againSet(true);
      };
    }
    if (G.Social.room) return null;
    return () => {
      if (G.Game.state !== 'over') return;
      if (G.Updater.pending) { back(); return; }
      // Como al empezar desde el menú (y como startCoop desde el resumen): fuera el resumen, estado de menú.
      G.UI.hide('scr-over');
      G.Game.toUI();
      again();
    };
  },
  /**
   * Tras enseñar el resumen de una partida en grupo: engancha la cuenta de "Volver a intentarlo" (net/coop.ts).
   * `normal`: ha acabado para todos a la vez (si no, no hay reintento).
   */
  overGroup(normal: boolean) {
    G.Coop.againOpen(st => { if (G.Game.state === 'over') G.RunUI.setAgain(st); }, normal && !!G.Social.room);
  },
  /** Empieza la partida en grupo (el anfitrión la manda a todos): de hordas o, con mode 'td', de Defensa. */
  startCoop(cfg: CoopConfig) {
    // En 'over' (resumen de la partida anterior) se cierra el resumen como si se pulsara "volver" y se empieza.
    // En cualquier otro estado que no sea 'ui' (p. ej. 'playing') se ignora.
    if ((G.Game.state !== 'ui' && G.Game.state !== 'over') || !G.Social.room) return;
    // Otra partida desde el resumen (cfg.again) sin ti: has vuelto a la sala (o te has quedado fuera), no la miras.
    if (cfg.again && !G.Social.amSpec() && !cfg.members.some(m => m.uid === G.Social.uid)) {
      if (G.Game.state === 'over') G.RunUI.setAgain({ names: [], n: 0, of: 0, left: 1 });
      return;
    }
    if (G.Game.state === 'over') {
      // Como al pulsar "volver" (el modo recoge su partida), pero sin pasar por la sala (afterRun lo evita con `chaining`).
      chaining = true;
      try { document.getElementById('btn-again')!.click(); } finally { chaining = false; }
      if ((G.Game.state as string) !== 'ui') G.Game.toUI();
      G.UI.hide('scr-over');
    }
    G.LobbyUI.close();
    // Si en la sala elegiste sólo mirar (o no estás en el equipo), entras como espectador.
    if (G.Social.amSpec() || !cfg.members.some(m => m.uid === G.Social.uid)) { G.Spectate.startInRoom(cfg); return; }
    if (cfg.mode === 'td') G.Game.start('td', { coop: cfg });
    else G.Game.startRun(cfg);
  }
};
G.Flow = Flow;

declare module './g' {
  interface Registry { Game: typeof Game; Flow: typeof Flow }
}
