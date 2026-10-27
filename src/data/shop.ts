import { G } from '../g';
/* ============ shop.ts — Tienda Kecleon y Mochila ============
 * Se compra con Pokémonedas y lo comprado va a la Mochila:
 *   save.bag[id]   Menta, Cápsula Habilidad y Cápsula Habilidad Oculta
 *   save.tms[mt]   MT sin usar (cada una se gasta al enseñarla: Mons.teach)
 *
 * MT a la venta: 8 cada día, iguales para todos los que juegan ese día (semilla: la fecha en España). Si
 * ninguna sirve a tu compañero, la última se cambia por una que sí pueda aprender. No se vende una MT que ya
 * llevas en la Mochila (se gasta primero), así un doble clic no cobra dos veces.
 */
export interface ShopItem { id: string; name: readonly [es: string, en: string]; icon: string; price: number; desc: readonly [es: string, en: string] }

export const Shop = (() => {
  const ITEMS: Record<string, ShopItem> = {
    mint: { id: 'mint', name: ['Menta', 'Mint'], icon: 'mint', price: 1500,
            desc: ['Cambia la naturaleza de un Pokémon por la que tú elijas.', 'Changes a Pokémon’s nature to the one you choose.'] },
    cap:  { id: 'cap', name: ['Cápsula Habilidad', 'Ability Capsule'], icon: 'capsule', price: 1500,
            desc: ['Cambia la habilidad de un Pokémon por otra de las suyas (no la oculta).', 'Swaps a Pokémon’s ability for another of its own (not the hidden one).'] },
    caph: { id: 'caph', name: ['Cápsula Habilidad Oculta', 'Ability Patch'], icon: 'capsuleh', price: 5000,
            desc: ['Cambia la habilidad de un Pokémon por cualquiera de las suyas, también la oculta.', 'Swaps a Pokémon’s ability for any of its own, hidden one included.'] }
  };
  const ORDER = ['mint', 'cap', 'caph'];
  /** MT nuevas cada día. */
  const DAILY = 8;
  /** Tope de cada objeto en la Mochila. */
  const MAX_ITEM = 99;

  const save = () => G.DB.save;

  // ---------------- Mochila ----------------

  const count = (id: string): number => { const s = save(); return (s && s.bag && s.bag[id]) || 0; };
  /** Gasta uno. → true si lo había. */
  function take(id: string): boolean {
    const s = save();
    if (!count(id)) return false;
    if (--s.bag[id] <= 0) delete s.bag[id];
    return true;
  }
  const tmCount = (id: string): number => { const s = save(); return (s && s.tms && s.tms[id]) || 0; };
  function takeTm(id: string): boolean {
    const s = save();
    if (!tmCount(id)) return false;
    if (--s.tms[id] <= 0) delete s.tms[id];
    return true;
  }

  // ---------------- MT del día ----------------

  /** La fecha de hoy en España, AAAAMMDD (todos ven la misma tienda el mismo día). */
  function today(now: number = Date.now()): string {
    const p: Record<string, string> = {};
    for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now))) p[x.type] = x.value;
    return p.year + p.month + p.day;
  }

  /** Generador con semilla (mulberry32 sobre un hash de la cadena). */
  function rng(seed: string): () => number {
    let a = Math.floor(G.Mons.hash(seed) * 4294967296) >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Las MT a la venta ese día (por defecto, hoy). Salen siempre las mismas 8 para una fecha; con `dex` (tu compañero),
   * si ninguna puede aprenderla, la última se cambia por una de las que sí.
   */
  function dailyTms(day: string = today(), dex?: number | null): string[] {
    const all = Object.keys(G.TM_MOVES).filter(id => G.Moves.BY_ID[id]).sort(), r = rng('kecleon:' + day);
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
    const list = all.slice(0, DAILY);
    if (dex && G.DEX_BY[dex] && !list.some(id => G.Mons.canLearn(dex, id))) {
      const mine = G.Mons.learnable(dex).sort();
      if (mine.length) list[DAILY - 1] = mine[Math.floor(rng('kecleon:' + day + ':' + dex)() * mine.length)];
    }
    return list;
  }
  const tmPrice = (id: string): number => G.TM_PRICE[id] || 400;

  // ---------------- comprar ----------------

  /**
   * Compra un objeto ('mint'...) o una MT ('tm:flamethrower'). La MT tiene que estar a la venta hoy.
   * @param now  el momento (para la prueba de la rotación; por defecto, ahora)
   */
  function buy(key: string, now: number = Date.now()): { ok: boolean; error?: string } {
    const s = save();
    if (!s || typeof key !== 'string') return { ok: false };
    const tm = key.startsWith('tm:') ? key.slice(3) : null;
    if (tm !== null) {
      if (!dailyTms(today(now), s.partner).includes(tm)) return { ok: false, error: 'Esa MT ya no está a la venta.' };
      if (tmCount(tm) > 0) return { ok: false, error: 'Ya tienes esa MT en la Mochila.' };
    } else if (!ITEMS[key]) return { ok: false };
    else if (count(key) >= MAX_ITEM) return { ok: false, error: 'La Mochila no admite más de ese objeto.' };
    const price = tm !== null ? tmPrice(tm) : ITEMS[key].price;
    if (!(s.coins >= price)) return { ok: false, error: 'No tienes Pokémonedas suficientes.' };
    s.coins -= price;
    if (tm !== null) { s.tms = s.tms || {}; s.tms[tm] = 1; }
    else { s.bag = s.bag || {}; s.bag[key] = (s.bag[key] || 0) + 1; }
    G.DB.commit(true);
    return { ok: true };
  }

  return { ITEMS, ORDER, DAILY, MAX_ITEM, count, take, tmCount, takeTm, dailyTms, tmPrice, buy, today };
})();
G.Shop = Shop;

declare module '../g' {
  interface Registry { Shop: typeof Shop }
}
