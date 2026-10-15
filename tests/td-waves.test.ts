/* ============ td-waves.test.ts — el calendario de oleadas del modo Defensa ============
 *   bun test tests/td-waves.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { DEX } from '../src/data/pokedex';
import { WAVES, LAST_WAVE, MAX_WAVE, START_LIVES, WIN_COINS, waveAt, waveHp, waveCount, waveGap, bossHpMul, leakCost,
         defenseScore, scoreParts, spawnTime, minDefenseTime, maxDefenseKills, defenseCoins } from '../src/modes/td-waves';
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
    expect(waveAt(-5)).toBe(WAVES[0]);
    expect(waveAt(NaN as any)).toBe(WAVES[0]);
    expect(waveAt(LAST_WAVE)).toBe(WAVES[LAST_WAVE - 1]);
  });

  test('sin fin: tras la 30 vuelve a empezar el calendario, marcado y con su inglés', () => {
    for (let n = LAST_WAVE + 1; n <= LAST_WAVE * 3 + 1; n++) {
      const w = waveAt(n), base = WAVES[(n - 1) % LAST_WAVE];
      expect(w.endless).toBe(true);
      expect(w.pool).toEqual(base.pool);
      expect(w.boss).toBe(base.boss);
      expect(w.legend).toBe(base.legend);
      expect(w.theme).toBe('Sin fin · ' + base.theme);
      expect(w.en[0]).toBe('Endless · ' + base.en[0]);
      expect(w.en[1]).toBe(base.en[1]);
    }
    expect(WAVES.some(w => w.endless)).toBe(false);           // el calendario no se toca
    expect(waveAt(999).endless).toBe(true);
    // Sigue endureciéndose: más vida y no menos enemigos que en la 30.
    expect(waveHp(LAST_WAVE + 1)).toBeGreaterThan(waveHp(LAST_WAVE));
    expect(waveCount(MAX_WAVE)).toBeGreaterThan(0);
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

describe('ranking de Defensa', () => {
  test('la puntuación ordena por oleadas y luego por vidas, y se deshace igual', () => {
    for (let w = 1; w <= LAST_WAVE; w++) {
      for (const l of [0, 1, 15, START_LIVES]) expect(scoreParts(defenseScore(w, l))).toEqual({ waves: w, lives: l });
      // Una oleada más gana a todas las vidas del mundo.
      if (w < LAST_WAVE) expect(defenseScore(w + 1, 0)).toBeGreaterThan(defenseScore(w, START_LIVES));
    }
    // Vidas fuera de rango se recortan (la partida puede acabar con vidas negativas).
    expect(defenseScore(5, -4)).toBe(500);
    expect(defenseScore(5, 99)).toBe(500 + START_LIVES);
  });

  test('tiempo mínimo: crece con cada oleada y cuadra con lo que tardan en salir', () => {
    expect(minDefenseTime(0)).toBe(0);
    let prev = 0;
    for (let w = 1; w <= LAST_WAVE; w++) {
      expect(spawnTime(w)).toBeGreaterThan(0);
      expect(minDefenseTime(w)).toBeCloseTo(prev + spawnTime(w), 6);
      prev = minDefenseTime(w);
    }
    // En el sin fin sigue sumando, hasta el tope del ranking.
    expect(minDefenseTime(LAST_WAVE + 5)).toBeCloseTo(minDefenseTime(LAST_WAVE) + [1, 2, 3, 4, 5].reduce((s, i) => s + spawnTime(LAST_WAVE + i), 0), 6);
    expect(minDefenseTime(MAX_WAVE + 10)).toBe(minDefenseTime(MAX_WAVE));
    // Ni demasiado (castigaría a quien juega rápido) ni nada: entre 2 y 15 min para las 30.
    expect(minDefenseTime(LAST_WAVE)).toBeGreaterThan(120);
    expect(minDefenseTime(LAST_WAVE)).toBeLessThan(900);
  });

  test('derrotados máximos: todo lo que sale hasta la oleada siguiente, jefes incluidos', () => {
    expect(maxDefenseKills(0)).toBe(waveCount(1));
    const all = WAVES.reduce((s, w, i) => s + waveCount(i + 1) + (w.boss ? 1 : 0), 0);
    expect(maxDefenseKills(LAST_WAVE - 1)).toBe(all);
    // Tras la 30, la siguiente (la 31, del sin fin) también cuenta.
    expect(maxDefenseKills(LAST_WAVE)).toBe(all + waveCount(LAST_WAVE + 1) + (waveAt(LAST_WAVE + 1).boss ? 1 : 0));
    expect(maxDefenseKills(MAX_WAVE + 5)).toBe(maxDefenseKills(MAX_WAVE));
  });

  test('puntuación del sin fin: hasta la 99 cabe sin pisar las vidas', () => {
    expect(scoreParts(defenseScore(MAX_WAVE, START_LIVES))).toEqual({ waves: MAX_WAVE, lives: START_LIVES });
    expect(defenseScore(LAST_WAVE + 1, 0)).toBeGreaterThan(defenseScore(LAST_WAVE, START_LIVES));
  });
});

describe('recompensas de cuenta', () => {
  test('10 por oleada, 1 por cada 5 derrotados y el premio de la victoria', () => {
    expect(defenseCoins(0, 0, false)).toBe(0);
    expect(defenseCoins(10, 99, false)).toBe(100 + 19);
    expect(defenseCoins(30, 500, true)).toBe(300 + 100 + WIN_COINS);
    expect(defenseCoins(-3, -10, false)).toBe(0);
    expect(defenseCoins(12.7, 7.9, false)).toBe(120 + 1);
  });

  test('una partida entera da más o menos lo que una de hordas del mismo rato (no se dispara)', () => {
    // 30 oleadas con todos los enemigos derrotados: unas 700 monedas (una de hordas de 20 min da del orden de 600-900).
    const all = maxDefenseKills(LAST_WAVE - 1);
    expect(defenseCoins(LAST_WAVE, all, true)).toBeLessThan(1000);
    expect(defenseCoins(LAST_WAVE, all, true)).toBeGreaterThan(500);
  });
});
