/* ============ server/save-rules.ts — anti-trampas del guardado de partida ============
 * La partida la escribe el navegador, así que se puede editar. Estas reglas
 * (portadas de las de `saves` de las reglas de Firestore del original; ver el historial de git) deciden qué hace
 * PUT /api/save con cada partida que llega. Hay tres salidas:
 *
 *   ok       la partida se guarda tal cual (salvo lo de "nada conseguido se pierde")
 *   sus      se guarda IGUAL y la cuenta queda apuntada como sospechosa (tabla save_suspects y
 *            el registro del servidor) para que la mire el admin. NO la saca del ranking: antes la
 *            marcaba (ranking_marked) y, con falsos positivos, dejaba fuera a ella y a sus equipos
 *   reject   400, no se guarda: sólo si la partida no tiene forma de partida (campos
 *            con el tipo cambiado)
 *
 * Por qué una partida imposible NO se rechaza: un falso positivo (alguien que jugó
 * muchas horas sin conexión y sube todo de golpe, una cuenta local importada...)
 * perdería progreso legítimo para siempre, y rechazar a un tramposo tampoco le
 * quita nada: seguiría jugando con su copia local. Tampoco se marca la cuenta: el admin
 * ve el aviso en el registro y, si hace falta, la marca a mano (Moderación).
 *
 * Por qué sí se rechaza la partida con la forma rota: el cliente siempre sube números
 * y objetos (db.ts, sanitize/migrate); si llegan otra cosa, es una petición a mano, y
 * guardarla estropearía la partida en todos los dispositivos de la cuenta.
 *
 * Nada conseguido se pierde: si la partida nueva trae menos que la guardada en
 * colecciones que sólo crecen (Pokémon, shinies, logros, legendarios, arenas,
 * objetos, movimientos evolucionados) o en las estadísticas, el servidor restituye
 * lo que falta antes de guardar. El cliente ya fusiona así (db.ts, merge), de modo que
 * una partida legítima nunca lo nota; además evita que se borren logros para volver a
 * cobrar su premio.
 *
 * Presupuesto entre dos guardados (todo en "tiradas": un ticket x1 = 1, un x10 = 10):
 *   tienes + lo que pudiste ganar - lo que te queda = tiradas que pudiste hacer, y
 *   tienen que alcanzar para los Pokémon, shinies y monedas nuevos. Lo que pudiste
 *   ganar crece con el tiempo REAL transcurrido desde el guardado anterior (hora del
 *   servidor), con mucho margen: se calibró con alguien muy bueno jugando sin parar.
 *   El margen fijo (k) también es proporcional a ese tiempo, hasta LIMITS.marginSecs: si valiera
 *   entero con un minuto, un script que subiera cada minuto lo cobraría cada vez. (Por eso PUT /api/save no
 *   necesita tope de frecuencia: api.ts, SAVE_GAP.)
 *
 * Depósito de margen (por cuenta, en la tabla save_budget): los tickets llegan A GOLPES (un ×10 de
 * un jefe, del legendario de la grieta, de Gholdengo o de un cofre grande vale 10 tiradas de una vez,
 * y en una partida con suerte caen varios), mientras que el presupuesto de arriba los reparte por
 * tiempo. Lo que un guardado traiga de más sobre ese presupuesto se paga de un depósito que se llena
 * con el tiempo real (BUDGET.rate por segundo) hasta BUDGET.cap. Sin él, una racha de suerte con
 * guardados seguidos (los tickets se guardan al cogerlos, como mucho cada 30 s) marcaba la cuenta.
 * Sólo cubre tickets NUEVOS guardados (lo que llega por suerte): no Pokémon, shinies ni monedas que
 * no se expliquen (ésos llegan con tickets ya guardados: gastarlos en el gacha es otro guardado).
 * Calibrado con las cuentas reales (2026-10-16): la que más, 197 tiradas en 11,8 h contando los
 * premios de logros (≈0,3 por minuto); el depósito rellena 6 por minuto, y guarda hasta 80 (8 ×10:
 * una partida con mucha suerte). Un script que invente tickets lo vacía en minutos y salta el aviso; uno
 * que invente Pokémon, a la primera (tests/save-rules.test.ts).
 *   Cambios respecto a las reglas originales: el tope de tiempo por guardado pasa de
 *   3 h a 12 h (el cliente ya no guarda cada 2 h y una tarde sin conexión no debe
 *   marcar a nadie) y el premio de cada logro se mira en una tabla con los premios
 *   del juego (ACH_VALUE; tests/save-rules.test.ts la compara con src/data/achievements.ts).
 */
