import { G } from '../g';
import type { PokeType } from '../data/types';
import type { Player } from './player';
/* ============ enemy.js — Pokémon salvajes y su gestor ============
 * (x, y) son los PIES. Animaciones de Mundo Misterioso:
 *   Walk al moverse · Idle parado · Charge apuntando una embestida ·
 *   Attack al embestir o al golpearte · Shoot al disparar · Hurt al recibir ·
 *   Faint al caer (se queda en el suelo y se desvanece).
 *
 * Los voladores, los fantasma y los jefes ignoran el terreno. El resto choca
 * con paredes y objetos, va más lento en el agua y se quema en la lava.
 *
 * El gestor mantiene una rejilla espacial (reconstruida cada frame) para la
 * separación entre enemigos y las colisiones de proyectiles.
 */
/** Definición de un enemigo (data/enemies.ts, o la que arma el invocador / el anfitrión). */
interface EnemyDef {
  dex: number;
  name?: string;
  hp: number;
  spd: number;
  dmg: number;
  xp: number;
  behavior: string;
  shotCd?: number;
  shotDmg?: number;
  range?: number;
  fanN?: number;
  zones?: number;
  minion?: number;
  loot?: string;
}
/** Escala de la run aplicada a las estadísticas base. */
interface EnemyScale { hp: number; spd: number; dmg: number }
/** A quien persigue: el jugador local o un compañero. */
interface EnemyTarget {
  x: number; y: number;
  r?: number;
  level?: number;
  dead?: boolean;
  kills?: number;
  bosses?: number;
  _vx?: number; _vy?: number;       // velocidad suavizada (la calcula EnemyMgr.update)
  _px?: number; _py?: number;       // posición del frame anterior
}
/** Lo que devuelve World.liquidEffect: según el líquido, frena (slow) o quema (dmg cada `every` s); {} si es inmune. */
interface LiquidEffect { dmg?: number; every?: number; color?: string; slow?: number }
/** Los jugadores que EnemyMgr.update sigue (con la velocidad suavizada que calcula él). */
type Tracked = Player & { _vx?: number; _vy?: number; _px?: number; _py?: number };
/** Salto: { sx, sy, tx, ty, t, dur } */
interface EnemyJump { sx: number; sy: number; tx: number; ty: number; t: number; dur: number }
/** Ataque de jefe en curso. */
interface BossCast {
  id: string; t: number; wind: number; after: number; ang: number;
  len?: number; dur?: number; go?: boolean; fired?: boolean;
}
interface BossAI {
  melee: string[]; ranged: string[];
  farLike: number;
  mode: 'far' | 'close'; modeT: number;
  cd: number;
  cast: BossCast | null;
  fury: boolean;
  side: number;
}
/** Última posición recibida del anfitrión (copias cooperativas). */
interface EnemyNet { x: number; y: number; vx: number; vy: number; age: number; dir: number; anim: number; st: number }
/** Lo que se necesita para crear una copia remota (mensaje del anfitrión). */
interface RemoteEnemyInfo {
  id: number; dex: number; hp: number; dmg: number; x: number; y: number;
  beh?: string; boss?: boolean; shiny?: boolean;
}
type BossMove = [number, number, string];

let nextId = 1;
/** Segundos mínimos entre dos curaciones / dos escudos sobre el mismo enemigo (menos que la recarga del apoyo, para que uno solo no falle). */
const HEAL_CD = 3.2, SHIELD_CD = 5.5;
/** Los jefes se agrandan hasta ~110 de alto, según lo grande que ya sea su sprite. */
function bossScale(dex: number) {
  const m = G.Sprites.animMeta(dex, 'Idle');
  const h = (m ? m.ay : 30) * G.Sprites.PX;
  // En múltiplos de 0,5: con la cámara a ×2 cada píxel de arte ocupa un
  // número entero de píxeles de pantalla (escalas como 1,37 lo deforman).
  return G.U.clamp(Math.round(110 / h * 2) / 2, 1, 2);
}

export class Enemy {
  declare id: number;
  declare def: EnemyDef;
  declare dex: number;
  declare name: string;
  declare x: number;
  declare y: number;
  declare boss: boolean;
  declare scale: number;
  declare anim: InstanceType<typeof G.Sprites.Animator>;
  declare r: number;
  declare bodyH: number;
  declare maxHp: number;
  declare hp: number;
  declare spd: number;
  declare dmg: number;
  declare xp: number;
  declare behavior: string;
  declare types: PokeType[];
  declare atkType: PokeType;
  declare flying: boolean;
  declare flash: number;
  declare slow: number;
  declare slowT: number;
  declare burn: number;
  declare burnT: number;
  declare burnTick: number;
  declare poison: number;
  declare poisonT: number;
  declare poisonTick: number;
  declare lavaTick: number;
  /**
   * La animación de herido sólo con golpes de al menos esta parte de su vida (o críticos). En las
   * hordas, 0: siempre. En la Defensa le pegan muchas torres a la vez y parecía que retrocedía (modes/td.ts).
   */
  hurtAnimMin = 0;
  declare kx: number;
  declare ky: number;
  declare touchCd: number;
  declare dead: boolean;
  declare fade: number;
  declare phase: 'walk' | 'aim' | 'dash' | 'fuse';
  declare pt: number;
  declare dx: number;
  declare dy: number;
  declare shotCd: number;
  declare stuckT: number;
  declare sideT: number;
  declare side: number;
  declare bob: number;
  declare shiny: boolean;
  declare sparkT: number;
  declare sc: EnemyScale;
  declare shield: number;
  declare shieldT: number;
  declare shieldCd: number;           // hasta entonces no recibe otro escudo
  declare healT: number;              // hasta entonces no recibe otra curación
  declare skillCd: number;
  declare minions: Enemy[];
  declare jump: EnemyJump | null;
  declare lagT: number;
  // Se añaden más tarde (o sólo a algunos enemigos):
  declare golden?: boolean;           // hora dorada (makeGolden)
  declare remote?: boolean;           // copia de un enemigo del anfitrión
  /** Estados propios de un modo para el cooperativo (net/coop.ts los manda en los bits 3+ del estado). */
  declare netBits?: () => number;
  declare net?: EnemyNet;             // última posición recibida (copias)
  declare lastNetAnim?: number;
  declare ai?: BossAI;                // IA de jefe (bossInit)
  declare judge?: boolean;            // Sentencia de Arceus (judgment.ts)
  declare legend?: boolean;           // legendario de la grieta (rift.ts)
  declare life?: number;              // duende del tesoro: segundos antes de escapar (events.ts)
  declare zig?: number;
  declare jumpLift?: number;

