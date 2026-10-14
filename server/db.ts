/* ============ server/db.ts — base de datos (SQLite, bun:sqlite) ============
 * Un solo archivo (DB_PATH, por defecto data/poke-td.sqlite). Tablas:
 *   users     cuenta: nombre visible, nombre en minúsculas (único) y contraseña (argon2id)
 *   sessions  sesiones abiertas: se guarda el SHA-256 del token, nunca el token
 *   saves     la partida de cada cuenta (JSON) con su versión, que sube en cada guardado
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface User { id: number; name: string; name_key: string; pass: string; created: number }
export interface SaveRow { data: string; ver: number; updated: number }

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      pass TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created INTEGER NOT NULL,
      seen INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS saves (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      ver INTEGER NOT NULL,
      updated INTEGER NOT NULL
    );
  `);

  const q = {
    userByKey: db.query<User, [string]>('SELECT * FROM users WHERE name_key = ?'),
    userById: db.query<User, [number]>('SELECT * FROM users WHERE id = ?'),
    addUser: db.query<{ id: number }, [string, string, string, number]>(
      'INSERT INTO users (name, name_key, pass, created) VALUES (?, ?, ?, ?) RETURNING id'),
    delUser: db.query<unknown, [number]>('DELETE FROM users WHERE id = ?'),
    addSession: db.query<unknown, [string, number, number, number]>(
      'INSERT INTO sessions (token_hash, user_id, created, seen) VALUES (?, ?, ?, ?)'),
    session: db.query<{ user_id: number; seen: number }, [string]>('SELECT user_id, seen FROM sessions WHERE token_hash = ?'),
    touchSession: db.query<unknown, [number, string]>('UPDATE sessions SET seen = ? WHERE token_hash = ?'),
    delSession: db.query<unknown, [string]>('DELETE FROM sessions WHERE token_hash = ?'),
    oldSessions: db.query<unknown, [number]>('DELETE FROM sessions WHERE seen < ?'),
    save: db.query<SaveRow, [number]>('SELECT data, ver, updated FROM saves WHERE user_id = ?'),
    // Sólo escribe si nadie ha guardado entre medias (la versión sigue siendo la que el cliente vio).
    putSave: db.query<{ ver: number }, [number, string, number, number]>(`
      INSERT INTO saves (user_id, data, ver, updated) VALUES (?1, ?2, 1, ?3)
        ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, ver = saves.ver + 1, updated = excluded.updated
        WHERE saves.ver = ?4
      RETURNING ver`),
  };

  return {
    raw: db,
    userByKey: (k: string) => q.userByKey.get(k),
    userById: (id: number) => q.userById.get(id),
    addUser: (name: string, key: string, pass: string) => q.addUser.get(name, key, pass, Date.now())!.id,
    deleteUser: (id: number) => { q.delUser.run(id); },
    addSession: (hash: string, userId: number) => { const t = Date.now(); q.addSession.run(hash, userId, t, t); },
    session: (hash: string) => q.session.get(hash),
    touchSession: (hash: string) => { q.touchSession.run(Date.now(), hash); },
    deleteSession: (hash: string) => { q.delSession.run(hash); },
    pruneSessions: (olderThan: number) => { q.oldSessions.run(olderThan); },
    save: (userId: number) => q.save.get(userId),
    /** @returns la versión nueva, o null si la de la base ya no es `base` (otro dispositivo guardó antes) */
    putSave: (userId: number, data: string, base: number) => {
      const r = q.putSave.get(userId, data, Date.now(), base);
      return r ? r.ver : null;
    },
    close: () => db.close(),
  };
}

export type Db = ReturnType<typeof openDb>;
