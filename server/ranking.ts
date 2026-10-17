/* ============ server/ranking.ts — ranking de tiempo aguantado ============
 * Todo es JSON bajo /api/ranking y exige sesión (401 sin ella). Los errores son
 * { ok: false, error } con un texto que se puede enseñar al jugador.
 *
 * Jugadores
 *   POST   /api/ranking/start   { mode }                        -> { ok }
 *          El servidor apunta la hora a la que empieza la partida (en grupo, la
 *          del anfitrión). mode: 's' solitario · 'g' grupo · 'd' Defensa (tower defense) · 'e' Defensa en grupo
 *          · 'a' Arena (aquí sólo se avisa: su resultado se sube a /api/ranking/arena, ver server/arena.ts).
 *   POST   /api/ranking/submit  { mode:'s', t, lv, kills, dex, shiny }
 *                               { mode:'g', t, lv, kills, members:[{ uid, dex, shiny }] }
 *                                                               -> { ok, better:['d','w','m','a'] }
 *                               { mode:'d', waves, lives, secs, kills, dex, shiny }   (Defensa)
 *                               { mode:'e', waves, lives, secs, kills, members:[{ uid, dex, shiny }] }   (Defensa en grupo)
 *          Sube la marca a cada tabla donde mejora (sólo mejora, nunca empeora):
 *          las de hoy, semana, mes e histórico, y la del histórico de cada Pokémon.
 *          `better` son los periodos (no el de Pokémon) donde ha mejorado. En
 *          grupo la sube el anfitrión, que debe estar en `members`; los nombres
 *          salen de la base de datos, no de lo que mande el cliente.
 *   GET    /api/ranking/top?mode&period[&dex][&circle=1,2,3]    -> { ok, rows, admin }
 *          Top 50 de una tabla (period: d|w|m|a; dex sólo cuenta en 'a'). Con
 *          `circle` (uids separados por comas, máx. 30) sólo salen las marcas donde
 *          estén esas cuentas o la tuya. Fila: { id, t, uids, names, dex, shiny, lv, kills }.
 *   GET    /api/ranking/rank?mode&period[&dex]                  -> { ok, rank, admin }
 *          Tu mejor puesto exacto (aunque pases del 50) o null: rank = { pos, t, row }.
 *   POST   /api/ranking/report  { board, e }                    -> { ok, dup }
 *          Reporta una marca (una vez por jugador y marca; la tuya no).
 *   DELETE /api/ranking/mine                                    -> { ok, removed }
 *          Quita todas tus marcas (al borrar la cuenta también se van solas).
 *   GET    /api/ranking/admin                                   -> { ok, admin }
 *
 * Moderación (403 si la cuenta no es admin; ver ADMIN_USERS)
 *   GET    /api/ranking/admin/reports                           -> { ok, groups }
 *   GET    /api/ranking/admin/entry?board&e                     -> { ok, row }  (row null si ya no está)
 *   POST   /api/ranking/admin/remove       { board, e }         -> { ok, removed }
 *   POST   /api/ranking/admin/remove-all   { e, mode, dexes, also } -> { ok, removed }
 *          Quita la marca `e` de las tablas de ahora de ese modo, de todas las de
 *          Pokémon y de la tabla `also` (`dexes` se admite por compatibilidad).
 *   POST   /api/ranking/admin/purge        { maxT }             -> { ok, rows, boards }
 *   POST   /api/ranking/admin/mark         { uid, on }          -> { ok }
 *   GET    /api/ranking/admin/marked                            -> { ok, accounts }
 *   POST   /api/ranking/admin/dismiss      { ids }              -> { ok }
 *
 * Tablas (se crean aquí; todo lo que cuelga de una cuenta se borra con ella):
 *   ranking_entries  la marca de cada jugador o equipo en cada tabla: (board, id) -> t, lv, kills, at
 *   ranking_members  quiénes forman la marca (con su Pokémon); si se va uno, se va la marca entera
 *   ranking_runs     cuándo empezó la última partida de cada cuenta (anti-trampas)
 *   ranking_reports  reportes de marcas sospechosas, uno por jugador y marca
 *   ranking_marked   cuentas marcadas: no pueden subir marcas (las marca el admin o el guardado de
 *                    una partida imposible, ver server/save-rules.ts)
 *
 * Tablas del ranking: `board` = modo + '_' + periodo, p. ej. s_d20261013 (solitario,
 * hoy), g_w2026-42 (grupo, semana ISO), s_m202610, s_all2 (histórico) y s_all2_p25
 * (histórico sólo con Pikachu). `id` = uid (solitario) o los uids del equipo en
 * orden numérico unidos con '_'. Los periodos se cuentan en hora de Europe/Madrid.
 * Orden: más tiempo primero; a igualdad, quien llegó antes; a igualdad, por id.
 *
 * Defensa ('d' solitario, 'e' en grupo; sin tablas por Pokémon): la columna `t` no
 * es tiempo sino la puntuación oleadas·100 + vidas (src/modes/td-waves.ts,
 * defenseScore), y `lv` son las oleadas superadas. El mismo orden sirve. El equipo
 * de 'e' se comprueba igual que el de 'g'.
 *
 * Anti-trampas (portado de las reglas de Firestore del original, validEntry; ver el historial de git):
 *   - hay que haber avisado con /start, y ese aviso se gasta con la marca (una
 *     partida, una subida); el modo tiene que coincidir
 *   - t entero, entre 60 s y 1 h, y no más que el tiempo real desde /start + 30 s
 *   - nivel entero entre 1 y 10 + t/4, derrotados entero entre 0 y 100 + 12·t
 *   - Pokémon entero entre 1 y 2000
 *   - la cuenta (y en grupo, ningún miembro) no puede estar marcada
 *   - grupo de 2 a 4 cuentas distintas y existentes (en la Defensa, hasta 8), con el anfitrión dentro
 *   - Defensa: de 1 a 99 oleadas (tras la 30 sigue el sin fin) y de 0 a 30 vidas; los segundos de partida, al menos
 *     lo que tardan en salir los enemigos de esas oleadas y no más que el doble del
 *     tiempo real desde /start (se puede jugar a ×2) + 30 s; derrotados, no más de
 *     los que salen hasta la oleada siguiente
 *
 * Admin: las cuentas cuyo nombre esté en la variable de entorno ADMIN_USERS
 * (separadas por comas, sin distinguir mayúsculas). Para las pruebas,
 * createRanking acepta `admins` en sus opciones.
 */
