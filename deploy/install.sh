#!/usr/bin/env bash
# Einmalige VPS-Einrichtung (Ubuntu/Debian): Docker, nginx, certbot, DuckDNS-Cron.
# Erstinstallation: sudo ./deploy/install.sh <sub>.duckdns.org [duckdns-token]
# Update:          sudo ./deploy/install.sh update
# Daten zurücksetzen: sudo ./deploy/install.sh reset

# Color detection and terminal output helpers
setup_colors() {
    if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-}" != "dumb" ]]; then
        ERROR=$'\033[1;31m'
        SUCCESS=$'\033[1;32m'
        WARNING=$'\033[1;33m'
        INFO=$'\033[1;36m'
        ACCENT=$'\033[1;35m'
        MUTED=$'\033[0;37m'
        BOLD=$'\033[1m'
        RESET=$'\033[0m'
    else
        ERROR=''
        SUCCESS=''
        WARNING=''
        INFO=''
        ACCENT=''
        MUTED=''
        BOLD=''
        RESET=''
    fi
}

setup_colors

print_step() {
  printf '\n%s==>%s %s\n' "$INFO" "$RESET" "$*"
}

print_success() {
  printf '%s%s%s\n' "$SUCCESS" "$*" "$RESET"
}

print_warning() {
  printf '%s%s%s\n' "$WARNING" "$*" "$RESET"
}

print_error() {
  printf '%s%s%s\n' "$ERROR" "$*" "$RESET" >&2
}

print_install_logo() {
  printf '\n%s  +--------------------------------------+%s\n' "$INFO" "$RESET"
  printf '  %s|%s  %s[>]  %sTWITCH STREAMER%s             %s|%s\n' \
    "$INFO" "$RESET" "$ACCENT" "$BOLD" "$RESET" "$INFO" "$RESET"
  printf '  %s|%s     24/7 PLAYER / VPS INSTALLER     %s|%s\n' \
    "$INFO" "$RESET" "$INFO" "$RESET"
  printf '%s  +--------------------------------------+%s\n\n' "$INFO" "$RESET"
}

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

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

  sudo ./deploy/install.sh reset
      Löscht Datenbank, Logs und Videos nach einer Sicherheitsabfrage.
      Startet die Container nach dem Reset neu und erstellt eine neue leere Datenbank.

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

if [ "${1:-}" = "update" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "Bitte mit sudo/als root ausführen." >&2
    exit 1
  fi

  print_step "Repository aktualisieren"
  git -C "${REPO_DIR}" pull --ff-only

  print_step "Container neu bauen und starten"
  docker compose -f "${REPO_DIR}/docker-compose.yml" up -d --build

  echo
  print_success "Update abgeschlossen. Die Ordner data/db, data/logs und data/videos wurden nicht verändert."
  exit 0
fi

if [ "${1:-}" = "reset" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "Bitte mit sudo/als root ausführen." >&2
    exit 1
  fi

  print_warning "ACHTUNG: Datenbank, Logs und Videos werden dauerhaft gelöscht."
  read -r -p 'Zum Bestätigen exakt RESET eingeben: ' RESET_CONFIRMATION
  if [ "${RESET_CONFIRMATION}" != "RESET" ]; then
    print_error "Reset abgebrochen."
    exit 1
  fi

  print_step "Laufende Twitch-Streamer-Container stoppen"
  docker stop twitch-streamer-backend twitch-streamer-frontend >/dev/null 2>&1 || true

  print_step "Persistente Daten löschen"
  rm -rf -- \
    "${REPO_DIR}/data/db" \
    "${REPO_DIR}/data/logs" \
    "${REPO_DIR}/data/videos"
  mkdir -p \
    "${REPO_DIR}/data/db" \
    "${REPO_DIR}/data/logs" \
    "${REPO_DIR}/data/videos"

  print_step "Twitch-Streamer-Container neu starten"
  docker start twitch-streamer-backend twitch-streamer-frontend >/dev/null 2>&1 || true

  print_success "Reset abgeschlossen. Datenbank, Logs und Videos sind leer."
  exit 0
fi

DOMAIN="${1:?Aufruf: sudo ./deploy/install.sh <sub>.duckdns.org [duckdns-token], sudo ./deploy/install.sh update oder sudo ./deploy/install.sh reset}"
DUCKDNS_TOKEN="${2:-}"
SUBDOMAIN="${DOMAIN%%.duckdns.org}"

if [ "$(id -u)" -ne 0 ]; then
  print_error "Bitte mit sudo/als root ausführen."
  exit 1
fi

print_install_logo
print_step "Installation für ${DOMAIN}"
print_step "Pakete installieren (nginx, certbot, curl)"
apt-get update
apt-get install -y ca-certificates curl nginx certbot python3-certbot-nginx

if ! command -v docker >/dev/null 2>&1; then
  print_step "Docker installieren"
  curl -fsSL https://get.docker.com | sh
else
  print_step "Docker bereits installiert"
fi

if [ -n "$DUCKDNS_TOKEN" ]; then
  print_step "DuckDNS: IP setzen und Cron-Update alle 5 Minuten einrichten"
  UPDATE_URL="https://www.duckdns.org/update?domains=${SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip="
  curl -fsS "$UPDATE_URL" && echo
  cat > /etc/cron.d/duckdns <<EOF
*/5 * * * * root curl -fsS "${UPDATE_URL}" >/dev/null 2>&1
EOF
  chmod 644 /etc/cron.d/duckdns
else
  print_warning "Kein DuckDNS-Token übergeben. DNS-Update übersprungen; die Domain muss bereits auf diese VPS zeigen."
fi

print_step "nginx-Konfiguration für ${DOMAIN} einrichten"
sed "s/__DOMAIN__/${DOMAIN}/g" "${REPO_DIR}/deploy/nginx-twitch-streamer.conf" \
  > /etc/nginx/sites-available/twitch-streamer.conf
ln -sf /etc/nginx/sites-available/twitch-streamer.conf /etc/nginx/sites-enabled/twitch-streamer.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

if command -v ufw >/dev/null 2>&1; then
  print_step "Firewall: SSH und HTTP/HTTPS freigeben"
  ufw allow OpenSSH >/dev/null || true
  ufw allow 'Nginx Full' >/dev/null || true
fi

echo
print_success "Installation abgeschlossen. Nächste Schritte:"
printf '  %s1.%s cp .env.example .env   und Werte eintragen\n' "$ACCENT" "$RESET"
printf '  %s2.%s docker compose up -d --build\n' "$ACCENT" "$RESET"
printf '  %s3.%s certbot --nginx -d %s   (HTTPS aktivieren)\n' "$ACCENT" "$RESET" "$DOMAIN"
