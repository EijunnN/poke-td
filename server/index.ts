/* ============ server/index.ts — servidor del juego (Bun) ============
 * Sirve lo que deja `bun run build` en dist/ y la API de cuentas y guardado
 * (server/api.ts) sobre SQLite (server/db.ts). El panel interno (public/admin.html) lee
 * sus métricas de server/stats.ts.
 *
 *   bun run build && bun run start          producción
 *   bun run server                          sólo la API, para `bun run dev`
 *
 * Variables de entorno:
 *   PORT       puerto (8080)
 *   DB_PATH    archivo de la base de datos (data/poke-td.sqlite)
 *   TRUST_PROXY=1  detrás de Caddy/nginx: la IP del jugador viene en X-Forwarded-For
 *   ROOM_GRACE_MS  cuánto espera una sala a quien se desconecta antes de sacarlo (45000)
 */
import { join, normalize, sep } from 'node:path';
import { openDb } from './db';
import { createApi } from './api';
import type { Module } from './http';
import { createRealtime, type RealtimeOptions } from './realtime';
import { createRanking } from './ranking';
import { createArena } from './arena';
import { createSocial } from './social';
import { createAccount } from './account';
import { createStats } from './stats';

const ROOT = join(import.meta.dir, '..');

/** Sprites, fuente e iconos no cambian nunca; lo empaquetado lleva huella en el nombre. */
const FOREVER = /^\/(assets|build)\//;

/** /s/<código> → /?sala=<código> (el juego usa rutas relativas: no puede abrirse desde /s/). */
export function roomLink(path: string) {
  const m = /^\/s\/([A-Za-z0-9-]{4,12})\/?$/.exec(path);
  return m ? new Response(null, { status: 302, headers: { Location: '/?sala=' + m[1].toUpperCase(), 'Cache-Control': 'no-store' } }) : null;
}

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  dist?: string;
  trustProxy?: boolean;
  /** Intentos de entrar o crear cuenta por IP y minuto. */
  loginLimit?: number;
  /** Mínimo entre dos guardados de una cuenta, en ms (SAVE_GAP; las pruebas lo bajan). */
  saveGapMs?: number;
  /** Límites del WebSocket (pruebas). */
  realtime?: RealtimeOptions;
}

export function startServer(o: ServerOptions = {}) {
  const dist = o.dist ?? join(ROOT, 'dist');
  const db = openDb(o.dbPath ?? join(ROOT, 'data', 'poke-td.sqlite'));
  // Tiempo real (presencia, invitaciones, salas, cooperativo): WebSocket en /ws?token=...
  const rt = createRealtime(db, o.realtime);
  // Módulos de la API: cada uno con sus rutas y sus tablas.
  // Las marcas de grupo del ranking sólo valen para el equipo que de verdad empezó una partida junto
  // (lo apunta realtime cuando el anfitrión manda `start`) y no antes de que el anfitrión avisara al ranking.
  // Con el mismo reloj que el tiempo real (en las pruebas, uno falso): verifyTeam compara sus horas.
  const clock = o.realtime?.clock;
  const ranking = createRanking(db, { verifyTeam: rt.verifyTeam, now: clock ? () => clock.now() : undefined });
  // Podio y victorias de la Arena: mismo equipo verificado y mismo reloj. Va antes que el ranking, que contesta 404 a todo /ranking/...
  const arena = createArena(db, { verifyTeam: rt.verifyTeam, now: clock ? () => clock.now() : undefined });
  // Métricas del panel interno (/admin.html): después del ranking y del tiempo real, que crean las tablas que lee.
  const stats = createStats(db, rt, { clock });
  const modules: Module[] = [createAccount(db, { perIp: o.loginLimit }), arena, ranking, createSocial(db, rt), stats.module];
  const api = createApi(db, { loginLimit: o.loginLimit, saveGapMs: o.saveGapMs, modules });

  async function serveFile(pathname: string) {
    let path = pathname;
    try { path = decodeURIComponent(path); } catch { return new Response('Bad request', { status: 400 }); }
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(dist, path));
    if (file !== dist && !file.startsWith(dist + sep)) return new Response('Forbidden', { status: 403 });
    const body = Bun.file(file);
    if (!(await body.exists())) return new Response('Not found', { status: 404 });
    return new Response(body, {
      headers: { 'Cache-Control': FOREVER.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache' },
    });
  }

  const server = Bun.serve({
    port: o.port ?? 8080,
    websocket: rt.websocket,
    async fetch(req, srv) {
      // Detrás de Caddy, la IP real es la ÚLTIMA de X-Forwarded-For (la que añade Caddy): las
      // anteriores las puede inventar el jugador para saltarse los límites de intentos.
      const ip = (o.trustProxy && (req.headers.get('x-forwarded-for') || '').split(',').pop()!.trim())
        || srv?.requestIP(req)?.address || '?';
      if (new URL(req.url).pathname === '/ws') {
        const s = api.whoToken(new URL(req.url).searchParams.get('token'));
        if (!s) return new Response('Sesión caducada', { status: 401 });
        return srv?.upgrade(req, { data: { user: s.user } }) ? undefined : new Response('Se esperaba un WebSocket', { status: 400 });
      }
      // Enlace de una sala (/s/K7QM4X): al juego, que entra en ella (src/ui/rooms-ui.ts, fromLink).
      const link = roomLink(new URL(req.url).pathname);
      if (link) return link;
      const res = await api.handle(req, ip);
      if (res) return res;
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      return serveFile(new URL(req.url).pathname);
    },
  });

  return { server, db, rt, stats, stop() { stats.stop(); rt.stop(); server.stop(true); db.close(); } };
}

if (import.meta.main) {
  const { server } = startServer({
    port: Number(process.env.PORT) || 8080,
    dbPath: process.env.DB_PATH,
    trustProxy: process.env.TRUST_PROXY === '1',
    realtime: process.env.ROOM_GRACE_MS ? { roomGrace: Number(process.env.ROOM_GRACE_MS) } : undefined,
  });
  console.log(`poke-td en http://localhost:${server.port}`);
}
