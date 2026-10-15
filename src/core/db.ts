import { G } from '../g';
import type { MissionBook } from '../data/missions';
/* ============ db.ts — base de datos: servidor propio o local ============
 * TODO el acceso a datos persistentes pasa por aquí. El resto del juego sólo
 * usa G.DB.*.
 *
 * Dos modos (se decide en ready()):
 *
 *   NUBE  (servidor propio: server/, Bun + SQLite)
 *     Si el juego se abre desde una web y responde /api/health. Cuentas de
 *     nombre y contraseña; la partida se guarda en el servidor y se puede
 *     seguir en cualquier dispositivo. Además se guarda una copia local para
 *     poder jugar sin conexión; al sincronizar se FUSIONA (ver merge): las
 *     colecciones se unen y nunca se pierde un Pokémon ni un shiny.
 *
 *   LOCAL (localStorage)
 *     Sin servidor (p. ej. `bun run dev` sin `bun run server`) o con doble
 *     clic (file://): cuentas y partidas sólo en este navegador.
 *       ps.accounts      { clave: { name, salt, hash, created } }
 *       ps.save.<clave>  partida de esa cuenta
 *       ps.session       última cuenta con sesión iniciada
 *
 * El modo invitado juega con una partida en memoria que no se guarda.
 */

/** Pokémon conseguido: cuándo y cómo ('starter' | 'gacha' | 'wild'...). */
export interface OwnedEntry { at: number; from: string }

export interface SaveStats {
  runs: number; bestTime: number; bestLevel: number; totalKills: number; pulls: number;
  coinsEarned: number; shinies: number; bossesTotal: number; riftWins: number; evolutions: number;
  missionsDone: number; groupRuns: number; bestGroupTime: number;
  judged?: number; judgeTime?: number; judgeBosses?: number;   // Sentencia de Arceus (se crean al usarlas)
  [k: string]: number | undefined;       // para leerlas por nombre (logros, fusión...)
  // Defensa (modes/td.ts; se crean al usarlas): partidas, mejor oleada superada, victorias,
  // victorias en grupo y victorias sin perder ninguna vida.
  tdRuns?: number; tdBestWave?: number; tdWins?: number; tdGroupWins?: number; tdPerfect?: number;
}

/** Partida guardada de una cuenta. Las claves de los mapas son números de Pokédex o ids. */
export interface SaveData {
  v: number;
  name: string;
  created: number;
  updated: number;                       // última modificación (para fusionar)
  coins: number;
  owned: Record<string, OwnedEntry>;
  shiny: Record<string, OwnedEntry>;
  partner: number | null;                // dex del Pokémon con el que juegas
  partnerShiny: boolean;
  starter: number | null;
  personality: { trait: string; scores: Record<string, number> } | null;
  upgrades: Record<string, number>;      // (antiguo) mejoras de la cuenta
  pupg: Record<string, Record<string, number>>;   // dex -> { id -> nivel }
  tickets: { t1: number; t10: number };
  pity: Record<string, number>;          // generación del banner -> tiradas sin ★5
  legends: Record<string, number>;
  arenas: Record<string, number>;
  itemsFound: Record<string, number>;
  evoMoves: Record<string, number>;
  ach: Record<string, number>;
  missions: MissionBook;                 // misiones del día / semana (systems/progress)
  profile: { favs: { dex: number; shiny: boolean }[]; title: string };
  stats: SaveStats;
  pupgDone?: boolean;                    // migración v2 -> v3 hecha
  pbind?: Record<string, (string | null)[]>;   // atajos de movimientos por Pokémon
  pban?: Record<string, string[]>;       // movimientos vetados por Pokémon
  [extra: string]: any;                  // campos que añaden otros módulos
}

/** Resultado de registro, entrada y demás operaciones de cuenta. */
export interface AuthResult { ok: boolean; error?: string; isNew?: boolean }