import type { Db } from './db';
import { isMarkedAccount } from './ranking';

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const size = (v: unknown) => (isObj(v) ? Object.keys(v).length : 0);

/** Las colecciones que sólo crecen (clave -> cuándo). Igual que el union de db.ts, merge. */
const GROWING = ['owned', 'shiny', 'legends', 'arenas', 'itemsFound', 'evoMoves', 'ach'] as const;

/** El depósito de margen (ver la cabecera): tiradas por segundo de tiempo real, y tope. */
export const BUDGET = { rate: 0.1, cap: 80 };

/** Tiradas que vale el premio de cada logro (ticket x1 = 1, x10 = 10, 300 monedas = 1). */
export const ACH_VALUE: Record<string, number> = {
  own1: 0.333, own10: 2, own50: 5, own100: 10, own250: 20, own500: 30, ownAll: 100, shiny1: 3, shiny5: 10, shiny20: 20, pulls100: 10,
  time5: 0.667, time10: 4, time15: 10, time20: 20, lvl20: 2, lvl40: 10, judge: 10, judge60: 20, judgeBoss: 20, runs50: 10,
  kills1k: 2, kills10k: 10, kills100k: 30, boss1: 2, boss25: 10, boss100: 20, evo1: 3, evo25: 10, evoAll: 30, items5: 3, itemsAll: 10,
  rift1: 3, rift10: 10, arenas: 20, leg10: 10, leg30: 20, legAll: 50, mis10: 3, mis50: 10, mis200: 30, group1: 2, group10: 10,
  tdWave10: 3, tdWin: 10, tdPerfect: 20, tdEndless40: 20, tdGroupWin: 10,
};
/** Un logro por legendario (leg_<dex>): 1 ticket x1. Un id que no conoce se paga como uno de 10 (el juego puede ir por delante del servidor). */
const achValue = (id: string) => ACH_VALUE[id] ?? (/^leg_\d+$/.test(id) ? 1 : 10);

export const LIMITS = {
  /** Pokémon y shinies posibles (966 en el juego, con holgura). */
  collection: 1100,
  /** Logros posibles (43 + uno por legendario, con holgura). */
  ach: 200,
  /** Tope de tiempo de juego que se concede entre dos guardados. */
  gapSecs: 12 * 3600,
  /** Segundos desde el guardado anterior para que valga el margen fijo entero (antes bastaban 60: subiendo cada minuto se cobraba cada vez). */
  marginSecs: 600,
  /** Una partida nueva cuenta como "recién empezada" si se creó hace menos de esto. */
  freshMs: 2 * 86400000,
};

export type Verdict =
  /** `used`: lo que se ha pagado del depósito de margen (tiradas). */
  | { kind: 'ok'; save: Obj; used?: number }
  | { kind: 'sus'; save: Obj; why: string }
  | { kind: 'reject'; error: string };

/** ¿Tiene forma de partida? (campos presentes con el tipo cambiado = no). → el motivo, o null */
function shapeError(s: Obj): string | null {
  const money = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (!money(s.coins)) return 'coins';
  if (s.tickets !== undefined && (!isObj(s.tickets) || !money(s.tickets.t1) || !money(s.tickets.t10))) return 'tickets';
  if (s.created !== undefined && !(typeof s.created === 'number' && Number.isFinite(s.created))) return 'created';
  if (s.stats !== undefined && (!isObj(s.stats) || (s.stats.missionsDone !== undefined && !money(s.stats.missionsDone)))) return 'stats';
  for (const k of GROWING) if (s[k] !== undefined && !isObj(s[k])) return k;
  return null;
}

/** Devuelve la partida nueva con lo que sólo crece, al menos como estaba en la anterior. */
function keepProgress(prev: Obj, next: Obj): Obj {
  const out: Obj = { ...next };
  for (const c of GROWING) {
    if (!isObj(prev[c])) continue;
    const merged: Obj = { ...(isObj(out[c]) ? out[c] : {}) };
    for (const k of Object.keys(prev[c])) if (!(k in merged)) merged[k] = prev[c][k];
    out[c] = merged;
  }
  if (isObj(prev.stats)) {
    const st: Obj = { ...(isObj(out.stats) ? out.stats : {}) };
    for (const [k, v] of Object.entries(prev.stats)) if (typeof v === 'number' && Number.isFinite(v) && !(num(st[k]) >= v)) st[k] = v;
    out.stats = st;
  }
  return out;
}

