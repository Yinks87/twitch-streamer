# Twitch Loop Player

Web-Oberfläche zum Hochladen von Videos auf eine VPS und Streamen dieser Videos
in Dauerschleife per RTMP zu Twitch, gesteuert per Knopfdruck. Kein OBS nötig —
das Backend startet `ffmpeg` direkt.

```
├── backend/     Node.js/Express API (ESM): Upload (multer), SQLite (Zieldaten),
│                ffmpeg-Prozesssteuerung
├── frontend/    React (Vite) Oberfläche
└── docker-compose.yml
```

Backend und Frontend sind zwei unabhängige Node-Projekte und laufen sowohl
lokal im Dev-Modus (ohne Docker) als auch produktiv in zwei getrennten
Docker-Containern.

## Lokaler Dev-Modus (ohne Docker)

Zwei Terminals parallel:

```bash
# Terminal 1 — Backend
cd backend
npm install
cp .env.example .env
npm start                # läuft auf http://localhost:4000
```

```bash
# Terminal 2 — Frontend
cd frontend
npm install
npm run dev              # läuft auf http://localhost:5173
```

Vite proxied `/api/*` im Dev-Server automatisch zu `http://localhost:4000`
(siehe `frontend/vite.config.js`), sodass der React-Code überall einfach
`fetch('/api/...')` nutzen kann — im Dev-Modus, im Docker-Setup und in
jeder anderen Umgebung identisch. So lässt sich Routing, Upload und
Stream-Steuerung lokal komplett durchspielen, bevor irgendetwas auf die
VPS kommt.

## Produktivbetrieb mit Docker

```bash
docker compose up -d --build
```

Das startet zwei Container:

- **backend** — Node/Express + ffmpeg (Alpine-Image), lauscht intern auf
  Port 4000, ist nicht direkt nach außen exponiert (`expose`, kein `ports`).
- **frontend** — statischer Vite-Build, ausgeliefert über nginx auf Port 80.
  nginx leitet `/api/*` intern an den `backend`-Container weiter
  (`frontend/nginx.conf`), sodass Browser nur mit dem Frontend-Container
  sprechen und CORS keine Rolle spielt.

Persistente Daten liegen auf dem Host, nicht im Container:

```
./data/videos   → gemountet nach /app/videos im Backend-Container
./data/db       → gemountet nach /app/db im Backend-Container (SQLite)
```

Diese Ordner bleiben bei `docker compose up --build` (Neubau der Images)
erhalten und gehen nur verloren, wenn du sie manuell löschst.

Der Frontend-Container ist bewusst nur an `127.0.0.1:8080` gebunden — nach
außen geht es über den Host-nginx mit HTTPS (siehe nächstes Kapitel).
Zum lokalen Testen des Docker-Setups: `http://localhost:8080`.

### Container-Logs

```bash
docker compose logs -f backend
docker compose logs -f frontend
```

