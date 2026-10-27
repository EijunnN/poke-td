#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Baja de PokeAPI (sus CSV en GitHub) las habilidades de cada Pokémon y las MT, y escribe
src/data/abilities.ts y src/data/tms.ts.

    python tools/fetch_mons.py
    python tools/fetch_mons.py --out /tmp/prueba      # fuera de src/

Los números de Pokédex salen de src/data/pokedex.ts y los movimientos, de src/data/moves.ts
(sólo se generan MT de movimientos que hay en el juego). Si algo falla en la red no se escribe nada.

  abilities.ts  ABIL[id] = [nombre es, nombre en] · DEX_ABIL[dex] = [habilidad 1, habilidad 2 o '', oculta o '']
  tms.ts        TM_MOVES[movimiento] = Pokémon que lo aprenden por MT en algún juego · TM_PRICE[movimiento]
"""
import argparse
import csv
import io
import os
import re
import sys

import fetch_pokedex
import netutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POKEDEX = os.path.join(ROOT, 'src', 'data', 'pokedex.ts')
MOVES = os.path.join(ROOT, 'src', 'data', 'moves.ts')
BASE = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/'
LANG_ES, LANG_EN = 7, 9
METHOD_MACHINE = 4

ABIL_HEADER = """import { G } from '../g';
/* ============ abilities.ts — GENERADO, no editar a mano ============
 * Lo produce tools/fetch_mons.py con los datos de PokeAPI.
 * ABIL[id]: nombre [es, en] · DEX_ABIL[dex]: [habilidad 1, habilidad 2 o '', oculta o ''].
 * Lo que hace cada una en el juego: data/ability-fx.ts.
 */
export const ABIL: Record<string, readonly [es: string, en: string]> = {
"""
ABIL_MID = """};
G.ABIL = ABIL;

export const DEX_ABIL: Record<number, readonly [string, string, string]> = {
"""
ABIL_FOOTER = """};
G.DEX_ABIL = DEX_ABIL;

declare module '../g' {
  interface Registry {
    ABIL: typeof ABIL;
    DEX_ABIL: typeof DEX_ABIL;
  }
}
"""

TM_HEADER = """import { G } from '../g';
/* ============ tms.ts — GENERADO, no editar a mano ============
 * Lo produce tools/fetch_mons.py con los datos de PokeAPI.
 * TM_MOVES[movimiento]: números de Pokédex de los que lo aprenden por MT en algún juego (sólo los movimientos
 * que hay en el juego). TM_PRICE[movimiento]: lo que cuesta en la Tienda Kecleon (300 + 6 por la potencia
 * que tiene en los juegos, redondeado a 10; los de estado, 400).
 */
export const TM_MOVES: Record<string, number[]> = {
"""
TM_MID = """};
G.TM_MOVES = TM_MOVES;

export const TM_PRICE: Record<string, number> = {
"""
TM_FOOTER = """};
G.TM_PRICE = TM_PRICE;

/** Las MT que puede aprender un Pokémon. */
const BY_DEX: Record<number, string[]> = {};
for (const id of Object.keys(TM_MOVES).sort()) for (const d of TM_MOVES[id]) (BY_DEX[d] = BY_DEX[d] || []).push(id);
export const tmOf = (dex: number): string[] => BY_DEX[dex] || [];
G.tmOf = tmOf;

