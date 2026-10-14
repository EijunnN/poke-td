/* ============ td-waves.ts — las oleadas del modo Defensa ============
 * Un calendario FIJO de 30 oleadas, cada una con un tema y su contrajuego
 * (como Green TD): se sabe lo que viene y se prepara el equipo. Los normales
 * son Pokémon sin evolucionar; cada 5 oleadas sale un jefe (una evolución
 * final) y cada 10, un legendario. La última es Mewtwo.
 *
 * La vida de cada oleada sale de una sola curva (waveHp), pensada a la par que
 * lo que se gana (td-geom: killReward y waveBonus). Funciones puras: se prueban
 * en tests/td-waves.test.ts.
 */

export interface Wave {
  /** Lo que se anuncia al empezar ("Voladores: Tierra no les hace nada"). */
  theme: string;
  /** Una pista para defenderse. */
  hint: string;
  /** Tema y pista en inglés. */
  en: [string, string];
  /** De dónde salen los normales (n.º de Pokédex). */
  pool: number[];
  /** El jefe, al final de la oleada. */
  boss?: number;
  /** El jefe es legendario (más vida y más vidas si llega). */
  legend?: boolean;
}

export const WAVES: Wave[] = [
  /* 1 */ { theme: 'Los primeros', hint: 'Cualquier torre sirve', en: ['The first ones', 'Any tower will do'], pool: [19, 16, 161, 263] },
  /* 2 */ { theme: 'Bichos', hint: 'Fuego, Volador y Roca les pegan fuerte', en: ['Bugs', 'Fire, Flying and Rock hit them hard'], pool: [10, 13, 265, 401] },
  /* 3 */ { theme: 'Agua', hint: 'Planta y Eléctrico', en: ['Water', 'Grass and Electric'], pool: [54, 60, 118, 116] },
  /* 4 */ { theme: 'Planta', hint: 'Fuego, Hielo, Volador', en: ['Grass', 'Fire, Ice, Flying'], pool: [43, 69, 187, 273] },
  /* 5 */ { theme: 'Jefe: Pidgeot', hint: 'Vuela: Tierra no le hace nada', en: ['Boss: Pidgeot', 'It flies: Ground does nothing to it'], pool: [16, 19, 21], boss: 18 },
  /* 6 */ { theme: 'Fuego', hint: 'Agua, Tierra y Roca', en: ['Fire', 'Water, Ground and Rock'], pool: [37, 58, 77, 218] },
  /* 7 */ { theme: 'Voladores', hint: 'Tierra no les hace nada; Eléctrico, Hielo y Roca sí', en: ['Flyers', 'Ground does nothing to them; Electric, Ice and Rock do'], pool: [16, 21, 41, 163, 276] },
  /* 8 */ { theme: 'Roca y Tierra', hint: 'Agua, Planta y Lucha', en: ['Rock and Ground', 'Water, Grass and Fighting'], pool: [74, 50, 27, 246] },
  /* 9 */ { theme: 'Eléctrico', hint: 'Tierra los anula', en: ['Electric', 'Ground shuts them down'], pool: [172, 81, 100, 309, 179] },
  /* 10 */ { theme: 'Legendario: Articuno', hint: 'Hielo y Volador: Fuego, Roca, Acero, Eléctrico', en: ['Legendary: Articuno', 'Ice and Flying: Fire, Rock, Steel, Electric'], pool: [86, 220, 361], boss: 144, legend: true },
  /* 11 */ { theme: 'Veneno', hint: 'Tierra y Psíquico; Veneno contra Veneno pega poco', en: ['Poison', 'Ground and Psychic; Poison against Poison hits weakly'], pool: [23, 29, 32, 88, 109] },
  /* 12 */ { theme: 'Fantasmas', hint: 'Normal y Lucha no les hacen nada; Siniestro y Fantasma sí', en: ['Ghosts', 'Normal and Fighting do nothing to them; Dark and Ghost do'], pool: [92, 200, 353, 355] },
  /* 13 */ { theme: 'Lucha', hint: 'Psíquico, Volador y Hada', en: ['Fighting', 'Psychic, Flying and Fairy'], pool: [66, 56, 296, 307] },
  /* 14 */ { theme: 'Psíquico', hint: 'Siniestro, Fantasma y Bicho', en: ['Psychic', 'Dark, Ghost and Bug'], pool: [63, 96, 79, 280] },
  /* 15 */ { theme: 'Jefe: Gyarados', hint: 'Eléctrico ×4', en: ['Boss: Gyarados', 'Electric ×4'], pool: [129, 118, 120], boss: 130 },
  /* 16 */ { theme: 'Hielo', hint: 'Fuego, Lucha, Roca, Acero', en: ['Ice', 'Fire, Fighting, Rock, Steel'], pool: [220, 361, 363, 459] },
  /* 17 */ { theme: 'Voladores, otra vez', hint: 'Tierra no les hace nada', en: ['Flyers, again', 'Ground does nothing to them'], pool: [84, 177, 333, 396, 198] },
  /* 18 */ { theme: 'Acero', hint: 'Fuego, Tierra, Lucha; Veneno no les hace nada', en: ['Steel', 'Fire, Ground, Fighting; Poison does nothing to them'], pool: [81, 304, 374, 436] },
  /* 19 */ { theme: 'Dragones jóvenes', hint: 'Hielo, Dragón y Hada', en: ['Young dragons', 'Ice, Dragon and Fairy'], pool: [147, 371, 443, 610] },
  /* 20 */ { theme: 'Legendario: Zapdos', hint: 'Eléctrico y Volador: Hielo y Roca', en: ['Legendary: Zapdos', 'Electric and Flying: Ice and Rock'], pool: [125, 239, 404], boss: 145, legend: true },
  /* 21 */ { theme: 'Siniestro', hint: 'Lucha, Bicho y Hada', en: ['Dark', 'Fighting, Bug and Fairy'], pool: [228, 215, 261, 570] },
  /* 22 */ { theme: 'Hadas', hint: 'Veneno y Acero', en: ['Fairies', 'Poison and Steel'], pool: [35, 209, 175, 669] },
  /* 23 */ { theme: 'Crecidos', hint: 'Evoluciones intermedias: más vida', en: ['Grown-ups', 'Middle evolutions: more HP'], pool: [2, 5, 8, 17, 30, 33] },
  /* 24 */ { theme: 'Fantasmas crecidos', hint: 'Siniestro y Fantasma', en: ['Grown-up ghosts', 'Dark and Ghost'], pool: [93, 354, 356, 426] },
  /* 25 */ { theme: 'Jefe: Tyranitar', hint: 'Lucha ×4; Agua, Planta, Tierra, Acero', en: ['Boss: Tyranitar', 'Fighting ×4; Water, Grass, Ground, Steel'], pool: [246, 247], boss: 248 },
  /* 26 */ { theme: 'Agua fuerte', hint: 'Planta y Eléctrico', en: ['Strong water', 'Grass and Electric'], pool: [134, 121, 119, 55] },
  /* 27 */ { theme: 'Dragones', hint: 'Hielo, Dragón y Hada', en: ['Dragons', 'Ice, Dragon and Fairy'], pool: [148, 372, 444, 611] },
  /* 28 */ { theme: 'Élite', hint: 'Evoluciones finales de todo tipo', en: ['Elite', 'Final evolutions of every type'], pool: [59, 68, 65, 94, 112] },
  /* 29 */ { theme: 'Pseudolegendarios', hint: 'Lo más fuerte antes del final', en: ['Pseudo-legendaries', 'The strongest before the end'], pool: [149, 373, 445, 376], boss: 635 },
  /* 30 */ { theme: 'Legendario: Mewtwo', hint: 'Psíquico: Siniestro, Fantasma y Bicho', en: ['Legendary: Mewtwo', 'Psychic: Dark, Ghost and Bug'], pool: [144, 145, 146], boss: 150, legend: true },
];

