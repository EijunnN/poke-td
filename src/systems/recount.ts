import { G } from '../g';
/* ============ recount.ts — medidor de daño ============
 * Cuenta cuánto daño ha hecho cada movimiento en la run. Sólo suma: no decide
 * nada ni gasta azar, así que las partidas salen igual con él que sin él.
 * Combate le apunta cada golpe propio (add); la pausa y el resumen lo leen.
 * En grupo cada uno cuenta lo suyo y manda sólo su total por el estado de
 * siempre (net/coop.ts), así que el reparto por movimiento es de uno mismo.
 */
/** Parte del total que se lleva una fila y lo larga que va su barra. */
export interface Share { pct: number; frac: number }

/**
 * Ordena de más a menos daño y añade `pct` (su parte del total, 0-100) y `frac`
 * (lo que mide frente a la primera, 0-1, para la barra). A igual daño, se queda el orden de entrada.
 */
export function rank<T extends { dmg: number }>(items: T[]): (T & Share)[] {
  const total = items.reduce((a, r) => a + r.dmg, 0);
  const sorted = items.slice().sort((a, b) => b.dmg - a.dmg);
  const top = sorted.length ? sorted[0].dmg : 0;
  return sorted.map(r => ({ ...r, pct: total > 0 ? r.dmg / total * 100 : 0, frac: top > 0 ? r.dmg / top : 0 }));
}

export const Recount = (() => {
  const by = new Map<string, number>();     // id del movimiento -> daño hecho

  function reset() { by.clear(); }

  /** Un golpe de `id` (los proyectiles sin movimiento, como los de la Defensa, no cuentan). */
  function add(id: string | undefined, dmg: number) {
    if (id && dmg > 0) by.set(id, (by.get(id) || 0) + dmg);
  }

  function total() { let s = 0; for (const v of by.values()) s += v; return s; }

  /** Daño por movimiento, de más a menos. */
  function rows() { return rank([...by].map(([id, dmg]) => ({ id, dmg }))); }

  return { reset, add, total, rows };
})();
G.Recount = Recount;

declare module '../g' {
  interface Registry { Recount: typeof Recount }
}
