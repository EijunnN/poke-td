/* ============ fakes.ts — lo que comparten las pruebas deterministas ============
 * - FakeClock: reloj falso del SERVIDOR (server/realtime.ts); sólo avanza con `advance`.
 * - installHarness: arnés de las PÁGINAS (azar con semilla, reloj falso, fotogramas a mano).
 *   Se inyecta con addInitScript, así que debe ser autocontenida.
 * - installFakeNet: la red de las páginas, simulada: un WebSocket falso que no manda nada por
 *   la red (lo que envía queda en un buzón que la prueba recoge) y un contador de peticiones en vuelo.
 *
 * (Este archivo lo importan también pruebas que corren con `node` directamente, p. ej.
 * tests/adversarial.ts: sólo TypeScript que se pueda borrar sin transformar, sin enum ni
 * propiedades en el constructor.)
 */
import type { Clock, TimerHandle } from '../server/realtime';

declare const window: any;
declare const addEventListener: any;
declare const DOMException: any;

interface Timer { at: number; every: number; n: number; fn: () => void }

/**
 * El tiempo sólo avanza con `advance`, que dispara a su paso los temporizadores vencidos, en orden
 * (por hora y, a igual hora, por creación) y de forma síncrona. Por defecto empieza en la hora real
 * (para que lo que se apunta en la base sea coherente con lo que compara el ranking, que usa el reloj de verdad).
 */
export class FakeClock {
  t: number;
  private seq = 0;
  private timers = new Map<TimerHandle, Timer>();
  /** Tras cada temporizador disparado (para dar por cerradas las conexiones que el servidor haya cortado). */
  after: () => void = () => {};
  readonly clock: Clock = {
    now: () => this.t,
    setTimeout: (fn, ms) => this.add(fn, ms, 0),
    clearTimeout: h => { this.timers.delete(h); },
    setInterval: (fn, ms) => this.add(fn, ms, Math.max(1, ms)),
    clearInterval: h => { this.timers.delete(h); },
  };
  constructor(start: number = Date.now()) { this.t = start; }
  private add(fn: () => void, ms: number, every: number): TimerHandle {
    const h: TimerHandle = { unref() { return this; } };
    this.timers.set(h, { at: this.t + (every || Math.max(0, ms)), every, n: ++this.seq, fn });
    return h;
  }
  /** Cuántos temporizadores siguen armados. */
  get pending() { return this.timers.size; }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let best: [TimerHandle, Timer] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!best || e[1].at < best[1].at || (e[1].at === best[1].at && e[1].n < best[1].n))) best = e;
      if (!best) break;
      const [h, tm] = best;
      this.t = Math.max(this.t, tm.at);
      if (tm.every) tm.at += tm.every; else this.timers.delete(h);
      tm.fn();
      this.after();
    }
    this.t = end;
  }
}

