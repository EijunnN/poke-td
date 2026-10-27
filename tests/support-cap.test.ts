/* ============ support-cap.test.ts — Pokémon grandes y tope de apoyos ============
 *   bun test tests/support-cap.test.ts
 * Como mucho 3 curanderos, 3 escuderos y 3 invocadores vivos (systems/spawner.ts) y la escala a la
 * que se dibuja tu Pokémon (core/sprites.ts, playerScale). Sin navegador.
 */
import { describe, expect, test } from 'bun:test';
import { G } from '../src/g';
import '../src/core/util';
import '../src/data/sprites-meta';
import '../src/data/pokedex';
import { Sprites } from '../src/core/sprites';
import { SUPPORT_MAX, pickCapped, supportFull } from '../src/systems/spawner';

const def = (behavior: string, dex = 1) => ({ behavior, dex });

describe('tope de apoyos', () => {
  test('hasta 3 de cada clase, a la tercera ya está llena', () => {
    expect(SUPPORT_MAX).toBe(3);
    expect([...supportFull(['healer', 'healer', 'chase'])]).toEqual([]);
    expect([...supportFull(['healer', 'healer', 'healer'])]).toEqual(['healer']);
    expect([...supportFull(['healer', 'healer', 'healer', 'shielder', 'summoner', 'summoner', 'summoner', 'summoner'])].sort())
      .toEqual(['healer', 'summoner']);
  });

  test('los que no son de apoyo no cuentan', () => {
    expect([...supportFull(Array(50).fill('chase').concat(Array(9).fill('ranged')))]).toEqual([]);
  });

  test('con la clase llena sale otro del elenco, nunca esa clase', () => {
    const bag = [def('healer', 113), def('shielder', 213), def('chase', 19)];
    const alive = ['healer', 'healer', 'healer'];
    for (let r = 0; r < 1; r += 0.01) expect(pickCapped(bag, r, alive)!.behavior).not.toBe('healer');
  });

  test('con sitio en la clase se sortea el elenco entero', () => {
    const bag = [def('healer', 113), def('shielder', 213), def('chase', 19)];
    const alive = ['healer', 'healer'];
    expect(pickCapped(bag, 0, alive)!.behavior).toBe('healer');
    expect(pickCapped(bag, 0.5, alive)!.behavior).toBe('shielder');
    expect(pickCapped(bag, 0.99, alive)!.behavior).toBe('chase');
  });

  test('sin tope los de siempre salen igual (mismo sorteo que antes: floor(azar * largo))', () => {
    const bag = [def('chase', 1), def('ranged', 2), def('tank', 3), def('charger', 4)];
    for (const r of [0, 0.24, 0.25, 0.6, 0.999]) expect(pickCapped(bag, r, ['healer', 'healer', 'healer'])).toBe(bag[Math.floor(r * 4)]);
  });

  test('si todo el elenco está al tope no sale nada', () => {
    const bag = [def('healer', 113), def('summoner', 30)];
    expect(pickCapped(bag, 0.3, ['healer', 'healer', 'healer', 'summoner', 'summoner', 'summoner'])).toBeNull();
    expect(pickCapped([], 0.3, [])).toBeNull();
  });
});

describe('escala de tu Pokémon', () => {
  const h = (dex: number) => { const m = Sprites.animMeta(dex, 'Idle')!; return Math.max(m.ay, m.w * 0.55); };

  test('los grandes se dibujan más pequeños, pero siguen siendo de los más grandes', () => {
    for (const dex of [95, 130, 321, 890]) {   // Onix, Gyarados, Wailord, Eternatus
      const k = Sprites.playerScale(dex);
      expect(h(dex), String(dex)).toBeGreaterThan(36);
      expect(k, String(dex)).toBeLessThan(1);
      expect(k, String(dex)).toBeGreaterThanOrEqual(0.3);
      expect(h(dex) * k, String(dex)).toBeGreaterThan(36);       // siguen sobrepasando el límite
      expect(h(dex) * k, String(dex)).toBeLessThan(h(dex));
    }
  });

  test('los normales no cambian y ningún Pokémon sale con escala fuera de (0, 1]', () => {
    expect(Sprites.playerScale(25)).toBe(1);
    expect(Sprites.playerScale(1)).toBe(1);
    expect(Sprites.playerScale(999999)).toBe(1);               // sin datos
    for (const p of G.DEX) {
      const k = Sprites.playerScale(p.dex);
      expect(k > 0 && k <= 1, String(p.dex)).toBe(true);
      if (h(p.dex) <= 36) expect(k).toBe(1);
    }
  });

  test('más grande de origen, más grande dibujado (no se cruzan)', () => {
    const l = G.DEX.filter(p => Sprites.animMeta(p.dex, 'Idle')).sort((a, b) => h(a.dex) - h(b.dex));
    let last = 0;
    for (const p of l) { const v = h(p.dex) * Sprites.playerScale(p.dex); expect(v).toBeGreaterThanOrEqual(last - 1.5); last = Math.max(last, v); }
  });
});
