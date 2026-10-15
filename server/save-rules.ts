/* ============ server/save-rules.ts — anti-trampas del guardado de partida ============
 * La partida la escribe el navegador, así que se puede editar. Estas reglas
 * (portadas de las de `saves` de las reglas de Firestore del original; ver el historial de git) deciden qué hace
 * PUT /api/save con cada partida que llega. Hay tres salidas:
 *
 *   ok       la partida se guarda tal cual (salvo lo de "nada conseguido se pierde")
 *   sus      se guarda IGUAL, pero la cuenta queda marcada: no puede subir marcas al
 *            ranking hasta que un admin la desmarque (server/ranking.ts, ranking_marked)
 *   reject   400, no se guarda: sólo si la partida no tiene forma de partida (campos
 *            con el tipo cambiado)
 *
 * Por qué una partida imposible NO se rechaza: un falso positivo (alguien que jugó
 * muchas horas sin conexión y sube todo de golpe, una cuenta local importada...)
 * perdería progreso legítimo para siempre, y rechazar a un tramposo tampoco le
 * quita nada: seguiría jugando con su copia local. Marcarlo sí: lo que le importa
 * (el ranking) se cierra, y el error se arregla con un clic del admin. Es lo que
 * hacía el original (el cliente reintentaba y subía con `sus = true`).
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
 *   Cambios respecto a las reglas originales: el tope de tiempo por guardado pasa de
 *   3 h a 12 h (el cliente ya no guarda cada 2 h y una tarde sin conexión no debe
 *   marcar a nadie) y el premio de cada logro se mira en una tabla con los premios
 *   del juego (ACH_VALUE; tests/save-rules.test.ts la compara con src/data/achievements.ts).
 */
import type { Db } from './db';
import { isMarkedAccount, markAccount } from './ranking';

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const size = (v: unknown) => (isObj(v) ? Object.keys(v).length : 0);

/** Las colecciones que sólo crecen (clave -> cuándo). Igual que el union de db.ts, merge. */
const GROWING = ['owned', 'shiny', 'legends', 'arenas', 'itemsFound', 'evoMoves', 'ach'] as const;

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
  | { kind: 'ok'; save: Obj }
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

/** ¿Puede ser la continuación de `o` pasados `secs` segundos? → el motivo si no */
function possibleSave(o: Obj, n: Obj, secs: number, now: number): string | null {
  if (num(n.created) !== num(o.created)) return 'la fecha de creación ha cambiado';
  if (size(n.ach) > LIMITS.ach) return 'demasiados logros';
  const dm = mis(n) - mis(o);
  if (mis(n) > 10 + (now - num(o.created)) / 86400000 * 5) return 'demasiadas misiones para los días que lleva la partida';

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
  return have >= need ? null : 'más de lo que se puede ganar en ese tiempo';
}

/**
 * Función pura: decide qué hacer con la partida `next` que llega cuando la guardada es `prev`
 * (null si la cuenta no tiene).
 * @param o.secs    segundos reales desde el guardado anterior (hora del servidor)
 * @param o.now     hora actual en ms
 * @param o.marked  la cuenta ya está marcada: no se vuelve a juzgar
 */
export function judgeSave(prev: Obj | null, next: Obj, o: { secs: number; now: number; marked?: boolean }): Verdict {
  const bad = shapeError(next);
  if (bad) return { kind: 'reject', error: 'Partida no válida (' + bad + ').' };
  const save = prev && isObj(prev) ? keepProgress(prev, next) : next;
  if (o.marked) return { kind: 'ok', save };
  const why = saneSave(save) ?? (prev && isObj(prev) ? possibleSave(prev, save, o.secs, o.now) : freshSave(save, o.now));
  return why ? { kind: 'sus', save, why } : { kind: 'ok', save };
}

/**
 * Lo que necesita PUT /api/save: juzga la partida contra la guardada de la cuenta.
 * @param base  versión que el cliente leyó; con otra, el guardado no se hará (409) y no se juzga
 * @returns la partida a guardar y, cuando se haya guardado, `stored()` (marca la cuenta si hacía falta)
 */
export function vetSave(db: Db, userId: number, save: Obj, base: number):
  { ok: true; save: Obj; stored: () => void } | { ok: false; error: string } {
  const cur = db.save(userId);
  if (cur && cur.ver !== base) return { ok: true, save, stored: () => {} };
  let prev: Obj | null = null;
  try { if (cur) prev = JSON.parse(cur.data); } catch { /* partida guardada ilegible: se trata como nueva */ }
  const now = Date.now();
  // (Una partida guardada que no se puede leer no sirve de referencia: no se juzga.)
  const v = judgeSave(prev, save, { secs: cur ? (now - cur.updated) / 1000 : 0, now, marked: isMarkedAccount(db, userId) || (!!cur && !prev) });
  if (v.kind === 'reject') return { ok: false, error: v.error };
  return {
    ok: true, save: v.save,
    stored: () => { if (v.kind === 'sus') { markAccount(db, userId, now); console.warn(`[save] cuenta ${userId} marcada: ${v.why}`); } },
  };
}
