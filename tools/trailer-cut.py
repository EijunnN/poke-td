"""trailer-cut.py — monta el tráiler de la Defensa (normal y Arena) con los planos de tools/trailer.ts y tools/trailer-coop.ts.

    python tools/trailer-cut.py <carpeta> [canción.mp3]   → <carpeta>/poketd-trailer.mp4 (1920×1080, 30 fps, H.264 + AAC, para X)

La canción suena seguida desde el principio, sin saltos: el vídeo se ajusta a ella (SONG: tempo, primer compás,
parte intensa y pasaje tranquilo) y sólo se corta al final, con un fundido. La Defensa va con la parte intensa del
principio; la Arena se presenta (el laberinto) en el pasaje tranquilo, y su rótulo cae en el golpe del regreso.
Todos los cortes van al compás; cada plano entra con un zoom lento y su rótulo se desliza. Si a un plano le faltan
imágenes para sus compases, va a cámara lenta.
Sin canción, usa los temas del juego (grabados con `node tools/trailer.ts <carpeta> --music judgment,boss,rift --secs 80`).
"""
import os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'trailer-out'))
SONG_FILE = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else None
W, H, FPS = 1920, 1080, 30
YELLOW, INK = '0xffd23f', '0x10132a'

# La canción (medida con un análisis de inicios y de volumen por compás: Celeste — True Love): 175 ppm, primer
# compás fuerte a 3,197 s; 64 compases intensos, 32 tranquilos y el regreso a 134,85 s (compás 96).
SONG = {'bpm': 175.0, 'first_bar': 3.197, 'loud': 64, 'calm': 32}
BAR = 4 * 60 / SONG['bpm'] if SONG_FILE else 4 * 60 / 150
INTRO = SONG['first_bar'] if SONG_FILE else 0

