/* ============ server/realtime.ts — tiempo real por WebSocket ============
 * Conexión en /ws?token=<sesión> (la valida server/index.ts y deja la cuenta en
 * ws.data.user). Las invitaciones y la presencia viven en memoria (se rehacen solas
 * al reconectar). Las SALAS también se guardan en SQLite (server/social-store.ts), así
 * que sobreviven a un reinicio del servidor y a un corte de conexión:
 *   - Quien se desconecta sigue en su sala, marcado como "away", durante `roomGrace`
 *     (45 s). Si vuelve (el cliente reconecta solo), el `hello` ya trae su sala y los
 *     demás ven que ha vuelto. Si no vuelve a tiempo, sale de la sala; si era el
 *     anfitrión, la sala se cierra para todos.
 *   - Tras un reinicio, todos los miembros empiezan "away" con el plazo entero.
 *   - Los mensajes de partida (`g`) para alguien "away" se pierden: al volver, el
 *     anfitrión le reenvía el estado (ver net/coop.ts, resync).
 *   - Al arrancar se borran las salas que llevan más de 3 h sin moverse.
 * Lo demás persistente (amigos, perfiles) se sirve por REST (server/social.ts).
 *
 * Una cuenta = una conexión: si abre otra pestaña, la nueva sustituye a la vieja
 * (que se cierra con el código 4001 y ya no reconecta) y hereda su sala.
 *
 * Cliente -> servidor (JSON; `i` opcional: el servidor contesta { k:'ack', i, ok, ... }):
 *   { k:'ping' }                                  -> { k:'pong' }
 *   { k:'play', v }                               estoy en partida (sí/no)
 *   { k:'room.new', dex, shiny }                  crea sala y eres su anfitrión
 *   { k:'room.join', id, dex, shiny }             entra en una sala a la que te han invitado
 *   { k:'room.leave' }                            sales (si eras el anfitrión, se cierra para todos)
 *   { k:'room.open', v }                          (anfitrión) admite o no jugadores nuevos
 *   { k:'room.me', dex, shiny }                   cambias de Pokémon
 *   { k:'inv', to }                               (anfitrión) invita a un amigo
 *   { k:'inv.no', from }                          rechazas una invitación
 *   { k:'g', to?, d }                             mensaje de partida para otro miembro (o para todos si no hay `to`)
 *
 * Servidor -> cliente:
 *   { k:'hello', uid, name, room }                al conectar (room: la sala en la que ya estabas, o null)
 *   { k:'pres', uid, online, play, room, seen? }  un amigo cambia de estado
 *   { k:'fr' }                                    cambió la lista de amigos (pídela por REST)
 *   { k:'inv', from, name, room, at } · { k:'invx', from }   invitación recibida / retirada
 *   { k:'room', room: { id, host, open, started, members:[{uid,name,dex,shiny,away}] } | null, why? }
 *   { k:'g', f, d }                               mensaje de partida de `f`
 *   { k:'err', error }
 *
 * Defensas: sólo texto JSON; 64 KB por mensaje (Bun cierra la conexión si se pasa);
 * cubo de mensajes y de bytes por conexión (si se vacía, se descartan y cuentan como
 * falta; con muchas faltas seguidas se cierra); un cliente que no lee (su cola de
 * salida crece) se desconecta en vez de acumular memoria o perder mensajes.
 */
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import type { Db, User } from './db';
import { MAX_DEX, socialStore } from './social-store';

export interface WsData { user: User; c?: Conn }

/** Un temporizador cualquiera: lo único que se le pide es que no mantenga vivo el proceso. */
export interface TimerHandle { unref(): unknown }
/** El tiempo que usa el módulo (hora y temporizadores). Se inyecta para poder probarlo sin esperar. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(t: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(t: TimerHandle): void;
}
/** El reloj de verdad. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: t => clearInterval(t as ReturnType<typeof setInterval>),
};

export interface RealtimeOptions {
  /** Cuánto vale una invitación (ms). */
  inviteTtl?: number;
  /** Mensajes por segundo que aguanta cada conexión de forma sostenida, y de golpe. */
  msgRate?: number; msgBurst?: number;
  /** Bytes por segundo, sostenido y de golpe. */
  byteRate?: number; byteBurst?: number;
  /** Cuánto se espera (ms) a quien se desconecta de una sala antes de sacarlo (o cerrarla si era el anfitrión). */
  roomGrace?: number;
  /** Hora y temporizadores (pruebas: un reloj falso que avanza a mano). Por defecto, el real. */
  clock?: Clock;
}

