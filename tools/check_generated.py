#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Comprueba que los archivos generados siguen siendo lo que producen sus scripts.

    python tools/check_generated.py

Sin red ni descargas: lee los datos de los archivos actuales, los vuelve a
escribir con las funciones puras de cada generador y exige el mismo texto,
byte a byte:

  - src/data/pokedex.ts       <- fetch_pokedex.render_pokedex
  - src/data/sprites-meta.ts  <- fetch_sprites.render_sprites_meta
  - src/data/evolutions.ts    <- fetch_evolutions.render_evolutions, más sanidad de
                                 datos (todo en la Pokédex, sin ciclos, STAGE coherente)
  - hover_flags.mark_hover    sobre public/assets/pokemon/ no cambia nada
  - CREDITS.md                <- fetch_credits.render_credits
  - public/assets/icons/*.png <- make_icons.icon (píxel a píxel)
  - los fetch_* ante un fallo de red (simulado, sin red): terminan con error,
    nombran el Pokémon y no escriben el archivo

Opciones, más lentas (escriben sólo en una carpeta temporal, nunca en el repo):

  --fuentes  regenera las .ttf con make_font.py y las compara con las de
             public/assets/fonts tabla a tabla (glifos incluidos), ignorando
             head.modified y el checksum, que cambian en cada generación.
  --red      descarga unos pocos Pokémon (REDES) con los fetch_* y compara con
             lo que hay: filas de la Pokédex, cadenas evolutivas (EVO_REDES), fichas de sprites-meta (sin `hv`,
             que lo pone hover_flags), PNG píxel a píxel y créditos. Si PokeAPI
             o SpriteCollab ya no devuelven lo mismo, falla y dice qué difiere.
  --pokemon  con --red, otros Pokémon: --red --pokemon 494,847,908
  --todo     todo lo anterior.

Sale con código 1 si algo difiere (y enseña la primera línea distinta).
Sin opciones no usa red y no escribe nada en disco.
"""
import argparse
import contextlib
import io
import urllib.error
import urllib.request
import os
import sys
import tempfile

from fontTools.ttLib import TTFont
from PIL import Image, ImageChops

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fetch_credits       # noqa: E402
import fetch_evolutions    # noqa: E402
import fetch_pokedex       # noqa: E402
import fetch_sprites       # noqa: E402
import hover_flags         # noqa: E402
import make_font           # noqa: E402
import netutil             # noqa: E402
import make_icons          # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Para --red: uno con hv y shiny (12), shiny con geometría distinta (16 y 909, tienen `sa`),
# sin shiny (588), legendario (144) y de gen 9 (909).
REDES = [12, 16, 144, 588, 909]
# Para --red, cadenas evolutivas: lineal de tres (1), con preevolución (25), Eevee (133),
# Tyrogue (236) y Wurmple (265), ramificadas, y uno sin evolución (150).
EVO_REDES = [1, 25, 133, 236, 265, 150]


def read(path):
    with io.open(path, encoding='utf-8', newline='') as f:     # sin traducir saltos de línea
        return f.read()


def first_diff(want, got):
    """Descripción de la primera línea que difiere (o de la longitud)."""
    a, b = want.split('\n'), got.split('\n')
    for i, (x, y) in enumerate(zip(a, b), 1):
        if x != y:
            return f'línea {i}:\n    archivo:  {x[:200]}\n    generado: {y[:200]}'
    return f'mismo comienzo pero {len(a)} líneas en el archivo y {len(got.split(chr(10)))} generadas'


def same_text(label, current, generated):
    if current == generated:
        print(f'OK     {label}')
        return True
    print(f'FALLA  {label}: {first_diff(current, generated)}')
    return False


def check_pokedex():
    path = os.path.join(ROOT, 'src', 'data', 'pokedex.ts')
    text = read(path)
    rows = fetch_pokedex.parse_pokedex(text)
    if not rows:
        print('FALLA  src/data/pokedex.ts: no se encontró ninguna fila')
        return False
    return same_text(f'src/data/pokedex.ts ({len(rows)} filas)', text, fetch_pokedex.render_pokedex(rows))


def check_evolutions():
    path = os.path.join(ROOT, 'src', 'data', 'evolutions.ts')
    text = read(path)
    evolutions, stage = fetch_evolutions.parse_evolutions(text)
    if not evolutions:
        print('FALLA  src/data/evolutions.ts: no se encontró ninguna evolución')
        return False
    ok = same_text(f'src/data/evolutions.ts ({len(evolutions)} con evolución, {len(stage)} en alguna cadena)',
                   text, fetch_evolutions.render_evolutions(evolutions, stage))
    dexes = {r['dex'] for r in fetch_pokedex.parse_pokedex(read(os.path.join(ROOT, 'src', 'data', 'pokedex.ts')))}
    problems = fetch_evolutions.validate(evolutions, stage, dexes)
    for p in problems[:10]:
        print(f'FALLA  evolutions.ts: {p}')
    if not problems:
        print('OK     evolutions.ts: todo en la Pokédex, sin ciclos y STAGE coherente con EVOLUTIONS')
    return ok and not problems


def check_sprites_meta():
    path = os.path.join(ROOT, 'src', 'data', 'sprites-meta.ts')
    text = read(path)
    metas = fetch_sprites.parse_sprites_meta(text)
    if not metas:
        print('FALLA  src/data/sprites-meta.ts: no se encontró ninguna ficha')
        return False
    ok = same_text(f'src/data/sprites-meta.ts ({len(metas)} fichas)', text, fetch_sprites.render_sprites_meta(metas))
    # hover_flags sobre las hojas reales: no debe cambiar ni un solo `hv`.
    before = sum(1 for m in metas.values() if 'hv' in m)
    hovering = hover_flags.mark_hover(metas)
    ok &= same_text(f'hover_flags sobre public/assets/pokemon/ ({before} -> {len(hovering)} flotan)',
                    text, fetch_sprites.render_sprites_meta(metas))
    return ok


def check_credits():
    text = read(os.path.join(ROOT, 'CREDITS.md'))
    per_artist = fetch_credits.parse_credits(text)
    if not per_artist:
        print('FALLA  CREDITS.md: no se encontró ningún artista')
        return False
    return same_text(f'CREDITS.md ({len(per_artist)} artistas)', text, fetch_credits.render_credits(per_artist))


def check_icons():
    ok = True
    wanted = [(f'icon-{s}.png', s, False) for s in make_icons.SIZES] + [('icon-maskable-512.png', 512, True)]
    for name, size, maskable in wanted:
        path = os.path.join(make_icons.OUT, name)
        if not os.path.exists(path):
            print(f'FALLA  public/assets/icons/{name}: no existe')
            ok = False
            continue
        have = Image.open(path).convert('RGBA')
        want = make_icons.icon(size, maskable)
        if have.size != want.size or ImageChops.difference(have, want).getbbox():
            print(f'FALLA  public/assets/icons/{name}: los píxeles difieren de make_icons.icon({size}, {maskable})')
            ok = False
    if ok:
        print(f'OK     public/assets/icons ({len(wanted)} PNG, píxel a píxel)')
    return ok


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self.data


def check_fallos():
    """Un fallo de red no puede dejar datos a medias en silencio (sin red real:
    se sustituye urllib.request.urlopen). Los fetch_* tienen que terminar con
    error, decir qué Pokémon falló y no escribir el archivo."""
    ok = True
    real, wait = urllib.request.urlopen, netutil.RETRY_WAIT
    netutil.RETRY_WAIT = 0

    def fail(req, timeout=None):
        raise urllib.error.URLError('red simulada caída')

    def serve(req, timeout=None):
        # credit_names y los créditos de 16 bien; los de 12 (y todo lo demás) caídos.
        url = req.full_url
        if url.endswith('credit_names.txt'):
            return FakeResponse(b'Nombre' + bytes([9]) + b'Id' + bytes([10]))
        if url.endswith('/sprite/0016/credits.txt'):
            return FakeResponse(b'2020' + bytes([9]) + b'Autor' + bytes([10]))
        if url.endswith('/sprite/0099/credits.txt'):
            raise urllib.error.HTTPError(url, 404, 'Not Found', {}, None)
        raise urllib.error.URLError('red simulada caída')

    def expect(label, cond):
        nonlocal ok
        print(('OK     ' if cond else 'FALLA  ') + label)
        ok &= cond

    try:
        with tempfile.TemporaryDirectory(prefix='check_fallos_') as tmp:
            urllib.request.urlopen = fail
            try:
                netutil.get_bytes('http://x.invalid/a')
                expect('netutil: sin red levanta FetchError', False)
            except netutil.FetchError:
                expect('netutil: sin red levanta FetchError', True)
            for name, main, fname in (('fetch_pokedex', fetch_pokedex.main, 'pokedex.ts'),
                                      ('fetch_sprites', fetch_sprites.main, 'sprites-meta.ts'),
                                      ('fetch_evolutions', fetch_evolutions.main, 'evolutions.ts'),
                                      ('fetch_credits', fetch_credits.main, 'CREDITS.md')):
                out = os.path.join(tmp, name)
                err = io.StringIO()
                with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
                    code = main(['--only', '12', '--out', out])
                expect(f'{name}: sin red termina con error y no escribe {fname}',
                       code == 1 and not os.path.exists(os.path.join(out, fname)) and 'ERROR' in err.getvalue())

            urllib.request.urlopen = serve
            per_artist, failed = fetch_credits.fetch_per_artist([12, 16], assets=os.path.join(tmp, 'sin_assets'))
            expect('fetch_credits: con un Pokémon caído lo nombra y conserva el otro',
                   list(failed) == [12] and '0012' in failed[12] and per_artist == {('Autor', ''): {16}})
            _, failed = fetch_credits.fetch_per_artist([99], assets=os.path.join(tmp, 'sin_assets'))
            expect('fetch_credits: un 404 en credits.txt es un error, no un dato vacío',
                   list(failed) == [99] and '404' in failed[99])
    finally:
        urllib.request.urlopen, netutil.RETRY_WAIT = real, wait
    return ok


def check_fonts(tmp):
    ok = True
    for w in (400, 700):
        name = f'PixelifyPS-{w}.ttf'
        made = TTFont(make_font.build(w, os.path.join(tmp, 'PixelifyPS-{}.ttf')))
        have = TTFont(os.path.join(ROOT, 'public', 'assets', 'fonts', name))
        if sorted(made.keys()) != sorted(have.keys()):
            print(f'FALLA  {name}: tablas distintas {sorted(set(made.keys()) ^ set(have.keys()))}')
            ok = False
            continue
        # La fecha de modificación y el checksum global cambian en cada generación.
        made['head'].modified = have['head'].modified
        made['head'].checkSumAdjustment = have['head'].checkSumAdjustment
        bad = [t for t in sorted(have.keys()) if t != 'GlyphOrder' and made[t].compile(made) != have[t].compile(have)]
        if bad:
            print(f'FALLA  {name}: difieren las tablas {bad}')
            ok = False
        else:
            print(f'OK     {name} ({len(have.keys()) - 1} tablas, {len(have.getGlyphOrder())} glifos; sin head.modified)')
    return ok


def check_red(tmp, dexes=REDES):
    ok = True
    print(f'       (red: Pokémon {dexes})')

    # PokeAPI -> filas de la Pokédex (pasan por render/parse para quedarse con las mismas claves).
    have = {r['dex']: r for r in fetch_pokedex.parse_pokedex(read(os.path.join(ROOT, 'src', 'data', 'pokedex.ts')))}
    rows, failed = fetch_pokedex.fetch_rows(dexes, verbose=False)
    got = {r['dex']: r for r in rows}
    ok_pd = True
    for d in dexes:
        if d not in got:
            print(f'FALLA  PokeAPI {d}: {failed.get(d, "sin respuesta")}')
            ok_pd = False
            continue
        row = fetch_pokedex.parse_pokedex(fetch_pokedex.render_pokedex([got[d]]))[0]
        if row != have[d]:
            print(f'FALLA  PokeAPI {d}: cambió\n    archivo:  {have[d]}\n    PokeAPI:  {row}')
            ok_pd = False
    if ok_pd:
        print(f'OK     PokeAPI: {len(dexes)} filas iguales a src/data/pokedex.ts')
    ok &= ok_pd

    # PokeAPI -> cadenas evolutivas (sólo las de EVO_REDES; se compara lo que toca a esas cadenas)
    ok &= check_red_evolutions()

    # SpriteCollab -> fichas y PNG
    sp = os.path.join(tmp, 'sprites')
    if fetch_sprites.main(['--only', ','.join(map(str, dexes)), '--out', sp]):
        print('FALLA  SpriteCollab: la descarga terminó con error (ver arriba)')
        return False
    new = fetch_sprites.parse_sprites_meta(read(os.path.join(sp, 'sprites-meta.ts')))
    old = fetch_sprites.parse_sprites_meta(read(os.path.join(ROOT, 'src', 'data', 'sprites-meta.ts')))

    def files(base):
        return sorted(os.path.relpath(os.path.join(r, f), base) for r, _, fs in os.walk(base) for f in fs)

    ok_sp, npng, nbytes = True, 0, 0
    for d in dexes:
        if d not in new:
            print(f'FALLA  SpriteCollab {d}: no se pudo bajar (¿red?)')
            ok_sp = False
            continue
        want = {k: v for k, v in old[d].items() if k != 'hv'}
        if new[d] != want:
            print(f'FALLA  SpriteCollab {d}: ficha distinta\n    archivo:  {want}\n    bajada:   {new[d]}')
            ok_sp = False
        mine = os.path.join(sp, 'pokemon', str(d))
        theirs = os.path.join(ROOT, 'public', 'assets', 'pokemon', str(d))
        if files(mine) != files(theirs):
            print(f'FALLA  SpriteCollab {d}: archivos distintos {sorted(set(files(mine)) ^ set(files(theirs)))}')
            ok_sp = False
            continue
        for n in files(mine):
            a, b = os.path.join(mine, n), os.path.join(theirs, n)
            A, B = Image.open(a).convert('RGBA'), Image.open(b).convert('RGBA')
            npng += 1
            if A.size != B.size or ImageChops.difference(A, B).getbbox():
                print(f'FALLA  SpriteCollab {d}/{n}: los píxeles difieren')
                ok_sp = False
            elif open(a, 'rb').read() != open(b, 'rb').read():
                nbytes += 1
    if ok_sp:
        extra = f' ({nbytes} con bytes distintos: otra versión de Pillow)' if nbytes else ', bytes idénticos'
        print(f'OK     SpriteCollab: {len(dexes)} fichas iguales y {npng} PNG iguales píxel a píxel{extra}')
    ok &= ok_sp

    # SpriteCollab -> créditos de esos Pokémon
    try:
        got, failed = fetch_credits.fetch_per_artist(dexes)
    except netutil.FetchError as e:
        print(f'FALLA  créditos: {e}')
        return False
    if failed:
        print(f'FALLA  créditos: no se pudo bajar {failed}')
        return False
    allc = fetch_credits.parse_credits(read(os.path.join(ROOT, 'CREDITS.md')))
    want = {k: v & set(dexes) for k, v in allc.items() if v & set(dexes)}
    if got == want:
        print(f'OK     SpriteCollab: créditos de {len(dexes)} Pokémon ({len(got)} artistas) iguales a CREDITS.md')
    else:
        for k in sorted(set(got) | set(want)):
            if got.get(k) != want.get(k):
                print(f'FALLA  créditos {k}: bajado {sorted(got.get(k, []))} / CREDITS.md {sorted(want.get(k, []))}')
        ok = False
    return ok


def check_red_evolutions(dexes=EVO_REDES):
    try:
        urls = sorted({fetch_evolutions.chain_url_of(d) for d in dexes})
    except netutil.FetchError as e:
        print(f'FALLA  PokeAPI cadenas evolutivas: {e}')
        return False
    chains, failed = fetch_evolutions.fetch_chains(urls, verbose=False)
    if failed:
        print(f'FALLA  PokeAPI cadenas evolutivas: {failed}')
        return False
    allowed = fetch_evolutions.allowed_dexes()
    evo, stage = fetch_evolutions.build_evolutions(chains, allowed)
    have_evo, have_stage = fetch_evolutions.parse_evolutions(read(os.path.join(ROOT, 'src', 'data', 'evolutions.ts')))
    members = set()

    def collect(node):
        members.add(fetch_evolutions.species_id(node))
        for n in node['evolves_to']:
            collect(n)
    for c in chains:
        collect(c['chain'])
    ok = True
    for d in sorted(members & allowed):
        if evo.get(d) != have_evo.get(d) or stage.get(d) != have_stage.get(d):
            print(f'FALLA  PokeAPI evolución {d}: cambió\n    archivo:  {have_evo.get(d)} etapa {have_stage.get(d)}'
                  f'\n    PokeAPI:  {evo.get(d)} etapa {stage.get(d)}')
            ok = False
    if ok:
        print(f'OK     PokeAPI: {len(chains)} cadenas ({len(members & allowed)} Pokémon) iguales a src/data/evolutions.ts')
    return ok


def main(argv=None):
    ap = argparse.ArgumentParser(description='Comprueba que los archivos generados coinciden con sus scripts.')
    ap.add_argument('--fuentes', action='store_true', help='regenera las .ttf y las compara')
    ap.add_argument('--red', action='store_true', help='descarga unos pocos Pokémon y compara')
    ap.add_argument('--pokemon', help='con --red: estos números de Pokédex, separados por comas, en vez de REDES')
    ap.add_argument('--todo', action='store_true', help='todo lo anterior')
    args = ap.parse_args(argv)

    results = [check_pokedex(), check_evolutions(), check_sprites_meta(), check_credits(), check_icons(), check_fallos()]
    if args.fuentes or args.red or args.todo:
        with tempfile.TemporaryDirectory(prefix='check_generated_') as tmp:
            if args.fuentes or args.todo:
                results.append(check_fonts(os.path.join(tmp, 'fonts')))
            if args.red or args.todo:
                results.append(check_red(tmp, [int(x) for x in args.pokemon.split(',')] if args.pokemon else REDES))
    if all(results):
        print('\nTodo coincide.')
        return 0
    print('\nHay archivos generados que no coinciden con su script.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
