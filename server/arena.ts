/* ============ server/arena.ts — podio y victorias de la Arena ============
 * La Arena es un modo de la Defensa sólo en grupo (2 a 8 jugadores): cada uno en su
 * carril, las mismas oleadas a la vez, sin tocarse; gana el último en pie. El anfitrión
 * simula la partida y, al acabar, sube el resultado de todos. Todo es JSON bajo
 * /api/ranking y exige sesión (401 sin ella), igual que server/ranking.ts (que apunta
 * el inicio de la partida con /start { mode: 'a' } y de quien se toman sus tablas de
 * periodos y las cuentas marcadas). Este módulo va ANTES que el del ranking en
 * server/index.ts: el del ranking contesta 404 a cualquier /ranking/... que no conozca.
 *
 *   POST /api/ranking/arena      { map, waves, secs, places:[{ uid, place, wave, dex, shiny }] }
 *                                                                  -> { ok, id, counted }
 *        Lo sube el anfitrión, que debe estar entre `places`. `place` 1 = ganador; los empates
 *        repiten puesto (1, 1, 3). `waves` son las oleadas que superó el ganador y `wave` la
 *        oleada en la que cayó cada uno. Se guarda la partida y el puesto de cada cuenta.
 *   GET  /api/ranking/arena/top?period=d|w|m|a[&circle=1,2,3]      -> { ok, rows, mine }
 *        Top 50 del periodo (los mismos que el ranking: hoy, semana, mes e histórico, en hora de
 *        Madrid), por cuenta: victorias (puesto 1), podios (puesto <= 3) y partidas, más el
 *        Pokémon de su última partida del periodo. Orden: victorias, podios (más es mejor),
 *        partidas (menos es mejor), nombre. Fila: { uid, name, dex, shiny, wins, podiums, games }.
 *        `mine` es tu fila con tu puesto exacto, aunque no salgas en el top (o null si no has jugado).
 *        Con `circle` (uids separados por comas, máx. 30) sólo salen esas cuentas y la tuya.
 *
 * Anti-trampas (como la Defensa en grupo de server/ranking.ts):
 *   - de 2 a 8 cuentas distintas y existentes, con el anfitrión dentro (403 si no)
 *   - hay que haber avisado con /start { mode: 'a' }; el aviso se gasta con la subida (una
 *     partida, una subida) -> 409 si no hay aviso o es de otro modo
 *   - el equipo tiene que ser el de la sala del anfitrión (opts.verifyTeam, 403 si no coincide)
 *   - puestos enteros de 1 a N, con al menos un ganador; oleadas de 0 a MAX_WAVE; segundos
 *     de 1 a lo máximo que dura una Defensa y no más del doble del tiempo real desde /start
 *     (se puede jugar a ×2) + 30 s; Pokémon de 1 a 2000; mapa: texto corto
 *   - cuentas marcadas (ranking_marked): si es el anfitrión, no sube nada (403); si es otro
 *     jugador, su fila se omite (no cuenta) pero no tumba la partida de los demás. Los puestos
 *     de los demás se guardan tal cual: quien perdió contra una cuenta marcada no gana por ello.
 *
 * Tablas (se borran con la cuenta):
 *   arena_games   una partida: cuándo, anfitrión, cuántos jugaban, mapa, oleadas, segundos y los
 *                 ids de periodo (hoy/semana/mes) al subirla, para que sus fronteras sean las del ranking
 *   arena_places  el puesto de cada cuenta en cada partida; si se va la cuenta, se va su fila, y una
 *                 partida sin ninguna fila se borra sola
 */
import type { Db } from './db';
import { fail, json, limiter, readBody, type Module } from './http';
import { GRACE_S, MAX_DEFENSE_S, MAX_DEX, UID_RE, isMarkedAccount, periodIds } from './ranking';
import { MAX_WAVE } from '../src/modes/td-waves';

export interface ArenaOptions {
  /** Reloj en ms (para las pruebas). */
  now?: () => number;
  /** Igual que en createRanking: comprueba que `members` son los de la sala del anfitrión. Sin él se acepta lo que diga el anfitrión. */
  verifyTeam?: (host: number, members: number[], startedAt: number | null) => boolean;
}

const MIN_PLAYERS = 2, MAX_PLAYERS = 8;
const TOP = 50;
/** Columna del periodo en arena_games (el histórico no filtra). */
const PERIOD_COL = { d: 'pd', w: 'pw', m: 'pm' } as const;
const isPeriod = (p: unknown): p is 'd' | 'w' | 'm' | 'a' => p === 'd' || p === 'w' || p === 'm' || p === 'a';
/** El nombre del mapa: corto y sin nada raro (letras, números, espacios, guiones y puntos). */
const MAP_RE = /^[\p{L}\p{N} _.\-]{1,32}$/u;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** Una fila del top, tal como la sirve el servidor. */
interface ArenaRow { uid: string; name: string; dex: number; shiny: boolean; wins: number; podiums: number; games: number }

