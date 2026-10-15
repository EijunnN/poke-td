import { G } from '../g';
import { Link, type LinkStatus, type ServerMsg } from './link';
import { roomMax } from '../modes/td-geom';
import type { SaveData } from '../core/db';
import type { CoopConfig } from './coop';
/* ============ social.ts — amigos, en línea, invitaciones y salas ============
 * Sólo funciona con cuenta en el servidor (G.DB.online). Dos caminos hacia server/:
 *
 *   REST (/api/social, server/social.ts)   lo que se guarda: amigos y solicitudes, perfil público.
 *   WebSocket (net/link.ts, server/realtime.ts)   lo que va en directo: "en línea", jugando,
 *     invitaciones y salas. Estar en línea es tener el WebSocket abierto; las salas viven en
 *     SQLite del servidor: si se reinicia o se corta la conexión, el cliente reconecta solo y el
 *     servidor le devuelve su sala (`hello`); si no vuelve a tiempo, la sala se cierra para todos.
 *
 * El apodo es el nombre de la cuenta (único): no hay nada que reservar, pero `claimNick` y
 * la pantalla de apodo siguen ahí por si alguna vez hiciera falta. El `uid` de todos es el
 * id de la cuenta como texto.
 *
 * Salas públicas (server/realtime.ts): el anfitrión la hace pública con `setPublic` y sale en
 * `listRooms`; cualquiera entra sin invitación mientras están en la sala, y si ya juegan, sólo
 * puede MIRAR (`watch`): `watching` es la sala que miras y la partida que mandó el anfitrión.
 *
 * El resto del juego escucha los cambios con G.Social.on(fn): 'friends', 'presence',
 * 'invites', 'room', 'room-closed', 'watch', 'watch-ended' y 'stop'.
 */

/** Resultado de una acción: `msg` si salió bien, `error` si no. */
export interface Result { ok: boolean; msg?: string; error?: string }
export interface Friend {
  uid: string; name: string; pid: string;
  /** 'ok' amigo · 'in' te ha mandado una solicitud · 'out' se la mandaste tú */
  status: 'ok' | 'in' | 'out';
  online: boolean; play: boolean; room: string; seen: number;
}
/** `away`: ha perdido la conexión y el servidor le guarda el sitio unos segundos. */
export interface Member { uid: string; name: string; dex: number; shiny: boolean; away?: boolean }
/**
 * `started`: la partida en grupo ya ha empezado. `pub`: sale en la lista de salas públicas, con
 * su modo y mapa. `watchers`: los que la miran (no juegan).
 */
export interface Room {
  id: string; host: string; isHost: boolean; members: Member[]; open: boolean; started: boolean;
  pub: boolean; mode: 'survivor' | 'td'; map: string; watchers: { uid: string; name: string }[];
  /** Cuántos caben (Survivor 4; Defensa, según el mapa). */
  max: number;
}
/** Una sala de la lista de salas públicas. */
export interface PublicRoom { id: string; host: string; hostName: string; mode: 'survivor' | 'td'; map: string; n: number; max: number; started: boolean; watchers: number }
export interface Invite { from: string; name: string; room: string; at: number }
/** Perfil público de un jugador (lo que devuelve getProfile; el servidor puede omitir campos). */
export interface PublicProfile {
  name?: string | null; title?: string; favs?: { dex: number; shiny?: boolean }[]; medals?: string[];
  best?: { solo?: number; group?: number; level?: number; bosses?: number; legends?: number; kills?: number; medals?: number };
}
type Presence = Pick<Friend, 'online' | 'play' | 'room' | 'seen'>;
/** La sala tal y como viene del servidor (JSON; toRoom la normaliza). */
interface RoomWire {
  id: string; host: string; members?: Member[]; open?: boolean; started?: boolean; pub?: boolean;
  mode?: string; map?: unknown; watchers?: { uid: string; name: string }[]; max?: number;
}