# Cada plano: (carpetas, desde (s), compases, rótulo grande, rótulo pequeño, opciones)
#   opciones: speed (×), flash (destello blanco al entrar), top / mid (rótulos arriba / en medio), zoom, big (tarjeta grande),
#             split (dos carpetas a la vez, una a cada lado), fadein (s, desde negro)
F = {'flash': 1}
FAST = {'flash': 1, 'speed': 1.3}
HOOK = [
    (['wide'], 1.2, 1, 'VIENEN EN OLEADAS', '', F),     # (Mewtwo no: sería un spoiler)
    (['map-tridente'], 0.5, 1, 'POR TODAS PARTES', '', F),
    (['gate-cruce'], 0.6, 1, 'CADA VEZ MÁS FUERTES', '', F),
    (['map-zigzag'], 0.8, 1, '¿AGUANTARÁS?', '', {'flash': 1, 'speed': 1.5}),
    (None, 0, 4, 'PokéTD', 'Tower defense con tus Pokémon', {'flash': 1, 'big': 1}),
]
ACT1 = [
    (['place'], 0.6, 2, 'PLANTA', 'Cualquier Pokémon de tu colección', {}),
    (['shop'], 0.3, 3, 'TODA TU COLECCIÓN', 'Elige y colócalo donde quieras', {}),
    (['build-a', 'build'], 0.0, 3, 'MONTA TU DEFENSA', '', {}),
    (['evo-a', 'evo-b'], 0.3, 3, 'EVOLUCIONA', '', F),
    (['learn'], 0.6, 2, 'ENSEÑA ATAQUES', 'Dos más por torre', {}),
    (['aura'], 0.4, 2, 'REFUERZA', 'Los apoyos dan su aura', {}),
    (['types'], 0.0, 4, 'CONGELA · QUEMA · PARALIZA', 'Cada tipo, su poder', {}),
    (['map-espiral'], 0.0, 2, 'CINCO MAPAS', 'Valle · Zigzag · Espiral · Cruce · Tridente', {}),
    (['map-cruce'], 0.0, 2, 'VARIAS ENTRADAS', 'Vigílalas todas', {}),
    (['gate-espiral'], 0.2, 2, 'JEFES CADA 5 OLEADAS', '', F),
    (['gate-tridente'], 0.3, 2, '', 'Por cualquier entrada', F),
    (['gate-zigzag'], 0.6, 1, '', '', F),
    (['articuno'], 0.3, 2, 'LEGENDARIOS CADA 10', '', F),
    (['zapdos'], 0.6, 1, '', '', F),
    (['gyarados'], 0.6, 1, '', '', F),
    (['wide'], 0.0, 3, '30 OLEADAS', 'Y luego, sin fin', {'speed': 1.25}),
    (['mewtwo'], 0.0, 3, 'Y AL FINAL...', '', F),
    (['victory'], 0.2, 2, '¡VICTORIA!', '', F),
    (['lobby'], 0.0, 3, 'SOLO O CON AMIGOS', 'Salas con código y chat', {}),
    (['coop'], 0.0, 5, 'JUNTOS', 'Cada uno sus torres · señales · chat', {}),
    # Ráfaga, antes de que se calme la música.
    (['zapdos'], 1.6, 1, '', '', FAST),
    (['types'], 2.2, 1, '', '', FAST),
    (['map-tridente'], 2.4, 1, '', '', FAST),
    (['gyarados'], 1.4, 1, '', '', FAST),
    (['articuno'], 1.8, 1, '', '', FAST),
    (['map-cruce'], 2.2, 1, '', '', FAST),
    (['mewtwo'], 2.4, 1, '', '', FAST),
    (['wide'], 2.6, 1, '', '', FAST),
]
CALM = [                                              # el pasaje tranquilo: la Arena, con calma
    (None, 0, 2, 'Y AHORA...', '', {}),
    (['arena-lobby'], 0.3, 3, 'UN MODO NUEVO', 'Hasta 8 jugadores en la sala', {'top': 1}),
    (['maze-empty'], 0.2, 3, 'SIN CAMINO', 'Entran por arriba, salen por abajo', {}),
    (['maze-build'], 0.2, 4, 'TÚ HACES EL LABERINTO', 'Cada torre es un obstáculo', {'mid': 1}),
    (['maze-preview'], 0.0, 5, 'NUNCA LO CIERRES', 'Ves la ruta antes de construir', {'mid': 1}),
    (['maze-pan'], 0.0, 4, 'CUANTO MÁS LARGO, MEJOR', 'Siempre van por el camino más corto', {'zoom': 0}),
    (['arena-zoom'], 0.0, 5, 'CADA UNO, SU LABERINTO', '', {'zoom': 0}),
    (['arena-wave'], 0.2, 3, 'LAS MISMAS OLEADAS', 'Para todos, cada 30 s', {}),
    (None, 0, 3, '¿Y SI LES MANDAS ALGO?', '', {}),
]
ACT2 = [                                              # desde el golpe del regreso
    (None, 0, 2, 'ARENA', 'Hasta 8 jugadores', {'flash': 1, 'big': 1}),
    (['arena-send'], 0.0, 3, 'ENVÍA MONSTRUOS', 'Al carril que tú elijas', {}),
    (['arena-incoming'], 0.6, 3, 'QUE LO SUFRAN ELLOS', '', F),
    (['arena-snorlax'], 0.3, 3, '', 'Cada envío sube tus ingresos', {}),
    (['arena-fly'], 0.2, 2, 'ALGUNOS VUELAN', 'Zubat ignora el laberinto', F),
    (['arena-war'], 0.2, 3, 'TODOS CONTRA TODOS', '', F),
    (['arena-hud'], 0.3, 2, 'VIGILA A TUS RIVALES', '', {}),
    (['arena-fall'], 0.4, 3, 'CAEN UNO A UNO', '', F),
    (['arena-spectate'], 0.6, 2, '', 'Fuera, miras a los demás', {}),
    (['arena-duel-a', 'arena-duel-b'], 0.3, 4, 'HASTA QUE SÓLO QUEDA UNO', '', {'flash': 1, 'split': 1}),
    (['arena-podium'], 0.4, 3, 'SÉ EL ÚLTIMO EN PIE', '', F),
    (['arena-rank'], 0.3, 2, '', 'Ranking de victorias y podios', {}),
]
END_BARS = 4
INTRO_SHOT = (['map-espiral'], 0.6, 0, '', '', {'fadein': 1.6, 'zoom': 0.03})
if SONG_FILE:
    # (Cada parte, justo lo que dura su trozo de la canción.)
    for part, bars in ((HOOK + ACT1, SONG['loud']), (CALM, SONG['calm'])):
        got = sum(it[2] for it in part)
        if got != bars: sys.exit(f'una parte dura {got} compases y su trozo de la canción, {bars}')

os.chdir(D)
shutil.copy(os.path.join(ROOT, 'public/assets/fonts/PixelifyPS-700.ttf'), 'font.ttf')
shutil.rmtree('cut', ignore_errors=True)
os.makedirs('cut')

