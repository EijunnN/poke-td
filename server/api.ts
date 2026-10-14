/* ============ server/api.ts — API de cuentas y guardado ============
 * Todo es JSON bajo /api. La sesión va en la cabecera `Authorization: Bearer <token>`.
 *
 *   POST   /api/register  { name, pass }      -> { ok, token, name }
 *   POST   /api/login     { name, pass }      -> { ok, token, name }
 *   POST   /api/logout                        -> { ok }
 *   GET    /api/me                            -> { ok, name }
 *   GET    /api/save                          -> { ok, save, ver }   (save null si no hay)
 *   PUT    /api/save      { save, base }      -> { ok, ver } | 409 { ok:false, save, ver }
 *   DELETE /api/account   { pass }            -> { ok }
 *   GET    /api/health                        -> { ok }
 *
 * Guardado sin pisarse: el cliente manda la versión que leyó (`base`). Si otro
 * dispositivo ha guardado entre medias, responde 409 con la partida de la base;
 * el cliente la FUSIONA con la suya (src/core/db.ts, merge) y vuelve a mandar.
 *
 * Errores: { ok: false, error } con un texto que se puede enseñar al jugador.
 */
import type { Db } from './db';

/** Igual que en el cliente (src/core/db.ts). */
const VALID_NAME = /^[A-Za-z0-9_ñÑáéíóúÁÉÍÓÚ]{3,16}$/;
const MIN_PASS = 6, MAX_PASS = 200;
/** Tamaño máximo de una partida guardada (JSON). Las reales rondan unos pocos KB. */
export const MAX_SAVE = 512 * 1024;
/** Una sesión sin usar en 60 días caduca. */
const SESSION_TTL = 60 * 24 * 3600 * 1000;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (status: number, error: string) => json({ ok: false, error }, status);

const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');
const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

/**
 * Límite de intentos por IP para entrar y crear cuentas (contra quien prueba
 * contraseñas a lo bruto): `max` en una ventana de `windowMs`.
 */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; t: number }>();
  return (ip: string) => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.t > windowMs) { hits.set(ip, { n: 1, t: now }); if (hits.size > 50_000) hits.clear(); return true; }
    return ++h.n <= max;
  };
}

