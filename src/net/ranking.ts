import { G } from '../g';
/* ============ ranking.ts — clasificación de tiempo aguantado ============
 * Habla con el servidor propio (server/ranking.ts, rutas /api/ranking/...) con
 * la sesión de G.DB.session. Sin sesión todo se comporta como "sin conexión":
 * no se sube nada, las listas salen vacías y no se lanza ningún error.
 *
 *   tabla = modo + periodo:
 *     s_d20261008   solitario, hoy            g_...   en grupo    d_...   Defensa    e_...   Defensa en grupo
 *     s_w2026-41    semana ISO                s_m202610  mes
 *     s_all2        histórico
 *     s_all2_p25    histórico sólo con Pikachu (el filtro por Pokémon sólo
 *                   existe en el histórico)
 *   id = tu uid (solitario) o los uid del equipo ordenados y unidos con "_".
 *
 * Los periodos se cuentan en hora de España (Europe/Madrid). El servidor lleva
 * el anti-trampas (hora de inicio de la partida, tiempos y niveles posibles) y
 * calcula los puestos, así que aquí no hay caché ni umbrales.
 *
 * Subir una marca puede fallar sin que el jugador lo sepa (el récord personal se guarda
 * siempre, el ranking no): cada intento acaba en un RankResult que se avisa con
 * `onResult` (y queda en `last`) para que la pantalla de fin de partida diga el motivo.
 * Red caída, 5xx y 429 se reintentan con espera antes de rendirse.
 */
/** Una marca del ranking tal como la sirve el servidor. */
export interface Row { id: string; t: number; uids: string[]; names: string[]; dex: number[]; shiny: boolean[]; lv: number; kills: number }
/**
 * Cómo acabó subir una marca. `ok` con `better` vacío = subió pero no mejora tus marcas. Sin `ok`,
 * `reason` dice por qué (texto para el jugador); con `skipped` ni se intentó porque la partida
 * no cuenta (muy corta, sin rivales...): no hace falta avisar.
 */
export interface RankResult { mode: string; ok: boolean; better: string[]; reason?: string; skipped?: boolean }

