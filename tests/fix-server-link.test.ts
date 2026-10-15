/* ============ fix-server-link.test.ts — Link (src/net/link.ts) con una segunda pestaña ============
 * El servidor cierra la conexión vieja con 4001 cuando la misma cuenta abre otra (server/realtime.ts).
 * La vieja no debe reintentar en bucle y tiene que avisar para que la interfaz lo diga.
 *
 *   bun test tests/fix-server-link.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: any; onmessage: any; onclose: any;
  constructor(public url: string) { FakeSocket.all.push(this); }
  open() { this.readyState = 1; this.onopen?.({}); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  send() { /* nada */ }
}

const g = globalThis as any;
const saved = { WebSocket: g.WebSocket, window: g.window, location: g.location };
const realSetTimeout = g.setTimeout;
g.WebSocket = FakeSocket;
g.window = g;
g.location = { protocol: 'http:', host: 'localhost' };
// Sin esperas: la reconexión (segundos) se dispararía al momento si la hubiera.
g.setTimeout = (fn: () => void) => realSetTimeout(fn, 0);
afterAll(() => { Object.assign(g, saved); g.setTimeout = realSetTimeout; });

const { Link } = await import('../src/net/link');
const tick = () => new Promise(r => realSetTimeout(r, 20));

describe('Link: sesión tomada por otra pestaña (4001)', () => {
  test('no reintenta, avisa, y se puede recuperar', async () => {
    const taken: boolean[] = [];
    Link.onTaken(t => taken.push(t));
    Link.connect('tok');
    expect(FakeSocket.all.length).toBe(1);
    FakeSocket.all[0].open();
    expect(Link.status).toBe('open');
    expect(Link.taken).toBe(false);

    FakeSocket.all[0].close(4001);                 // el servidor: sesión abierta en otro sitio
    await tick();
    expect(Link.status).toBe('closed');
    expect(Link.taken).toBe(true);
    expect(taken).toEqual([true]);
    expect(FakeSocket.all.length).toBe(1);         // sin bucle de reconexión

    Link.resume();                                 // "usar aquí"
    expect(Link.taken).toBe(false);
    expect(taken).toEqual([true, false]);
    expect(FakeSocket.all.length).toBe(2);
    expect(FakeSocket.all[1].url).toContain('token=tok');
    FakeSocket.all[1].open();
    expect(Link.status).toBe('open');
    Link.resume();                                 // sin estar desplazada no hace nada
    expect(FakeSocket.all.length).toBe(2);
  });

  test('una caída normal sigue reconectando y no marca "tomada"', async () => {
    Link.disconnect();
    const n = FakeSocket.all.length;
    Link.connect('tok2');
    FakeSocket.all[n].open();
    FakeSocket.all[n].close(1006);
    expect(Link.taken).toBe(false);
    await tick(); await tick();
    // (la espera del primer reintento es de ~1 s: aquí basta con no estar "tomada")
    expect(Link.taken).toBe(false);
    Link.disconnect();
  });

  test('cerrar sesión (disconnect) olvida el estado de tomada', async () => {
    const n = FakeSocket.all.length;
    Link.connect('tok3');
    FakeSocket.all[n].open();
    FakeSocket.all[n].close(4001);
    expect(Link.taken).toBe(true);
    Link.disconnect();
    expect(Link.taken).toBe(false);
    Link.resume();                                 // sin token no abre nada
    expect(FakeSocket.all.length).toBe(n + 1);
  });
});
