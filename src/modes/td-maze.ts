/* ============ td-maze.ts — el laberinto de la Arena (Line Tower Wars) ============
 * Funciones puras, sin nada del juego: cada carril es una cuadrícula vertical; los monstruos
 * entran por arriba y salen por abajo, y no hay camino fijo: las torres son obstáculos y los
 * monstruos van siempre por la ruta más corta que quede. Se prueban en tests/td-maze.test.ts.
 *
 *   distancias  `flow`: lo que le falta a cada casilla para llegar a la salida (Dijkstra desde la
 *               fila de abajo; recto 10, en diagonal 14, sin cortar esquinas de obstáculos). Una
 *               casilla sin salida vale UNREACH. Se rehace al plantar o vender (es pequeña).
 *   moverse     `stepFrom`: la casilla vecina con menos distancia (de ahí sale la ruta de cada uno).
 *   construir   `canBlock`: no se puede tapar el paso de la entrada a la salida, ni dejar encerrado
 *               a ningún monstruo, ni plantar donde está uno (ni en las filas libres de arriba y abajo).
 *   vista       `routeFrom`: la ruta de una casilla a la salida (para dibujarla al colocar).
 */

/** Columnas y filas de un carril, y lo que mide una casilla (unidades de mundo). */
export const MAZE_COLS = 11, MAZE_ROWS = 26, CELL = 48;
/** Filas de arriba (por donde entran) y de abajo (la salida) en las que no se construye. */
export const FREE_ROWS = 2;
/** Distancia de una casilla sin camino a la salida. */
export const UNREACH = 1e9;

/** El índice de una casilla. */
export const cellIx = (c: number, r: number) => r * MAZE_COLS + c;
export const cellCol = (i: number) => i % MAZE_COLS;
export const cellRow = (i: number) => Math.floor(i / MAZE_COLS);
/** ¿Está dentro del carril? */
export const inMaze = (c: number, r: number) => c >= 0 && c < MAZE_COLS && r >= 0 && r < MAZE_ROWS;
/** ¿Se puede construir en esa fila? (las de arriba y abajo quedan libres) */
export const buildRow = (r: number) => r >= FREE_ROWS && r < MAZE_ROWS - FREE_ROWS;

/** Lo que mide un carril en unidades de mundo. */
export const MAZE_W = MAZE_COLS * CELL, MAZE_H = MAZE_ROWS * CELL;
/** La casilla de un punto (relativo al centro del carril), o -1 si cae fuera. */
export function cellAt(x: number, y: number): number {
  const c = Math.floor((x + MAZE_W / 2) / CELL), r = Math.floor((y + MAZE_H / 2) / CELL);
  return inMaze(c, r) ? cellIx(c, r) : -1;
}
/** El centro de una casilla (relativo al centro del carril). */
export function cellCenter(i: number): { x: number; y: number } {
  return { x: (cellCol(i) + 0.5) * CELL - MAZE_W / 2, y: (cellRow(i) + 0.5) * CELL - MAZE_H / 2 };
}

const STEPS: [number, number, number][] = [[1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10], [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14]];

/**
 * Las distancias a la salida (la última fila) de cada casilla, con `blocked` como obstáculos.
 * En diagonal sólo si las dos casillas de al lado están libres (no se corta la esquina de una torre).
 */