export const LAST_WAVE = WAVES.length;

/** La oleada n (1..30); más allá de la última, la última. */
export const waveAt = (n: number): Wave => WAVES[Math.max(0, Math.min(WAVES.length - 1, (n | 0) - 1))];

/** Cuánto crece la vida de una oleada a la siguiente. */
export const HP_GROWTH = 1.19;

/** Vida de un enemigo normal en la oleada n: crece un HP_GROWTH por oleada, más un poco fijo. */
export function waveHp(n: number): number {
  const w = Math.max(1, n | 0);
  return Math.round(50 * Math.pow(HP_GROWTH, w - 1) + 10 * w);
}

/** Cuántos normales salen en la oleada n (en las de jefe, menos: el jefe vale por muchos). */
export function waveCount(n: number): number {
  const w = Math.max(1, n | 0);
  const base = Math.min(26, 8 + Math.floor(w * 0.6));
  return waveAt(w).boss ? Math.ceil(base * 0.6) : base;
}

/** Segundos entre uno y el siguiente. */
export const waveGap = (n: number) => Math.max(0.45, 1.05 - Math.max(1, n | 0) * 0.02);

/** Vida del jefe: tantas veces la de un normal. */
export const bossHpMul = (legend: boolean) => legend ? 16 : 12;

/** Vidas al empezar la partida. */
export const START_LIVES = 30;

/** Vidas que te quita al llegar a la base. */
export const leakCost = (boss: boolean, legend: boolean) => legend ? 6 : boss ? 3 : 1;
