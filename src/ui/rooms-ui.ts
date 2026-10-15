import { G } from '../g';
/* ============ rooms-ui.ts — la lista de salas públicas ============
 * Las salas que sus anfitriones han hecho públicas (net/social.ts, listRooms): de qué son
 * (Survivor o Defensa, y el mapa), cuántos juegan y si ya han empezado. Si esperan gente,
 * "Unirse" te mete en la sala (sin invitación); si ya juegan, "Mirar" te deja ver la partida
 * como espectador (net/spectate.ts). Se actualiza sola mientras está abierta.
 */
export const RoomsUI = (() => {
  const $ = G.UI.$;
  const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  let filter: 'all' | 'survivor' | 'td' = 'all';
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  function init() {
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

  return { init, open, load };
})();
G.RoomsUI = RoomsUI;

declare module '../g' {
  interface Registry { RoomsUI: typeof RoomsUI }
}
