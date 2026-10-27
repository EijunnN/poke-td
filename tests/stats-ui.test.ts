/* ============ stats-ui.test.ts — medidor de daño y estadísticas de la pausa ============
 *   bun test tests/stats-ui.test.ts
 * Cálculos puros (sin navegador): el reparto del daño, cuánto sube cada carta de mejora y el informe.
 */
import { describe, expect, test } from 'bun:test';
import { rank, Recount } from '../src/systems/recount';
import '../src/systems/levelup';
import { G } from '../src/g';
import { cardPreview, damageReport, fmtN, statRows } from '../src/ui/stats-ui';

describe('reparto del daño', () => {
  test('ordena de más a menos, con su parte del total y lo larga que va la barra', () => {
    const r = rank([{ id: 'a', dmg: 25 }, { id: 'b', dmg: 75 }, { id: 'c', dmg: 0 }]);
    expect(r.map(x => x.id)).toEqual(['b', 'a', 'c']);
    expect(r.map(x => x.pct)).toEqual([75, 25, 0]);
    expect(r.map(x => x.frac)).toEqual([1, 1 / 3, 0]);
    expect(r.reduce((a, x) => a + x.pct, 0)).toBeCloseTo(100);
  });
  test('a igual daño se queda el orden de entrada; sin daño no divide por cero', () => {
    expect(rank([{ id: 'x', dmg: 5 }, { id: 'y', dmg: 5 }]).map(x => x.id)).toEqual(['x', 'y']);
    const z = rank([{ id: 'x', dmg: 0 }]);
    expect(z[0].pct).toBe(0);
    expect(z[0].frac).toBe(0);
    expect(rank([])).toEqual([]);
  });
});

describe('medidor de daño', () => {
  test('suma por movimiento, ignora lo que no tiene movimiento y se vacía', () => {
    Recount.reset();
    Recount.add('rayo', 10); Recount.add('rayo', 5); Recount.add('placaje', 3);
    Recount.add(undefined, 99); Recount.add('nada', 0); Recount.add('nada', -4);
    expect(Recount.total()).toBe(18);
    expect(Recount.rows().map(r => [r.id, r.dmg])).toEqual([['rayo', 15], ['placaje', 3]]);
    Recount.reset();
    expect(Recount.total()).toBe(0);
    expect(Recount.rows()).toEqual([]);
  });

  test('el informe pone nombre y tipo, el daño por segundo y el equipo sólo si hay más de uno', () => {
    const moves = [{ id: 'rayo', name: 'Rayo', type: 'electric' }];
    const rows = [{ id: 'rayo', dmg: 600 }, { id: 'fantasma', dmg: 200 }];
    const solo = damageReport({ moves } as any, 100, [], rows);
    expect(solo.total).toBe(800);
    expect(solo.dps).toBe(8);
    expect(solo.time).toBe(100);
    expect(solo.moves[0]).toMatchObject({ id: 'rayo', name: 'Rayo', type: 'electric', pct: 75 });
    expect(solo.moves[1]).toMatchObject({ id: 'fantasma', name: 'fantasma', type: 'normal' });
    expect(solo.team).toEqual([]);
    const team = [{ name: 'Ana', color: '#fff', me: true, dmg: 10 }, { name: 'Bo', color: '#000', me: false, dmg: 30 }];
    const grupo = damageReport({ moves } as any, 0, team, rows);
    expect(grupo.dps).toBe(800);                         // (el reloj a 0 no divide por cero)
    expect(grupo.team.map(t => [t.name, t.pct])).toEqual([['Bo', 75], ['Ana', 25]]);
    expect(damageReport({ moves } as any, 50, [team[0]], rows).team).toEqual([]);
  });

  test('cifras cortas', () => {
    expect([0, 999, 1234, 15600, 2500000, 12000000].map(fmtN)).toEqual(['0', '999', '1.2k', '16k', '2.5M', '12M']);
  });
});