export const MAX_PLAYERS = 4;
const MAX_MSG = 64 * 1024;
/** Cuántos pasos en falso (mensaje roto, sin permiso, a destiempo) aguanta una conexión antes de cerrarse. */
const MAX_BAD = 40;
const BAD_WINDOW = 10_000;
const MAX_OUT_INVITES = 8;
const ID = /^[A-Za-z0-9_-]{8,32}$/;

interface Member { uid: number; name: string; dex: number; shiny: boolean }
/** `started`: cuándo empezó la partida en grupo (0 si la sala sigue en el vestíbulo). */
interface Room { id: string; host: number; open: boolean; started: number; created: number; members: Map<number, Member> }
/** Las salas guardadas más viejas que esto se descartan al arrancar. */
const ROOM_MAX_AGE = 3 * 3600_000;
/** Una partida en grupo ya no sirve para validar una marca pasado esto (el tope de una partida es 1 h). */
const START_MAX_AGE = 70 * 60_000;
interface Invite { room: string; at: number }

export interface Conn {
  ws: ServerWebSocket<WsData>;
  id: number;
  name: string;
  play: boolean;
  gone: boolean;
  msgs: number; bytes: number; t: number;
  bad: number; badT: number;
}

const newRoomId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(9))).toString('base64url');
/** Un id de cuenta tal y como lo manda el cliente (texto). */
const parseUid = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^[1-9]\d{0,11}$/.test(v) ? Number(v) : null;
  return n;
};

