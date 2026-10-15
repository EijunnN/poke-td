/* ============ server/social.ts — perfiles y amigos (REST) ============
 * Lo persistente de lo social, bajo /api/social (la sesión va como en el resto de la API).
 * Lo que va en directo (en línea, invitaciones, salas) está en server/realtime.ts.
 *
 *   GET    /api/social/friends                -> { ok, friends: [{ uid, name, pid, status, online, play, room, seen }] }
 *                                                status: 'ok' amigo · 'in' te la mandó él · 'out' se la mandaste tú
 *   POST   /api/social/friends/request { name } -> { ok, msg, accepted }   (si ya te la había mandado, la acepta)
 *   POST   /api/social/friends/accept  { uid }  -> { ok, msg }
 *   DELETE /api/social/friends/:uid             -> { ok }   quitar amigo, rechazar o cancelar una solicitud
 *   PUT    /api/social/profile { favs, title, best, medals } -> { ok }   tu perfil público
 *   GET    /api/social/profile/:uid             -> { ok, profile: { name, favs, title, best, medals } }
 *
 * `uid` es el id de la cuenta como texto. El apodo es el nombre de la cuenta (único).
 * Cada cambio en las amistades avisa por WebSocket ({ k:'fr' }) a la otra persona.
 */
import type { Db } from './db';
import { json, fail, limiter, readBody, type Module } from './http';
import type { Realtime } from './realtime';
import { parseProfile, socialStore } from './social-store';

const VALID_NAME = /^[A-Za-z0-9_ñÑáéíóúÁÉÍÓÚ]{3,16}$/;
const UID = /^[1-9]\d{0,11}$/;
/** Caracteres de ancho cero y marcas de dirección que se cuelan al copiar un apodo (no se ven, pero no coinciden). */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const MAX_FRIENDS = 200, MAX_OUT = 30, MAX_IN = 100;

export function createSocial(db: Db, rt: Realtime): Module {
  const store = socialStore(db);
  const reqLimit = limiter(40, 60_000);
  const pubLimit = limiter(10, 60_000);
  const readLimit = limiter(120, 60_000);

  function friends(me: number) {
    const list = store.friends(me).map(f => {
      const p = rt.presence(f.other);
      const ok = f.status === 'ok';
      return {
        uid: String(f.other), name: f.name, pid: f.a + '_' + f.b,
        status: ok ? 'ok' : f.from_id === me ? 'out' : 'in',
        // La presencia sólo se enseña a los amigos confirmados.
        online: ok && p.online, play: ok && p.play, room: ok ? p.room : '', seen: ok ? (f.seen ?? 0) : 0,
      };
    });
    return json({ ok: true, friends: list });
  }

  async function request(req: Request, me: number) {
    if (!reqLimit('r' + me)) return fail(429, 'Demasiadas solicitudes seguidas. Espera un poco.');
    const b = await readBody(req, 512);
    if (b instanceof Response) return b;
    // El apodo se escribe o se pega: se normaliza (ñ y tildes compuestas, sin caracteres invisibles) antes de validar.
    const name = typeof b.name === 'string' ? b.name.normalize('NFC').replace(INVISIBLE, '').trim() : '';
    if (!VALID_NAME.test(name)) return fail(400, 'Escribe el apodo exacto de tu amigo.');
    const other = db.userByKey(name.toLowerCase());
    if (!other) return fail(404, 'No hay ningún jugador con ese apodo.');
    if (other.id === me) return fail(400, 'Ese eres tú.');
    const cur = store.pair(me, other.id);
    if (cur) {
      if (cur.status === 'ok') return fail(409, 'Ya sois amigos.');
      if (cur.from_id === me) return fail(409, 'Ya le enviaste una solicitud.');
      return accept(me, other.id);          // cruzadas: él ya te la había mandado
    }
    const mine = store.counts(me), theirs = store.counts(other.id);
    if (mine.out >= MAX_OUT) return fail(429, 'Tienes demasiadas solicitudes sin responder.');
    if (mine.ok >= MAX_FRIENDS || theirs.ok >= MAX_FRIENDS) return fail(409, 'No caben más amigos.');
    if (theirs.inn >= MAX_IN) return fail(429, 'Ese jugador tiene demasiadas solicitudes pendientes.');
    try { store.request(me, other.id); } catch { return fail(409, 'Ya le enviaste una solicitud.'); }
    rt.notify(other.id, { k: 'fr' });
    return json({ ok: true, msg: 'Solicitud enviada a ' + other.name, accepted: false });
  }

  function accept(me: number, other: number) {
    const cur = store.pair(me, other);
    if (!cur || cur.status !== 'pending' || cur.from_id === me) return fail(404, 'No hay solicitud.');
    const o = db.userById(other);
    if (!o || !store.accept(me, other)) return fail(404, 'No hay solicitud.');
    rt.notify(other, { k: 'fr' });
    return json({ ok: true, msg: 'Ahora eres amigo de ' + o.name, accepted: true });
  }

  function remove(me: number, other: number) {
    if (!store.remove(me, other)) return fail(404, 'No hay amistad ni solicitud con ese jugador.');
    rt.dropInvitesBetween(me, other);
    rt.notify(other, { k: 'fr' });
    return json({ ok: true });
  }

  async function putProfile(req: Request, me: number) {
    if (!pubLimit('p' + me)) return fail(429, 'Demasiados cambios seguidos.');
    const b = await readBody(req, 4096);
    if (b instanceof Response) return b;
    const p = parseProfile(b);
    if (typeof p === 'string') return fail(400, p);
    store.saveProfile(me, p);
    return json({ ok: true });
  }

  function getProfile(uid: number) {
    const u = db.userById(uid);
    if (!u) return fail(404, 'No existe ese jugador.');
    return json({ ok: true, profile: { name: u.name, ...store.profile(uid) } });
  }

  return async (req, ctx) => {
    if (!ctx.path.startsWith('/social/')) return null;
    if (!ctx.user) return fail(401, 'Sesión caducada: vuelve a entrar.');
    const me = ctx.user.id;
    const route = ctx.method + ' ' + ctx.path;
    const id = /^(?:DELETE \/social\/friends|GET \/social\/profile)\/([^/]+)$/.exec(route)?.[1];

    if (route === 'GET /social/friends') return readLimit('l' + me) ? friends(me) : fail(429, 'Demasiadas peticiones.');
    if (route === 'POST /social/friends/request') return request(req, me);
    if (route === 'POST /social/friends/accept') {
      if (!reqLimit('a' + me)) return fail(429, 'Demasiadas peticiones.');
      const b = await readBody(req, 256);
      if (b instanceof Response) return b;
      return typeof b.uid === 'string' && UID.test(b.uid) ? accept(me, Number(b.uid)) : fail(400, 'Jugador no válido.');
    }
    if (route === 'PUT /social/profile') return putProfile(req, me);
    if (id !== undefined) {
      if (!UID.test(id)) return fail(400, 'Jugador no válido.');
      if (route.startsWith('DELETE')) return remove(me, Number(id));
      return readLimit('g' + me) ? getProfile(Number(id)) : fail(429, 'Demasiadas peticiones.');
    }
    return fail(404, 'No existe.');
  };
}
