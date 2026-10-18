/* ============ trailer-mazes.ts — los laberintos de los expertos del tráiler (tools/trailer-coop.ts) ============ */
import { MAZE_COLS, MAZE_ROWS, UNREACH, blockError, cellIx, entryCells, flow, routeFrom } from '../src/modes/td-maze';

/** Las estrategias de los expertos, una por carril (td-maze.ts: 11×26 casillas de 48; se construye de la fila 2 a la 23):
 *   zigzag  una fila de piezas cada dos, con el hueco a un lado y al otro: bajan de pared a pared
 *   embudo  una barrera con un solo hueco y, debajo, un pasillo forrado de torres: corto, pero todo dispara a la vez
 *   peine   barreras arriba y abajo y columnas alternas: suben y bajan de lado a lado
 *   ladrillos  filas con huecos que no coinciden con los de la fila siguiente: cada fila, un paso de lado
 *  Lo que queda a medias de un laberinto válido también lo es, así que el bot puede ir pieza a pieza.
 *  `bun tools/trailer-mazes.ts` los comprueba con las reglas de verdad (src/modes/td-maze.ts) y los dibuja. */
const MAZE_ROWS_PLAN = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21];
export const MAZE_STYLES = ['zigzag', 'embudo', 'peine', 'ladrillos'] as const;
export function mazeCells(style: typeof MAZE_STYLES[number]): [number, number, boolean][] {
  const out: [number, number, boolean][] = [];
  if (style === 'zigzag') MAZE_ROWS_PLAN.forEach((r, k) => {
    const gap = k % 2 ? 0 : 10;
    for (let c = 0; c < 11; c++) if (c !== gap) out.push([c, r, c % 2 === 0]);
  });
  if (style === 'embudo') {
    for (let c = 0; c < 11; c++) if (c !== 5) out.push([c, 3, false]);
    for (let r = 4; r <= 21; r++) { out.push([4, r, true]); out.push([6, r, true]); }
    for (let r = 7; r <= 18; r += 2) { out.push([3, r, true]); out.push([7, r, true]); }
  }
  if (style === 'peine') {
    for (let c = 0; c < 10; c++) out.push([c + 1, 2, c % 3 === 0]);          // arriba, sólo entra por la columna 0
    [1, 3, 5, 7, 9].forEach((c, k) => {
      const [r0, r1] = k % 2 ? [5, 22] : [3, 20];                            // el hueco, abajo y arriba por turnos
      for (let r = r0; r <= r1; r++) out.push([c, r, r % 3 === 0]);
    });
    for (let c = 0; c < 10; c++) out.push([c, 23, c % 3 === 0]);             // abajo, sólo sale por la columna 10
  }
  if (style === 'ladrillos') MAZE_ROWS_PLAN.forEach((r, k) => {
    for (let c = 0; c < 11; c++) if ((c + 2 * k) % 4 !== 1) out.push([c, r, c % 2 === 0]);
  });
  return out;
}

// Comprobación: cada pieza, en orden, se puede poner (con el carril vacío de monstruos), y la ruta final.
if (import.meta.main) for (const st of MAZE_STYLES) {
  const blocked = new Uint8Array(MAZE_COLS * MAZE_ROWS);
  for (const [c, r] of mazeCells(st)) {
    const why = blockError(cellIx(c, r), blocked, []);
    if (why) throw new Error(`${st}: (${c}, ${r}) ${why}`);
    blocked[cellIx(c, r)] = 1;
  }
  const d = flow(blocked);
  const best = Math.min(...entryCells().map(e => d[e]));
  const route = new Set(routeFrom(entryCells().find(e => d[e] === best)!, d, blocked));
  const pieces = mazeCells(st), towers = pieces.filter(p => p[2]).length;
  console.log(`${st}: ${pieces.length} piezas (${towers} torres), recorrido ${(best / 10).toFixed(1)} casillas (vacío: 26)`);
  for (let r = 0; r < MAZE_ROWS; r++) {
    let line = '';
    for (let c = 0; c < MAZE_COLS; c++) {
      const i = cellIx(c, r);
      line += blocked[i] ? (pieces.find(p => p[0] === c && p[1] === r)![2] ? 'T' : '#') : route.has(i) ? '·' : ' ';
    }
    console.log('  |' + line + '|');
  }
  if (best >= UNREACH) throw new Error(st + ': sin salida');
}
