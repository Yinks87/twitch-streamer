#!/usr/bin/env bash
# Einmalige VPS-Einrichtung (Ubuntu/Debian): Docker, nginx, certbot, optional DuckDNS-Cron.
# Erstinstallation: sudo ./deploy/install.sh install <domain> [duckdns-token]
# Update:           sudo ./deploy/install.sh update
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
Twitch 24/7 Streamer - Installation und Wartung

Verwendung:
  sudo ./deploy/install.sh install <domain> [duckdns-token]
      Erstinstallation: installiert Docker, nginx und certbot und richtet
      den Host-Reverse-Proxy ein. Optional wird die .env-Datei interaktiv erstellt.
      Ist die Domain eine *.duckdns.org-Domain, wird zusätzlich der DuckDNS-Updater
      (Cron alle 5 Minuten) eingerichtet. Bei anderen Domains wird dieser Schritt
      übersprungen; die Domain muss dann bereits auf diese VPS zeigen.

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

Beispiele:
  sudo ./deploy/install.sh install meinsub.duckdns.org <token>
  sudo ./deploy/install.sh install stream.example.com

Nach der Erstinstallation:
  (.env anlegen, falls nicht vom Installer erstellt: cp .env.example .env)
  sudo docker compose up -d --build
  sudo certbot --nginx -d <domain>
EOF
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    print_error "Bitte mit sudo/als root ausführen."
    exit 1
  fi
}

# Fragt einen Wert ab, bis er nicht leer ist.
# Verwendung: prompt_required VARNAME "Beschreibung" [secret] [default]
prompt_required() {
  local var_name="$1"
  local description="$2"
  local secret="${3:-}"
  local default_value="${4:-}"
  local value=""

  while true; do
    if [ -n "$default_value" ]; then
      printf '%s%s%s [%s]: ' "$ACCENT" "$description" "$RESET" "$default_value"
    else
      printf '%s%s%s: ' "$ACCENT" "$description" "$RESET"
    fi
    if [ "$secret" = "secret" ]; then
      read -r -s value
      printf '\n'
    else
      read -r value
    fi

    # Whitespace und CR am Rand entfernen
    value="${value%$'\r'}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"

    if [ -z "$value" ] && [ -n "$default_value" ]; then
      value="$default_value"
    fi

    if [ -z "$value" ]; then
      print_warning "Diese Eingabe ist verpflichtend."
      continue
    fi

    printf -v "$var_name" '%s' "$value"
    return 0
  done
}

# Fragt, ob die .env direkt erstellt werden soll, und erstellt sie ggf.
# Setzt ENV_CREATED=1, wenn die Datei geschrieben wurde.
ENV_CREATED=0
setup_env_file() {
  local env_file="${REPO_DIR}/.env"
  local answer=""

  print_step ".env-Datei"

  if [ ! -t 0 ]; then
    print_warning "Keine interaktive Eingabe verfügbar. .env muss manuell erstellt werden."
    return 0
  fi

  printf 'Soll die .env-Datei jetzt direkt erstellt werden? [J/n] (n = manuell erstellen): '
  read -r answer
  case "${answer,,}" in
    ""|j|ja|y|yes) ;;
    *)
      print_warning "Die .env wird nicht erstellt. Bitte manuell anlegen (cp .env.example .env)."
      return 0
      ;;
  esac

  if [ -f "$env_file" ]; then
    printf '%s.env existiert bereits.%s Überschreiben? [j/N]: ' "$WARNING" "$RESET"
    read -r answer
    case "${answer,,}" in
      j|ja|y|yes) ;;
      *)
        print_warning "Vorhandene .env bleibt unverändert."
        return 0
        ;;
    esac
  fi

  local twitch_client_id twitch_client_secret twitch_permitted_user twitch_redirect_uri session_secret
  local default_redirect="https://${DOMAIN}/api/v1/auth/twitch/callback"

  echo
  echo "Bitte die .env-Werte nacheinander eingeben (alle Angaben sind verpflichtend)."
  echo "${MUTED}Twitch-App anlegen unter: https://dev.twitch.tv/console${RESET}"
  echo

  prompt_required twitch_client_id "TWITCH_CLIENT_ID"
  # "secret" auskommentieren um die Eingaben sichtbar zu machen in der Konsole
  prompt_required twitch_client_secret "TWITCH_CLIENT_SECRET (Eingabe verdeckt)" secret
  prompt_required twitch_permitted_user "TWITCH_PERMITTED_USER (Twitch-User-ID des Broadcasters)"
  echo "${MUTED}Muss exakt so in der Twitch-Dev-Console als OAuth Redirect URL eingetragen sein.${RESET}"
  prompt_required twitch_redirect_uri "TWITCH_REDIRECT_URI" "" "$default_redirect"
  echo "${MUTED}Zufälliger langer String, z. B. via: openssl rand -hex 32${RESET}"
  # "secret" auskommentieren um die Eingaben sichtbar zu machen in der Konsole
  prompt_required session_secret "SESSION_SECRET (Eingabe verdeckt)" secret

  local tmp_file
  tmp_file="$(mktemp "${REPO_DIR}/.env.XXXXXX")"
  {
    echo "# Docker-Compose Umgebung (Produktivbetrieb auf der VPS)."
    echo "# Vom Installer erstellt."
    echo
    echo "# Twitch-App (https://dev.twitch.tv/console)"
    printf 'TWITCH_CLIENT_ID=%s\n' "$twitch_client_id"
    printf 'TWITCH_CLIENT_SECRET=%s\n' "$twitch_client_secret"
    echo
    echo "# Twitch-User-ID des Broadcasters, der streamen darf"
    printf 'TWITCH_PERMITTED_USER=%s\n' "$twitch_permitted_user"
    echo
    echo "# Muss exakt so in der Twitch-Dev-Console als OAuth Redirect URL eingetragen sein"
    printf 'TWITCH_REDIRECT_URI=%s\n' "$twitch_redirect_uri"
    echo
    echo "# Zufälliger langer String"
    printf 'SESSION_SECRET=%s\n' "$session_secret"
  } > "$tmp_file"

  chmod 600 "$tmp_file"
  mv -f "$tmp_file" "$env_file"

  ENV_CREATED=1
  print_success ".env wurde erstellt: ${env_file}"
}

