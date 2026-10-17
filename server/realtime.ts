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
 *   { k:'room.join', id, dex, shiny }             entra en una sala a la que te han invitado (o pública)
 *   { k:'room.join', code, dex, shiny }           entra con el código de la sala (vale de invitación, también
 *                                                 en las privadas, sin ser amigos). Como mucho CODE_TRIES códigos
 *                                                 equivocados cada CODE_WINDOW ms por conexión
 *   { k:'room.recode' }                           (anfitrión) código nuevo: el viejo deja de valer
 *   { k:'room.kick', uid }                        (anfitrión, antes de empezar) saca a alguien de la sala; ya no
 *                                                 puede volver con el código ni desde la lista (con invitación, sí)
 *   { k:'room.leave' }                            sales (si eras el anfitrión, se cierra para todos)
 *   { k:'room.open', v }                          (anfitrión) admite o no jugadores nuevos
 *   { k:'room.me', dex, shiny }                   cambias de Pokémon
 *   { k:'room.spec', v }                          (no anfitrión, antes de empezar) sólo mirar: sigues en la sala, pero
 *                                                 al empezar no juegas, miras (no cuentas para el equipo ni el ranking)
 *   { k:'inv', to }                               (anfitrión) invita a un amigo
 *   { k:'inv.no', from }                          rechazas una invitación
 *   { k:'g', to?, d }                             mensaje de partida para otro miembro (o para todos si no hay `to`)
 *   { k:'room.pub', v, mode, map }                (anfitrión) sala pública o privada, y a qué se juega ('survivor', 'td' o
 *                                                 'arena', la Defensa en la que cada uno tiene su carril; de eso
 *                                                 depende cuántos caben: Survivor 4, Defensa según el mapa)
 *   { k:'rooms.list' }                            -> ack { rooms: [{ id, host, hostName, mode, map, n, max, started, watchers }] }
 *                                                 las salas públicas (para entrar sin invitación, o mirar si ya juegan)
 *   { k:'room.watch', id }                        mirar como espectador la partida de una sala pública -> ack { room, cfg }
 *   { k:'room.unwatch' }                          dejar de mirar
 *   { k:'mark', x, y }                            señal en el mapa de la partida en curso (miembros y espectadores);
 *                                                 como mucho PING_BURST cada PING_WINDOW ms
 *   { k:'chat', t } · { k:'chat', q }             chat de la sala (miembros y espectadores): texto libre `t` (sin
 *                                                 invisibles y como mucho CHAT_MAX letras; las palabras, tal cual: el
 *                                                 que quiera las censura en su juego) o frase rápida `q`
 *                                                 (src/data/quick-chat.ts). Como mucho CHAT_BURST mensajes
 *                                                 cada CHAT_WINDOW ms, y no el mismo texto dos veces seguidas.
 *
 * Servidor -> cliente:
 *   { k:'hello', uid, name, room }                al conectar (room: la sala en la que ya estabas, o null)
 *   { k:'pres', uid, online, play, room, seen? }  un amigo cambia de estado
 *   { k:'fr' }                                    cambió la lista de amigos (pídela por REST)
 *   { k:'inv', from, name, room, at } · { k:'invx', from }   invitación recibida / retirada
 *   { k:'room', room: { id, code, host, open, started, pub, mode, map, members:[{uid,name,dex,shiny,away,spec}], watchers:[{uid,name}] } | null, why? }
 *                                                 why: 'closed' · 'left' · 'timeout' · 'kicked' (te ha sacado el anfitrión)
 *   { k:'watch', room: <igual> | null, why? }     la sala que miras (null: se acabó la partida o se cerró)
 *   { k:'chat', f, n, t?, q?, at }                un mensaje del chat de tu sala (también el tuyo)
 *   { k:'mark', f, n, x, y }                      una señal en el mapa (también la tuya)
 *   { k:'chat.h', m: [<chat>] }                   los últimos mensajes, al entrar, mirar o volver a una sala
 *                                                 (sólo en memoria: tras un reinicio del servidor empieza vacío)
 *
 * Salas públicas: cualquiera con cuenta entra sin invitación mientras están en el vestíbulo (sin
 * ser amigos). Si ya juegan, sólo se puede MIRAR: el espectador no es miembro (no ocupa sitio ni
 * cuenta para el ranking); recibe del anfitrión la partida como un invitado más, y sólo puede
 * hablarle a él. Al acabar la partida (la sala se reabre) o cerrarse, los espectadores salen.
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
import { roomMax, MAX_ROOM } from '../src/modes/td-geom';
import { QUICK_IDS } from '../src/data/quick-chat';
import { cleanChat } from '../src/data/chat-filter';

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

