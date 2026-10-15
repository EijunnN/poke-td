import { G } from './g';
import type { CameraT } from './core/camera';
import type { Player } from './entities/player';
/* ============ run.ts — la partida en curso y el contrato de los modos de juego ============
 * game.ts lleva el bucle, el lienzo y los menús; lo que pasa DENTRO de una
 * partida lo pone un modo (modes/survivor.ts, y el tower defense cuando llegue).
 * Aquí está lo que comparten: el estado de la partida y qué tiene que ofrecer
 * un modo para que el bucle lo mueva.
 */

/** 'ui' = menús (sin partida). El resto, con partida en pantalla. */
export type RunState = 'ui' | 'playing' | 'levelup' | 'paused' | 'choice' | 'held' | 'over';

/** Lo que el bucle le presta al modo para dibujar. */
export interface View {
  ctx: CanvasRenderingContext2D;
  /** Tamaño del lienzo en píxeles CSS y densidad de píxeles. */
  w: number; h: number; dpr: number;
  /** Segundos de este fotograma (0 si la partida está parada). */
  frameDt: number;
  fps: number;
  /** Dibuja el mundo (suelo, objetos, enemigos) con `extra` ordenado por Y entre ellos. */
  drawScene(cam: CameraT, extra: { y: number; draw(ctx: CanvasRenderingContext2D): void }[]): void;
}

export interface GameMode {
  readonly id: string;
  /** Tu Pokémon en la partida. (Vale null sin partida; sólo se usa con ella, como en los modos.) */
  readonly player: Player;
  /** Reloj de la partida, en segundos. */
  readonly time: number;
  /** Empieza una partida y deja Run.state en 'playing'. */
  /** (Cada modo tiene sus opciones: ver su `start`.) */
  start(opts?: unknown): void;
  /** Un paso de simulación (sólo con Run.state === 'playing'). */
  update(dt: number): void;
  /** Partida en pantalla pero parada (cartas, pausa, resumen): sólo lo decorativo. */
  idle(dt: number): void;
  /** Pantallas propias que se quedan el teclado. @returns true si había alguna abierta */
  keysModal(): boolean;
  /** Teclas de juego (sólo con Run.state === 'playing'). */
  keysPlay(): void;
  /** Lo del modo que se dibuja dentro del mundo, ordenado por Y con lo demás. */
  drawables(): { y: number; draw(ctx: CanvasRenderingContext2D): void }[];
  /** Opcional: algo pintado en el suelo, debajo de todo (el camino del tower defense). */
  drawGround?(ctx: CanvasRenderingContext2D): void;
  render(v: View): void;
  /** Abandona la partida (se guarda lo conseguido). */
  quit(): void;
  /** Todos los jugadores de la partida (tú primero). */
  everyone(): Player[];
}

export const Run = {
  state: 'ui' as RunState,
  /** El modo de la última partida empezada (se queda puesto al volver al menú). */
  mode: null as GameMode | null
};
G.Run = Run;

declare module './g' {
  interface Registry { Run: typeof Run }
}
