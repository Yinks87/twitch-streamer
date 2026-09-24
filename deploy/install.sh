#!/usr/bin/env bash
# Einmalige VPS-Einrichtung (Ubuntu/Debian): Docker, nginx, certbot, DuckDNS-Cron.
# Erstinstallation: sudo ./deploy/install.sh <sub>.duckdns.org [duckdns-token]
# Update:          sudo ./deploy/install.sh update
# Daten zurücksetzen: sudo ./deploy/install.sh reset
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

setup_update_service() {
  local update_token

  touch "${REPO_DIR}/.env"
  if ! grep -q '^UPDATE_SERVICE_TOKEN=.\+' "${REPO_DIR}/.env"; then
    update_token="$(openssl rand -hex 32)"
    printf '\nUPDATE_SERVICE_TOKEN=%s\n' "$update_token" >> "${REPO_DIR}/.env"
    chmod 600 "${REPO_DIR}/.env"
  fi

  cat > /etc/systemd/system/twitch-streamer-update.service <<EOF
[Unit]
Description=Twitch Streamer update service
After=network.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
EnvironmentFile=${REPO_DIR}/.env
Environment=UPDATE_SERVICE_REPO_DIR=${REPO_DIR}
ExecStart=/usr/bin/python3 ${REPO_DIR}/deploy/update-service.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now twitch-streamer-update.service
}

show_help() {
  cat <<'EOF'
Twitch Streamer - Installation und Wartung

Verwendung:
  sudo ./deploy/install.sh <sub>.duckdns.org [duckdns-token]
      Erstinstallation: installiert Docker, nginx und certbot und richtet
      die DuckDNS-Domain sowie den Host-Reverse-Proxy ein.

  sudo ./deploy/install.sh update
      Holt den neuesten Repository-Stand und baut die Container neu.
      data/db, data/logs und data/videos bleiben erhalten.

    sudo ./deploy/install.sh update-service
      Richtet den lokalen Dienst fuer Updates aus der Admin-Oberflaeche ein.

  sudo ./deploy/install.sh reset
      Löscht Datenbank, Logs und Videos nach einer Sicherheitsabfrage.

  sudo ./deploy/install.sh -h
  sudo ./deploy/install.sh --help
  sudo ./deploy/install.sh -help
      Zeigt diese Hilfe an.

Nach der Erstinstallation:
  cp .env.example .env
  sudo docker compose up -d --build
  sudo certbot --nginx -d <sub>.duckdns.org
EOF
}

case "${1:-}" in
  -h|--help|-help)
    show_help
    exit 0
    ;;
esac

if [ "${1:-}" = "update-service" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "Bitte mit sudo/als root ausführen." >&2
    exit 1
  fi
  setup_update_service
  echo "Admin-Update-Service eingerichtet."
  exit 0
fi

if [ "${1:-}" = "update" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "Bitte mit sudo/als root ausführen." >&2
    exit 1
  fi

  echo "==> Repository aktualisieren"
  git -C "${REPO_DIR}" pull --ff-only

  echo "==> Container neu bauen und starten"
  docker compose -f "${REPO_DIR}/docker-compose.yml" up -d --build

  echo
  echo "Update abgeschlossen. Die Ordner data/db, data/logs und data/videos wurden nicht verändert."
  exit 0
fi

if [ "${1:-}" = "reset" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "Bitte mit sudo/als root ausführen." >&2
    exit 1
  fi

  echo "ACHTUNG: Die Datenbank, alle Logs und alle Videos werden dauerhaft gelöscht."
  read -r -p 'Zum Bestätigen exakt RESET eingeben: ' RESET_CONFIRMATION
  if [ "${RESET_CONFIRMATION}" != "RESET" ]; then
    echo "Reset abgebrochen."
    exit 1
  fi

  echo "==> Laufende Twitch-Streamer-Container stoppen"
  docker stop twitch-streamer-backend twitch-streamer-frontend >/dev/null 2>&1 || true

  echo "==> Persistente Daten löschen"
  rm -rf -- \
    "${REPO_DIR}/data/db" \
    "${REPO_DIR}/data/logs" \
    "${REPO_DIR}/data/videos"
  mkdir -p \
    "${REPO_DIR}/data/db" \
    "${REPO_DIR}/data/logs" \
    "${REPO_DIR}/data/videos"

  echo "Reset abgeschlossen. Datenbank, Logs und Videos sind leer."
  exit 0
fi

DOMAIN="${1:?Aufruf: sudo ./deploy/install.sh <sub>.duckdns.org [duckdns-token], sudo ./deploy/install.sh update oder sudo ./deploy/install.sh reset}"
DUCKDNS_TOKEN="${2:-}"
SUBDOMAIN="${DOMAIN%%.duckdns.org}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Bitte mit sudo/als root ausführen." >&2
  exit 1
fi

echo "==> Pakete installieren (nginx, certbot, curl)"
apt-get update
apt-get install -y ca-certificates curl nginx certbot openssl python3-certbot-nginx

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

echo "==> Admin-Update-Service einrichten"
setup_update_service

echo
echo "Fertig. Nächste Schritte (siehe README):"
echo "  1. cp .env.example .env   und Werte eintragen"
echo "  2. docker compose up -d --build"
echo "  3. certbot --nginx -d ${DOMAIN}   (HTTPS aktivieren)"
