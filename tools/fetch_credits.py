#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera CREDITS.md con los artistas de cada sprite descargado.

    python tools/fetch_credits.py
    python tools/fetch_credits.py --only 12,16 --out /tmp/prueba   # sólo esos, fuera del repo
    python tools/fetch_credits.py --only 494                       # actualiza ese Pokémon en CREDITS.md

Cada carpeta de SpriteCollab tiene un credits.txt (sin cabecera) con lineas
    fecha <TAB> autor <TAB> ...
donde el autor es un nombre o un ID de Discord ("<@!123...>"). Los IDs se
traducen con el credit_names.txt de la raiz del repo.

El texto de CREDITS.md sale de render_credits(), una funcion pura (artistas ->
texto); parse_credits() es su inversa. tools/check_generated.py las usa para
comprobar que el archivo actual es exactamente lo que generaria este script.
"""
import argparse
import io
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor

import netutil

RAW = 'https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'public', 'assets', 'pokemon')
OUT = os.path.join(ROOT, 'CREDITS.md')

INTRO = """# Créditos

## Sprites

Los sprites estilo *Pokémon Mundo Misterioso* vienen de
[SpriteCollab](https://github.com/PMDCollab/SpriteCollab), bajo licencia
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/):
uso **no comercial** y con atribución a sus artistas.

| Artista | Contacto | Sprites (nº de Pokédex) |
|---|---|---|
"""

OUTRO = """
## Datos

Stats base y nombres en español: [PokeAPI](https://pokeapi.co/),
descargados una vez y guardados en `src/data/pokedex.ts`.

## Fuente

[Pixelify Sans](https://github.com/eifetx/Pixelify-Sans) (SIL Open Font License 1.1,
licencia en `public/assets/fonts/OFL.txt`). El juego usa una versión modificada,
"Pixelify PS", con los números redibujados para distinguirlos mejor
(`tools/make_font.py`).

## Marca

Pokémon es propiedad de Nintendo, Creatures Inc. y GAME FREAK.
Este es un proyecto de fan sin ánimo de lucro.
"""

ROW = re.compile(r'^\| (.*) \| (.*) \| ([0-9, ]+) \|$')


def render_credits(per_artist):
    """{(nombre, contacto): {dex, ...}} -> texto de CREDITS.md."""
    out = [INTRO]
    for (display, contact), dx in sorted(per_artist.items(), key=lambda kv: kv[0][0].lower()):
        nums = ', '.join(str(d) for d in sorted(dx))
        out.append(f'| {display} | {contact} | {nums} |\n')
    out.append(OUTRO)
    return ''.join(out)


def parse_credits(text):
    """Texto de CREDITS.md -> {(nombre, contacto): {dex, ...}} (inversa de render_credits)."""
    per_artist = {}
    for ln in text.split('\n'):
        m = ROW.match(ln)
        if m:
            per_artist[(m.group(1), m.group(2))] = {int(n) for n in m.group(3).split(', ')}
    return per_artist


def fetch(url):
    """Texto de la url; None si SpriteCollab dice que no existe (404).
    Cualquier otro fallo levanta netutil.FetchError tras reintentar."""
    data = netutil.get_bytes(url, timeout=40)
    return None if data is None else data.decode('utf-8', 'replace')


def fetch_per_artist(dexes, assets=ASSETS):
    """Baja los créditos de esos Pokémon.
    Devuelve ({(nombre, contacto): {dex, ...}}, {dex: motivo} de los que fallaron).
    `assets` es donde se mira si el Pokémon tiene shiny (carpeta `s/`).
    Si no se puede bajar credit_names.txt levanta FetchError: sin él los IDs de
    Discord saldrían sin traducir."""
    # ID de Discord / alias -> (nombre visible, contacto)
    names = {}
    raw_names = fetch(f'{RAW}/credit_names.txt')
    if raw_names is None:
        raise netutil.FetchError('credit_names.txt -> 404')
    for line in raw_names.splitlines()[1:]:
        parts = line.split('\t')
        if len(parts) >= 2:
            display = parts[0].strip()
            contact = parts[2].strip() if len(parts) > 2 else ''
            names[parts[1].strip()] = (display, contact)
            names[display] = (display, contact)

    def one(dex):
        # Créditos del sprite normal y del shiny (que puede ser de otro artista).
        txt = fetch(f'{RAW}/sprite/{dex:04d}/credits.txt')
        if txt is None:
            raise netutil.FetchError(f'sprite/{dex:04d}/credits.txt -> 404')
        if os.path.isdir(os.path.join(assets, str(dex), 's')):
            # Un shiny sin credits.txt propio (404) es un dato válido: sin créditos extra.
            txt += '\n' + (fetch(f'{RAW}/sprite/{dex:04d}/0000/0001/credits.txt') or '')
        authors = []
        for line in txt.splitlines():
            parts = line.split('\t')
            a = parts[1].strip() if len(parts) > 1 else ''
            if a and names.get(a, (a, ''))[0]:
                authors.append(a)
        return authors

    def try_one(dex):
        try:
            return one(dex), None
        except Exception as e:
            return None, str(e)

    per_artist, failed = {}, {}
    with ThreadPoolExecutor(max_workers=12) as ex:
        for dex, (authors, err) in zip(dexes, ex.map(try_one, dexes)):
            if err:
                failed[dex] = err
                continue
            for a in set(authors):
                display, contact = names.get(a, (a, ''))
                per_artist.setdefault((display, contact), set()).add(dex)
    return per_artist, failed


def main(argv=None):
    ap = argparse.ArgumentParser(description='Genera CREDITS.md con los artistas de cada sprite.')
    ap.add_argument('--only', help='sólo estos números de Pokédex, separados por comas. Sin --out '
                                   'actualiza sus filas en CREDITS.md y deja las demás como están')
    ap.add_argument('--out', help='carpeta donde escribir CREDITS.md, en vez de la raíz del repo')
    args = ap.parse_args(argv)
    out = os.path.join(args.out, 'CREDITS.md') if args.out else OUT
    if args.only:
        dexes = sorted(int(x) for x in args.only.split(','))
    else:
        dexes = sorted(int(d) for d in os.listdir(ASSETS) if d.isdigit())

    try:
        per_artist, failed = fetch_per_artist(dexes)
    except netutil.FetchError as e:
        print(f'ERROR: {e}; no se escribe {os.path.relpath(out, ROOT)}', file=sys.stderr)
        return 1
    if failed:
        print(f'\nERROR: no se pudieron bajar los créditos de {len(failed)} Pokemon; '
              f'no se escribe {os.path.relpath(out, ROOT)}:', file=sys.stderr)
        for dex, why in sorted(failed.items()):
            print(f'  {dex}: {why}', file=sys.stderr)
        return 1

    if args.only and not args.out:
        # Actualización en su sitio: se quitan esos Pokémon de todos los artistas y se
        # ponen los recién bajados; lo demás queda igual.
        with io.open(OUT, encoding='utf-8', newline='') as f:
            rest = parse_credits(f.read())
        rest = {k: v - set(dexes) for k, v in rest.items()}
        for k, v in per_artist.items():
            rest[k] = rest.get(k, set()) | v
        per_artist = {k: v for k, v in rest.items() if v}

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(render_credits(per_artist))

    print(f'{len(per_artist)} artistas para {len(dexes)} Pokemon -> {os.path.relpath(out, ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
