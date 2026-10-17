/* ============ server/stats.ts — métricas para el panel interno (/admin.html) ============
 * Sólo para las cuentas admin (ADMIN_USERS, las mismas que moderan el ranking):
 *
 *   GET /api/admin/stats   -> { ok, now, online, rooms, counts, modes24h, history, daily, recent }
 *     online    quién está conectado ahora (WebSocket abierto): nombre, si está en partida, su sala
 *     rooms     las salas abiertas, con sus miembros
 *     counts    cuentas (total, nuevas), activas (24 h, 7 días) y el máximo de conectados desde el arranque
 *     modes24h  cuántas cuentas empezaron una partida en las últimas 24 h, por modo (s, g, d, e, a)
 *     history   conectados cada 5 min (últimos 7 días): [{ t, n, play, rooms }]
 *     daily     jugadores distintos que se conectaron cada día (últimos 30, días en UTC): [{ day, n }]
 *     recent    las últimas cuentas creadas
 * 401 sin sesión, 403 si la cuenta no es admin.
 *
 * Tablas:
 *   stats_online  una muestra cada 5 min (se guardan 31 días)
 *   stats_daily   (día, cuenta): quién se conectó cada día (se guardan 60 días)
 */
import type { Db } from './db';
import type { Realtime, Clock } from './realtime';
import { json, fail, type Module } from './http';

const SAMPLE_MS = 5 * 60_000;
const DAY = 86_400_000;

export interface StatsOptions {
  /** Nombres de las cuentas admin; si falta, ADMIN_USERS. */
  admins?: string[];
  /** El reloj del tiempo real (en las pruebas, uno falso). */
  clock?: Clock;
}

export function createStats(db: Db, rt: Realtime, opts: StatsOptions = {}) {
  const raw = db.raw;
  const admins = new Set((opts.admins ?? (process.env.ADMIN_USERS || '').split(',')).map(s => s.trim().toLowerCase()).filter(Boolean));
  const clock = opts.clock;
  const now = () => clock ? clock.now() : Date.now();

  raw.exec(`
    CREATE TABLE IF NOT EXISTS stats_online (
      t INTEGER PRIMARY KEY,
      n INTEGER NOT NULL,
      play INTEGER NOT NULL,
      rooms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stats_daily (
      day INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (day, user_id)
    ) WITHOUT ROWID;
  `);
  const q = {
    sample: raw.query<unknown, [number, number, number, number]>('INSERT OR REPLACE INTO stats_online (t, n, play, rooms) VALUES (?, ?, ?, ?)'),
    pruneSamples: raw.query<unknown, [number]>('DELETE FROM stats_online WHERE t < ?'),
    history: raw.query<{ t: number; n: number; play: number; rooms: number }, [number]>('SELECT t, n, play, rooms FROM stats_online WHERE t >= ? ORDER BY t'),
    seenToday: raw.query<unknown, [number, number]>('INSERT OR IGNORE INTO stats_daily (day, user_id) VALUES (?, ?)'),
    pruneDaily: raw.query<unknown, [number]>('DELETE FROM stats_daily WHERE day < ?'),
    daily: raw.query<{ day: number; n: number }, [number]>('SELECT day, COUNT(*) AS n FROM stats_daily WHERE day >= ? GROUP BY day ORDER BY day'),
    users: raw.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM users'),
    newSince: raw.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM users WHERE created >= ?'),
    // Activa: con el WebSocket cerrado hace poco (last_seen) o usando la API (sessions.seen, se toca cada hora).
    activeIds: raw.query<{ id: number }, [number, number]>(`
      SELECT user_id AS id FROM last_seen WHERE seen >= ?1
      UNION SELECT user_id FROM sessions WHERE seen >= ?2`),
    modes: raw.query<{ mode: string; n: number }, [number]>('SELECT mode, COUNT(*) AS n FROM ranking_runs WHERE started >= ? GROUP BY mode'),
    recent: raw.query<{ name: string; created: number }, []>('SELECT name, created FROM users ORDER BY created DESC LIMIT 15'),
  };

  let peak = { n: 0, t: now() };
  const dayOf = (t: number) => Math.floor(t / DAY);

  function sample() {
    const o = rt.overview();
    const t = now();
    q.sample.run(t, o.online.length, o.online.filter(c => c.play).length, o.rooms.length);
    q.pruneSamples.run(t - 31 * DAY);
    q.pruneDaily.run(dayOf(t) - 60);
  }
  const timer = clock ? clock.setInterval(sample, SAMPLE_MS) : setInterval(sample, SAMPLE_MS);
  timer.unref();

  rt.onConnect(id => {
    const t = now();
    q.seenToday.run(dayOf(t), id);
    const n = rt.overview().online.length;
    if (n > peak.n) peak = { n, t };
  });

  const module: Module = (_req, ctx) => {
    if (ctx.path !== '/admin/stats') return null;
    if (ctx.method !== 'GET') return fail(405, 'Método no permitido.');
    if (!ctx.user) return fail(401, 'Inicia sesión.');
    if (!admins.has(ctx.user.name.toLowerCase())) return fail(403, 'Sólo para administradores.');
    const t = now();
    const o = rt.overview();
    const onlineIds = new Set(o.online.map(c => Number(c.uid)));
    const active = (since: number) => {
      const ids = new Set(onlineIds);
      for (const r of q.activeIds.all(since, since)) ids.add(r.id);
      return ids.size;
    };
    return json({
      ok: true, now: t,
      online: o.online.sort((a, b) => a.since - b.since),
      rooms: o.rooms,
      counts: {
        accounts: q.users.get()!.n,
        new24h: q.newSince.get(t - DAY)!.n, new7d: q.newSince.get(t - 7 * DAY)!.n, new30d: q.newSince.get(t - 30 * DAY)!.n,
        active24h: active(t - DAY), active7d: active(t - 7 * DAY), active30d: active(t - 30 * DAY),
        peak: peak.n, peakAt: peak.t,
      },
      modes24h: Object.fromEntries(q.modes.all(t - DAY).map(r => [r.mode, r.n])),
      history: q.history.all(t - 7 * DAY),
      daily: q.daily.all(dayOf(t) - 30).map(r => ({ day: r.day * DAY, n: r.n })),
      recent: q.recent.all(),
    });
  };

  return { module, sample, stop() { if (clock) clock.clearInterval(timer); else clearInterval(timer as ReturnType<typeof setInterval>); } };
}
