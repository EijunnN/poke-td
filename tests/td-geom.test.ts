/* ============ td-geom.test.ts — apuntar y colocar torres en el modo Defensa ============
 *   bun test tests/td-geom.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { leadAngle, distToPath, placementError, moveRange, PATH_CLEAR, TOWER_GAP } from '../src/modes/td-geom';
import { MAPS, mapById, randomMap, distToSegment, pathLengths, ENDS_CLEAR } from '../src/modes/td-geom';

/** Simula el disparo: ¿pasa el proyectil a menos de `hit` del blanco en algún momento? */
function hits(sx: number, sy: number, tx: number, ty: number, vx: number, vy: number, speed: number, ang: number, hit = 12, life = 3) {
  const dt = 1 / 120;
  let px = sx, py = sy, ex = tx, ey = ty;
  for (let t = 0; t < life; t += dt) {
    px += Math.cos(ang) * speed * dt; py += Math.sin(ang) * speed * dt;
    ex += vx * dt; ey += vy * dt;
    if (Math.hypot(px - ex, py - ey) < hit) return true;
  }
  return false;
}

describe('apuntar a donde va a estar el enemigo', () => {
  test('a un blanco quieto se apunta de frente', () => {
    expect(leadAngle(0, 0, 100, 0, 0, 0, 300)).toBeCloseTo(0);
    expect(leadAngle(0, 0, 0, -50, 0, 0, 300)).toBeCloseTo(-Math.PI / 2);
  });

  test('apuntar a donde está falla con enemigos rápidos; adelantarse acierta (500 casos al azar)', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let direct = 0, lead = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      const tx = (rnd() - 0.5) * 800, ty = (rnd() - 0.5) * 800;
      const a = rnd() * Math.PI * 2, sp = 60 + rnd() * 120;          // como un enemigo del camino
      const vx = Math.cos(a) * sp, vy = Math.sin(a) * sp, speed = 260 + rnd() * 200;
      if (hits(0, 0, tx, ty, vx, vy, speed, Math.atan2(ty, tx))) direct++;
      if (hits(0, 0, tx, ty, vx, vy, speed, leadAngle(0, 0, tx, ty, vx, vy, speed))) lead++;
    }
    expect(lead).toBeGreaterThan(N * 0.98);
    expect(lead).toBeGreaterThan(direct + N * 0.3);                     // la diferencia es grande, no un detalle
  });

  test('si no se le puede alcanzar (va más deprisa y se aleja), apunta a donde está', () => {
    expect(leadAngle(0, 0, 100, 0, 500, 0, 300)).toBeCloseTo(0);
    expect(leadAngle(0, 0, 100, 0, 0, 0, 0)).toBeCloseTo(0);
  });

  test('datos raros no rompen el cálculo', () => {
    for (const args of [[0, 0, 0, 0, 0, 0, 300], [0, 0, 1e9, 1e9, 1e5, -1e5, 300], [0, 0, 10, 10, NaN, 0, 300], [0, 0, 10, 10, 300, 0, 300]] as const) {
      expect(Number.isFinite(leadAngle(...args))).toBe(true);
    }
  });
});

describe('dónde se puede plantar una torre', () => {
  const path = [{ x: -600, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 400 }];
  const base = { path, towers: [] as { x: number; y: number }[], bound: 700 };

  test('distancia al camino', () => {
    expect(distToPath(-300, 50, path)).toBeCloseTo(50);
    expect(distToPath(80, 200, path)).toBeCloseTo(80);
    expect(distToPath(30, -40, path)).toBeCloseTo(50);
  });

  test('junto al camino, sí; encima, no', () => {
    expect(placementError(-300, PATH_CLEAR + 10, base)).toBe('');
    expect(placementError(-300, PATH_CLEAR - 1, base)).toBe('Encima del camino');
    expect(placementError(-300, 0, base)).toBe('Encima del camino');
  });

  test('no pegada a otra torre', () => {
    const o = { ...base, towers: [{ x: -300, y: 100 }] };
    expect(placementError(-300 + TOWER_GAP - 1, 100, o)).toBe('Pegada a otra torre');
    expect(placementError(-300 + TOWER_GAP + 1, 100, o)).toBe('');
  });

  test('ni fuera del mapa, ni en la entrada ni en la base, ni con coordenadas rotas', () => {
    expect(placementError(800, 0, base)).toBe('Fuera del mapa');
    expect(placementError(NaN, 0, base)).toBe('Fuera del mapa');
    expect(placementError(-600, 50, base)).toBe('Demasiado cerca de la entrada o de la base');
    expect(placementError(50, 400, base)).toBe('Demasiado cerca de la entrada o de la base');
  });
});

