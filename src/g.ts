/* ============ g.ts — registro de módulos del juego ============
 * Cada módulo se apunta aquí (G.Spawner = Spawner) y declara su tipo en
 * `Registry`, así el resto lo usa como G.Spawner con tipos y sin depender del
 * orden de los imports. Lo que aún no se ha declarado sale como `any`.
 */
export interface Registry { [key: string]: any }
export const G = {} as Registry;
