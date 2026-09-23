#!/usr/bin/env bash
# Einmalige VPS-Einrichtung (Ubuntu/Debian): Docker, nginx, certbot, DuckDNS-Cron.
# Aufruf aus dem Repo-Root:  sudo ./deploy/install.sh <sub>.duckdns.org [duckdns-token]
set -euo pipefail

DOMAIN="${1:?Aufruf: sudo ./deploy/install.sh <sub>.duckdns.org [duckdns-token]}"
DUCKDNS_TOKEN="${2:-}"
SUBDOMAIN="${DOMAIN%%.duckdns.org}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Bitte mit sudo/als root ausführen." >&2
  exit 1
fi

echo "==> Pakete installieren (nginx, certbot, curl)"
apt-get update
apt-get install -y ca-certificates curl nginx certbot python3-certbot-nginx

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Docker installieren"
  curl -fsSL https://get.docker.com | sh
else
  echo "==> Docker bereits installiert"
fi

if [ -n "$DUCKDNS_TOKEN" ]; then
  echo "==> DuckDNS: IP jetzt setzen + Cron-Update alle 5 Minuten"
  UPDATE_URL="https://www.duckdns.org/update?domains=${SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip="
  curl -fsS "$UPDATE_URL" && echo
  cat > /etc/cron.d/duckdns <<EOF
*/5 * * * * root curl -fsS "${UPDATE_URL}" >/dev/null 2>&1
EOF
  chmod 644 /etc/cron.d/duckdns
else
  echo "==> Kein DuckDNS-Token übergeben — DNS-Update übersprungen (Domain muss bereits auf diese VPS zeigen)."
fi

echo "==> nginx-Konfiguration für ${DOMAIN} einrichten"
sed "s/__DOMAIN__/${DOMAIN}/g" "${REPO_DIR}/deploy/nginx-twitch-streamer.conf" \
  > /etc/nginx/sites-available/twitch-streamer.conf
ln -sf /etc/nginx/sites-available/twitch-streamer.conf /etc/nginx/sites-enabled/twitch-streamer.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

if command -v ufw >/dev/null 2>&1; then
  echo "==> Firewall: SSH + HTTP/HTTPS freigeben"
  ufw allow OpenSSH >/dev/null || true
  ufw allow 'Nginx Full' >/dev/null || true
fi

echo
echo "Fertig. Nächste Schritte (siehe README):"
echo "  1. cp .env.example .env   und Werte eintragen"
echo "  2. docker compose up -d --build"
echo "  3. certbot --nginx -d ${DOMAIN}   (HTTPS aktivieren)"
