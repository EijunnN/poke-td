#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Descarga los sprites estilo Mundo Misterioso de SpriteCollab (normal y shiny)
a public/assets/pokemon/ y genera src/data/sprites-meta.ts.

    python tools/fetch_sprites.py            # todos los que existan (1-1025)
    python tools/fetch_sprites.py 1 151      # sólo un rango de la Pokédex
    python tools/fetch_sprites.py --only 12,16 --out /tmp/prueba
                                             # sólo esos, y todo en otra carpeta (sin tocar el repo)
    python tools/fetch_sprites.py --only 494   # actualiza ese Pokémon en el repo (PNG y su ficha)

Se puede interrumpir y relanzar: lo ya bajado se reutiliza (tools/cache/).
Después hay que pasar tools/hover_flags.py, que añade `hv` (los que flotan).

El texto del .ts sale de render_sprites_meta(), una función pura (fichas ->
texto); parse_sprites_meta() es su inversa. tools/check_generated.py las usa
para comprobar que el archivo actual es exactamente lo que generaría este script.

Fuente: https://github.com/PMDCollab/SpriteCollab  (CC BY-NC 4.0)
Créditos: python tools/fetch_credits.py

Formato de SpriteCollab:
  sprite/{dex}/            sprite normal
  sprite/{dex}/0000/0001/  sprite shiny (forma 0000, variante 0001)
  - columnas = fotogramas, filas = 8 direcciones
    (Down, DownRight, Right, UpRight, Up, UpLeft, Left, DownLeft; verificado
     con los -Offsets.png)
  - cada animación tiene su propio tamaño de fotograma, así que se alinean por
    el ancla al suelo, que se saca del -Shadow.png

Las hojas se guardan como PNG con paleta (sin pérdida): ocupan la mitad.
"""
import argparse
import io
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

import netutil

RAW = 'https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master'
BASE = RAW + '/sprite'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_ASSETS = os.path.join(ROOT, 'public', 'assets', 'pokemon')
OUT_META = os.path.join(ROOT, 'src', 'data', 'sprites-meta.ts')
CACHE = os.path.join(ROOT, 'tools', 'cache')

# Todo lo que rodea a las fichas en sprites-meta.ts: cabecera con los tipos y
# el registro en G. Cualquier cambio de formato se hace aquí.
HEADER = """import { G } from '../g';
/* ============ sprites-meta.ts — GENERADO, no editar a mano ============
 * Lo produce tools/fetch_sprites.py a partir de los AnimData.xml de
 * SpriteCollab. Va en un .ts y no en un .json para que Vite lo empaquete
 * con el juego y los tipos de abajo lo describan.
 *
 * Por Pokémon:    s ShadowSize · a animaciones · sh=1 si hay shiny
 *                 sa geometría shiny que difiera de la normal (raro)
 *                 sm animaciones que le faltan al shiny
 *                 hv=1 si flota en su sprite (tools/hover_flags.py):
 *                 pasa por encima de rocas y agua
 * Por animación:  w,h fotograma · n fotogramas · r filas
 *                 d duración de cada fotograma (1/60 s)
 *                 ax,ay ancla al suelo dentro del fotograma
 * Filas: 0 Down · 1 DownRight · 2 Right · 3 UpRight
 *        4 Up   · 5 UpLeft    · 6 Left  · 7 DownLeft
 */
/** Animación de un Pokémon (ver cabecera). */
export interface SpriteAnim {
  w: number;
  h: number;
  n: number;
  r: number;
  d: number[];
  ax: number;
  ay: number;
}

/** Las 7 animaciones de cada Pokémon. */
export type AnimName = 'Idle' | 'Walk' | 'Attack' | 'Shoot' | 'Charge' | 'Hurt' | 'Faint';

/** Ficha de sprite de un Pokémon (ver cabecera). */
export interface SpriteMeta {
  s: number;
  a: Record<AnimName, SpriteAnim>;
  sh?: number;
  hv?: number;
  sa?: Partial<Record<AnimName, SpriteAnim>>;
  sm?: string[];
}

export const SPRITE_META: Record<number, SpriteMeta> = {
"""

FOOTER = """};
G.SPRITE_META = SPRITE_META;