const tk = (s: Obj, k: string) => num(isObj(s.tickets) ? s.tickets[k] : 0);
const mis = (s: Obj) => num(isObj(s.stats) ? s.stats.missionsDone : 0);

/** Lo mínimo de cualquier partida que no se pueda explicar con un presupuesto. */
function saneSave(s: Obj): string | null {
  if (size(s.owned) > LIMITS.collection) return 'demasiados Pokémon';
  if (size(s.shiny) > LIMITS.collection) return 'demasiados shinies';
  return null;
}

/** Una partida nueva (la cuenta no tiene ninguna guardada): lo que da empezar. */
function freshSave(s: Obj, now: number): string | null {
  if (num(s.coins) > 2000 || tk(s, 't1') > 10 || tk(s, 't10') > 2) return 'monedas o tickets de más para una partida nueva';
  if (size(s.owned) > 3 || size(s.shiny) > 1 || size(s.ach) > 5 || mis(s) > 3) return 'colección de más para una partida nueva';
  if (!(num(s.created) > now - LIMITS.freshMs)) return 'partida nueva con fecha vieja';
  return null;
}

/**
 * ¿Puede ser la continuación de `o` pasados `secs` segundos? → el motivo si no (`short`: las tiradas que
 * faltan en el presupuesto; si es eso lo único, el depósito de margen puede cubrirlas)
 */
function possibleSave(o: Obj, n: Obj, secs: number, now: number): { why: string; short?: number; gain?: number } | null {
  if (num(n.created) !== num(o.created)) return { why: 'la fecha de creación ha cambiado' };
  if (size(n.ach) > LIMITS.ach) return { why: 'demasiados logros' };
  const dm = mis(n) - mis(o);
  if (mis(n) > 10 + (now - num(o.created)) / 86400000 * 5) return { why: 'demasiadas misiones para los días que lleva la partida' };

  const e = Math.min(Math.max(secs, 0), LIMITS.gapSecs);          // segundos de juego que pudo haber
  const k = Math.min(Math.max(secs, 0) / LIMITS.marginSecs, 1);   // margen fijo (0-1): proporcional al tiempo real desde el último guardado, así subir a menudo no lo multiplica
  let achV = 0;
  for (const id of Object.keys(isObj(n.ach) ? n.ach : {})) if (!(isObj(o.ach) && id in o.ach)) achV += achValue(id);

  const have = tk(o, 't1') + 10 * tk(o, 't10')
    + 3 * k + e / 30 + 3 * dm                                      // tickets x1 que pudo ganar
    + 10 * (k + e / 300 + dm)                                      // tickets x10
    + achV                                                         // premios de los logros nuevos
    - tk(n, 't1') - 10 * tk(n, 't10');
  const need = Math.max(
    Math.max(0, size(n.owned) - size(o.owned) - 3 * k - e / 600),
    Math.max(size(n.shiny) - size(o.shiny) - 2 * k - e / 900,
      // monedas: lo de jugar, logros y misiones; lo que sobre, reembolsos del gacha (< 300 por tirada)
      (num(n.coins) - num(o.coins) - 8000 * k - 40 * e - 1000 * dm) / 300));
  // Tiradas en tickets nuevos guardados (lo único que llega a golpes por suerte).
  const gain = Math.max(0, tk(n, 't1') + 10 * tk(n, 't10') - tk(o, 't1') - 10 * tk(o, 't10'));
  return have >= need ? null : { why: 'más de lo que se puede ganar en ese tiempo', short: need - have, gain };
}

/**
 * Función pura: decide qué hacer con la partida `next` que llega cuando la guardada es `prev`
 * (null si la cuenta no tiene).
 * @param o.secs    segundos reales desde el guardado anterior (hora del servidor)
 * @param o.now     hora actual en ms
 * @param o.marked  la cuenta ya está marcada: no se vuelve a juzgar
 * @param o.budget  tiradas en el depósito de margen de la cuenta (ver la cabecera; sin él, 0)
 */
export function judgeSave(prev: Obj | null, next: Obj, o: { secs: number; now: number; marked?: boolean; budget?: number }): Verdict {
  const bad = shapeError(next);
  if (bad) return { kind: 'reject', error: 'Partida no válida (' + bad + ').' };
  const save = prev && isObj(prev) ? keepProgress(prev, next) : next;
  if (o.marked) return { kind: 'ok', save };
  const sane = saneSave(save) ?? (prev && isObj(prev) ? null : freshSave(save, o.now));
  if (sane) return { kind: 'sus', save, why: sane };
  if (!prev || !isObj(prev)) return { kind: 'ok', save };
  const p = possibleSave(prev, save, o.secs, o.now);
  if (!p) return { kind: 'ok', save };
  // Sólo falta presupuesto, y por tickets nuevos (una racha de suerte): si el depósito alcanza, se paga
  // de ahí. Pokémon, shinies o monedas sin tickets que los expliquen no son suerte: eso no lo cubre.
  if (p.short !== undefined && p.short <= Math.min(p.gain ?? 0, Math.max(0, o.budget ?? 0))) return { kind: 'ok', save, used: p.short };
  return { kind: 'sus', save, why: p.why };
}

