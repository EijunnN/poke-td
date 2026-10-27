/* ============ move-cats.test.ts — ataques físicos y especiales ============
 *   bun test tests/move-cats.test.ts
 * Categoría de cada movimiento, quién aprende Maquinación y las cuentas de daño y defensa.
 */
import { describe, expect, test } from 'bun:test';
import { G } from '../src/g';
import '../src/core/util';
import '../src/data/pokedex';
import '../src/data/base-stats';
import { Moves } from '../src/data/moves';
import { Player } from '../src/entities/player';
import { atkOf, guardOf } from '../src/data/stat-mods';

/** Un jugador con sólo lo que miran atkFor y hurt, con el Ataque y el At. Esp. base que se diga. */
function stub(atk: number, spa: number): Player {
  const buff = () => ({ n: 0, t: 0, amount: 0, dur: 0, src: null });
  return Object.assign(Object.create(Player.prototype), {
    cats: true, atkMul: 1, basePhys: atkOf(atk), baseSpec: atkOf(spa), baseAtk: 1, mon: { types: ['normal', 'flying'] },
    buffs: { atk: buff(), spa: buff() }
  });
}

describe('categoría de los movimientos', () => {
  test('todos los que hacen daño son físicos o especiales y los potenciadores no tienen', () => {
    for (const m of Moves.ALL) {
      if (m.kind === 'buff') expect(m.cat, m.id).toBeUndefined();
      else expect(['phys', 'spec'], m.id).toContain(m.cat);
    }
  });

  test('las de los juegos: Lanzallamas y Rayo especiales, Placaje y Mordisco físicos', () => {
    expect(Moves.BY_ID['flamethrower'].cat).toBe('spec');
    expect(Moves.BY_ID['thunderbolt'].cat).toBe('spec');
    expect(Moves.BY_ID['tackle'].cat).toBe('phys');
    expect(Moves.BY_ID['bite'].cat).toBe('phys');
  });

  test('la instancia en partida conserva la categoría', () => {
    expect(Moves.instance('shadow-ball', 3).cat).toBe('spec');
  });
});

describe('Maquinación', () => {
  const pool = (dex: number) => Moves.poolFor({ ...G.DEX_BY[dex] });

  test('sólo la aprenden los que la tienen en los juegos, sean o no Siniestro', () => {
    expect(pool(94)).toContain('nasty-plot');   // Gengar (Fantasma/Veneno)
    expect(pool(65)).toContain('nasty-plot');   // Alakazam
    expect(pool(197)).not.toContain('nasty-plot');  // Umbreon, Siniestro que no la aprende
    expect(pool(6)).not.toContain('nasty-plot');    // Charizard
  });

  test('sin número de Pokédex (el movimiento inicial por tipo) no sale', () => {
    expect(Moves.poolFor({ types: ['dark'] })).not.toContain('nasty-plot');
  });

  test('potencia el At. Esp. y la Danza Espada sólo el Ataque', () => {
    expect(Moves.BY_ID['nasty-plot'].stat).toBe('spa');
    expect(Moves.BY_ID['swords-dance'].stat).toBe('atk');
  });
});

describe('daño y defensa', () => {
  test('el lado bueno pega más: con más Ataque, los físicos; con más At. Esp., los especiales', () => {
    const fis = stub(130, 60), esp = stub(60, 130);
    expect(fis.atkFor({ cat: 'phys' })).toBeGreaterThan(fis.atkFor({ cat: 'spec' }));
    expect(esp.atkFor({ cat: 'spec' })).toBeGreaterThan(esp.atkFor({ cat: 'phys' }));
    expect(fis.bestCat()).toBe('phys');
    expect(esp.bestCat()).toBe('spec');
    expect(stub(100, 95).bestCat()).toBe('');
  });

  test('la media de todos los Pokémon queda cerca de la de antes (±5 %)', () => {
    const rows = Object.values(G.BASE_STATS as Record<number, [number, number]>);
    const antes = rows.reduce((a, s) => a + 0.70 + Math.max(s[0], s[1]) / 100 * 0.55, 0) / rows.length;
    // Lo normal es usar sobre todo el lado bueno: 7 de cada 10 golpes.
    const ahora = rows.reduce((a, s) => a + 0.7 * atkOf(Math.max(s[0], s[1])) + 0.3 * atkOf(Math.min(s[0], s[1])), 0) / rows.length;
    expect(Math.abs(ahora / antes - 1)).toBeLessThan(0.05);
  });

  test('las danzas sólo suben su categoría', () => {
    const p = stub(100, 100);
    p.buffs.atk = { n: 5, t: 5, amount: 0.13, dur: 7, src: null };
    expect(p.atkFor({ cat: 'phys' })).toBeCloseTo(p.atkFor({ cat: 'spec' }) * 1.65, 6);
    p.buffs.spa = { n: 5, t: 5, amount: 0.13, dur: 7, src: null };
    expect(p.atkFor({ cat: 'phys' })).toBeCloseTo(p.atkFor({ cat: 'spec' }), 6);
  });

  test('sin categorías (la Defensa) o sin categoría en el golpe, todo cuenta como antes', () => {
    const p = stub(130, 60);
    p.cats = false;
    expect(p.atkFor({ cat: 'spec' })).toBe(p.atk);
    const q = stub(130, 60);
    expect(q.atkFor({})).toBe(q.atk);
  });

  test('la defensa baja o sube el daño recibido entre ×0,8 y ×1,25 y 72 es lo corriente', () => {
    expect(guardOf(72)).toBeCloseTo(1, 6);
    expect(guardOf(230)).toBe(0.8);
    expect(guardOf(5)).toBe(1.25);
    expect(guardOf(100)).toBeLessThan(1);
    expect(guardOf(45)).toBeGreaterThan(1);
  });
});

describe('movimiento inicial', () => {
  test('sin categorías es el de siempre; con ellas, uno del lado bueno si el de su tipo cae en el flojo', () => {
    const gyarados = G.DEX_BY[130];     // Agua/Volador, Ataque 125 y At. Esp. 60
    expect(Moves.startFor(gyarados)).toBe('water-gun');
    expect(Moves.BY_ID[Moves.startFor(gyarados, true)].cat).toBe('phys');
    const gengar = G.DEX_BY[94];        // Bola Sombra (especial) le va bien
    expect(Moves.startFor(gengar, true)).toBe(Moves.startFor(gengar));
  });

  test('sin número de Pokédex no cambia nada (la Defensa pide el inicial de un tipo suelto)', () => {
    expect(Moves.startFor({ types: ['water'] }, true)).toBe('water-gun');
  });
});

describe('potenciadores que se pisan', () => {
  test('Armadura Frágil (+20 %, 1 carga) no rebaja una Agilidad cargada; si no hay nada mejor, sí se pone', () => {
    const p = stub(100, 100);
    (p.buffs as Record<string, unknown>).spd = { n: 3, t: 4, amount: 0.15, dur: 6, src: 'agility' };
    p.addBuff('spd', 0.2, 3, 1);
    expect(p.buffs.spd).toMatchObject({ n: 3, amount: 0.15, src: 'agility' });
    p.buffs.spd!.t = 0; p.buffs.spd!.n = 0;
    p.addBuff('spd', 0.2, 3, 1);
    expect(p.buffs.spd).toMatchObject({ n: 1, amount: 0.2 });
  });
});