/** Se inyecta antes que cualquier script del juego: azar con semilla, reloj falso y fotogramas a mano. */
export function installHarness() {
  let s = 1;
  const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  Math.random = rnd;
  let now = 1_000_000;
  const T0 = window.__T0 ?? 1_760_000_000_000;      // (las pruebas que lo necesitan lo fijan antes con addInitScript)
  performance.now = () => now;
  Date.now = () => T0 + now;
  let queue: ((ts: number) => void)[] = [];
  window.requestAnimationFrame = (cb: any) => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  // Temporizadores: reales durante el arranque; desde freeze() van con el reloj
  // falso (saltan dentro de frame()), para que no dependan de la carga de la máquina.
  type Timer = { id: number; due: number; fn: any; args: any[]; every: number };
  let frozen = false, tid = 1_000_000_000, timers: Timer[] = [];
  const real = { st: window.setTimeout.bind(window), si: window.setInterval.bind(window), ct: window.clearTimeout.bind(window), ci: window.clearInterval.bind(window) };
  const add = (fn: any, ms: any, args: any[], repeat: boolean) => {
    const d = Math.max(0, +ms || 0);
    timers.push({ id: ++tid, due: now + d, fn, args, every: repeat ? Math.max(1, d) : 0 });
    return tid;
  };
  const drop = (id: any) => { timers = timers.filter(t => t.id !== id); };
  window.setTimeout = (fn: any, ms: any, ...a: any[]) => frozen ? add(fn, ms, a, false) : real.st(fn, ms, ...a);
  window.setInterval = (fn: any, ms: any, ...a: any[]) => frozen ? add(fn, ms, a, true) : real.si(fn, ms, ...a);
  window.clearTimeout = (id: any) => { drop(id); real.ct(id); };
  window.clearInterval = (id: any) => { drop(id); real.ci(id); };
  const runTimers = () => {
    for (let guard = 0; guard < 10000; guard++) {
      let best: Timer | null = null;
      for (const t of timers) if (t.due <= now && (!best || t.due < best.due || (t.due === best.due && t.id < best.id))) best = t;
      if (!best) return;
      if (best.every) best.due += best.every; else drop(best.id);
      if (typeof best.fn === 'function') best.fn(...best.args);
    }
  };
  window.__errors = [];
  addEventListener('error', (e: any) => window.__errors.push('error: ' + (e.message || e)));
  addEventListener('unhandledrejection', (e: any) => window.__errors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
  window.__h = {
    seed(n: number) { s = n; },
    rnd,
    /** Avanza un fotograma de 1/60 s. */
    frame() { now += 1000 / 60; runTimers(); const q = queue; queue = []; for (const cb of q) cb(now); },
    freeze() { frozen = true; },
    ready() { return queue.length > 0; },
    /** Salta `ms` de reloj sin dibujar ni simular nada (sólo dispara los temporizadores vencidos). */
    jump(ms: number) { now += ms; runTimers(); },
    get now() { return now; },
  };
}

/**
 * Evento que la prueba le entrega a una página por su buzón de entrada:
 * `ev`: 'o' abrió · 'm' mensaje (`d`) · 'c' cerró (`code`). `c` es el id del socket.
 */
export interface NetIn { c: number; ev: 'o' | 'm' | 'c'; d?: string; code?: number }
/** Lo que la página saca por su buzón de salida: 'new' socket (`url`) · 'send' (`d`) · 'close' (`code`). */
export interface NetOut { c: number; t: 'new' | 'send' | 'close'; url?: string; d?: string; code?: number }

/**
 * Red simulada de la página. Se inyecta después de installHarness.
 *  - `WebSocket` hacia /ws?token=... es falso: no sale nada por la red. Lo que la página envía se acumula
 *    en `window.__net.out` y la prueba lo recoge con `__net.step(...)`. Cualquier otro WebSocket (p. ej. el de Vite) va tal cual.
 *  - `fetch` cuenta las peticiones en vuelo (hasta haber leído la respuesta) en `window.__net.pending`.
 */
export function installFakeNet() {
  const RealWS = window.WebSocket;
  const socks = new Map<number, any>();
  let nextId = 1;
  const net: any = { out: [] as any[], pending: 0 };
  class FakeWS {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    readyState = 0; bufferedAmount = 0; protocol = ''; extensions = ''; binaryType = 'blob';
    onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
    url = ""; id = 0;
    constructor(url: string, protocols?: any) {
      if (!/\/ws\?token=/.test(String(url))) return new RealWS(url, protocols);
      this.url = String(url);
      this.id = nextId++;
      socks.set(this.id, this);
      net.out.push({ c: this.id, t: 'new', url: this.url });
    }
    send(d: any) {
      if (this.readyState !== 1) throw new DOMException('WebSocket no está abierto', 'InvalidStateError');
      net.out.push({ c: this.id, t: 'send', d: String(d) });
    }
    close(code = 1000) {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      net.out.push({ c: this.id, t: 'close', code });
    }
    addEventListener() {}
    removeEventListener() {}
  }
  window.WebSocket = FakeWS;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (...a: any[]) => {
    net.pending++;
    try {
      const r = await realFetch(...a);
      await r.clone().arrayBuffer().catch(() => {});
      return r;
    } finally { net.pending--; }
  };
  /** Entrega eventos del servidor, en orden. */
  net.deliver = (evs: NetIn[]) => {
    for (const e of evs) {
      const s = socks.get(e.c);
      if (!s) continue;
      if (e.ev === 'o') { if (s.readyState === 0) { s.readyState = 1; s.onopen && s.onopen({}); } }
      else if (e.ev === 'm') { if (s.readyState === 1) s.onmessage && s.onmessage({ data: e.d }); }
      else {
        if (s.readyState === 3) continue;
        s.readyState = 3; socks.delete(e.c);
        s.onclose && s.onclose({ code: e.code ?? 1006, reason: '', wasClean: false });
      }
    }
  };
  /** Un paso: entrega, deja correr las promesas, juega `frames` fotogramas y devuelve (vaciando) el buzón de salida. */
  net.step = async (evs: NetIn[], frames: number, jump = 0) => {
    net.deliver(evs);
    if (jump) window.__h.jump(jump);
    for (let i = 0; i < frames; i++) { await null; window.__h.frame(); }
    await null;
    return net.out.splice(0);
  };
  window.__net = net;
}
