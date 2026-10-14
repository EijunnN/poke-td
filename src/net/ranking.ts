import { G } from '../g';
/* ============ ranking.ts — clasificación de tiempo aguantado ============
 * Habla con el servidor propio (server/ranking.ts, rutas /api/ranking/...) con
 * la sesión de G.DB.session. Sin sesión todo se comporta como "sin conexión":
 * no se sube nada, las listas salen vacías y no se lanza ningún error.
 *
 *   tabla = modo + periodo:
 *     s_d20261008   solitario, hoy            g_...   en grupo    d_...   Defensa
 *     s_w2026-41    semana ISO                s_m202610  mes
 *     s_all2        histórico
 *     s_all2_p25    histórico sólo con Pikachu (el filtro por Pokémon sólo
 *                   existe en el histórico)
 *   id = tu uid (solitario) o los uid del equipo ordenados y unidos con "_".
 *
 * Los periodos se cuentan en hora de España (Europe/Madrid). El servidor lleva
 * el anti-trampas (hora de inicio de la partida, tiempos y niveles posibles) y
 * calcula los puestos, así que aquí no hay caché ni umbrales.
 */
export const Ranking = (() => {
  const TZ = 'Europe/Madrid';
  const PERIODS: [string, string][] = [['d', 'Diario'], ['w', 'Semanal'], ['m', 'Mensual'], ['a', 'Histórico']];
  // Las runs de menos de 1 minuto no se suben (el servidor tampoco las acepta).
  const MIN_T = 60;
  const ALL = 'all2';                     // histórico

  /** Una marca del ranking tal como la sirve el servidor. */
  interface Row { id: string; t: number; uids: string[]; names: string[]; dex: number[]; shiny: boolean[]; lv: number; kills: number }
  interface Result { status: number; j: any }
  interface ReportGroup { board: string; e: string; names: string[]; t: number; n: number; ids: string[]; at: number }
  interface Member { uid: string; name?: string; dex: number; shiny?: boolean }

  const session = () => G.DB.session;
  const rowOf = (v: any): Row => ({ id: v.id, t: v.t, uids: v.uids || [], names: v.names || [], dex: v.dex || [],
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
    return mode + '_' + periodIds()[period] + (dex && period === 'a' && mode !== 'd' ? '_p' + dex : '');
  }

  // ---------------- llamadas al servidor ----------------

  /** Llamada a la API del ranking. null si no hay sesión o no hay red. */
  async function call(method: string, path: string, body?: unknown): Promise<Result | null> {
    if (!session()) return null;
    try { return await G.DB.api(method, '/ranking' + path, body); }
    catch (e) { console.warn('[Ranking] sin conexión:', e.message); return null; }
  }
  /** Como call, pero lanza si el servidor responde con un error (para lo que la pantalla enseña). */
  async function need(method: string, path: string, body?: unknown): Promise<any> {
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
  function runStarted(mode: string) {
    if (!session()) return;
    const go = async (n: number) => {
      const r = await call('POST', '/start', { mode });
      if ((!r || r.status >= 500) && n < 2) setTimeout(() => go(n + 1), 15000);
      else if (r && !r.j.ok) console.warn('[Ranking] inicio:', r.j.error);
    };
    busy.then(() => go(0));
  }
  /** La subida de una marca (para que la partida siguiente espere a que acabe). */
  function track<T>(p: Promise<T>): Promise<T> { busy = p.catch(() => {}); return p; }

  // ---------------- guardar ----------------

  function announce(better: string[]) {
    if (!better.length) return;
    const names = { d: 'de hoy', w: 'de la semana', m: 'del mes', a: 'histórico' };
    const best = PERIODS.map(p => p[0]).filter(p => better.includes(p)).pop();
    G.UI.toast('¡Nueva mejor marca ' + names[best] + ' en el ranking!', 3400);
  }

  /** Sube la marca. → periodos donde ha mejorado */
  async function send(body: Record<string, unknown>): Promise<string[]> {
    const r = await call('POST', '/submit', body);
    if (!r || !r.j.ok) {
      // Una cuenta marcada o una partida sin avisar no son un fallo que enseñar: sólo no sube.
      if (r) console.warn('[Ranking] no se pudo subir:', r.j.error);
      return [];
    }
    const better: string[] = r.j.better || [];
    announce(better);
    return better;
  }

  function submitSolo(r: { t: number; lv: number; kills: number; dex: number; shiny?: boolean }) { return track(submitSoloNow(r)); }
  async function submitSoloNow(r: { t: number; lv: number; kills: number; dex: number; shiny?: boolean }) {
    if (!session() || r.t < MIN_T) return [];
    return send({ mode: 's', t: r.t, lv: r.lv, kills: r.kills, dex: r.dex, shiny: !!r.shiny });
  }

  /** La sube el anfitrión, con todo el equipo. */
  function submitGroup(r: { t: number; lv: number; kills: number; members: Member[] }) { return track(submitGroupNow(r)); }
  async function submitGroupNow(r: { t: number; lv: number; kills: number; members: Member[] }) {
    if (!session() || r.t < MIN_T || !r.members || r.members.length < 2) return [];
    return send({ mode: 'g', t: r.t, lv: r.lv, kills: r.kills,
                  members: r.members.map(m => ({ uid: String(m.uid), dex: m.dex, shiny: !!m.shiny })) });
  }

  /**
   * Defensa: oleadas superadas, vidas que quedaban, segundos de partida y tu Pokémon.
   * El servidor guarda la puntuación oleadas·100 + vidas (ver td-waves.ts, defenseScore).
   */
  function submitDefense(r: { waves: number; lives: number; secs: number; kills: number; dex: number; shiny?: boolean }) { return track(submitDefenseNow(r)); }
  async function submitDefenseNow(r: { waves: number; lives: number; secs: number; kills: number; dex: number; shiny?: boolean }) {
    if (!session() || r.waves < 1) return [];
    return send({ mode: 'd', waves: r.waves, lives: r.lives, secs: r.secs, kills: r.kills, dex: r.dex, shiny: !!r.shiny });
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
    return (j.rows as any[]).map(rowOf);
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
  const repKey = () => 'ps.rk.rep.' + (session() ? session().uid : '');
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
  function noteAdmin(j: any) {
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

  return { PERIODS, periodIds, board, runStarted, submitSolo, submitGroup, submitDefense, top, myRank, removeMine,
           report, reported, isAdmin, reports, entryInfo, removeEntry, purgeAbove, removeEverywhere, setMarked, dismiss, markedAccounts };
})();
G.Ranking = Ranking;

declare module '../g' {
  interface Registry { Ranking: typeof Ranking }
}
