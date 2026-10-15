import { G } from '../g';
import type { Friend, Invite, Member, Room } from '../net/social';
import type { CoopConfig } from '../net/coop';
/* ============ social-ui.js — apodo, amigos, sala e invitaciones ============ */
  const $ = G.UI.$;
  const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

  /** ¿Se puede usar lo online? Si no, explica por qué. */
  function needOnline() {
    if (G.DB.online) return true;
    G.UI.toast(G.DB.guest ? 'Crea una cuenta para jugar con amigos y salir en el ranking.'
      : 'Esto necesita la versión online del juego (con la nube).', 3200);
    return false;
  }

  // ======================= APODO =======================

  export const NickUI = (() => {
    let then: (() => void) | null = null, skipped = false;

    function init() {
      $('nick-form').onsubmit = async (e: Event) => {
        e.preventDefault();
        $('nick-err').textContent = '';
        $<HTMLButtonElement>('nick-ok').disabled = true;
        const r = await G.Social.claimNick($<HTMLInputElement>('nick-in').value);
        $<HTMLButtonElement>('nick-ok').disabled = false;
        if (!r.ok) { $('nick-err').textContent = r.error || ''; G.Audio.sfx('error'); return; }
        G.Audio.sfx('confirm');
        G.UI.toast('Tu apodo es ' + G.Social.me!.name);
        const cb = then; then = null;
        if (cb) cb(); else G.MenuUI.open();
      };
      $('nick-later').onclick = () => { skipped = true; then = null; G.MenuUI.open(); };
    }

    /** @param next  qué abrir después de elegirlo */
    function open(next?: () => void) {
      then = next || null;
      G.UI.show('scr-nick');
      $('nick-err').textContent = '';
      $<HTMLInputElement>('nick-in').value = '';
      setTimeout(() => $<HTMLInputElement>('nick-in').focus(), 50);
    }

    return { init, open, get skipped() { return skipped; } };
  })();
  G.NickUI = NickUI;

  /** Abre `fn` si tienes apodo; si no, pide el apodo primero. */
  function withNick(fn: () => void) {
    if (!needOnline()) return;
    if (G.Social.me) { fn(); return; }
    G.Social.start().then(r => { if (r === 'ok') fn(); else G.NickUI.open(fn); });
  }

  // ======================= AMIGOS =======================

  export const FriendsUI = (() => {
    function init() {
      $('fr-add').onsubmit = async (e: Event) => {
        e.preventDefault();
        const name = $<HTMLInputElement>('fr-name').value;
        msg('');
        const r = await G.Social.request(name);
        msg(r.ok ? r.msg : r.error, !r.ok);
        if (r.ok) $<HTMLInputElement>('fr-name').value = '';
      };
      $('fr-room').onclick = () => G.LobbyUI.open();
      G.Social.on(() => { if (G.UI.isOpen('scr-friends')) render(); });
    }

    function msg(t?: string, bad?: boolean) {
      $('fr-msg').textContent = t || '';
      $('fr-msg').style.color = bad ? '#ffb0b8' : '';
      if (t) G.Audio.sfx(bad ? 'error' : 'confirm');
    }

    function open() { withNick(() => { G.UI.show('scr-friends', true); msg(''); render(); G.Social.refreshPresence(); }); }

    /** "hace 5 min", "hace 2 h", "hace 3 días". */
    function ago(t: number) {
      const m = Math.max(1, Math.round((Date.now() - t) / 60000));
      if (m < 60) return 'hace ' + m + ' min';
      const h = Math.round(m / 60);
      if (h < 48) return 'hace ' + h + ' h';
      return 'hace ' + Math.round(h / 24) + ' días';
    }

    function stateText(f: Friend) {
      if (f.status === 'in') return 'Quiere ser tu amigo';
      if (f.status === 'out') return 'Solicitud enviada';
      if (!f.online) return f.seen ? 'Visto ' + ago(f.seen) : 'Desconectado';
      return f.play ? 'Jugando' : 'En línea';
    }

    function render() {
      const room = G.Social.room;
      $('fr-me').innerHTML = 'Tu apodo: <b class="gold" translate="no">' + esc(G.Social.me ? G.Social.me.name : '') + '</b> · dáselo a tus amigos para que te añadan.';
      $('fr-room').classList.toggle('hidden', !room);
      const list = G.Social.friends.sort((a, b) => {
        const rank = (f: Friend) => f.status === 'in' ? 0 : f.status === 'ok' ? (f.online ? (f.play ? 2 : 1) : 3) : 4;
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      });
      const box = $('fr-list');
      box.innerHTML = '';
      if (!list.length) {
        box.innerHTML = '<p class="sub">Aún no tienes amigos añadidos. Escribe arriba el apodo de un amigo.</p>';
        return;
      }
      for (const f of list) {
        const el = document.createElement('div');
        el.className = 'fr-row';
        const dot = f.status !== 'ok' ? 'pend' : !f.online ? 'off' : f.play ? 'play' : 'on';
        const inRoom = room && room.members.some(m => m.uid === f.uid);
        el.innerHTML = `<i class="dot ${dot}"></i><b translate="no"><a href="#" class="plink" title="Ver su perfil">${esc(f.name)}</a></b><span class="st">${inRoom ? 'En tu sala' : stateText(f)}</span><span class="grow"></span>`;
        if (f.status === 'ok') el.querySelector<HTMLElement>('.plink')!.onclick = e => { e.preventDefault(); G.ProfileUI.show(f.uid); };
        else el.querySelector<HTMLElement>('.plink')!.onclick = e => e.preventDefault();
        const btn = (txt: string, cls: string, fn: () => unknown) => {
          const b = document.createElement('button');
          b.className = 'btn small ' + cls; b.textContent = txt; b.onclick = fn; el.appendChild(b); return b;
        };
        if (f.status === 'in') {
          btn('Aceptar', 'gold', async () => { const r = await G.Social.accept(f.uid); msg(r.ok ? r.msg : r.error, !r.ok); });
          btn('Rechazar', 'ghost', () => G.Social.remove(f.uid));
        } else if (f.status === 'out') {
          btn('Cancelar', 'ghost', () => G.Social.remove(f.uid));
        } else {
          if (f.online && !f.play && !inRoom && (!room || room.isHost)) {
            btn('Invitar', 'gold', async () => {
              const r = await G.Social.invite(f.uid);
              msg(r.ok ? r.msg : r.error, !r.ok);
              if (r.ok) G.LobbyUI.open();
            });
          }
          btn('Quitar', 'ghost', () => { if (confirm('¿Quitar a ' + f.name + ' de tus amigos?')) G.Social.remove(f.uid); });
        }
        box.appendChild(el);
      }
    }

    return { init, open, render };
  })();
  G.FriendsUI = FriendsUI;

  // ======================= SALA =======================

  export const LobbyUI = (() => {
    let membersKey = '';
    /**
     * A qué se juega: hordas o Defensa (y en qué mapa). Lo elige el anfitrión y se lo
     * cuenta a la sala con { k:'lobby', mode, map } (otra vez cuando entra alguien).
     */
    let game: { mode: 'hordas' | 'td'; map: string } = { mode: 'hordas', map: 'random' };
    const tellGame = () => {
      const room = G.Social.room;
      if (!room || !room.isHost) return;
      G.Net.broadcast({ k: 'lobby', ...game });
      // El servidor tiene que saber a qué se juega (de eso depende cuántos caben, y la lista de públicas lo enseña).
      if (room.mode !== modeOf() || room.map !== game.map) G.Social.setPublic(room.pub, modeOf(), game.map);
    };
    const modeOf = (): 'survivor' | 'td' => (game.mode === 'td' ? 'td' : 'survivor');

    function init() {
      $('lobby-leave').onclick = async () => {
        await G.Social.leaveRoom();
        G.Net.close();
        G.MenuUI.open();
      };
      $('lobby-menu').onclick = () => G.MenuUI.open();
      $<HTMLButtonElement>('lobby-start').onclick = start;
      $<HTMLButtonElement>('lobby-start').dataset.sfx = 'confirm';
      // Conecta / desconecta la red al entrar o salir de una sala.
      G.Social.on(what => {
        const room = G.Social.room;
        if (room) {
          G.Net.open(room.id, room.isHost, room.host);
          // Los que miran también reciben del anfitrión (como compañeros que no juegan).
          G.Net.syncMembers([...room.members.map(m => m.uid), ...room.watchers.map(w => w.uid)], room.members.filter(m => m.away).map(m => m.uid));
          if (room.isHost && G.Coop.active) G.Coop.syncWatchers(room.watchers);
        } else if (G.Net.open_ && !G.Social.watching) G.Net.close();
        if (what === 'room-closed') {
          G.UI.toast('La sala se ha cerrado', 2600);
          if (G.UI.isOpen('scr-lobby')) G.MenuUI.open();
        }
        if (G.UI.isOpen('scr-lobby')) render();
      });
      G.Net.onPeer((u, mode) => {
        if (mode === 'relay') tellGame();          // quien llega (o vuelve) se entera de a qué se juega
        if (G.UI.isOpen('scr-lobby')) render();
      });
      G.Net.on((from, msg) => {
        const room = G.Social.room;
        if (!msg || msg.k !== 'lobby' || !room || from !== room.host || room.isHost) return;
        game = { mode: msg.mode === 'td' ? 'td' : 'hordas', map: typeof msg.map === 'string' ? msg.map.slice(0, 20) : 'random' };
        if (G.UI.isOpen('scr-lobby')) render();
      });
    }

    /** El modo (y el mapa de la Defensa): botones para el anfitrión; para los demás, lo que ha elegido. */
    function renderMode(room: Room) {
      const box = $('lobby-mode');
      document.querySelectorAll('.lobby-access').forEach(el => el.remove());
      // Si la sala aún no sabe a qué se juega (recién creada), se le dice.
      if (room.isHost && (room.mode !== modeOf() || room.map !== game.map)) tellGame();
      const maps = [...G.TD_MAPS.map(m => [m.id, m.name]), ['random', 'Al azar']];
      const mapName = (maps.find(m => m[0] === game.map) || maps[maps.length - 1])[1];
      if (!room.isHost) {
        box.innerHTML = `<span class="sub">Modo: <b>${game.mode === 'td' ? 'Defensa · ' + esc(mapName) : 'Survivor'}</b> · ${room.pub ? 'Sala pública' : 'Sala privada'} · caben ${room.max}</span>`;
        return;
      }
      box.innerHTML = '<b>Modo:</b>';
      const chip = (label: string, on: boolean, fn: () => void) => {
        const b = document.createElement('button');
        b.className = 'btn small' + (on ? ' gold' : '');
        b.textContent = label;
        b.onclick = () => { fn(); tellGame(); render(); };
        box.appendChild(b);
      };
      chip('Survivor', game.mode === 'hordas', () => { game.mode = 'hordas'; });
      chip('Defensa', game.mode === 'td', () => { game.mode = 'td'; });
      if (game.mode === 'td') {
        box.insertAdjacentHTML('beforeend', '<b style="margin-left:8px">Mapa:</b>');
        for (const [id, name] of maps) chip(name, game.map === id, () => { game.map = id; });
      }
      // Privada (sólo con invitación) o pública (sale en Salas públicas: cualquiera entra, o mira si ya jugáis).
      const row = document.createElement('div');
      row.className = 'row lobby-mode lobby-access';
      row.innerHTML = '<b>Sala:</b>';
      for (const [pub, label, tip] of [[false, 'Privada', 'Sólo entran tus amigos, con invitación'],
                                       [true, 'Pública', 'Sale en Salas públicas: cualquiera puede entrar, o mirar si ya habéis empezado']] as const) {
        const b = document.createElement('button');
        b.className = 'btn small' + (room.pub === pub ? ' gold' : '');
        b.textContent = label;
        b.title = tip;
        b.onclick = () => { if (room.pub !== pub) G.Social.setPublic(pub, modeOf(), game.map); };
        row.appendChild(b);
      }
      row.insertAdjacentHTML('beforeend', `<span class="sub">Caben ${room.max}</span>`);
      box.after(row);
    }

    function open() {
      if (!G.Social.room) { G.MenuUI.open(); return; }
      G.Social.refreshMember();
      G.Social.refreshPresence();
      G.UI.show('scr-lobby', true);
      membersKey = '';
      render();
    }

    function close() { G.UI.hide('scr-lobby'); }

    function connText(m: Member, room: Room) {
      if (m.uid === room.host) return 'Anfitrión';
      if (!room.isHost) return m.uid === G.Social.uid ? 'Tú' : 'En la sala';
      const mode = G.Net.mode(m.uid);
      return mode === 'relay' ? 'Conectado' : 'Conectando…';
    }

    function render() {
      const room = G.Social.room;
      if (!room) return;
      const ms = room.members;
      renderMode(room);
      $('lobby-sub').textContent = room.isHost
        ? 'Eres el anfitrión. Invita a tus amigos (hasta ' + room.max + ') y empezad cuando estéis.'
        : 'Estás en la sala de ' + ((ms.find(m => m.uid === room.host) || {}).name || '…') + '. El anfitrión empezará la partida.';

      // Las tarjetas sólo se rehacen si cambian los miembros (los sprites no parpadean).
      const key = room.max + '#' + ms.map(m => m.uid + ':' + m.dex + ':' + (m.shiny ? 1 : 0)).join('|');
      const box = $('lobby-members');
      if (key !== membersKey) {
        membersKey = key;
        box.innerHTML = '';
        // Un hueco por plaza (Survivor 4; Defensa según el mapa); si sobra gente tras cambiar de modo, se ve.
        for (let i = 0; i < Math.max(room.max, ms.length); i++) {
          const m = ms[i];
          const c = document.createElement('div');
          c.className = 'lob-card' + (m ? '' : ' empty') + (i >= room.max ? ' over' : '');
          if (m) {
            c.style.setProperty('--pc', G.Coop.COLORS[i]);
            c.appendChild(G.UI.spriteCanvas(m.dex, 120, 96, { scale: 2, lively: true, shiny: !!m.shiny }));
            c.insertAdjacentHTML('beforeend', `<b translate="no">${esc(m.name)}</b><small>${esc((G.DEX_BY[m.dex] || {}).name || '')}</small><span class="conn" data-u="${m.uid}"></span>`);
          } else c.innerHTML = '<span>Libre</span>';
          box.appendChild(c);
        }
      }
      box.querySelectorAll<HTMLElement>('.conn').forEach(el => {
        const m = ms.find(x => x.uid === el.dataset.u);
        if (!m) return;
        const t = connText(m, room);
        el.textContent = t;
        el.className = 'conn' + (t === 'Conectando…' ? ' wait' : '');
      });

      // Invitar (sólo el anfitrión y si queda sitio).
      const canInvite = room.isHost && ms.length < room.max;
      $('lobby-inv-title').classList.toggle('hidden', !canInvite);
      const inv = $('lobby-invite');
      inv.classList.toggle('hidden', !canInvite);
      if (canInvite) {
        inv.innerHTML = '';
        const free = G.Social.friends.filter(f => f.status === 'ok' && f.online && !ms.some(m => m.uid === f.uid));
        if (!free.length) inv.innerHTML = '<p class="sub" style="margin:0">Ningún amigo en línea ahora mismo.</p>';
        for (const f of free) {
          const el = document.createElement('div');
          el.className = 'fr-row';
          el.innerHTML = `<i class="dot ${f.play ? 'play' : 'on'}"></i><b translate="no">${esc(f.name)}</b><span class="st">${f.play ? 'Jugando' : 'En línea'}</span><span class="grow"></span>`;
          const b = document.createElement('button');
          b.className = 'btn small gold'; b.textContent = 'Invitar';
          b.onclick = async () => { const r = await G.Social.invite(f.uid); G.UI.toast(r.ok ? r.msg : r.error); };
          el.appendChild(b);
          inv.appendChild(el);
        }
      }

      const btn = $<HTMLButtonElement>('lobby-start');
      btn.classList.toggle('hidden', !room.isHost);
      const connecting = ms.some(m => m.uid !== room.host && G.Net.mode(m.uid) === 'connecting');
      const over = ms.length - room.max;
      btn.disabled = !room.isHost || ms.length < 2 || connecting || over > 0;
      btn.textContent = 'Empezar partida (' + ms.length + '/' + room.max + ')';
      $('lobby-note').textContent = !room.isHost ? 'Cuando el anfitrión empiece, entraréis todos a la vez.'
        : over > 0 ? (game.mode === 'td' ? 'En este mapa caben ' + room.max : 'En el Survivor caben ' + room.max) + ': sobra' + (over > 1 ? 'n ' + over : ' 1') + '. Elige otro modo o mapa.'
        : ms.length < 2 ? 'Necesitas al menos un amigo en la sala.'
        : connecting ? 'Conectando con tus amigos…' : 'La partida empieza para todos a la vez.';
    }

    function start() {
      const room = G.Social.room;
      if (!room || !room.isHost || room.members.length < 2 || room.members.length > room.max) return;
      const cfg: CoopConfig & { k: string; mode?: 'survivor' | 'td'; map?: string } = {
        k: 'start', seed: Math.floor(Math.random() * 1e6), host: room.host,
        members: room.members.map(m => ({ uid: m.uid, name: m.name, dex: m.dex, shiny: !!m.shiny }))
      };
      // Defensa: el mapa elegido (o uno al azar, el mismo para todos).
      if (game.mode === 'td') { cfg.mode = 'td'; cfg.map = game.map === 'random' ? G.U.pick(G.TD_MAPS).id : game.map; }
      G.Social.setOpen(false);
      G.Net.broadcast({ ...cfg });
      G.Flow.startCoop(cfg);
    }

    return { init, open, close, render, get game() { return { ...game }; }, setGame(mode: 'hordas' | 'td', map = 'random') { game = { mode, map }; tellGame(); render(); } };
  })();
  G.LobbyUI = LobbyUI;

  // ======================= INVITACIONES =======================

  export const InvitePop = (() => {
    let cur: Invite | null = null;

    function init() {
      $('inv-yes').onclick = async () => {
        if (!cur) return;
        const from = cur.from;
        hide();
        const r = await G.Social.acceptInvite(from);
        if (!r.ok) { G.UI.toast(r.error, 3000); return; }
        G.LobbyUI.open();
      };
      $('inv-no').onclick = () => { if (cur) G.Social.declineInvite(cur.from); hide(); };
      G.Social.on(what => { if (what === 'invites' || what === 'room') refresh(); });
    }

    function hide() { cur = null; $('invite-pop').classList.add('hidden'); }

    /** Enseña la invitación más antigua si estás en los menús (no en plena partida). */
    function refresh() {
      const room = G.Social.room;
      const list = G.Social.invites.filter(i => !room || i.room !== room.id).sort((a, b) => a.at - b.at);
      if (!list.length || G.Game.state !== 'ui' || !G.DB.loggedIn) { hide(); return; }
      if (cur && cur.from === list[0].from) return;
      cur = list[0];
      $('inv-text').innerHTML = `${G.Icons.html('friends', 22)} <b class="gold" translate="no">${esc(cur.name)}</b> te invita a jugar en su sala`;
      $('invite-pop').classList.remove('hidden');
      G.Audio.sfx('shiny');
    }

    return { init, refresh };
  })();
  G.InvitePop = InvitePop;

  export const SocialUI = {
    init() { G.NickUI.init(); G.FriendsUI.init(); G.LobbyUI.init(); G.InvitePop.init(); },
    withNick, needOnline
  };
  G.SocialUI = SocialUI;

declare module '../g' {
  interface Registry { NickUI: typeof NickUI; FriendsUI: typeof FriendsUI; LobbyUI: typeof LobbyUI; InvitePop: typeof InvitePop; SocialUI: typeof SocialUI }
}