  constructor(def: EnemyDef, x: number, y: number, sc: EnemyScale, boss = false) {
    this.id = nextId++;
    this.def = def;
    this.dex = def.dex;
    this.name = (G.DEX_BY[def.dex] && G.DEX_BY[def.dex].name) || def.name!;
    this.x = x; this.y = y;
    this.boss = boss;
    this.scale = boss ? bossScale(def.dex) : 1;
    this.anim = new G.Sprites.Animator(def.dex, this.scale);
    this.r = G.Sprites.bodyRadius(def.dex, this.scale);
    this.bodyH = G.Sprites.bodyHeight(def.dex, this.scale);

    this.maxHp = Math.round(def.hp * sc.hp);
    this.hp = this.maxHp;
    this.spd = def.spd * sc.spd;
    this.dmg = def.dmg * sc.dmg;
    this.xp = def.xp;
    this.behavior = def.behavior;

    const types = (G.DEX_BY[def.dex] && G.DEX_BY[def.dex].types) || [];
    this.types = types.length ? types : ['normal'];
    this.atkType = this.types[0];         // tipo de sus golpes (tabla de tipos)
    // Vuelan por encima de rocas y agua sólo los que FLOTAN en su sprite (un
    // Rowlet camina aunque sea Volador). Los jefes, por su tamaño, también.
    this.flying = boss || G.Sprites.hovers(def.dex);

    this.flash = 0;
    this.slow = 0; this.slowT = 0;
    this.burn = 0; this.burnT = 0; this.burnTick = 0;
    this.poison = 0; this.poisonT = 0; this.poisonTick = 0;
    this.lavaTick = 0;
    this.kx = 0; this.ky = 0;
    this.touchCd = 0;
    this.dead = false;
    this.fade = 0;             // tiempo de desvanecimiento tras caer

    // embestida
    this.phase = 'walk'; this.pt = 0; this.dx = 0; this.dy = 0;
    // distancia
    this.shotCd = def.shotCd ? G.U.rand(0.3, def.shotCd) : 0;
    // desatasco
    this.stuckT = 0; this.sideT = 0; this.side = 1;
    this.bob = Math.random() * 6.28;
    this.shiny = false;
    this.sparkT = 0;
    // personalidades
    this.sc = sc;                       // escala de la run (para sus invocaciones)
    this.shield = 0; this.shieldT = 0;  // escudo que absorbe daño
    this.shieldCd = 0; this.healT = 0;  // enfriamientos por objetivo: varios apoyos no se suman
    this.skillCd = G.U.rand(1, 4);      // escudos / saltos
    this.minions = [];
    this.jump = null;                   // { sx, sy, tx, ty, t, dur }
    // Rezagados: si se quedan atrás, fuera de la vista, mientras huyes,
    // vuelven a salir por delante (ver EnemyMgr.update).
    this.lagT = 0;
  }

  cy() { return this.y; }

  /** Lo convierte en shiny: otro sprite, más aguante y mucha más XP. */
  makeShiny() {
    this.shiny = true;
    this.anim = new G.Sprites.Animator(this.dex, this.scale, true);
    this.maxHp *= 2; this.hp = this.maxHp;
    this.xp *= 5;
    G.Sprites.preload([this.dex], 4000, true);
  }

  /** Hora dorada (events.js): doble de experiencia y a veces monedas. */
  makeGolden() {
    if (this.golden || this.boss || this.behavior === 'thief') return;
    this.golden = true;
    this.xp *= 2;
  }

  /** @param eff  'super' | 'weak' | null (tabla de tipos, sólo para enseñarlo) */
  hurt(amount: number, color = '#fff', dirX = 0, dirY = 0, knock = 0, eff: string | null = null) {
    if (this.dead) return;
    const d = Math.max(1, Math.round(amount));
    // Copia de un enemigo del anfitrión: el golpe se le manda a él, que es
    // quien decide si cae. Aquí sólo se ve (número, destello y animación).
    if (this.remote) {
      G.Coop.hit(this, d, color, dirX, dirY, knock);
      this.hp = Math.max(1, this.hp - d);
      this.showHurt(d, color, dirX, dirY, eff);
      return;
    }
    // Escudo: absorbe primero.
    if (this.shield > 0) {
      const a = Math.min(this.shield, d);
      this.shield -= a;
      if (a >= d) { G.FX.dmgText(this.x, this.y - this.bodyH - 4, d, '#9fd8ff'); this.flash = 0.05; return; }
      amount = d - a;
    }
    this.hp -= Math.max(1, Math.round(amount));
    G.Judgment.noteDmg(amount, this);
    this.showHurt(d, color, dirX, dirY, eff);
    if (knock > 0 && !this.boss) {
      const [nx, ny] = G.U.norm(dirX, dirY);
      this.kx += nx * knock;
      this.ky += ny * knock;
    }
    if (G.Coop.isHost) G.Coop.hurtShown(this, d, color);
    if (this.hp <= 0) this.die();
  }

  /** Lo que se VE al recibir un golpe. */
  showHurt(d: number, color: string, dirX = 0, dirY = 0, eff: string | null = null) {
    this.flash = 0.09;
    // Muy eficaz: número amarillo y grande. Poco eficaz: gris. Crítico: naranja y grande.
    G.FX.dmgText(this.x, this.y - this.bodyH - 4, d, eff === 'crit' ? '#ff9a3c' : eff === 'super' ? '#ffe14d' : eff === 'weak' ? '#a3abb8' : color,
                 this.boss || eff === 'super' || eff === 'crit');
    G.FX.spark(this.x, this.y - this.bodyH * 0.5, color, dirX, dirY, 3);
    if (!this.anim.busy() && this.phase !== 'dash' && (d >= this.maxHp * this.hurtAnimMin || eff === 'crit')) this.anim.play('Hurt');
    G.Audio.sfx('hit');
  }

  applySlow(factor: number, dur = 1.2) {
    if (this.remote) { G.Coop.status(this, 's', factor); return; }
    this.slow = Math.max(this.slow, factor);
    this.slowT = Math.max(this.slowT, dur);
  }
  applyBurn(stacks = 1) {
    if (this.remote) { G.Coop.status(this, 'b', stacks); return; }
    this.burn = Math.min(8, this.burn + stacks); this.burnT = 3;
  }
  applyPoison(stacks = 1) {
    if (this.remote) { G.Coop.status(this, 'p', stacks); return; }
    this.poison = Math.min(8, this.poison + stacks); this.poisonT = 4;
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.fade = 0.9;
    this.anim.play('Faint', { hold: true });
    const col = this.boss ? '#ffd95e' : '#ffffff';
    const cy = this.y - this.bodyH * 0.5;
    G.FX.burst(this.x, cy, col, this.boss ? 34 : 9, this.boss ? 260 : 120);
    G.FX.ring(this.x, this.y, this.r, this.r * (this.boss ? 6 : 2.6), col, this.boss ? 0.6 : 0.3, this.boss ? 6 : 3);
    // En una copia, el botín y los shinies los reparte el anfitrión.
    if (this.remote) {
      if (this.boss) G.Camera.kick(0.9);
      G.Audio.sfx(this.boss ? 'bossDown' : 'faint');
      if (this.shiny) { G.FX.burst(this.x, cy, '#ffe9a0', 30, 220); G.FX.ring(this.x, this.y, this.r, this.r * 7, '#9ae6ff', 0.7, 5); }
      return;
    }
    // (Los legendarios de la Sentencia de Arceus sólo dan experiencia.)
    if (this.boss && !this.judge) {
      G.Camera.kick(0.9);
      for (let i = 0; i < 10; i++) G.Pickups.drop('coin', this.x + G.U.rand(-40, 40), this.y + G.U.rand(-30, 30), 5);
      // Los jefes siempre sueltan un objeto equipable.
      G.Pickups.drop('item', this.x - 26, this.y - 10, G.Items.roll());
    }
    // (Sin experiencia, nada: así son los de la Defensa.)
    if (this.xp > 0) G.Pickups.dropXp(this.x, this.y, this.xp, this.boss, !!this.legend, !!this.judge);
    if (this.golden && Math.random() < 0.35) G.Pickups.drop('coin', this.x + 6, this.y - 4, 3);
    // Duende del tesoro: Meowth suelta monedas; Gholdengo, un ticket ×10.
    if (this.behavior === 'thief') {
      const n = this.def.loot === 'ticket10' ? 6 : 20;
      for (let i = 0; i < n; i++) G.Pickups.drop('coin', this.x + G.U.rand(-36, 36), this.y + G.U.rand(-26, 26), 5);
      if (this.def.loot === 'ticket10') G.Pickups.drop('ticket10', this.x, this.y - 12, 1);
      G.FX.ring(this.x, this.y, this.r, this.r * 5, '#ffd23f', 0.6, 4);
    }
    if (this.legend) {
      // El legendario de la grieta: tickets sueltos y monedas (el ×10, como
      // la mitad de las veces; antes daba 2 siempre).
      for (let i = 0; i < 3; i++) G.Pickups.drop('ticket', this.x + G.U.rand(-30, 30), this.y + G.U.rand(-20, 20), 1);
      for (let i = 0; i < 10; i++) G.Pickups.drop('coin', this.x + G.U.rand(-50, 50), this.y + G.U.rand(-35, 35), 8);
    }
    G.Audio.sfx(this.boss ? 'bossDown' : 'faint');
    if (this.shiny) {
      G.FX.burst(this.x, cy, '#ffe9a0', 30, 220);
      G.FX.ring(this.x, this.y, this.r, this.r * 7, '#9ae6ff', 0.7, 5);
      if (G.onShinyCaught) G.onShinyCaught(this);
    }
  }

