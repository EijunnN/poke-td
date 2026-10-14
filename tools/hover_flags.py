#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Marca qué Pokémon FLOTAN de verdad en su sprite (y por tanto pueden pasar por
encima de rocas y agua) y cuáles caminan aunque sean de tipo Volador.

    python tools/hover_flags.py

Mira el primer fotograma de Idle (mirando abajo) de cada Pokémon: si el pixel
opaco más bajo queda claramente por encima del ancla del suelo (la sombra),
es que flota. Añade "hv":1 a esos Pokémon en src/data/sprites-meta.ts.

Lee y escribe el archivo con parse_sprites_meta() / render_sprites_meta() de
tools/fetch_sprites.py, así que el formato es el mismo que genera aquel script.
La parte que decide quién flota es mark_hover(), que no toca el disco salvo
para leer las hojas Idle.png de public/assets/pokemon/.
"""
import io
import os

from PIL import Image

from fetch_sprites import parse_sprites_meta, render_sprites_meta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
META = os.path.join(ROOT, 'src', 'data', 'sprites-meta.ts')
ASSETS = os.path.join(ROOT, 'public', 'assets', 'pokemon')
GAP = 1          # píxeles de arte entre los pies y el suelo (los que caminan dan <= -0,5)


def gap_of(dex, idle):
    path = os.path.join(ASSETS, str(dex), 'Idle.png')
    if not os.path.exists(path):
        return 0
    im = Image.open(path).convert('RGBA')
    w, h = idle['w'], idle['h']
    frame = im.crop((0, 0, w, h))
    alpha = frame.getchannel('A')
    bbox = alpha.point(lambda a: 255 if a > 40 else 0).getbbox()
    if not bbox:
        return 0
    bottom = bbox[3] - 1                     # fila del pixel opaco más bajo
    return idle['ay'] - bottom


def mark_hover(metas):
    """Pone o quita `hv` en cada ficha de {dex: ficha}. Devuelve los que flotan."""
    hovering = []
    for dex, data in metas.items():
        data.pop('hv', None)
        idle = data['a'].get('Idle') or data['a'].get('Walk')
        if idle and gap_of(dex, idle) >= GAP:
            data['hv'] = 1
            hovering.append(dex)
    return hovering


def main():
    with io.open(META, encoding='utf-8', newline='') as f:
        metas = parse_sprites_meta(f.read())
    hovering = mark_hover(metas)
    with io.open(META, 'w', encoding='utf-8', newline='\n') as f:
        f.write(render_sprites_meta(metas))
    print(f'{len(hovering)} Pokémon flotan')
    return hovering


if __name__ == '__main__':
    h = main()
    for d in [6, 12, 16, 41, 81, 92, 93, 94, 109, 151, 722, 18, 142, 249, 384]:
        print(d, 'flota' if d in h else 'camina')
