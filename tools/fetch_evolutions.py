#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Baja de PokeAPI las cadenas evolutivas y deja src/data/evolutions.ts.
A partir de ahi el juego no toca internet: todo es local.

    python tools/fetch_evolutions.py
    python tools/fetch_evolutions.py --only 133,25 --out /tmp/prueba   # sólo esas cadenas, fuera de src/

Se trabaja por especie (el número de Pokédex nacional es el id de la especie),
así que las formas regionales no cuentan como evolución aparte. Sólo entran los
Pokémon que están en src/data/pokedex.ts y tienen ficha en src/data/sprites-meta.ts:
una evolución sin sprite se omite.

Salida:
  EVOLUTIONS  dex -> dex en los que evoluciona directamente (orden de dex)
  STAGE       dex -> etapa dentro de su cadena (1 = básico, 2, 3), sólo para
              los que tienen evolución o preevolución. Es la profundidad en la
              cadena de PokeAPI, así que Pichu es 1, Pikachu 2 y Raichu 3.

El texto del .ts sale de render_evolutions(), una función pura (datos ->
texto); parse_evolutions() es su inversa. tools/check_generated.py las usa
para comprobar que el archivo actual es exactamente lo que generaría este script.
"""
import argparse
import io
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor

import netutil
import fetch_pokedex
import fetch_sprites

API = fetch_pokedex.API
ROOT = fetch_pokedex.ROOT
OUT = os.path.join(ROOT, 'src', 'data', 'evolutions.ts')
POKEDEX = os.path.join(ROOT, 'src', 'data', 'pokedex.ts')
SPRITES_META = os.path.join(ROOT, 'src', 'data', 'sprites-meta.ts')

# Todo lo que rodea a los datos en evolutions.ts: cabecera y registro en G.
# Cualquier cambio de formato se hace aqui.
HEADER = """import { G } from '../g';
/* ============ evolutions.ts — GENERADO, no editar a mano ============
 * Lo produce tools/fetch_evolutions.py. Las cadenas evolutivas se bajaron
 * una vez de PokeAPI y viven aqui: el juego no hace ninguna peticion a internet.
 *
 * EVOLUTIONS: dex -> dex en los que evoluciona directamente (por especie,
 *             las formas regionales no cuentan aparte). Sólo Pokémon con sprite.
 * STAGE:      dex -> etapa en su cadena (1 = básico, 2, 3), sólo para los que
 *             tienen evolución o preevolución.
 */
export const EVOLUTIONS: Record<number, number[]> = {
"""

MIDDLE = """};
G.EVOLUTIONS = EVOLUTIONS;

export const STAGE: Record<number, number> = {
"""

FOOTER = """};
G.STAGE = STAGE;

