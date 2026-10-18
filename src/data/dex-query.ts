import { G } from '../g';
import type { Pokemon } from './pokedex';
/* ============ dex-query.ts — buscar, filtrar, ordenar y favoritos de la colección ============
 * Lógica pura de la pantalla de Pokémon (ui/menu.ts), sin DOM: un estado de
 * búsqueda (`DexSearch`) y `run()`, que lo cruza con la partida.
 *
 * Lo que aún no tienes no se delata: el nombre sólo se busca entre los que
 * tienes (el número, en todos), y los órdenes por nombre, fecha o stats dejan
 * al final a los que faltan.
 *
 * Favoritos (`save.dexFav`, opcional: las partidas viejas no lo tienen):
 * dex -> momento del último cambio, en positivo si es favorito y en negativo si
 * se quitó. Así la fusión entre aparatos (db.ts, merge) se queda con el cambio
 * más reciente de cada Pokémon: quitar un favorito en un móvil no lo revive el
 * otro, y marcar uno nuevo en cada aparato se suma. (No confundir con
 * `profile.favs`, los 3 del perfil público.)
 */

/** Órdenes de la colección. */
export type DexSort = 'num' | 'name' | 'rarity' | 'recent' | 'hp' | 'atk' | 'spd';
export const SORTS: DexSort[] = ['num', 'name', 'rarity', 'recent', 'hp', 'atk', 'spd'];

/** Qué se busca: todos los filtros se cruzan entre sí. */
export interface DexSearch {
  text: string;                      // nombre (sólo de los que tienes) o número
  sort: DexSort;
  gen: number;                       // 0 = todas las generaciones
  own: 'all' | 'own' | 'miss';
  rarity: number[];                  // vacío = cualquiera
  types: string[];                   // vacío = cualquiera; con varios, basta uno
  shiny: boolean;                    // sólo los que tienes en shiny
  fav: boolean;                      // sólo favoritos
}

/** Lo que `run` lee de la partida. */
export interface DexSave {
  owned: Record<string, { at: number }>;
  shiny?: Record<string, unknown>;
  dexFav?: Record<string, number>;
}

/** Cuántos favoritos se guardan como mucho (con holgura sobre los Pokémon que hay). */
const FAV_MAX = 1100;

export const DexQuery = (() => {
  const blank = (): DexSearch => ({ text: '', sort: 'num', gen: 0, own: 'all', rarity: [], types: [], shiny: false, fav: false });

  /** Sin mayúsculas ni tildes: "Flabébé" se encuentra con "flabebe". */
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  /** ¿Hay algo filtrado además de la generación y el orden? (para el botón "Limpiar") */
  function active(q: DexSearch) {
    return !!(q.text.trim() || q.own !== 'all' || q.rarity.length || q.types.length || q.shiny || q.fav);
  }

  /** Quita todos los filtros (la generación y el orden se quedan). */
  function clear(q: DexSearch) {
    q.text = ''; q.own = 'all'; q.rarity = []; q.types = []; q.shiny = false; q.fav = false;
  }

  // ---------------- favoritos ----------------

  const isFav = (s: DexSave, dex: number) => (s.dexFav ? s.dexFav[dex] || 0 : 0) > 0;

  function favCount(s: DexSave) {
    let n = 0;
    for (const k in s.dexFav || {}) if (s.dexFav![k] > 0) n++;
    return n;
  }

  /** Marca o quita el favorito. → cómo queda. `now` se inyecta para las pruebas. */
  function toggleFav(s: DexSave, dex: number, now = Date.now()) {
    const fav = s.dexFav || (s.dexFav = {});
    const was = (fav[dex] || 0) > 0;
    // Siempre más reciente que el cambio anterior, aunque el reloj vaya atrasado o sea el mismo milisegundo.
    const at = Math.max(now, Math.abs(fav[dex] || 0) + 1);
    fav[dex] = was ? -at : at;
    return !was;
  }

  /** Fusiona los favoritos de dos copias de la partida: gana el cambio más reciente de cada Pokémon. */
  function mergeFavs(a: Record<string, number> | undefined, b: Record<string, number> | undefined) {
    const out: Record<string, number> = { ...(a || {}) };
    for (const k in b || {}) {
      if (!(k in out) || Math.abs(b![k]) > Math.abs(out[k])) out[k] = b![k];
    }
    return out;
  }

  /** Deja `dexFav` con la forma buena (partida editada a mano): números finitos, Pokémon que existen. */
  function cleanFavs(raw: unknown, exists: (dex: number) => boolean) {
    const out: Record<string, number> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    let n = 0;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^\d+$/.test(k) || !exists(+k) || typeof v !== 'number' || !Number.isFinite(v) || v === 0) continue;
      if (++n > FAV_MAX) break;
      out[k] = Math.trunc(v);
    }
    return out;
  }

  // ---------------- buscar y ordenar ----------------

  /** Los Pokémon que cumplen la búsqueda, ya ordenados. */
  function run(q: DexSearch, s: DexSave, list: Pokemon[] = G.DEX): Pokemon[] {
    const text = norm(q.text.trim().replace(/^#/, ''));
    const num = /^\d+$/.test(text) ? +text : 0;
    const has = (p: Pokemon) => !!s.owned[p.dex];
    const out = list.filter(p => {
      if (q.gen && p.gen !== q.gen) return false;
      const own = has(p);
      if (q.own === 'own' && !own) return false;
      if (q.own === 'miss' && own) return false;
      if (q.shiny && !(s.shiny && s.shiny[p.dex])) return false;
      if (q.fav && !isFav(s, p.dex)) return false;
      if (q.rarity.length && !q.rarity.includes(p.rarity)) return false;
      if (q.types.length && !p.types.some(t => q.types.includes(t))) return false;
      if (text) {
        const byName = own && norm(p.name).includes(text);
        if (!(num ? p.dex === num || byName : byName)) return false;
      }
      return true;
    });

    // Cada orden da la clave de cada Pokémon (mayor = antes), salvo número y nombre (menor = antes).
    // Los que faltan van siempre al final, y a igualdad manda el número.
    const key: Record<DexSort, (p: Pokemon) => number> = {
      num: p => -p.dex,
      name: () => 0,
      rarity: p => p.rarity,
      recent: p => (s.owned[p.dex] ? s.owned[p.dex].at || 0 : 0),
      hp: p => p.hp,
      atk: p => p.atk,
      spd: p => p.spd,
    };
    const k = key[q.sort] || key.num;
    const needsOwn = q.sort === 'name' || q.sort === 'recent' || q.sort === 'hp' || q.sort === 'atk' || q.sort === 'spd';
    return out.sort((a, b) => {
      if (needsOwn) {
        const d = Number(has(b)) - Number(has(a));
        if (d) return d;
        if (!has(a)) return a.dex - b.dex;
      }
      if (q.sort === 'name') return a.name.localeCompare(b.name, 'es') || a.dex - b.dex;
      return k(b) - k(a) || a.dex - b.dex;
    });
  }

  return { SORTS, blank, norm, active, clear, run, isFav, favCount, toggleFav, mergeFavs, cleanFavs };
})();
G.DexQuery = DexQuery;

declare module '../g' {
  interface Registry { DexQuery: typeof DexQuery }
}