declare module '../g' {
  interface Registry { SPRITE_META: typeof SPRITE_META }
}
"""

META_LINE = re.compile(r'^  (\d+): (\{.*\}),$')


def render_sprites_meta(metas):
    """{dex: ficha} -> texto de sprites-meta.ts (las claves de cada ficha, en su orden)."""
    out = [HEADER]
    for dex in sorted(metas):
        out.append(f'  {dex}: {json.dumps(metas[dex], separators=(",", ":"))},\n')
    out.append(FOOTER)
    return ''.join(out)


def parse_sprites_meta(text):
    """Texto de sprites-meta.ts -> {dex: ficha} (inversa de render_sprites_meta)."""
    metas = {}
    for ln in text.split('\n'):
        m = META_LINE.match(ln)
        if m:
            metas[int(m.group(1))] = json.loads(m.group(2))
    return metas

WANT = ['Idle', 'Walk', 'Attack', 'Shoot', 'Charge', 'Hurt', 'Faint']
FALLBACK = {
    'Idle': ['Walk'],
    'Walk': ['Idle'],
    'Attack': ['Strike', 'Swing', 'Shoot', 'Idle'],
    'Shoot': ['Attack', 'Strike', 'Idle'],
    'Charge': ['DeepBreath', 'Idle'],
    'Hurt': ['Cringe', 'Idle'],
    'Faint': ['Hurt', 'Idle'],
}
REQUIRED = {'Idle', 'Walk', 'Attack'}


def fetch(url):
    """Bytes de la url; None si SpriteCollab dice que no existe (404).
    Cualquier otro fallo levanta netutil.FetchError tras reintentar."""
    return netutil.get_bytes(url)


def parse_animdata(xml):
    anims = {}
    for blk in re.findall(r'<Anim>(.*?)</Anim>', xml, re.S):
        name = re.search(r'<Name>(\w+)</Name>', blk)
        if not name:
            continue
        name = name.group(1)
        copy = re.search(r'<CopyOf>(\w+)</CopyOf>', blk)
        if copy:
            anims[name] = {'copyOf': copy.group(1)}
            continue
        fw = re.search(r'<FrameWidth>(\d+)</FrameWidth>', blk)
        fh = re.search(r'<FrameHeight>(\d+)</FrameHeight>', blk)
        if not (fw and fh):
            continue
        durs = [int(x) for x in re.findall(r'<Duration>(\d+)</Duration>', blk)]
        anims[name] = {'w': int(fw.group(1)), 'h': int(fh.group(1)), 'n': len(durs), 'd': durs}
    shadow = re.search(r'<ShadowSize>(\d+)</ShadowSize>', xml)
    return anims, int(shadow.group(1)) if shadow else 1


def resolve(anims, name, seen=None):
    seen = seen or set()
    if name not in anims or name in seen:
        return None, None
    seen.add(name)
    a = anims[name]
    if 'copyOf' in a:
        return resolve(anims, a['copyOf'], seen)
    return name, a


def ground_anchor(png, w, h):
    try:
        im = Image.open(io.BytesIO(png)).convert('RGBA')
    except Exception as e:
        # Una sombra bajada a medias daría un ancla inventada sin avisar.
        raise netutil.FetchError(f'Shadow.png ilegible: {e!r}')
    px = im.crop((0, 0, w, h)).load()
    xs = ys = n = 0
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > 40:
                xs += x; ys += y; n += 1
    return (round(xs / n, 1), round(ys / n, 1)) if n else None


def save_optimized(png, path):
    """Guarda como PNG con paleta exacta (sin pérdida). Devuelve (ancho, alto)."""
    im = Image.open(io.BytesIO(png)).convert('RGBA')
    cols = im.getcolors(256)
    if cols is None:                          # más de 256 colores: tal cual
        im.save(path, 'PNG', optimize=True)
        return im.size
    colors = [c for _, c in cols]
    # El transparente primero: algunos lectores lo agradecen.
    colors.sort(key=lambda c: c[3])
    idx = {c: i for i, c in enumerate(colors)}
    pim = Image.new('P', im.size)
    data = im.get_flattened_data() if hasattr(im, 'get_flattened_data') else im.getdata()
    pim.putdata([idx[p] for p in data])
    flat = []
    for c in colors:
        flat += c[:3]
    pim.putpalette(flat + [0] * (768 - len(flat)))
    pim.save(path, 'PNG', optimize=True, transparency=bytes(c[3] for c in colors))
    return im.size


def download_set(url_base, out_dir, anims, geometry_from=None):
    """Baja las animaciones de WANT desde url_base. `geometry_from` reutiliza
    las anclas del sprite normal (el shiny es el mismo dibujo recoloreado)."""
    os.makedirs(out_dir, exist_ok=True)
    meta = {}
    for want in WANT:
        src, geom = None, None
        for cand in [want] + FALLBACK[want]:
            src, geom = resolve(anims, cand)
            if geom:
                break
        if not geom:
            continue
        png = fetch(f'{url_base}/{src}-Anim.png')
        if not png:
            continue
        path = os.path.join(out_dir, want + '.png')
        w, h = save_optimized(png, path)
        cols, rows = w // geom['w'], h // geom['h']
        if rows < 1 or cols < 1:
            os.remove(path)
            continue

        ref = geometry_from.get(want) if geometry_from else None
        if ref and ref['w'] == geom['w'] and ref['h'] == geom['h']:
            ax, ay = ref['ax'], ref['ay']
        else:
            sh = fetch(f'{url_base}/{src}-Shadow.png')
            anchor = ground_anchor(sh, geom['w'], geom['h']) if sh else None
            ax, ay = (anchor if anchor else (geom['w'] / 2, geom['h'] * 0.78))
        meta[want] = {'w': geom['w'], 'h': geom['h'], 'n': min(geom['n'], cols), 'r': rows,
                      'd': geom['d'][:cols], 'ax': ax, 'ay': ay}
    return meta


def do_dex(job):
    """(dex, ficha) o (dex, None) si no hay sprites; (dex, FetchError) si falló la descarga."""
    try:
        return do_dex_inner(job)
    except Exception as e:
        return job[0], netutil.FetchError(f'{job[0]}: {e}')


def do_dex_inner(job):
    dex, want_shiny = job
    cache_file = os.path.join(CACHE, f'{dex}.json')
    out_dir = os.path.join(OUT_ASSETS, str(dex))
    if os.path.exists(cache_file):
        meta = json.load(open(cache_file, encoding='utf-8'))
        if all(os.path.exists(os.path.join(out_dir, a + '.png')) for a in meta['a']):
            return dex, meta

    tag = f'{dex:04d}'
    xml = fetch(f'{BASE}/{tag}/AnimData.xml')
    if not xml:
        return dex, None
    anims, shadow = parse_animdata(xml.decode('utf-8', 'replace'))
    normal = download_set(f'{BASE}/{tag}', out_dir, anims)
    if not REQUIRED & set(normal):
        return dex, None
    meta = {'s': shadow, 'a': normal}

    if want_shiny:
        sxml = fetch(f'{BASE}/{tag}/0000/0001/AnimData.xml')
        sanims = parse_animdata(sxml.decode('utf-8', 'replace'))[0] if sxml else anims
        shiny = download_set(f'{BASE}/{tag}/0000/0001', os.path.join(out_dir, 's'), sanims, normal)
        if REQUIRED <= set(shiny) or ('Idle' in shiny and 'Walk' in shiny):
            meta['sh'] = 1
            # Sólo se guarda la geometría shiny si difiere de la normal.
            diff = {k: v for k, v in shiny.items() if normal.get(k) != v}
            if diff:
                meta['sa'] = diff
            missing_s = [k for k in normal if k not in shiny]
            if missing_s:
                meta['sm'] = missing_s

    with open(cache_file, 'w', encoding='utf-8') as f:
        json.dump(meta, f, separators=(',', ':'))
    return dex, meta


def main(argv=None):
    global OUT_ASSETS, OUT_META, CACHE
    ap = argparse.ArgumentParser(description='Baja los sprites de SpriteCollab y escribe sprites-meta.ts.')
    ap.add_argument('lo', nargs='?', type=int, default=1, help='primer número de Pokédex (1)')
    ap.add_argument('hi', nargs='?', type=int, default=1025, help='último número de Pokédex (1025)')
    ap.add_argument('--only', help='sólo estos números de Pokédex, separados por comas. Sin --out los '
                                   'actualiza en su sitio: baja sus PNG a public/assets/pokemon y cambia '
                                   'sólo sus fichas en src/data/sprites-meta.ts (luego, hover_flags.py)')
    ap.add_argument('--out', help='carpeta de trabajo (pokemon/, cache/ y sprites-meta.ts) en vez de '
                                  'public/assets/pokemon, tools/cache y src/data')
    args = ap.parse_args(argv)
    if args.out:
        OUT_ASSETS = os.path.join(args.out, 'pokemon')
        OUT_META = os.path.join(args.out, 'sprites-meta.ts')
        CACHE = os.path.join(args.out, 'cache')
    lo, hi = args.lo, args.hi
    only = {int(x) for x in args.only.split(',')} if args.only else None
    os.makedirs(OUT_ASSETS, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)

    print('Leyendo tracker.json de SpriteCollab...')
    try:
        raw = fetch(RAW + '/tracker.json')
        if raw is None:
            raise netutil.FetchError('tracker.json -> 404')
        tracker = json.loads(raw.decode('utf-8'))
    except Exception as e:
        print(f'ERROR: no se pudo leer tracker.json: {e}', file=sys.stderr)
        return 1
    jobs = []
    for dex in sorted(only) if only else range(lo, hi + 1):
        e = tracker.get(f'{dex:04d}')
        if not e or not REQUIRED <= set(e.get('sprite_files', {})):
            continue
        s = e.get('subgroups', {}).get('0000', {}).get('subgroups', {}).get('0001', {})
        jobs.append((dex, {'Idle', 'Walk'} <= set(s.get('sprite_files', {}))))
    print(f'{len(jobs)} Pokemon con sprites en {args.only or f"{lo}-{hi}"} ({sum(1 for _, s in jobs if s)} con shiny)')

    metas, failed, done = {}, {}, 0
    with ThreadPoolExecutor(max_workers=16) as ex:
        for dex, meta in ex.map(do_dex, jobs):
            done += 1
            if isinstance(meta, Exception):
                failed[dex] = str(meta)
            elif meta:
                metas[dex] = meta
            else:
                # El tracker dice que tiene sprites y no salió ninguno: algo no cuadra.
                failed[dex] = 'sin AnimData.xml o sin animaciones Idle/Walk/Attack'
            if done % 50 == 0 or done == len(jobs):
                print(f'  {done}/{len(jobs)}', flush=True)

    if failed:
        # Lo ya bajado queda en caché: relanzando sólo se repite lo que falló.
        print(f'\nERROR: fallaron {len(failed)} Pokemon; no se escribe {os.path.relpath(OUT_META, ROOT)}:', file=sys.stderr)
        for dex, why in sorted(failed.items()):
            print(f'  {dex}: {why}', file=sys.stderr)
        return 1

    if only and not args.out:
        # Actualización en su sitio: el resto de fichas se quedan como están.
        with io.open(OUT_META, encoding='utf-8', newline='') as f:
            rest = parse_sprites_meta(f.read())
        rest.update(metas)
        metas = rest

    # Compatibilidad con cachés antiguas: anota qué le falta al shiny.
    for dex, m in metas.items():
        if m.get('sh') and 'sm' not in m:
            sdir = os.path.join(OUT_ASSETS, str(dex), 's')
            miss = [k for k in m['a'] if not os.path.exists(os.path.join(sdir, k + '.png'))]
            if miss:
                m['sm'] = miss

    # Funde con lo que ya hubiera en caché fuera del rango pedido.
    for fn in os.listdir(CACHE):
        d = int(fn.split('.')[0])
        if d not in metas and os.path.isdir(os.path.join(OUT_ASSETS, str(d))):
            metas[d] = json.load(open(os.path.join(CACHE, fn), encoding='utf-8'))

    with io.open(OUT_META, 'w', encoding='utf-8', newline='\n') as f:
        f.write(render_sprites_meta(metas))

    size = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fns in os.walk(OUT_ASSETS) for fn in fns)
    print(f'\n{len(metas)} Pokemon ({sum(1 for m in metas.values() if m.get("sh"))} con shiny), {size / 1e6:.1f} MB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
