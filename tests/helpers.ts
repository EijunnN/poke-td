/* ============ helpers.ts — servidor de pruebas sin red ============
 * Las pruebas de la API arrancan el servidor de verdad (server/index.ts) pero le
 * hablan DENTRO del mismo proceso (Bun: server.fetch), sin abrir conexiones:
 * es más rápido y no depende de la red local (con miles de conexiones, Windows
 * rechazaba alguna de vez en cuando y la prueba fallaba sin que el código tuviera culpa).
 * El WebSocket sí va por red: es justo lo que se prueba ahí.
 *
 * Uso: importar `startServer` de aquí en vez de '../server/index'. Los `fetch`
 * a http://127.0.0.1:<puerto de ese servidor> se atienden en el proceso.
 */
import { startServer as realStart, type ServerOptions } from '../server/index';

const servers = new Map<string, ReturnType<typeof realStart>>();
const realFetch = globalThis.fetch;

globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const s = (url.hostname === '127.0.0.1' || url.hostname === 'localhost') ? servers.get(url.port) : undefined;
  if (!s) return realFetch(input, init);
  return s.server.fetch(input instanceof Request ? new Request(input, init) : new Request(url.href, init));
}, { preconnect: realFetch.preconnect });

export function startServer(o: ServerOptions = {}) {
  const s = realStart(o);
  const port = String(s.server.port);
  servers.set(port, s);
  const stop = s.stop;
  return Object.assign(s, { stop() { servers.delete(port); stop(); } });
}
