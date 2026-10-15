# Desplegar poke-td en una VPS

Un solo servidor: **Bun** sirve el juego, la API y el WebSocket, con la base de datos en
un archivo **SQLite**. Delante, **Caddy** pone HTTPS (certificado gratis de Let's
Encrypt, se renueva solo). Probado para Debian 12 / Ubuntu 22.04 o posteriores.

## Antes de empezar

1. Un dominio (o subdominio) con un registro **A** que apunte a la IP de la VPS.
2. Los puertos **80** y **443** abiertos (el 8080 NO hace falta abrirlo: sólo lo usa Caddy).
3. Acceso por SSH con un usuario que pueda usar `sudo`.

## Instalar

En la VPS:

```bash
git clone https://github.com/EijunnN/poke-td.git
cd poke-td
sudo bash deploy/install.sh tu-dominio.com TuNombreDeJugador
```

El segundo argumento (opcional) es la cuenta que podrá moderar el ranking, y el tercero
(opcional, sólo la primera vez) el puerto local del juego, 8080 si no se dice. El script:

- instala Caddy y Bun si faltan;
- crea el usuario de sistema `poketd` y copia el juego a `/opt/poke-td`;
- construye el juego (`bun run build`);
- crea `/etc/poke-td.env` (configuración) y la configuración de Caddy (ver abajo);
- activa el servicio `poke-td` y la copia de seguridad diaria (`poke-td-backup.timer`).

Al acabar, el juego está en `https://tu-dominio.com`.

### Si la VPS ya sirve otras webs con Caddy

Si su `/etc/caddy/Caddyfile` incluye `import sites/*.caddy`, el script NO lo toca: escribe
sólo `/etc/caddy/sites/poke-td.caddy` (y, si `/etc/caddy/caddy.env` trae `CF_API_TOKEN`, pide
el certificado por DNS de Cloudflare, como las demás webs). Elige un puerto libre:

```bash
sudo bash deploy/install.sh poke.ejemplo.com TuNombre 4070
```

Así está desplegado ahora: `https://poke.bezenti.com`, código en `/srv/poke-td`, juego en
`/opt/poke-td` y puerto 4070 (el 8080 lo usa otra web de esa VPS). El registro DNS va sin el
proxy de Cloudflare: las salas, el chat y la partida en grupo van por WebSocket.

## Actualizar

```bash
cd poke-td && git pull
sudo bash deploy/install.sh tu-dominio.com
```

(En la VPS actual: `cd /srv/poke-td && git pull && sudo bash deploy/install.sh poke.bezenti.com`.)

La base de datos y `/etc/poke-td.env` no se tocan. Los jugadores que estén en el menú
pasan a la versión nueva solos; los que estén en partida, al acabarla.

## Día a día

| Qué | Cómo |
|---|---|
| Ver si va | `systemctl status poke-td` |
| Ver los registros | `journalctl -u poke-td -f` |
| Reiniciar | `sudo systemctl restart poke-td` |
| Alguien olvidó la contraseña | `cd /opt/poke-td && sudo -u poketd bun server/admin.ts reset-password Nombre` (le das la temporal y la cambia en Ajustes → Cuenta) |
| Copia de seguridad ahora | `sudo systemctl start poke-td-backup` |
| Moderadores del ranking | `ADMIN_USERS` en `/etc/poke-td.env` y reiniciar |

## Copias de seguridad

Cada día a las 05:00 se guarda una copia completa en `/var/backups/poke-td/`
(`poke-td-<fecha>.sqlite`) y se conservan las 14 últimas (`BACKUP_KEEP`). Es una copia
coherente aunque el servidor esté funcionando. Conviene llevarlas también fuera de la VPS,
por ejemplo con `rsync` o `scp` desde tu ordenador.

Para restaurar una copia:

```bash
sudo systemctl stop poke-td
sudo cp /var/backups/poke-td/poke-td-<fecha>.sqlite /opt/poke-td/data/poke-td.sqlite
sudo rm -f /opt/poke-td/data/poke-td.sqlite-wal /opt/poke-td/data/poke-td.sqlite-shm
sudo chown poketd:poketd /opt/poke-td/data/poke-td.sqlite
sudo systemctl start poke-td
```

## Qué guarda el servidor

Cuentas (nombre y contraseña cifrada con argon2id), partidas, amigos, perfiles públicos,
ranking y reportes, todo en `/opt/poke-td/data/poke-td.sqlite`. No se pide correo ni
ningún otro dato personal.