/** Lo más que puede tener una sala (Defensa en el mapa más grande); cada sala, según a qué se juega (roomMax). */
export const MAX_PLAYERS = MAX_ROOM;
const MAX_MSG = 64 * 1024;
/** Cuántos pasos en falso (mensaje roto, sin permiso, a destiempo) aguanta una conexión antes de cerrarse. */
const MAX_BAD = 40;
const BAD_WINDOW = 10_000;
const MAX_OUT_INVITES = 8;
const ID = /^[A-Za-z0-9_-]{8,32}$/;
/** Chat: mensajes que guarda cada sala (para quien entra después), y el ritmo de cada uno. */
const CHAT_KEEP = 30, CHAT_BURST = 5, CHAT_WINDOW = 8_000, CHAT_REPEAT = 15_000;
/**
 * Código de sala: 6 letras y cifras sin las que se confunden (0/O, 1/I/L). 31^6 ≈ 887 millones;
 * con CODE_TRIES fallos por minuto, adivinar uno al azar es inviable.
 */
const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const CODE_TRIES = 8, CODE_WINDOW = 60_000;
/** El código tal y como lo escribe alguien (minúsculas, espacios, guiones) → como se guarda. */
export const normCode = (v: unknown) => typeof v === 'string' ? v.toUpperCase().replace(/[\s-]/g, '') : '';
/** Señales en el mapa: como mucho tantas cada tanto (más, se ignoran). */
const PING_BURST = 4, PING_WINDOW = 3_000;
/** Un mensaje del chat tal y como se reparte. */
interface ChatMsg { k: 'chat'; f: string; n: string; t?: string; q?: string; at: number }

/** `spec`: sólo mirará la partida (sólo en memoria: tras un reinicio del servidor vuelve a jugar). */
interface Member { uid: number; name: string; dex: number; shiny: boolean; spec?: boolean }
/**
 * Lo público de una sala: si sale en la lista, a qué se juega y la partida en curso (`cfg`, lo
 * que mandó el anfitrión al empezar; el espectador lo necesita para montar la suya).
 */
