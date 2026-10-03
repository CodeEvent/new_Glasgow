#!/data/data/com.termux/files/usr/bin/bash
# Gatekeeper on an Android phone (Termux). Installs, or updates if already installed:
#
#   curl -fsSL https://raw.githubusercontent.com/CodeEvent/new_Glasgow/claude/inspiring-fermi-ujdf1c/incident-tracker/scripts/android/install.sh | bash
#
# Afterwards:  gk-start | gk-stop | gk-status | gk-key | gk-log | gk-update
set -euo pipefail

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
set -e
gk-stop
curl -fsSL "https://raw.githubusercontent.com/CodeEvent/new_Glasgow/$BRANCH/incident-tracker/scripts/android/install.sh" | bash
EOF
chmod +x "$BIN"/gk-start "$BIN"/gk-stop "$BIN"/gk-status "$BIN"/gk-key "$BIN"/gk-log "$BIN"/gk-update

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

Commands: gk-status · gk-key · gk-log · gk-stop · gk-start · gk-update
EOF
