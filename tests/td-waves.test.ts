/* ============ td-waves.test.ts — el calendario de oleadas del modo Defensa ============
 *   bun test tests/td-waves.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { DEX } from '../src/data/pokedex';
import { WAVES, LAST_WAVE, waveAt, waveHp, waveCount, waveGap, bossHpMul, leakCost } from '../src/modes/td-waves';
import { killReward, waveBonus } from '../src/modes/td-geom';

const BY = new Map(DEX.map(p => [p.dex, p]));

describe('calendario', () => {
  test('30 oleadas, todas con tema, pista y Pokémon que existen', () => {
    expect(LAST_WAVE).toBe(30);
    for (const w of WAVES) {
      expect(w.theme.length).toBeGreaterThan(3);
      expect(w.hint.length).toBeGreaterThan(3);
      expect(w.pool.length).toBeGreaterThanOrEqual(2);
      for (const d of [...w.pool, ...(w.boss ? [w.boss] : [])]) expect(BY.has(d)).toBe(true);
    }
  });

  test('jefe cada 5 y legendario cada 10; los normales no son legendarios (salvo en la final)', () => {
    WAVES.forEach((w, i) => {
      const n = i + 1;
      if (n % 10 === 0) { expect(w.legend).toBe(true); expect(BY.get(w.boss!)!.leg).toBe(true); }
      else if (n % 5 === 0) { expect(w.boss).toBeDefined(); expect(w.legend).toBeFalsy(); expect(BY.get(w.boss!)!.leg).toBeFalsy(); }
      if (n < LAST_WAVE) for (const d of w.pool) expect(BY.get(d)!.leg).toBeFalsy();
    });
    expect(BY.get(WAVES[LAST_WAVE - 1].boss!)!.name).toBe('Mewtwo');
  });

  test('las oleadas de voladores lo son de verdad', () => {
    for (const w of WAVES.filter(w => /Voladores/.test(w.theme))) {
      for (const d of w.pool) expect(BY.get(d)!.types).toContain('flying');
    }
  });

  test('fuera de rango no revienta', () => {
    expect(waveAt(0)).toBe(WAVES[0]);
    expect(waveAt(999)).toBe(WAVES[LAST_WAVE - 1]);
    expect(waveAt(NaN as any)).toBe(WAVES[0]);
  });
});

describe('curva', () => {
  test('la vida crece cada oleada, y la cantidad nunca baja salvo en las de jefe', () => {
    for (let n = 2; n <= LAST_WAVE; n++) {
      expect(waveHp(n)).toBeGreaterThan(waveHp(n - 1));
      expect(waveGap(n)).toBeLessThanOrEqual(waveGap(n - 1));
      if (!waveAt(n).boss && !waveAt(n - 1).boss) expect(waveCount(n)).toBeGreaterThanOrEqual(waveCount(n - 1));
    }
    expect(waveGap(999)).toBeGreaterThan(0.3);
  });

  test('la vida total de una oleada crece más deprisa que el dinero, pero sin desbocarse', () => {
    const total = (n: number) => waveCount(n) * waveHp(n) + (waveAt(n).boss ? waveHp(n) * bossHpMul(!!waveAt(n).legend) : 0);
    const income = (n: number) => waveCount(n) * killReward(n) + waveBonus(n);
    // De la 1 a la 30, la vida por oleada crece entre 100 y 3000 veces (las torres evolucionan y se
    // apilan: medido con tools/td-balance.ts); el dinero, mucho menos.
    const hpGrowth = total(30) / total(1), moneyGrowth = income(30) / income(1);
    expect(hpGrowth).toBeGreaterThan(100);
    expect(hpGrowth).toBeLessThan(3000);
    expect(moneyGrowth * 20).toBeLessThan(hpGrowth);
  });

  test('lo que cuesta dejar pasar a cada uno', () => {
    expect(leakCost(false, false)).toBe(1);
    expect(leakCost(true, false)).toBe(3);
    expect(leakCost(true, true)).toBe(6);
  });
});

describe('textos en inglés (la guía y el juego en inglés)', () => {
  const { ROLES, AURAS } = require('../src/modes/td-geom');
  test('cada oleada, cada poder de tipo y cada aura tienen su inglés', () => {
    for (const w of WAVES) { expect(w.en[0].length).toBeGreaterThan(2); expect(w.en[1].length).toBeGreaterThan(2); }
    for (const r of Object.values(ROLES) as any[]) { expect(r.en[0].length).toBeGreaterThan(2); expect(r.en[1].length).toBeGreaterThan(5); }
    for (const a of Object.values(AURAS) as any[]) { expect(a.en[0].length).toBeGreaterThan(2); expect(a.en[1].length).toBeGreaterThan(2); }
  });
});
