import { G } from '../g';
/* ============ rooms-ui.ts — la lista de salas públicas ============
 * Las salas que sus anfitriones han hecho públicas (net/social.ts, listRooms): de qué son
 * (Survivor o Defensa, y el mapa), cuántos juegan y si ya han empezado. Si esperan gente,
 * "Unirse" te mete en la sala (sin invitación); si ya juegan, "Mirar" te deja ver la partida
 * como espectador (net/spectate.ts). Se actualiza sola mientras está abierta.
 *
 * Arriba, "Entrar con código": el código de cualquier sala (también privada; vale de invitación).
 * Los enlaces /s/<código> llegan como /?sala=<código> (server/index.ts, roomLink): al abrir el
 * juego se guarda y, en cuanto hay sesión con cuenta, se entra en esa sala (takeLink, desde el menú).
 */
export const RoomsUI = (() => {
  const $ = G.UI.$;
  const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  let filter: 'all' | 'survivor' | 'td' = 'all';
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  // ¿Se abrió el juego desde el enlace de una sala? Se guarda (por si hay que iniciar sesión antes) y se quita de la barra.
  const K_LINK = 'ps.sala';
  let linked: string | null = null, told = false;
  try {
    const q = new URLSearchParams(location.search).get('sala');
    if (q && /^[A-Za-z0-9-]{4,12}$/.test(q)) {
      sessionStorage.setItem(K_LINK, q.toUpperCase());
      const u = new URL(location.href); u.searchParams.delete('sala');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
    linked = sessionStorage.getItem(K_LINK);
  } catch { /* sin sessionStorage: el enlace no se recuerda */ }

  /** Entra en la sala de un código (escrito o de un enlace), pidiendo el apodo si hace falta. */
  function joinCode(code: string, done?: (ok: boolean) => void) {
    G.Social.start().then(st => {
      const go = async () => {
        const r = await G.Social.joinByCode(code);
        done?.(r.ok);
        if (r.ok) G.LobbyUI.open(); else G.UI.toast(r.error || 'No se pudo entrar.', 3200);
      };
      if (st === 'ok') go(); else if (st === 'need-nick') G.NickUI.open(go); else done?.(false);
    });
  }

  /** Desde el menú: si el juego se abrió con el enlace de una sala, entra en ella (con cuenta; si no, avisa). */
  function takeLink() {
    if (!linked) return;
    if (!G.DB.online) {
      if (!told) { told = true; G.UI.toast(G.I18n.f('Para entrar en la sala {x}, inicia sesión con tu cuenta (o crea una).', linked), 6000); }
      return;
    }
    const code = linked;
    linked = null;
    try { sessionStorage.removeItem(K_LINK); } catch { /* nada */ }
    if (G.Social.room && G.Social.room.code === code) { G.LobbyUI.open(); return; }
    joinCode(code);
  }

  function init() {
    $('rooms-code').onsubmit = (e: Event) => {
      e.preventDefault();
      const inp = $<HTMLInputElement>('rooms-code-in');
      const code = inp.value.trim();
      if (!code) return;
      if (!G.SocialUI.needOnline()) return;
      const btn = $('rooms-code').querySelector('button')!;
      btn.disabled = true;
      joinCode(code, ok => { btn.disabled = false; if (ok) inp.value = ''; });
    };
    $('rooms-refresh').onclick = () => load();
    // Tu propia sala: si ya tienes una, a ella; si no, se crea pública (para que otros la vean aquí).
    $('rooms-create').onclick = async () => {
      if (G.Social.watching) return;
      if (!G.Social.room) {
        const r = await G.Social.createRoom();
        if (!r) { G.UI.toast('No se pudo crear la sala.', 2600); return; }
        const g = G.LobbyUI.game;
        G.Social.setPublic(true, g.mode === 'td' ? 'td' : 'survivor', g.map);
      }
      G.LobbyUI.open();
    };
  }

  function open() {
    if (!G.SocialUI.needOnline()) return;
    if (!G.Social.started) G.Social.start();
    G.UI.show('scr-rooms', true);
    paintFilter();
    load();
    if (timer) clearInterval(timer);
    // Mientras está abierta, cada pocos segundos (para ver quién empieza o se llena).
    timer = setInterval(() => { if (G.UI.isOpen('scr-rooms')) load(); else { clearInterval(timer!); timer = null; } }, 5000);
  }

  function paintFilter() {
    const box = $('rooms-filter');
    box.innerHTML = '';
    for (const [k, label] of [['all', 'Todas'], ['survivor', 'Survivor'], ['td', 'Defensa']] as const) {
      const b = document.createElement('button');
      b.className = 'chip' + (filter === k ? ' on' : '');
      b.textContent = label;
      b.onclick = () => { filter = k; paintFilter(); load(); };
      box.appendChild(b);
    }
  }

  const mapName = (id: string) => (G.TD_MAPS.find(m => m.id === id) || { name: 'Al azar' }).name;

  async function load() {
    if (busy) return;
    busy = true;
    const list = $('rooms-list');
    try {
      const rooms = (await G.Social.listRooms()).filter(r => filter === 'all' || r.mode === filter);
      if (!G.UI.isOpen('scr-rooms')) return;
      list.innerHTML = rooms.length ? '' : '<p class="sub" style="margin:0">No hay salas públicas ahora mismo. Crea la tuya con «Crear sala pública».</p>';
      $('rooms-create').textContent = G.Social.room ? 'Ir a tu sala' : 'Crear sala pública';
      $('rooms-note').textContent = G.Social.room ? 'Ya estás en una sala: al unirte a otra, sales de la tuya. Para mirar una partida, sal antes de tu sala.' : '';
      for (const r of rooms) {
        const el = document.createElement('div');
        el.className = 'fr-row rooms-row';
        const what = r.mode === 'td' ? 'Defensa · ' + esc(mapName(r.map)) : 'Survivor';
        const state = r.started ? 'Jugando' + (r.watchers ? ' · ' + r.watchers + ' mirando' : '') : 'En la sala';
        el.innerHTML = `<i class="dot ${r.started ? 'play' : 'on'}"></i><b translate="no">${esc(r.hostName)}</b>
          <span class="st">${what} · ${r.n}/${r.max} · ${state}</span><span class="grow"></span>`;
        const b = document.createElement('button');
        if (!r.started) {
          b.className = 'btn small gold';
          b.textContent = 'Unirse';
          b.disabled = r.n >= r.max;
          if (r.n >= r.max) b.textContent = 'Llena';
          b.onclick = async () => {
            b.disabled = true;
            const res = await G.Social.joinRoom(r.id);
            if (res.ok) G.LobbyUI.open(); else { G.UI.toast(res.error || 'No se pudo entrar.', 2600); load(); }
          };
        } else {
          b.className = 'btn small';
          b.textContent = 'Mirar';
          b.onclick = async () => { b.disabled = true; if (!(await G.Spectate.start(r.id))) load(); };
        }
        el.appendChild(b);
        list.appendChild(el);
      }
    } finally { busy = false; }
  }

  return { init, open, load, takeLink };
})();
G.RoomsUI = RoomsUI;

declare module '../g' {
  interface Registry { RoomsUI: typeof RoomsUI }
}
