#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Baja una sola vez los datos de PokeAPI y los deja en src/data/pokedex.ts.
A partir de ahi el juego no toca internet: todo es local.

    python tools/fetch_pokedex.py
    python tools/fetch_pokedex.py --only 1,6,1024 --out /tmp/prueba   # sólo unos pocos, fuera de src/

Trae nombre en espanol, tipos, stats base y altura, y de ahi deriva los stats
del juego y la rareza para el gacha.

El texto del .ts sale de render_pokedex(), una funcion pura (filas -> texto);
parse_pokedex() es su inversa. tools/check_generated.py las usa para comprobar
que el archivo actual sigue siendo exactamente lo que generaria este script.
"""
import argparse
import io
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor

import netutil

API = 'https://pokeapi.co/api/v2'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'src', 'data', 'pokedex.ts')

STARTERS = {1, 4, 7, 152, 155, 158, 252, 255, 258, 387, 390, 393, 495, 498, 501,
            650, 653, 656, 722, 725, 728, 810, 813, 816, 906, 909, 912, 54, 79}
# Último Pokémon de cada generación.
GEN_END = [151, 251, 386, 493, 649, 721, 809, 905, 1025]

# Todo lo que rodea a las filas en pokedex.ts: cabecera con los tipos y el
# registro en G. Cualquier cambio de formato se hace aqui.
HEADER = """import { G } from '../g';
import type { PokeType } from './types';
/* ============ pokedex.ts — GENERADO, no editar a mano ============
 * Lo produce tools/fetch_pokedex.py. Los datos se bajaron una vez de
 * PokeAPI y viven aqui: el juego no hace ninguna peticion a internet.
 *
 * hp/spd/atk son stats de juego derivados de los stats base.
 * rarity 1-5 para el gacha · gen = generación (banner) · starter = test
 * leg = legendario o singular (sólo salen en las grietas)
 */
/** Una fila de la Pokédex (ver cabecera). `leg` sólo en legendarios y singulares. */
export interface Pokemon {
  dex: number;
  name: string;
  types: PokeType[];
  hp: number;
  spd: number;
  atk: number;
  rarity: 1 | 2 | 3 | 4 | 5;
  bst: number;
  starter: boolean;
  gen: number;
  leg?: true;
}

export const DEX: Pokemon[] = [
"""

FOOTER = """];
G.DEX = DEX;

export const DEX_BY: Record<number, Pokemon> = {};
G.DEX_BY = DEX_BY;
for (const p of DEX) DEX_BY[p.dex] = p;
export const getPokemon = (dex: number): Pokemon | undefined => DEX_BY[dex];
G.getPokemon = getPokemon;

