/* ============ server/social-store.ts — tablas y consultas de lo social ============
 * Lo comparten server/social.ts (REST) y server/realtime.ts (WebSocket).
 *
 *   profiles     perfil público de cada cuenta (JSON ya validado: favoritos, título, marcas, medallas)
 *   friendships  una fila por pareja (a < b): solicitud pendiente (from_id la envió) o amistad
 *   last_seen    cuándo se vio por última vez a cada cuenta (al cerrarse su WebSocket)
 *   rooms        salas en curso (para que sobrevivan a un reinicio del servidor): anfitrión, si admite
 *                gente y desde cuándo juegan, y `info` (JSON: si es pública, el modo, el mapa y la partida
 *                en curso, para los espectadores); room_members, sus miembros con el Pokémon (una cuenta, una sala)
 *   group_starts el equipo real de la última partida en grupo que empezó cada anfitrión (lo comprueba el ranking)
 *
 * Todas con ON DELETE CASCADE: al borrar la cuenta desaparecen de golpe.
 */
import type { Db } from './db';

export const MAX_DEX = 5000;

export interface Profile {
  favs: { dex: number; shiny: boolean }[];
  title: string;
  best: { solo: number; group: number; level: number; bosses: number; legends: number; kills: number; medals: number };
  medals: string[];
}
export const emptyProfile = (): Profile => ({
  favs: [], title: '', medals: [],
  best: { solo: 0, group: 0, level: 0, bosses: 0, legends: 0, kills: 0, medals: 0 },
});

export interface FriendRow { other: number; name: string; status: 'pending' | 'ok'; from_id: number; seen: number | null; a: number; b: number }

const BEST_KEYS = Object.keys(emptyProfile().best) as (keyof Profile['best'])[];
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/**
 * Valida el perfil que manda el cliente. Sólo se guarda lo conocido y con su forma:
 * lo que sobra se ignora y lo que está mal se rechaza (no se "arregla" a medias).
 * @returns el perfil limpio, o el texto del error
 */
export function parseProfile(b: Record<string, any>): Profile | string {
  const out = emptyProfile();
  if (b.favs !== undefined) {
    if (!Array.isArray(b.favs) || b.favs.length > 3) return 'Favoritos no válidos.';
    for (const f of b.favs) {
      if (!f || typeof f !== 'object' || !isInt(f.dex, 1, MAX_DEX) || typeof f.shiny !== 'boolean') return 'Favoritos no válidos.';
      out.favs.push({ dex: f.dex, shiny: f.shiny });
    }
  }
  if (b.title !== undefined) {
    // Los títulos salen de una lista fija del juego: texto corto, sin etiquetas ni control.
    if (typeof b.title !== 'string' || b.title.length > 40 || /[<>\u0000-\u001f\u007f]/.test(b.title)) return 'Título no válido.';
    out.title = b.title;
  }
  if (b.best !== undefined) {
    if (!b.best || typeof b.best !== 'object' || Array.isArray(b.best)) return 'Marcas no válidas.';
    for (const k of BEST_KEYS) {
      const v = b.best[k];
      if (v === undefined) continue;
      if (!isInt(v, 0, 1e9)) return 'Marcas no válidas.';
      out.best[k] = v;
    }
  }
  if (b.medals !== undefined) {
    if (!Array.isArray(b.medals) || b.medals.length > 8) return 'Medallas no válidas.';
    for (const m of b.medals) {
      if (typeof m !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(m)) return 'Medallas no válidas.';
      out.medals.push(m);
    }
  }
  return out;
}

export interface RoomRecord { id: string; host: number; open: boolean; started: number; created: number; members: { uid: number; dex: number; shiny: boolean }[]; info?: string }
interface RoomRow { id: string; host_id: number; open: number; started: number; created: number; info: string }
interface RoomMemberRow { user_id: number; dex: number; shiny: number }

const stores = new WeakMap<Db, ReturnType<typeof build>>();

/** Crea las tablas (una vez por base) y devuelve las consultas. */
export function socialStore(db: Db) {
  let s = stores.get(db);
  if (!s) stores.set(db, s = build(db));
  return s;
}