/** Un jugador con sólo lo que miran las mejoras de nivel. */
function fakePlayer(): any {
  const buff = () => ({ n: 0, t: 0, amount: 0, dur: 0, src: null });
  return {
    maxHp: 100, hp: 100, atkMul: 1, spdMul: 1, cdMul: 1, dmgReduce: 0, regenFlat: 0, magnet: 78, xpMul: 1, critChance: 0, coinMul: 1,
    statsTaken: {}, buffs: { atk: buff(), spa: buff(), spd: buff(), def: buff(), regen: buff() }, moves: [],
    addMaxHp(a: number) { this.maxHp += a; this.hp += a; },
    heal() { throw new Error('la previsión no debe curar'); }
  };
}

describe('cuánto sube cada carta de mejora', () => {
  const stat = (id: string) => ({ type: 'stat' as const, key: 'stat:' + id });

  test('todas las mejoras con cifra tienen previsión (una nueva sin ella se nota aquí)', () => {
    for (const s of G.LevelUp.STATS as { id: string }[]) {
      if (s.id === 'heal') { expect(cardPreview(stat(s.id), fakePlayer())).toBeNull(); continue; }
      const v = cardPreview(stat(s.id), fakePlayer());
      expect(v, s.id).not.toBeNull();
      expect(v!.from).not.toBe(v!.to);
    }
  });

  test('las cifras salen de aplicar la mejora de verdad', () => {
    const p = fakePlayer();
    expect(cardPreview(stat('atk'), p)).toMatchObject({ from: '0%', to: '+10%', n: 1, max: 40 });
    expect(cardPreview(stat('cd'), p)).toMatchObject({ from: '0%', to: '-8%' });
    expect(cardPreview(stat('hp'), p)).toMatchObject({ from: '100', to: '120', max: 0 });
    expect(cardPreview(stat('def'), p)).toMatchObject({ from: '0%', to: '-6%' });
    expect(cardPreview(stat('rgn'), p)).toMatchObject({ from: '0/s', to: '0.9/s' });
    p.atkMul = 1.331; p.statsTaken.atk = 3;
    expect(cardPreview(stat('atk'), p)).toMatchObject({ from: '+33%', to: '+46%', n: 4 });
  });

  test('no toca al jugador ni lo que lleva contado', () => {
    const p = fakePlayer(), antes = JSON.stringify(p);
    for (const id of ['hp', 'atk', 'spd', 'cd', 'def', 'rgn', 'mag', 'xp']) cardPreview(stat(id), p);
    expect(JSON.stringify(p)).toBe(antes);
  });

  test('sin cambio (tope de reducción) o sin ser mejora, no hay línea', () => {
    const p = fakePlayer();
    p.dmgReduce = 0.7;
    expect(cardPreview(stat('def'), p)).toBeNull();
    expect(cardPreview({ type: 'up', key: 'up:rayo' }, p)).toBeNull();
    expect(cardPreview({ type: 'new', key: 'new:rayo' }, p)).toBeNull();
  });
});

describe('estadísticas de la pausa', () => {
  test('crítico y monedas sólo salen si valen algo; el potenciador va aparte', () => {
    const p = fakePlayer();
    expect(statRows(p).map(r => r.id)).toEqual(['hp', 'atk', 'spd', 'cd', 'def', 'rgn', 'mag', 'xp']);
    p.critChance = 0.05; p.coinMul = 1.2;
    p.buffs.atk = { n: 2, t: 5, amount: 0.15, dur: 8, src: 'swordsdance' };
    p.statsTaken.atk = 3;
    const rows = Object.fromEntries(statRows(p).map(r => [r.id, r]));
    expect(rows.crit.value).toBe('5%');
    expect(rows.coin.value).toBe('+20%');
    expect(rows.atk).toMatchObject({ value: '0%', temp: '+30%', n: 3, max: 40 });
    expect(rows.hp.value).toBe('100 / 100');
  });
});
