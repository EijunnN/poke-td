import { G } from '../g';
/* ============ lang-en-stats.ts — pausa, estadísticas y medidor de daño en inglés ============
 * Como lang-en.ts (clave: el texto en español tal como sale; {x} = hueco), pero sólo lo
 * de ui/stats-ui.ts y las pestañas de la pausa.
 */
G.I18n.add({
  'Resumen': 'Summary', 'Estadísticas': 'Stats', 'Daño': 'Damage', 'Recarga': 'Cooldown', 'Nv. {x}': 'Lv. {x}',
  // estadísticas del Pokémon
  'Vida máxima': 'Max HP', 'Daño recibido': 'Damage taken', 'Regeneración': 'Regeneration', 'Radio de recogida': 'Pickup radius',
  'Experiencia': 'Experience', 'Crítico': 'Crit', 'Pokémonedas': 'PokéCoins', 'temporal': 'temporary',
  'Cartas de esta mejora que llevas': 'Upgrade cards of this kind you have',
  'Cartas de esta mejora que llevarías': 'Upgrade cards of this kind you would have',
  // ataques físicos y especiales
  'Físico': 'Physical', 'Especial': 'Special', 'At. Esp.': 'Sp. Atk', 'Def. Esp.': 'Sp. Def', 'Estadísticas base': 'Base stats',
  'Físico: pega con el Ataque del Pokémon y lo frena la Defensa': 'Physical: hits with the Pokémon’s Attack and is reduced by Defense',
  'Especial: pega con el At. Esp. del Pokémon y lo frena la Def. Esp.': 'Special: hits with the Pokémon’s Sp. Atk and is reduced by Sp. Def',
  'Los ataques físicos pegan con el Ataque y los especiales con el At. Esp. Los golpes cuerpo a cuerpo se frenan con la Defensa y los disparos con la Def. Esp.':
    'Physical moves hit with Attack and special moves with Sp. Atk. Melee hits are reduced by Defense and ranged shots by Sp. Def.',
  'Fís. {x} · Esp. {x}': 'Phys. {x} · Sp. {x}', 'Esp. {x}': 'Sp. {x}',
  // resumen y medidor de daño
  'Daño/s': 'Dmg/s', 'Daño total': 'Total damage', 'Daño del equipo': 'Team damage', 'Daño por segundo': 'Damage per second',
  'Equipo': 'Team', 'Tus movimientos': 'Your moves', 'Aún no has hecho daño.': "You haven't dealt any damage yet."
});
