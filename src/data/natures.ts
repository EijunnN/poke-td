import { G } from '../g';
/* ============ natures.ts — las 25 naturalezas de los juegos ============
 * +10 % a una cualidad (`up`) y −10 % a otra (`down`); cinco son neutras.
 *   pa  daño de los ataques físicos     sa  daño de los ataques especiales
 *   df  Defensa (recibe menos daño físico)   sd  Defensa Esp. (menos daño especial)   spd  velocidad
 * Nombres [es, en]: van aquí y no en el diccionario porque "Rara" o "Seria" significan otra cosa allí.
 */
export type NatureStat = 'pa' | 'sa' | 'df' | 'sd' | 'spd';
export interface Nature { id: string; n: readonly [es: string, en: string]; up: NatureStat | ''; down: NatureStat | '' }

export const NATURES: Nature[] = [
  { id: 'hardy', n: ['Fuerte', 'Hardy'], up: '', down: '' },
  { id: 'lonely', n: ['Huraña', 'Lonely'], up: 'pa', down: 'df' },
  { id: 'brave', n: ['Audaz', 'Brave'], up: 'pa', down: 'spd' },
  { id: 'adamant', n: ['Firme', 'Adamant'], up: 'pa', down: 'sa' },
  { id: 'naughty', n: ['Pícara', 'Naughty'], up: 'pa', down: 'sd' },
  { id: 'bold', n: ['Osada', 'Bold'], up: 'df', down: 'pa' },
  { id: 'docile', n: ['Dócil', 'Docile'], up: '', down: '' },
  { id: 'relaxed', n: ['Plácida', 'Relaxed'], up: 'df', down: 'spd' },
  { id: 'impish', n: ['Agitada', 'Impish'], up: 'df', down: 'sa' },
  { id: 'lax', n: ['Floja', 'Lax'], up: 'df', down: 'sd' },
  { id: 'timid', n: ['Miedosa', 'Timid'], up: 'spd', down: 'pa' },
  { id: 'hasty', n: ['Activa', 'Hasty'], up: 'spd', down: 'df' },
  { id: 'serious', n: ['Seria', 'Serious'], up: '', down: '' },
  { id: 'jolly', n: ['Alegre', 'Jolly'], up: 'spd', down: 'sa' },
  { id: 'naive', n: ['Ingenua', 'Naive'], up: 'spd', down: 'sd' },
  { id: 'modest', n: ['Modesta', 'Modest'], up: 'sa', down: 'pa' },
  { id: 'mild', n: ['Afable', 'Mild'], up: 'sa', down: 'df' },
  { id: 'quiet', n: ['Mansa', 'Quiet'], up: 'sa', down: 'spd' },
  { id: 'bashful', n: ['Tímida', 'Bashful'], up: '', down: '' },
  { id: 'rash', n: ['Alocada', 'Rash'], up: 'sa', down: 'sd' },
  { id: 'calm', n: ['Serena', 'Calm'], up: 'sd', down: 'pa' },
  { id: 'gentle', n: ['Amable', 'Gentle'], up: 'sd', down: 'df' },
  { id: 'sassy', n: ['Grosera', 'Sassy'], up: 'sd', down: 'spd' },
  { id: 'careful', n: ['Cauta', 'Careful'], up: 'sd', down: 'sa' },
  { id: 'quirky', n: ['Rara', 'Quirky'], up: '', down: '' }
];
G.NATURES = NATURES;

export const NATURE_BY: Record<string, Nature> = {};
for (const n of NATURES) NATURE_BY[n.id] = n;
G.NATURE_BY = NATURE_BY;

declare module '../g' {
  interface Registry {
    NATURES: typeof NATURES;
    NATURE_BY: typeof NATURE_BY;
  }
}