  /**
   * Copia de un enemigo del anfitrión: va hacia la última posición recibida
   * (más la velocidad estimada, para que no avance a saltos) y anima según
   * se mueva o según la animación que tenga en el anfitrión.
   */
  netUpdate(dt: number) {
    this.anim.update(dt);
    if (this.flash > 0) this.flash -= dt;
    if (this.dead) { this.fade -= dt; return; }
    if (this.touchCd > 0) this.touchCd -= dt;
    this.bob += dt * 6;
    if (this.shiny) {
      this.sparkT -= dt;
      if (this.sparkT <= 0) { this.sparkT = 0.22; G.FX.twinkle(this.x + G.U.rand(-this.r, this.r) * 1.2, this.y - G.U.rand(4, this.bodyH * 1.1)); }
    }
    const n = this.net;
    if (!n) return;
    // Se adelanta hasta 0,3 s (por TURN llegan 4 posiciones por segundo).
    const lead = Math.min(0.3, n.age);
    n.age += dt;
    const tx = n.x + n.vx * lead, ty = n.y + n.vy * lead;
    const ox = this.x, oy = this.y;
    if (G.U.dist2(this.x, this.y, tx, ty) > 160 * 160) { this.x = tx; this.y = ty; }
    else { this.x = G.U.damp(this.x, tx, 12, dt); this.y = G.U.damp(this.y, ty, 12, dt); }
    const vx = (this.x - ox) / (dt || 1), vy = (this.y - oy) / (dt || 1);
    const moving = Math.abs(vx) + Math.abs(vy) > 8;
    this.anim.dir = n.dir;
    // Animaciones de una vez (embestida, disparo...) que ha empezado el anfitrión.
    if (n.anim !== this.lastNetAnim) {
      this.lastNetAnim = n.anim;
      const a = G.Coop.ANIMS[n.anim];
      if (a && a !== 'Idle' && a !== 'Walk' && a !== 'Faint') this.anim.play(a, { speed: 1.4 });
    }
    this.anim.loop(moving ? 'Walk' : 'Idle');
  }