export function createArena(db: Db, opts: ArenaOptions = {}): Module {
  const raw = db.raw;
  const now = opts.now ?? Date.now;

  raw.exec(`
    CREATE TABLE IF NOT EXISTS arena_games (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      host INTEGER REFERENCES users(id) ON DELETE SET NULL,
      players INTEGER NOT NULL,
      map TEXT NOT NULL,
      waves INTEGER NOT NULL,
      secs INTEGER NOT NULL,
      pd TEXT NOT NULL,
      pw TEXT NOT NULL,
      pm TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS arena_games_pd ON arena_games(pd);
    CREATE INDEX IF NOT EXISTS arena_games_pw ON arena_games(pw);
    CREATE INDEX IF NOT EXISTS arena_games_pm ON arena_games(pm);
    CREATE TABLE IF NOT EXISTS arena_places (
      game_id INTEGER NOT NULL REFERENCES arena_games(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      place INTEGER NOT NULL,
      wave INTEGER NOT NULL,
      dex INTEGER NOT NULL,
      shiny INTEGER NOT NULL,
      PRIMARY KEY (game_id, user_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS arena_places_user ON arena_places(user_id);
    -- Una partida a la que ya no le queda ninguna fila (todas las cuentas borradas) no cuenta para nada.
    CREATE TRIGGER IF NOT EXISTS arena_places_gone AFTER DELETE ON arena_places
    BEGIN DELETE FROM arena_games WHERE id = OLD.game_id AND NOT EXISTS (SELECT 1 FROM arena_places WHERE game_id = OLD.game_id); END;
  `);

  const q = {
    userExists: raw.query<{ id: number }, [number]>('SELECT id FROM users WHERE id = ?'),
    getRun: raw.query<{ started: number; mode: string }, [number]>('SELECT started, mode FROM ranking_runs WHERE user_id = ?'),
    delRun: raw.query<unknown, [number]>('DELETE FROM ranking_runs WHERE user_id = ?'),
    addGame: raw.query<{ id: number }, [number, number, number, string, number, number, string, string, string]>(
      'INSERT INTO arena_games (at, host, players, map, waves, secs, pd, pw, pm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'),
    addPlace: raw.query<unknown, [number, number, number, number, number, number]>(
      'INSERT INTO arena_places (game_id, user_id, place, wave, dex, shiny) VALUES (?, ?, ?, ?, ?, ?)'),
  };

  const writeOk = limiter(120, 60_000);
  const readOk = limiter(600, 60_000);

  // ---------------- subir ----------------

  async function submit(req: Request, uid: number) {
    const b = await readBody(req, 4096);
    if (b instanceof Response) return b;
    // Desde aquí no hay await: comprobar la partida y gastarla es una sola operación.
    const { map, waves, secs, places } = b;
    if (typeof map !== 'string' || !MAP_RE.test(map)) return fail(400, 'Mapa no válido.');
    if (!isInt(waves) || waves < 0 || waves > MAX_WAVE) return fail(400, 'Oleadas no válidas.');
    if (!isInt(secs) || secs < 1 || secs > MAX_DEFENSE_S) return fail(400, 'Tiempo no válido.');
    if (!Array.isArray(places) || places.length < MIN_PLAYERS || places.length > MAX_PLAYERS) return fail(400, 'Resultado no válido.');
    const n = places.length;
    const rows: { uid: number; place: number; wave: number; dex: number; shiny: boolean }[] = [];
    for (const p of places) {
      if (!p || typeof p !== 'object' || typeof p.uid !== 'string' || !UID_RE.test(p.uid)) return fail(400, 'Resultado no válido.');
      if (!isInt(p.place) || p.place < 1 || p.place > n) return fail(400, 'Puestos no válidos.');
      // `wave`: la oleada en la que cayó (o la que alcanzó el ganador, que puede ser una más que las superadas).
      if (!isInt(p.wave) || p.wave < 0 || p.wave > MAX_WAVE + 1) return fail(400, 'Oleadas no válidas.');
      if (!isInt(p.dex) || p.dex < 1 || p.dex > MAX_DEX) return fail(400, 'Pokémon no válido.');
      rows.push({ uid: +p.uid, place: p.place, wave: p.wave, dex: p.dex, shiny: p.shiny === true });
    }
    if (new Set(rows.map(r => r.uid)).size !== n) return fail(400, 'Resultado no válido.');
    if (!rows.some(r => r.place === 1)) return fail(400, 'Puestos no válidos.');       // siempre hay alguien en lo más alto
    if (!rows.some(r => r.uid === uid)) return fail(403, 'Sólo el anfitrión, dentro de la partida, puede subir el resultado.');
    if (rows.some(r => !q.userExists.get(r.uid))) return fail(400, 'Resultado no válido.');
    // Hay que haber avisado con /start 'a' (antes que el equipo: sin aviso la sala ni se mira).
    const run = q.getRun.get(uid);
    if (!run || run.mode !== 'a') return fail(409, 'No hay una partida en curso.');
    if (opts.verifyTeam) {
      const uids = rows.map(r => r.uid).sort((x, y) => x - y);
      if (!opts.verifyTeam(uid, uids, run.started)) return fail(403, 'Los jugadores no coinciden con tu sala.');
    }
    if (isMarkedAccount(db, uid)) return fail(403, 'Una cuenta marcada no puede subir marcas.');

    // Anti-trampas: la partida tiene que haber durado esto (según el reloj del servidor).
    const elapsed = (now() - run.started) / 1000;
    if (secs / 2 > elapsed + GRACE_S) return fail(400, 'Tiempo imposible.');          // a ×2, la mitad de tiempo real
    q.delRun.run(uid);                      // una partida, una subida

    // Las cuentas marcadas no cuentan: su fila se omite (los puestos de los demás se quedan como están).
    const counted = rows.filter(r => !isMarkedAccount(db, r.uid));
    const at = now();
    const ids = periodIds(new Date(at));
    const id = raw.transaction(() => {
      const g = q.addGame.get(at, uid, n, map, waves, secs, ids.d, ids.w, ids.m)!;
      for (const r of counted) q.addPlace.run(g.id, r.uid, r.place, r.wave, r.dex, r.shiny ? 1 : 0);
      return g.id;
    })();
    return json({ ok: true, id, counted: counted.length });
  }

  // ---------------- leer ----------------

  /**
   * Las cuentas del periodo ya ordenadas, cada una con su puesto (`pos`), a partir de las partidas del
   * periodo (el id de periodo se guardó al subir la partida: las fronteras son las del ranking).
   */
  function board(period: 'd' | 'w' | 'm' | 'a', only?: number[], limit = -1): (ArenaRow & { pos: number })[] {
    const where = period === 'a' ? '' : `WHERE g.${PERIOD_COL[period]} = ?`;
    const args: (string | number)[] = period === 'a' ? [] : [periodIds(new Date(now()))[period]];
    if (only) args.push(...only);
    const sql = `
      WITH pl AS (
        SELECT p.user_id, p.place, p.dex, p.shiny,
               ROW_NUMBER() OVER (PARTITION BY p.user_id ORDER BY g.at DESC, g.id DESC) AS rn
        FROM arena_places p JOIN arena_games g ON g.id = p.game_id ${where}
      ),
      agg AS (
        SELECT user_id, SUM(place = 1) AS wins, SUM(place <= 3) AS podiums, COUNT(*) AS games,
               MAX(CASE WHEN rn = 1 THEN dex END) AS dex, MAX(CASE WHEN rn = 1 THEN shiny END) AS shiny
        FROM pl GROUP BY user_id
      ),
      ranked AS (
        SELECT a.user_id AS uid, u.name, a.dex, a.shiny, a.wins, a.podiums, a.games,
               ROW_NUMBER() OVER (ORDER BY a.wins DESC, a.podiums DESC, a.games, u.name COLLATE NOCASE, a.user_id) AS pos
        FROM agg a JOIN users u ON u.id = a.user_id
      )
      SELECT * FROM ranked ${only ? `WHERE uid IN (${placeholders(only.length)})` : ''} ORDER BY pos LIMIT ${limit}`;
    return raw.query<{ uid: number; name: string; dex: number; shiny: number; wins: number; podiums: number; games: number; pos: number }, (string | number)[]>(sql)
      .all(...args).map(r => ({ uid: String(r.uid), name: r.name, dex: r.dex, shiny: !!r.shiny, wins: r.wins, podiums: r.podiums, games: r.games, pos: r.pos }));
  }

  function top(url: URL, uid: number) {
    const period = url.searchParams.get('period');
    if (!isPeriod(period)) return fail(400, 'Tabla no válida.');
    const circleRaw = url.searchParams.get('circle');
    let rows: ArenaRow[];
    if (circleRaw === null) rows = board(period, undefined, TOP);
    else {
      const set = new Set<number>([uid]);
      for (const s of circleRaw.split(',').slice(0, 30)) if (UID_RE.test(s)) set.add(+s);
      rows = board(period, [...set], TOP);
    }
    // Tu puesto es el de todo el periodo (como /rank del ranking), aunque salgan sólo tus amigos:
    // `pos` se numera antes de filtrar por cuentas.
    const mine = board(period, [uid], 1)[0] ?? null;
    return json({ ok: true, rows: rows.map(({ uid, name, dex, shiny, wins, podiums, games }) => ({ uid, name, dex, shiny, wins, podiums, games })), mine });
  }

  // ---------------- rutas ----------------

  return async (req, ctx) => {
    if (ctx.path !== '/ranking/arena' && ctx.path !== '/ranking/arena/top') return null;
    if (!ctx.user) return fail(401, 'Sesión caducada: vuelve a entrar.');
    const uid = ctx.user.id;
    const route = ctx.method + ' ' + ctx.path;
    if (route === 'POST /ranking/arena') {
      if (!writeOk(uid + ':ar')) return fail(429, 'Demasiadas peticiones. Espera un poco.');
      return submit(req, uid);
    }
    if (route === 'GET /ranking/arena/top') {
      if (!readOk(uid + ':ar')) return fail(429, 'Demasiadas peticiones. Espera un poco.');
      return top(new URL(req.url), uid);
    }
    return fail(405, 'Método no permitido.');
  };
}