declare module '../g' {
  interface Registry {
    TM_MOVES: typeof TM_MOVES;
    TM_PRICE: typeof TM_PRICE;
    tmOf: typeof tmOf;
  }
}
"""


def rows(name):
    raw = netutil.get_bytes(BASE + name + '.csv')
    if raw is None:
        raise netutil.FetchError(name + ' -> 404')
    return list(csv.DictReader(io.StringIO(raw.decode('utf-8'))))


def our_dexes():
    with io.open(POKEDEX, encoding='utf-8') as f:
        return [r['dex'] for r in fetch_pokedex.parse_pokedex(f.read())]


def our_moves():
    with io.open(MOVES, encoding='utf-8') as f:
        return sorted(set(re.findall(r"\{ id: '([a-z0-9-]+)', name:", f.read())))


def build(dexes, moves, t):
    """t: las tablas CSV ya leídas -> (abil, dex_abil, tm_moves, tm_price)."""
    ident = {r['id']: r['identifier'] for r in t['abilities']}
    names = {}
    for r in t['ability_names']:
        if r['local_language_id'] in (str(LANG_ES), str(LANG_EN)):
            names.setdefault(r['ability_id'], {})[int(r['local_language_id'])] = r['name']
    want = set(dexes)
    slots = {}
    for r in t['pokemon_abilities']:
        d = int(r['pokemon_id'])
        if d not in want:
            continue
        i = 2 if r['is_hidden'] == '1' else int(r['slot']) - 1
        if 0 <= i <= 2:
            slots.setdefault(d, ['', '', ''])[i] = ident[r['ability_id']]
    for d in want:
        if d not in slots:
            raise netutil.FetchError(f'{d}: sin habilidades')
    used = sorted({a for l in slots.values() for a in l if a})
    abil = {}
    for a in used:
        aid = next(i for i, n in ident.items() if n == a)
        n = names.get(aid, {})
        abil[a] = (n.get(LANG_ES) or n.get(LANG_EN) or a, n.get(LANG_EN) or a)
    mid = {r['identifier']: r['id'] for r in t['moves']}
    power = {r['identifier']: int(r['power']) if r['power'] else 0 for r in t['moves']}
    missing = [m for m in moves if m not in mid]
    if missing:
        raise netutil.FetchError('movimientos que PokeAPI no conoce: ' + ', '.join(missing))
    by_id = {mid[m]: m for m in moves}
    tm = {m: set() for m in moves}
    for r in t['pokemon_moves']:
        if r['pokemon_move_method_id'] != str(METHOD_MACHINE) or r['move_id'] not in by_id:
            continue
        d = int(r['pokemon_id'])
        if d in want:
            tm[by_id[r['move_id']]].add(d)
    tm_moves = {m: sorted(s) for m, s in tm.items() if s}
    tm_price = {m: (int(round((300 + 6 * power[m]) / 10.0)) * 10 if power[m] else 400) for m in tm_moves}
    return abil, slots, tm_moves, tm_price


def q(s):
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def render_abilities(abil, slots):
    out = [ABIL_HEADER]
    for a in sorted(abil):
        out.append('  %s: [%s, %s],\n' % (q(a) if '-' in a else a, q(abil[a][0]), q(abil[a][1])))
    out.append(ABIL_MID)
    for d in sorted(slots):
        out.append('  %d: [%s],\n' % (d, ', '.join(q(x) for x in slots[d])))
    out.append(ABIL_FOOTER)
    return ''.join(out)


def render_tms(tm_moves, tm_price):
    out = [TM_HEADER]
    for m in sorted(tm_moves):
        out.append('  %s: [%s],\n' % (q(m), ','.join(str(d) for d in tm_moves[m])))
    out.append(TM_MID)
    for m in sorted(tm_price):
        out.append('  %s: %d,\n' % (q(m), tm_price[m]))
    out.append(TM_FOOTER)
    return ''.join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Baja habilidades y MT de PokeAPI y escribe abilities.ts y tms.ts.')
    ap.add_argument('--out', help='carpeta donde escribir, en vez de src/data/')
    args = ap.parse_args(argv)
    outdir = args.out or os.path.join(ROOT, 'src', 'data')
    dexes, moves = [int(d) for d in our_dexes()], our_moves()
    print(f'Bajando las tablas de PokeAPI para {len(dexes)} Pokémon y {len(moves)} movimientos...')
    try:
        t = {n: rows(n) for n in ('abilities', 'ability_names', 'pokemon_abilities', 'moves', 'pokemon_moves')}
        data = build(dexes, moves, t)
    except netutil.FetchError as e:
        print('ERROR: no se escribe nada: %s' % e, file=sys.stderr)
        return 1
    os.makedirs(outdir, exist_ok=True)
    for name, text in (('abilities.ts', render_abilities(data[0], data[1])), ('tms.ts', render_tms(data[2], data[3]))):
        with io.open(os.path.join(outdir, name), 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
    print(f'{len(data[0])} habilidades, {len(data[2])} movimientos con MT.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