  update(dt: number, pl: EnemyTarget) {
    // Fuera de pantalla no hace falta animar (sí moverse y pensar).
    const seen = G.Camera.sees(this.x, this.y, 120);
    if (seen || this.dead) this.anim.update(dt);
    if (this.flash > 0) this.flash -= dt;
    if (this.dead) { this.fade -= dt; return; }
    if (this.shiny && seen) {
      this.sparkT -= dt;
      if (this.sparkT <= 0) {
        this.sparkT = 0.22;
        G.FX.twinkle(this.x + G.U.rand(-this.r, this.r) * 1.2, this.y - G.U.rand(4, this.bodyH * 1.1));
      }
    }
    if (this.touchCd > 0) this.touchCd -= dt;
    if (this.healT > 0) this.healT -= dt;
    if (this.shieldCd > 0) this.shieldCd -= dt;
    this.bob += dt * 6;

    // --- estados ---
    if (this.slowT > 0) { this.slowT -= dt; if (this.slowT <= 0) this.slow = 0; }
    if (this.burn > 0) {
      this.burnT -= dt; this.burnTick -= dt;
      if (this.burnTick <= 0) { this.burnTick = 0.5; this.hurt(1.6 * this.burn * (1 + pl.level! * 0.06), '#ff9a4d'); }
      if (this.burnT <= 0) this.burn = 0;
    }
    if (this.poison > 0) {
      this.poisonT -= dt; this.poisonTick -= dt;
      if (this.poisonTick <= 0) { this.poisonTick = 0.6; this.hurt(this.maxHp * 0.012 * this.poison + 1, '#d47cf0'); }
      if (this.poisonT <= 0) this.poison = 0;
    }
    if (this.dead) return;

    // --- terreno ---
    let terrainMul = 1;
    // (El legendario está en su casa: su arena no le afecta. Los de Arceus, tampoco.)
    if (!this.flying && !this.legend && !this.judge && G.World.isLiquid(this.x, this.y)) {
      const le: LiquidEffect = G.World.liquidEffect(this.types);
      if (le.dmg) {
        this.lavaTick -= dt;
        if (this.lavaTick <= 0) { this.lavaTick = le.every!; this.hurt(6 + this.maxHp * 0.04, le.color); }
        if (this.dead) return;
      } else if (le.slow) terrainMul = le.slow < 0.5 ? 0.45 : 0.55;
    }

    const spd = this.spd * (1 - this.slow) * terrainMul * G.Weather.speedFor(this.types);
    let [dx, dy] = G.U.norm(pl.x - this.x, pl.y - this.y);
    const dist = G.U.dist(this.x, this.y, pl.x, pl.y);
    // Duende del tesoro: huye de ti (en zigzag) en cuanto te acercas.
    if (this.behavior === 'thief') {
      this.zig = (this.zig || 0) + dt;
      const near = dist < 300, a = Math.atan2(-dy, -dx) + Math.sin(this.zig * 2.2) * 0.7;
      const k = near ? 1 : 0.35;
      const vx0 = Math.cos(a) * spd * k, vy0 = Math.sin(a) * spd * k;
      const ox = this.x, oy = this.y;
      this.x += (vx0 + this.kx) * dt; this.y += (vy0 + this.ky) * dt;
      this.kx *= Math.pow(0.0015, dt); this.ky *= Math.pow(0.0015, dt);
      if (G.World.collide(this) && Math.hypot(this.x - ox, this.y - oy) < spd * k * dt * 0.3) this.zig += 1.4;
      if (Math.random() < dt * 6 && G.Camera.sees(this.x, this.y, 0)) G.FX.twinkle(this.x + G.U.rand(-this.r, this.r), this.y - G.U.rand(4, this.bodyH));
      this.anim.dir = G.Sprites.dirFromAngle(a);
      this.anim.loop('Walk', 1.4);
      return;
    }
    // Corredor: va a donde VAS a estar (te corta el paso si sólo huyes).
    if (this.behavior === 'runner' && pl._vx != null) {
      const lead = G.U.clamp(dist / Math.max(60, spd), 0, 1.4);
      [dx, dy] = G.U.norm(pl.x + pl._vx * lead - this.x, pl.y + pl._vy! * lead - this.y);
      if (G.Camera.sees(this.x, this.y, 0) && Math.random() < dt * 10) G.FX.px(this.x - dx * 8 + G.U.rand(-4, 4), this.y, '#e8dcc0', { vy: -12, life: 0.35 });
    }

    // --- personalidad (escudos, saltos, explosión) ---
    if (this.shieldT > 0 && (this.shieldT -= dt) <= 0) this.shield = 0;
    if (this.jump) { this.updateJump(dt); return; }
    if (this.behavior === 'bomber' && this.phase === 'fuse') {
      this.pt -= dt;
      this.flash = Math.floor(this.pt * 10) % 2 ? 0.05 : 0;
      if (this.pt <= 0) { this.hp = 0; this.die(); }
      this.anim.loop('Idle');
      return;
    }
    if (this.behavior === 'bomber' && dist < this.r + pl.r! + 26) { this.startFuse(); return; }
    if (this.behavior === 'shielder' || this.behavior === 'jumper') {
      this.skillCd -= dt;
      if (this.skillCd <= 0) {
        if (this.behavior === 'shielder') { this.skillCd = 6; this.castShields(); }
        else if (dist < 250) { this.skillCd = G.U.rand(5, 7); this.startJump(pl); return; }
        else this.skillCd = 0.5;
      }
    }

    // Si lleva rato atascado contra algo, rodea por un lado.
    if (this.sideT > 0) {
      this.sideT -= dt;
      const a = Math.atan2(dy, dx) + this.side * 1.25;
      dx = Math.cos(a); dy = Math.sin(a);
    }

    // Camino alrededor de los obstáculos (los que no vuelan).
    if (!this.flying && this.phase !== 'dash' && this.sideT <= 0) {
      const pd = G.Path.dirFor(this, pl);
      if (pd && !(this.keepsDistance() && dist < (this.def.range || 200) * 0.82)) { dx = pd[0]; dy = pd[1]; }
    }

    let vx = dx * spd, vy = dy * spd;
    let animBase = 'Walk';

    if (this.boss) {
      [vx, vy, animBase] = this.bossMove(dt, pl, dist, dx, dy, spd);
    } else if (this.behavior === 'charger') {
      this.pt -= dt;
      if (this.phase === 'walk') {
        if (dist < 200 && this.pt <= 0) {
          this.phase = 'aim'; this.pt = 0.55;
          this.anim.play('Charge', { speed: 1.6 });
        }
      } else if (this.phase === 'aim') {
        vx = vy = 0; animBase = 'Idle';
        if (this.pt <= 0) {
          this.phase = 'dash'; this.pt = 0.42;
          this.dx = dx; this.dy = dy;
          this.anim.play('Attack', { speed: 1.4 });
          G.FX.ring(this.x, this.y, this.r, this.r * 2.4, '#ff6b6b', 0.25, 2);
        }
      } else if (this.phase === 'dash') {
        vx = this.dx * spd * 3.4; vy = this.dy * spd * 3.4;
        if (this.pt <= 0) { this.phase = 'walk'; this.pt = 1.1; }
      }
    } else if (this.keepsDistance()) {
      const range = this.def.range || 200;
      const keep = range * 0.82;
      // Recta hacia ti (no el camino) para alejarse.
      const [ddx, ddy] = G.U.norm(pl.x - this.x, pl.y - this.y);
      if (dist < keep * 0.75) { vx = -ddx * spd * 0.8; vy = -ddy * spd * 0.8; }
      else if (dist < keep) { vx *= 0.1; vy *= 0.1; animBase = 'Idle'; }
      this.shotCd -= dt;
      if (this.shotCd <= 0 && dist < range) {
        this.shotCd = this.def.shotCd || 2;
        this.special(pl, ddx, ddy);
      }
    }

    // --- integración ---
    const ox = this.x, oy = this.y;
    this.x += this.kx * dt; this.y += this.ky * dt;
    this.kx *= Math.pow(0.0015, dt); this.ky *= Math.pow(0.0015, dt);
    this.x += vx * dt; this.y += vy * dt;

    if (!this.flying && G.World.collide(this)) {
      // ¿Ha avanzado bastante menos de lo que quería?
      const want = Math.hypot(vx, vy) * dt;
      const got = Math.hypot(this.x - ox, this.y - oy);
      if (want > 0.5 && got < want * 0.35) {
        this.stuckT += dt;
        if (this.stuckT > 0.35 && this.sideT <= 0) {
          this.sideT = 0.7; this.stuckT = 0;
          this.side = Math.random() < 0.5 ? -1 : 1;
        }
      } else this.stuckT = 0;
    }

    // --- animación ---
    const moving = Math.abs(vx) + Math.abs(vy) > 2;
    const faceA = this.phase === 'dash' ? Math.atan2(this.dy, this.dx)
                : moving ? Math.atan2(vy, vx) : Math.atan2(pl.y - this.y, pl.x - this.x);
    this.anim.dir = G.Sprites.dirFromAngle(faceA);
    this.anim.loop(moving ? animBase : 'Idle', moving ? Math.max(0.6, spd / 70) : 1);
  }

  // ---------------- jefes ----------------
  // Cada jefe (y cada legendario de las grietas) tiene 4 ataques: 2 de
  // cerca (Pisotón siempre + Embestida o Salto) y 2 de lejos según su tipo.
  // Va alternando entre ir a por ti y pelear a distancia, así que el que
  // dispara también se te echa encima y el de cuerpo a cuerpo también
  // dispara. Todo avisa en el suelo. Por debajo de la mitad de vida se
  // enfurece: más rápido, menos espera y a veces encadena dos ataques.

  bossInit() {
    const T = this.types, has = (...xs: PokeType[]) => xs.some(x => T.includes(x));
    const melee = ['slam', G.U.hash(this.dex, 3, 7) < 0.5 ? 'dash' : 'leap'];
    const pref = has('fire', 'ground', 'poison', 'rock', 'grass') ? 'rain'
               : has('electric', 'psychic', 'dragon', 'ice', 'steel') ? 'beam'
               : has('fairy', 'ghost', 'water', 'flying') ? 'nova' : 'volley';
    const others = ['rain', 'beam', 'nova', 'volley'].filter(x => x !== pref);
    const ranged = [pref, others[Math.floor(G.U.hash(this.dex, 5, 9) * 3) % 3]];
    const far = this.behavior === 'ranged';
    this.ai = { melee, ranged, farLike: far ? 0.65 : 0.35, mode: far ? 'far' : 'close', modeT: G.U.rand(6, 8),
                cd: 1.6, cast: null, fury: false, side: Math.random() < 0.5 ? -1 : 1 };
  }

