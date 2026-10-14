import { G } from '../g';
/* ============ util.js — helpers compartidos ============ */

/** Altura a la que vuelan proyectiles y efectos sobre el plano del suelo. */
export const LIFT: number = 18;
G.LIFT = LIFT;

export const U = {
  clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; },
  lerp(a: number, b: number, t: number): number { return a + (b - a) * t; },
  rand(a: number, b: number): number { return a + Math.random() * (b - a); },
  randInt(a: number, b: number): number { return Math.floor(a + Math.random() * (b - a + 1)); },
  pick<T>(arr: ArrayLike<T>): T { return arr[Math.floor(Math.random() * arr.length)]; },

  /** Elige n elementos distintos al azar. */
  pickN<T>(arr: T[], n: number): T[] {
    const c = arr.slice();
    const out: T[] = [];
    while (out.length < n && c.length) out.push(c.splice(Math.floor(Math.random() * c.length), 1)[0]);
    return out;
  },

  dist(ax: number, ay: number, bx: number, by: number): number { return Math.hypot(bx - ax, by - ay); },
  dist2(ax: number, ay: number, bx: number, by: number): number { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; },

  /** Normaliza un vector; devuelve [0,0] si es nulo. */
  norm(x: number, y: number): [number, number] { const m = Math.hypot(x, y); return m > 1e-6 ? [x / m, y / m] : [0, 0]; },

  /** Interpolación independiente del framerate. */
  damp(a: number, b: number, rate: number, dt: number): number { return b + (a - b) * Math.exp(-rate * dt); },

  /** Hash determinista 2D -> [0,1). Para generar el mapa siempre igual. */
  hash(x: number, y: number, seed = 0): number {
    // Todo en enteros de 32 bits con Math.imul: es la función más llamada
    // al hornear el mapa, y así V8 no sale nunca de la ruta rápida.
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  },

  /** "3:07" a partir de segundos. */
  mmss(s: number): string {
    const m = Math.floor(s / 60);
    return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  },

  /** Colores de tipo Pokémon (para proyectiles, tags y efectos). */
  TYPE_COLOR: {
    normal: '#b0a99f', fire: '#ff7b3d', water: '#4b9bff', grass: '#5fcb6a',
    electric: '#ffd33d', ice: '#7fe0e0', fighting: '#e0533d', poison: '#b45ec4',
    ground: '#d6b25c', flying: '#9bb8ff', psychic: '#ff5f9e', bug: '#a3c43d',
    rock: '#bfa96b', ghost: '#7a6bc4', dragon: '#6b58ff', dark: '#6b5c52',
    steel: '#a8b8c4', fairy: '#ff9ed8'
  },

  TYPE_NAME: {
    normal: 'Normal', fire: 'Fuego', water: 'Agua', grass: 'Planta',
    electric: 'Eléctrico', ice: 'Hielo', fighting: 'Lucha', poison: 'Veneno',
    ground: 'Tierra', flying: 'Volador', psychic: 'Psíquico', bug: 'Bicho',
    rock: 'Roca', ghost: 'Fantasma', dragon: 'Dragón', dark: 'Siniestro',
    steel: 'Acero', fairy: 'Hada'
  }
};
G.U = U;

declare module '../g' {
  interface Registry {
    LIFT: typeof LIFT;
    /** `shuffle` no existe (combat.ts lo comprueba antes de usarlo). */
    U: typeof U & { shuffle?<T>(arr: T[]): T[] };
  }
}
