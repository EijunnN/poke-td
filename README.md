# poke-td

Juego de Pokémon para navegador y móvil con dos modos:

- **Supervivencia** (bullet-heaven / roguelike, estilo Survivor.io): llevas a tu
  compañero, que ataca solo, y aguantas oleadas cada vez más duras, con jefes,
  grietas con legendarios, climas, objetos y movimientos que evolucionan.
- **Defensa** (tower defense): 30 oleadas con tema fijo (bichos, voladores,
  fantasmas...), un jefe cada 5 y un legendario cada 10, hasta Mewtwo. Con las
  monedas de la partida compras en la tienda cualquier Pokémon de tu colección y lo
  plantas donde quieras como torre; al mejorarlo evoluciona. Cada tipo tiene su
  poder (Hielo congela, Fuego quema, Eléctrico paraliza, Psíquico confunde...) y la
  tabla de tipos de los juegos manda. Los Pokémon de apoyo (Scyther, Togekiss, Lucario,
  Meowth, Noctowl) no atacan: dan auras de daño, velocidad, crítico, monedas o alcance.
  Tres mapas, modo sin fin tras la victoria, premios de cuenta, misiones y logros, ranking
  propio y **en grupo de 2 a 4** (vidas compartidas, monedas y torres de cada uno).

Sprites de *Pokémon Mundo Misterioso*, **966 Pokémon de las 9 generaciones**,
shinies, gacha por región, misiones, logros, ranking, amigos y partidas en grupo
de hasta 4. Música y efectos compuestos para el juego.

Nació como fork de [PokéSurvivor](https://github.com/JPTER78/pokesurvivor) y es un
proyecto aparte: TypeScript, servidor propio con Bun y SQLite, sin Firebase.

## Jugar en local

Necesitas [Bun](https://bun.sh).

```bash
bun install
bun run server     # servidor: cuentas, guardado, ranking, amigos y grupo (puerto 8080)
bun run dev        # el juego, en otra terminal (Vite; abre la URL que te da)
```

Sin `bun run server`, el juego funciona igual pero en **modo local**: las cuentas y
la partida se guardan sólo en ese navegador, sin ranking ni amigos.

| Tecla | Acción |
|---|---|
| `W` `A` `S` `D` / flechas | Moverse |
| `1` `2` `3` `4` | Elegir el movimiento activo (o carta, cuando salen) |
| `Q` / `E` | Ciclar movimientos |
| `Esc` / `P` | Pausa |

En móvil o tablet (en horizontal): arrastra el dedo para moverte (el joystick sale
donde tocas) y toca un ataque para cambiarlo. Se puede instalar como app.

## Cuentas y partida

- Cuentas de **nombre y contraseña** (cifrada con argon2id). No se pide correo.
- La partida se guarda en el servidor y se sigue en cualquier dispositivo. También
  se guarda una copia en el navegador para jugar sin conexión.
- Si juegas en dos dispositivos a la vez, las partidas se **fusionan**: la colección
  se une y nunca se pierde un Pokémon ni un shiny.
- La contraseña se cambia en **Ajustes → Cuenta**. Si alguien la olvida, el
  administrador le pone una temporal desde el servidor (ver [docs/DEPLOY.md](docs/DEPLOY.md)).
- También se puede jugar como **invitado** (no se guarda nada).

## Online

- **Ranking** de tiempo aguantado: solo o en grupo; diario, semanal, mensual,
  histórico y por Pokémon. El servidor comprueba que las marcas sean posibles.
- **Amigos** por nombre, con perfil público, y quién está en línea.
- **Partidas en grupo** de hasta 4: invitas a tus amigos a tu sala y el anfitrión
  empieza la partida. Todo el tráfico va por el servidor, así que nadie ve la IP
  de nadie y funciona en cualquier red.

## Desarrollo

```bash
bun run check      # tipos del juego y del servidor
bun run test       # todas las pruebas
bun run build      # genera dist/
bun run start      # sirve dist/ y la API (producción)
```

Las pruebas son **adversariales**: intentan romper el juego y el servidor.

| Pruebas | Qué hacen |
|---|---|
| `tests/server.test.ts`, `account.test.ts`, `ranking.test.ts`, `social.test.ts` | Atacan la API: inyección, tokens falsos, partidas imposibles, carreras entre peticiones, fuerza bruta, salirse de `dist/`... |
| `tests/adversarial.ts` | Juega partidas con el azar y el reloj fijados y compara el estado con `tests/golden.json`. Un refactor no debe cambiar el resultado; sólo se regraba (`bun run test:record`) al cambiar la jugabilidad a propósito. |
| `tests/sync.e2e.ts` | El juego contra el servidor con varios navegadores: guardado cruzado, sesión, servidor caído. |
| `tests/coop.e2e.ts` | Dos navegadores se hacen amigos y juegan una partida en grupo. |

Las normas de trabajo del repo están en [CLAUDE.md](CLAUDE.md) y el diseño del juego
en [docs/GDD.md](docs/GDD.md).

## Estructura

```
index.html          pantallas del juego
src/                el juego (TypeScript)
  main.ts           carga los módulos en orden
  g.ts              registro de módulos (G.*)
  run.ts            contrato de los modos de juego
  game.ts           bucle, lienzo, pausa, menús
  modes/            survivor.ts (hordas) y td.ts (Defensa)
  core/ data/ world/ entities/ systems/ ui/
  net/              ranking, amigos, salas y partida en grupo
public/             estáticos: sprites, fuente, iconos, PWA
server/             servidor Bun + SQLite (API, WebSocket, administración)
tests/              pruebas adversariales
deploy/             instalación en la VPS (Caddy + systemd + copias)
tools/              scripts que regeneran datos y sprites
docs/               diseño (GDD) y despliegue
```

## Publicar

En una VPS con Debian o Ubuntu: `sudo bash deploy/install.sh tu-dominio.com`.
Instala Caddy (HTTPS automático) y Bun, construye el juego, lo deja como servicio y
programa una copia diaria de la base de datos. Detalles en [docs/DEPLOY.md](docs/DEPLOY.md).

## Datos generados

La Pokédex, los metadatos de los sprites y los sprites se generaron una vez con los
scripts de `tools/` (necesitan Python 3 con Pillow e internet):

```bash
python tools/fetch_sprites.py    # sprites normal y shiny + src/data/sprites-meta.ts
python tools/fetch_pokedex.py    # src/data/pokedex.ts
python tools/fetch_credits.py    # CREDITS.md
```

## Licencia y créditos

Código bajo **MIT** (ver [LICENSE](LICENSE), que conserva el aviso del proyecto
original). Sprites de [SpriteCollab](https://github.com/PMDCollab/SpriteCollab) bajo
**CC BY-NC 4.0**: uso **no comercial** y con atribución; la lista de artistas está en
[CREDITS.md](CREDITS.md). Datos de [PokeAPI](https://pokeapi.co/), fuente Pixelify
Sans (OFL). Pokémon es propiedad de Nintendo, Creatures Inc. y GAME FREAK. Proyecto
de fan sin ánimo de lucro, sin criptomonedas, tokens ni NFT.
