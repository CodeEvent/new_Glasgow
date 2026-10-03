#!/data/data/com.termux/files/usr/bin/bash
# Gatekeeper on an Android phone (Termux). Installs, or updates if already installed:
#
#   pkg install -y git
#   git clone --depth 1 -b claude/inspiring-fermi-ujdf1c https://github.com/CodeEvent/new_Glasgow.git ~/new_glasgow
#   bash ~/new_glasgow/incident-tracker/scripts/android/install.sh
#
# Afterwards:  gk-start | gk-stop | gk-status | gk-key | gk-log | gk-update | gk-set
set -euo pipefail

# This script updates the folder it lives in, so run a copy of it, not the file git may replace.
# ($0 is checked by name: under "curl | bash" Termux sets it to the bash binary itself.)
if [ -z "${GK_COPY:-}" ] && [ -f "$0" ] && [ "$(basename "$0")" = "install.sh" ]; then
  tmp="$(mktemp "${TMPDIR:-/tmp}/gk-install.XXXXXX")"
  cp "$0" "$tmp"
  GK_COPY=1 exec bash "$tmp" "$@"
fi

REPO="https://github.com/CodeEvent/new_Glasgow.git"
BRANCH="${GK_BRANCH:-claude/inspiring-fermi-ujdf1c}"
SRC="$HOME/new_glasgow"
APP="$SRC/incident-tracker"
DATA="$HOME/gatekeeper-data"   # records, photos and the WhatsApp link; kept across updates
BIN="${PREFIX:?This script is for Termux on Android}/bin"
PORT="${GK_PORT:-3000}"

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

say "Installing Node.js and git (a few minutes the first time)"
apt-get update
apt-get install -y -o Dpkg::Options::=--force-confnew nodejs-lts git procps curl

say "Getting the Gatekeeper code"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --depth 1 origin "$BRANCH"
  git -C "$SRC" checkout -q -B "$BRANCH" FETCH_HEAD
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$SRC"
fi

say "Installing its packages"
cd "$APP"
npm install --no-audit --no-fund

mkdir -p "$DATA"