import type { Db } from './db';
import { fail, json, limiter, readBody, type Module } from './http';
import { MAX_WAVE, START_LIVES, defenseScore, maxDefenseKills, minDefenseTime } from '../src/modes/td-waves';
import { MAX_ROOM } from '../src/modes/td-geom';

export interface RankingOptions {
  /** Nombres de las cuentas admin; si falta, ADMIN_USERS. */
  admins?: string[];
  /** Reloj en ms (para las pruebas). */
  now?: () => number;
  /**
   * Comprueba que `members` (ids de cuenta) están de verdad en la sala del
   * anfitrión. Sin él no se puede comprobar (la sala vive en server/realtime.ts)
   * y se acepta el equipo que diga el anfitrión. `startedAt` es la hora (ms) a la que el
   * anfitrión avisó con /start de esta partida en grupo, o null si no hay aviso.
   */
  verifyTeam?: (host: number, members: number[], startedAt: number | null) => boolean;
}

const TZ = 'Europe/Madrid';
const ALL = 'all2';
const PERIODS = ['d', 'w', 'm', 'a'] as const;
type Period = typeof PERIODS[number];
const TOP = 50;
/** Las partidas de menos de 1 minuto no cuentan. */
const MIN_T = 60;
/** Ninguna marca real pasa de 1 h (la Sentencia de Arceus acaba las partidas hacia el minuto 31-32). */
const MAX_T = 3600;
/** Margen sobre el tiempo real transcurrido desde /start. */
export const GRACE_S = 30;
export const MAX_DEX = 2000;
/** Lo más grande que puede ser un equipo: en el Survivor, 4; en la Defensa, los del mapa más grande. */
const MAX_TEAM = 4;
const MAX_TEAM_TD = MAX_ROOM;
/** Los modos: solitario, grupo, Defensa y Defensa en grupo. */
type Mode = 's' | 'g' | 'd' | 'e';
const isMode = (m: unknown): m is Mode => m === 's' || m === 'g' || m === 'd' || m === 'e';
/** Los modos que se avisan con /start: los de arriba y la Arena ('a'), que sube su resultado por server/arena.ts, no por /submit. */
const isRunMode = (m: unknown) => isMode(m) || m === 'a';
/** ¿Marca de Defensa (puntuación en vez de tiempo, sin tablas por Pokémon)? */
const isDefense = (m: string) => m === 'd' || m === 'e';
/** ¿Marca de un equipo? */
const isGroup = (m: string) => m === 'g' || m === 'e';
/** Una partida de Defensa no dura más de esto (en segundos de partida). */
export const MAX_DEFENSE_S = 3 * 3600;