  bossMove(dt: number, pl: EnemyTarget, dist: number, dx: number, dy: number, spd: number): BossMove {
    if (!this.ai) this.bossInit();
    const ai = this.ai!;
    if (!ai.fury && this.hp < this.maxHp * 0.5) this.enrage();
    const k = ai.fury ? 1.25 : 1;
    if (ai.cast) return this.bossCast(dt, pl);
    ai.modeT -= dt; ai.cd -= dt * k;
    // Alterna siempre: en su distancia favorita está más rato (7-9 s) que en la otra (4-5 s).
    if (ai.modeT <= 0) {
      ai.mode = ai.mode === 'far' ? 'close' : 'far';
      ai.modeT = (ai.mode === 'far') === (ai.farLike > 0.5) ? G.U.rand(7, 9) : G.U.rand(4, 5);
      ai.side = -ai.side;
    }
    let vx = dx * spd * k * 1.1, vy = dy * spd * k * 1.1;
    const [ddx, ddy] = G.U.norm(pl.x - this.x, pl.y - this.y);
    if (ai.mode === 'far') {
      if (dist < 170) { vx = -ddx * spd; vy = -ddy * spd; }
      else if (dist < 300) { vx = -ddy * spd * 0.55 * ai.side; vy = ddx * spd * 0.55 * ai.side; }   // te rodea
    }
    if (ai.cd <= 0) {
      let id = null;
      if (ai.mode === 'close') {
        const ok = ai.melee.filter(m => m === 'slam' ? dist < 125 : dist < 320);
        // De vez en cuando, aunque esté cerca, también dispara.
        id = ok.length && Math.random() < 0.8 ? G.U.pick(ok) : dist < 480 ? G.U.pick(ai.ranged) : null;
      } else {
        id = dist < 115 ? 'slam' : dist < 430 ? G.U.pick(ai.ranged) : null;
      }
      if (id) this.bossStart(id, pl);
    }
    return [vx, vy, 'Walk'];
  }

  enrage() {
    this.ai!.fury = true;
    this.spd *= 1.15;
    if (!this.judge) G.Spawner.say('¡' + this.name + ' se ha enfurecido!', 2.4);
    G.FX.ring(this.x, this.y, this.r, this.r * 5, '#ff4a4a', 0.6, 5);
    G.Camera.kick(0.5);
    G.Audio.sfx('boss');
  }

  bossStart(id: string, pl: EnemyTarget) {
    const ai = this.ai!, f = ai.fury ? 0.8 : 1, type = this.atkType;
    const col = G.U.TYPE_COLOR[type] || '#ff7a9e';
    const ang = Math.atan2(pl.y - this.y, pl.x - this.x);
    const c: BossCast = ai.cast = { id, t: 0, wind: 0.6 * f, after: 0.35, ang };
    switch (id) {
      case 'slam':       // pisotón: onda alrededor
        c.wind = 0.85 * f;
        G.Hazards.add({ kind: 'zone', x: this.x, y: this.y, r: 96 + this.r, delay: c.wind, dmg: this.dmg * 1.3, type, color: col });
        this.anim.play('Charge', { speed: 1.2 });
        break;
      case 'dash':       // embestida en línea recta
        c.wind = 0.75 * f; c.len = 330; c.dur = 0.32;
        G.Hazards.add({ kind: 'beam', x: this.x, y: this.y, angle: ang, len: c.len + this.r, w: this.r * 2 + 16,
                        delay: c.wind + c.dur, dmg: this.dmg * 1.2, type, color: col });
        this.anim.play('Charge', { speed: 1.3 });
        break;
      case 'leap':       // salto y caída sobre ti
        this.jump = { sx: this.x, sy: this.y, tx: pl.x, ty: pl.y, t: -0.5 * f, dur: 0.65 };
        G.Hazards.add({ kind: 'zone', x: pl.x, y: pl.y, r: 82, delay: 0.5 * f + 0.65, dmg: this.dmg * 1.25, type, color: col });
        this.anim.play('Charge', { speed: 1.4 });
        ai.cast = null; ai.cd = G.U.rand(1.4, 2) + 0.6;
        break;
      case 'rain': {     // zonas que caen alrededor de ti
        const n = ai.fury ? 6 : 4;
        for (let i = 0; i < n; i++) {
          const a = i ? Math.random() * 6.2832 : 0, d = i ? G.U.rand(40, 120) : 0;
          G.Hazards.add({ kind: 'zone', x: pl.x + Math.cos(a) * d, y: pl.y + Math.sin(a) * d * 0.8, r: 50,
                          delay: 1.05 + i * 0.12, dmg: this.shotDmg() * 1.15, type, color: col });
        }
        c.wind = 0.5; this.anim.play('Shoot');
        break;
      }
      case 'beam': {     // rayos en abanico
        const n = ai.fury ? 5 : 3, sp = ai.fury ? 0.42 : 0.5;
        for (let i = 0; i < n; i++) {
          G.Hazards.add({ kind: 'beam', x: this.x, y: this.y, angle: ang + (i - (n - 1) / 2) * sp, len: 400, w: 26,
                          delay: 1.0, dmg: this.shotDmg() * 1.2, type, color: col });
        }
        c.wind = 1.0; c.after = 0.25; this.anim.play('Charge', { speed: 1.1 });
        break;
      }
      case 'volley':     // abanico de disparos
      case 'nova':       // anillo de disparos
        c.wind = (id === 'nova' ? 0.7 : 0.5) * f;
        this.anim.play('Charge', { speed: 1.4 });
        G.FX.ring(this.x, this.y, this.r, this.r * 2.4, col, c.wind, 2);
        break;
    }
  }

  bossCast(dt: number, pl: EnemyTarget): BossMove {
    const ai = this.ai!, c = ai.cast!;
    c.t += dt;
    if (c.id === 'dash' && c.t >= c.wind) {
      if (!c.go) { c.go = true; this.anim.play('Attack', { speed: 1.6 }); }
      if (c.t >= c.wind + c.dur!) return this.bossEnd();
      const sp = c.len! / c.dur!;
      return [Math.cos(c.ang) * sp, Math.sin(c.ang) * sp, 'Walk'];
    }
    if (c.t >= c.wind && !c.fired) {
      c.fired = true;
      const [ax, ay] = G.U.norm(pl.x - this.x, pl.y - this.y);
      if (c.id === 'volley') this.shoot(ax, ay, 1.1, ai.fury ? 9 : 7, 0.8);
      else if (c.id === 'nova') { const n = ai.fury ? 18 : 14; this.shoot(ax, ay, 6.2832 * (n - 1) / n, n, 0.7); }
      else if (c.id === 'slam') this.anim.play('Attack', { speed: 1.4 });
    }
    if (c.t >= c.wind + c.after) return this.bossEnd();
    return [0, 0, 'Idle'];
  }

  bossEnd(): BossMove {
    const ai = this.ai!;
    ai.cast = null;
    ai.cd = G.U.rand(1.3, 2.0);
    if (ai.fury && Math.random() < 0.35) ai.cd = 0.3;    // encadena otro
    return [0, 0, 'Idle'];
  }

  keepsDistance() { return ['ranged', 'fan', 'beamer', 'zoner', 'healer', 'summoner'].includes(this.behavior); }

  shotDmg() { return (this.def.shotDmg || 10) * (this.dmg / this.def.dmg); }

