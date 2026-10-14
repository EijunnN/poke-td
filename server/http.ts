/* ============ server/http.ts — utilidades HTTP compartidas por los módulos de la API ============ */
import type { User } from './db';

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
/** Error con un texto que se puede enseñar al jugador. */
export const fail = (status: number, error: string) => json({ ok: false, error }, status);

export const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');

/** Lo que cada petición a la API sabe de quién la hace. */
export interface Ctx {
  ip: string;
  /** La cuenta de la sesión (cabecera Authorization), o null. */
  user: User | null;
  /** SHA-256 del token de esa sesión (para cerrar las demás sesiones de la cuenta), o null. */
  session?: string | null;
  /** Ruta sin '/api' (p. ej. '/ranking/top') y método. */
  path: string;
  method: string;
}

/**
 * Un módulo de la API (ranking, amigos...): atiende las rutas que son suyas y
 * devuelve null con las demás. Ver createApi en server/api.ts.
 */
export type Module = (req: Request, ctx: Ctx) => Promise<Response | null> | Response | null;

/**
 * Límite de intentos por clave (IP, cuenta...): `max` en una ventana de
 * `windowMs`. @returns true si aún se permite
 */
export function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; t: number }>();
  return (key: string) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.t > windowMs) { hits.set(key, { n: 1, t: now }); if (hits.size > 50_000) hits.clear(); return true; }
    return ++h.n <= max;
  };
}

/** Cuerpo JSON (un objeto) con tope de tamaño. @returns el objeto, o una Response de error */
export async function readBody(req: Request, max = 8 * 1024): Promise<Record<string, any> | Response> {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > max) return fail(413, 'Demasiado grande.');
  let text: string;
  try { text = await req.text(); } catch { return fail(400, 'Petición no válida.'); }
  if (text.length > max) return fail(413, 'Demasiado grande.');
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : fail(400, 'Petición no válida.');
  } catch { return fail(400, 'Petición no válida.'); }
}