export const Social = (() => {
  const VALID = /^[A-Za-z0-9_ñÑáéíóúÁÉÍÓÚ]{3,16}$/;
  /** Lo que cabe en una sala del Survivor (y en una sala recién creada). */
  const MAX_PLAYERS = 4;
  const INVITE_TTL = 3 * 60 * 1000;
  const PRES_TTL = 5 * 1000;            // refrescar la lista de amigos como mucho cada 5 s

  let uid: string | null = null;
  let me: { uid: string; name: string } | null = null;
  let friends = new Map<string, Friend>();
  let room: Room | null = null;
  /**
   * Anfitrión: lo último que pediste para tu sala (pública o no, modo y mapa). Las respuestas del
   * servidor pueden llegar desordenadas respecto a lo que vas cambiando: mientras sea tu sala, manda esto.
   */
  let want: { id: string; pub: boolean; mode: 'survivor' | 'td'; map: string } | null = null;
  /** La sala que miras como espectador y la partida que se juega en ella (o null). */
  let watching: { room: Room; cfg: CoopConfig } | null = null;
  const invites = new Map<string, Invite>();  // de quién -> invitación
  const listeners = new Set<(what: string) => void>();
  let started = false, playing = false, friendsAt = 0, loadSeq = 0, loading: Promise<void> | null = null;

  function emit(what: string) { listeners.forEach(fn => { try { fn(what); } catch (e) { console.warn(e); } }); }

  /** Llamada REST; nunca lanza (sin red, { ok:false, error }). */
  async function call(method: string, path: string, body?: unknown): Promise<{ ok: boolean; [k: string]: any }> {
    try { return (await G.DB.api(method, '/social' + path, body)).j; }
    catch (e) { return { ok: false, error: 'No se pudo conectar con el servidor.' }; }
  }

  // ---------------- arranque ----------------

  /** Tras iniciar sesión. → 'ok' | 'need-nick' | 'off' (sin cuenta en el servidor) */
  async function start(): Promise<'ok' | 'need-nick' | 'off'> {
    const s = G.DB.session;
    if (!G.DB.online || !s) return 'off';
    if (started) return me ? 'ok' : 'need-nick';
    started = true;
    uid = s.uid;
    // El apodo es el nombre de la cuenta, que ya es único.
    me = { uid, name: s.name! };
    Link.connect(s.token);
    loadFriends();
    publishProfile(true);
    return 'ok';
  }

  /**
   * El apodo es el nombre de la cuenta: sólo vale ése. (Se mantiene por si la pantalla de
   * apodo llegara a abrirse; con cuenta del servidor no se abre.)
   */
  async function claimNick(name: string): Promise<Result> {
    name = (name || '').trim();
    if (!VALID.test(name)) return { ok: false, error: 'El apodo debe tener 3-16 letras, números o _.' };
    const s = G.DB.session;
    if (!s) return { ok: false, error: 'Entra con tu cuenta para elegir apodo.' };
    if (name.toLowerCase() !== s.name!.toLowerCase()) return { ok: false, error: 'Aquí tu apodo es el nombre de tu cuenta (' + s.name + ').' };
    if (!started) await start();
    return { ok: true };
  }

  async function stop(_why?: string) {
    if (!started) return;
    await leaveRoom().catch(() => {});
    Link.disconnect();
    friends.clear(); invites.clear(); profCache.clear(); friendsAt = 0;
    me = null; started = false; uid = null; playing = false; pubLast = ''; watching = null;
    emit('stop');
  }

  // ---------------- tiempo real ----------------

  // Otra pestaña con la misma cuenta se ha quedado la conexión: ésta ya no recibe invitaciones.
  Link.onTaken(t => { if (t && G.UI) G.UI.toast('Has abierto el juego en otra pestaña: aquí ya no te llegan invitaciones. Recarga para usar ésta.', 7000); });

  Link.onStatus((s: LinkStatus) => {
    if (!started) return;
    if (s === 'open') {
      if (playing) Link.send({ k: 'play', v: true });
      loadFriends(true);              // lo que cambió mientras no estabas conectado
    } else if (s === 'closed') {
      // La sala se conserva: el servidor se la guarda un rato y al reconectar (hello) se decide.
      invites.clear();
      for (const f of friends.values()) { f.online = false; f.play = false; f.room = ''; }
      emit('presence');
      emit('invites');
    }
  });

  Link.on((m: ServerMsg) => {
    if (!started) return;
    switch (m.k) {
      case 'hello': {
        // Al reconectar ya no miras nada (el servidor saca a quien se desconecta mientras mira).
        if (watching) { watching = null; Link.setEager(!!room); emit('watch-ended'); }
        // Tu sala tal y como la guardó el servidor (al reconectar, al recargar la página, tras un reinicio).
        if (m.room && m.room.started && !G.Coop.active) {
          // Había una partida en marcha y esta página ya no la está jugando (se recargó): no se puede volver.
          Link.send({ k: 'room.leave' });
          if (room) closedRoom();
        } else if (m.room) applyRoom(m.room);
        else if (room) closedRoom();
        break;
      }
      case 'pres': {
        const p: Presence = { online: !!m.online, play: !!m.play, room: typeof m.room === 'string' ? m.room : '', seen: +m.seen || 0 };
        const f = friends.get(m.uid);
        if (f) { if (!p.seen) p.seen = f.seen; Object.assign(f, p); }
        emit('presence');
        break;
      }
      case 'fr': loadFriends(true); break;
      case 'inv': {
        const f = friends.get(m.from);
        if (f && f.status !== 'ok') break;
        invites.set(m.from, { from: m.from, name: String(m.name), room: m.room, at: +m.at || Date.now() });
        emit('invites');
        break;
      }
      case 'invx': if (invites.delete(m.from)) emit('invites'); break;
      case 'room': {
        if (m.room) applyRoom(m.room);
        else if (room) closedRoom();
        break;
      }
      case 'watch': {
        if (!watching) break;
        if (m.room) { watching.room = toRoom(m.room); emit('watch'); }
        else { watching = null; Link.setEager(!!room); emit('watch-ended'); }
        break;
      }
    }
  });

  // ---------------- amigos ----------------

  /** Lee la lista de amigos y solicitudes (con su "en línea" actual). */
  function loadFriends(force = false): Promise<void> {
    if (!force && loading) return loading;
    const n = ++loadSeq;
    const p = (async () => {
      const r = await call('GET', '/friends');
      // Si mientras tanto se pidió otra lista más nueva, ésta ya no vale.
      if (!started || !r.ok || n !== loadSeq) return;
      const next = new Map<string, Friend>();
      for (const f of r.friends as Friend[]) next.set(f.uid, f);
      friends = next;
      friendsAt = Date.now();
      emit('friends');
    })().finally(() => { if (loading === p) loading = null; });
    loading = p;
    return p;
  }

  /** Vuelve a leer a tus amigos si hace más de unos segundos (al abrir Amigos o la sala). */
  async function refreshPresence(force = false) {
    if (!started || (!force && Date.now() - friendsAt < PRES_TTL)) return;
    await loadFriends(true);
  }

  /** Envía una solicitud de amistad (o acepta la que ya te había mandado). */
  async function request(name: string): Promise<Result> {
    name = (name || '').trim();
    if (!me) return { ok: false, error: 'Primero elige tu apodo.' };
    if (!VALID.test(name)) return { ok: false, error: 'Escribe el apodo exacto de tu amigo.' };
    const r = await call('POST', '/friends/request', { name });
    if (r.ok) loadFriends(true);
    return r.ok ? { ok: true, msg: r.msg } : { ok: false, error: r.error };
  }

  async function accept(other: string): Promise<Result> {
    const f = friends.get(other);
    if (!f || f.status !== 'in') return { ok: false, error: 'No hay solicitud.' };
    const r = await call('POST', '/friends/accept', { uid: other });
    loadFriends(true);
    return r.ok ? { ok: true, msg: r.msg } : { ok: false, error: r.error };
  }

  async function remove(other: string): Promise<Result> {
    if (!friends.has(other)) return { ok: false };
    const r = await call('DELETE', '/friends/' + encodeURIComponent(other));
    if (r.ok) { friends.delete(other); invites.delete(other); emit('friends'); }
    else loadFriends(true);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  // ---------------- salas ----------------

  function memberInfo() {
    const s = G.DB.save!;
    return { dex: s.partner, shiny: !!s.partnerShiny && G.DB.ownsShiny(s.partner!) };
  }

  /** La sala tal y como la manda el servidor. */
  function toRoom(r: RoomWire): Room {
    return { id: r.id, host: r.host, isHost: r.host === uid, members: r.members || [], open: !!r.open, started: !!r.started,
             pub: !!r.pub, mode: r.mode === 'td' ? 'td' : 'survivor', map: typeof r.map === 'string' ? r.map : 'random',
             watchers: Array.isArray(r.watchers) ? r.watchers : [], max: typeof r.max === 'number' && Number.isInteger(r.max) && r.max > 0 ? r.max : MAX_PLAYERS };
  }
  /** Aplica la sala tal y como la manda el servidor. */
  function applyRoom(r: RoomWire) {
    room = toRoom(r);
    if (want && want.id === room.id && room.isHost) {
      room.pub = want.pub; room.mode = want.mode; room.map = want.map; room.max = roomMax(want.mode, want.map);
    } else if (want && want.id !== room.id) want = null;
    Link.setEager(true);
    emit('room');
  }

  // ---------------- salas públicas y espectadores ----------------

  /** Anfitrión: la sala sale (o deja de salir) en la lista de públicas, con a qué se juega. */
  function setPublic(v: boolean, mode: 'survivor' | 'td', map: string) {
    if (!room || !room.isHost) return;
    const m = /^[a-z]{1,20}$/.test(map) ? map : 'random';
    // Ya, en local (el servidor lo confirmará): si no, lo que se pinte antes de su respuesta vería
    // lo de antes y lo volvería a mandar, deshaciendo el cambio.
    want = { id: room.id, pub: !!v, mode, map: m };
    room.pub = !!v; room.mode = mode; room.map = m; room.max = roomMax(mode, m);
    Link.send({ k: 'room.pub', v: !!v, mode, map: m });
  }

  /** Las salas públicas (las que esperan gente, primero). */
  async function listRooms(): Promise<PublicRoom[]> {
    const r = await Link.request({ k: 'rooms.list' }).catch(() => null);
    return r && r.ok && Array.isArray(r.rooms) ? r.rooms : [];
  }

  /** Empiezas a mirar la partida de una sala pública. → la partida (cfg) o un error */
  async function watch(id: string): Promise<{ ok: boolean; error?: string; cfg?: CoopConfig }> {
    if (room) return { ok: false, error: 'Sal de tu sala para mirar otra partida.' };
    const r = await Link.request({ k: 'room.watch', id }).catch(() => null);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'No se pudo entrar a mirar.' };
    watching = { room: toRoom(r.room), cfg: r.cfg };
    Link.setEager(true);
    emit('watch');
    return { ok: true, cfg: r.cfg };
  }

  /** Dejas de mirar. */
  function unwatch() {
    if (!watching) return;
    watching = null;
    Link.send({ k: 'room.unwatch' });
    Link.setEager(!!room);
    emit('watch');
  }

  async function createRoom(): Promise<Room | null> {
    if (room) return room;
    const r = await Link.request({ k: 'room.new', ...memberInfo() });
    if (r.ok && !room) applyRoom(r.room);
    return room;
  }

  async function joinRoom(id: string): Promise<Result> {
    if (room && room.id === id) return { ok: true };
    if (room) await leaveRoom();
    const r = await Link.request({ k: 'room.join', id, ...memberInfo() });
    if (!r.ok) return { ok: false, error: r.error || 'No se pudo entrar en la sala.' };
    applyRoom(r.room);
    return { ok: true };
  }

  /** La sala se cerró (el anfitrión se fue o se cayó la conexión). */
  function closedRoom() {
    if (!room) return;
    room = null;
    Link.setEager(false);
    emit('room-closed');
  }

  async function leaveRoom() {
    if (!room) return;
    room = null;
    Link.setEager(false);
    await Link.request({ k: 'room.leave' });
    emit('room');
  }

  /** El anfitrión cierra la sala a nuevos jugadores al empezar la partida. */
  function setOpen(open: boolean) {
    if (room && room.isHost) Link.send({ k: 'room.open', v: !!open });
  }

  /** Actualiza tu Pokémon en la sala (si cambias de compañero). */
  function refreshMember() {
    if (room && me) Link.send({ k: 'room.me', ...memberInfo() });
  }

  /** Dices si estás en partida (los amigos lo ven). */
  function setPlaying(p: boolean) {
    if (playing === !!p) return;
    playing = !!p;
    Link.send({ k: 'play', v: playing });
  }

  // ---------------- invitaciones ----------------

  async function invite(other: string): Promise<Result> {
    const f = friends.get(other);
    if (!f || f.status !== 'ok') return { ok: false, error: 'Sólo puedes invitar a tus amigos.' };
    if (room && room.members.length >= room.max) return { ok: false, error: 'La sala está llena.' };
    if (room && !room.isHost) return { ok: false, error: 'Sólo el anfitrión de la sala puede invitar.' };
    if (!room && !(await createRoom())) return { ok: false, error: 'No se pudo crear la sala.' };
    const r = await Link.request({ k: 'inv', to: other });
    return r.ok ? { ok: true, msg: 'Invitación enviada a ' + f.name } : { ok: false, error: r.error || 'No se pudo invitar.' };
  }

  async function acceptInvite(from: string): Promise<Result> {
    const inv = invites.get(from);
    if (!inv || Date.now() - inv.at > INVITE_TTL) { invites.delete(from); emit('invites'); return { ok: false, error: 'La invitación ha caducado.' }; }
    invites.delete(from);
    emit('invites');
    return joinRoom(inv.room);
  }

  function declineInvite(from: string) {
    invites.delete(from);
    Link.send({ k: 'inv.no', from });
    emit('invites');
  }

  // ---------------- perfil público ----------------

  /** Lo que se enseña de ti (también para tu vista previa, sin subirlo). */
  function profileData() {
    const s = G.DB.save!, st = s.stats, prof: Partial<SaveData['profile']> = s.profile || {};
    const unlocked = G.AchDefs.LIST.filter(a => s.ach && s.ach[a.id]);
    const medals = unlocked.slice().sort((a, b) => (b.tier - a.tier) || (s.ach[b.id] - s.ach[a.id])).slice(0, 8).map(a => a.id);
    return {
      name: me ? me.name : G.DB.user,
      favs: (prof.favs || []).filter(f => f && f.dex > 0).slice(0, 3).map(f => ({ dex: f.dex | 0, shiny: !!f.shiny })),
      title: prof.title || '',
      best: { solo: st.bestTime | 0, group: st.bestGroupTime | 0, level: st.bestLevel | 0, bosses: st.bossesTotal | 0,
              legends: Object.keys(s.legends || {}).length, kills: st.totalKills | 0, medals: unlocked.length },
      medals
    };
  }

  let pubT = 0, pubLast = '';
  /**
   * Sube tu perfil (con un poco de espera, por si cambias varias cosas seguidas), pero sólo
   * si ha cambiado algo desde la última vez que se subió en esta sesión.
   */
  function publishProfile(_force = false) {
    if (!me || !started) return;
    clearTimeout(pubT);
    pubT = window.setTimeout(async () => {
      if (!me || !started) return;
      const { name, ...d } = profileData();
      const key = JSON.stringify(d);
      if (key === pubLast) return;
      pubLast = key;
      const r = await call('PUT', '/profile', d);
      if (!r.ok) { pubLast = ''; console.warn('[Social] perfil:', r.error); }
    }, 800);
  }

  /** El perfil público de otro jugador. */
  const profCache = new Map<string, { at: number; v: PublicProfile }>();
  async function getProfile(other: string): Promise<PublicProfile | null> {
    if (!started) return null;
    // El tuyo sale de tu partida (sin pedir nada y siempre al día).
    if (other === uid && me) return Object.assign(profileData(), { name: me.name });
    const c = profCache.get(other);
    if (c && Date.now() - c.at < 10 * 60 * 1000) return c.v;     // lo leído vale 10 min
    const r = await call('GET', '/profile/' + encodeURIComponent(other));
    const v = r.ok ? r.profile : null;
    if (r.ok) profCache.set(other, { at: Date.now(), v });
    return v;
  }

  // Al cerrar sesión o borrar la cuenta.
  G.DB.onLeave(why => stop(why));

  return {
    start, stop, claimNick, request, accept, remove, publishProfile, getProfile, profileData,
    createRoom, joinRoom, leaveRoom, setOpen, refreshMember, setPlaying, refreshPresence,
    setPublic, listRooms, watch, unwatch,
    invite, acceptInvite, declineInvite,
    on(fn: (what: string) => void) { listeners.add(fn); }, off(fn: (what: string) => void) { listeners.delete(fn); },
    get me() { return me; },
    get started() { return started; },
    get friends() { return [...friends.values()]; },
    get invites() { return [...invites.values()]; },
    get room() { return room; },
    get watching() { return watching; },
    get uid() { return uid; },
    VALID, MAX_PLAYERS
  };
})();
G.Social = Social;

declare module '../g' {
  interface Registry { Social: typeof Social }
}