  /** Disparo normal de enemigo (uno, o varios en abanico). */
  shoot(ax: number, ay: number, spread = 0, n = 1, k = 1) {
    const sp = 190, type = this.atkType;
    const base = Math.atan2(ay, ax);
    for (let i = 0; i < n; i++) {
      const a = base + (n === 1 ? 0 : (i / (n - 1) - 0.5) * spread);
      const shot = G.Projectiles.spawn({
        x: this.x, y: this.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        dmg: this.shotDmg() * k, r: 7, life: 2.4, friendly: false, color: '#ff7a9e', mtype: type,
        vis: G.VFX.forType(type)
      });
      if (G.Coop.isHost) G.Coop.enemyShot(shot, type);
    }
    this.anim.play('Shoot');
    G.FX.ring(this.x, this.y - G.LIFT, 4, 14, '#ff7a9e', 0.2, 2);
  }

  /** Lo que hace cada personalidad cuando le toca (anfitrión / solitario). */
  special(pl: EnemyTarget, dx: number, dy: number) {
    const col = G.U.TYPE_COLOR[this.atkType] || '#ff7a9e';
    switch (this.behavior) {
      case 'fan': { const n = this.def.fanN || 5; this.shoot(dx, dy, n === 3 ? 0.6 : 0.9, n, 0.65); break; }
      case 'beamer':
        // Rayo con aviso: primero se ve la franja en el suelo.
        G.Hazards.add({ kind: 'beam', x: this.x, y: this.y, angle: Math.atan2(dy, dx), len: 360, w: 22,
                        delay: 1.0, dmg: this.shotDmg() * 1.05, type: this.atkType, color: col });
        this.anim.play('Charge', { speed: 1.2 });
        break;
      case 'zoner': {
        const n = G.U.randInt(1, this.def.zones || 3);
        for (let i = 0; i < n; i++) {
          G.Hazards.add({ kind: 'zone', x: pl.x + (i ? G.U.rand(-70, 70) : 0), y: pl.y + (i ? G.U.rand(-55, 55) : 0), r: 44,
                          delay: 1.2, dmg: this.shotDmg() * 0.95, type: this.atkType, color: col });
        }
        this.anim.play('Shoot');
        break;
      }
      case 'healer': this.healAround(); break;
      case 'summoner': this.summon(); break;
      default: this.shoot(dx, dy);
    }
  }

  healAround() {
    // 7 % de la vida (era 15 %: con varios curanderos curaban más de lo que
    // pegabas), y más cuanto más fuerte pegas, pero cada vez menos: con el
    // doble de ataque cura un 27 % más, con 10 veces más un 124 %, y como
    // mucho ×2,5. (Como los enemigos que tienen más vida si haces más daño.)
    // Cada enemigo recibe como mucho una curación cada HEAL_CD s, vengan de
    // quien vengan (N curanderos juntos no curan N veces), y los curanderos
    // ni se curan entre sí ni curan a los jefes: se les puede matar.
    const pow = Math.max(1, ...G.Game.everyone().map(p => (p.atk > 0 && p.baseAtk > 0 ? p.atk / p.baseAtk : 1)));
    const k = 0.07 * Math.min(2.5, Math.pow(pow, 0.35));
    let n = 0;
    for (const e of G.EnemyMgr.queryCircle(this.x, this.y, 150)) {
      if (e.dead || e.hp >= e.maxHp || e.healT > 0 || e.boss || e.behavior === 'healer') continue;
      e.hp = Math.min(e.maxHp, e.hp + e.maxHp * k);
      e.healT = HEAL_CD;
      G.FX.burst(e.x, e.y - e.bodyH * 0.6, '#7dffb0', 5, 60);
      n++;
    }
    this.anim.play('Charge');
    G.FX.ring(this.x, this.y, 8, 150, '#5fe08a', 0.5, 3);
    if (G.Coop.isHost) G.Coop.broadcast(['fxr', Math.round(this.x), Math.round(this.y), 150, '#5fe08a']);
    if (n && G.Camera.sees(this.x, this.y, 0)) G.Audio.sfx('heal');
  }

  castShields() {
    // Ni a los escudadores ni a los jefes; y un escudo nuevo a cada enemigo
    // como mucho cada SHIELD_CD s, aunque haya varios escudadores.
    const near = G.EnemyMgr.queryCircle(this.x, this.y, 160).filter(e => !e.dead && !e.boss && e.behavior !== 'shielder' && e.shieldCd <= 0)
      .sort((a, b) => G.U.dist2(a.x, a.y, this.x, this.y) - G.U.dist2(b.x, b.y, this.x, this.y)).slice(0, 6);
    for (const e of near) { e.shield = Math.max(e.shield, e.maxHp * 0.35); e.shieldT = 8; e.shieldCd = SHIELD_CD; }
    this.anim.play('Charge');
    G.FX.ring(this.x, this.y, 8, 160, '#7fc8ff', 0.5, 3);
    if (G.Coop.isHost) G.Coop.broadcast(['fxr', Math.round(this.x), Math.round(this.y), 160, '#7fc8ff']);
  }

  summon() {
    this.minions = this.minions.filter(m => !m.dead && G.EnemyMgr.get(m.id));
    // Con el tope general de enemigos (menos Pokémon en pantalla), con un pequeño margen.
    if (this.minions.length >= 4 || G.EnemyMgr.count > G.Spawner.CAP + 15) return;
    const dex = this.def.minion || this.dex;
    const mon = G.DEX_BY[dex];
    const def = { dex, name: mon ? mon.name : '', hp: Math.round(this.def.hp * 0.35), spd: Math.round(this.def.spd * 1.1),
                  dmg: Math.round(this.def.dmg * 0.6), xp: Math.max(1, Math.round(this.def.xp * 0.25)), behavior: 'chase' };
    for (let i = 0; i < 2; i++) {
      const a = Math.random() * 6.2832;
      const m = new Enemy(def, this.x + Math.cos(a) * 30, this.y + Math.sin(a) * 22, this.sc || { hp: 1, spd: 1, dmg: 1 });
      G.EnemyMgr.add(m);
      this.minions.push(m);
      G.FX.burst(m.x, m.y - 8, '#c47bff', 8, 90);
    }
    this.anim.play('Charge');
    G.FX.ring(this.x, this.y, 8, 50, '#c47bff', 0.4, 3);
  }

  startFuse() {
    this.phase = 'fuse'; this.pt = 1.0;
    G.Hazards.add({ kind: 'zone', x: this.x, y: this.y, r: 62, delay: 1.0, dmg: this.dmg * 1.4, type: this.atkType, color: '#ff7b3d' });
  }

  startJump(pl: EnemyTarget) {
    const tx = pl.x, ty = pl.y;
    this.jump = { sx: this.x, sy: this.y, tx, ty, t: -0.45, dur: 0.6 };
    this.anim.play('Charge', { speed: 1.4 });
    G.Hazards.add({ kind: 'zone', x: tx, y: ty, r: 50, delay: 1.05, dmg: this.dmg * 1.2, type: this.atkType,
                    color: G.U.TYPE_COLOR[this.atkType] || '#ff7a9e' });
  }

  /** Salto: se agacha, vuela en arco y cae donde estabas. */
  updateJump(dt: number) {
    const j = this.jump!;
    j.t += dt;
    if (j.t < 0) { this.anim.loop('Idle'); return; }
    const k = Math.min(1, j.t / j.dur);
    this.x = j.sx + (j.tx - j.sx) * k;
    this.y = j.sy + (j.ty - j.sy) * k;
    this.jumpLift = Math.sin(k * Math.PI) * 46;
    this.anim.dir = G.Sprites.dirFromAngle(Math.atan2(j.ty - j.sy, j.tx - j.sx));
    if (k >= 1) {
      this.jump = null; this.jumpLift = 0;
      if (!this.flying) G.World.collide(this);
      this.anim.play('Attack', { speed: 1.4 });
    }
  }