export const Ranking = (() => {
  const TZ = 'Europe/Madrid';
  const PERIODS: [string, string][] = [['d', 'Diario'], ['w', 'Semanal'], ['m', 'Mensual'], ['a', 'Histórico']];
  // Las runs de menos de 1 minuto no se suben (el servidor tampoco las acepta).
  const MIN_T = 60;
  // Ninguna marca real pasa de 1 h (la Sentencia de Arceus acaba las partidas hacia el minuto 31-32;
  // server/ranking.ts, MAX_T, lo rechaza): no se acota, un tiempo así es un fallo y se dice.
  const MAX_T = 3600;
  // Esperas entre reintentos (red caída, 5xx, 429) de /start y de /submit.
  const START_RETRY = [5000, 10000, 20000], SUBMIT_RETRY = [4000, 10000, 20000];
  const ALL = 'all2';                     // histórico

  /** Respuesta de la API: `j` es el JSON, que cambia con cada ruta (de ahí el any). */
  interface Result { status: number; j: any }
  /** Una marca como viene en el JSON: lo que falta se rellena en rowOf. */
  type RowWire = Pick<Row, 'id' | 't' | 'lv' | 'kills'> & Partial<Row>;
  interface ReportGroup { board: string; e: string; names: string[]; t: number; n: number; ids: string[]; at: number }
  interface Member { uid: string; name?: string; dex: number; shiny?: boolean }

  const session = () => G.DB.session;
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  let lastResult: RankResult | null = null;
  const resultFns = new Set<(r: RankResult) => void>();
  /** Anota y avisa el resultado de una subida. → los periodos mejorados (lo que devuelven submit*) */
  function finish(r: RankResult): string[] {
    lastResult = r;
    if (!r.ok && !r.skipped) console.warn('[Ranking] marca no subida:', r.reason);
    resultFns.forEach(fn => { try { fn(r); } catch (e) { console.warn(e); } });
    return r.better;
  }
  const rowOf = (v: RowWire): Row => ({ id: v.id, t: v.t, uids: v.uids || [], names: v.names || [], dex: v.dex || [],
                                    shiny: v.shiny || [], lv: v.lv, kills: v.kills });

  // ---------------- periodos ----------------

  function madridDate(date: Date) {
    const p: Record<string, string> = {};
    for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)) p[x.type] = x.value;
    return { y: +p.year, m: +p.month, d: +p.day };
  }

  /** Semana ISO (lunes a domingo) de una fecha y-m-d. */
  function isoWeek(y: number, m: number, d: number) {
    const t = new Date(Date.UTC(y, m - 1, d));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return { year: t.getUTCFullYear(), week: Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7) };
  }

  function periodIds(date = new Date()) {
    const { y, m, d } = madridDate(date);
    const w = isoWeek(y, m, d);
    const p2 = (n: number) => String(n).padStart(2, '0');
    return { d: 'd' + y + p2(m) + p2(d), w: 'w' + w.year + '-' + p2(w.week), m: 'm' + y + p2(m), y: 'y' + y, a: ALL };
  }

  /** El filtro por Pokémon sólo existe en el histórico. */
  function board(mode: string, period: string, dex?: number | null) {
    return mode + '_' + (periodIds() as Record<string, string>)[period] + (dex && period === 'a' && mode !== 'd' && mode !== 'e' ? '_p' + dex : '');
  }

  // ---------------- llamadas al servidor ----------------

  /** Llamada a la API del ranking. null si no hay sesión o no hay red. */
  async function call(method: string, path: string, body?: unknown): Promise<Result | null> {
    if (!session()) return null;
    try { return await G.DB.api(method, '/ranking' + path, body); }
    catch (e) { console.warn('[Ranking] sin conexión:', (e as Error).message); return null; }
  }
  /** Como call, pero lanza si el servidor responde con un error (para lo que la pantalla enseña). */
  async function need(method: string, path: string, body?: unknown): Promise<any> {   // (JSON de cada ruta: ver Result)
    const r = await call(method, path, body);
    if (!r) throw new Error('Sin conexión.');
    if (!r.j.ok) throw new Error(r.j.error || 'Error del servidor.');
    noteAdmin(r.j);
    return r.j;
  }
  const qs = (o: Record<string, string | number | null | undefined>) =>
    '?' + Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => k + '=' + encodeURIComponent(v as string)).join('&');

  // ---------------- anti-trampas ----------------

  /**
   * Al empezar cada partida (en grupo, el anfitrión) el servidor apunta la hora:
   * ninguna marca puede durar más que el tiempo real desde entonces. Antes se
   * espera a que acabe de subirse la marca de la partida anterior, para no
   * cambiarle la hora a mitad.
   */
  let busy: Promise<unknown> = Promise.resolve();
  /** El aviso de inicio de la partida en marcha (con sus reintentos): la subida espera a que acabe. */
  let starting: Promise<unknown> = Promise.resolve();
  /** ¿Vale la pena repetir esta respuesta? (sin red, error del servidor o 429) */
  const retryable = (r: Result | null) => !r || r.status >= 500 || r.status === 429;
  function runStarted(mode: string) {
    if (!session()) return;
    starting = Promise.all([busy, starting]).then(async () => {
      for (let n = 0; ; n++) {
        const r = await call('POST', '/start', { mode });
        if (!retryable(r)) { if (r && !r.j.ok) console.warn('[Ranking] inicio:', r.j.error); return; }
        if (n >= START_RETRY.length || !session()) return;
        await sleep(START_RETRY[n]);
      }
    }).catch(() => {});
  }
  /** La subida de una marca (para que la partida siguiente espere a que acabe). */
  function track<T>(p: Promise<T>): Promise<T> { busy = p.catch(() => {}); return p; }

  // ---------------- guardar ----------------

  function announce(better: string[]) {
    if (!better.length) return;
    const names: Record<string, string> = { d: 'de hoy', w: 'de la semana', m: 'del mes', a: 'histórico' };
    const best = PERIODS.map(p => p[0]).filter(p => better.includes(p)).pop();
    G.UI.toast('¡Nueva mejor marca ' + names[best] + ' en el ranking!', 3400);
  }

  /** El motivo (texto para el jugador) de una subida que no ha salido bien. */
  function whyNot(r: Result | null, retried: boolean): string {
    if (!r) return 'No hay conexión con el servidor.';
    if (r.status === 429) return 'El servidor tiene demasiadas peticiones ahora mismo.';
    if (r.status >= 500) return 'El servidor ha fallado.';
    // 409 tras un reintento: pudo llegar la primera vez y perderse sólo la respuesta.
    if (r.status === 409) return retried ? 'No se ha podido confirmar si la marca llegó al servidor.' : 'El servidor no registró el inicio de la partida.';
    return r.j.error || 'El servidor la ha rechazado.';
  }

  /** Sube la marca (reintenta si falla la red, el servidor o hay 429). → periodos donde ha mejorado */
  async function send(body: Record<string, unknown>): Promise<string[]> {
    const mode = String(body.mode);
    if (typeof body.t === 'number' && body.t > MAX_T) {
      return finish({ mode, ok: false, better: [], reason: 'Esta partida dura más de ' + MAX_T / 60 + ' minutos y el ranking no la admite.' });
    }
    await starting;                      // el servidor sólo admite marcas de una partida que ha visto empezar
    let r: Result | null = null, tries = 0;
    for (;; tries++) {
      r = await call('POST', '/submit', body);
      if (!retryable(r) || tries >= SUBMIT_RETRY.length || !session()) break;
      await sleep(SUBMIT_RETRY[tries]);
    }
    if (!r || !r.j.ok) return finish({ mode, ok: false, better: [], reason: whyNot(r, tries > 0) });
    const better: string[] = r.j.better || [];
    announce(better);
    return finish({ mode, ok: true, better });
  }

  /** La partida no cuenta para el ranking (no es un fallo): se anota el motivo y no se sube. */
  const skip = (mode: string, reason: string) => finish({ mode, ok: false, better: [], reason, skipped: true });

  function submitSolo(r: { t: number; lv: number; kills: number; dex: number; shiny?: boolean }) { return track(submitSoloNow(r)); }
  async function submitSoloNow(r: { t: number; lv: number; kills: number; dex: number; shiny?: boolean }) {
    if (!session()) return [];
    if (r.t < MIN_T) return skip('s', 'Las partidas de menos de 1 minuto no cuentan para el ranking.');
    return send({ mode: 's', t: r.t, lv: r.lv, kills: r.kills, dex: r.dex, shiny: !!r.shiny });
  }

  /** La sube el anfitrión, con todo el equipo. */
  function submitGroup(r: { t: number; lv: number; kills: number; members: Member[] }) { return track(submitGroupNow(r)); }
  async function submitGroupNow(r: { t: number; lv: number; kills: number; members: Member[] }) {
    if (!session()) return [];
    if (r.t < MIN_T) return skip('g', 'Las partidas de menos de 1 minuto no cuentan para el ranking.');
    if (!r.members || r.members.length < 2) return skip('g', 'Una partida en grupo necesita al menos 2 jugadores.');
    return send({ mode: 'g', t: r.t, lv: r.lv, kills: r.kills,
                  members: r.members.map(m => ({ uid: String(m.uid), dex: m.dex, shiny: !!m.shiny })) });
  }

  /**
   * Defensa: oleadas superadas, vidas que quedaban, segundos de partida y tu Pokémon.
   * El servidor guarda la puntuación oleadas·100 + vidas (ver td-waves.ts, defenseScore).
   */
  function submitDefense(r: { waves: number; lives: number; secs: number; kills: number; dex: number; shiny?: boolean }) { return track(submitDefenseNow(r)); }
  async function submitDefenseNow(r: { waves: number; lives: number; secs: number; kills: number; dex: number; shiny?: boolean }) {
    if (!session()) return [];
    if (r.waves < 1) return skip('d', 'Hay que superar al menos una oleada para entrar en el ranking.');
    return send({ mode: 'd', waves: r.waves, lives: r.lives, secs: r.secs, kills: r.kills, dex: r.dex, shiny: !!r.shiny });
  }

  /** Defensa en grupo: la sube el anfitrión, con todo el equipo (cada uno con su héroe). */
  function submitDefenseGroup(r: { waves: number; lives: number; secs: number; kills: number; members: Member[] }) { return track(submitDefenseGroupNow(r)); }
  async function submitDefenseGroupNow(r: { waves: number; lives: number; secs: number; kills: number; members: Member[] }) {
    if (!session()) return [];
    if (r.waves < 1) return skip('e', 'Hay que superar al menos una oleada para entrar en el ranking.');
    if (!r.members || r.members.length < 2) return skip('e', 'Una partida en grupo necesita al menos 2 jugadores.');
    return send({ mode: 'e', waves: r.waves, lives: r.lives, secs: r.secs, kills: r.kills,
                  members: r.members.map(m => ({ uid: String(m.uid), dex: m.dex, shiny: !!m.shiny })) });
  }

  // ---------------- leer ----------------

  /**
   * Mejores marcas de una tabla (las 50 primeras).
   * @param friendsOnly  sólo tú y tus amigos
   */
  async function top(mode: string, period: string, dex?: number | null, friendsOnly?: boolean): Promise<Row[]> {
    if (!session()) return [];
    const circle = friendsOnly ? G.Social.friends.filter(f => f.status === 'ok').map(f => f.uid).slice(0, 30).join(',') || ',' : null;
    const j = await need('GET', '/top' + qs({ mode, period, dex: period === 'a' ? dex : null, circle }));
    return (j.rows as RowWire[]).map(rowOf);
  }

  /** Tu puesto en la tabla (aunque no salgas en el top). → { pos, t, row } | null */
  async function myRank(mode: string, period: string, dex?: number | null): Promise<{ pos: number; t: number; row: Row } | null> {
    if (!session()) return null;
    const j = await need('GET', '/rank' + qs({ mode, period, dex: period === 'a' ? dex : null }));
    return j.rank ? { pos: j.rank.pos, t: j.rank.t, row: rowOf(j.rank.row) } : null;
  }

  /** Quita todas tus marcas (al borrar la cuenta el servidor ya se las lleva solo). */
  async function removeMine() {
    await call('DELETE', '/mine');
  }

  // ---------------- reportes y moderación ----------------

  /** Reporta una marca sospechosa (una vez por marca y jugador). → true si se ha enviado */
  const repKey = () => 'ps.rk.rep.' + (session() ? session()!.uid : '');
  function reported(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(repKey()) || '[]')); } catch (e) { return new Set(); } }
  async function report(b: string, row: Row) {
    if (!session()) return false;
    const key = b + '__' + row.id;
    const done = reported();
    if (!done.has(key)) {
      // (Si ya lo habías reportado desde otro ordenador, el servidor no lo repite: da igual.)
      const r = await call('POST', '/report', { board: b, e: row.id });
      if (!r || (!r.j.ok && r.status !== 404)) return false;
      done.add(key);
      try { localStorage.setItem(repKey(), JSON.stringify([...done].slice(-300))); } catch (e) { /* lleno */ }
    }
    return true;
  }

  // Cuenta de moderación: la decide el servidor (variable ADMIN_USERS). Aquí sólo
  // se recuerda lo que dijo, que llega con cada lista del ranking; isAdmin es
  // síncrona, así que hasta la primera respuesta vale false (y se pregunta).
  const admin = new Map<string, boolean>();
  const asking = new Set<string>();
  function noteAdmin(j: { admin?: unknown } | null) {
    const s = session();
    if (s && j && typeof j.admin === 'boolean') admin.set(s.uid, j.admin);
  }
  function isAdmin(): boolean {
    const s = session();
    if (!s) return false;
    if (!admin.has(s.uid) && !asking.has(s.uid)) {
      asking.add(s.uid);
      call('GET', '/admin').then(r => { if (r) noteAdmin(r.j); }).finally(() => asking.delete(s.uid));
    }
    return !!admin.get(s.uid);
  }

  /** Admin: los reportes, juntos por marca (los más reportados primero). */
  async function reports(): Promise<ReportGroup[]> {
    return (await need('GET', '/admin/reports')).groups;
  }

  /** Admin: la fila de una marca en su tabla (o null si ya no está). */
  async function entryInfo(b: string, e: string): Promise<Row | null> {
    const j = await need('GET', '/admin/entry' + qs({ board: b, e }));
    return j.row ? rowOf(j.row) : null;
  }

  /** Admin: quita una marca de una tabla. */
  async function removeEntry(b: string, e: string) {
    await need('POST', '/admin/remove', { board: b, e });
  }

  /** Admin: quita la marca de un jugador o equipo de todas las tablas de ahora (y de `also`). */
  async function removeEverywhere(e: string, mode: string, dexes: number[] = [], also: string | null = null) {
    await need('POST', '/admin/remove-all', { e, mode, dexes, also });
  }

  /**
   * Admin: quita de TODAS las tablas las marcas de más de `maxT` segundos. Con
   * la Sentencia de Arceus nadie legal pasa de ~32 min. → { rows, boards }
   */
  async function purgeAbove(maxT: number, onProgress?: (i: number, n: number) => void): Promise<{ rows: number; boards: number }> {
    const j = await need('POST', '/admin/purge', { maxT });
    if (onProgress) onProgress(1, 1);
    return { rows: j.rows, boards: j.boards };
  }

  /** Admin: marca o desmarca una cuenta (marcada = no puede subir marcas). */
  async function setMarked(uid: string, on: boolean) { await need('POST', '/admin/mark', { uid: String(uid), on: !!on }); }
  /** Admin: borra reportes ya vistos. */
  async function dismiss(ids: string[]) { await need('POST', '/admin/dismiss', { ids: ids.map(String) }); }
  /** Admin: cuentas marcadas. */
  async function markedAccounts(): Promise<{ uid: string; name: string; coins: number; t1: number; t10: number; owned: number }[]> {
    return (await need('GET', '/admin/marked')).accounts;
  }

  return { PERIODS, periodIds, board, runStarted,
           /** Avisa del resultado de cada subida (ver RankResult); `last` es el de la última. */
           onResult(fn: (r: RankResult) => void) { resultFns.add(fn); },
           get last() { return lastResult; }, submitSolo, submitGroup, submitDefense, submitDefenseGroup, top, myRank, removeMine,
           report, reported, isAdmin, reports, entryInfo, removeEntry, purgeAbove, removeEverywhere, setMarked, dismiss, markedAccounts };
})();
G.Ranking = Ranking;

// Si una marca que cuenta no entra en el ranking, se dice (antes el récord salía en el menú y en el ranking no).
Ranking.onResult(r => {
  if (!r.ok && !r.skipped && r.reason && G.UI) G.UI.toast(G.T('Esta partida no ha entrado en el ranking:') + ' ' + G.T(r.reason), 6000);
});

declare module '../g' {
  interface Registry { Ranking: typeof Ranking }
}