// ---------------- periodos ----------------

function madridDate(date: Date) {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day };
}

/** Semana ISO (lunes a domingo) de una fecha y-m-d. */
function isoWeek(y: number, m: number, d: number) {
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7) };
}

/** Los ids de los periodos de una fecha, en hora de Madrid. Igual que en el cliente (src/net/ranking.ts). */
export function periodIds(date = new Date()): Record<Period, string> {
  const { y, m, d } = madridDate(date);
  const w = isoWeek(y, m, d);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return { d: 'd' + y + p2(m) + p2(d), w: 'w' + w.year + '-' + p2(w.week), m: 'm' + y + p2(m), a: ALL };
}

/** Una tabla válida: modo, periodo y (sólo en el histórico) Pokémon. */
const BOARD_RE = /^([sgde])_(d\d{8}|w\d{4}-\d{2}|m\d{6}|all2)(?:_p([1-9]\d{0,3}))?$/;
function validBoard(b: unknown): b is string {
  if (typeof b !== 'string' || b.length > 40) return false;
  const m = BOARD_RE.exec(b);
  return !!m && (!m[3] || (!isDefense(m[1]) && m[2] === ALL && +m[3] <= MAX_DEX));
}
/** El id de una marca: un uid o varios (equipo) unidos con '_'. */
const ENTRY_RE = /^[1-9]\d{0,12}(?:_[1-9]\d{0,12}){0,7}$/;
export const UID_RE = /^[1-9]\d{0,12}$/;

// ---------------- tipos ----------------

interface Row { id: string; t: number; uids: string[]; names: string[]; dex: number[]; shiny: boolean[]; lv: number; kills: number }
interface EntryRow { id: string; t: number; lv: number; kills: number }

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

const MARKED_DDL = `CREATE TABLE IF NOT EXISTS ranking_marked (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  at INTEGER NOT NULL
)`;
const ready = new WeakSet<Db>();
function ensureMarked(db: Db) {
  if (ready.has(db)) return;
  db.raw.exec(MARKED_DDL);
  ready.add(db);
}
/** ¿Está marcada la cuenta (no puede subir marcas)? También la usa el guardado (server/save-rules.ts). */
export function isMarkedAccount(db: Db, userId: number) {
  ensureMarked(db);
  return db.raw.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM ranking_marked WHERE user_id = ?').get(userId)!.n > 0;
}
/** Marca una cuenta como sospechosa. */
export function markAccount(db: Db, userId: number, at = Date.now()) {
  ensureMarked(db);
  db.raw.query<unknown, [number, number]>('INSERT OR IGNORE INTO ranking_marked (user_id, at) VALUES (?, ?)').run(userId, at);
}

