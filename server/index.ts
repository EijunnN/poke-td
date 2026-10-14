/* ============ server/index.ts — servidor del juego (Bun) ============
 * Sirve lo que deja `bun run build` en dist/. Aquí irán también la API y el
 * tiempo real (cuentas, guardado, ranking, cooperativo) que sustituyen a Firebase.
 *
 *   bun run build && bun run start        PORT=8080 por defecto
 */
import { join, normalize, sep } from 'node:path';

const DIST = join(import.meta.dir, '..', 'dist');
const PORT = Number(process.env.PORT) || 8080;

/** Sprites, fuente e iconos no cambian nunca; lo empaquetado lleva huella en el nombre. */
const FOREVER = /^\/(assets|build)\//;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(DIST, path));
    if (file !== DIST && !file.startsWith(DIST + sep)) return new Response('Forbidden', { status: 403 });
    const body = Bun.file(file);
    if (!(await body.exists())) return new Response('Not found', { status: 404 });
    return new Response(body, {
      headers: { 'Cache-Control': FOREVER.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache' },
    });
  },
});

console.log(`poke-td en http://localhost:${PORT}`);