declare module '../g' {
  interface Registry {
    EVOLUTIONS: typeof EVOLUTIONS;
    STAGE: typeof STAGE;
  }
}
"""

EVO_LINE = re.compile(r'^  (\d+): \[([\d,]*)\],$')
STAGE_LINE = re.compile(r'^  (\d+): (\d+),$')


def render_evolutions(evolutions, stage):
    """({dex: [dex]}, {dex: etapa}) -> texto de evolutions.ts."""
    out = [HEADER]
    for d in sorted(evolutions):
        out.append(f"  {d}: [{','.join(map(str, evolutions[d]))}],\n")
    out.append(MIDDLE)
    for d in sorted(stage):
        out.append(f'  {d}: {stage[d]},\n')
    out.append(FOOTER)
    return ''.join(out)


def parse_evolutions(text):
    """Texto de evolutions.ts -> (EVOLUTIONS, STAGE) (inversa de render_evolutions)."""
    evolutions, stage, in_stage = {}, {}, False
    for ln in text.split('\n'):
        if ln.startswith('export const STAGE'):
            in_stage = True
        elif m := (STAGE_LINE if in_stage else EVO_LINE).match(ln):
            if in_stage:
                stage[int(m.group(1))] = int(m.group(2))
            else:
                evolutions[int(m.group(1))] = [int(x) for x in m.group(2).split(',') if x]
    return evolutions, stage


def species_id(node):
    """Número de Pokédex nacional (id de la especie) de un nodo de la cadena."""
    return int(node['species']['url'].rstrip('/').rsplit('/', 1)[1])


def build_evolutions(chains, allowed):
    """Cadenas de PokeAPI (los JSON de /evolution-chain/{id}) -> (EVOLUTIONS, STAGE).
    `allowed` son los dex que pueden salir: el resto (sin ficha o sin sprite) se omite."""
    evolutions, stage = {}, {}

    def walk(node, depth):
        src = species_id(node)
        for nxt in node['evolves_to']:
            dst = species_id(nxt)
            if src in allowed and dst in allowed:
                if dst not in evolutions.setdefault(src, []):
                    evolutions[src].append(dst)
                stage[src], stage[dst] = depth, depth + 1
            walk(nxt, depth + 1)

    for chain in chains:
        walk(chain['chain'], 1)
    return ({d: sorted(v) for d, v in sorted(evolutions.items())}, dict(sorted(stage.items())))


def validate(evolutions, stage, dexes):
    """Sanidad de datos (sin red): lista de problemas, vacía si todo está bien."""
    bad = []
    for d, tos in evolutions.items():
        if d not in dexes:
            bad.append(f'{d}: no está en la Pokédex')
        if tos != sorted(set(tos)):
            bad.append(f'{d}: evoluciones repetidas o sin ordenar {tos}')
        for t in tos:
            if t not in dexes:
                bad.append(f'{d} -> {t}: {t} no está en la Pokédex')
            if t == d:
                bad.append(f'{d}: evoluciona en sí mismo')
            if stage.get(t) != stage.get(d, 0) + 1:
                bad.append(f'{d} -> {t}: etapa {stage.get(t)} y debería ser {stage.get(d, 0) + 1}')
    for d, s in stage.items():
        if d not in dexes:
            bad.append(f'STAGE {d}: no está en la Pokédex')
        if s not in (1, 2, 3):
            bad.append(f'STAGE {d}: etapa {s} fuera de 1..3')
    involved = set(evolutions) | {t for tos in evolutions.values() for t in tos}
    if involved != set(stage):
        bad.append(f'STAGE y EVOLUTIONS no cubren los mismos Pokémon: {sorted(involved ^ set(stage))}')
    # Ciclos: seguir las evoluciones desde cada Pokémon nunca puede volver a él.
    for d in evolutions:
        seen, todo = set(), list(evolutions[d])
        while todo:
            x = todo.pop()
            if x == d:
                bad.append(f'{d}: ciclo en las evoluciones')
                break
            if x not in seen:
                seen.add(x)
                todo.extend(evolutions.get(x, []))
    return bad


def allowed_dexes():
    """Dex de la Pokédex que además tienen ficha de sprite."""
    with io.open(POKEDEX, encoding='utf-8') as f:
        dex = {r['dex'] for r in fetch_pokedex.parse_pokedex(f.read())}
    with io.open(SPRITES_META, encoding='utf-8') as f:
        sprites = set(fetch_sprites.parse_sprites_meta(f.read()))
    return dex & sprites


def get(url):
    """JSON de la url. Los fallos de red levantan FetchError (ver netutil.py);
    un 404 también, porque aquí todo lo que se pide tiene que existir."""
    data = netutil.get_json(url)
    if data is None:
        raise netutil.FetchError(f'{url} -> 404')
    return data


def chain_url_of(dex):
    """URL de la cadena evolutiva de la especie `dex`."""
    return get(f'{API}/pokemon-species/{dex}')['evolution_chain']['url']


def chain_urls():
    """URL de todas las cadenas de PokeAPI."""
    first = get(f'{API}/evolution-chain?limit=1')
    lst = get(f'{API}/evolution-chain?limit={first["count"]}')
    return [r['url'] for r in lst['results']]


def try_get(url):
    """get() sin dejar escapar el fallo: (json, None) o (None, mensaje)."""
    try:
        return get(url), None
    except Exception as e:
        return None, str(e)


def fetch_chains(urls, verbose=True):
    """Baja esas cadenas. Devuelve (cadenas, {url: motivo} de las que fallaron)."""
    chains, failed = [], {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        for i, (url, (c, err)) in enumerate(zip(urls, ex.map(try_get, urls)), 1):
            if err:
                failed[url] = err
            else:
                chains.append(c)
            if verbose and (i % 100 == 0 or i == len(urls)):
                print(f'  {i}/{len(urls)}')
    return chains, failed


def main(argv=None):
    ap = argparse.ArgumentParser(description='Baja las cadenas evolutivas de PokeAPI y escribe evolutions.ts.')
    ap.add_argument('--only', help='sólo las cadenas de estos números de Pokédex, separados por comas (exige --out)')
    ap.add_argument('--out', help='carpeta donde escribir evolutions.ts, en vez de src/data/')
    args = ap.parse_args(argv)
    if args.only and not args.out:
        ap.error('--only exige --out: no se sobrescribe src/data/evolutions.ts con un subconjunto')
    out = os.path.join(args.out, 'evolutions.ts') if args.out else OUT

    failed = {}
    try:
        if args.only:
            urls = sorted({chain_url_of(int(x)) for x in args.only.split(',')})
        else:
            urls = chain_urls()
        print(f'Bajando {len(urls)} cadenas evolutivas de PokeAPI...')
        chains, failed = fetch_chains(urls)
    except netutil.FetchError as e:
        failed = {'(lista de cadenas)': str(e)}
    if failed:
        print(f'\nERROR: no se pudieron bajar {len(failed)} cadenas; no se escribe {os.path.relpath(out, ROOT)}:', file=sys.stderr)
        for url, why in sorted(failed.items()):
            print(f'  {url}: {why}', file=sys.stderr)
        return 1

    evolutions, stage = build_evolutions(chains, allowed_dexes())
    problems = validate(evolutions, stage, allowed_dexes())
    if problems:
        print(f'\nERROR: datos incoherentes; no se escribe {os.path.relpath(out, ROOT)}:', file=sys.stderr)
        for p in problems:
            print(f'  {p}', file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(render_evolutions(evolutions, stage))

    print(f'\n{len(evolutions)} Pokemon con evolucion y {len(stage)} en alguna cadena, escritos en {os.path.relpath(out, ROOT)}')
    for s in (1, 2, 3):
        print(f'  etapa {s}: {sum(1 for v in stage.values() if v == s)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