export function flow(blocked: Uint8Array | boolean[]): Float64Array {
  const n = MAZE_COLS * MAZE_ROWS, d = new Float64Array(n).fill(UNREACH);
  // Dijkstra con una cola sencilla (la cuadrícula es pequeña: 286 casillas).
  const open: number[] = [];
  for (let c = 0; c < MAZE_COLS; c++) { const i = cellIx(c, MAZE_ROWS - 1); if (!blocked[i]) { d[i] = 0; open.push(i); } }
  while (open.length) {
    let k = 0;
    for (let j = 1; j < open.length; j++) if (d[open[j]] < d[open[k]]) k = j;
    const i = open[k]; open[k] = open[open.length - 1]; open.pop();
    const c = cellCol(i), r = cellRow(i);
    for (const [dc, dr, w] of STEPS) {
      const nc = c + dc, nr = r + dr;
      if (!inMaze(nc, nr)) continue;
      const ni = cellIx(nc, nr);
      if (blocked[ni]) continue;
      if (dc && dr && (blocked[cellIx(c + dc, r)] || blocked[cellIx(c, r + dr)])) continue;
      if (d[i] + w < d[ni]) { d[ni] = d[i] + w; open.push(ni); }
    }
  }
  return d;
}

/** La casilla vecina por la que seguir hacia la salida (la de menos distancia), o -1 si no hay. */
export function stepFrom(i: number, d: Float64Array, blocked: Uint8Array | boolean[]): number {
  const c = cellCol(i), r = cellRow(i);
  let best = -1, bd = d[i];
  for (const [dc, dr] of STEPS) {
    const nc = c + dc, nr = r + dr;
    if (!inMaze(nc, nr)) continue;
    const ni = cellIx(nc, nr);
    if (blocked[ni] || d[ni] >= bd) continue;
    if (dc && dr && (blocked[cellIx(c + dc, r)] || blocked[cellIx(c, r + dr)])) continue;
    bd = d[ni]; best = ni;
  }
  return best;
}

/** La casilla vecina más lejos de la salida (para empujar o confundir), o -1. */
export function stepBackFrom(i: number, d: Float64Array, blocked: Uint8Array | boolean[]): number {
  const c = cellCol(i), r = cellRow(i);
  let best = -1, bd = d[i];
  for (const [dc, dr] of STEPS) {
    const nc = c + dc, nr = r + dr;
    if (!inMaze(nc, nr)) continue;
    const ni = cellIx(nc, nr);
    if (blocked[ni] || d[ni] >= UNREACH || d[ni] <= bd) continue;
    if (dc && dr && (blocked[cellIx(c + dc, r)] || blocked[cellIx(c, r + dr)])) continue;
    bd = d[ni]; best = ni;
  }
  return best;
}

/** La ruta de `i` a la salida (casillas), siguiendo las distancias; vacía si no hay. */
export function routeFrom(i: number, d: Float64Array, blocked: Uint8Array | boolean[]): number[] {
  if (i < 0 || d[i] >= UNREACH) return [];
  const out = [i];
  for (let k = 0; k < MAZE_COLS * MAZE_ROWS && d[out[out.length - 1]] > 0; k++) {
    const n = stepFrom(out[out.length - 1], d, blocked);
    if (n < 0) break;
    out.push(n);
  }
  return out;
}

/** Las casillas de entrada (la fila de arriba). */
export const entryCells = () => Array.from({ length: MAZE_COLS }, (_, c) => cellIx(c, 0));

/**
 * ¿Se puede poner un obstáculo en la casilla `i`? → '' si se puede, o el motivo.
 * @param monsters  las casillas donde hay monstruos (o a las que van): ahí no, y ninguno puede quedar encerrado
 */
export function blockError(i: number, blocked: Uint8Array | boolean[], monsters: number[]): string {
  if (i < 0) return 'Fuera de tu carril';
  if (!buildRow(cellRow(i))) return 'Ahí entran o salen: déjalo libre';
  if (blocked[i]) return 'Ya hay algo ahí';
  if (monsters.includes(i)) return 'Hay un monstruo ahí';
  const b = Uint8Array.from(blocked as ArrayLike<number>, v => (v ? 1 : 0));
  b[i] = 1;
  const d = flow(b);
  if (!entryCells().some(e => d[e] < UNREACH)) return 'Taparías el camino';
  if (monsters.some(m => d[m] >= UNREACH)) return 'Dejarías a un monstruo encerrado';
  return '';
}
