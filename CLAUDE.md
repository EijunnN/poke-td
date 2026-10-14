# poke-td — cómo se trabaja

Juego propio, nacido como fork de PokéSurvivor (JPTER78/pokesurvivor). No comparte
servidores, dominio ni cuentas con el original.

## Estructura
- `src/` — el juego, en TypeScript. `src/main.ts` carga los módulos en orden; cada
  uno se apunta en `G` (`src/g.ts`) y declara su tipo en `Registry`.
- Modos de juego: `src/game.ts` lleva el bucle, el lienzo, la pausa y los menús;
  lo de dentro de la partida lo pone un modo que cumple `GameMode` (`src/run.ts`).
  `src/modes/survivor.ts` es el de hordas y `src/modes/td.ts` el de Defensa (sus cálculos puros en `td-geom.ts`, las oleadas en `td-waves.ts`; `node tools/td-balance.ts` juega una partida entera con un bot para afinarlas). Un modo nuevo se añade en `src/modes/`,
  se importa en `main.ts` y se apunta en `MODES` de `game.ts`.
- `public/` — estáticos servidos tal cual (`assets/` con sprites, fuente e iconos; PWA).
- `server/` — servidor Bun sobre SQLite (`server/db.ts`, archivo en `data/`); sustituye a Firebase.
  Sirve `dist/`, la API de cuentas y guardado (`api.ts`), el ranking (`ranking.ts`), perfiles
  y amigos (`social.ts`) y, por WebSocket en `/ws`, presencia, invitaciones, salas y el relé
  del cooperativo (`realtime.ts`). Admins del ranking: variable `ADMIN_USERS` (nombres).
- `tests/` — pruebas adversariales diferenciales (`golden.json` es la referencia).
- `tools/` — scripts de datos (PokeAPI, SpriteCollab). `docs/GDD.md` — diseño.

## Comandos (Bun)
- `bun run dev` — desarrollo (Vite). `G` se ve en la consola sólo aquí. Con `bun run server`
  a la vez, `/api` va al servidor (cuentas y guardado de verdad); sin él, modo local.
- `bun run check` — tipos del juego y del servidor.
- `bun run test` — las pruebas rápidas y deterministas (reloj simulado, sin red ni esperas;
  unos 20 s). Es lo que se ejecuta en cada cambio:
  - `tests/*.test.ts` (bun test): API, cuentas, ranking, guardado y amigos contra el servidor
    en el mismo proceso (`tests/helpers.ts`, sin sockets); WebSocket con conexiones y reloj
    simulados (`tests/fakes.ts`); `coop.fast.test.ts`: dos páginas del juego en partida en
    grupo con la red y el reloj controlados (reconexión, grietas, reinicio del servidor...).
  - `tests/adversarial.ts`: partidas con azar y reloj fijos, comparadas con
    `tests/golden.json`. Un refactor o una migración NO debe cambiar el resultado.
- `bun run test:e2e` — pruebas de humo con servidor y navegadores reales (lentas: sólo antes
  de publicar): `sync.e2e.ts`, `ranking.e2e.ts`, `coop.e2e.ts`.
- Nada de esperas en tiempo real en las pruebas: si algo depende del tiempo, se inyecta un reloj.
- `bun run test:record` — regraba la referencia. Sólo cuando se cambia la jugabilidad
  a propósito; nunca para "arreglar" una prueba que falla tras un refactor.
- `bun run build` — genera `dist/` (incluye `version.json`). `bun run start` lo sirve.

## Actualización automática de los jugadores (obligatorio)
Al publicar, todos los jugadores deben pasar a la versión nueva sin perder nada
(`src/core/updater.ts`, mira `version.json` cada 5 min):
- **Fuera de partida**: aviso de 5 s y la página se recarga. Si está en el gacha, la
  tienda de mejoras, los ajustes o escribiendo en un campo, espera a que termine.
- **En partida**: no se toca. Al acabar, la run se guarda y, al volver al menú, se recarga.
No quitar `updater.ts` ni la escritura de `version.json` en `vite.config.ts`.

## Novedades (changelog)
Cada cambio de juego o arreglo de fallos va también en `src/data/changelog.ts`
(español e inglés, en `new` / `chg` / `fix` de la fecha de hoy). Los cambios de
servidores, build o tipos NO van ahí.

## Git
Commit y push sólo cuando el dueño lo pida. Sin "Co-Authored-By" ni ninguna firma
de IA en commits ni en pull requests (también está en `.claude/settings.json`).

## Licencias (no quitar)
Código MIT: se conserva el aviso de copyright del original en `LICENSE`.
Sprites CC BY-NC 4.0: uso no comercial y atribución en `CREDITS.md`.
