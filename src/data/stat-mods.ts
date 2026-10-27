import { statsOf } from './base-stats';
import type { MoveCat } from './moves';
/* ============ stat-mods.ts — de los stats base de los juegos al daño y a la defensa ============
 * Ataque / At. Esp. (físicos / especiales) escalan el daño y Defensa / Def. Esp. lo que se
 * recibe. Lo usan el jugador (entities/player.ts) y el movimiento inicial (data/moves.ts).
 */

/**
 * Lo que multiplica el daño según el Ataque o el At. Esp. base (0-255). Con 0,74 + 0,55 por cada 100
 * sale casi lo de siempre (0,70 + 0,55 por 100 del mayor de los dos): al lado bueno le queda igual o un
 * poco por encima y al otro le baja según lo flojo que sea.
 */
export const atkOf = (stat: number) => 0.74 + stat / 100 * 0.55;

/** Lo que multiplica el daño recibido según la Defensa o Def. Esp. base: 72 es lo corriente (×1), de ×0,8 a ×1,25. */
export const guardOf = (stat: number) => Math.min(1.25, Math.max(0.8, Math.pow(72 / Math.max(1, stat), 0.4)));

/** Qué parte del daño del lado bueno da esa categoría a ese Pokémon: 1 en su lado bueno, menos en el otro. */
export function catShareOf(dex: number, cat: MoveCat): number {
  const [atk, spa] = statsOf(dex);
  return atkOf(cat === 'phys' ? atk : spa) / atkOf(Math.max(atk, spa));
}
