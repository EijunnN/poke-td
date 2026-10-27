import { G } from '../g';
import type { Player } from '../entities/player';
import type { Nature, NatureStat } from '../data/natures';
/* ============ mons.ts — naturaleza, habilidad y MT de cada Pokémon ============
 * Cada Pokémon de tu colección tiene:
 *   - NATURALEZA (data/natures.ts): +10 % a una cualidad y −10 % a otra (cinco son neutras). Se cambia con una Menta.
 *   - HABILIDAD (data/abilities.ts; su efecto, en data/ability-fx.ts): una de las suyas; la oculta sale 1 de cada 20.
 *     Se cambia con una Cápsula Habilidad (la oculta, con la Cápsula Habilidad Oculta).
 *   - MT aprendidas: ataques que no son de sus tipos pero que sí aprende en los juegos (data/tms.ts). Salen en las
 *     cartas de nivel y valen de movimiento inicial (Moves.poolFor).
 *
 * Lo que le TOCÓ (naturaleza y habilidad) no se guarda: sale "al azar" pero fijo para cada cuenta y Pokémon (semilla:
 * la fecha de creación de la partida y su número de Pokédex). Así todos los aparatos de la misma cuenta ven lo mismo
 * y también los Pokémon que ya tenías tienen la suya. Lo cambiado con Menta o Cápsula sí se guarda
 * (save.pnat / save.pabil: [valor, fecha] para fusionar) y las MT aprendidas, en save.ptm.
 *
 * Sólo el Survivor las usa (`apply`): la Defensa (modes/td.ts) no mira ni naturalezas ni habilidades.
 */