setup_duckdns() {
  local subdomain="${DOMAIN%.duckdns.org}"
  local token="$DUCKDNS_TOKEN"

  if [ -z "$token" ]; then
    if [ -t 0 ]; then
      printf '%sDuckDNS-Token%s (leer lassen zum Überspringen): ' "$ACCENT" "$RESET"
      read -r -s token
      printf '\n'
    fi
  fi

  if [ -z "$token" ]; then
    print_warning "Kein DuckDNS-Token angegeben. DNS-Update übersprungen; die Domain muss bereits auf diese VPS zeigen."
    return 0
  fi

  print_step "DuckDNS: IP setzen und Cron-Update alle 5 Minuten einrichten"
  local update_url="https://www.duckdns.org/update?domains=${subdomain}&token=${token}&ip="
  curl -fsS "$update_url" && echo
  cat > /etc/cron.d/duckdns <<EOF
*/5 * * * * root curl -fsS "${update_url}" >/dev/null 2>&1
EOF
  # Enthält das Token: nur root darf lesen
  chmod 600 /etc/cron.d/duckdns
}

run_install() {
  DOMAIN="${1:-}"
  DUCKDNS_TOKEN="${2:-}"

  if [ -z "$DOMAIN" ]; then
    print_error "Aufruf: sudo ./deploy/install.sh install <domain> [duckdns-token]"
    exit 1
  fi

  DOMAIN="${DOMAIN,,}"
  if ! [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; then
    print_error "Ungültige Domain: ${DOMAIN}"
    exit 1
  fi

  require_root

  print_install_logo
  print_step "Erstinstallation für ${DOMAIN}"

  # Eingaben zuerst abfragen, damit die Installation danach ohne Rückfragen durchläuft
  setup_env_file

  print_step "Pakete installieren (nginx, certbot, curl)"
  apt-get update
  apt-get install -y ca-certificates curl nginx certbot python3-certbot-nginx

  if ! command -v docker >/dev/null 2>&1; then
    print_step "Docker installieren"
    curl -fsSL https://get.docker.com | sh
  else
    print_step "Docker bereits installiert"
  fi

  if [[ "$DOMAIN" == *.duckdns.org ]]; then
    setup_duckdns
  else
    print_step "DuckDNS-Updater überspringen"
    print_warning "${DOMAIN} ist keine duckdns.org-Domain. Die Domain muss bereits auf diese VPS zeigen."
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
  local step=1
  if [ "$ENV_CREATED" -ne 1 ]; then
    printf '  %s%d.%s cp .env.example .env   und Werte eintragen\n' "$ACCENT" "$step" "$RESET"
    step=$((step + 1))
  fi
  printf '  %s%d.%s docker compose up -d --build\n' "$ACCENT" "$step" "$RESET"
  step=$((step + 1))
  printf '  %s%d.%s certbot --nginx -d %s   (HTTPS aktivieren)\n' "$ACCENT" "$step" "$RESET" "$DOMAIN"
}

run_update() {
  require_root

  print_step "Repository aktualisieren"
  git -C "${REPO_DIR}" pull --ff-only

  print_step "Container neu bauen und starten"
  # Lokale änderungen beiseite stellen und im anschluss wieder laden
  # Lokale änderungen verhindern den Pull, da die Dateien im Projekt-Ordner abgelegt werden
  print_step "Lokale Änderungen am Projektordner zwischenspeichern"
  docker stash
  print_step "Voller rebuild von Front/Backend"
  docker compose -f "${REPO_DIR}/docker-compose.yml" up -d --build
  print_step "Lokale Änderungen am Projektordner wieder laden"
  docker stash pop

  echo
  print_success "Update abgeschlossen. Die Ordner data/db, data/logs und data/videos wurden nicht verändert."
}

run_reset() {
  require_root

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
}

case "${1:-}" in
  -h|--help|-help)
    show_help
    ;;
  install)
    shift
    run_install "$@"
    ;;
  update)
    run_update
    ;;
  reset)
    run_reset
    ;;
  "")
    print_error "Kein Befehl angegeben."
    echo >&2
    show_help >&2
    exit 1
    ;;
  *)
    print_error "Unbekannter Befehl: $1"
    echo >&2
    show_help >&2
    exit 1
    ;;
esac
