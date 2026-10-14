import { G } from '../g';
import { Link, type ServerMsg } from './link';
/* ============ net.ts — mensajes entre los jugadores de una sala ============
 * Topología en estrella: el ANFITRIÓN habla con cada invitado; los invitados
 * sólo hablan con el anfitrión (él reenvía lo que haga falta).
 *
 * Todo pasa por el servidor del juego (el WebSocket de net/link.ts, que lo
 * retransmite a los miembros de la sala; ver server/realtime.ts). Antes iba
 * directo entre navegadores con WebRTC, pero eso necesitaba un servidor TURN
 * para las redes que no dejan conectar y no funcionaba en todas. Así funciona
 * en cualquier red, y el coste es una parada más de unos pocos ms.
 *
 * Un compañero que pierde la conexión (o todos, si se reinicia el servidor) sigue en la sala
 * unos segundos ('connecting'); si vuelve, el modo pasa otra vez a 'relay' y Coop le reenvía
 * el estado de la partida (ver coop.ts, resync). Los mensajes que se mandan mientras tanto se pierden.
 *
 * Mensajes: JSON, hasta 64 KB cada uno y unos 90 por segundo por jugador (el
 * servidor descarta lo que pase de eso). La partida manda unos 15 por segundo
 * (ver coop.ts).
 *
 * API:  open(roomId, isHost, hostUid) · close() · send(to, msg) · toHost(msg)
 *       broadcast(msg) · on(fn(from, msg)) · onPeer(fn(uid, state))
 *       peers() · mode(uid) -> 'connecting' | 'relay' | 'closed'
 */

/** 'relay': conectado (por el servidor). 'connecting': sin conexión con el servidor, reintentando. */
export type PeerMode = 'connecting' | 'relay' | 'closed';
type Peer = { mode: PeerMode };
type Msg = { k: string; [key: string]: any };

export const Net = (() => {
  /** Más de esto sin salir del navegador: la red va justa y se manda menos (ver coop.ts). */
  const CONGESTED = 64 * 1024;

  let roomId: string | null = null, isHost = false, hostUid: string | null = null;
  const peers = new Map<string, Peer>();
  let away = new Set<string>();       // miembros de la sala sin conexión (según el servidor)
  const handlers = new Set<(from: string, msg: Msg) => void>();
  const peerHandlers = new Set<(uid: string, mode: PeerMode) => void>();
  const stats = { sent: 0, recv: 0 };
  const myUid = () => (G.DB.session ? G.DB.session.uid : null);
  const modeOf = (u: string): PeerMode => (Link.status === 'open' && !away.has(u) ? 'relay' : 'connecting');

  function emitPeer(u: string) {
    const p = peers.get(u);
    peerHandlers.forEach(fn => { try { fn(u, p ? p.mode : 'closed'); } catch (e) { console.warn(e); } });
  }

  // ---------------- apertura ----------------

  function open(id: string, host: boolean, hostId: string) {
    if (roomId === id) return;
    close();
    roomId = id; isHost = host; hostUid = hostId;
    // Invitado: el anfitrión es su único compañero de conexión, desde ya.
    if (!isHost) { peers.set(hostId, { mode: modeOf(hostId) }); emitPeer(hostId); }
  }

  function close() {
    for (const u of [...peers.keys()]) drop(u);
    roomId = null; isHost = false; hostUid = null; away = new Set();
  }

  /** El anfitrión llama a esto cuando cambian los miembros de la sala. */
  function syncMembers(uids: string[], awayUids: string[] = []) {
    if (!roomId) return;
    away = new Set(awayUids);
    if (isHost) {
      for (const u of uids) if (u !== myUid() && !peers.has(u)) { peers.set(u, { mode: modeOf(u) }); emitPeer(u); }
      for (const u of [...peers.keys()]) if (!uids.includes(u)) drop(u);
    } else if (hostUid && !uids.includes(hostUid)) {
      drop(hostUid);
    }
    refreshModes();
  }

  /** Pasa a 'relay' o 'connecting' a quien haya cambiado (conexión propia o del compañero). */
  function refreshModes() {
    for (const [u, p] of peers) {
      const m = modeOf(u);
      if (p.mode !== m) { p.mode = m; emitPeer(u); }
    }
  }

  function drop(u: string, silent?: boolean) {
    const p = peers.get(u);
    if (!p) return;
    p.mode = 'closed';
    peers.delete(u);
    if (!silent) emitPeer(u);
  }

  // Si se cae la conexión con el servidor, todos quedan "conectando"; al volver, "relay" (y Coop reenvía el estado).
  Link.onStatus(refreshModes);

  // ---------------- envío / recepción ----------------

  /** @returns false si no ha salido (sin sala o sin conexión con el servidor) */
  function put(m: object) { if (!roomId || !Link.send(m)) return false; stats.sent++; return true; }

  function send(to: string, msg: Msg) { return put({ k: 'g', to, d: msg }); }
  function toHost(msg: Msg) { return !isHost && !!hostUid && send(hostUid, msg); }
  /** A todos los demás de la sala (menos `except`). */
  function broadcast(msg: Msg, except?: string) {
    if (!except) return put({ k: 'g', d: msg });
    let ok = false;
    for (const u of peers.keys()) if (u !== except) ok = send(u, msg) || ok;
    return ok;
  }

  function deliver(from: string, msg: Msg) {
    stats.recv++;
    handlers.forEach(fn => { try { fn(from, msg); } catch (e) { console.error('[Net] mensaje:', e); } });
  }

  Link.on((m: ServerMsg) => {
    if (m.k === 'g' && roomId && typeof m.f === 'string' && m.d && typeof m.d === 'object') deliver(m.f, m.d);
  });

  return {
    open, close, syncMembers, send, toHost, broadcast,
    on(fn: (from: string, msg: Msg) => void) { handlers.add(fn); }, off(fn: (from: string, msg: Msg) => void) { handlers.delete(fn); },
    onPeer(fn: (uid: string, mode: PeerMode) => void) { peerHandlers.add(fn); },
    mode(u: string): PeerMode { const p = peers.get(u); return p ? p.mode : 'closed'; },
    /** ¿La red va justa (sin conexión o con mensajes sin salir)? Entonces se manda menos a menudo. */
    slow(_u?: string) { return Link.status !== 'open' || Link.buffered > CONGESTED; },
    /** ¿Hay conexión con el servidor? (si no, lo que se manda se pierde) */
    get up() { return Link.status === 'open'; },
    peers() { return [...peers.keys()]; },
    get open_() { return !!roomId; },
    get isHost() { return isHost; },
    get uid() { return myUid(); },
    get hostUid() { return hostUid; },
    stats
  };
})();
G.Net = Net;

declare module '../g' {
  interface Registry { Net: typeof Net }
}
