import { G } from '../g';
import { Link, type ServerMsg } from './link';
import { QUICK, CHAT_MAX } from '../data/quick-chat';
import { maskBad } from '../data/chat-filter';
/* ============ chat.ts — el chat de la sala (lógica; lo que se ve está en ui/chat-ui.ts) ============
 * Los mensajes van por el servidor (server/realtime.ts), que quita invisibles,
 * corta los largos y limita el ritmo, pero no cambia ninguna palabra: el chat es
 * libre. Aquí se reciben, se guardan los de la sala actual y se decide qué se
 * enseña y cómo:
 *   - Ajustes → Chat: 'all' (todo), 'quick' (sólo frases rápidas de los demás) u 'off'.
 *   - Ajustes → Censurar palabrotas (desactivado de serie): tacha palabrotas y enlaces,
 *     sólo en lo que ves tú (data/chat-filter.ts).
 *   - Silenciar a alguien (se guarda en este navegador, por cuenta).
 * Cada mensaje que se enseña sale también como bocadillo sobre el héroe de quien
 * lo dice (Player.speak), si está en la partida.
 */

export interface ChatMsg { f: string; n: string; t?: string; q?: string; at: number }
export type ChatMode = 'all' | 'quick' | 'off';

export const Chat = (() => {
  const KEEP = 50;
  let log: ChatMsg[] = [];
  let roomId = '';
  const fns = new Set<(m: ChatMsg | null) => void>();
  /** Avisa a la interfaz: un mensaje nuevo, o null si cambió la lista entera. */
  const emit = (m: ChatMsg | null) => fns.forEach(fn => { try { fn(m); } catch (e) { console.warn(e); } });

  // ---------------- silenciados ----------------
  const muteKey = () => 'ps.chat.mute.' + (G.Social.uid || '');
  function muted(): Set<string> {
    try { return new Set(JSON.parse(localStorage.getItem(muteKey()) || '[]')); } catch (e) { return new Set(); }
  }
  function setMuted(uid: string, v: boolean) {
    const s = muted();
    if (v) s.add(uid); else s.delete(uid);
    try { localStorage.setItem(muteKey(), JSON.stringify([...s])); } catch (e) { /* sin almacenamiento: dura esta sesión */ }
    emit(null);
  }

  const mode = (): ChatMode => {
    const v = G.Settings.get('chat');
    return v === 'quick' || v === 'off' ? v : 'all';
  };
  const mine = (m: ChatMsg) => m.f === G.Social.uid;
  /** ¿Se enseña este mensaje? (ajuste de chat y silenciados; los tuyos, siempre) */
  function shown(m: ChatMsg): boolean {
    if (mine(m)) return mode() !== 'off';
    if (mode() === 'off' || muted().has(m.f)) return false;
    return mode() === 'all' || !!m.q;
  }
  /** El texto de un mensaje, en tu idioma si es una frase rápida. */
  function textOf(m: ChatMsg): string {
    if (m.q) { const q = QUICK.find(x => x.id === m.q); return q ? (G.I18n.lang === 'en' ? q.en : q.es) : ''; }
    return m.t ? (G.Settings.get('chatFilter') ? maskBad(m.t) : m.t) : '';
  }

  /** El bocadillo sobre el héroe de quien habla (si está en la partida). */
  function bubble(m: ChatMsg) {
    if (G.Game.state === 'ui' || !G.Game.player) return;
    for (const p of G.Game.everyone()) if (p && p.uid === m.f) { p.speak(textOf(m)); return; }
  }

  function add(m: ChatMsg) {
    log.push(m);
    if (log.length > KEEP) log.shift();
    if (shown(m)) { bubble(m); emit(m); }
  }

  const valid = (m: ServerMsg): m is ServerMsg & ChatMsg =>
    typeof m.f === 'string' && typeof m.n === 'string' && (typeof m.t === 'string' || typeof m.q === 'string');

  Link.on((m: ServerMsg) => {
    if (m.k === 'chat' && valid(m)) add({ f: m.f, n: m.n, t: m.t, q: m.q, at: +m.at || Date.now() });
    else if (m.k === 'chat.h' && Array.isArray(m.m)) {
      log = (m.m as ServerMsg[]).filter(valid).map(x => ({ f: x.f, n: x.n, t: x.t, q: x.q, at: +x.at || 0 })).slice(-KEEP);
      emit(null);
    }
  });

  // Otra sala (o ninguna): la conversación de antes ya no toca.
  const where = () => (G.Social.room && G.Social.room.id) || (G.Social.watching && G.Social.watching.room.id) || '';
  G.Social.on(() => {
    const now = where();
    if (now !== roomId) { roomId = now; log = []; emit(null); }
  });

  /** Respuesta del servidor a un envío: si no sale, se dice por qué. */
  async function post(body: { t?: string; q?: string }): Promise<boolean> {
    const r = await Link.request({ k: 'chat', ...body }).catch(() => null);
    if (r && r.ok) return true;
    G.UI.toast((r && r.error) || 'No se pudo enviar el mensaje.', 2200);
    return false;
  }

  return {
    QUICK, MAX: CHAT_MAX,
    /** ¿Hay con quién hablar? (en una sala o mirando una partida, y con el chat activado) */
    available: () => !!where() && mode() !== 'off',
    mode, shown, textOf, mine,
    send: (t: string) => post({ t: t.slice(0, CHAT_MAX) }),
    quick: (id: string) => post({ q: id }),
    /** Los mensajes de la sala que se enseñan, del más viejo al más nuevo. */
    visible: () => log.filter(shown),
    isMuted: (uid: string) => muted().has(uid),
    setMuted,
    on(fn: (m: ChatMsg | null) => void) { fns.add(fn); },
    /** Pruebas y capturas: como si llegara del servidor. */
    debugReceive(m: ChatMsg) { add(m); },
  };
})();
G.Chat = Chat;

declare module '../g' {
  interface Registry { Chat: typeof Chat }
}
