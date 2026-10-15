/* ============ fix-combat.test.ts — arreglos de combate (sanadores, escudos, revivir, rareza...) ============
 *   bun test tests/fix-combat.test.ts
 * Prueba la lógica con el resto del juego simulado (G a medias), sin navegador.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { G } from '../src/g';
import '../src/core/util';
import '../src/data/pokedex';
import { Enemy } from '../src/entities/enemy';
import { Player } from '../src/entities/player';
import '../src/systems/gacha';

const saved: Record<string, any> = {};
let field: any[] = [];
let queryOrig: any;
beforeAll(() => {
  for (const k of ['Game', 'FX', 'Coop', 'Camera', 'Audio', 'Sprites', 'Projectiles']) saved[k] = G[k];
  G.Game = { everyone: () => [{ atk: 1, baseAtk: 1 }] };
  G.FX = { burst() {}, ring() {}, dmgText() {} };
  G.Coop = { isHost: false };
  G.Camera = { sees: () => false, kick() {} };
  G.Audio = { sfx() {} };
  G.Projectiles = { clearOrbs() {} };
  G.Sprites = { hasShiny: () => false, Animator: class { _start() {} play() {} }, bodyRadius: (dex: number) => (dex === 146 ? 35 : dex === 25 ? 6 : 14), bodyHeight: () => 40 };
  queryOrig = G.EnemyMgr.queryCircle;
  G.EnemyMgr.queryCircle = (x: number, y: number, r: number) => field.filter(e => Math.hypot(e.x - x, e.y - y) <= r);
});
afterAll(() => {
  for (const k in saved) G[k] = saved[k];
  G.EnemyMgr.queryCircle = queryOrig;
});

const anim = { play() {} };
const healer = (x = 0, y = 0) => Object.assign(Object.create(Enemy.prototype), { x, y, anim, behavior: 'healer', hp: 100, maxHp: 100, healT: 0, bodyH: 30, dead: false });
const mob = (x = 20, y = 0, extra: any = {}) => ({ x, y, hp: 10, maxHp: 100, healT: 0, shieldCd: 0, shield: 0, shieldT: 0, behavior: 'chase', boss: false, dead: false, bodyH: 30, ...extra });

/** Vida que recupera por segundo (en % de su máximo) un enemigo herido rodeado de N curanderos, durante 60 s. */
function healRate(n: number, legacy = false) {
  const hs = Array.from({ length: n }, (_, i) => healer(Math.cos(i) * 40, Math.sin(i) * 40));
  const target = mob(10, 10);
  field = [...hs, target];
  const cd = hs.map((_, i) => 0.3 + (3.5 * i) / n);       // recargas escalonadas, como al azar
  const dt = 1 / 60;
  let healed = 0;
  for (let t = 0; t < 60; t += dt) {
    if (target.healT > 0) target.healT -= dt;
    hs.forEach((h, i) => {
      if ((cd[i] -= dt) > 0) return;
      cd[i] = 3.5;
      const before = target.hp;
      if (legacy) legacyHeal(h); else (Enemy.prototype as any).healAround.call(h);
      healed += target.hp - before;
    });
    target.hp = 10;
  }
  return (healed / target.maxHp / 60) * 100;
}

/** Cómo curaba antes: a todos en 150 px, incluidos los curanderos y los jefes, sin tope por objetivo. */
function legacyHeal(h: any) {
  for (const e of field) {
    if (Math.hypot(e.x - h.x, e.y - h.y) > 150 || e.dead || e.hp >= e.maxHp) continue;
    e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.07);
  }
}