describe('alcance de cada familia de movimiento', () => {
  test('igual que el criterio del combate', () => {
    expect(moveRange({ kind: 'melee', radius: 40 })).toBe(70);
    expect(moveRange({ kind: 'beam', radius: 200 })).toBe(220);
    expect(moveRange({ kind: 'chain' })).toBe(280);
    expect(moveRange({ kind: 'projectile', speed: 400, life: 0.8 })).toBe(320);
    expect(moveRange({ kind: 'projectile', speed: 400, life: 5 })).toBe(520);
    expect(moveRange({ kind: 'buff' })).toBe(0);
    expect(moveRange({ kind: 'nova', radius: 90 })).toBe(90);
  });
});

describe('economía', () => {
  const { towerCost, upgradeCost, sellValue, killReward, waveBonus, MAX_LEVEL, START_MONEY, evolvesAt } = require('../src/modes/td-geom');

  test('precios por rareza, y rarezas raras se acotan', () => {
    expect([1, 2, 3, 4, 5].map(towerCost)).toEqual([60, 90, 120, 150, 180]);
    expect(towerCost(0)).toBe(60);
    expect(towerCost(99)).toBe(180);
    expect(towerCost(NaN)).toBe(60);
    expect(START_MONEY).toBeGreaterThanOrEqual(towerCost(1) * 2);       // al empezar te llega para dos torres baratas
  });

  test('cada mejora cuesta más que la anterior, y al máximo no hay más', () => {
    const c = [1, 2, 3, 4].map(l => upgradeCost(120, l)!);
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThan(c[i - 1]);
    expect(c.every(x => x % 5 === 0)).toBe(true);
    expect(upgradeCost(120, MAX_LEVEL)).toBeNull();
    expect(upgradeCost(120, MAX_LEVEL + 3)).toBeNull();
  });

  test('vender nunca devuelve más de lo gastado', () => {
    for (const spent of [0, 1, 60, 121, 999]) {
      expect(sellValue(spent)).toBeLessThanOrEqual(spent);
      expect(sellValue(spent)).toBeGreaterThanOrEqual(0);
    }
    // Comprar y vender en bucle siempre pierde dinero.
    let money = 500;
    for (let i = 0; i < 20; i++) { money -= towerCost(3); money += sellValue(towerCost(3)); }
    expect(money).toBeLessThan(500);
  });

  test('las recompensas crecen con las oleadas y adelantarse da extra', () => {
    expect(killReward(10)).toBeGreaterThan(killReward(1));
    expect(killReward(5, true)).toBe(killReward(5) * 10);
    expect(waveBonus(3, 10)).toBe(waveBonus(3) + 20);
    expect(waveBonus(3, -50)).toBe(waveBonus(3));
  });

  test('evoluciona en los niveles 3 y 5', () => {
    expect([1, 2, 3, 4, 5].filter(evolvesAt)).toEqual([3, 5]);
  });
});

describe('el camino', () => {
  const { pathLengths, pathProgress, stepBack } = require('../src/modes/td-geom');
  const path = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  const lens = pathLengths(path);

  test('medidas y avance', () => {
    expect(lens).toEqual([0, 100, 200]);
    expect(pathProgress(50, 0, 1, path, lens)).toBeCloseTo(50);
    expect(pathProgress(100, 30, 2, path, lens)).toBeCloseTo(130);
    // Quien va más adelantado tiene más avance, aunque esté más lejos en línea recta del inicio.
    expect(pathProgress(100, 90, 2, path, lens)).toBeGreaterThan(pathProgress(90, 0, 1, path, lens));
    // Índices raros no rompen nada.
    expect(Number.isFinite(pathProgress(0, 0, 99, path, lens))).toBe(true);
    expect(Number.isFinite(pathProgress(0, 0, -3, path, lens))).toBe(true);
  });

  test('retroceder por el camino, doblando esquinas, y nunca antes de la entrada', () => {
    expect(stepBack(100, 50, 2, 20, path)).toEqual({ x: 100, y: 30, wp: 2 });
    const b = stepBack(100, 20, 2, 50, path);
    expect(b.wp).toBe(1); expect(b.x).toBeCloseTo(70); expect(b.y).toBeCloseTo(0);
    const c = stepBack(30, 0, 1, 500, path);
    expect(c).toEqual({ x: 0, y: 0, wp: 1 });
  });
});

