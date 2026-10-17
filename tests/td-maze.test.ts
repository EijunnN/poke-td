/* ============ td-maze.test.ts — el laberinto de la Arena (src/modes/td-maze.ts) ============
 *   bun test tests/td-maze.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  MAZE_COLS, MAZE_ROWS, CELL, FREE_ROWS, UNREACH, cellIx, cellCol, cellRow, cellAt, cellCenter, flow, stepFrom,
  stepBackFrom, routeFrom, blockError, entryCells,
} from '../src/modes/td-maze';

const empty = () => new Uint8Array(MAZE_COLS * MAZE_ROWS);
const mid = Math.floor(MAZE_COLS / 2);

describe('Arena: el laberinto', () => {
  test('sin obstáculos, todo llega a la salida y en línea recta hacia abajo', () => {
    const d = flow(empty());
    for (let i = 0; i < d.length; i++) expect(d[i]).toBeLessThan(UNREACH);
    const r = routeFrom(cellIx(mid, 0), d, empty());
    expect(r.length).toBe(MAZE_ROWS);
    expect(r.every(i => cellCol(i) === mid)).toBe(true);
    expect(cellRow(r[r.length - 1])).toBe(MAZE_ROWS - 1);
  });

  test('una fila de torres con un hueco: la ruta pasa por el hueco', () => {
    const b = empty(), row = 10, gap = 2;
    for (let c = 0; c < MAZE_COLS; c++) if (c !== gap) b[cellIx(c, row)] = 1;
    const d = flow(b);
    const r = routeFrom(cellIx(mid, 0), d, b);
    expect(r.some(i => cellRow(i) === row && cellCol(i) === gap)).toBe(true);
    expect(r.every(i => !b[i])).toBe(true);
    // Más larga que sin obstáculos (ése es el juego: alargar el camino).
    expect(d[cellIx(mid, 0)]).toBeGreaterThan(flow(empty())[cellIx(mid, 0)]);
  });

  test('en diagonal no corta la esquina de una torre', () => {
    const b = empty();
    b[cellIx(5, 5)] = 1;
    const d = flow(b);
    // De (4,4) a (5,5) no se puede (es la torre); de (4,5) a (5,6) sí; de (4,4) no salta a (5,5) ni cruza su esquina.
    const n = stepFrom(cellIx(6, 4), d, b);
    expect(n).not.toBe(cellIx(5, 5));
    // Un paso en diagonal pegado a la torre: con la esquina tapada no se toma.
    expect(stepFrom(cellIx(4, 4), d, b)).not.toBe(cellIx(5, 5));
  });

  test('no se puede tapar el paso, ni encerrar a un monstruo, ni plantar encima de uno, ni arriba o abajo', () => {
    const b = empty(), row = 12;
    for (let c = 0; c < MAZE_COLS - 1; c++) b[cellIx(c, row)] = 1;
    const last = cellIx(MAZE_COLS - 1, row);
    expect(blockError(last, b, [])).toBe('Taparías el camino');
    // Un monstruo en una bolsa (torres arriba y a su derecha): tapar su única salida, abajo, lo encerraría.
    const b2 = empty();
    for (const [c, r] of [[0, 9], [1, 9], [1, 10]]) b2[cellIx(c, r)] = 1;
    expect(blockError(cellIx(6, 6), b2, [cellIx(0, 10)])).toBe('');
    expect(blockError(cellIx(0, 11), b2, [cellIx(0, 10)])).not.toBe('');
    b2[cellIx(1, 11)] = 1;
    expect(blockError(cellIx(0, 11), b2, [cellIx(0, 10)])).toBe('Dejarías a un monstruo encerrado');
    expect(blockError(cellIx(3, 8), empty(), [cellIx(3, 8)])).toBe('Hay un monstruo ahí');
    expect(blockError(cellIx(3, 0), empty(), [])).not.toBe('');
    expect(blockError(cellIx(3, MAZE_ROWS - 1), empty(), [])).not.toBe('');
    expect(blockError(cellIx(3, FREE_ROWS), empty(), [])).toBe('');
    expect(blockError(-1, empty(), [])).toBe('Fuera de tu carril');
  });

  test('se puede hacer un laberinto en serpiente y la ruta lo recorre entero', () => {
    const b = empty();
    // Filas de torres alternando el hueco a un lado y al otro.
    for (let r = 4; r < MAZE_ROWS - 4; r += 3) {
      const gap = ((r - 4) / 3) % 2 ? 0 : MAZE_COLS - 1;
      for (let c = 0; c < MAZE_COLS; c++) {
        if (c === gap) continue;
        expect(blockError(cellIx(c, r), b, [])).toBe('');
        b[cellIx(c, r)] = 1;
      }
    }
    const d = flow(b);
    expect(entryCells().every(e => d[e] < UNREACH)).toBe(true);
    expect(routeFrom(cellIx(mid, 0), d, b).length).toBeGreaterThan(MAZE_ROWS);
    expect(d[cellIx(mid, 0)]).toBeGreaterThan(3 * flow(empty())[cellIx(mid, 0)]);   // mucho más largo que bajar recto
  });

  test('empujar: la casilla vecina más lejos de la salida', () => {
    const d = flow(empty());
    const back = stepBackFrom(cellIx(mid, 10), d, empty());
    expect(cellRow(back)).toBe(9);
  });

  test('casillas y coordenadas (relativas al centro del carril)', () => {
    for (const i of [0, cellIx(mid, 7), MAZE_COLS * MAZE_ROWS - 1]) {
      const p = cellCenter(i);
      expect(cellAt(p.x, p.y)).toBe(i);
      expect(cellAt(p.x + CELL / 2 - 1, p.y - CELL / 2 + 1)).toBe(i);
    }
    expect(cellAt(-MAZE_COLS * CELL, 0)).toBe(-1);
  });
});