export function createRanking(db: Db, opts: RankingOptions = {}): Module {
  const raw = db.raw;
  const now = opts.now ?? Date.now;
  const admins = new Set((opts.admins ?? (process.env.ADMIN_USERS || '').split(',')).map(s => s.trim().toLowerCase()).filter(Boolean));

  raw.exec(`
    CREATE TABLE IF NOT EXISTS ranking_entries (
      board TEXT NOT NULL,
      id TEXT NOT NULL,
      t INTEGER NOT NULL,
      lv INTEGER NOT NULL,
      kills INTEGER NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (board, id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS ranking_entries_top ON ranking_entries(board, t DESC, at, id);
    CREATE INDEX IF NOT EXISTS ranking_entries_t ON ranking_entries(t);
    CREATE TABLE IF NOT EXISTS ranking_members (
      board TEXT NOT NULL,
      id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dex INTEGER NOT NULL,
      shiny INTEGER NOT NULL,
      PRIMARY KEY (board, id, user_id),
      FOREIGN KEY (board, id) REFERENCES ranking_entries(board, id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS ranking_members_user ON ranking_members(user_id, board);
    -- Si se va un miembro (cuenta borrada), el equipo ya no existe: se va la marca entera.
    CREATE TRIGGER IF NOT EXISTS ranking_members_gone AFTER DELETE ON ranking_members
    BEGIN DELETE FROM ranking_entries WHERE board = OLD.board AND id = OLD.id; END;
    CREATE TABLE IF NOT EXISTS ranking_runs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      started INTEGER NOT NULL,
      mode TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ranking_reports (
      id INTEGER PRIMARY KEY,
      board TEXT NOT NULL,
      entry TEXT NOT NULL,
      names TEXT NOT NULL,
      t INTEGER NOT NULL,
      by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at INTEGER NOT NULL,
      UNIQUE (board, entry, by)
    );
    CREATE INDEX IF NOT EXISTS ranking_reports_at ON ranking_reports(at);
    -- Una marca que se quita arrastra sus reportes.
    CREATE TRIGGER IF NOT EXISTS ranking_entries_gone AFTER DELETE ON ranking_entries
    BEGIN DELETE FROM ranking_reports WHERE board = OLD.board AND entry = OLD.id; END;
  `);
  ensureMarked(db);

  const q = {
    userExists: raw.query<{ id: number; name: string }, [number]>('SELECT id, name FROM users WHERE id = ?'),
    isMarked: raw.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM ranking_marked WHERE user_id = ?'),
    setRun: raw.query<unknown, [number, number, string]>(
      'INSERT INTO ranking_runs (user_id, started, mode) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET started = excluded.started, mode = excluded.mode'),
    getRun: raw.query<{ started: number; mode: string }, [number]>('SELECT started, mode FROM ranking_runs WHERE user_id = ?'),
    delRun: raw.query<unknown, [number]>('DELETE FROM ranking_runs WHERE user_id = ?'),
    // Sólo escribe si mejora (t estrictamente mayor); RETURNING sólo devuelve fila si escribió.
    upsertEntry: raw.query<{ t: number }, [string, string, number, number, number, number]>(`
      INSERT INTO ranking_entries (board, id, t, lv, kills, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(board, id) DO UPDATE SET t = excluded.t, lv = excluded.lv, kills = excluded.kills, at = excluded.at
        WHERE excluded.t > ranking_entries.t
      RETURNING t`),
    upsertMember: raw.query<unknown, [string, string, number, number, number]>(`
      INSERT INTO ranking_members (board, id, user_id, dex, shiny) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(board, id, user_id) DO UPDATE SET dex = excluded.dex, shiny = excluded.shiny`),
    entry: raw.query<EntryRow, [string, string]>('SELECT id, t, lv, kills FROM ranking_entries WHERE board = ? AND id = ?'),
    top: raw.query<EntryRow, [string, number]>(
      'SELECT id, t, lv, kills FROM ranking_entries WHERE board = ? ORDER BY t DESC, at, id LIMIT ?'),
    // La mejor marca de un jugador en una tabla (con su `at`, para contar quién va delante).
    mine: raw.query<EntryRow & { at: number }, [string, number]>(`
      SELECT e.id, e.t, e.lv, e.kills, e.at FROM ranking_entries e
      JOIN ranking_members m ON m.board = e.board AND m.id = e.id
      WHERE e.board = ? AND m.user_id = ? ORDER BY e.t DESC, e.at, e.id LIMIT 1`),
    above: raw.query<{ n: number }, [string, number, number, string]>(`
      SELECT COUNT(*) AS n FROM ranking_entries
      WHERE board = ?1 AND (t > ?2 OR (t = ?2 AND (at < ?3 OR (at = ?3 AND id < ?4))))`),
    delEntry: raw.query<unknown, [string, string]>('DELETE FROM ranking_entries WHERE board = ? AND id = ?'),
    delMine: raw.query<unknown, [number]>(
      'DELETE FROM ranking_entries WHERE (board, id) IN (SELECT board, id FROM ranking_members WHERE user_id = ?)'),
    countMine: raw.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM ranking_members WHERE user_id = ?'),
    // Las de Defensa no: su `t` es una puntuación, no un tiempo.
    purgeCount: raw.query<{ rows: number; boards: number }, [number]>(
      "SELECT COUNT(*) AS rows, COUNT(DISTINCT board) AS boards FROM ranking_entries WHERE t > ? AND board NOT LIKE 'd!_%' ESCAPE '!' AND board NOT LIKE 'e!_%' ESCAPE '!'"),
    purge: raw.query<unknown, [number]>("DELETE FROM ranking_entries WHERE t > ? AND board NOT LIKE 'd!_%' ESCAPE '!' AND board NOT LIKE 'e!_%' ESCAPE '!'"),
    reports: raw.query<{ id: number; board: string; entry: string; names: string; t: number; at: number }, []>(
      'SELECT id, board, entry, names, t, at FROM ranking_reports ORDER BY at DESC, id DESC LIMIT 400'),
    delReport: raw.query<unknown, [number]>('DELETE FROM ranking_reports WHERE id = ?'),
    mark: raw.query<unknown, [number, number]>('INSERT OR IGNORE INTO ranking_marked (user_id, at) VALUES (?, ?)'),
    unmark: raw.query<unknown, [number]>('DELETE FROM ranking_marked WHERE user_id = ?'),
    marked: raw.query<{ id: number; name: string; data: string | null }, []>(`
      SELECT u.id, u.name, s.data FROM ranking_marked k JOIN users u ON u.id = k.user_id
      LEFT JOIN saves s ON s.user_id = u.id ORDER BY k.at DESC LIMIT 100`),
  };

  const writeOk = limiter(120, 60_000);
  const readOk = limiter(600, 60_000);

  /** Quita una marca de una tabla. → 1 si estaba (los cambios que cuenta SQLite incluyen los de las cascadas) */
  function removeEntry(board: string, id: string) {
    if (!q.entry.get(board, id)) return 0;
    q.delEntry.run(board, id);
    return 1;
  }

  const isMarked = (userId: number) => q.isMarked.get(userId)!.n > 0;

  /** Rellena las filas con sus miembros (nombres de la base de datos). */
  function rowsOf(board: string, entries: EntryRow[]): Row[] {
    if (!entries.length) return [];
    const ms = raw.query<{ id: string; user_id: number; dex: number; shiny: number; name: string }, (string)[]>(`
      SELECT m.id, m.user_id, m.dex, m.shiny, u.name FROM ranking_members m JOIN users u ON u.id = m.user_id
      WHERE m.board = ? AND m.id IN (${placeholders(entries.length)}) ORDER BY m.id, m.user_id`)
      .all(board, ...entries.map(e => e.id));
    const by = new Map<string, Row>();
    for (const e of entries) by.set(e.id, { id: e.id, t: e.t, uids: [], names: [], dex: [], shiny: [], lv: e.lv, kills: e.kills });
    // El orden de los miembros es numérico (ids como '9_10'), no el del texto.
    ms.sort((a, b) => a.user_id - b.user_id);
    for (const m of ms) {
      const r = by.get(m.id);
      if (!r) continue;
      r.uids.push(String(m.user_id)); r.names.push(m.name); r.dex.push(m.dex); r.shiny.push(!!m.shiny);
    }
    return entries.map(e => by.get(e.id)!);
  }

  /** Nombre del modo y periodo → tabla. null si algo no es válido. */
  function boardOf(mode: unknown, period: unknown, dex: unknown): string | null {
    if (!isMode(mode)) return null;
    if (typeof period !== 'string' || !(PERIODS as readonly string[]).includes(period)) return null;
    let b = mode + '_' + periodIds(new Date(now()))[period as Period];
    // El filtro por Pokémon sólo existe en el histórico (en los demás periodos no cuenta); en Defensa, en ninguno.
    if (dex !== undefined && dex !== null && dex !== '' && period === 'a' && !isDefense(mode)) {
      const n = typeof dex === 'string' && /^[1-9]\d{0,3}$/.test(dex) ? +dex : NaN;
      if (!(n >= 1 && n <= MAX_DEX)) return null;
      b += '_p' + n;
    }
    return b;
  }

  // ---------------- jugadores ----------------

  async function start(req: Request, uid: number) {
    const b = await readBody(req, 1024);
    if (b instanceof Response) return b;
    if (!isRunMode(b.mode)) return fail(400, 'Modo no válido.');
    q.setRun.run(uid, now(), b.mode);
    return json({ ok: true });
  }

  async function submit(req: Request, uid: number) {
    const b = await readBody(req, 2048);
    if (b instanceof Response) return b;
    // Desde aquí no hay await: comprobar la partida y gastarla es una sola operación.
    const mode = b.mode;
    if (!isMode(mode)) return fail(400, 'Modo no válido.');
    let t: number, lv: number, kills: number;
    /** Los segundos que tienen que haber pasado de verdad desde /start. */
    let realS: number;
    if (isDefense(mode)) {
      const { waves, lives, secs } = b;
      if (!isInt(waves) || waves < 1 || waves > MAX_WAVE) return fail(400, 'Oleadas no válidas.');
      if (!isInt(lives) || lives < 0 || lives > START_LIVES) return fail(400, 'Vidas no válidas.');
      // Hay que esperar a que salgan los enemigos; a ×2, eso pasa en la mitad de tiempo real.
      if (!isInt(secs) || secs < Math.floor(minDefenseTime(waves) * 0.9) || secs > MAX_DEFENSE_S) return fail(400, 'Tiempo no válido.');
      if (!isInt(b.kills) || b.kills < 0 || b.kills > maxDefenseKills(waves)) return fail(400, 'Derrotados no válidos.');
      t = defenseScore(waves, lives); lv = waves; kills = b.kills; realS = secs / 2;
    } else {
      ({ t, lv, kills } = b);
      if (!isInt(t) || t < MIN_T || t > MAX_T) return fail(400, 'Tiempo no válido.');
      if (!isInt(lv) || lv < 1 || lv > 10 + t / 4) return fail(400, 'Nivel no válido.');
      if (!isInt(kills) || kills < 0 || kills > 100 + t * 12) return fail(400, 'Derrotados no válidos.');
      realS = t;
    }

    // Quién forma la marca y con qué Pokémon.
    let team: { uid: number; dex: number; shiny: boolean }[];
    if (!isGroup(mode)) {
      if (!isInt(b.dex) || b.dex < 1 || b.dex > MAX_DEX) return fail(400, 'Pokémon no válido.');
      team = [{ uid, dex: b.dex, shiny: b.shiny === true }];
    } else {
      const ms = b.members;
      if (!Array.isArray(ms) || ms.length < 2 || ms.length > (mode === 'e' ? MAX_TEAM_TD : MAX_TEAM)) return fail(400, 'Equipo no válido.');
      team = [];
      for (const m of ms) {
        if (!m || typeof m !== 'object' || typeof m.uid !== 'string' || !UID_RE.test(m.uid)) return fail(400, 'Equipo no válido.');
        if (!isInt(m.dex) || m.dex < 1 || m.dex > MAX_DEX) return fail(400, 'Pokémon no válido.');
        team.push({ uid: +m.uid, dex: m.dex, shiny: m.shiny === true });
      }
      if (new Set(team.map(m => m.uid)).size !== team.length) return fail(400, 'Equipo no válido.');
      if (!team.some(m => m.uid === uid)) return fail(403, 'Sólo el anfitrión, dentro del equipo, puede subir la marca.');
      if (team.some(m => !q.userExists.get(m.uid))) return fail(400, 'Equipo no válido.');
      if (opts.verifyTeam) {
        const aviso = q.getRun.get(uid);
        if (!opts.verifyTeam(uid, team.map(m => m.uid), aviso ? aviso.started : null)) return fail(403, 'El equipo no coincide con tu sala.');
      }
    }
    if (team.some(m => isMarked(m.uid))) return fail(403, 'Una cuenta marcada no puede subir marcas.');

    // Anti-trampas: la partida tiene que haber empezado (según el reloj del servidor) y haber durado esto.
    const run = q.getRun.get(uid);
    if (!run || run.mode !== mode) return fail(409, 'No hay una partida en curso.');
    const elapsed = (now() - run.started) / 1000;
    if (realS > elapsed + GRACE_S) return fail(400, 'Tiempo imposible.');
    q.delRun.run(uid);                      // una partida, una subida

    team.sort((a, c) => a.uid - c.uid);
    const id = team.map(m => m.uid).join('_');
    const ids = periodIds(new Date(now()));
    const boards: [string, Period | 'p'][] = PERIODS.map(p => [mode + '_' + ids[p], p]);
    if (!isDefense(mode)) for (const d of new Set(team.map(m => m.dex))) boards.push([mode + '_' + ALL + '_p' + d, 'p']);

    const at = now();
    const better: string[] = [];
    raw.transaction(() => {
      for (const [board, p] of boards) {
        if (!q.upsertEntry.get(board, id, t, lv, kills, at)) continue;
        for (const m of team) q.upsertMember.run(board, id, m.uid, m.dex, m.shiny ? 1 : 0);
        if (p !== 'p' && !better.includes(p)) better.push(p);
      }
    })();
    return json({ ok: true, better: PERIODS.filter(p => better.includes(p)) });
  }

  function top(url: URL, uid: number) {
    const board = boardOf(url.searchParams.get('mode'), url.searchParams.get('period'), url.searchParams.get('dex'));
    if (!board) return fail(400, 'Tabla no válida.');
    const circleRaw = url.searchParams.get('circle');
    let entries: EntryRow[];
    if (circleRaw === null) entries = q.top.all(board, TOP);
    else {
      const set = new Set<number>([uid]);
      for (const s of circleRaw.split(',').slice(0, 30)) if (UID_RE.test(s)) set.add(+s);
      entries = raw.query<EntryRow, (string | number)[]>(`
        SELECT e.id, e.t, e.lv, e.kills FROM ranking_entries e
        WHERE e.board = ? AND EXISTS (SELECT 1 FROM ranking_members m WHERE m.board = e.board AND m.id = e.id AND m.user_id IN (${placeholders(set.size)}))
        ORDER BY e.t DESC, e.at, e.id LIMIT ${TOP}`).all(board, ...set);
    }
    return json({ ok: true, rows: rowsOf(board, entries), admin: isAdmin(uid) });
  }

  function rank(url: URL, uid: number) {
    const board = boardOf(url.searchParams.get('mode'), url.searchParams.get('period'), url.searchParams.get('dex'));
    if (!board) return fail(400, 'Tabla no válida.');
    const mine = q.mine.get(board, uid);
    if (!mine) return json({ ok: true, rank: null, admin: isAdmin(uid) });
    const pos = q.above.get(board, mine.t, mine.at, mine.id)!.n + 1;
    return json({ ok: true, rank: { pos, t: mine.t, row: rowsOf(board, [mine])[0] }, admin: isAdmin(uid) });
  }

  async function report(req: Request, uid: number) {
    const b = await readBody(req, 1024);
    if (b instanceof Response) return b;
    if (!validBoard(b.board) || typeof b.e !== 'string' || !ENTRY_RE.test(b.e)) return fail(400, 'Marca no válida.');
    const e = q.entry.get(b.board, b.e);
    if (!e) return fail(404, 'Esa marca ya no existe.');
    const row = rowsOf(b.board, [e])[0];
    if (row.uids.includes(String(uid))) return fail(400, 'No puedes reportar tu propia marca.');
    const r = raw.run('INSERT OR IGNORE INTO ranking_reports (board, entry, names, t, by, at) VALUES (?, ?, ?, ?, ?, ?)',
      [b.board, b.e, JSON.stringify(row.names.slice(0, MAX_TEAM_TD)), e.t, uid, now()]);
    return json({ ok: true, dup: r.changes === 0 });
  }

  function removeMine(uid: number) {
    const n = q.countMine.get(uid)!.n;
    q.delMine.run(uid);
    return json({ ok: true, removed: n });
  }

  // ---------------- moderación ----------------

  function isAdmin(uid: number) {
    const u = q.userExists.get(uid);
    if (!u) return false;
    return admins.has(u.name.toLowerCase());
  }

  async function admin(req: Request, ctxPath: string, url: URL) {
    const route = req.method + ' ' + ctxPath;
    if (route === 'GET /ranking/admin/reports') {
      const by = new Map<string, { board: string; e: string; names: string[]; t: number; n: number; ids: string[]; at: number }>();
      for (const r of q.reports.all()) {
        const k = r.board + '__' + r.entry;
        let g = by.get(k);
        if (!g) { g = { board: r.board, e: r.entry, names: JSON.parse(r.names), t: r.t, n: 0, ids: [], at: r.at }; by.set(k, g); }
        g.n++; g.ids.push(String(r.id));
      }
      return json({ ok: true, groups: [...by.values()].sort((a, c) => c.n - a.n || c.at - a.at) });
    }
    if (route === 'GET /ranking/admin/entry') {
      const board = url.searchParams.get('board'), e = url.searchParams.get('e');
      if (!validBoard(board) || !e || !ENTRY_RE.test(e)) return fail(400, 'Marca no válida.');
      const en = q.entry.get(board, e);
      return json({ ok: true, row: en ? rowsOf(board, [en])[0] : null });
    }
    if (route === 'GET /ranking/admin/marked') {
      const accounts = q.marked.all().map(a => {
        let v: any = {};
        try { v = a.data ? JSON.parse(a.data) : {}; } catch { /* partida ilegible */ }
        return { uid: String(a.id), name: a.name, coins: +v.coins || 0, t1: +(v.tickets || {}).t1 || 0, t10: +(v.tickets || {}).t10 || 0,
                 owned: Object.keys(v.owned || {}).length };
      });
      return json({ ok: true, accounts });
    }
    if (req.method !== 'POST') return null;
    const b = await readBody(req);
    if (b instanceof Response) return b;
    if (route === 'POST /ranking/admin/remove') {
      if (!validBoard(b.board) || typeof b.e !== 'string' || !ENTRY_RE.test(b.e)) return fail(400, 'Marca no válida.');
      return json({ ok: true, removed: removeEntry(b.board, b.e) });
    }
    if (route === 'POST /ranking/admin/remove-all') {
      if (typeof b.e !== 'string' || !ENTRY_RE.test(b.e) || !isMode(b.mode)) return fail(400, 'Marca no válida.');
      const boards = new Set<string>(PERIODS.map(p => b.mode + '_' + periodIds(new Date(now()))[p]));
      if (b.dexes !== undefined) {
        if (!Array.isArray(b.dexes) || b.dexes.length > 50) return fail(400, 'Pokémon no válidos.');
        for (const d of b.dexes) {
          if (!isInt(d) || d < 1 || d > MAX_DEX) return fail(400, 'Pokémon no válidos.');
          boards.add(b.mode + '_' + ALL + '_p' + d);
        }
      }
      if (b.also !== undefined && b.also !== null) {
        if (!validBoard(b.also)) return fail(400, 'Tabla no válida.');
        boards.add(b.also);
      }
      let removed = 0;
      raw.transaction(() => {
        for (const board of boards) removed += removeEntry(board, b.e);
        // Y de las tablas de cada Pokémon: una marca quitada no puede seguir saliendo en ellas.
        const dexBoards = raw.query<{ board: string }, [string, string]>(
          "SELECT board FROM ranking_entries WHERE id = ? AND board LIKE ? ESCAPE '!'").all(b.e, b.mode + '!_' + ALL + '!_p%');
        for (const { board } of dexBoards) removed += removeEntry(board, b.e);
      })();
      return json({ ok: true, removed });
    }
    if (route === 'POST /ranking/admin/purge') {
      // Con un tope tan bajo se vaciaría el ranking por un descuido.
      if (!isInt(b.maxT) || b.maxT < 600) return fail(400, 'Tope no válido (mínimo 600 s).');
      const c = q.purgeCount.get(b.maxT)!;
      q.purge.run(b.maxT);
      return json({ ok: true, rows: c.rows, boards: c.boards });
    }
    if (route === 'POST /ranking/admin/mark') {
      if (typeof b.uid !== 'string' || !UID_RE.test(b.uid) || typeof b.on !== 'boolean') return fail(400, 'Petición no válida.');
      if (!q.userExists.get(+b.uid)) return fail(404, 'No existe esa cuenta.');
      if (b.on) q.mark.run(+b.uid, now()); else q.unmark.run(+b.uid);
      return json({ ok: true });
    }
    if (route === 'POST /ranking/admin/dismiss') {
      if (!Array.isArray(b.ids) || b.ids.length > 500 || b.ids.some((i: unknown) => typeof i !== 'string' || !/^\d{1,15}$/.test(i))) return fail(400, 'Petición no válida.');
      raw.transaction(() => { for (const i of b.ids) q.delReport.run(+i); })();
      return json({ ok: true });
    }
    return null;
  }

  // ---------------- rutas ----------------

  return async (req, ctx) => {
    if (!ctx.path.startsWith('/ranking/')) return null;
    if (!ctx.user) return fail(401, 'Sesión caducada: vuelve a entrar.');
    const uid = ctx.user.id;
    const url = new URL(req.url);
    const route = ctx.method + ' ' + ctx.path;

    if (route === 'GET /ranking/admin') return json({ ok: true, admin: isAdmin(uid) });
    if (ctx.path.startsWith('/ranking/admin/')) {
      if (!isAdmin(uid)) return fail(403, 'No autorizado.');
      if (!writeOk(uid + ':a')) return fail(429, 'Demasiadas peticiones. Espera un poco.');
      return (await admin(req, ctx.path, url)) ?? fail(404, 'No existe.');
    }

    switch (route) {
      case 'POST /ranking/start': case 'POST /ranking/submit': case 'POST /ranking/report': case 'DELETE /ranking/mine':
        if (!writeOk(String(uid))) return fail(429, 'Demasiadas peticiones. Espera un poco.');
        if (route === 'POST /ranking/start') return start(req, uid);
        if (route === 'POST /ranking/submit') return submit(req, uid);
        if (route === 'POST /ranking/report') return report(req, uid);
        return removeMine(uid);
      case 'GET /ranking/top': case 'GET /ranking/rank':
        if (!readOk(String(uid))) return fail(429, 'Demasiadas peticiones. Espera un poco.');
        return route === 'GET /ranking/top' ? top(url, uid) : rank(url, uid);
    }
    return fail(404, 'No existe.');
  };
}