interface RoomInfo { pub: boolean; mode: 'survivor' | 'td' | 'arena'; map: string; cfg: Record<string, unknown> | null; code: string }
/** `started`: cuándo empezó la partida en grupo (0 si la sala sigue en el vestíbulo). */
interface Room {
  id: string; host: number; open: boolean; started: number; created: number; members: Map<number, Member>;
  info: RoomInfo; watchers: Map<number, { uid: number; name: string }>;
  /** Los últimos mensajes del chat (sólo en memoria). */
  chat: ChatMsg[];
  /** Los que ha sacado el anfitrión: no vuelven con el código ni desde la lista (sólo en memoria). */
  kicked: Set<number>;
}
/** Espectadores por sala, como mucho. */
export const MAX_WATCHERS = 8;
const newInfo = (): RoomInfo => ({ pub: false, mode: 'survivor', map: 'random', cfg: null, code: '' });
/** La información guardada (JSON) de una sala, con lo que falte por defecto. */
function readInfo(s: string | undefined): RoomInfo {
  const i = newInfo();
  try {
    const v = JSON.parse(s || '{}');
    if (v && typeof v === 'object') {
      i.pub = v.pub === true; i.mode = v.mode === 'td' || v.mode === 'arena' ? v.mode : 'survivor';
      if (typeof v.map === 'string' && v.map.length <= 20) i.map = v.map;
      if (v.cfg && typeof v.cfg === 'object') i.cfg = v.cfg;
      if (typeof v.code === 'string' && CODE_RE.test(v.code)) i.code = v.code;
    }
  } catch { /* JSON roto: por defecto */ }
  return i;
}
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
  /** Cuándo abrió esta conexión (para el panel interno, server/stats.ts). */
  since: number;
  msgs: number; bytes: number; t: number;
  bad: number; badT: number;
  /** Chat: cuándo mandó sus últimos mensajes, y el último texto. */
  chatAt: number[]; lastChat: string; lastChatAt: number;
  /** Cuándo lanzó sus últimas señales en el mapa. */
  pingAt: number[];
  /** Cuándo probó un código de sala que no existía. */
  codeMiss: number[];
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
  /** Quién se entera de cada conexión nueva (server/stats.ts: jugadores distintos por día). */
  const onOpen: ((id: number) => void)[] = [];

  const conns = new Map<number, Conn>();
  const rooms = new Map<string, Room>();
  const roomOf = new Map<number, Room>();
  /** Espectador -> la sala que mira. */
  const watchOf = new Map<number, Room>();
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

  /** Cuántos caben en la sala: Survivor, 4; Defensa, según el mapa (td-geom.ts, roomMax). */
  const maxOf = (r: Room) => roomMax(r.info.mode, r.info.map);
  /** Los de la sala que juegan (los que sólo miran no ocupan plaza: tienen su tope, MAX_WATCHERS). */
  const playersOf = (r: Room) => [...r.members.values()].filter(m => !m.spec).length;
  const snapshot = (r: Room) => ({
    id: r.id, code: r.info.code, host: String(r.host), open: r.open, started: r.started > 0, pub: r.info.pub, mode: r.info.mode, map: r.info.map, max: maxOf(r),
    members: [...r.members.values()].map(m => ({ uid: String(m.uid), name: m.name, dex: m.dex, shiny: m.shiny, away: !conns.has(m.uid), spec: !!m.spec })),
    watchers: [...r.watchers.values()].map(w => ({ uid: String(w.uid), name: w.name })),
  });
  const tellRoom = (r: Room, except?: number) => {
    const snap = snapshot(r);
    const s = text({ k: 'room', room: snap });
    for (const id of r.members.keys()) { const c = conns.get(id); if (c && id !== except) raw(c, s); }
    const w = text({ k: 'watch', room: snap });
    for (const id of r.watchers.keys()) { const c = conns.get(id); if (c && id !== except) raw(c, w); }
  };
  const persist = (r: Room) => store.saveRoom({
    id: r.id, host: r.host, open: r.open, started: r.started, created: r.created,
    members: [...r.members.values()].map(m => ({ uid: m.uid, dex: m.dex, shiny: m.shiny })),
    info: JSON.stringify(r.info),
  }, now());

  /** Un código que no tenga ninguna otra sala. */
  function newCode() {
    const used = new Set([...rooms.values()].map(r => r.info.code));
    for (;;) {
      const b = crypto.getRandomValues(new Uint8Array(6));
      const c = Array.from(b, x => CODE_ABC[x % CODE_ABC.length]).join('');
      if (!used.has(c)) return c;
    }
  }
  const byCode = (code: string) => [...rooms.values()].find(r => r.info.code === code);

  // ---------------- espectadores ----------------

  /** `id` deja de mirar (sin avisarle: se lo pide él, o se ha ido). */
  function unwatch(id: number) {
    const r = watchOf.get(id);
    if (!r) return;
    watchOf.delete(id);
    r.watchers.delete(id);
    tellRoom(r);
  }
  /** Fuera todos los espectadores de `r` (la partida ha acabado o la sala se cierra). */
  function dropWatchers(r: Room, why: string) {
    const s = text({ k: 'watch', room: null, why });
    for (const id of [...r.watchers.keys()]) { watchOf.delete(id); const c = conns.get(id); if (c) raw(c, s); }
    r.watchers.clear();
  }

  // Quien se desconecta de una sala tiene `roomGrace` para volver.
  function clearAway(id: number) { const t = awayT.get(id); if (t) { clock.clearTimeout(t); awayT.delete(id); } }
  function markAway(id: number) {
    if (!roomOf.has(id) || awayT.has(id)) return;
    const t = clock.setTimeout(() => { awayT.delete(id); if (!conns.has(id)) leaveRoom(id, 'timeout'); }, roomGrace);
    t.unref();
    awayT.set(id, t);
  }

  function closeRoom(r: Room, why: string, except?: number) {
    dropWatchers(r, why);
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
    const r: Room = { id: rec.id, host: rec.host, open: rec.open, started: rec.started, created: rec.created, members,
                      info: readInfo(rec.info), watchers: new Map(), chat: [], kicked: new Set() };
    // Salas de antes de los códigos (o con uno repetido): uno nuevo.
    if (!r.info.code || byCode(r.info.code)) { r.info.code = newCode(); rooms.set(r.id, r); persist(r); }
    rooms.set(r.id, r);
    for (const id of members.keys()) { roomOf.set(id, r); markAway(id); }
  }

  const validDex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_DEX;

  // ---------------- conexión ----------------

  function open(ws: ServerWebSocket<WsData>) {
    const u = ws.data.user;
    const c: Conn = { ws, id: u.id, name: u.name, play: false, gone: false, since: now(), msgs: msgBurst, bytes: byteBurst, t: now(), bad: 0, badT: 0,
                      chatAt: [], lastChat: '', lastChatAt: 0, pingAt: [], codeMiss: [] };
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
    if (mine) chatHistory(c, mine);
    if (mine) tellRoom(mine, u.id);                        // los demás ven que has vuelto
    for (const [from, iv] of invites.get(u.id) ?? []) {
      if (live(iv)) raw(c, text({ k: 'inv', from: String(from), name: db.userById(from)?.name ?? '?', room: iv.room, at: iv.at }));
    }
    pushPresence(u.id);
    for (const fn of onOpen) fn(u.id);
  }

  function close(ws: ServerWebSocket<WsData>) {
    const c = ws.data.c;
    if (stopped || !c || c.gone) return;         // servidor parado, o sustituida por otra pestaña: nada que limpiar
    c.gone = true;
    conns.delete(c.id);
    // Quien mira deja de mirar (al volver, que vuelva a pedirlo).
    unwatch(c.id);
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
        unwatch(c.id);
        const r: Room = { id: newRoomId(), host: c.id, open: true, started: 0, created: now(), members: new Map(), info: newInfo(), watchers: new Map(), chat: [], kicked: new Set() };
        r.info.code = newCode();
        r.members.set(c.id, { uid: c.id, name: c.name, dex: m.dex, shiny: m.shiny });
        rooms.set(r.id, r); roomOf.set(c.id, r);
        persist(r);
        pushPresence(c.id);
        return reply(true, { room: snapshot(r) });
      }

      case 'room.join': {
        const withCode = m.id === undefined && typeof m.code === 'string';
        if ((!withCode && (typeof m.id !== 'string' || !ID.test(m.id))) || !validDex(m.dex) || typeof m.shiny !== 'boolean') return bad('Mensaje no válido.');
        let r: Room | undefined;
        if (withCode) {
          // El código vale de invitación (también en las privadas). Los fallos, contados: nada de probar códigos al azar.
          const t = now();
          c.codeMiss = c.codeMiss.filter(x => t - x < CODE_WINDOW);
          if (c.codeMiss.length >= CODE_TRIES) return no('Demasiados códigos equivocados: espera un minuto.');
          const code = normCode(m.code);
          r = CODE_RE.test(code) ? byCode(code) : undefined;
          if (!r) { c.codeMiss.push(t); return no('No hay ninguna sala con ese código.'); }
        } else r = rooms.get(m.id);
        const cur = roomOf.get(c.id);
        if (cur && r && cur.id === r.id) return reply(true, { room: snapshot(cur) });
        if (r && r.kicked.has(c.id) && (withCode || r.info.pub) && !invites.get(c.id)?.get(r.host)) return no('El anfitrión te ha sacado de esa sala.');
        // En una sala pública se entra sin invitación (y sin ser amigos); en una privada, invitado por un amigo o con su código.
        if (!withCode && (!r || !r.info.pub)) {
          const iv = r && invites.get(c.id)?.get(r.host);
          if (!r || !iv || iv.room !== r.id) return no('Esa sala ya no existe o no te han invitado.');
          if (!live(iv)) { dropInvite(c.id, r.host); return no('La invitación ha caducado.'); }
          if (!store.isFriend(c.id, r.host)) { dropInvite(c.id, r.host); return no('Sólo puedes entrar en la sala de un amigo.'); }
        }
        if (!r) return no('Esa sala ya no existe.');
        if (!r.open) return no('La partida de esa sala ya ha empezado.');
        unwatch(c.id);
        if (playersOf(r) >= maxOf(r)) return no(`La sala está llena (máximo ${maxOf(r)}).`);
        if (cur) leaveRoom(c.id);
        dropInvite(c.id, r.host, false);
        r.members.set(c.id, { uid: c.id, name: c.name, dex: m.dex, shiny: m.shiny });
        roomOf.set(c.id, r);
        persist(r);
        tellRoom(r);
        pushPresence(c.id);
        reply(true, { room: snapshot(r) });
        chatHistory(c, r);
        return;
      }

      case 'room.leave': {
        leaveRoom(c.id, 'left');
        return reply(true);
      }

      case 'room.recode': {
        const r = roomOf.get(c.id);
        if (!r) return no('No estás en ninguna sala.');
        if (r.host !== c.id) return bad('Sólo el anfitrión gobierna la sala.');
        r.info.code = newCode();
        persist(r);
        tellRoom(r);
        return reply(true, { code: r.info.code });
      }

      case 'room.kick': {
        const who = parseUid(m.uid);
        if (who === null) return bad('Mensaje no válido.');
        const r = roomOf.get(c.id);
        if (!r) return no('No estás en ninguna sala.');
        if (r.host !== c.id) return bad('Sólo el anfitrión gobierna la sala.');
        if (who === c.id) return no('No puedes sacarte a ti mismo.');
        if (!r.members.has(who)) return no('Ya no está en la sala.');
        if (r.started) return no('La partida ya ha empezado.');
        r.kicked.add(who);
        dropInvite(who, r.host);
        send(who, { k: 'room', room: null, why: 'kicked' });
        leaveRoom(who, 'kicked');
        return reply(true);
      }

      case 'room.open': {
        if (typeof m.v !== 'boolean') return bad('Mensaje no válido.');
        const r = roomOf.get(c.id);
        if (!r) return no('No estás en ninguna sala.');
        if (r.host !== c.id) return bad('Sólo el anfitrión gobierna la sala.');
        if (r.open !== m.v) {
          r.open = m.v;
          if (m.v) { r.started = 0; r.info.cfg = null; dropWatchers(r, 'ended'); }   // la sala se reabre: la partida ha terminado
          persist(r);
          tellRoom(r);
        }
        return reply(true);
      }

      case 'room.pub': {
        if (typeof m.v !== 'boolean' || (m.mode !== 'survivor' && m.mode !== 'td' && m.mode !== 'arena') || typeof m.map !== 'string' || !/^[a-z]{1,20}$/.test(m.map)) return bad('Mensaje no válido.');
        const r = roomOf.get(c.id);
        if (!r) return no('No estás en ninguna sala.');
        if (r.host !== c.id) return bad('Sólo el anfitrión gobierna la sala.');
        if (r.info.pub !== m.v || r.info.mode !== m.mode || r.info.map !== m.map) {
          r.info.pub = m.v; r.info.mode = m.mode; r.info.map = m.map;
          persist(r);
          tellRoom(r);
        }
        return reply(true);
      }

      case 'rooms.list': {
        // Las públicas, primero las que esperan gente; nada de quién está dentro salvo el anfitrión.
        const out = [...rooms.values()].filter(r => r.info.pub && conns.has(r.host)).map(r => ({
          id: r.id, host: String(r.host), hostName: r.members.get(r.host)?.name ?? '?', mode: r.info.mode, map: r.info.map,
          n: playersOf(r), max: maxOf(r), started: r.started > 0, watchers: r.watchers.size,
        }));
        out.sort((a, b) => Number(a.started) - Number(b.started) || b.n - a.n);
        return reply(true, { rooms: out.slice(0, 50) });
      }

      case 'room.watch': {
        if (typeof m.id !== 'string' || !ID.test(m.id)) return bad('Mensaje no válido.');
        const r = rooms.get(m.id);
        if (!r || !r.info.pub) return no('Esa sala ya no existe o no es pública.');
        if (roomOf.get(c.id) === r) return no('Ya juegas en esa sala.');
        if (roomOf.has(c.id)) return no('Sal de tu sala para mirar otra partida.');
        if (!r.started || !r.info.cfg) return no('Esa sala aún no ha empezado: puedes entrar a jugar.');
        if (!r.watchers.has(c.id) && r.watchers.size >= MAX_WATCHERS) return no(`Ya hay ${MAX_WATCHERS} mirando esa partida.`);
        if (watchOf.get(c.id) !== r) unwatch(c.id);
        r.watchers.set(c.id, { uid: c.id, name: c.name });
        watchOf.set(c.id, r);
        tellRoom(r, c.id);
        reply(true, { room: snapshot(r), cfg: r.info.cfg });
        chatHistory(c, r);
        return;
      }

      case 'room.unwatch': {
        unwatch(c.id);
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

      case 'room.spec': {
        if (typeof m.v !== 'boolean') return bad('Mensaje no válido.');
        const r = roomOf.get(c.id);
        if (!r) return no('No estás en ninguna sala.');
        if (r.host === c.id) return no('El anfitrión juega siempre: es quien lleva la partida.');
        if (r.started) return no('La partida ya ha empezado.');
        const me = r.members.get(c.id)!;
        if (!!me.spec === m.v) return reply(true);
        if (m.v && r.members.size - playersOf(r) >= MAX_WATCHERS) return no(`Ya hay ${MAX_WATCHERS} mirando.`);
        if (!m.v && playersOf(r) >= maxOf(r)) return no('No queda sitio para jugar.');
        me.spec = m.v;
        tellRoom(r);
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
        if (playersOf(r) >= maxOf(r)) return no('La sala está llena.');
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
        // Un espectador sólo le habla al anfitrión (dónde está mirando), y nunca empieza nada.
        const w = watchOf.get(c.id);
        if (w && !roomOf.has(c.id)) {
          if (d.k === 'start' || parseUid(m.to) !== w.host) return no('Un espectador sólo habla con el anfitrión.');
          const hc = conns.get(w.host);
          if (hc) raw(hc, text({ k: 'g', f: String(c.id), d }));
          return;
        }
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
          // A un espectador sólo le habla el anfitrión (le manda la partida).
          if (!r.members.has(to) && !(r.watchers.has(to) && r.host === c.id)) return no('Ese jugador no está en tu sala.');
          targets = [to];
        }
        const s = text({ k: 'g', f: String(c.id), d });
        for (const t of targets) { const tc = conns.get(t); if (tc) raw(tc, s); }
        return;
      }

      case 'mark': {
        const r = roomOf.get(c.id) ?? watchOf.get(c.id);
        if (!r || !r.started) return no('No hay ninguna partida en curso.');
        const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6;
        if (!ok(m.x) || !ok(m.y)) return bad('Señal no válida.');
        const at = now();
        c.pingAt = c.pingAt.filter(x => at - x < PING_WINDOW);
        if (c.pingAt.length >= PING_BURST) return no('Demasiadas señales seguidas.');
        c.pingAt.push(at);
        const s = text({ k: 'mark', f: String(c.id), n: c.name, x: Math.round(m.x), y: Math.round(m.y) });
        for (const id of [...r.members.keys(), ...r.watchers.keys()]) { const tc = conns.get(id); if (tc) raw(tc, s); }
        return reply(true);
      }

      case 'chat': {
        const r = roomOf.get(c.id) ?? watchOf.get(c.id);
        if (!r) return no('No estás en ninguna sala.');
        const out: ChatMsg = { k: 'chat', f: String(c.id), n: c.name, at: now() };
        if (typeof m.q === 'string') {
          if (!QUICK_IDS.has(m.q)) return bad('Frase no válida.');
          out.q = m.q;
        } else if (typeof m.t === 'string' && m.t.length <= 2000) {
          const t = cleanChat(m.t);
          if (!t) return no('El mensaje está vacío.');
          out.t = t;
        } else return bad('Mensaje no válido.');
        // Ritmo: no cuenta como falta (es fácil pulsar de más), sólo no sale.
        c.chatAt = c.chatAt.filter(x => out.at - x < CHAT_WINDOW);
        if (c.chatAt.length >= CHAT_BURST) return no('Vas muy deprisa: espera un momento.');
        const said = out.t ?? '#' + out.q;
        if (said === c.lastChat && out.at - c.lastChatAt < CHAT_REPEAT) return no('Ya lo has dicho.');
        c.chatAt.push(out.at); c.lastChat = said; c.lastChatAt = out.at;
        r.chat.push(out);
        if (r.chat.length > CHAT_KEEP) r.chat.shift();
        const s = text(out);
        for (const id of [...r.members.keys(), ...r.watchers.keys()]) { const tc = conns.get(id); if (tc) raw(tc, s); }
        return reply(true);
      }

      default: return bad('Mensaje no válido.');
    }
  }

  /** Los últimos mensajes del chat de la sala, a quien acaba de entrar, mirar o volver. */
  function chatHistory(c: Conn, r: Room) { if (r.chat.length) raw(c, text({ k: 'chat.h', m: r.chat })); }

  // ---------------- partidas en grupo ----------------

  /**
   * El anfitrión manda `start`: se apunta el equipo REAL (los de `d.members` que de verdad están
   * en la sala; los demás se ignoran), y la sala pasa a "jugando" y se cierra a nuevos. El ranking
   * comprueba contra esto las marcas de grupo (verifyTeam).
   */
  function startGame(r: Room, d: Record<string, any>) {
    const at = now();
    const listed = Array.isArray(d.members) ? d.members.map((x: any) => parseUid(x && x.uid)) : [];
    // Los que juegan de verdad: de la sala y sin "sólo mirar".
    const plays = (u: number | null): u is number => u !== null && r.members.has(u) && !r.members.get(u)!.spec;
    const team = [...new Set([r.host, ...listed.filter(plays)])].sort((a, b) => a - b);
    r.started = at;
    r.open = false;
    // Lo que necesita un espectador para montar la partida (los nombres, los de la base).
    r.info.cfg = {
      k: 'start', seed: Number.isInteger(d.seed) ? d.seed : 0, host: String(r.host),
      mode: d.mode === 'td' ? 'td' : undefined, map: typeof d.map === 'string' && d.map.length <= 20 ? d.map : undefined,
      arena: d.mode === 'td' && d.arena === true ? true : undefined,
      // En el orden de la partida (de él salen los colores de cada uno).
      members: [...new Set<number>([...listed.filter(plays), r.host])].map(u => {
        const mm = r.members.get(u)!;
        return { uid: String(u), name: mm.name, dex: mm.dex, shiny: mm.shiny };
      }),
    };
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
    unwatch(id);
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
    /** Avisa de cada cuenta que se conecta. */
    onConnect(fn: (id: number) => void) { onOpen.push(fn); },
    /** Foto de ahora para el panel interno (server/stats.ts): quién está conectado y las salas. */
    overview() {
      const online = [...conns.values()].map(c => ({
        uid: String(c.id), name: c.name, play: c.play, since: c.since,
        room: roomOf.get(c.id)?.id ?? '', watching: watchOf.get(c.id)?.id ?? '',
      }));
      const list = [...rooms.values()].map(r => ({
        id: r.id, host: r.members.get(r.host)?.name ?? '?', pub: r.info.pub, mode: r.info.mode, map: r.info.map,
        started: r.started, created: r.created, max: maxOf(r),
        members: [...r.members.values()].map(m => ({ name: m.name, dex: m.dex, away: !conns.has(m.uid), spec: !!m.spec })),
        watchers: r.watchers.size,
      }));
      return { online, rooms: list };
    },
    stop() { stopped = true; clock.clearInterval(sweep); clock.clearInterval(keep); for (const t of awayT.values()) clock.clearTimeout(t); awayT.clear(); },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;
