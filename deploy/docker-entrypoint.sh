#!/usr/bin/env bash
# Container entrypoint — HA add-on or plain Docker.
#  1. HA add-on: turn /data/options.json into environment variables.
#  2. Persistent state on /data (CloakBrowser binary, warm per-origin profiles).
#  3. Windows fonts, if provided (CloakBrowser spoofs Windows on Linux).
#  4. Xvfb virtual display for the headed escalation.
#  5. Sync the DB schema.
#  6. Import the PC data dump once, if one was dropped in /share, then start.
set -euo pipefail

log() { echo "[entrypoint] $*"; }

# ── 1. HA add-on options ─────────────────────────────────────────────────────
OPTIONS=/data/options.json
if [[ -f "$OPTIONS" ]]; then
  log "Home Assistant add-on options found"
  opt() { jq -r --arg k "$1" '.[$k] // empty' "$OPTIONS"; }
  setenv() { local v; v="$(opt "$2")"; [[ -n "$v" ]] && export "$1=$v" || true; }
  setenv DATABASE_URL              database_url
  setenv CRUX_API_KEY              crux_api_key
  setenv CRUX_BQ_CREDENTIALS       crux_bq_credentials
  setenv CLOAKBROWSER_LICENSE_KEY  cloakbrowser_license_key
  setenv CAPTURE_CONCURRENCY       capture_concurrency
  setenv CLOAK_SESSION_LIMIT       cloak_session_limit
  setenv CLOAK_PROXY               cloak_proxy
  setenv TZ                        timezone
  # Free-form KEY=VALUE lines for every other variable of .env.example.
  while IFS= read -r line; do
    [[ "$line" == *=* ]] && export "${line?}"
  done < <(jq -r '.env_vars[]? // empty' "$OPTIONS")
fi

: "${DATABASE_URL:?DATABASE_URL is required (mysql://user:pass@host:3306/db)}"

# ── 2. Persistent state ──────────────────────────────────────────────────────
mkdir -p /data/cloakbrowser /data/cloak-profiles
# The app resolves the escalation profiles to <app>/data/cloak-profiles.
if [[ ! -L /app/data/cloak-profiles ]]; then
  rm -rf /app/data/cloak-profiles
  ln -s /data/cloak-profiles /app/data/cloak-profiles
fi

# ── 3. Windows fonts ─────────────────────────────────────────────────────────
# On Linux the stealth binary claims to be Windows; a box without Segoe UI,
# Calibri, Consolas… contradicts that claim and font-fingerprinting WAFs notice.
# Drop the .ttf/.ttc files copied from C:\Windows\Fonts in one of these folders.
for dir in "${WINDOWS_FONTS_DIR:-}" /share/fonts-windows /data/fonts-windows; do
  if [[ -n "$dir" && -d "$dir" ]] && compgen -G "$dir/*.[tT][tT][fFcC]" > /dev/null; then
    log "Windows fonts: $dir"
    ln -sfn "$dir" /usr/share/fonts/windows
    fc-cache -f > /dev/null
    break
  fi
done
if [[ ! -e /usr/share/fonts/windows ]]; then
  log "WARNING: no Windows fonts — CloakBrowser's Windows fingerprint is weaker (see deploy/README.md)"
fi

# ── 4. Virtual display ───────────────────────────────────────────────────────
# CloakBrowser takes the screen size from the real display in headed mode, so
# give it a common desktop resolution.
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -ac > /dev/null 2>&1 &
log "Xvfb started on $DISPLAY"

# ── 5. Schema + server ───────────────────────────────────────────────────────
# No --accept-data-loss: a schema change that would drop data stops the boot
# instead of silently destroying runs.
cd /app
for attempt in $(seq 1 20); do
  if npx prisma db push --skip-generate; then
    break
  fi
  if [[ "$attempt" == 20 ]]; then
    log "prisma db push failed 20 times — giving up"
    exit 1
  fi
  log "database not ready (attempt $attempt/20), retrying in 5 s"
  sleep 5
done

# ── 6. One-shot data import ──────────────────────────────────────────────────
# deploy/migrate-db.ps1 drops the PC's data here; imported only into an EMPTY
# database (no Run row), so a leftover file is harmless on later boots.
IMPORT_FILE="${IMPORT_FILE:-/share/maturity-import/maturite-data.sql}"
if [[ -f "$IMPORT_FILE" ]]; then
  # host port user password database, decoded from DATABASE_URL.
  read -r DBH DBP DBU DBW DBN < <(node -e '
    const u = new URL(process.env.DATABASE_URL);
    console.log(u.hostname, u.port || 3306, decodeURIComponent(u.username),
      decodeURIComponent(u.password), u.pathname.slice(1));')
  runs=$(MYSQL_PWD="$DBW" mysql -h "$DBH" -P "$DBP" -u "$DBU" -N -e 'SELECT COUNT(*) FROM `Run`' "$DBN")
  if [[ "$runs" == 0 ]]; then
    log "importing $IMPORT_FILE into an empty database…"
    MYSQL_PWD="$DBW" mysql -h "$DBH" -P "$DBP" -u "$DBU" --default-character-set=utf8mb4 \
      --max-allowed-packet=64M "$DBN" -e "SET FOREIGN_KEY_CHECKS=0; source $IMPORT_FILE; SET FOREIGN_KEY_CHECKS=1;"
    log "import done: $(MYSQL_PWD="$DBW" mysql -h "$DBH" -P "$DBP" -u "$DBU" -N -e 'SELECT COUNT(*) FROM `Run`' "$DBN") runs"
  else
    log "import skipped: database already holds $runs runs (delete $IMPORT_FILE)"
  fi
fi

log "starting web UI on port $PORT"
exec npx tsx src/web/server.ts