export const Mons = (() => {
  /** Una de cada tantas habilidades que salen es la oculta (si el Pokémon la tiene). */
  const HIDDEN_RATE = 1 / 20;
  /** Lo que sube y baja una naturaleza. */
  const NATURE_K = 0.1;
  const save = () => G.DB && G.DB.save;

  /** Un nombre [es, en] en el idioma del juego. */
  function name(n: readonly [string, string] | string): string {
    if (typeof n === 'string') return n;
    return G.I18n.lang === 'es' ? n[0] : n[1] || n[0];
  }

  /** Número pseudoaleatorio fijo (0 ≤ n < 1) para una cadena. */
  function hash(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  const roll = (dex: number, salt: string) => hash(((save() && save().created) || 0) + ':' + dex + ':' + salt);

  // ---------------- naturaleza ----------------

  /** La que le tocó (sin Menta). */
  const rolledNature = (dex: number): Nature => G.NATURES[Math.floor(roll(dex, 'nat') * G.NATURES.length)];

  /** La que tiene ahora: la de la última Menta o la que le tocó. */
  function natureOf(dex: number): Nature {
    const s = save(), p = s && s.pnat && s.pnat[dex];
    return (p && G.NATURE_BY[p[0]]) || rolledNature(dex);
  }

  /** Le pone esa naturaleza (el gasto de la Menta lo hace quien llama). */
  function setNature(dex: number, id: string): boolean {
    const s = save();
    if (!s || !G.NATURE_BY[id] || !G.DEX_BY[dex]) return false;
    s.pnat = s.pnat || {};
    s.pnat[dex] = [id, Date.now()];
    return true;
  }

  /** Lo que una naturaleza hace a las cualidades de un jugador. Una copia de la tabla: 1 = igual. */
  function natureMods(n: Nature): Record<NatureStat, number> {
    const m = { pa: 1, sa: 1, df: 1, sd: 1, spd: 1 };
    if (n.up) m[n.up] = 1 + NATURE_K;
    if (n.down) m[n.down] = 1 - NATURE_K;
    return m;
  }

  // ---------------- habilidad ----------------

  /** [habilidad 1, habilidad 2 o '', oculta o ''] */
  const slots = (dex: number): readonly string[] => G.DEX_ABIL[dex] || ['', '', ''];

  /** El hueco que le tocó: 2 (la oculta) 1 de cada 20 si tiene; si no, 0 o 1. */
  function rolledSlot(dex: number): number {
    const l = slots(dex);
    if (l[2] && roll(dex, 'hid') < HIDDEN_RATE) return 2;
    return l[1] && roll(dex, 'abil') < 0.5 ? 1 : 0;
  }

  /** { id, slot }: la de la última Cápsula o la que le tocó. */
  function abilityOf(dex: number): { id: string; slot: number } {
    const s = save(), p = s && s.pabil && s.pabil[dex], l = slots(dex);
    let slot = p && l[p[0]] ? p[0] : rolledSlot(dex);
    if (!l[slot]) slot = 0;
    return { id: l[slot] || '', slot };
  }

  /** Huecos a los que se puede cambiar (la oculta, sólo con la Cápsula Oculta; sin repetir la que ya tiene). */
  function abilityChoices(dex: number, hidden: boolean): number[] {
    const l = slots(dex), cur = abilityOf(dex).id;
    return [0, 1, 2].filter(i => l[i] && l[i] !== cur && (i < 2 || hidden) && !(i === 1 && l[1] === l[0]));
  }

  function setAbility(dex: number, slot: number): boolean {
    const s = save();
    if (!s || !slots(dex)[slot]) return false;
    s.pabil = s.pabil || {};
    s.pabil[dex] = [slot, Date.now()];
    return true;
  }

  const abilityName = (id: string) => (id && G.ABIL[id] ? name(G.ABIL[id]) : '');

  // ---------------- MT ----------------

  /** Movimientos que ha aprendido con MT. */
  function taught(dex: number): string[] {
    const s = save(), l = s && s.ptm && s.ptm[dex];
    return Array.isArray(l) ? l.filter(id => G.Moves.BY_ID[id]) : [];
  }
  /** ¿Ya lo sabe sin MT (es de sus tipos o de los que sólo aprenden unos pocos)? */
  const natural = (dex: number, id: string) => G.Moves.poolFor(G.DEX_BY[dex], true, false).includes(id);
  /** MT que puede aprender: las de los juegos que no sabe ya. */
  function learnable(dex: number): string[] {
    if (!G.DEX_BY[dex]) return [];
    return G.tmOf(dex).filter(id => G.Moves.BY_ID[id] && !natural(dex, id) && !taught(dex).includes(id));
  }
  const canLearn = (dex: number, id: string) => learnable(dex).includes(id);

  /** Enseña una MT de la Mochila (se gasta). → true si la ha aprendido. */
  function teach(dex: number, id: string): boolean {
    const s = save();
    if (!s || !canLearn(dex, id) || !G.Shop.takeTm(id)) return false;
    s.ptm = s.ptm || {};
    s.ptm[dex] = taught(dex).concat([id]);
    return true;
  }

  // ---------------- en partida ----------------

  /**
   * Naturaleza y habilidad en el jugador (Survivor). Debe llamarse justo tras crearlo, antes de elegir movimientos:
   * la habilidad puede cambiar su vida, su recarga o su crítico.
   */
  function apply(pl: Player) {
    const n = natureOf(pl.dex), m = natureMods(n);
    pl.basePhys *= m.pa;
    pl.baseSpec *= m.sa;
    pl.guardPhys /= m.df;
    pl.guardSpec /= m.sd;
    pl.baseSpd *= m.spd;
    pl.nature = n.id;
    pl.setAbility(abilityOf(pl.dex).id);
  }

  return { name, hash, natureOf, rolledNature, setNature, natureMods, slots, abilityOf, abilityChoices, setAbility, abilityName,
           taught, learnable, canLearn, natural, teach, apply, NATURE_K, HIDDEN_RATE };
})();
G.Mons = Mons;

declare module '../g' {
  interface Registry { Mons: typeof Mons }
}