  /** Lo llama combat.js cuando te toca: anima el golpe. */
  strike(pl: EnemyTarget) {
    if (!this.anim.busy()) {
      this.anim.dir = G.Sprites.dirFromAngle(Math.atan2(pl.y - this.y, pl.x - this.x));
      this.anim.play('Attack', { speed: 1.5 });
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    const alpha = this.dead ? G.U.clamp(this.fade / 0.5, 0, 1) : 1;
    if (alpha <= 0) return;

    const gold = this.golden || this.behavior === 'thief' || (this.remote && !this.boss && G.Events.golden);
    if ((this.boss || this.shiny || gold) && !this.dead) {
      ctx.save();
      ctx.globalAlpha = (gold && !this.boss ? 0.32 : 0.22) + Math.sin(this.bob * 0.5) * 0.06;
      ctx.fillStyle = this.ai && this.ai.fury ? '#ff4a4a' : this.shiny ? '#9ae6ff' : gold ? '#ffd23f' : '#ffd95e';
      ctx.beginPath(); ctx.ellipse(this.x, this.y, this.r * 1.6, this.r * 0.6, 0, 0, 6.2832); ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    G.Sprites.drawShadow(ctx, this.dex, this.x, this.y, this.scale);
    // Los que flotan ya van en el aire en su sprite: sólo se mecen un poco.
    // (Y los que saltan, en arco.)
    const lift = (this.flying && !this.boss ? 1 + Math.sin(this.bob) * 1.5 : 0) + (this.jumpLift || 0);
    this.anim.draw(ctx, this.x, this.y - lift, { flash: this.flash > 0, alpha });
    ctx.restore();

    if (this.dead) return;

    // Escudo: burbuja azul.
    if (this.shield > 0 || (this.net && this.net.st & 4)) {
      ctx.save();
      ctx.globalAlpha = 0.35 + Math.sin(this.bob) * 0.08;
      ctx.strokeStyle = '#9fd8ff'; ctx.lineWidth = 2;
      ctx.fillStyle = 'rgba(127,200,255,.14)';
      ctx.beginPath(); ctx.ellipse(this.x, this.y - this.bodyH * 0.45, this.r * 1.5, this.bodyH * 0.65, 0, 0, 6.2832);
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    if (this.burn > 0 || this.poison > 0 || (this.net && this.net.st & 3)) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      const burning = this.burn > 0 || (this.net && this.net.st & 1);
      const poisoned = this.poison > 0 || (this.net && this.net.st & 2);
      // Quemado y envenenado a la vez: la elipse naranja y, dentro, una morada más pequeña.
      ctx.fillStyle = burning ? '#ff8a3d' : '#c86bdc';
      ctx.beginPath(); ctx.ellipse(this.x, this.y, this.r * 1.2, this.r * 0.5, 0, 0, 6.2832); ctx.fill();
      if (burning && poisoned) {
        ctx.fillStyle = '#c86bdc';
        ctx.beginPath(); ctx.ellipse(this.x, this.y, this.r * 0.75, this.r * 0.31, 0, 0, 6.2832); ctx.fill();
      }
      ctx.restore();
    }

    // Apoyos: icono encima, para saber a quién ir primero.
    const SUP: Record<string, string> = { healer: 'heart', shielder: 'shield', summoner: 'friends' };
    if (SUP[this.behavior]) G.Icons.draw(ctx, SUP[this.behavior], Math.round(this.x - 6), Math.round(this.y - this.bodyH - (this.hp < this.maxHp ? 26 : 18)), 12);

    if (this.boss || this.hp < this.maxHp) {
      const w = this.boss ? 90 : Math.max(22, this.r * 2);
      const y = this.y - this.bodyH - 10;
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(this.x - w / 2, y, w, 3.4);
      ctx.fillStyle = this.boss ? '#ffcb3d' : '#ff5f6d';
      ctx.fillRect(this.x - w / 2, y, w * Math.max(0, this.hp / this.maxHp), 3.4);
    }
  }
}

// ---------------- gestor ----------------

G.Enemy = Enemy;

export const EnemyMgr = (() => {
  let list: Enemy[] = [];            // vivos
  let corpses: Enemy[] = [];         // cayendo / desvaneciéndose
  const CELL = 52;
  const grid = new Map<number, Enemy[]>();

  const byId = new Map<number, Enemy>();
  function clear() { list = []; corpses = []; grid.clear(); byId.clear(); }
  function all() { return list; }
  function add(e: Enemy) {
    list.push(e);
    byId.set(e.id, e);
    if (G.Coop.isHost) G.Coop.enemyAdded(e);
    return e;
  }
  function get(id: number) { return byId.get(id); }

  /** Copia local de un enemigo del anfitrión (cooperativo). */
  function addRemote(o: RemoteEnemyInfo) {
    if (byId.has(o.id)) return byId.get(o.id);
    const def = { dex: o.dex, hp: o.hp, spd: 0, dmg: o.dmg, xp: 0, behavior: o.beh || 'remote' };
    const e = new Enemy(def, o.x, o.y, { hp: 1, spd: 1, dmg: 1 }, o.boss);
    e.id = o.id;
    e.remote = true;
    if (o.shiny) e.makeShiny();
    e.maxHp = o.hp; e.hp = o.hp;
    e.net = { x: o.x, y: o.y, vx: 0, vy: 0, age: 0, dir: 0, anim: 0, st: 0 };
    list.push(e);
    byId.set(e.id, e);
    return e;
  }

  // --- arena de la grieta ---
  let stashed: Enemy[] | null = null;

  /** Guarda los enemigos del mapa mientras dura la arena. */
  function stash() {
    stashed = list.filter(e => !e.dead);
    for (const e of stashed) byId.delete(e.id);
    list = []; corpses = [];
  }

  /** Al volver: quita los de la arena y devuelve los del mapa (avisando a los demás). */
  function restore() {
    for (const e of list) { byId.delete(e.id); if (G.Coop.isHost) G.Coop.enemyGone(e, false); }
    list = []; corpses = [];
    for (const e of stashed || []) add(e);
    stashed = null;
  }

  /** Invitado: borra las copias (llegarán otra vez del anfitrión). */
  function clearRemote() {
    for (const e of list) if (e.remote) byId.delete(e.id);
    list = list.filter(e => !e.remote);
    corpses = corpses.filter(e => !e.remote);
  }

  /** Quita una copia (el anfitrión dice que ha caído o que se ha alejado). */
  function removeRemote(id: number, died?: boolean) {
    const e = byId.get(id);
    if (!e) return;
    byId.delete(id);
    if (died) { e.die(); G.Progress.kill(e); }
    const i = list.indexOf(e);
    if (i >= 0) list.splice(i, 1);
    if (died) corpses.push(e);
  }

  function key(cx: number, cy: number) { return cx * 73856093 ^ cy * 19349663; }

  function rebuildGrid() {
    grid.clear();
    for (const e of list) {
      if (e.dead) continue;
      const k = key(Math.floor(e.x / CELL), Math.floor(e.y / CELL));
      let b = grid.get(k);
      if (!b) grid.set(k, b = []);
      b.push(e);
    }
  }

  /** Enemigos vivos cuyo círculo toca este círculo. */
  function queryCircle(x: number, y: number, r: number) {
    const out: Enemy[] = [];
    const c0x = Math.floor((x - r) / CELL) - 1, c1x = Math.floor((x + r) / CELL) + 1;
    const c0y = Math.floor((y - r) / CELL) - 1, c1y = Math.floor((y + r) / CELL) + 1;
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const b = grid.get(key(cx, cy));
        if (!b) continue;
        for (const e of b) {
          if (e.dead) continue;
          const rr = r + e.r;
          if (G.U.dist2(x, y, e.x, e.y) <= rr * rr) out.push(e);
        }
      }
    }
    return out;
  }

  function separate(dt: number) {
    for (const e of list) {
      if (e.dead) continue;
      const cx = Math.floor(e.x / CELL), cy = Math.floor(e.y / CELL);
      let px = 0, py = 0, n = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const b = grid.get(key(cx + i, cy + j));
          if (!b) continue;
          for (const o of b) {
            if (o === e || o.dead) continue;
            const min = (e.r + o.r) * 0.82;
            const dx = e.x - o.x, dy = e.y - o.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > min * min || d2 < 1e-4) continue;
            const d = Math.sqrt(d2);
            const f = (min - d) / min;
            px += (dx / d) * f; py += (dy / d) * f;
            if (++n > 6) break;
          }
        }
      }
      if (n) {
        e.x += px * 42 * dt;
        e.y += py * 42 * dt;
        if (!e.flying) G.World.collide(e);
      }
    }
  }

  /** El jugador vivo más cercano (los caídos no atraen a nadie). */
  function nearestPlayer<T extends EnemyTarget>(players: T[], x: number, y: number) {
    let best: T | null = null, bd = Infinity;
    for (const p of players) {
      if (p.dead) continue;
      const d = G.U.dist2(x, y, p.x, p.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /**
   * @param players  [jugador local, ...compañeros]. Las estadísticas de la
   *                 run (derrotados, jefes) se apuntan en el primero.
   */
  // Segundos que un rezagado tiene que llevar fuera de la vista antes de volver por delante.
  const LAG_T = 2.5;
  // Un jefe a más de BOSS_FAR px de todos durante BOSS_LAG_T s se recoloca.
  const BOSS_FAR = 1000, BOSS_LAG_T = 10;

  function update(dt: number, players: Tracked | Tracked[]) {
    if (!Array.isArray(players)) players = [players];
    const pl = players[0];
    // Velocidad suavizada de cada jugador (vale también para los compañeros).
    for (const p of players) {
      if (p._px != null && dt > 0) {
        const k = Math.min(1, dt * 5);
        p._vx! += ((p.x - p._px) / dt - p._vx!) * k; p._vy! += ((p.y - p._py!) / dt - p._vy!) * k;
        if (Math.abs(p.x - p._px) > 200 || Math.abs(p.y - p._py!) > 200) p._vx = p._vy = 0;    // teletransporte
      } else { p._vx = 0; p._vy = 0; }
      p._px = p.x; p._py = p.y;
    }
    rebuildGrid();
    for (const e of list) {
      if (e.remote) e.netUpdate(dt);
      else e.update(dt, nearestPlayer(players, e.x, e.y) || pl);
    }
    if (!G.Coop.active || G.Coop.isHost) separate(dt);
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.remote) continue;
      if (e.dead) {
        pl.kills++;
        if (e.boss && !e.judge) pl.bosses++;
        G.Progress.kill(e);
        corpses.push(e);
        list.splice(i, 1);
        byId.delete(e.id);
        if (G.Coop.isHost) G.Coop.enemyGone(e, true);
        continue;
      }
      const near = nearestPlayer(players, e.x, e.y) || pl;
      // El duende del tesoro se escapa si no lo atrapas a tiempo.
      if (e.behavior === 'thief' && (e.life! -= dt) <= 0) {
        G.FX.burst(e.x, e.y - 10, '#ffd23f', 16, 140);
        G.Spawner.say('¡' + e.name + ' se ha escapado!', 2.4);
        list.splice(i, 1); byId.delete(e.id);
        if (G.Coop.isHost) G.Coop.enemyGone(e, false);
        continue;
      }
      // Jefe que se queda muy atrás de todos: vuelve a salir por delante (si no, su barra
      // sale arriba pero no hay jefe que ver). No si está lanzando un ataque.
      if (e.boss && !e.judge && !G.Rift.inArena) {
        if (G.U.dist2(e.x, e.y, near.x, near.y) > BOSS_FAR * BOSS_FAR && !(e.ai && e.ai.cast)) e.lagT += dt;
        else e.lagT = 0;
        if (e.lagT > BOSS_LAG_T) {
          e.lagT = BOSS_LAG_T - 2;     // si no hay sitio, reintenta en 2 s
          if (G.Spawner.ahead(e, near)) e.lagT = 0;
        }
        continue;
      }
      if (e.boss || e.shiny || G.Rift.inArena) continue;
      // Rezagados: los que se quedan atrás mientras corres y llevan un rato
      // FUERA DE LA VISTA (de todos) vuelven a salir por delante de ti. Así
      // no se puede huir sin más, y nunca desaparece uno que estés viendo.
      const d2 = G.U.dist2(e.x, e.y, near.x, near.y);
      const R = G.Camera.outerRadius() + 40;
      const unseen = d2 > R * R && !G.Camera.sees(e.x, e.y, 60);
      const sp = Math.hypot(near._vx || 0, near._vy || 0);
      const behind = sp > 40 && ((e.x - near.x) * near._vx! + (e.y - near.y) * near._vy!) < -0.2 * Math.sqrt(d2) * sp;
      if (unseen && behind) e.lagT += dt;
      else if (!unseen) e.lagT = 0;
      if ((unseen && e.lagT > LAG_T) || d2 > 1400 * 1400) {
        e.lagT = 0;
        if (!G.Spawner.ahead(e, near)) { list.splice(i, 1); byId.delete(e.id); if (G.Coop.isHost) G.Coop.enemyGone(e, false); }
      }
    }
    for (let i = corpses.length - 1; i >= 0; i--) {
      if (corpses[i].remote) corpses[i].netUpdate(dt); else corpses[i].update(dt, pl);
      if (corpses[i].fade <= 0) corpses.splice(i, 1);
    }
    if (corpses.length > 120) corpses.splice(0, corpses.length - 120);
  }

  /** Lo que hay que dibujar ordenado por Y junto al resto de la escena. */
  function drawables(cam: { sees(x: number, y: number, pad?: number): boolean }) {
    const out: Enemy[] = [];
    for (const e of corpses) if (cam.sees(e.x, e.y, 80)) out.push(e);
    for (const e of list) if (cam.sees(e.x, e.y, 80)) out.push(e);
    return out;
  }

  function bossAlive() { return list.some(e => e.boss && !e.dead); }
  function shinies() { return list.filter(e => e.shiny && !e.dead); }

  return { clear, all, add, get, addRemote, removeRemote, stash, restore, clearRemote, update, drawables, queryCircle, rebuildGrid, bossAlive, shinies, nearestPlayer,
           get count() { return list.length; } };
})();
G.EnemyMgr = EnemyMgr;

declare module '../g' {
  interface Registry { Enemy: typeof Enemy; EnemyMgr: typeof EnemyMgr }
}
