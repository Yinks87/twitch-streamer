#!/usr/bin/env bash
# Pulls the latest version of the repository (run from Git Bash on Windows).
set -euo pipefail

REPO_URL="https://github.com/Yinks87/twitch-streamer.git"

cd "$(dirname "$0")"

if [ ! -d .git ]; then
  echo "Kein Git-Repository gefunden - initialisiere und verbinde mit $REPO_URL"
  git init
  git remote add origin "$REPO_URL"
  git fetch origin
  git checkout -f -B main origin/main
else
  git remote set-url origin "$REPO_URL"
  before="$(git rev-parse HEAD)"
  git pull --ff-only origin main
  after="$(git rev-parse HEAD)"

  if [ "$before" = "$after" ]; then
    echo "Bereits auf dem neuesten Stand."
    exit 0
  fi

  # Reinstall dependencies only when a manifest changed in the pulled commits.
  for dir in backend frontend; do
    if git diff --name-only "$before" "$after" -- "$dir/package.json" "$dir/package-lock.json" | grep -q .; then
      echo "Abhängigkeiten in $dir haben sich geändert - npm install"
      (cd "$dir" && npm install)
    fi
  done
fi

echo "Update abgeschlossen."
