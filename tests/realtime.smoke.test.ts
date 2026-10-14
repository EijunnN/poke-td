/* ============ realtime.smoke.test.ts — el WebSocket de verdad ============
 * tests/social.test.ts prueba el módulo de tiempo real con conexiones simuladas y un reloj
 * falso. Aquí, sólo lo que únicamente se puede ver con un WebSocket real sobre la red local:
 * que Bun hace el apretón de manos con el token, rechaza lo que no lleva sesión válida, entrega
 * los mensajes a `rt.websocket` (ping/pong) y corta lo que pasa del tope de 64 KB por mensaje.
 *
 * Son las únicas pruebas de tiempo real que tocan la red. No hay esperas con tiempo fijo: cada
 * paso espera al evento que toca, y la prueba entera tiene su tope de tiempo.
 *
 *   bun test tests/realtime.smoke.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startServer } from './helpers';

let srv: ReturnType<typeof startServer>;
let base = '';
let token = '';
let uid = '';
let name = '';

beforeAll(async () => {
  srv = startServer({ port: 0, dbPath: ':memory:', loginLimit: 100 });
  base = `http://127.0.0.1:${srv.server.port}`;
  name = 'Humo' + Math.random().toString(36).slice(2, 7);
  const res = await fetch(base + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pass: 'secreta1' }),
  });
  expect(res.status).toBe(200);
  const j = await res.json() as { token: string; uid: string };
  token = j.token; uid = j.uid;
});
afterAll(() => srv.stop());

/** Un WebSocket de verdad que guarda lo que llega y deja esperar a un mensaje o al cierre. */
class Wire {
  ws: WebSocket;
  msgs: any[] = [];
  closed: { code: number } | null = null;
  private waiters: (() => void)[] = [];
  /** Se resuelve al abrirse y se rechaza si el servidor no deja abrir. */
  opened: Promise<void>;
  constructor(query: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${srv.server.port}/ws${query}`);
    this.opened = new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('no abre'));
      this.ws.onclose = e => { this.closed = { code: e.code }; rej(new Error('cerrado sin abrir')); this.wake(); };
    });
    this.opened.catch(() => {});
    this.ws.onmessage = e => { this.msgs.push(JSON.parse(String(e.data))); this.wake(); };
  }
  private wake() { for (const w of this.waiters.splice(0)) w(); }
  /** Espera (y consume) el primer mensaje que cumpla `pred`; el tope lo pone el de la prueba. */
  async take(pred: (m: any) => boolean): Promise<any> {
    for (;;) {
      const k = this.msgs.findIndex(pred);
      if (k >= 0) return this.msgs.splice(k, 1)[0];
      if (this.closed) throw new Error('se cerró (' + this.closed.code + ') sin que llegara el mensaje esperado');
      await new Promise<void>(r => this.waiters.push(r));
    }
  }
  async waitClosed() {
    while (!this.closed) await new Promise<void>(r => this.waiters.push(r));
    return this.closed;
  }
}

describe('WebSocket de verdad', () => {
  test('con token abre, recibe el hello y contesta al ping', async () => {
    const w = new Wire('?token=' + token);
    try {
      await w.opened;
      expect(await w.take(m => m.k === 'hello')).toEqual({ k: 'hello', uid, name, room: null });
      w.ws.send(JSON.stringify({ k: 'ping' }));
      await w.take(m => m.k === 'pong');
      w.ws.send(JSON.stringify({ k: 'room.new', i: 1, dex: 25, shiny: false }));
      expect((await w.take(m => m.k === 'ack' && m.i === 1)).ok).toBe(true);
    } finally { w.ws.close(); }
  });

  test('sin token, con token falso o de una sesión cerrada no abre', async () => {
    for (const q of ['', '?token=', '?token=falso', '?token=' + 'a'.repeat(43)]) {
      const w = new Wire(q);
      await expect(w.opened).rejects.toThrow();
      expect(w.msgs).toEqual([]);
    }
    // Una sesión cerrada ya no vale.
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pass: 'secreta1' }) });
    const t2 = (await r.json() as { token: string }).token;
    await fetch(base + '/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t2 } });
    const w = new Wire('?token=' + t2);
    await expect(w.opened).rejects.toThrow();
  });

  test('un mensaje de más de 64 KB cierra la conexión', async () => {
    const w = new Wire('?token=' + token);
    await w.opened;
    await w.take(m => m.k === 'hello');
    w.ws.send(JSON.stringify({ k: 'g', d: { k: 'f', pad: 'x'.repeat(100_000) } }));
    // Bun corta el socket al pasarse del tope (1009 en el protocolo; el cliente puede ver 1006).
    expect([1009, 1006]).toContain((await w.waitClosed()).code);
  });
});