export const DB = (() => {
  const K_ACC = 'ps.accounts', K_SES = 'ps.session', K_SAVE = 'ps.save.';
  const K_CLOUD = 'ps.cloud.';
  const VERSION = 3;
  const START_COINS = 500;

  let mode: 'cloud' | 'local' = 'local';       // 'cloud' | 'local'
  let localReason = '';     // por qué no hay servidor: 'file' | 'config' | 'error'
  let user: string | null = null;          // nombre visible
  let key: string | null = null;           // clave de la partida (nombre en minúsculas)
  let guest = false;
  let save: SaveData | null = null;
  let storageOk = true;

  // ---------------- almacenamiento local seguro ----------------

  // (any: lo que haya guardado en el navegador, de cualquier forma)
  function read(k: string): any {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; }
    catch (e) { storageOk = false; return null; }
  }
  function write(k: string, v: unknown) {
    const s = JSON.stringify(v);
    try { localStorage.setItem(k, s); return true; }
    catch (e) {
      // Navegador lleno (sobre todo por lo que guarda el ranking): se libera lo
      // prescindible y se reintenta. Antes la copia de la partida dejaba de
      // guardarse sin avisar y, al recargar, se volvía a la de la nube.
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key && /^ps\.rk\.c\./.test(key)) localStorage.removeItem(key);
        }
        localStorage.setItem(k, s); return true;
      } catch (e2) { storageOk = false; return false; }
    }
  }
  function remove(k: string) { try { localStorage.removeItem(k); } catch (e) { /* nada */ } }

  // ---------------- partida ----------------

  function newSave(name: string): SaveData {
    return {
      v: VERSION,
      name,
      created: Date.now(),
      updated: Date.now(),    // última modificación (para fusionar)
      coins: START_COINS,
      owned: {},              // dex -> { at, from: 'starter'|'gacha'|'wild' }
      shiny: {},              // dex -> { at, from } — variantes shiny conseguidas
      partner: null,          // dex del Pokémon con el que juegas
      partnerShiny: false,    // jugar con su versión shiny (si la tienes)
      starter: null,          // dex que te tocó en el test
      personality: null,      // { trait, scores }
      upgrades: {},           // (antiguo) mejoras de la cuenta; ahora van por Pokémon
      pupg: {},               // dex -> { id -> nivel }: mejoras de cada Pokémon
      tickets: { t1: 0, t10: 0 },   // tickets del gacha (x1 y x10)
      pity: {},               // generación del banner -> tiradas sin ★5
      legends: {},            // dex -> fecha: legendarios vencidos en grietas
      arenas: {},             // tipo -> fecha: arenas de grieta ganadas
      itemsFound: {},         // id -> fecha: objetos equipables encontrados
      evoMoves: {},           // id -> fecha: movimientos evolucionados alguna vez
      ach: {},                // id -> fecha: logros conseguidos
      missions: {},           // misiones del día / semana (systems/progress.js)
      profile: { favs: [], title: '' },   // perfil público: 3 favoritos y título
      stats: { runs: 0, bestTime: 0, bestLevel: 0, totalKills: 0, pulls: 0, coinsEarned: 0, shinies: 0,
               bossesTotal: 0, riftWins: 0, evolutions: 0, missionsDone: 0, groupRuns: 0, bestGroupTime: 0 }
    };
  }

  /** Rellena campos que falten en partidas de versiones anteriores. */
  function migrate(s: SaveData, name?: string): SaveData {
    const base = newSave(name || s.name);
    for (const k in base) if (s[k] == null) s[k] = base[k];
    for (const k in base.stats) if (s.stats[k] == null) s.stats[k] = base.stats[k];
    // v1 -> v2: había un único banner (Kanto) con el pity como número.
    if (typeof s.pity === 'number') s.pity = { 1: s.pity };
    // v2 -> v3: las mejoras eran de la cuenta; pasan al compañero de entonces.
    if (!s.pupgDone) {
      if (s.partner && Object.values(s.upgrades || {}).some(v => v > 0)) {
        s.pupg[s.partner] = Object.assign({}, s.upgrades);
      }
      s.pupgDone = true;
    }
    s.tickets = Object.assign({ t1: 0, t10: 0 }, s.tickets);
    sanitize(s);
    s.v = VERSION;
    return s;
  }

  /**
   * Quita lo imposible de una partida editada a mano (la copia del navegador
   * se puede tocar): números negativos o raros, mejoras por encima del
   * máximo y Pokémon que no existen. Lo que sí sea posible lo frena el
   * servidor (firestore.rules, saves).
   */
  function sanitize(s: SaveData) {
    const n = (v: any) => (Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : 0);   // (any: puede venir cualquier cosa)
    s.coins = n(s.coins);
    s.tickets.t1 = n(s.tickets.t1);
    s.tickets.t10 = n(s.tickets.t10);
    if (G.DEX_BY) for (const coll of ['owned', 'shiny']) {
      for (const d of Object.keys(s[coll] || {})) if (!G.DEX_BY[+d]) delete s[coll][d];
    }
    // Atajos: 4 huecos con un movimiento que exista (o null), sin repetir.
    if (s.pbind && typeof s.pbind === 'object') {
      for (const d of Object.keys(s.pbind)) {
        const l = Array.isArray(s.pbind[d]) ? s.pbind[d].slice(0, 4) : [];
        const seen = new Set();
        s.pbind[d] = [0, 1, 2, 3].map(i => {
          const id = l[i];
          if (typeof id !== 'string' || (G.Moves && !G.Moves.BY_ID[id]) || seen.has(id)) return null;
          seen.add(id); return id;
        });
      }
    } else s.pbind = {};
    // Veto: listas de movimientos que existen, sin repetir, como mucho 3.
    if (s.pban && typeof s.pban === 'object') {
      for (const d of Object.keys(s.pban)) {
        const l = Array.isArray(s.pban[d]) ? s.pban[d] : [];
        s.pban[d] = [...new Set(l.filter(id => typeof id === 'string' && (!G.Moves || G.Moves.BY_ID[id])))].slice(0, 3);
      }
    } else s.pban = {};
    if (G.Upgrades) for (const d of Object.keys(s.pupg || {})) {
      const u = s.pupg[d];
      if (!u || typeof u !== 'object') { delete s.pupg[d]; continue; }
      for (const id of Object.keys(u)) {
        if (!G.Upgrades.BY[id]) delete u[id];
        else u[id] = Math.min(G.Upgrades.BY[id].max, n(u[id]));
      }
    }
  }

  /**
   * Fusiona dos versiones de la misma partida (p. ej. una jugada sin
   * conexión y la de la nube). Nunca se pierde nada conseguido:
   *   - colecciones (owned, shiny): unión
   *   - mejoras y estadísticas: el máximo de cada una
   *   - monedas, compañero, pity...: los de la versión más reciente
   * Es idempotente: fusionar dos veces da lo mismo.
   */
  function merge(a: SaveData, b?: SaveData | null): SaveData;
  function merge(a: SaveData | null | undefined, b?: SaveData | null): SaveData | null;
  function merge(a: SaveData | null | undefined, b?: SaveData | null): SaveData | null {
    if (!a) return b || null;
    if (!b) return a;
    const newer = (a.updated || 0) >= (b.updated || 0) ? a : b;
    const older = newer === a ? b : a;
    const r: SaveData = JSON.parse(JSON.stringify(newer));
    for (const coll of ['owned', 'shiny']) {
      r[coll] = r[coll] || {};
      for (const k in older[coll] || {}) {
        if (!r[coll][k] || (older[coll][k].at || 0) < (r[coll][k].at || 0)) r[coll][k] = older[coll][k];
      }
    }
    for (const k in older.upgrades || {}) r.upgrades[k] = Math.max(r.upgrades[k] || 0, older.upgrades[k]);
    r.pupg = r.pupg || {};
    for (const d in older.pupg || {}) {
      const mine = r.pupg[d] = r.pupg[d] || {};
      for (const k in older.pupg[d]) mine[k] = Math.max(mine[k] || 0, older.pupg[d][k]);
    }
    r.pupgDone = r.pupgDone || older.pupgDone;
    // Lo conseguido nunca se pierde: unión de legendarios, arenas, objetos, logros...
    for (const coll of ['legends', 'arenas', 'itemsFound', 'evoMoves', 'ach']) {
      r[coll] = r[coll] || {};
      for (const k in older[coll] || {}) if (!r[coll][k]) r[coll][k] = older[coll][k];
    }
    // Misiones del mismo día/semana: el mayor progreso y lo ya recogido.
    const mo = older.missions || {}, mr: MissionBook = r.missions = r.missions || {};
    for (const [per, list] of [['day', 'daily'], ['week', 'weekly']] as const) {
      if (mr[per] !== mo[per] || !mr[list] || !mo[list]) continue;
      mr[list]!.forEach((m, i) => {
        const o = mo[list]![i];
        if (!o || o.id !== m.id) return;
        m.prog = Math.max(m.prog || 0, o.prog || 0);
        m.claimed = m.claimed || o.claimed;
        m.told = m.told || o.told;
      });
    }
    for (const k in older.stats || {}) r.stats[k] = Math.max(r.stats[k] || 0, older.stats[k] || 0);
    if (r.starter == null) r.starter = older.starter;
    if (r.personality == null) r.personality = older.personality;
    if (r.partner == null || !r.owned[r.partner]) { r.partner = older.partner; r.partnerShiny = older.partnerShiny; }
    r.created = Math.min(a.created || Date.now(), b.created || Date.now());
    r.updated = Math.max(a.updated || 0, b.updated || 0);
    return r;
  }

  /** Sustituye el contenido de `save` sin cambiar el objeto (otros módulos lo tienen). */
  // Copia `s` sobre la partida SIN cambiar los objetos de dentro (mejoras,
  // Pokémon...): las pantallas abiertas guardan referencias a ellos. Antes se
  // sustituían y una compra hecha justo después de subir la partida se
  // apuntaba en la copia vieja: se cobraban las monedas y la mejora se perdía.
  // (any: copia profunda entre partidas, cuyas claves son de cualquier módulo)
  const isObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
  function assignDeep(dst: any, src: any) {
    for (const k of Object.keys(dst)) if (!(k in src)) delete dst[k];
    for (const k in src) {
      if (isObj(src[k]) && isObj(dst[k])) assignDeep(dst[k], src[k]);
      else dst[k] = src[k];
    }
  }
  function applyInPlace(s: SaveData) { assignDeep(save, s); }

  const VALID = /^[A-Za-z0-9_ñÑáéíóúÁÉÍÓÚ]{3,16}$/;

  // =====================================================================
  //                               MODO LOCAL
  // =====================================================================

  async function hash(pass: string, salt: string) {
    const text = salt + ':' + pass;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    return 'f' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
  }

  function randomSalt() {
    const a = new Uint8Array(12);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (let i = 0; i < a.length; i++) a[i] = Math.random() * 256;
    return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function loadLocal(k: string, name: string) {
    const s = read(K_SAVE + k);
    return s ? migrate(s, name) : newSave(name);
  }

  function beginLocal(k: string, name: string) {
    key = k; user = name; guest = false;
    save = loadLocal(k, name);
    write(K_SES, k);
  }

  async function registerLocal(name: string, pass: string): Promise<AuthResult> {
    const accs = read(K_ACC) || {};
    const k = name.toLowerCase();
    if (accs[k]) return { ok: false, error: 'Ese nombre ya existe.' };
    const salt = randomSalt();
    accs[k] = { name, salt, hash: await hash(pass, salt), created: Date.now() };
    if (!write(K_ACC, accs)) return { ok: false, error: 'El navegador no deja guardar datos (¿modo incógnito?).' };
    beginLocal(k, name);
    write(K_SAVE + k, save);
    return { ok: true, isNew: true };
  }

  async function loginLocal(name: string, pass: string): Promise<AuthResult> {
    const accs = read(K_ACC) || {};
    const acc = accs[name.toLowerCase()];
    if (!acc || acc.hash !== await hash(pass || '', acc.salt)) {
      return { ok: false, error: 'Usuario o contraseña incorrectos.' };
    }
    beginLocal(name.toLowerCase(), acc.name);
    return { ok: true, isNew: !save!.partner };
  }

  function restoreLocal() {
    const k = read(K_SES);
    if (!k) return false;
    const accs = read(K_ACC) || {};
    if (!accs[k]) { remove(K_SES); return false; }
    beginLocal(k, accs[k].name);
    return true;
  }

  // =====================================================================
  //                 MODO NUBE: servidor propio (server/, Bun + SQLite)
  // =====================================================================

  const K_TOKEN = 'ps.token';             // { token, uid, name } de la sesión abierta
  let token: string | null = null;        // sesión con el servidor
  let sid: string | null = null;          // id de la cuenta en el servidor (texto)
  let uid: string | null = null;          // nombre en minúsculas: clave de la copia local (K_CLOUD + uid)
  let ver = 0;                            // versión de la partida en el servidor que conoce esta copia
  let pushT = 0, retryT = 0, pending = false, pushing: Promise<void> | null = null, lastPush = 0;
  // Cada cuánto se sube la partida: lo que vale algo (tiradas, compras, Pokémon,
  // premios) a los pocos segundos; al acabar una partida, al medio minuto; lo
  // demás, cada 5 min. La copia del navegador se guarda siempre al momento y al
  // cerrar la pestaña se sube lo pendiente.
  const PUSH_GAP = 5 * 60e3, PUSH_GAP_URGENT = 3e3, PUSH_GAP_RUN = 30e3;
  let syncState = 'local';           // 'ok' | 'syncing' | 'pending' | 'offline' | 'local'
  const listeners = new Set<(s: string) => void>();

  function setSync(s: string) { syncState = s; listeners.forEach(fn => { try { fn(s); } catch (e) { /* nada */ } }); }

  /** Llamada a la API. Nunca lanza por un error HTTP (mira `status`); sí si no hay red. */
  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; j: any }> {   // (j: el JSON de cada ruta de server/api.ts)
    const text = body === undefined ? undefined : JSON.stringify(body);
    const res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: text,
      // Al cerrar la pestaña, la subida sigue aunque la página ya no exista (tope del navegador: 64 KB).
      keepalive: !!text && text.length < 60000,
      signal: AbortSignal.timeout(12000),
    });
    let j = null;
    try { j = await res.json(); } catch (e) { /* no era JSON */ }
    return { status: res.status, j: j || { ok: false, error: 'Error del servidor (' + res.status + ').' } };
  }

  /** ¿Hay servidor? (en desarrollo, sin `bun run server`, el juego va en modo local) */
  async function initCloud() {
    if (!/^https?:$/.test(location.protocol)) { localReason = 'file'; return false; }
    try {
      const r = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!r.ok || !(await r.json()).ok) throw new Error('sin API');
    } catch (e) { localReason = 'config'; return false; }
    addEventListener('online', () => { if (pending) pushNow(); });
    // Al ocultar o cerrar la pestaña se sube lo pendiente.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && pending) pushNow(); });
    addEventListener('pagehide', () => { if (pending) pushNow(); });
    return true;
  }

  const plain = <T>(s: T): T => JSON.parse(JSON.stringify(s));

  /**
   * Abre la partida de una sesión recién iniciada: la del servidor FUSIONADA con
   * la copia de este navegador.
   */
  async function openCloud(tok: string, id: string, name: string) {
    token = tok; sid = id; uid = name.toLowerCase();
    write(K_TOKEN, { token: tok, uid: id, name });
    const cached = read(K_CLOUD + uid);
    let remote = null, online = true;
    try {
      const r = await api('GET', '/save');
      if (r.status === 401) throw Object.assign(new Error(r.j.error), { code: 'auth' });
      if (!r.j.ok) throw new Error(r.j.error);
      remote = r.j.save; ver = r.j.ver;
    } catch (e) {
      if ((e as NetFail).code === 'auth' || !cached) throw e;   // sesión caducada, o sin conexión y sin copia
      online = false;
    }
    let s = merge(cached && migrate(cached), remote && migrate(remote));
    if (!s) s = newSave(name);
    save = migrate(s, s.name);
    // El nombre que se ve es el de la cuenta del servidor (el de amigos y ranking), no el de la partida.
    key = uid; user = name; guest = false;
    write(K_CLOUD + uid, save);
    // Sólo se sube si esta copia tiene algo que el servidor no (cuenta nueva,
    // progreso de este navegador sin subir...), y sin esperar a que acabe.
    const same = remote && (!cached || (cached.updated || 0) <= (remote.updated || 0));
    lastPush = Date.now();
    if (!online) { pending = true; setSync('offline'); scheduleRetry(); }
    else if (same) setSync('ok');
    else pushNow();
  }

  /**
   * Sube la partida. Si otro dispositivo ha guardado entre medias, el servidor
   * responde 409 con la suya: se FUSIONA con la de aquí (no se pierde nada de
   * ninguna) y se vuelve a mandar.
   */
  function pushNow(): Promise<void> {
    if (mode !== 'cloud' || guest || !save || !token) return Promise.resolve();
    // Si ya hay una subida en marcha, se hace otra justo después (para lo que haya cambiado mientras).
    if (pushing) { pending = true; return pushing.then(() => (pending ? pushNow() : undefined)); }
    clearTimeout(pushT); pushT = 0; pushDue = 0;
    if (navigator.onLine === false) {
      pending = true; setSync('offline'); scheduleRetry();
      return Promise.resolve();
    }
    pending = false;
    lastPush = Date.now();
    setSync('syncing');
    let failed = false;
    pushing = (async () => {
      for (let i = 0; i < 4; i++) {
        const r = await api('PUT', '/save', { save: plain(save), base: ver });
        if (r.status === 200) { ver = r.j.ver; return; }
        if (r.status === 409) {
          ver = r.j.ver;
          if (r.j.save && save) { applyInPlace(merge(plain(save), migrate(r.j.save))); write(K_CLOUD + uid, save); }
          continue;
        }
        // 429: guardó hace nada. No es un fallo: se espera lo que pide el servidor y se sube lo pendiente.
        if (r.status === 429) throw Object.assign(new Error(r.j.error), { code: 'rate', wait: Math.max(1, Math.min(60, Number(r.j.wait) || 20)) * 1000 });
        throw Object.assign(new Error(r.j.error), { code: r.status === 401 ? 'auth' : 'server' });
      }
      throw Object.assign(new Error('demasiados choques'), { code: 'conflict' });
    })().then(() => {
      fails = 0;
      setSync(pending ? 'pending' : 'ok');
      if (G.UI && G.UI.refreshCoins) G.UI.refreshCoins();
    }).catch(e => {
      console.warn('[DB] no se pudo sincronizar:', e.code || e.message);
      pending = true; failed = true;
      setSync(navigator.onLine === false || e.name === 'TimeoutError' || e instanceof TypeError ? 'offline' : 'pending');
      // Con la sesión caducada no sirve reintentar: la copia queda aquí hasta volver a entrar.
      if (e.code === 'rate') { clearTimeout(retryT); retryT = setTimeout(() => { if (pending) pushNow(); }, e.wait * (1 + Math.random() * 0.2)); }
      else if (e.code !== 'auth') scheduleRetry();
    }).finally(() => {
      pushing = null;
      if (!failed && pending && syncState === 'pending') schedulePush(Math.max(1500, PUSH_GAP - (Date.now() - lastPush)));
    });
    return pushing;
  }

  // Si ya había una subida programada antes, se respeta (una compra no espera a la siguiente partida).
  let pushDue = 0;
  function schedulePush(ms: number) {
    const due = Date.now() + ms;
    if (pushT && pushDue && pushDue <= due) return;
    clearTimeout(pushT); pushDue = due;
    pushT = setTimeout(() => { pushT = 0; pushDue = 0; pushNow(); }, ms);
  }
  /** Reintento con espera creciente: 15 s, 30 s, 1 min, 2 min... hasta 10 min. */
  let fails = 0;
  function scheduleRetry() {
    const ms = Math.min(10 * 60e3, 15e3 * Math.pow(2, fails)) * (0.8 + Math.random() * 0.4);
    fails = Math.min(fails + 1, 8);
    clearTimeout(retryT);
    retryT = setTimeout(() => { if (pending) pushNow(); }, ms);
  }

  /** Error de red o de la API, con el motivo que se le añade al lanzarlo. */
  type NetFail = Error & { code?: string; wait?: number };

  /** Texto para el jugador cuando falla la red. */
  function netError(e: unknown) {
    const er = e as { name?: string; message?: string } | null;
    return er && (er.name === 'TimeoutError' || e instanceof TypeError) ? 'Sin conexión con el servidor.'
      : (er && er.message) || 'Error desconocido.';
  }

  // =====================================================================
  //                           API PÚBLICA
  // =====================================================================

  let readyP: Promise<boolean> | null = null;

  /** Arranca la base de datos y recupera la sesión anterior. → true si hay sesión. */
  function ready() {
    if (readyP) return readyP;
    readyP = (async () => {
      try { if (await initCloud()) mode = 'cloud'; }
      catch (e) { console.warn('[DB] sin servidor:', (e as Error).message); localReason = 'error'; mode = 'local'; }
      if (mode === 'local') { setSync('local'); return restoreLocal(); }
      const ses = read(K_TOKEN);
      if (!ses || !ses.token || !ses.uid) return false;
      try { await openCloud(ses.token, ses.uid, ses.name); return true; }
      catch (e) {
        const er = e as NetFail;
        console.warn('[DB] no se pudo abrir la partida:', er.code || er.message);
        if (er.code === 'auth') remove(K_TOKEN);
        token = null; uid = null; sid = null;
        return false;
      }
    })();
    return readyP;
  }

  async function register(name: string, pass: string): Promise<AuthResult> {
    name = (name || '').trim();
    if (!VALID.test(name)) return { ok: false, error: 'El nombre debe tener 3-16 letras, números o _.' };
    const min = mode === 'cloud' ? 6 : 4;
    if ((pass || '').length < min) return { ok: false, error: `La contraseña debe tener al menos ${min} caracteres.` };
    if (mode === 'local') return registerLocal(name, pass);
    try {
      const r = await api('POST', '/register', { name, pass });
      if (!r.j.ok) return { ok: false, error: r.j.error };
      await openCloud(r.j.token, r.j.uid, r.j.name);
      return { ok: true, isNew: !save!.partner };
    } catch (e) { return { ok: false, error: netError(e) }; }
  }

  async function login(name: string, pass: string): Promise<AuthResult> {
    name = (name || '').trim();
    if (mode === 'local') return loginLocal(name, pass);
    try {
      const r = await api('POST', '/login', { name, pass: pass || '' });
      if (!r.j.ok) return { ok: false, error: r.j.error };
      await openCloud(r.j.token, r.j.uid, r.j.name);
      return { ok: true, isNew: !save!.partner };
    } catch (e) { return { ok: false, error: netError(e) }; }
  }

  /** Cambia la contraseña de la cuenta (pide la actual). En el servidor, cierra las demás sesiones. */
  async function changePassword(old: string, pass: string): Promise<AuthResult> {
    if (guest || !key) return { ok: false, error: 'No hay cuenta.' };
    const min = mode === 'cloud' ? 6 : 4;
    if ((pass || '').length < min) return { ok: false, error: `La contraseña nueva debe tener al menos ${min} caracteres.` };
    if (mode === 'local') {
      const accs = read(K_ACC) || {};
      const acc = accs[key];
      if (!acc || acc.hash !== await hash(old || '', acc.salt)) return { ok: false, error: 'La contraseña actual no es correcta.' };
      acc.salt = randomSalt();
      acc.hash = await hash(pass, acc.salt);
      return write(K_ACC, accs) ? { ok: true } : { ok: false, error: 'El navegador no deja guardar datos (¿modo incógnito?).' };
    }
    try {
      const r = await api('POST', '/password', { old: old || '', pass });
      return r.j.ok ? { ok: true } : { ok: false, error: r.j.error };
    } catch (e) { return { ok: false, error: netError(e) }; }
  }

  /** Cambia el nombre que se ve en la partida (al elegir apodo). */
  function setName(n: string) {
    if (!save || guest) return;
    save.name = n; user = n;
    commit();
  }

  function playAsGuest(): AuthResult {
    user = 'Invitado'; key = null; guest = true;
    save = newSave('Invitado');
    if (mode === 'local') remove(K_SES);
    return { ok: true, isNew: true };
  }

  /**
   * Guarda la partida actual (no hace nada en modo invitado). En el navegador,
   * al momento; en el servidor:
   * @param urgent  true: lo que vale algo (tiradas, compras, Pokémon, premios): enseguida
   *                'run': al acabar una partida · false: cada 5 min
   */
  function commit(urgent: boolean | 'run' = false) {
    if (guest || !key || !save) return false;
    save.updated = Date.now();
    if (mode === 'local') return write(K_SAVE + key, save);
    write(K_CLOUD + uid, save);
    pending = true;
    setSync('pending');
    const gap = urgent === 'run' ? PUSH_GAP_RUN : urgent ? PUSH_GAP_URGENT : PUSH_GAP;
    schedulePush(Math.max(1200, gap - (Date.now() - lastPush)));
    return true;
  }

  /** Funciones que se ejecutan al cerrar sesión o borrar la cuenta (amigos, salas...). */
  const leaveHooks: ((why: 'logout' | 'delete') => unknown)[] = [];

  async function logout() {
    for (const fn of leaveHooks) { try { await fn('logout'); } catch (e) { /* nada */ } }
    if (mode === 'cloud' && !guest && save) {
      if (pending) { try { await pushNow(); } catch (e) { /* queda la copia local */ } }
      try { await api('POST', '/logout'); } catch (e) { /* nada */ }
      remove(K_TOKEN);
    } else if (mode === 'local' && !guest) {
      commit();
      remove(K_SES);
    }
    clearTimeout(pushT); clearTimeout(retryT);
    user = key = save = uid = token = sid = null; guest = false; pending = false; ver = 0;
    setSync(mode === 'cloud' ? 'ok' : 'local');
  }

  /** Las cuentas del servidor son siempre de nombre y contraseña. */
  function nameAccount() { return mode === 'cloud' && !!token; }

  /**
   * Borra la cuenta y la partida (en el servidor o en este navegador).
   * @param pass  contraseña (se pide para confirmar)
   */
  async function deleteAccount(pass?: string): Promise<AuthResult> {
    if (guest || !key) return { ok: false, error: 'No hay cuenta que borrar.' };
    if (mode === 'local') {
      const accs = read(K_ACC) || {};
      delete accs[key];
      write(K_ACC, accs);
      remove(K_SAVE + key); remove(K_SES);
      user = key = save = null;
      return { ok: true };
    }
    if (!pass) return { ok: false, error: 'Escribe tu contraseña.' };
    try {
      const r = await api('DELETE', '/account', { pass });
      if (!r.j.ok) return { ok: false, error: r.j.error };
      clearTimeout(pushT); clearTimeout(retryT); pending = false;
      for (const fn of leaveHooks) { try { await fn('delete'); } catch (e) { /* nada */ } }
      remove(K_CLOUD + uid); remove(K_TOKEN);
      user = key = save = uid = token = sid = null; ver = 0;
      return { ok: true };
    } catch (e) { return { ok: false, error: netError(e) }; }
  }

  // ---------------- helpers de partida ----------------

  function owns(dex: number) { return !!(save && save.owned[dex]); }

  function grant(dex: number, from: string) {
    if (!save!.owned[dex]) save!.owned[dex] = { at: Date.now(), from };
  }

  function ownsShiny(dex: number) { return !!(save && save.shiny && save.shiny[dex]); }

  /** Mejoras compradas para un Pokémon: { id -> nivel }. */
  function upgradesOf(dex: number) {
    if (!save) return {};
    save.pupg = save.pupg || {};
    return save.pupg[dex] || (save.pupg[dex] = {});
  }

  /** Da la versión shiny (y la normal, si no la tenía). Devuelve true si es nueva. */
  function grantShiny(dex: number, from: string) {
    grant(dex, from);
    if (save!.shiny[dex]) return false;
    save!.shiny[dex] = { at: Date.now(), from };
    return true;
  }

  return {
    ready, register, login, changePassword, playAsGuest, logout, commit, deleteAccount, flush: pushNow,
    owns, grant, ownsShiny, grantShiny, merge, setName, upgradesOf,
    onSync(fn: (s: string) => void) { listeners.add(fn); },
    onLeave(fn: (why: 'logout' | 'delete') => unknown) { leaveHooks.push(fn); },
    /** (Firebase, ya retirado) Los módulos de red lo miran: sin él no arrancan. */
    get fb(): null { return null; },
    /** ¿Está disponible lo online (amigos, ranking, multijugador)? Sí, con una sesión en el servidor. */
    get online() { return !!this.session; },
    /** Sesión con el servidor propio, para los módulos de red (src/net/). null sin cuenta en el servidor. */
    get session() { return mode === 'cloud' && token && sid && !guest && save ? { token, uid: sid, name: user } : null; },
    /** Llamada a la API del servidor con la sesión (ver server/api.ts). */
    api,
    /** ¿Cuenta del servidor (de nombre y contraseña)? */
    get nameAccount() { return nameAccount(); },
    get mode() { return mode; },
    get localReason() { return localReason; },
    get syncState() { return syncState; },
    get user() { return user; },
    get guest() { return guest; },
    /** La partida abierta. Es null sólo sin sesión (antes de entrar o tras salir); el juego sólo la usa con sesión. */
    get save(): SaveData { return save!; },
    get loggedIn() { return !!save; },
    get storageOk() { return storageOk; },
    START_COINS
  };
})();
G.DB = DB;

declare module '../g' {
  interface Registry { DB: typeof DB }
}