/** Cuerpo JSON con tope de tamaño. @returns el objeto, o una Response de error */
async function body(req: Request, max = 8 * 1024): Promise<any | Response> {
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

export function createApi(db: Db, opts: { loginLimit?: number } = {}) {
  const authLimit = limiter(opts.loginLimit ?? 20, 60_000);
  db.pruneSessions(Date.now() - SESSION_TTL);

  function openSession(userId: number) {
    const token = newToken();
    db.addSession(sha256(token), userId);
    return token;
  }

  /** Usuario de la sesión de la petición, o null. */
  function who(req: Request) {
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get('authorization') || '');
    if (!m) return null;
    const hash = sha256(m[1]);
    const s = db.session(hash);
    if (!s) return null;
    if (Date.now() - s.seen > SESSION_TTL) { db.deleteSession(hash); return null; }
    if (Date.now() - s.seen > 3600_000) db.touchSession(hash);
    const user = db.userById(s.user_id);
    return user ? { user, hash } : null;
  }

  async function register(req: Request, ip: string) {
    if (!authLimit(ip)) return fail(429, 'Demasiados intentos seguidos. Espera un poco.');
    const b = await body(req);
    if (b instanceof Response) return b;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const pass = typeof b.pass === 'string' ? b.pass : '';
    if (!VALID_NAME.test(name)) return fail(400, 'El nombre debe tener 3-16 letras, números o _.');
    if (pass.length < MIN_PASS) return fail(400, `La contraseña debe tener al menos ${MIN_PASS} caracteres.`);
    if (pass.length > MAX_PASS) return fail(400, 'La contraseña es demasiado larga.');
    const key = name.toLowerCase();
    if (db.userByKey(key)) return fail(409, 'Ese nombre ya existe.');
    const hash = await Bun.password.hash(pass, { algorithm: 'argon2id' });
    let id: number;
    // Dos registros a la vez con el mismo nombre: la base (UNIQUE) sólo deja uno.
    try { id = db.addUser(name, key, hash); } catch { return fail(409, 'Ese nombre ya existe.'); }
    return json({ ok: true, token: openSession(id), name });
  }

  async function login(req: Request, ip: string) {
    if (!authLimit(ip)) return fail(429, 'Demasiados intentos seguidos. Espera un poco.');
    const b = await body(req);
    if (b instanceof Response) return b;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const pass = typeof b.pass === 'string' ? b.pass : '';
    const user = name.length <= 16 ? db.userByKey(name.toLowerCase()) : null;
    // Con nombre inexistente también se calcula un hash: así no se nota por el tiempo de respuesta.
    const ok = user ? await Bun.password.verify(pass, user.pass) : (await Bun.password.hash(pass || 'x', { algorithm: 'argon2id' }), false);
    if (!user || !ok || pass.length > MAX_PASS) return fail(401, 'Usuario o contraseña incorrectos.');
    return json({ ok: true, token: openSession(user.id), name: user.name });
  }

  async function getSave(userId: number) {
    const r = db.save(userId);
    return json({ ok: true, save: r ? JSON.parse(r.data) : null, ver: r ? r.ver : 0 });
  }

  async function putSave(req: Request, userId: number) {
    const b = await body(req, MAX_SAVE);
    if (b instanceof Response) return b;
    const save = b.save, base = b.base;
    if (!save || typeof save !== 'object' || Array.isArray(save)) return fail(400, 'Partida no válida.');
    if (!Number.isInteger(base) || base < 0) return fail(400, 'Versión no válida.');
    const ver = db.putSave(userId, JSON.stringify(save), base);
    if (ver != null) return json({ ok: true, ver });
    const cur = db.save(userId);
    return json({ ok: false, error: 'Otra sesión ha guardado antes.', save: cur ? JSON.parse(cur.data) : null, ver: cur ? cur.ver : 0 }, 409);
  }

  async function deleteAccount(req: Request, ip: string, user: { id: number; pass: string }) {
    if (!authLimit(ip)) return fail(429, 'Demasiados intentos seguidos. Espera un poco.');
    const b = await body(req);
    if (b instanceof Response) return b;
    const pass = typeof b.pass === 'string' ? b.pass : '';
    if (!pass || !(await Bun.password.verify(pass, user.pass))) return fail(401, 'Contraseña incorrecta.');
    db.deleteUser(user.id);           // sesiones y partida se borran en cascada
    return json({ ok: true });
  }

  /** Atiende /api/*. @returns null si la ruta no es de la API */
  return async function handle(req: Request, ip: string): Promise<Response | null> {
    const { pathname } = new URL(req.url);
    if (!pathname.startsWith('/api/')) return null;
    const route = req.method + ' ' + pathname;
    try {
      if (route === 'GET /api/health') return json({ ok: true });
      if (route === 'POST /api/register') return await register(req, ip);
      if (route === 'POST /api/login') return await login(req, ip);
      const s = who(req);
      if (['POST /api/logout', 'GET /api/me', 'GET /api/save', 'PUT /api/save', 'DELETE /api/account'].includes(route)) {
        if (!s) return fail(401, 'Sesión caducada: vuelve a entrar.');
        if (route === 'POST /api/logout') { db.deleteSession(s.hash); return json({ ok: true }); }
        if (route === 'GET /api/me') return json({ ok: true, name: s.user.name });
        if (route === 'GET /api/save') return await getSave(s.user.id);
        if (route === 'PUT /api/save') return await putSave(req, s.user.id);
        if (route === 'DELETE /api/account') return await deleteAccount(req, ip, s.user);
      }
      return fail(404, 'No existe.');
    } catch (e) {
      console.error('[api]', route, e);
      return fail(500, 'Error del servidor.');
    }
  };
}