describe('a quién ataca una torre', () => {
  const { pickTarget } = require('../src/modes/td-geom');
  const list = [
    { d2: 900, progress: 300, hp: 50 },
    { d2: 100, progress: 120, hp: 400 },
    { d2: 400, progress: 40, hp: 10 },
  ];
  test('cada modo elige al suyo', () => {
    expect(pickTarget(list, 'first')).toBe(0);
    expect(pickTarget(list, 'last')).toBe(2);
    expect(pickTarget(list, 'strong')).toBe(1);
    expect(pickTarget(list, 'near')).toBe(1);
    expect(pickTarget([], 'first')).toBe(-1);
  });
});

describe('el poder de cada tipo', () => {
  const { ROLES, roleHit } = require('../src/modes/td-geom');
  const base = { hp: 100, maxHp: 100, boss: false, flying: false, cursed: false };
  const always = () => 0, never = () => 0.999;

  test('los 18 tipos tienen poder, con nombre y explicación', () => {
    const TYPES = ['normal', 'fire', 'water', 'grass', 'electric', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];
    for (const t of TYPES) { expect(ROLES[t]).toBeDefined(); expect(ROLES[t].name.length).toBeGreaterThan(2); expect(ROLES[t].desc.length).toBeGreaterThan(5); }
  });

  test('multiplicadores según el blanco', () => {
    expect(roleHit('normal', base, never).mul).toBeCloseTo(1.15);
    expect(roleHit('flying', { ...base, flying: true }, never).mul).toBeCloseTo(1.3);
    expect(roleHit('flying', base, never).mul).toBe(1);
    expect(roleHit('steel', { ...base, boss: true }, never).mul).toBeCloseTo(1.4);
    expect(roleHit('dark', { ...base, hp: 20 }, never).mul).toBe(2);
    expect(roleHit('dark', base, never).mul).toBe(1);
    expect(roleHit('fire', { ...base, cursed: true }, never).mul).toBeCloseTo(1.2);
    const c = roleHit('fighting', base, always);
    expect(c.crit).toBe(true); expect(c.mul).toBeCloseTo(1.8);
  });

  test('los efectos con suerte salen con suerte, y a los jefes les afectan la mitad', () => {
    expect(roleHit('electric', base, never).stun).toBe(0);
    expect(roleHit('electric', base, always).stun).toBeGreaterThan(0);
    expect(roleHit('electric', { ...base, boss: true }, always).stun).toBeCloseTo(roleHit('electric', base, always).stun / 2);
    expect(roleHit('psychic', base, always).confuse).toBeGreaterThan(0);
    expect(roleHit('water', base, always).push).toBeGreaterThan(0);
    // Un tipo desconocido no hace nada raro.
    expect(roleHit('???', base, always)).toEqual({ mul: 1, crit: false, stun: 0, confuse: 0, push: 0 });
  });
});

describe('Pokémon de apoyo', () => {
  const { aurasAt, auraStrength, auraRadius, SUPPORT, AURAS, AURA_KINDS } = require('../src/modes/td-geom');
  const { DEX } = require('../src/data/pokedex');
  const { EVOLUTIONS } = require('../src/data/evolutions');

  test('cada aura crece con el nivel, y fuera de rango no revienta', () => {
    for (const k of AURA_KINDS) {
      for (let l = 2; l <= 5; l++) expect(auraStrength(k, l)).toBeGreaterThan(auraStrength(k, l - 1));
      expect(auraStrength(k, 0)).toBe(auraStrength(k, 1));
      expect(auraStrength(k, 99)).toBe(auraStrength(k, 5));
    }
    expect(auraRadius(5)).toBeGreaterThan(auraRadius(1));
  });

  test('las auras no se suman: cuenta la más fuerte de cada clase', () => {
    const s = [
      { x: 0, y: 0, kind: 'dmg', level: 1 }, { x: 10, y: 0, kind: 'dmg', level: 3 },
      { x: 0, y: 10, kind: 'haste', level: 1 }, { x: 5000, y: 0, kind: 'crit', level: 5 },
    ];
    const a = aurasAt(0, 0, s);
    expect(a.dmg).toBe(auraStrength('dmg', 3));
    expect(a.haste).toBe(auraStrength('haste', 1));
    expect(a.crit).toBe(0);                           // demasiado lejos
    expect(aurasAt(0, 0, []).dmg).toBe(0);
    // Justo en el borde del radio, sí; un poco más allá, no.
    expect(aurasAt(auraRadius(1), 0, [{ x: 0, y: 0, kind: 'range', level: 1 }]).range).toBeGreaterThan(0);
    expect(aurasAt(auraRadius(1) + 1, 0, [{ x: 0, y: 0, kind: 'range', level: 1 }]).range).toBe(0);
  });

  test('los de apoyo existen, y su familia entera da la misma aura (evolucionar no se la quita)', () => {
    const by = new Map(DEX.map((p: any) => [p.dex, p]));
    for (const d of Object.keys(SUPPORT).map(Number)) {
      if (!by.has(d)) continue;                       // (alguno puede no tener sprite todavía)
      for (const to of EVOLUTIONS[d] || []) if (by.has(to)) expect(SUPPORT[to]).toBe(SUPPORT[d]);
    }
    expect(Object.values(SUPPORT).every(k => AURAS[k as string])).toBe(true);
  });
});