function build(db: Db) {
  const raw = db.raw;
  raw.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS friendships (
      a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'ok')),
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      PRIMARY KEY (a, b),
      CHECK (a < b),
      CHECK (from_id = a OR from_id = b)
    );
    CREATE INDEX IF NOT EXISTS friendships_b ON friendships(b);
    CREATE TABLE IF NOT EXISTS last_seen (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      host_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      open INTEGER NOT NULL,
      started INTEGER NOT NULL,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      dex INTEGER NOT NULL,
      shiny INTEGER NOT NULL,
      joined INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS group_starts (
      host_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      team TEXT NOT NULL,
      started INTEGER NOT NULL
    );
  `);
  // Bases de antes de las salas públicas: la columna `info` se añade (las salas que hubiera, privadas).
  if (!raw.query<{ name: string }, []>('PRAGMA table_info(rooms)').all().some(c => c.name === 'info')) {
    raw.exec("ALTER TABLE rooms ADD COLUMN info TEXT NOT NULL DEFAULT '{}'");
  }

  const q = {
    getProfile: raw.query<{ data: string }, [number]>('SELECT data FROM profiles WHERE user_id = ?'),
    putProfile: raw.query<unknown, [number, string, number]>(
      'INSERT INTO profiles (user_id, data, updated) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated = excluded.updated'),
    friends: raw.query<FriendRow, [number]>(`
      SELECT u.id AS other, u.name, f.status, f.from_id, s.seen, f.a, f.b
      FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.a = ?1 THEN f.b ELSE f.a END
      LEFT JOIN last_seen s ON s.user_id = u.id
      WHERE f.a = ?1 OR f.b = ?1`),
    friendIds: raw.query<{ other: number }, [number]>(`
      SELECT CASE WHEN a = ?1 THEN b ELSE a END AS other FROM friendships
      WHERE status = 'ok' AND (a = ?1 OR b = ?1)`),
    pair: raw.query<{ status: 'pending' | 'ok'; from_id: number }, [number, number]>(
      'SELECT status, from_id FROM friendships WHERE a = ? AND b = ?'),
    add: raw.query<unknown, [number, number, number, number, number]>(
      "INSERT INTO friendships (a, b, from_id, status, created, updated) VALUES (?, ?, ?, 'pending', ?, ?)"),
    accept: raw.query<{ a: number }, [number, number, number]>(
      "UPDATE friendships SET status = 'ok', updated = ?1 WHERE a = ?2 AND b = ?3 AND status = 'pending' RETURNING a"),
    del: raw.query<{ a: number }, [number, number]>('DELETE FROM friendships WHERE a = ? AND b = ? RETURNING a'),
    // Cuántas amistades confirmadas / solicitudes enviadas / solicitudes recibidas tiene alguien.
    counts: raw.query<{ ok: number; out: number; inn: number }, [number]>(`
      SELECT COALESCE(SUM(status = 'ok'), 0) AS ok,
             COALESCE(SUM(status = 'pending' AND from_id = ?1), 0) AS out,
             COALESCE(SUM(status = 'pending' AND from_id <> ?1), 0) AS inn
      FROM friendships WHERE a = ?1 OR b = ?1`),
    seen: raw.query<unknown, [number, number]>(
      'INSERT INTO last_seen (user_id, seen) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET seen = excluded.seen'),
  };
  const room = {
    all: raw.query<RoomRow, []>('SELECT id, host_id, open, started, created, info FROM rooms'),
    members: raw.query<RoomMemberRow, [string]>('SELECT user_id, dex, shiny FROM room_members WHERE room_id = ? ORDER BY joined'),
    put: raw.query<unknown, [string, number, number, number, number, number, string]>(
      'INSERT INTO rooms (id, host_id, open, started, created, updated, info) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO UPDATE SET open = excluded.open, started = excluded.started, updated = excluded.updated, info = excluded.info'),
    delMembers: raw.query<unknown, [string]>('DELETE FROM room_members WHERE room_id = ?'),
    addMember: raw.query<unknown, [string, number, number, number, number]>(
      'INSERT INTO room_members (room_id, user_id, dex, shiny, joined) VALUES (?, ?, ?, ?, ?)'),
    del: raw.query<unknown, [string]>('DELETE FROM rooms WHERE id = ?'),
    prune: raw.query<unknown, [number]>('DELETE FROM rooms WHERE updated < ?'),
    touch: raw.query<unknown, [number, string]>('UPDATE rooms SET updated = ? WHERE id = ?'),
    putStart: raw.query<unknown, [number, string, number]>(
      'INSERT INTO group_starts (host_id, team, started) VALUES (?1, ?2, ?3) ON CONFLICT(host_id) DO UPDATE SET team = excluded.team, started = excluded.started'),
    getStart: raw.query<{ team: string; started: number }, [number]>('SELECT team, started FROM group_starts WHERE host_id = ?'),
    pruneStarts: raw.query<unknown, [number]>('DELETE FROM group_starts WHERE started < ?'),
  };
  const saveRoom = raw.transaction((r: RoomRecord, at: number) => {
    room.put.run(r.id, r.host, r.open ? 1 : 0, r.started, r.created, at, r.info ?? '{}');
    room.delMembers.run(r.id);
    r.members.forEach((m, i) => room.addMember.run(r.id, m.uid, m.dex, m.shiny ? 1 : 0, i));
  });
  const ord = (x: number, y: number): [number, number] => (x < y ? [x, y] : [y, x]);

  return {
    profile(id: number): Profile {
      const r = q.getProfile.get(id);
      return r ? { ...emptyProfile(), ...JSON.parse(r.data) } : emptyProfile();
    },
    saveProfile: (id: number, p: Profile) => { q.putProfile.run(id, JSON.stringify(p), Date.now()); },
    friends: (id: number) => q.friends.all(id),
    friendIds: (id: number) => q.friendIds.all(id).map(r => r.other),
    isFriend(x: number, y: number) { const [a, b] = ord(x, y); return q.pair.get(a, b)?.status === 'ok'; },
    pair(x: number, y: number) { const [a, b] = ord(x, y); return q.pair.get(a, b) ?? null; },
    /** Solicitud nueva de `from` a `to`. Lanza si ya hay fila (la PK). */
    request(from: number, to: number) { const [a, b] = ord(from, to); const t = Date.now(); q.add.run(a, b, from, t, t); },
    /** @returns true si había una solicitud pendiente y se ha aceptado */
    accept(x: number, y: number) { const [a, b] = ord(x, y); return !!q.accept.get(Date.now(), a, b); },
    /** Quita la amistad o solicitud. @returns true si existía */
    remove(x: number, y: number) { const [a, b] = ord(x, y); return !!q.del.get(a, b); },
    counts: (id: number) => q.counts.get(id)!,
    touchSeen: (id: number, at = Date.now()) => { q.seen.run(id, at); },
    saveRoom: (r: RoomRecord, at = Date.now()) => { saveRoom(r, at); },
    deleteRoom: (id: string) => { room.del.run(id); },
    touchRoom: (id: string, at = Date.now()) => { room.touch.run(at, id); },
    /** Salas guardadas (con sus miembros por orden de llegada). Antes quita las que llevan mucho sin moverse. */
    loadRooms(olderThan: number): RoomRecord[] {
      room.prune.run(olderThan);
      return room.all.all().map(r => ({
        id: r.id, host: r.host_id, open: !!r.open, started: r.started, created: r.created, info: r.info,
        members: room.members.all(r.id).map(m => ({ uid: m.user_id, dex: m.dex, shiny: !!m.shiny })),
      }));
    },
    saveGroupStart: (host: number, team: number[], at: number) => { room.putStart.run(host, JSON.stringify(team), at); },
    groupStart(host: number): { team: number[]; started: number } | null {
      const r = room.getStart.get(host);
      return r ? { team: JSON.parse(r.team), started: r.started } : null;
    },
    pruneGroupStarts: (olderThan: number) => { room.pruneStarts.run(olderThan); },
  };
}

export type SocialStore = ReturnType<typeof socialStore>;