Das ffmpeg-Log ist zusätzlich direkt in der Oberfläche einsehbar (Panel
„ffmpeg-Log" aufklappen).

### Aktualisieren

```bash
sudo ./deploy/install.sh update
```

Der Update-Befehl führt `git pull --ff-only` aus und baut die Container neu.
Die persistenten Ordner `data/db`, `data/logs` und `data/videos` werden nicht
gelöscht oder aus dem Repository überschrieben. Lokale, nicht committete
Codeänderungen können den Pull wie gewohnt blockieren.

Zum vollständigen Zurücksetzen der Laufzeitdaten:

```bash
sudo ./deploy/install.sh reset
```

Nach der Sicherheitsabfrage werden die Datenbank, alle Logs und alle Videos
gelöscht. Die leeren Ordner werden anschließend neu angelegt.

## Installation auf der VPS (Ubuntu + DuckDNS + HTTPS)

Zielarchitektur:

```
Browser ─HTTPS─▶ Host-nginx (443, DuckDNS-Domain, Let's-Encrypt-Zertifikat)
                    └─▶ 127.0.0.1:8080 ─▶ frontend-Container (nginx, statisches UI)
                                              └─▶ /api/* ─▶ backend-Container (Node + ffmpeg)
```

Voraussetzungen: Ubuntu-VPS mit Root-Zugang (getestet: 4 Kerne / 8 GB — reicht
für 1080p60 mit `veryfast` und ~2,6× Encoding-Headroom), ein kostenloses
[DuckDNS](https://www.duckdns.org)-Konto mit einer Subdomain und dem Token
von der DuckDNS-Startseite.

### 1. DuckDNS-Subdomain anlegen

Auf duckdns.org einloggen, Subdomain anlegen (z. B. `meinstream`
→ `meinstream.duckdns.org`). Die IP musst du nicht manuell eintragen —
das Installationsskript setzt sie und richtet ein Cron-Update ein.

### 2. Repo auf die VPS bringen und Installationsskript ausführen

```bash
git clone <repo-url> twitch-streamer
cd twitch-streamer
chmod +x deploy/install.sh
sudo ./deploy/install.sh meinstream.duckdns.org <duckdns-token>
```

Das Skript (`deploy/install.sh`) installiert Docker, nginx und certbot,
setzt die DuckDNS-IP (plus Cron-Update alle 5 Minuten in
`/etc/cron.d/duckdns`), aktiviert die nginx-Site aus
`deploy/nginx-twitch-streamer.conf` mit deiner Domain und gibt — falls `ufw`
aktiv ist — SSH und HTTP/HTTPS frei.

Die verfügbaren Befehle zeigt das Skript mit:

```bash
sudo ./deploy/install.sh -h
```

### 3. Umgebungsvariablen setzen

```bash
cp .env.example .env
nano .env
```

| Variable | Wert |
|---|---|
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | aus der [Twitch-Dev-Console](https://dev.twitch.tv/console) |
| `TWITCH_PERMITTED_USER` | Twitch-User-ID des Broadcasters |
| `TWITCH_REDIRECT_URI` | `https://meinstream.duckdns.org/api/v1/auth/twitch/callback` |
| `SESSION_SECRET` | `openssl rand -hex 32` |

Wichtig: Die `TWITCH_REDIRECT_URI` muss **exakt gleich** (inkl. `https://`)
als „OAuth Redirect URL“ in der Twitch-Dev-Console eingetragen sein.
Twitch akzeptiert **keine** `http://`-Redirect-URIs (einzige Ausnahme:
`http://localhost` für lokale Entwicklung) — deshalb ist die öffentliche
DuckDNS-Domain mit HTTPS zwingend, eine nackte VPS-IP reicht nicht.

### 4. Container starten

```bash
sudo docker compose up -d --build
```

Danach antwortet `http://meinstream.duckdns.org` bereits über den Host-nginx.
Der Twitch-Login funktioniert aber erst nach dem nächsten Schritt — die
Redirect-URI ist `https://`, also muss das Zertifikat vorher da sein.

### 5. HTTPS aktivieren (Let's Encrypt)

```bash
sudo certbot --nginx -d meinstream.duckdns.org
```

certbot holt das Zertifikat, erweitert die nginx-Site automatisch um den
443-Block samt HTTP→HTTPS-Redirect und erneuert das Zertifikat künftig
selbstständig (systemd-Timer). Danach ist die Oberfläche unter
`https://meinstream.duckdns.org` erreichbar und der Twitch-Login funktioniert.

### 6. Twitch-Ingest wählen

In den Einstellungen der Oberfläche einen zur VPS-Region passenden
Ingest-Server auswählen (z. B. `rtmp://fra05.contribute.live-video.net/app/`
für Frankfurt statt `live.twitch.tv`) — siehe
[Twitch Ingest-Empfehlungen](https://help.twitch.tv/s/twitch-ingest-recommendation).

### Betrieb & Wartung

```bash
sudo docker compose logs -f backend        # Backend-/ffmpeg-Log live
ls data/logs/                              # ffmpeg-Session-Logs (pro Verbindung eine Datei)
sudo docker compose up -d --build          # Update nach git pull
sudo certbot renew --dry-run               # Zertifikats-Erneuerung testen
curl -fsS "https://www.duckdns.org/update?domains=meinstream&token=<token>&ip="  # DuckDNS manuell setzen
```

Hinweise:

- Das Backend nutzt das ffmpeg aus dem Alpine-Container — dessen **nativer
  RTMP-Stack** beantwortet Twitchs Ping-Nachrichten korrekt. Kein librtmp-Build
  verwenden (Symptom: sauberer Twitch-Disconnect alle 15–40 Minuten mit
  sofortigem Offline-Screen).
- Traffic: 24/7 mit 6 Mbit/s ≈ 2 TB/Monat Upstream.
- Der geplante Neustart (Standard: 47 h, unter Twitchs 48-h-Limit) und der
  automatische Reconnect mit fortgeführten Timestamps sind im Backend
  eingebaut; es ist kein zusätzlicher Watchdog nötig.

## API-Endpunkte (identisch in Dev und Docker)

| Methode | Pfad                 | Zweck                                   |
|---------|------------------------|------------------------------------------|
| GET     | /api/videos             | Videoliste                               |
| POST    | /api/upload              | Dateien hochladen (Feld: `videos`)       |
| DELETE  | /api/videos/:name        | Video löschen                            |
| GET     | /api/settings            | Twitch-Server + Stream-Key lesen         |
| POST    | /api/settings            | Twitch-Server + Stream-Key speichern     |
| GET     | /api/stream/status       | Läuft der Stream? Log-Tail, Uptime       |
| POST    | /api/stream/start         | Stream starten (immer OBS-Twitch-Reencode) |
| POST    | /api/stream/stop          | Stream stoppen                           |
| GET     | /api/health               | Healthcheck                              |

## Hinweise zum Streaming

- **Copy-Modus**: kein Re-Encoding, minimale CPU-Last. Voraussetzung: alle
  Videos im Ordner haben identisches Codec/Format/Auflösung/Framerate,
  sonst drohen Ruckler oder Verbindungsabbrüche an den Nahtstellen.
- **Neu-kodieren-Modus**: transkodiert alles einheitlich (H.264/AAC, Keyframe
  alle 2s) — funktioniert mit gemischten Quelldateien, braucht aber
  mehrere CPU-Kerne (ca. 2–4 für 1080p30). Im Docker-Setup teilt sich der
  Backend-Container die CPU mit dem Host wie jeder andere Prozess auch —
  ffmpeg läuft nicht "in" nginx, sondern als Kindprozess des Node-Backends.
- Die Videos werden alphabetisch sortiert und in Dauerschleife abgespielt
  (`-stream_loop -1`). Neue Uploads wirken erst nach einem Neustart des
  Streams, da die Playlist beim Start neu erzeugt wird.
- Traffic im Auge behalten: ein 24/7-Stream mit 6 Mbit/s sind ca. 2 TB/Monat.
- Der Stream-Key liegt unverschlüsselt in der SQLite-Datenbank
  (`./data/db/data.sqlite` im Docker-Setup). Da es keine Login-Funktion
  gibt, solltest du den Zugriff auf die Oberfläche selbst absichern (z. B.
  Basic-Auth vor nginx, oder die Ports nur über ein VPN/SSH-Tunnel
  erreichbar machen), sonst kann jeder mit Zugriff auf die URL den
  Stream-Key auslesen und den Stream starten/stoppen.