# ---- the runner: keeps the bot going, restarts it if it ever stops
cat > "$HOME/.gatekeeper-run.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Started by gk-start and at boot by Termux:Boot. One copy only.
PIDFILE="$DATA/.run.pid"
if [ -f "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null; then exit 0; fi
echo \$\$ > "\$PIDFILE"
termux-wake-lock
cd "$APP"
while true; do
  # Keep the log small on the phone.
  [ -f "$DATA/gatekeeper.log" ] && [ "\$(stat -c %s "$DATA/gatekeeper.log")" -gt 5000000 ] && mv -f "$DATA/gatekeeper.log" "$DATA/gatekeeper.old.log"
  # Optional settings (see gk-set), re-read on every start.
  if [ -f "$DATA/settings.env" ]; then set -a; . "$DATA/settings.env"; set +a; fi
  echo "[\$(date '+%F %T')] starting" >> "$DATA/gatekeeper.log"
  PORT=$PORT LOCAL_DATA_DIR="$DATA" node node_modules/tsx/dist/cli.mjs src/local/start.ts >> "$DATA/gatekeeper.log" 2>&1 || true
  echo "[\$(date '+%F %T')] stopped; restarting in 10 s" >> "$DATA/gatekeeper.log"
  sleep 10
done
EOF
chmod +x "$HOME/.gatekeeper-run.sh"

# ---- short commands
cat > "$BIN/gk-start" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
if [ -f "$DATA/.run.pid" ] && kill -0 "\$(cat "$DATA/.run.pid")" 2>/dev/null; then echo "Gatekeeper is already running."; exit 0; fi
nohup "$HOME/.gatekeeper-run.sh" >/dev/null 2>&1 &
echo "Starting Gatekeeper…"
for i in \$(seq 1 60); do
  if curl -fs -o /dev/null http://127.0.0.1:$PORT/healthz; then
    echo "Running. Setup page: http://localhost:$PORT/admin/whatsapp   Records: http://localhost:$PORT/admin/records"
    echo "Admin key: \$(cat "$DATA/admin-key.txt")"
    exit 0
  fi
  sleep 2
done
echo "Still starting (or failed). Check: gk-log"
EOF
cat > "$BIN/gk-stop" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
[ -f "$DATA/.run.pid" ] && kill "\$(cat "$DATA/.run.pid")" 2>/dev/null || true
rm -f "$DATA/.run.pid"
pkill -f gatekeeper-run.sh || true
pkill -f "src/local/start.ts" || true
termux-wake-unlock
echo "Gatekeeper stopped."
EOF
cat > "$BIN/gk-status" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
if curl -fs -o /dev/null http://127.0.0.1:$PORT/healthz; then echo "✅ Gatekeeper is running."; else echo "❌ Gatekeeper is not answering. Run gk-start, or see gk-log."; fi
EOF
cat > "$BIN/gk-key" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
cat "$DATA/admin-key.txt" 2>/dev/null || echo "No key yet: run gk-start first."
EOF
cat > "$BIN/gk-log" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
tail -n "\${1:-60}" "$DATA/gatekeeper.log"
EOF
cat > "$BIN/gk-update" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Download first: if the network is down, the running bot is left alone.
if ! git -C "$SRC" fetch --depth 1 origin "$BRANCH"; then
  echo "❌ Couldn't download the update (no internet, or GitHub unreachable). Gatekeeper keeps running the current version."
  echo "   Try again later, or switch between Wi-Fi and mobile data."
  exit 1
fi
set -e
gk-stop
git -C "$SRC" checkout -q -B "$BRANCH" FETCH_HEAD
bash "$APP/scripts/android/install.sh"
EOF
cat > "$BIN/gk-set" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# gk-set                      show the settings
# gk-set SUMMARY_TIME 22:45   change one and restart the bot
F="$DATA/settings.env"
touch "\$F"
if [ \$# -lt 2 ]; then echo "Settings (\$F):"; cat "\$F"; echo "(empty = defaults)"; exit 0; fi
case "\$1" in
  SUMMARY_TIME|WA_HUBHOP_ALERTS|WA_READMIT_REMINDERS|WA_SUPERVISOR_ONLY|COOL_OFF_MINUTES|RETENTION_HOURS|TZ_DISPLAY) ;;
  *) echo "Unknown setting: \$1"; echo "Use one of: SUMMARY_TIME WA_HUBHOP_ALERTS WA_READMIT_REMINDERS WA_SUPERVISOR_ONLY COOL_OFF_MINUTES RETENTION_HOURS TZ_DISPLAY"; exit 1 ;;
esac
case "\$2" in *\'*) echo "Values can't contain quotes."; exit 1 ;; esac
grep -v "^\$1=" "\$F" > "\$F.tmp" || true
echo "\$1='\$2'" >> "\$F.tmp"
mv "\$F.tmp" "\$F"
echo "Saved \$1=\$2. Restarting…"
gk-stop >/dev/null
gk-start
EOF
chmod +x "$BIN"/gk-start "$BIN"/gk-stop "$BIN"/gk-status "$BIN"/gk-key "$BIN"/gk-log "$BIN"/gk-update "$BIN"/gk-set

# ---- start again after the phone restarts (needs the Termux:Boot app, opened once)
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/gatekeeper" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
"$HOME/.gatekeeper-run.sh" >/dev/null 2>&1 &
EOF
chmod +x "$HOME/.termux/boot/gatekeeper"

say "Installed. Starting Gatekeeper"
gk-start

cat <<'EOF'

Next:
  1. Open Chrome on this phone: http://localhost:3000/admin/whatsapp
  2. Paste the admin key above, then link the WhatsApp phone (scan the QR, or use "Get code").
  3. Tick your work group, Save, Send test.

Commands: gk-status · gk-key · gk-log · gk-stop · gk-start · gk-update · gk-set
EOF
