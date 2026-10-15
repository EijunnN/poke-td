import { G } from '../g';
/* ============ settings-ui.js — pantalla de Ajustes (PC y móvil) ============
 * Se abre por encima de lo que haya (menú o pausa) y al cerrar vuelve ahí.
 * Pestañas: Sonido · Gráficos · Controles · Cuenta · Acerca de.
 * Los ajustes son de este dispositivo (G.Settings / G.Audio en el navegador).
 */
/** Pantalla completa con el prefijo de Safari. */
type WebkitDoc = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> };
type WebkitEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

export const SettingsUI = (() => {
  const $ = G.UI.$;
  const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const VERSION = '1.2 · 2026-10-09';
  const REPO = 'https://github.com/EijunnN/poke-td';
  let tab = 'sound';

  function init() {
    document.querySelectorAll<HTMLElement>('#set-tabs .gen-tab').forEach(b => { b.onclick = () => { tab = b.dataset.t!; render(); }; });
    $('set-close').onclick = close;
    $('btn-settings').innerHTML = G.Icons.html('gear', 20);
    $('btn-settings').onclick = () => open();
    $('btn-pause-settings').onclick = () => open('sound');
    // Pantalla completa (si el navegador la permite; en iPhone, cómo conseguirla).
    if (canFull() || iosTip()) {
      $('btn-full').classList.remove('hidden');
      $('btn-full').innerHTML = G.Icons.html('full', 20);
      $('btn-full').onclick = toggleFull;
    }
  }

  function open(t?: string) {
    if (t) tab = t;
    $('scr-settings').classList.remove('hidden');
    render();
  }
  function close() { $('scr-settings').classList.add('hidden'); }
  const isOpen = () => !$('scr-settings').classList.contains('hidden');

  // ---------------- pantalla completa ----------------
  function canFull() { return !!(document.fullscreenEnabled || (document as WebkitDoc).webkitFullscreenEnabled); }
  function isFull() { return !!(document.fullscreenElement || (document as WebkitDoc).webkitFullscreenElement); }
  // iPhone: Safari no deja poner una web a pantalla completa (por eso a veces
  // no salía la opción). Sí se puede abriéndola desde la pantalla de inicio.
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => !!(navigator as Navigator & { standalone?: boolean }).standalone || (typeof window.matchMedia === 'function' && matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches);
  function iosTip() { return IOS && !canFull() && !standalone(); }
  const IOS_TIP = 'En iPhone, Safari no deja poner las webs a pantalla completa. Pulsa Compartir y luego "Añadir a pantalla de inicio": abriendo el juego desde ese icono se juega a pantalla completa.';
  function toggleFull() {
    if (!canFull()) { if (iosTip()) G.UI.toast(IOS_TIP, 9000); return; }
    if (isFull()) (document.exitFullscreen || (document as WebkitDoc).webkitExitFullscreen)!.call(document);
    else {
      const el = document.documentElement;
      const p = (el.requestFullscreen || (el as WebkitEl).webkitRequestFullscreen)!.call(el);
      // En móvil, además se intenta fijar la pantalla en horizontal.
      if (p && p.then) p.then(() => { try { (screen.orientation as ScreenOrientation & { lock(o: string): Promise<void> }).lock('landscape').catch(() => {}); } catch (e) { /* nada */ } }).catch(() => {});
    }
    setTimeout(() => { if (isOpen()) render(); }, 300);
  }

  // ---------------- piezas ----------------
  function section(title: string, sub?: string) { return `<h3 class="set-h">${esc(title)}</h3>${sub ? `<p class="sub">${sub}</p>` : ''}`; }
  function toggle(key: string, label: string, desc: string) {
    const on = !!G.Settings.get(key);
    return `<div class="set-row"><div class="grow"><b>${esc(label)}</b><small>${esc(desc)}</small></div>
      <button class="btn small switch ${on ? 'gold' : ''}" data-k="${key}">${on ? 'Sí' : 'No'}</button></div>`;
  }
  function choice(key: string, opts: [string | number, string][]) {
    const cur = G.Settings.get(key);
    return `<div class="chips set-chips">${opts.map(([v, l]) => `<button class="chip ${v === cur ? 'on' : ''}" data-k="${key}" data-v="${v}">${esc(l)}</button>`).join('')}</div>`;
  }

  function render() {
    document.querySelectorAll<HTMLElement>('#set-tabs .gen-tab').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
    const box = $('set-body');
    box.scrollTop = 0;
    if (tab === 'sound') {
      box.innerHTML = section('Sonido') + '<div id="set-sound" class="sound-inline"></div>';
      G.UI.soundControls($('set-sound'));
    } else if (tab === 'gfx') {
      const auto = ['baja', 'media', 'alta'][G.Settings.autoLevel];
      box.innerHTML = section('Idioma', 'El juego se recarga al cambiarlo.')
        + `<div class="chips set-chips" translate="no">${[['es', 'Español'], ['en', 'English']].map(([v, l]) =>
             `<button class="chip ${G.I18n.lang === v ? 'on' : ''}" data-lang="${v}">${l}</button>`).join('')}</div>`
        + section('Calidad', 'Cuántos efectos y partículas se dibujan. <b>Auto</b> la baja sola si el juego va a tirones (ahora: ' + auto + ').')
        + choice('quality', [['auto', 'Auto'], ['high', 'Alta'], ['mid', 'Media'], ['low', 'Baja']])
        + section('Resolución', '<b>Normal</b> dibuja menos píxeles: va más fluido en móviles y pantallas de alta densidad.')
        + choice('res', [['high', 'Alta'], ['normal', 'Normal']])
        + section('Pantalla')
        + toggle('dmgNumbers', 'Números de daño', 'Los números que salen al golpear y al recibir daño.')
        + toggle('calm', 'Menos sacudidas y destellos', 'La cámara tiembla menos y los fogonazos son suaves.')
        + toggle('fps', 'Mostrar FPS', 'Fotogramas por segundo, en la esquina de abajo.')
        + section('Chat', 'En las salas. Con <b>Sólo frases</b> ves las frases rápidas de los demás, pero no lo que escriben.')
        + choice('chat', [['all', 'Todo'], ['quick', 'Sólo frases'], ['off', 'Nada']])
        + toggle('chatFilter', 'Censurar palabrotas', 'Tacha palabrotas y enlaces en lo que ves tú (los demás lo ven como lo escribieron).')
        + (canFull() ? `<div class="set-row"><div class="grow"><b>Pantalla completa</b><small>Sin barras del navegador.</small></div>
             <button class="btn small" id="set-full">${isFull() ? 'Salir' : 'Activar'}</button></div>`
           : iosTip() ? `<div class="set-row"><div class="grow"><b>Pantalla completa</b><small>${esc(IOS_TIP)}</small></div></div>` : '');
    } else if (tab === 'ctl') {
      box.innerHTML = section('En móvil o tablet')
        + `<p class="sub">Pon el dedo en cualquier parte y arrastra para moverte: el joystick aparece donde tocas. Toca un ataque de abajo para cambiarlo y el botón de arriba a la derecha para pausar. Se juega en horizontal.</p>`
        + `<div class="set-row"><div class="grow"><b>Tamaño del joystick</b><small>Cuánto hay que arrastrar el dedo.</small></div></div>`
        + choice('stick', [[0.8, 'Pequeño'], [1, 'Normal'], [1.25, 'Grande']])
        + section('En PC')
        + `<div class="keys">
             <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> o flechas</div><span>moverse</span>
             <div><kbd>1</kbd>–<kbd>4</kbd> o clic en el icono</div><span>elegir ataque</span>
             <div><kbd>Q</kbd> / <kbd>E</kbd></div><span>ataque anterior / siguiente</span>
             <div><kbd>Esc</kbd> o <kbd>P</kbd></div><span>pausa</span>
             <div><kbd>1</kbd>–<kbd>3</kbd></div><span>elegir carta al subir de nivel</span>
             <div><kbd>Enter</kbd> o <kbd>T</kbd></div><span>chat (en una sala)</span>
             <div><kbd>V</kbd>, luego <kbd>1</kbd>–<kbd>8</kbd></div><span>frases rápidas</span>
             <div><kbd>Alt</kbd> + clic</div><span>señal en el mapa (en grupo)</span>
           </div>`;
    } else if (tab === 'acc') {
      renderAccount(box);
    } else {
      box.innerHTML = `<div class="about-logo">PokéSurvivor</div><p class="sub center">Versión ${esc(VERSION)}</p>`
        + `<p class="sub">Juego de fans <b>gratuito y sin ánimo de lucro</b>: sin anuncios ni compras. Pokémon y sus personajes son propiedad de Nintendo, Creatures y GAME FREAK; este proyecto no está afiliado a ellos.</p>`
        + section('Créditos')
        + `<ul class="credits">
             <li><b>Sprites:</b> PMD SpriteCollab y sus artistas (CC BY-NC 4.0).</li>
             <li><b>Datos de los Pokémon:</b> PokéAPI.</li>
             <li><b>Música y sonidos:</b> originales, generados por el propio juego.</li>
             <li><b>Fuente:</b> Pixelify Sans (OFL).</li>
           </ul>`
        + `<div class="row wrap" style="justify-content:center;gap:8px">
             <button class="btn small" data-guide>Cómo se juega</button>
             <button class="btn small" data-legal>Aviso legal y privacidad</button>
             <a class="btn small" href="${REPO}/issues" target="_blank" rel="noopener">Contacto</a>
             <a class="btn small" href="${REPO}" target="_blank" rel="noopener">Código (GitHub)</a>
           </div>`;
    }
    wire(box);
  }

  function renderAccount(box: HTMLElement) {
    const st = G.DB.guest ? 'guest' : G.DB.syncState;
    const SYNC: Record<string, string> = { ok: 'Guardado en la nube', syncing: 'Guardando…', pending: 'Pendiente de subir (se sube al salir del juego)',
                   offline: 'Sin conexión: se subirá al volver', local: 'Guardado sólo en este navegador', guest: 'Invitado: no se guarda' };
    if (G.DB.guest) {
      box.innerHTML = section('Cuenta', 'Estás jugando como <b>invitado</b>: tu progreso no se guarda al salir.')
        + `<button class="btn gold" id="set-login">Crear cuenta o entrar</button>`;
      return;
    }
    const nick = G.Social.me ? G.Social.me.name : (G.DB.user || '');
    const kind = G.DB.mode === 'local' ? 'Cuenta de este navegador' : 'Nombre y contraseña';
    box.innerHTML = section('Cuenta')
      + `<div class="set-row"><div class="grow"><b>Apodo</b><small>Es único y no se puede cambiar.</small></div><span class="gold" translate="no">${esc(nick)}</span></div>`
      + `<div class="set-row"><div class="grow"><b>Tipo de cuenta</b></div><span>${esc(kind)}</span></div>`
      + `<div class="set-row"><div class="grow"><b>Partida</b></div><span>${esc(SYNC[st] || st)}</span></div>`
      + `<div class="row wrap" style="gap:8px;margin-top:12px">
           <button class="btn" id="set-pass">Cambiar contraseña</button>
           <button class="btn" id="set-logout">Cerrar sesión</button>
           <button class="btn danger" id="set-delete">Borrar cuenta</button>
         </div><p class="note" id="set-msg"></p>`;
  }

  function wire(box: HTMLElement) {
    box.querySelectorAll<HTMLElement>('.switch[data-k]').forEach(b => { b.onclick = () => { G.Settings.set(b.dataset.k!, !G.Settings.get(b.dataset.k!)); render(); }; });
    box.querySelectorAll<HTMLElement>('.chip[data-k]').forEach(b => {
      b.onclick = () => { const v = b.dataset.v!; G.Settings.set(b.dataset.k!, isNaN(+v) ? v : +v); render(); };
    });
    const full = $<HTMLButtonElement>('set-full'); if (full) full.onclick = toggleFull;
    box.querySelectorAll<HTMLElement>('[data-guide]').forEach(b => { b.onclick = () => G.GuideUI.open(); });
    box.querySelectorAll<HTMLElement>('[data-lang]').forEach(b => { b.onclick = () => { if (b.dataset.lang !== G.I18n.lang) G.I18n.set(b.dataset.lang!); }; });
    const lo = $<HTMLButtonElement>('set-login'); if (lo) lo.onclick = () => { close(); leave(); };
    const out = $<HTMLButtonElement>('set-logout'); if (out) out.onclick = () => { close(); leave(); };
    const pw = $<HTMLButtonElement>('set-pass');
    if (pw) pw.onclick = async () => {
      if (await askNewPassword()) { $('set-msg').textContent = G.T('Contraseña cambiada.'); G.UI.toast('Contraseña cambiada'); }
    };
    const del = $<HTMLButtonElement>('set-delete');
    if (del) del.onclick = async () => {
      const ok = await G.UI.confirmDelete();
      if (!ok) return;
      del.disabled = true;
      const r = await G.DB.deleteAccount(ok.pass);
      if (!r.ok) { $('set-msg').textContent = r.error || ''; del.disabled = false; return; }
      close();
      G.UI.toast('Cuenta borrada');
      G.Audio.music(null);
      G.Flow.toLogin();
    };
  }

  /**
   * Ventana para cambiar la contraseña: la actual y la nueva dos veces.
   * @returns true si se ha cambiado
   */
  function askNewPassword() {
    return new Promise<boolean>(done => {
      const el = document.createElement('section');
      el.className = 'scr dim';
      el.style.zIndex = '70';
      el.innerHTML = `<form class="box" style="max-width:380px;width:100%" autocomplete="off">
        <h3>Cambiar contraseña</h3>
        <label>Contraseña actual</label>
        <input class="field" type="password" maxlength="64" autocomplete="current-password" name="old" style="width:100%">
        <label>Contraseña nueva</label>
        <input class="field" type="password" maxlength="64" autocomplete="new-password" name="pass" style="width:100%">
        <label>Repite la nueva</label>
        <input class="field" type="password" maxlength="64" autocomplete="new-password" name="pass2" style="width:100%">
        <p class="err" data-err></p>
        <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end;flex-wrap:wrap">
          <button class="btn ghost" type="button" data-a="no">Cancelar</button>
          <button class="btn gold" type="submit">Cambiar contraseña</button>
        </div></form>`;
      document.body.appendChild(el);
      const form = el.querySelector('form')!, err = el.querySelector<HTMLElement>('[data-err]')!;
      const val = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value;
      el.querySelector<HTMLElement>('[data-a=no]')!.onclick = () => { el.remove(); done(false); };
      form.onsubmit = async e => {
        e.preventDefault();
        if (val('pass') !== val('pass2')) { err.textContent = G.T('Las dos contraseñas nuevas no coinciden.'); return; }
        const ok = el.querySelector<HTMLButtonElement>('[type=submit]')!;
        ok.disabled = true;
        const r = await G.DB.changePassword(val('old'), val('pass'));
        ok.disabled = false;
        if (!r.ok) { err.textContent = r.error || ''; return; }
        el.remove(); done(true);
      };
      (form.elements.namedItem('old') as HTMLInputElement).focus();
    });
  }

  /** Cerrar sesión (si estás en una partida, se abandona). */
  function leave() {
    if (G.DB.guest && !confirm('Eres invitado: se perderá todo el progreso. ¿Salir?')) return;
    if (G.Game.state !== 'ui') G.Game.quit && G.Game.quit();
    G.Audio.music(null);
    G.DB.logout().then(() => G.Flow.toLogin());
  }

  return { init, open, close, get isOpen() { return isOpen(); } };
})();
G.SettingsUI = SettingsUI;

declare module '../g' {
  interface Registry { SettingsUI: typeof SettingsUI }
}