describe('curanderos', () => {
  test('antes: N curanderos curaban N veces (la prueba sí lo ve)', () => {
    expect(healRate(8, true)).toBeGreaterThan(healRate(1, true) * 6);
  });

  test('ahora: 8 curanderos juntos no curan a un enemigo más que 1 (±1 pulso)', () => {
    const one = healRate(1), eight = healRate(8), twenty = healRate(20);
    expect(one).toBeGreaterThan(1.5);                       // 7 % cada 3,5 s ≈ 2 %/s: uno solo sigue sirviendo
    expect(eight).toBeLessThan(one * 1.25);
    expect(twenty).toBeLessThan(one * 1.25);
  });

  test('no se curan entre sí, ni a sí mismos, ni a los jefes', () => {
    const a = healer(0, 0), b = healer(30, 0), boss = mob(20, 20, { boss: true });
    a.hp = 10; b.hp = 10;
    field = [a, b, boss];
    (Enemy.prototype as any).healAround.call(a);
    (Enemy.prototype as any).healAround.call(b);
    expect(a.hp).toBe(10);
    expect(b.hp).toBe(10);
    expect(boss.hp).toBe(10);
  });

  test('un enemigo curado no vuelve a curarse hasta que acaba su enfriamiento', () => {
    const h1 = healer(0, 0), h2 = healer(30, 0), m = mob();
    field = [h1, h2, m];
    (Enemy.prototype as any).healAround.call(h1);
    const after1 = m.hp;
    expect(after1).toBeGreaterThan(10);
    (Enemy.prototype as any).healAround.call(h2);
    expect(m.hp).toBe(after1);
    m.healT = 0;
    (Enemy.prototype as any).healAround.call(h2);
    expect(m.hp).toBeGreaterThan(after1);
  });
});

describe('escudadores', () => {
  const shielder = (x = 0, y = 0) => Object.assign(Object.create(Enemy.prototype), { x, y, anim, behavior: 'shielder', maxHp: 100, shield: 0, shieldT: 0, shieldCd: 0, dead: false });

  test('no dan escudo a otros escudadores ni a jefes, y sí al resto', () => {
    const a = shielder(), b = shielder(30, 0), boss = mob(10, 10, { boss: true }), m = mob(20, 0);
    field = [a, b, boss, m];
    (Enemy.prototype as any).castShields.call(a);
    expect(b.shield).toBe(0);
    expect(boss.shield).toBe(0);
    expect(m.shield).toBe(35);
  });

  test('varios escudadores no rehacen el escudo roto antes del enfriamiento', () => {
    const a = shielder(), b = shielder(30, 0), m = mob(20, 0);
    field = [a, b, m];
    (Enemy.prototype as any).castShields.call(a);
    m.shield = 0;                                            // se lo rompen
    (Enemy.prototype as any).castShields.call(b);
    expect(m.shield).toBe(0);
    m.shieldCd = 0;
    (Enemy.prototype as any).castShields.call(b);
    expect(m.shield).toBe(35);
  });
});

describe('jugador', () => {
  test('radio de colisión acotado; el visual sigue el sprite', () => {
    const big = new Player({ dex: 146, hp: 100, spd: 100, atk: 1, types: ['fire'] } as any);
    const mid = new Player({ dex: 1, hp: 100, spd: 100, atk: 1, types: ['grass'] } as any);
    const tiny = new Player({ dex: 25, hp: 100, spd: 100, atk: 1, types: ['electric'] } as any);
    expect(big.visR).toBe(35);
    expect(big.r).toBe(16);
    expect(mid.r).toBe(14);
    expect(tiny.r).toBe(10);
  });

  test('revivido: los golpes que ponen invuln = 0 (trampas, lava, Arceus) no lo matan', () => {
    const p = new Player({ dex: 1, hp: 100, spd: 100, atk: 1, types: ['grass'] } as any);
    p.hp = 0; p.dead = true;
    p.revive(0.1);
    expect(p.dead).toBe(false);
    const hp = p.hp;
    p.invuln = 0;                                            // lo que hacen hazards / interact / judgment / lava
    p.hurt(9999, null, true);
    expect(p.dead).toBe(false);
    expect(p.hp).toBe(hp);
    expect(p.reviveShield).toBeCloseTo(2);
    p.reviveShield = 0;                                      // pasan los 2 s (update lo gasta)
    p.invuln = 0;
    p.hurt(9999, null, true);
    expect(p.dead).toBe(true);
  });
});

describe('etiqueta de rareza', () => {
  test('sólo los legendarios de verdad son "Legendario"', () => {
    const L = (G as any).Gacha.rarityLabel;
    expect(L(5, 445)).toBe('Élite');          // Garchomp (pseudolegendario)
    expect(L(5, 149)).toBe('Élite');          // Dragonite
    expect(L(5, 150)).toBe('Legendario');     // Mewtwo
    expect(L(5, 144)).toBe('Legendario');     // Articuno
    expect(L(4, 6)).toBe('Épica');
    expect(L(1)).toBe('Común');
  });
});