def run(args):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y'] + args)
    if r.returncode: sys.exit('ffmpeg ha fallado: ' + ' '.join(args))

n_txt = 0
def txt(s):
    global n_txt
    n_txt += 1
    p = f'cut/t{n_txt}.txt'
    open(p, 'w', encoding='utf-8').write(s)
    return p

def label(s, size, y, start, end, color='white', border=10, slide=40):
    """Rótulo que entra deslizándose hacia arriba (0,2 s) y se va con fundido."""
    a = f"if(lt(t,{start}),0,if(lt(t,{start}+0.18),(t-{start})/0.18,if(lt(t,{end}-0.15),1,if(lt(t,{end}),({end}-t)/0.15,0))))"
    yy = f"{y}+{slide}*max(0,1-(t-{start})/0.2)"
    return (f"drawtext=fontfile=font.ttf:textfile={txt(s)}:fontsize={size}:fontcolor={color}:borderw={border}:bordercolor={INK}"
            f":shadowcolor=black@0.6:shadowx=0:shadowy={max(4, size // 14)}:x=(w-text_w)/2:y='{yy}':alpha='{a}'")

def enc(out, vf, inputs, dur, complex_=False):
    flt = ['-filter_complex', vf] if complex_ else ['-vf', vf]
    run(inputs + flt + ['-t', f'{dur:.3f}', '-r', str(FPS), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', out])

def imgs_of(d):
    return [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith('.png')]

def pick(imgs, start, need, speed, what):
    """Las imágenes del plano; si no llegan, a cámara lenta (y, si hace falta, desde antes)."""
    first = int(start * FPS)
    if first + (need - 1) * speed > len(imgs) - 1:
        speed = max(0.45, (len(imgs) - 1 - first) / max(1, need - 1))
        if first + (need - 1) * speed > len(imgs) - 1: first = max(0, int(len(imgs) - 1 - (need - 1) * speed))
        print(f'  {what}: a {speed:.2f}×')
    return [imgs[min(len(imgs) - 1, first + int(k * speed))] for k in range(need)]

parts = []
clock = [0.0]
def shot(item, bar, secs=None):
    dirs, start, bars, big, small, opt = item
    # (Con un reloj común, cada plano empieza en su imagen exacta: el redondeo no se acumula y los cortes siguen al compás.)
    t0 = clock[0]
    clock[0] += secs if secs is not None else bars * bar
    need = int(round(clock[0] * FPS)) - int(round(t0 * FPS))
    dur = need / FPS
    out = f'cut/{len(parts):02d}.mp4'
    yb, ys = ('60', '170') if opt.get('top') else ('h*0.44', 'h*0.44+110') if opt.get('mid') else ('h-300', 'h-170')
    texts = []
    if big and dirs: texts.append(label(big, 96, yb, 0.12, dur - 0.05))
    if small and dirs: texts.append(label(small, 46, ys, 0.3, dur - 0.05, color=YELLOW, border=7, slide=24))
    flash = ['fade=in:st=0:d=0.18:color=white'] if opt.get('flash') else []
    if opt.get('fadein'): flash = [f"fade=in:st=0:d={opt['fadein']}"]
    if dirs is None:
        vf = ['drawbox=x=0:y=0:w=iw:h=ih:color=0x07091a:t=fill']
        if opt.get('big'):
            vf.append(label(big, 260, '(h-text_h)/2-60', 0.05, dur, color=YELLOW, border=18, slide=0))
            if small: vf.append(label(small, 60, '(h-text_h)/2+150', 0.35, dur, border=8))
        else:
            vf.append(label(big, 120, '(h-text_h)/2', 0.1, dur, border=12))
        enc(out, ','.join(vf + flash), ['-f', 'lavfi', '-i', f'color=c=black:s={W}x{H}:r={FPS}'], dur)
        parts.append(out); return
    speed = opt.get('speed', 1)
    if opt.get('split'):
        # Pantalla partida: el centro de cada plano, uno a cada lado, con una raya en medio.
        inputs = []
        for side, d in enumerate(dirs):
            seq = f'cut/seq{len(parts):02d}{side}'
            os.makedirs(seq)
            for k, src in enumerate(pick(imgs_of(d), start, need, speed, d)): shutil.copy(src, f'{seq}/{k:05d}.png')
            inputs += ['-framerate', str(FPS), '-i', f'{seq}/%05d.png']
        z = f"zoompan=z='1+0.04*on/{need}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W // 2}x{H}:fps={FPS}"
        g = (f"[0]scale={W}:{H},crop={W // 2}:{H}:{W // 4}:0,{z}[l];[1]scale={W}:{H},crop={W // 2}:{H}:{W // 4}:0,{z}[r];"
             f"[l][r]hstack,drawbox=x={W // 2 - 4}:y=0:w=8:h=ih:color=white@0.9:t=fill" + ''.join(',' + t for t in texts + flash))
        enc(out, g, inputs, dur, complex_=True)
        parts.append(out); return
    seq = f'cut/seq{len(parts):02d}'
    os.makedirs(seq)
    imgs = []
    for d in dirs: imgs += imgs_of(d)
    for k, src in enumerate(pick(imgs, start, need, speed, '+'.join(dirs))): shutil.copy(src, f'{seq}/{k:05d}.png')
    z = opt.get('zoom', 0.05)
    vf = [f'scale={W}:{H}:flags=lanczos']
    if z: vf.append(f"zoompan=z='1+{z}*on/{need}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={FPS}")
    enc(out, ','.join(vf + texts + flash), ['-framerate', str(FPS), '-i', f'{seq}/%05d.png'], dur)
    parts.append(out)

if INTRO: shot(INTRO_SHOT, BAR, INTRO)
for it in HOOK + ACT1 + CALM + ACT2: shot(it, BAR)

# Final: el duelo de la Arena, borroso y oscuro, con el nombre, el lema y la web.
END = int(round((clock[0] + END_BARS * BAR) * FPS)) / FPS - int(round(clock[0] * FPS)) / FPS
duel = sorted(f for f in os.listdir('arena-duel-a') if f.endswith('.png'))
vf = ','.join([
    f'scale={W}:{H}', 'boxblur=14:2', 'eq=brightness=-0.3:saturation=0.75',
    label('PokéTD', 230, '(h-text_h)/2-170', 0.15, END + 1, color=YELLOW, border=16, slide=0),
    label('Defensa · Arena · Survivor', 64, '(h-text_h)/2+20', 0.45, END + 1, border=8),
    label('Gratis en el navegador y el móvil', 50, '(h-text_h)/2+110', 0.7, END + 1, color='0xdfe6ff', border=7),
    label('poke.bezenti.com', 84, '(h-text_h)/2+220', 0.95, END + 1, color=YELLOW, border=9),
    'fade=in:st=0:d=0.25:color=white', f'fade=out:st={END - 1.5}:d=1.5',
])
enc('cut/end.mp4', vf, ['-loop', '1', '-framerate', str(FPS), '-i', os.path.join('arena-duel-a', duel[len(duel) // 2])], END)
parts.append('cut/end.mp4')

open('cut/list.txt', 'w').write(''.join(f"file '{os.path.basename(p)}'\n" for p in parts))
run(['-f', 'concat', '-safe', '0', '-i', 'cut/list.txt', '-c', 'copy', 'cut/video.mp4'])
total = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'cut/video.mp4'],
                             capture_output=True, text=True).stdout)

if SONG_FILE:
    # La canción, seguida desde el principio; sólo se corta al final, con un fundido.
    run(['-i', SONG_FILE, '-filter_complex',
         f'[0:a]atrim=0:{total},asetpts=N/SR/TB,afade=out:st={total - 3.2}:d=3.2,loudnorm=I=-13:TP=-1.2[m]',
         '-map', '[m]', '-c:a', 'pcm_s16le', '-ar', '48000', 'cut/music.wav'])
else:
    t_main = INTRO + sum(it[2] for it in HOOK + ACT1) * BAR
    t_act2 = total - t_main
    run(['-i', 'music-boss.webm', '-i', 'music-rift.webm', '-filter_complex',
         f'[0:a]atrim=0:{t_main + 0.15},asetpts=N/SR/TB[a0];[1:a]atrim=0:{t_act2},asetpts=N/SR/TB[a1];'
         f'[a0][a1]acrossfade=d=0.15,afade=in:d=0.2,afade=out:st={total - 1.8}:d=1.8,loudnorm=I=-13:TP=-1.2[a]',
         '-map', '[a]', '-c:a', 'pcm_s16le', '-ar', '48000', 'cut/music.wav'])
run(['-i', 'cut/video.mp4', '-i', 'cut/music.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
     '-movflags', '+faststart', '-shortest', 'poketd-trailer.mp4'])
print(f'listo: {os.path.join(D, "poketd-trailer.mp4")} ({total:.1f} s)')
