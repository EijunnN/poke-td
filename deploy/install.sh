#!/usr/bin/env bash
# Instala o actualiza poke-td en una VPS Debian/Ubuntu. Se puede repetir sin
# miedo: la primera vez lo instala todo; las siguientes, actualiza el código,
# reconstruye y reinicia (la base de datos y la configuración no se tocan).
#
#   sudo bash deploy/install.sh tu-dominio.com [ADMIN]
#
# Antes: el dominio debe apuntar (registro A) a la IP de la VPS, y los
# puertos 80 y 443 abiertos.
set -euo pipefail

DOMAIN="${1:?Uso: sudo bash deploy/install.sh tu-dominio.com [nombre-admin]}"
ADMIN="${2:-}"
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
rsync -a --delete --exclude node_modules --exclude data --exclude dist --exclude .git "$SRC/" "$APP/"
cd "$APP"
/usr/local/bin/bun install --frozen-lockfile >/dev/null
/usr/local/bin/bun run build >/dev/null
chown -R poketd:poketd "$APP" /var/backups/poke-td

echo "== Configuración"
if [ ! -f /etc/poke-td.env ]; then
  cp deploy/poke-td.env.example /etc/poke-td.env
  sed -i "s/^ADMIN_USERS=.*/ADMIN_USERS=$ADMIN/" /etc/poke-td.env
  chmod 640 /etc/poke-td.env && chown root:poketd /etc/poke-td.env
fi
sed "s/DOMINIO/$DOMAIN/" deploy/Caddyfile > /etc/caddy/Caddyfile
cp deploy/poke-td.service deploy/poke-td-backup.service deploy/poke-td-backup.timer /etc/systemd/system/

echo "== Servicios"
systemctl daemon-reload
systemctl enable --now poke-td.service poke-td-backup.timer >/dev/null
systemctl restart poke-td.service
systemctl reload caddy || systemctl restart caddy

sleep 2
if curl -fsS http://127.0.0.1:8080/api/health >/dev/null; then
  echo "Listo: https://$DOMAIN (el certificado HTTPS puede tardar un minuto la primera vez)."
else
  echo "El servidor no responde. Mira: journalctl -u poke-td -n 50"; exit 1
fi
