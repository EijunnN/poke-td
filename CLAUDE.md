# poke-td — cómo se trabaja

Juego propio, nacido como fork de PokéSurvivor (JPTER78/pokesurvivor). No comparte
servidores, dominio ni cuentas con el original.

## Estructura
- `src/` — el juego, en TypeScript. `src/main.ts` carga los módulos en orden; cada
  uno se apunta en `G` (`src/g.ts`) y declara su tipo en `Registry`.
- `public/` — estáticos servidos tal cual (`assets/` con sprites, fuente e iconos; PWA).
- `server/` — servidor Bun: sirve `dist/` y llevará API y tiempo real (sustituye a Firebase).
- `tests/` — pruebas adversariales diferenciales (`golden.json` es la referencia).
- `tools/` — scripts de datos (PokeAPI, SpriteCollab). `docs/GDD.md` — diseño.
- `legacy/` — lo del original que ya no se usa (Firebase, Cloudflare, páginas SEO,
  build antiguo). Sólo de consulta: las reglas anti-trampas de `legacy/firestore.rules`
  hay que portarlas al servidor nuevo.

## Comandos (Bun)
- `bun run dev` — desarrollo (Vite). `G` se ve en la consola sólo aquí.
- `bun run check` — tipos (`tsc --noEmit`).
- `bun run test` — pruebas adversariales: partidas con azar y reloj fijos, comparadas
  con `tests/golden.json`. Un refactor o una migración NO debe cambiar el resultado.
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