declare module '../g' {
  interface Registry {
    DEX: typeof DEX;
    DEX_BY: typeof DEX_BY;
    getPokemon: typeof getPokemon;
  }
}
"""

ROW = re.compile(r'^  (\{.*\}),$')


def render_pokedex(rows):
    """Filas (como las devuelve one(); `leg` puede faltar) -> texto de pokedex.ts."""
    out = [HEADER]
    for r in rows:
        o = {
            'dex': r['dex'], 'name': r['name'], 'types': r['types'],
            'hp': r['hp'], 'spd': r['spd'], 'atk': r['atk'],
            'rarity': r['rarity'], 'bst': r['bst'],
            'starter': r['starter'], 'gen': r['gen'],
        }
        if r.get('leg'):
            o['leg'] = True
        out.append('  ' + json.dumps(o, ensure_ascii=False, separators=(',', ':')) + ',\n')
    out.append(FOOTER)
    return ''.join(out)


def parse_pokedex(text):
    """Texto de pokedex.ts -> filas (inversa de render_pokedex)."""
    return [json.loads(m.group(1)) for m in map(ROW.match, text.split('\n')) if m]


def gen_of(dex):
    for g, end in enumerate(GEN_END, 1):
        if dex <= end:
            return g
    return 9


def dexes_with_sprites():
    """Sólo los que tienen sprite de Mundo Misterioso (según SpriteCollab)."""
    url = 'https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/tracker.json'
    t = get(url)
    need = {'Idle', 'Walk', 'Attack'}
    return [d for d in range(1, 1026) if need <= set(t.get(f'{d:04d}', {}).get('sprite_files', {}))]


def get(url):
    """JSON de la url. Los fallos de red levantan FetchError (ver netutil.py);
    un 404 también, porque aquí todo lo que se pide tiene que existir."""
    data = netutil.get_json(url)
    if data is None:
        raise netutil.FetchError(f'{url} -> 404')
    return data


def rarity(bst, dex, is_legendary, is_mythical):
    """5 estrellas = legendarios y pseudolegendarios; 1 = los mas comunes."""
    if is_mythical or is_legendary:
        return 5
    if bst >= 580:
        return 5
    if bst >= 495:
        return 4
    if bst >= 410:
        return 3
    if bst >= 320:
        return 2
    return 1


def one(dex):
    p = get(f'{API}/pokemon/{dex}')
    s = get(f'{API}/pokemon-species/{dex}')

    base = {st['stat']['name']: st['base_stat'] for st in p['stats']}
    bst = sum(base.values())

    name_es = p['name'].capitalize()
    for n in s.get('names', []):
        if n['language']['name'] == 'es':
            name_es = n['name']
            break

    # --- stats del juego a partir de los stats base ---
    hp = round(70 + base['hp'] * 0.45)
    spd = round(78 + base['speed'] * 0.42)
    atk = round(0.70 + max(base['attack'], base['special-attack']) / 100 * 0.55, 2)

    return {
        'dex': dex,
        'name': name_es,
        'slug': p['name'],
        'types': [t['type']['name'] for t in p['types']],
        'hp': hp,
        'spd': spd,
        'atk': atk,
        'bst': bst,
        'height': p['height'],
        'rarity': rarity(bst, dex, s.get('is_legendary'), s.get('is_mythical')),
        'starter': dex in STARTERS,
        'gen': gen_of(dex),
        'leg': bool(s.get('is_legendary') or s.get('is_mythical')),
    }


def try_one(dex):
    """one() sin dejar escapar el fallo: (fila, None) o (None, mensaje)."""
    try:
        return one(dex), None
    except Exception as e:
        return None, str(e)


def fetch_rows(dexes, verbose=True):
    """Baja las filas de esos Pokémon de PokeAPI.
    Devuelve (filas ordenadas por número, {dex: motivo} de los que fallaron)."""
    rows, failed = [], {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        for i, (dex, (r, err)) in enumerate(zip(dexes, ex.map(try_one, dexes)), 1):
            if err:
                failed[dex] = err
            else:
                rows.append(r)
            if verbose and (i % 100 == 0 or i == len(dexes)):
                print(f'  {i}/{len(dexes)}')
    rows.sort(key=lambda r: r['dex'])
    return rows, failed


def main(argv=None):
    ap = argparse.ArgumentParser(description='Baja la Pokédex de PokeAPI y escribe pokedex.ts.')
    ap.add_argument('--only', help='sólo estos números de Pokédex, separados por comas (exige --out)')
    ap.add_argument('--out', help='carpeta donde escribir pokedex.ts, en vez de src/data/')
    args = ap.parse_args(argv)
    if args.only and not args.out:
        ap.error('--only exige --out: no se sobrescribe src/data/pokedex.ts con un subconjunto')
    out = os.path.join(args.out, 'pokedex.ts') if args.out else OUT
    dexes = [int(x) for x in args.only.split(',')] if args.only else dexes_with_sprites()

    print(f'Bajando {len(dexes)} Pokemon de PokeAPI...')
    rows, failed = fetch_rows(dexes)
    if failed:
        print(f'\nERROR: no se pudieron bajar {len(failed)} Pokemon; no se escribe {os.path.relpath(out, ROOT)}:', file=sys.stderr)
        for dex, why in sorted(failed.items()):
            print(f'  {dex}: {why}', file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(render_pokedex(rows))

    print(f'\n{len(rows)} Pokemon escritos en {os.path.relpath(out, ROOT)}')
    print('\nrareza por generacion (1* 2* 3* 4* 5*):')
    for g in range(1, 10):
        c = [sum(1 for x in rows if x['gen'] == g and x['rarity'] == r) for r in range(1, 6)]
        print(f'  gen {g}: {c}  total {sum(c)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
