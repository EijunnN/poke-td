/* ============ server/index.ts — servidor del juego (Bun) ============
 * Sirve lo que deja `bun run build` en dist/ y la API de cuentas y guardado
 * (server/api.ts) sobre SQLite (server/db.ts).
 *
 *   bun run build && bun run start          producción
 *   bun run server                          sólo la API, para `bun run dev`
 *
 * Variables de entorno:
 *   PORT       puerto (8080)
 *   DB_PATH    archivo de la base de datos (data/poke-td.sqlite)
 *   TRUST_PROXY=1  detrás de Caddy/nginx: la IP del jugador viene en X-Forwarded-For
 */
import { join, normalize, sep } from 'node:path';
import { openDb } from './db';
import { createApi } from './api';

const ROOT = join(import.meta.dir, '..');

/** Sprites, fuente e iconos no cambian nunca; lo empaquetado lleva huella en el nombre. */
const FOREVER = /^\/(assets|build)\//;

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  dist?: string;
  trustProxy?: boolean;
  /** Intentos de entrar o crear cuenta por IP y minuto. */
  loginLimit?: number;
}

export function startServer(o: ServerOptions = {}) {
  const dist = o.dist ?? join(ROOT, 'dist');
  const db = openDb(o.dbPath ?? join(ROOT, 'data', 'poke-td.sqlite'));
  const api = createApi(db, { loginLimit: o.loginLimit });

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
    async fetch(req, srv) {
      const ip = (o.trustProxy && (req.headers.get('x-forwarded-for') || '').split(',')[0].trim())
        || srv.requestIP(req)?.address || '?';
      const res = await api(req, ip);
      if (res) return res;
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      return serveFile(new URL(req.url).pathname);
    },
  });

  return { server, db, stop() { server.stop(true); db.close(); } };
}

if (import.meta.main) {
  const { server } = startServer({
    port: Number(process.env.PORT) || 8080,
    dbPath: process.env.DB_PATH,
    trustProxy: process.env.TRUST_PROXY === '1',
  });
  console.log(`poke-td en http://localhost:${server.port}`);
}