// ---------------- sospechosas (tabla save_suspects) ----------------

const suspectsReady = new WeakSet<Db>();
function ensureSuspects(db: Db) {
  if (suspectsReady.has(db)) return;
  db.raw.exec(`CREATE TABLE IF NOT EXISTS save_suspects (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    why TEXT NOT NULL
  )`);
  suspectsReady.add(db);
}
/** ¿Algún guardado de la cuenta fue imposible? (Sólo informa: no cierra nada.) */
export function isSuspect(db: Db, userId: number) {
  ensureSuspects(db);
  return !!db.raw.query<{ n: number }, [number]>('SELECT 1 AS n FROM save_suspects WHERE user_id = ?').get(userId);
}
function markSuspect(db: Db, userId: number, why: string, now: number) {
  ensureSuspects(db);
  db.raw.query<unknown, [number, number, string]>('INSERT OR IGNORE INTO save_suspects (user_id, at, why) VALUES (?, ?, ?)').run(userId, now, why);
}

// ---------------- depósito de margen (tabla save_budget) ----------------

const budgetReady = new WeakSet<Db>();
function ensureBudget(db: Db) {
  if (budgetReady.has(db)) return;
  db.raw.exec(`CREATE TABLE IF NOT EXISTS save_budget (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tokens REAL NOT NULL,
    at INTEGER NOT NULL
  )`);
  budgetReady.add(db);
}
/** Las tiradas del depósito de la cuenta ahora: lo que quedaba más lo rellenado desde entonces (lleno si no tenía). */
export function readBudget(db: Db, userId: number, now = Date.now()) {
  ensureBudget(db);
  const r = db.raw.query<{ tokens: number; at: number }, [number]>('SELECT tokens, at FROM save_budget WHERE user_id = ?').get(userId);
  if (!r) return BUDGET.cap;
  return Math.min(BUDGET.cap, r.tokens + Math.max(0, now - r.at) / 1000 * BUDGET.rate);
}
function writeBudget(db: Db, userId: number, tokens: number, now: number) {
  ensureBudget(db);
  db.raw.query<unknown, [number, number, number]>(
    'INSERT INTO save_budget (user_id, tokens, at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET tokens = excluded.tokens, at = excluded.at')
    .run(userId, Math.max(0, Math.min(BUDGET.cap, tokens)), now);
}

/**
 * Lo que necesita PUT /api/save: juzga la partida contra la guardada de la cuenta.
 * @param base  versión que el cliente leyó; con otra, el guardado no se hará (409) y no se juzga
 * @returns la partida a guardar y, cuando se haya guardado, `stored()` (apunta el aviso si hacía falta)
 */
export function vetSave(db: Db, userId: number, save: Obj, base: number):
  { ok: true; save: Obj; stored: () => void } | { ok: false; error: string } {
  const cur = db.save(userId);
  if (cur && cur.ver !== base) return { ok: true, save, stored: () => {} };
  let prev: Obj | null = null;
  try { if (cur) prev = JSON.parse(cur.data); } catch { /* partida guardada ilegible: se trata como nueva */ }
  const now = Date.now();
  const budget = readBudget(db, userId, now);
  // (Una partida guardada que no se puede leer no sirve de referencia: no se juzga.)
  // (Una ya sospechosa o marcada no se vuelve a juzgar: llenaría el registro con el mismo aviso.)
  const marked = isSuspect(db, userId) || isMarkedAccount(db, userId);
  const v = judgeSave(prev, save, { secs: cur ? (now - cur.updated) / 1000 : 0, now, marked: marked || (!!cur && !prev), budget });
  if (v.kind === 'reject') return { ok: false, error: v.error };
  return {
    ok: true, save: v.save,
    stored: () => {
      if (v.kind === 'sus') { markSuspect(db, userId, v.why, now); console.warn(`[save] cuenta ${userId} sospechosa (no se marca): ${v.why}`); }
      writeBudget(db, userId, budget - (v.kind === 'ok' ? v.used ?? 0 : 0), now);
    },
  };
}
