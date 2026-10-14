/* ============ link.ts — la conexión WebSocket con el servidor ============
 * Una sola para todo lo que va en directo (ver server/realtime.ts): "en línea" de los
 * amigos, invitaciones, salas y el tráfico de la partida en grupo. Social y Net la
 * comparten. Reconecta sola con espera creciente mientras se quiera estar conectado
 * (con `eager`, p. ej. dentro de una sala o partida, esperando como mucho 3 s entre intentos:
 * el servidor sólo guarda el sitio unos segundos, ver server/realtime.ts).
 */

export type LinkStatus = 'closed' | 'connecting' | 'open';

/** Lo que manda el servidor (ver server/realtime.ts). */
export interface ServerMsg { k: string; [key: string]: any }
/** Respuesta a una orden: { ok, error?, ...datos }. */
export interface Reply { ok: boolean; error?: string; [key: string]: any }

/** Códigos con los que el servidor cierra y que NO se reintentan: otra pestaña tomó la sesión, o se borró la cuenta. */
const NO_RETRY = new Set([4001, 4002]);
const PING_EVERY = 20_000, DEAD_AFTER = 55_000, REQUEST_TIMEOUT = 8_000;

export const Link = (() => {
  let ws: WebSocket | null = null;
  let token = '', want = false, status: LinkStatus = 'closed';
  let tries = 0, retryT = 0, beatT = 0, lastRx = 0, seq = 0, eager = false;
  const waiting = new Map<number, { done: (r: Reply) => void; timer: number }>();
  const msgFns = new Set<(m: ServerMsg) => void>();
  const statusFns = new Set<(s: LinkStatus, code?: number) => void>();

  function setStatus(s: LinkStatus, code?: number) {
    if (status === s) return;
    status = s;
    statusFns.forEach(fn => { try { fn(s, code); } catch (e) { console.warn(e); } });
  }

  function url() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?token=' + encodeURIComponent(token);
  }

  function open() {
    clearTimeout(retryT);
    setStatus('connecting');
    let sock: WebSocket;
    try { sock = ws = new WebSocket(url()); }
    catch (e) { retry(); return; }
    sock.onopen = () => {
      if (ws !== sock) return;
      tries = 0; lastRx = Date.now();
      clearInterval(beatT);
      beatT = window.setInterval(() => {
        if (Date.now() - lastRx > DEAD_AFTER) { sock.close(); return; }     // se cayó sin avisar
        send({ k: 'ping' });
      }, PING_EVERY);
      setStatus('open');
    };
    sock.onmessage = e => {
      lastRx = Date.now();
      let m: ServerMsg;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (!m || typeof m.k !== 'string') return;
      if (m.k === 'ack') {
        const w = waiting.get(m.i);
        if (w) { waiting.delete(m.i); clearTimeout(w.timer); w.done(m as unknown as Reply); }
        return;
      }
      msgFns.forEach(fn => { try { fn(m); } catch (err) { console.error('[Link] mensaje:', err); } });
    };
    sock.onclose = e => {
      if (ws !== sock) return;
      ws = null;
      clearInterval(beatT);
      for (const [i, w] of waiting) { clearTimeout(w.timer); w.done({ ok: false, error: 'Se ha perdido la conexión con el servidor.' }); waiting.delete(i); }
      setStatus('closed', e.code);
      if (want && !NO_RETRY.has(e.code)) retry();
      else want = false;
    };
  }

  function retry() {
    setStatus('closed');
    clearTimeout(retryT);
    const wait = Math.min(eager ? 3000 : 30_000, 1000 * 2 ** Math.min(tries++, 5)) * (0.75 + Math.random() * 0.5);
    retryT = window.setTimeout(() => { if (want) open(); }, wait);
  }

  /** @returns true si se ha mandado (la conexión está abierta) */
  function send(m: object): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  }

  return {
    /** Abre la conexión con la sesión `tok` y la mantiene. */
    connect(tok: string) {
      if (want && tok === token) return;
      Link.disconnect();
      token = tok; want = true; tries = 0;
      open();
    },
    /** Cierra y deja de reconectar. */
    disconnect() {
      want = false; token = '';
      clearTimeout(retryT); clearInterval(beatT);
      const s = ws; ws = null;
      if (s) { try { s.close(); } catch (e) { /* nada */ } }
      for (const [i, w] of waiting) { clearTimeout(w.timer); w.done({ ok: false, error: 'Sin conexión.' }); waiting.delete(i); }
      setStatus('closed');
    },
    send,
    /** Reconexión con prisa (dentro de una sala). */
    setEager(v: boolean) { eager = v; },
    /** Manda una orden y espera su respuesta. Nunca lanza: sin conexión o sin respuesta, { ok:false, error }. */
    request(m: object, ms = REQUEST_TIMEOUT): Promise<Reply> {
      return new Promise(done => {
        const i = ++seq;
        const timer = window.setTimeout(() => { waiting.delete(i); done({ ok: false, error: 'El servidor no responde.' }); }, ms);
        waiting.set(i, { done, timer });
        if (!send({ ...m, i })) { waiting.delete(i); clearTimeout(timer); done({ ok: false, error: 'Sin conexión con el servidor.' }); }
      });
    },
    on(fn: (m: ServerMsg) => void) { msgFns.add(fn); },
    onStatus(fn: (s: LinkStatus, code?: number) => void) { statusFns.add(fn); },
    get status() { return status; },
    /** Bytes que el navegador aún no ha podido enviar (la red va lenta). */
    get buffered() { return ws ? ws.bufferedAmount : 0; },
  };
})();