export function createRealtime(db: Db, opts: RealtimeOptions = {}) {
  const store = socialStore(db);
  const inviteTtl = opts.inviteTtl ?? 3 * 60_000;
  const msgRate = opts.msgRate ?? 90, msgBurst = opts.msgBurst ?? 180;
  const byteRate = opts.byteRate ?? 1_000_000, byteBurst = opts.byteBurst ?? 2_000_000;
  const roomGrace = opts.roomGrace ?? 45_000;
  const clock = opts.clock ?? realClock;
  const now = clock.now;
  /** Parado el servidor: las conexiones que se cierran ya no tocan la base (las salas se quedan como estaban para el próximo arranque). */
  let stopped = false;

  const conns = new Map<number, Conn>();
  const rooms = new Map<string, Room>();
  const roomOf = new Map<number, Room>();
  const invites = new Map<number, Map<number, Invite>>();   // para -> de -> invitación
  const sentBy = new Map<number, Set<number>>();            // de -> a quién
  const awayT = new Map<number, TimerHandle>();   // desconectado de su sala -> cuándo se le saca

  const text = (m: unknown) => JSON.stringify(m);
  /** Manda; si la cola de salida de ese cliente se desborda, Bun lo desconecta (ver `websocket`). */
  function raw(c: Conn, s: string) { if (!c.gone) c.ws.send(s); }
  function send(id: number, m: unknown) { const c = conns.get(id); if (c) raw(c, text(m)); }

  // ---------------- presencia ----------------

  function presence(id: number) {
    const c = conns.get(id);
    return { online: !!c, play: !!c && c.play, room: roomOf.get(id)?.id ?? '' };
  }

  /** Cuenta a sus amigos conectados cómo está ahora. */
  function pushPresence(id: number) {
    const friends = store.friendIds(id).filter(f => conns.has(f));
    if (!friends.length) return;
    const p = presence(id);
    const s = text({ k: 'pres', uid: String(id), ...p, ...(p.online ? {} : { seen: now() }) });
    for (const f of friends) raw(conns.get(f)!, s);
  }

  // ---------------- invitaciones ----------------

  function dropInvite(to: number, from: number, tell = true) {
    const m = invites.get(to);
    if (!m || !m.delete(from)) return;
    if (!m.size) invites.delete(to);
    const s = sentBy.get(from);
    if (s) { s.delete(to); if (!s.size) sentBy.delete(from); }
    if (tell) send(to, { k: 'invx', from: String(from) });
  }
  /** Retira todas las invitaciones que mandó `from`. */
  function dropSent(from: number) { for (const to of [...(sentBy.get(from) ?? [])]) dropInvite(to, from); }
  /** Retira las de `id` (recibidas y enviadas), p. ej. al borrar la cuenta o romper la amistad. */
  function dropAll(id: number) {
    dropSent(id);
    for (const from of [...(invites.get(id)?.keys() ?? [])]) dropInvite(id, from, false);
  }
  const live = (iv: Invite) => now() - iv.at <= inviteTtl;

  // Las caducadas se retiran (y se avisa) cada pocos segundos.
  const sweep = clock.setInterval(() => {
    for (const [to, m] of [...invites]) for (const [from, iv] of [...m]) if (!live(iv)) dropInvite(to, from);
  }, Math.max(50, Math.min(15_000, inviteTtl / 2)));
  sweep.unref();
  // Las salas con alguien dentro se marcan como vivas (las que no, se descartan al arrancar si son viejas).
  const keep = clock.setInterval(() => { for (const r of rooms.values()) if ([...r.members.keys()].some(id => conns.has(id))) store.touchRoom(r.id, now()); }, 60_000);
  keep.unref();

  // ---------------- salas ----------------

  const snapshot = (r: Room) => ({
    id: r.id, host: String(r.host), open: r.open, started: r.started > 0,
    members: [...r.members.values()].map(m => ({ uid: String(m.uid), name: m.name, dex: m.dex, shiny: m.shiny, away: !conns.has(m.uid) })),
  });
  const tellRoom = (r: Room, except?: number) => {
    const s = text({ k: 'room', room: snapshot(r) });
    for (const id of r.members.keys()) { const c = conns.get(id); if (c && id !== except) raw(c, s); }
  };
  const persist = (r: Room) => store.saveRoom({
    id: r.id, host: r.host, open: r.open, started: r.started, created: r.created,
    members: [...r.members.values()].map(m => ({ uid: m.uid, dex: m.dex, shiny: m.shiny })),
  }, now());

  // Quien se desconecta de una sala tiene `roomGrace` para volver.
  function clearAway(id: number) { const t = awayT.get(id); if (t) { clock.clearTimeout(t); awayT.delete(id); } }
  function markAway(id: number) {
    if (!roomOf.has(id) || awayT.has(id)) return;
    const t = clock.setTimeout(() => { awayT.delete(id); if (!conns.has(id)) leaveRoom(id, 'timeout'); }, roomGrace);
    t.unref();
    awayT.set(id, t);
  }

  function closeRoom(r: Room, why: string, except?: number) {
    rooms.delete(r.id);
    store.deleteRoom(r.id);
    dropSent(r.host);
    const s = text({ k: 'room', room: null, why });
    for (const id of [...r.members.keys()]) {
      clearAway(id);
      roomOf.delete(id);
      const c = conns.get(id);
      if (c && id !== except) raw(c, s);
      pushPresence(id);
    }
  }

  /** Saca a `id` de su sala: si era el anfitrión, se cierra para todos. */
  function leaveRoom(id: number, why = 'closed') {
    const r = roomOf.get(id);
    if (!r) return;
    if (r.host === id) { closeRoom(r, why, id); return; }
    r.members.delete(id);
    roomOf.delete(id);
    clearAway(id);
    persist(r);
    tellRoom(r);
    pushPresence(id);
  }

  // Salas guardadas de antes de un reinicio: sus miembros vuelven a tener el plazo entero para reconectar.
  store.pruneGroupStarts(now() - 24 * 3600_000);
  for (const rec of store.loadRooms(now() - ROOM_MAX_AGE)) {
    const members = new Map<number, Member>();
    for (const m of rec.members) {
      const u = db.userById(m.uid);
      if (u) members.set(m.uid, { uid: m.uid, name: u.name, dex: m.dex, shiny: m.shiny });
    }
    if (!members.has(rec.host)) { store.deleteRoom(rec.id); continue; }
    const r: Room = { id: rec.id, host: rec.host, open: rec.open, started: rec.started, created: rec.created, members };
    rooms.set(r.id, r);
    for (const id of members.keys()) { roomOf.set(id, r); markAway(id); }
  }

  const validDex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_DEX;

  // ---------------- conexión ----------------

  function open(ws: ServerWebSocket<WsData>) {
    const u = ws.data.user;
    const c: Conn = { ws, id: u.id, name: u.name, play: false, gone: false, msgs: msgBurst, bytes: byteBurst, t: now(), bad: 0, badT: 0 };
    ws.data.c = c;
    const old = conns.get(u.id);
    if (old) {
      // La sesión nueva manda: la vieja se cierra sin reconectar y la sala pasa a la nueva.
      old.gone = true;
      conns.delete(u.id);
      old.ws.close(4001, 'Sesión abierta en otro sitio');
    }
    conns.set(u.id, c);
    clearAway(u.id);
    const mine = roomOf.get(u.id) ?? null;
    raw(c, text({ k: 'hello', uid: String(u.id), name: u.name, room: mine && snapshot(mine) }));
    if (mine) tellRoom(mine, u.id);                        // los demás ven que has vuelto
    for (const [from, iv] of invites.get(u.id) ?? []) {
      if (live(iv)) raw(c, text({ k: 'inv', from: String(from), name: db.userById(from)?.name ?? '?', room: iv.room, at: iv.at }));
    }
    pushPresence(u.id);
  }

  function close(ws: ServerWebSocket<WsData>) {
    const c = ws.data.c;
    if (stopped || !c || c.gone) return;         // servidor parado, o sustituida por otra pestaña: nada que limpiar
    c.gone = true;
    conns.delete(c.id);
    // Sigue en su sala un rato por si vuelve (corte de red, reinicio del servidor).
    const r = roomOf.get(c.id);
    if (r) { markAway(c.id); tellRoom(r); }
    try { store.touchSeen(c.id, now()); } catch { /* la cuenta ya no existe */ }
    pushPresence(c.id);
  }

  /** Una falta: mensaje roto, sin permiso o a destiempo. Con muchas seguidas se corta la conexión. */
  function offend(c: Conn) {
    const t = now();
    if (t - c.badT > BAD_WINDOW) c.bad = 0;
    c.badT = t;
    if (++c.bad > MAX_BAD && !c.gone) c.ws.close(1008, 'Demasiados errores');
  }

  /** Cubos de mensajes y de bytes: cada conexión puede gastar lo suyo y no más. */
  function allow(c: Conn, len: number) {
    const t = now();
    const dt = (t - c.t) / 1000;
    c.t = t;
    c.msgs = Math.min(msgBurst, c.msgs + dt * msgRate);
    c.bytes = Math.min(byteBurst, c.bytes + dt * byteRate);
    if (c.msgs < 1 || c.bytes < len) return false;
    c.msgs -= 1; c.bytes -= len;
    return true;
  }

  function message(ws: ServerWebSocket<WsData>, rawMsg: string | Buffer) {
    const c = ws.data.c;
    if (stopped || !c || c.gone) return;
    if (typeof rawMsg !== 'string') { offend(c); return; }
    if (!allow(c, rawMsg.length)) { offend(c); return; }
    let m: any;
    try { m = JSON.parse(rawMsg); } catch { offend(c); return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.k !== 'string') { offend(c); return; }
    const ref = Number.isInteger(m.i) && m.i >= 0 && m.i < 1e9 ? m.i as number : null;
    /** Contesta a una orden con `i`; sin `i` los errores van como { k:'err' }. */
    const reply = (ok: boolean, extra: Record<string, unknown> = {}) => {
      if (ref !== null) raw(c, text({ k: 'ack', i: ref, ok, ...extra }));
      else if (!ok) raw(c, text({ k: 'err', error: extra.error }));
    };
    const bad = (error: string) => { offend(c); reply(false, { error }); };
    /** Error esperable (carrera, sala llena...): no cuenta como falta. */
    const no = (error: string) => reply(false, { error });

    switch (m.k) {
      case 'ping': raw(c, '{"k":"pong"}'); return;

      case 'play': {
        if (typeof m.v !== 'boolean') return bad('Mensaje no válido.');
        if (c.play !== m.v) { c.play = m.v; pushPresence(c.id); }
        return reply(true);
      }

      case 'room.new': {
        if (!validDex(m.dex) || typeof m.shiny !== 'boolean') return bad('Pokémon no válido.');
        const cur = roomOf.get(c.id);
        if (cur) return reply(true, { room: snapshot(cur) });
        const r: Room = { id: newRoomId(), host: c.id, open: true, started: 0, created: now(), members: new Map() };
        r.members.set(c.id, { uid: c.id, name: c.name, dex: m.dex, shiny: m.shiny });
        rooms.set(r.id, r); roomOf.set(c.id, r);
        persist(r);
        pushPresence(c.id);
        return reply(true, { room: snapshot(r) });
      }

      case 'room.join': {
        if (typeof m.id !== 'string' || !ID.test(m.id) || !validDex(m.dex) || typeof m.shiny !== 'boolean') return bad('Mensaje no válido.');
        const cur = roomOf.get(c.id);
        if (cur && cur.id === m.id) return reply(true, { room: snapshot(cur) });
        const r = rooms.get(m.id);
        const iv = r && invites.get(c.id)?.get(r.host);
        if (!r || !iv || iv.room !== r.id) return no('Esa sala ya no existe o no te han invitado.');
        if (!live(iv)) { dropInvite(c.id, r.host); return no('La invitación ha caducado.'); }
        if (!store.isFriend(c.id, r.host)) { dropInvite(c.id, r.host); return no('Sólo puedes entrar en la sala de un amigo.'); }
        if (!r.open) return no('La partida de esa sala ya ha empezado.');
        if (r.members.size >= MAX_PLAYERS) return no(`La sala está llena (máximo ${MAX_PLAYERS}).`);
        if (cur) leaveRoom(c.id);
        dropInvite(c.id, r.host, false);
        r.members.set(c.id, { uid: c.id, name: c.name, dex: m.dex, shiny: m.shiny });
        roomOf.set(c.id, r);
        persist(r);
        tellRoom(r);
        pushPresence(c.id);
        return reply(true, { room: snapshot(r) });
      }

      case 'room.leave': {
        leaveRoom(c.id, 'left');
        return reply(true);
      }

      case 'room.open': {
        if (typeof m.v !== 'boolean') return bad('Mensaje no válido.');
        const r = roomOf.get(c.id);
        if (!r) return no('No estás en ninguna sala.');
        if (r.host !== c.id) return bad('Sólo el anfitrión gobierna la sala.');
        if (r.open !== m.v) {
          r.open = m.v;
          if (m.v) r.started = 0;                            // la sala se reabre: la partida ha terminado
          persist(r);
          tellRoom(r);
        }
        return reply(true);
      }

      case 'room.me': {
        if (!validDex(m.dex) || typeof m.shiny !== 'boolean') return bad('Pokémon no válido.');
        const r = roomOf.get(c.id);
        if (!r) return no('No estás en ninguna sala.');
        const me = r.members.get(c.id)!;
        if (me.dex !== m.dex || me.shiny !== m.shiny) { me.dex = m.dex; me.shiny = m.shiny; persist(r); tellRoom(r); }
        return reply(true);
      }

      case 'inv': {
        const to = parseUid(m.to);
        if (to === null) return bad('Mensaje no válido.');
        const r = roomOf.get(c.id);
        if (!r) return no('Crea una sala antes de invitar.');
        if (r.host !== c.id) return bad('Sólo el anfitrión de la sala puede invitar.');
        if (to === c.id || !store.isFriend(c.id, to)) return bad('Sólo puedes invitar a tus amigos.');
        if (!r.open) return no('La partida de la sala ya ha empezado.');
        if (r.members.has(to)) return no('Ya está en tu sala.');
        if (r.members.size >= MAX_PLAYERS) return no('La sala está llena.');
        if (!invites.get(to)?.has(c.id) && (sentBy.get(c.id)?.size ?? 0) >= MAX_OUT_INVITES) return no('Tienes demasiadas invitaciones pendientes.');
        const iv: Invite = { room: r.id, at: now() };
        if (!invites.has(to)) invites.set(to, new Map());
        invites.get(to)!.set(c.id, iv);
        if (!sentBy.has(c.id)) sentBy.set(c.id, new Set());
        sentBy.get(c.id)!.add(to);
        send(to, { k: 'inv', from: String(c.id), name: c.name, room: r.id, at: iv.at });
        return reply(true);
      }

      case 'inv.no': {
        const from = parseUid(m.from);
        if (from === null) return bad('Mensaje no válido.');
        dropInvite(c.id, from, false);
        return reply(true);
      }

      case 'g': {
        const d = m.d;
        if (!d || typeof d !== 'object' || Array.isArray(d)) return bad('Mensaje de partida no válido.');
        // Empezar la partida sólo lo manda el anfitrión (los invitados se lo creerían).
        const r = roomOf.get(c.id);
        if (!r) return no('No estás en ninguna sala.');
        if (d.k === 'start') {
          if (r.host !== c.id) return bad('Sólo el anfitrión empieza la partida.');
          startGame(r, d);
        }
        let targets: number[];
        if (m.to === undefined) targets = [...r.members.keys()].filter(u => u !== c.id);
        else {
          const to = parseUid(m.to);
          if (to === null || to === c.id) return bad('Destinatario no válido.');
          if (!r.members.has(to)) return no('Ese jugador no está en tu sala.');
          targets = [to];
        }
        const s = text({ k: 'g', f: String(c.id), d });
        for (const t of targets) { const tc = conns.get(t); if (tc) raw(tc, s); }
        return;
      }

      default: return bad('Mensaje no válido.');
    }
  }

  // ---------------- partidas en grupo ----------------

  /**
   * El anfitrión manda `start`: se apunta el equipo REAL (los de `d.members` que de verdad están
   * en la sala; los demás se ignoran), y la sala pasa a "jugando" y se cierra a nuevos. El ranking
   * comprueba contra esto las marcas de grupo (verifyTeam).
   */
  function startGame(r: Room, d: Record<string, any>) {
    const at = now();
    const listed = Array.isArray(d.members) ? d.members.map((x: any) => parseUid(x && x.uid)) : [];
    const team = [...new Set([r.host, ...listed.filter((u: number | null): u is number => u !== null && r.members.has(u))])].sort((a, b) => a - b);
    r.started = at;
    r.open = false;
    persist(r);
    if (team.length >= 2) store.saveGroupStart(r.host, team, at);
    tellRoom(r);
  }

  /**
   * ¿`members` es el equipo de la última partida en grupo que empezó `host` en su sala, y fue hace poco?
   * `runStart`: cuándo avisó el anfitrión al ranking de que empezaba (/api/ranking/start), o null; no puede
   * ser anterior a la partida (si no, el ranking le dejaría un margen de tiempo que no ha jugado).
   * Vale también tras reconexiones y reinicios (el equipo está en la base) y aunque la sala ya no exista.
   */
  function verifyTeam(host: number, members: number[], runStart: number | null) {
    const g = store.groupStart(host);
    if (!g || now() - g.started > START_MAX_AGE) return false;
    if (typeof runStart !== 'number' || runStart < g.started - 10_000) return false;
    const mine = [...new Set(members)].sort((a, b) => a - b);
    return mine.length === members.length && mine.length === g.team.length && mine.every((u, i) => u === g.team[i]);
  }

  // ---------------- cuentas borradas ----------------

  /**
   * Al borrar una cuenta (api.ts llama a db.deleteUser): fuera de su sala, sin invitaciones,
   * conexión cerrada y sus amigos se enteran. Se engancha aquí para no tocar api.ts.
   */
  const deleteUser = db.deleteUser;
  db.deleteUser = (id: number) => {
    const friends = store.friendIds(id);
    leaveRoom(id);
    dropAll(id);
    const c = conns.get(id);
    if (c) { c.gone = true; conns.delete(id); c.ws.close(4002, 'Cuenta borrada'); }
    deleteUser(id);
    for (const f of friends) send(f, { k: 'fr' });
  };

  const websocket: WebSocketHandler<WsData> = {
    open, message, close,
    maxPayloadLength: MAX_MSG,
    idleTimeout: 60,
    // Un cliente que no lee se desconecta; así nadie acumula memoria ni se pierden mensajes sueltos.
    backpressureLimit: 2 * 1024 * 1024,
    closeOnBackpressureLimit: true,
  };

  return {
    websocket,
    presence,
    /** Manda un mensaje a una cuenta si está conectada. */
    notify: send,
    /** Retira las invitaciones entre dos cuentas (al romper su amistad). */
    dropInvitesBetween(x: number, y: number) { dropInvite(x, y); dropInvite(y, x); },
    verifyTeam,
    stop() { stopped = true; clock.clearInterval(sweep); clock.clearInterval(keep); for (const t of awayT.values()) clock.clearTimeout(t); awayT.clear(); },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;
