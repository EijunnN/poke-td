#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Baja de PokeAPI las cuatro estadísticas base que separan los ataques físicos de
los especiales (Ataque, Ataque Esp., Defensa y Defensa Esp.) de los Pokémon que
hay en src/data/pokedex.ts y las deja en src/data/base-stats.ts.

    python tools/fetch_stats.py
    python tools/fetch_stats.py --only 1,6,1024 --out /tmp/prueba   # sólo unos pocos, fuera de src/

Los números de Pokédex salen de pokedex.ts (hay que haberlo generado antes con
fetch_pokedex.py). Si algo falla en la red no se escribe nada.
"""
import argparse
import io
import os
import sys
from concurrent.futures import ThreadPoolExecutor

import fetch_pokedex
import netutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'src', 'data', 'base-stats.ts')
POKEDEX = os.path.join(ROOT, 'src', 'data', 'pokedex.ts')

HEADER = """import { G } from '../g';
/* ============ base-stats.ts — GENERADO, no editar a mano ============
 * Lo produce tools/fetch_stats.py con los stats base de PokeAPI.
 * Por Pokémon: [Ataque, Ataque Esp., Defensa, Defensa Esp.] de los juegos.
 * Deciden cuánto pega con ataques físicos y especiales y cuánto aguanta
 * los golpes de cada clase (ver entities/player.ts).
 */
/** [Ataque, Ataque Esp., Defensa, Defensa Esp.] base. */
export type BaseStats = readonly [atk: number, spa: number, def: number, spd: number];

export const BASE_STATS: Record<number, BaseStats> = {
"""

FOOTER = """};
G.BASE_STATS = BASE_STATS;

/** Stats base de un Pokémon; si faltara, uno corriente (70 en todo) para que nada se rompa. */
export const statsOf = (dex: number): BaseStats => BASE_STATS[dex] || [70, 70, 70, 70];
G.statsOf = statsOf;

declare module '../g' {
  interface Registry {
    BASE_STATS: typeof BASE_STATS;
    statsOf: typeof statsOf;
  }
}
"""


def render_stats(rows):
    """{dex: [atk, spa, def, spd]} -> texto de base-stats.ts."""
    out = [HEADER]
    for dex in sorted(rows):
        out.append('  %d: [%s],\n' % (dex, ', '.join(str(v) for v in rows[dex])))
    out.append(FOOTER)
    return ''.join(out)


def one(dex):
    p = netutil.get_json(f'{fetch_pokedex.API}/pokemon/{dex}')
    if p is None:
        raise netutil.FetchError(f'{dex} -> 404')
    s = {st['stat']['name']: st['base_stat'] for st in p['stats']}
    return [s['attack'], s['special-attack'], s['defense'], s['special-defense']]


def try_one(dex):
    try:
        return one(dex), None
    except Exception as e:
        return None, str(e)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Baja los stats base de PokeAPI y escribe base-stats.ts.')
    ap.add_argument('--only', help='sólo estos números de Pokédex, separados por comas (exige --out)')
    ap.add_argument('--out', help='carpeta donde escribir base-stats.ts, en vez de src/data/')
    args = ap.parse_args(argv)
    if args.only and not args.out:
        ap.error('--only exige --out: no se sobrescribe src/data/base-stats.ts con un subconjunto')
    out = os.path.join(args.out, 'base-stats.ts') if args.out else OUT

    if args.only:
        dexes = [int(x) for x in args.only.split(',')]
    else:
        with io.open(POKEDEX, encoding='utf-8') as f:
            dexes = [r['dex'] for r in fetch_pokedex.parse_pokedex(f.read())]

    print(f'Bajando los stats de {len(dexes)} Pokemon de PokeAPI...')
    rows, failed = {}, {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        for i, (dex, (r, err)) in enumerate(zip(dexes, ex.map(try_one, dexes)), 1):
            if err:
                failed[dex] = err
            else:
                rows[dex] = r
            if i % 100 == 0 or i == len(dexes):
                print(f'  {i}/{len(dexes)}')
    if failed:
        print(f'\nERROR: no se pudieron bajar {len(failed)} Pokemon; no se escribe {os.path.relpath(out, ROOT)}:', file=sys.stderr)
        for dex, why in sorted(failed.items()):
            print(f'  {dex}: {why}', file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(render_stats(rows))
    print(f'\n{len(rows)} Pokemon escritos en {os.path.relpath(out, ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
