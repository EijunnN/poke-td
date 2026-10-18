import { G } from '../g';
import type { ChatMsg } from '../net/chat';
/* ============ chat-ui.ts — lo que se ve del chat (la lógica, en net/chat.ts) ============
 * Pensado para no tapar la partida, en PC y en móvil:
 *   - Botón pequeño (arriba a la derecha) con un punto si hay mensajes sin leer.
 *   - Los mensajes nuevos salen como líneas finas que se apagan solas (no reciben
 *     toques: el joystick sigue funcionando debajo) y se colocan donde no tapen la
 *     tienda, el panel ni el minimapa de la Defensa. Además, bocadillo sobre el héroe.
 *   - Panel con la conversación, las frases rápidas y el campo de texto: Enter o T (o el
 *     botón) lo abre ya para escribir, y Enter envía y lo cierra; en móvil va pegado
 *     arriba para que el teclado no lo tape. En el lobby, Enter lleva al chat de la sala.
 *   - V: sólo las frases rápidas, numeradas (1-8 las manda sin escribir).
 *   - En el lobby, el chat va dentro de la pantalla de la sala.
 * Tocar el nombre de alguien lo silencia (y otra vez, lo vuelve a oír).
 *
 * Al lado, en partida, el botón 📍: arma el siguiente toque en el mapa como señal para
 * los demás (net/ping.ts; con ratón, Alt + clic lo hace directamente).
 */
