#!/usr/bin/env bash
# Instala o actualiza poke-td en una VPS Debian/Ubuntu. Se puede repetir sin
# miedo: la primera vez lo instala todo; las siguientes, actualiza el código,
# reconstruye y reinicia (la base de datos y la configuración no se tocan).
#
#   sudo bash deploy/install.sh tu-dominio.com [ADMIN] [PUERTO]
#
# Antes: el dominio debe apuntar (registro A) a la IP de la VPS, y los
# puertos 80 y 443 abiertos.
#
# Si la VPS ya tiene Caddy con otras webs (un Caddyfile con `import sites/*.caddy`),
# no se toca su Caddyfile: se añade /etc/caddy/sites/poke-td.caddy (con el certificado
# por DNS de Cloudflare si /etc/caddy/caddy.env trae CF_API_TOKEN). El puerto del juego
# (8080 por defecto) se elige la primera vez y luego se lee de /etc/poke-td.env.
set -euo pipefail

DOMAIN="${1:?Uso: sudo bash deploy/install.sh tu-dominio.com [nombre-admin]}"
ADMIN="${2:-}"
PORT_ARG="${3:-8080}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/poke-td

[ "$(id -u)" = 0 ] || { echo "Ejecútalo con sudo."; exit 1; }

echo "== Paquetes"
apt-get update -qq
apt-get install -y -qq curl unzip rsync debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
if [ ! -x /usr/local/bin/bun ]; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null
fi

echo "== Usuario y carpetas"
id poketd >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin poketd
mkdir -p "$APP/data" /var/backups/poke-td

echo "== Código"
# (Las exclusiones van ancladas a la raíz: sin la barra, "data" se llevaba también src/data.)
rsync -a --delete --exclude /node_modules --exclude /data --exclude /dist --exclude /.git "$SRC/" "$APP/"
cd "$APP"
/usr/local/bin/bun install --frozen-lockfile >/dev/null
/usr/local/bin/bun run build >/dev/null
chown -R poketd:poketd "$APP" /var/backups/poke-td

echo "== Configuración"
if [ ! -f /etc/poke-td.env ]; then
  cp deploy/poke-td.env.example /etc/poke-td.env
  sed -i "s/^ADMIN_USERS=.*/ADMIN_USERS=$ADMIN/; s/^PORT=.*/PORT=$PORT_ARG/" /etc/poke-td.env
  chmod 640 /etc/poke-td.env && chown root:poketd /etc/poke-td.env
fi
PORT=$(grep -E '^PORT=' /etc/poke-td.env | cut -d= -f2); PORT=${PORT:-8080}
if [ -d /etc/caddy/sites ] && grep -q 'import sites/' /etc/caddy/Caddyfile 2>/dev/null; then
  # Caddy compartido: sólo nuestro sitio, en su propio fichero.
  TLS=""
  grep -q '^CF_API_TOKEN=' /etc/caddy/caddy.env 2>/dev/null && TLS=$'	tls {
		dns cloudflare {env.CF_API_TOKEN}
		resolvers 1.1.1.1
	}
'
  # Las cabeceras de seguridad, las mismas que en deploy/Caddyfile.
  HEADERS=$(sed -n '/^\t# Cabeceras de seguridad/,/^\t}/p' deploy/Caddyfile)
  printf '# poke-td: Bun en 127.0.0.1:%s (/opt/poke-td, servicio poke-td). Lo escribe deploy/install.sh.
%s {
%s	encode zstd gzip
%s
	reverse_proxy 127.0.0.1:%s {
		flush_interval -1
	}
}
'     "$PORT" "$DOMAIN" "$TLS" "$HEADERS" "$PORT" > /etc/caddy/sites/poke-td.caddy
  chgrp caddy /etc/caddy/sites/poke-td.caddy 2>/dev/null || true
else
  sed "s/DOMINIO/$DOMAIN/; s/127.0.0.1:8080/127.0.0.1:$PORT/" deploy/Caddyfile > /etc/caddy/Caddyfile
fi
cp deploy/poke-td.service deploy/poke-td-backup.service deploy/poke-td-backup.timer /etc/systemd/system/

echo "== Servicios"
systemctl daemon-reload
systemctl enable --now poke-td.service poke-td-backup.timer >/dev/null
systemctl restart poke-td.service
if command -v caddy-reload >/dev/null; then caddy-reload; else systemctl reload caddy || systemctl restart caddy; fi

sleep 2
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  echo "Listo: https://$DOMAIN (el certificado HTTPS puede tardar un minuto la primera vez)."
else
  echo "El servidor no responde. Mira: journalctl -u poke-td -n 50"; exit 1
fi