describe('mapas', () => {
  const TS = 32, BOUND = 20 * TS, CLEAR = 24;          // como en modes/td.ts (tile de 32, claro de 24 tiles)
  const ptsOf = (m: typeof MAPS[number]) => m.route.map(([x, y]) => ({ x: x * TS, y: y * TS }));
  const lenOf = (m: typeof MAPS[number]) => { const l = pathLengths(ptsOf(m)); return l[l.length - 1]; };

  test('ids únicos, nombre en los dos idiomas, y mapById / randomMap', () => {
    expect(new Set(MAPS.map(m => m.id)).size).toBe(MAPS.length);
    expect(MAPS.length).toBeGreaterThanOrEqual(3);
    for (const m of MAPS) { expect(m.name.length).toBeGreaterThan(0); expect(m.en.length).toBeGreaterThan(0); }
    for (const m of MAPS) expect(mapById(m.id)).toBe(m);
    expect(mapById('nada')).toBe(MAPS[0]);
    expect(mapById(undefined)).toBe(MAPS[0]);
    const seen = new Set<string>();
    for (let i = 0; i < MAPS.length; i++) seen.add(randomMap(() => (i + 0.5) / MAPS.length).id);
    expect(seen.size).toBe(MAPS.length);
    expect(randomMap(() => 0.9999999).id).toBe(MAPS[MAPS.length - 1].id);
  });

  test.each(MAPS.map(m => [m.id, m] as const))('%s: cabe en el claro, y la entrada y la base quedan lejos', (_, m) => {
    for (const [x, y] of m.route) expect(Math.hypot(x, y)).toBeLessThanOrEqual(CLEAR - 0.5);
    const p = ptsOf(m), a = p[0], b = p[p.length - 1];
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(2 * ENDS_CLEAR + 200);
  });

  test.each(MAPS.map(m => [m.id, m] as const))('%s: los tramos que no se tocan quedan separados (cabe una torre entre ellos)', (_, m) => {
    const p = ptsOf(m);
    // Entre dos tramos no seguidos: los dos bordes del camino y sitio para una torre.
    const need = 2 * PATH_CLEAR + TOWER_GAP;
    for (let i = 0; i + 1 < p.length; i++) {
      for (let j = i + 2; j + 1 < p.length; j++) {
        // Distancia mínima entre los dos segmentos (por sus puntos y muestras).
        let d = Infinity;
        for (let k = 0; k <= 20; k++) {
          const t = k / 20;
          d = Math.min(d, distToSegment(p[i].x + (p[i + 1].x - p[i].x) * t, p[i].y + (p[i + 1].y - p[i].y) * t, p[j], p[j + 1]));
          d = Math.min(d, distToSegment(p[j].x + (p[j + 1].x - p[j].x) * t, p[j].y + (p[j + 1].y - p[j].y) * t, p[i], p[i + 1]));
        }
        expect([i, j, Math.round(d)]).toEqual([i, j, Math.max(Math.round(d), need)]);
      }
    }
  });

  test('todos miden parecido (la dificultad y el ranking valen para cualquiera)', () => {
    const base = lenOf(MAPS[0]);
    for (const m of MAPS) expect([m.id, Math.abs(lenOf(m) / base - 1) < 0.35]).toEqual([m.id, true]);
  });

  test.each(MAPS.map(m => [m.id, m] as const))('%s: hay sitio de sobra para construir junto al camino', (_, m) => {
    const path = ptsOf(m);
    let ok = 0;
    for (let x = -BOUND; x <= BOUND; x += TS) {
      for (let y = -BOUND; y <= BOUND; y += TS) {
        if (distToPath(x, y, path) > 160) continue;         // al alcance del camino
        if (!placementError(x, y, { path, towers: [], bound: BOUND })) ok++;
      }
    }
    expect(ok).toBeGreaterThan(120);
  });
});