export const ChatUI = (() => {
  const FEED_MS = 7000, FEED_MAX = 4;
  let btn: HTMLButtonElement, pingBtn: HTMLButtonElement, feed: HTMLElement, panel: HTMLElement, quickPop: HTMLElement;
  let built = false, open = false, quickOpen = false, unread = false;
  const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

  // ---------------- piezas comunes ----------------

  /** Color de cada jugador (el de la partida en grupo: el orden de la sala). */
  function colorOf(uid: string): string {
    const r = G.Social.room || (G.Social.watching && G.Social.watching.room);
    const i = r ? r.members.findIndex(m => m.uid === uid) : -1;
    return i >= 0 ? G.Coop.COLORS[i % G.Coop.COLORS.length] : '#c9d4ea';
  }
  function lineHtml(m: ChatMsg, clickable: boolean) {
    const name = `<span class="chat-name" style="color:${colorOf(m.f)}" translate="no"${clickable && !G.Chat.mine(m) ? ` data-uid="${esc(m.f)}" data-name="${esc(m.n)}" role="button"` : ''}>${esc(m.n)}</span>`;
    return `${name}<span class="chat-sep">:</span> <span class="chat-text${m.q ? ' chat-said' : ''}" translate="no">${esc(G.Chat.textOf(m))}</span>`;
  }
  /** La conversación en una caja (panel o lobby), con el último abajo. */
  function renderLog(box: HTMLElement) {
    const ms = G.Chat.visible();
    box.innerHTML = ms.length ? ms.map(m => `<div class="chat-line">${lineHtml(m, true)}</div>`).join('')
      : `<p class="sub chat-empty">${G.Chat.mode() === 'quick' ? 'Sólo ves las frases rápidas (Ajustes → Chat).' : 'Aún no ha escrito nadie.'}</p>`;
    box.scrollTop = box.scrollHeight;
  }
  /** Tocar un nombre: silenciar o volver a oír. */
  function wireNames(box: HTMLElement) {
    box.onclick = e => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-uid]');
      if (!el) return;
      const uid = el.dataset.uid!, name = el.dataset.name || '';
      const now = !G.Chat.isMuted(uid);
      G.Chat.setMuted(uid, now);
      G.UI.toast(now ? G.I18n.f('Has silenciado a {x}', name) : G.I18n.f('Vuelves a ver lo que escribe {x}', name), 2600);
    };
  }
  /** Chips de frases rápidas (con su número en PC). */
  function quickHtml(numbers: boolean) {
    return G.Chat.QUICK.map((q, i) => `<button type="button" class="chip chat-q" data-q="${q.id}">${numbers ? `<kbd>${i + 1}</kbd> ` : ''}${esc(G.I18n.lang === 'en' ? q.en : q.es)}</button>`).join('');
  }
  function wireQuick(box: HTMLElement, after?: () => void) {
    box.querySelectorAll<HTMLButtonElement>('[data-q]').forEach(b => {
      b.onclick = () => { G.Chat.quick(b.dataset.q!); G.Audio.sfx('confirm'); after && after(); };
    });
  }
  /** Campo de texto + enviar. */
  function formHtml() {
    return `<form class="chat-form"><input class="field" maxlength="${G.Chat.MAX}" placeholder="Escribe un mensaje…" autocomplete="off" enterkeyhint="send" spellcheck="false">
      <button class="btn small gold" type="submit">Enviar</button></form>`;
  }
  function wireForm(box: HTMLElement, after?: () => void) {
    const form = box.querySelector('form')!, inp = form.querySelector('input')!;
    form.onsubmit = e => {
      e.preventDefault();
      const t = inp.value.trim();
      if (!t) { after && after(); return; }
      G.Chat.send(t).then(ok => { if (ok) inp.value = ''; });
      after && after();
    };
    inp.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); inp.blur(); after && after(); } e.stopPropagation(); };
  }

  // ---------------- en partida y menús: botón, líneas y panel ----------------

  function build() {
    if (built) return;
    built = true;
    const s = document.createElement('style');
    s.textContent = `
      #chat-btn { position: fixed; top: 10px; right: 64px; z-index: 40; width: 38px; height: 38px; border-radius: 12px;
        border: 2px solid rgba(255,255,255,.85); background: rgba(16,28,64,.78); color: #fff; display: grid; place-items: center;
        cursor: pointer; padding: 0; }
      #chat-btn svg { width: 22px; height: 22px; }
      #ping-btn { position: fixed; top: 10px; right: 110px; z-index: 40; width: 38px; height: 38px; border-radius: 12px;
        border: 2px solid rgba(255,255,255,.85); background: rgba(16,28,64,.78); color: #fff; display: grid; place-items: center;
        cursor: pointer; padding: 0; }
      #ping-btn svg { width: 20px; height: 20px; }
      #ping-btn.armed { background: #ffd23f; color: #10204a; border-color: #fff; box-shadow: 0 0 0 3px rgba(255,210,63,.45); }
      #chat-btn .dot { position: absolute; top: -3px; right: -3px; width: 10px; height: 10px; border-radius: 50%; background: #ffd23f;
        border: 2px solid #102040; display: none; }
      #chat-btn.unread .dot { display: block; }
      #chat-feed { position: fixed; z-index: 35; pointer-events: none; display: flex; flex-direction: column; gap: 3px;
        max-width: min(340px, 34vw); }
      #chat-feed.right { align-items: flex-end; }
      #chat-feed .chat-line { background: rgba(10,18,40,.62); color: #fff; border-radius: 8px; padding: 2px 8px; font-size: 13px;
        line-height: 1.35; transition: opacity .6s; overflow-wrap: anywhere; text-shadow: 0 1px 0 #000; }
      #chat-feed .chat-line.out { opacity: 0; }
      .chat-name { font-weight: 700; }
      .chat-name[role=button] { cursor: pointer; }
      .chat-text.chat-said { color: #ffe08a; }
      .chat-panel { position: fixed; z-index: 45; left: 12px; bottom: 12px; width: min(360px, calc(100vw - 24px)); padding: 10px;
        display: flex; flex-direction: column; gap: 8px; }
      .chat-head { display: flex; align-items: center; gap: 6px; }
      .chat-head .grow { flex: 1; }
      .chat-log { max-height: 30vh; overflow-y: auto; font-size: 14px; line-height: 1.4; display: flex; flex-direction: column; gap: 2px;
        overflow-wrap: anywhere; }
      .chat-quick { display: flex; flex-wrap: wrap; gap: 5px; }
      .chat-quick .chip { font-size: 12px; padding: 3px 8px; }
      .chat-quick kbd { font-size: 10px; padding: 0 3px; }
      .chat-form { display: flex; gap: 6px; }
      .chat-form .field { flex: 1; min-width: 0; }
      #chat-quickpop { position: fixed; z-index: 45; left: 12px; bottom: 12px; padding: 8px; max-width: min(520px, calc(100vw - 24px)); }
      .chat-empty { margin: 0; }
      /* Móvil: el teclado tapa la mitad de abajo; el panel, arriba y más bajito. */
      @media (pointer: coarse), (max-height: 520px) {
        .chat-panel { top: 6px; bottom: auto; left: 50%; transform: translateX(-50%); width: min(460px, calc(100vw - 16px)); padding: 8px; gap: 6px; }
        .chat-log { max-height: 22vh; font-size: 13px; }
        #chat-btn { top: 8px; right: 58px; width: 36px; height: 36px; }
        #ping-btn { top: 8px; right: 100px; width: 36px; height: 36px; }
        #chat-feed { max-width: min(300px, 32vw); }
        #chat-feed .chat-line { font-size: 12px; }
      }
      /* El lobby lleva el chat dentro. */
      .lobby-chat { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
      .lobby-chat .chat-log { max-height: 120px; min-height: 48px; background: rgba(0,0,0,.18); border-radius: 8px; padding: 6px 8px; }
    `;
    document.head.appendChild(s);

    btn = document.createElement('button');
    btn.id = 'chat-btn';
    btn.title = 'Chat (Enter o T) · frases rápidas (V)';
    btn.setAttribute('aria-label', 'Chat');
    // Bocadillo redondeado con tres puntos (el de antes, un cuadrado de trazo, parecía una ventana).
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3.5c-5 0-9 3.3-9 7.4 0 2.3 1.2 4.3 3.1 5.7-.2 1.4-.9 2.8-2 3.9 2.1-.1 4-.9 5.4-2.1.8.2 1.6.3 2.5.3 5 0 9-3.3 9-7.8s-4-7.4-9-7.4z"/><g fill="#1b2a4a"><circle cx="8" cy="11" r="1.5"/><circle cx="12" cy="11" r="1.5"/><circle cx="16" cy="11" r="1.5"/></g></svg><span class="dot"></span>`;
    btn.onclick = () => (open ? close() : openPanel(false));
    btn.addEventListener('pointerdown', e => e.stopPropagation());

    pingBtn = document.createElement('button');
    pingBtn.id = 'ping-btn';
    pingBtn.title = 'Señal en el mapa (o Alt + clic)';
    pingBtn.setAttribute('aria-label', 'Señal en el mapa');
    pingBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M12 21s-6-6.2-6-11a6 6 0 0 1 12 0c0 4.8-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>`;
    pingBtn.onclick = () => {
      const v = !G.Pings.armed;
      G.Pings.setArmed(v);
      if (v) G.UI.toast(G.Touch.active ? 'Toca el mapa donde quieras marcar' : 'Haz clic en el mapa donde quieras marcar (Alt + clic, sin botón)', 2400);
    };
    pingBtn.addEventListener('pointerdown', e => e.stopPropagation());
    G.Pings.onArmed(v => pingBtn.classList.toggle('armed', v));

    feed = document.createElement('div');
    feed.id = 'chat-feed';

    panel = document.createElement('div');
    panel.id = 'chat-panel';
    panel.className = 'box chat-panel hidden';
    panel.addEventListener('pointerdown', e => e.stopPropagation());

    quickPop = document.createElement('div');
    quickPop.id = 'chat-quickpop';
    quickPop.className = 'box hidden';
    quickPop.addEventListener('pointerdown', e => e.stopPropagation());

    document.body.append(feed, btn, pingBtn, panel, quickPop);
    setInterval(sync, 400);
    sync();
  }

  /** El lobby tiene su propio chat dentro. */
  const lobbyOpen = () => G.UI.isOpen('scr-lobby');
  /** Botón y líneas: con sala (o mirando), con el chat activado y fuera del lobby. */
  function sync() {
    const on = G.Chat.available() && !lobbyOpen();
    btn.style.display = on ? '' : 'none';
    const pingOn = G.Pings.available() && !lobbyOpen();
    pingBtn.style.display = pingOn ? '' : 'none';
    if (!pingOn && G.Pings.armed) G.Pings.setArmed(false);
    btn.classList.toggle('unread', unread);
    feed.style.display = on && !open ? '' : 'none';
    if (!on && (open || quickOpen)) close();
    if (on && feed.childElementCount) place();
  }

  function openPanel(focus: boolean) {
    quickPop.classList.add('hidden'); quickOpen = false;
    open = true; unread = false;
    panel.innerHTML = `<div class="chat-head"><b>Chat</b><span class="grow"></span>${mutedBtn()}
        <button class="btn small ghost" data-x type="button">Cerrar</button></div>
      <div class="chat-log"></div>
      <div class="chat-quick">${quickHtml(false)}</div>
      ${formHtml()}`;
    panel.classList.remove('hidden');
    renderLog(panel.querySelector('.chat-log')!);
    wireNames(panel.querySelector('.chat-log')!);
    wireQuick(panel, close);
    wireForm(panel, close);
    panel.querySelector<HTMLElement>('[data-x]')!.onclick = close;
    const mb = panel.querySelector<HTMLElement>('[data-unmute]');
    if (mb) mb.onclick = () => { unmuteAll(); openPanel(false); };
    if (focus) panel.querySelector('input')!.focus();
    sync();
  }
  /** "Silenciados (n)": vuelve a oírlos a todos. */
  function mutedBtn() {
    const n = mutedCount();
    return n ? `<button class="btn small ghost" data-unmute type="button">${G.I18n.f('Silenciados ({x}): quitar', n)}</button>` : '';
  }
  function mutedRoom() {
    const r = G.Social.room || (G.Social.watching && G.Social.watching.room);
    return r ? [...r.members.map(m => m.uid), ...(r.watchers || []).map(w => w.uid)].filter(u => G.Chat.isMuted(u)) : [];
  }
  const mutedCount = () => mutedRoom().length;
  function unmuteAll() { for (const u of mutedRoom()) G.Chat.setMuted(u, false); }

  function openQuick() {
    if (open) close();
    quickOpen = true;
    quickPop.innerHTML = `<div class="chat-quick">${quickHtml(!G.Touch.active)}</div>`;
    quickPop.classList.remove('hidden');
    wireQuick(quickPop, close);
  }
  function close() {
    open = false; quickOpen = false;
    if (built) {
      const inp = panel.querySelector('input');
      if (inp && document.activeElement === inp) inp.blur();
      panel.classList.add('hidden'); quickPop.classList.add('hidden');
      sync();
    }
  }

  /** Una línea nueva abajo, que se apaga sola. */
  function pushFeed(m: ChatMsg) {
    const el = document.createElement('div');
    el.className = 'chat-line';
    el.innerHTML = lineHtml(m, false);
    feed.appendChild(el);
    while (feed.childElementCount > FEED_MAX) feed.firstElementChild!.remove();
    setTimeout(() => el.classList.add('out'), FEED_MS);
    setTimeout(() => el.remove(), FEED_MS + 700);
    place();
  }

  /**
   * Dónde van las líneas: el primer sitio que no pise nada de la pantalla (la tienda, el panel,
   * el minimapa y la barra de la Defensa; el botón del chat). Abajo a la izquierda, si no
   * a la derecha (arriba, o bajo la barra de la Defensa), si no arriba a la izquierda.
   */
  function place() {
    const SPOTS: Partial<CSSStyleDeclaration>[] = [
      { left: '12px', bottom: '14px', top: 'auto', right: 'auto' },
      { right: '12px', top: '56px', left: 'auto', bottom: 'auto' },
      // (en el móvil, la barra de la Defensa baja hasta ~105 px)
      { right: '12px', top: '112px', left: 'auto', bottom: 'auto' },
      { right: '12px', top: '160px', left: 'auto', bottom: 'auto' },
      { left: '12px', top: '64px', right: 'auto', bottom: 'auto' },
    ];
    const blocks = ['td-shop', 'td-panel', 'td-map', 'td-bar', 'td-hud', 'chat-btn', 'ping-btn', 'td-tip']
      // (offsetParent no sirve: con position: fixed siempre es null.)
      .map(id => document.getElementById(id)).filter((el): el is HTMLElement => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
      .map(el => el.getBoundingClientRect());
    const hits = (a: DOMRect) => blocks.some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
    for (const s of SPOTS) {
      Object.assign(feed.style, s);
      feed.classList.toggle('right', s.right === '12px');
      if (!hits(feed.getBoundingClientRect())) return;
    }
    Object.assign(feed.style, SPOTS[0]);
    feed.classList.remove('right');
  }

  // ---------------- lobby ----------------

  function renderLobby() {
    const box = document.getElementById('lobby-chat');
    if (!box) return;
    const on = G.Chat.available();
    box.classList.toggle('hidden', !on);
    if (!on) return;
    if (!box.dataset.built) {
      box.dataset.built = '1';
      box.innerHTML = `<div class="chat-log"></div><div class="chat-quick">${quickHtml(false)}</div>${formHtml()}`;
      wireNames(box.querySelector('.chat-log')!);
      wireQuick(box);
      wireForm(box);
    }
    renderLog(box.querySelector('.chat-log')!);
  }

  // ---------------- teclas (PC) ----------------

  addEventListener('keydown', e => {
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
    if (!built || e.ctrlKey || e.metaKey || e.altKey) return;
    const enter = e.code === 'Enter' || e.code === 'NumpadEnter';
    // Lobby: Enter lleva al chat de la sala (si no hay un botón elegido con el teclado).
    if (enter && lobbyOpen() && G.Chat.available() && (!el || el === document.body)) {
      const inp = document.querySelector<HTMLInputElement>('#lobby-chat input');
      if (inp) { e.preventDefault(); inp.focus(); }
      return;
    }
    if (btn.style.display === 'none') return;
    // En partida, Enter abre el chat salvo que Enter ya sirva para algo: plantar la torre que
    // llevas (Defensa), saltar la Sentencia, o pantallas de cartas, pausa o vínculo.
    if (enter) {
      const busy = G.Game.state !== 'playing' || (G.TD.placing && G.Run.mode && G.Run.mode.id === 'td') || G.Judgment.cinematic
        || (el && el !== document.body && el.tagName === 'BUTTON');
      if (!busy && !open) { e.preventDefault(); e.stopImmediatePropagation(); openPanel(true); }
      return;
    }
    // Con las frases a la vista, los números las mandan (y no cambian de ataque).
    if (quickOpen && /^Digit[1-8]$/.test(e.code)) {
      const q = G.Chat.QUICK[+e.code.slice(5) - 1];
      if (q) { G.Chat.quick(q.id); G.Audio.sfx('confirm'); }
      close(); e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    if (e.code === 'Escape' && (open || quickOpen)) { close(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.code === 'Escape' && G.Pings.armed) { G.Pings.setArmed(false); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.code === 'KeyT') { e.preventDefault(); e.stopImmediatePropagation(); openPanel(true); return; }
    if (e.code === 'KeyV') { e.preventDefault(); e.stopImmediatePropagation(); quickOpen ? close() : openQuick(); }
  }, true);

  // ---------------- mensajes ----------------

  G.Chat.on(m => {
    if (!built) return;
    if (m) {
      if (open) renderLog(panel.querySelector('.chat-log')!);
      else if (!lobbyOpen()) { pushFeed(m); if (!G.Chat.mine(m)) unread = true; }
    } else if (open) openPanel(false);
    renderLobby();
    sync();
  });
  G.Social.on(() => { if (built) { renderLobby(); sync(); } });
  G.Settings.on(k => { if ((k === 'chat' || k === 'chatFilter') && built) { renderLobby(); sync(); } });

  return { build, renderLobby, open: () => openPanel(true), close };
})();
G.ChatUI = ChatUI;
ChatUI.build();

declare module '../g' {
  interface Registry { ChatUI: typeof ChatUI }
}
