#!/data/data/com.termux/files/usr/bin/bash
# Gatekeeper on an Android phone (Termux). Installs, or updates if already installed:
#
#   pkg install -y git
#   git clone --depth 1 -b claude/inspiring-fermi-ujdf1c https://github.com/CodeEvent/new_Glasgow.git ~/new_glasgow
#   bash ~/new_glasgow/incident-tracker/scripts/android/install.sh
#
# Afterwards:  gk-start | gk-stop | gk-status | gk-url | gk-key | gk-log | gk-update | gk-set
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
apt-get install -y -o Dpkg::Options::=--force-confnew nodejs-lts git procps curl termux-api cloudflared libqrencode

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

# ---- the tunnel: gives the app an https address other phones can open (free Cloudflare tunnel)
#   TUNNEL_TOKEN set (gk-set): your own fixed address (needs a domain on Cloudflare).
#   Otherwise a free quick tunnel: an address like https://xxxx.trycloudflare.com that changes when it restarts.
#   GK_TUNNEL=off (gk-set): no tunnel, only this phone can open the app.
cat > "$HOME/.gatekeeper-tunnel.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
PIDFILE="$DATA/.tunnel.pid"
if [ -f "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null; then exit 0; fi
echo \$\$ > "\$PIDFILE"
while true; do
  if [ -f "$DATA/settings.env" ]; then set -a; . "$DATA/settings.env"; set +a; fi
  if [ "\${GK_TUNNEL:-on}" = "off" ]; then rm -f "$DATA/url.txt"; sleep 60; continue; fi
  [ -f "$DATA/tunnel.log" ] && [ "\$(stat -c %s "$DATA/tunnel.log")" -gt 2000000 ] && mv -f "$DATA/tunnel.log" "$DATA/tunnel.old.log"
  echo "[\$(date '+%F %T')] tunnel starting" >> "$DATA/tunnel.log"
  if [ -n "\${TUNNEL_TOKEN:-}" ]; then
    # Fixed address: the hostname is set in the Cloudflare dashboard (TUNNEL_URL says what it is).
    [ -n "\${TUNNEL_URL:-}" ] && echo "\$TUNNEL_URL" > "$DATA/url.txt"
    cloudflared tunnel --no-autoupdate run --token "\$TUNNEL_TOKEN" >> "$DATA/tunnel.log" 2>&1 || true
  else
    rm -f "$DATA/url.txt"
    cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT 2>&1 | while IFS= read -r line; do
      echo "\$line" >> "$DATA/tunnel.log"
      url="\$(printf '%s' "\$line" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | head -1)"
      [ -n "\$url" ] && echo "\$url" > "$DATA/url.txt"
    done
  fi
  echo "[\$(date '+%F %T')] tunnel stopped; restarting in 15 s" >> "$DATA/tunnel.log"
  sleep 15
done
EOF
chmod +x "$HOME/.gatekeeper-tunnel.sh"

# ---- short commands
cat > "$BIN/gk-start" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
if [ -f "$DATA/.run.pid" ] && kill -0 "\$(cat "$DATA/.run.pid")" 2>/dev/null; then echo "Gatekeeper is already running."; exit 0; fi
nohup "$HOME/.gatekeeper-run.sh" >/dev/null 2>&1 &
nohup "$HOME/.gatekeeper-tunnel.sh" >/dev/null 2>&1 &
echo "Starting Gatekeeper…"
for i in \$(seq 1 60); do
  if curl -fs -o /dev/null http://127.0.0.1:$PORT/healthz; then
    echo "Running. On this phone: http://localhost:$PORT/app/"
    echo "Admin key (first-time setup): \$(cat "$DATA/admin-key.txt")"
    echo "For other phones, run: gk-url"
    exit 0
  fi
  sleep 2
done
echo "Still starting (or failed). Check: gk-log"
EOF
cat > "$BIN/gk-stop" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
[ -f "$DATA/.run.pid" ] && kill "\$(cat "$DATA/.run.pid")" 2>/dev/null || true
[ -f "$DATA/.tunnel.pid" ] && kill "\$(cat "$DATA/.tunnel.pid")" 2>/dev/null || true
rm -f "$DATA/.run.pid" "$DATA/.tunnel.pid" "$DATA/url.txt"
pkill -f gatekeeper-run.sh || true
pkill -f gatekeeper-tunnel.sh || true
pkill -f "cloudflared tunnel" || true
pkill -f "src/local/start.ts" || true
termux-wake-unlock
echo "Gatekeeper stopped."
EOF
cat > "$BIN/gk-status" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
if curl -fs -o /dev/null http://127.0.0.1:$PORT/healthz; then echo "✅ Gatekeeper is running."; else echo "❌ Gatekeeper is not answering. Run gk-start, or see gk-log."; fi
EOF
cat > "$BIN/gk-url" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# The address other phones open, and a QR code to scan.
for i in \$(seq 1 30); do [ -s "$DATA/url.txt" ] && break; sleep 2; done
if [ ! -s "$DATA/url.txt" ]; then echo "No public address yet. Check: tail $DATA/tunnel.log  (or gk-set GK_TUNNEL off to use this phone only)"; exit 1; fi
url="\$(cat "$DATA/url.txt")/app/"
echo "Open on any phone: \$url"
command -v qrencode >/dev/null && qrencode -t ANSIUTF8 "\$url"
case "\$url" in *trycloudflare.com*) echo "(A free quick address: it changes when the phone restarts. It's also shown in the app: Settings.)";; esac
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
touch "\$F"; chmod 600 "\$F"
# Show settings with the API key hidden.
if [ \$# -lt 2 ]; then echo "Settings (\$F):"; sed -E "s/^((ANTHROPIC|GEMINI|GROQ)_API_KEY=|TUNNEL_TOKEN=).*/\\1'(set, hidden)'/" "\$F"; echo "(empty = defaults)"; exit 0; fi
case "\$1" in
  WA_LINKED_ENABLED|GK_TUNNEL|TUNNEL_TOKEN|TUNNEL_URL|SUMMARY_TIME|WA_HUBHOP_ALERTS|WA_READMIT_REMINDERS|WA_SUPERVISOR_ONLY|WA_PRIVATE_CHATS|WA_BOT_PHONE_COMMANDS|WA_NIGHTLY_BACKUP|WA_HEALTH_ALERTS|ANTHROPIC_API_KEY|GEMINI_API_KEY|GROQ_API_KEY|AI_BASE_URL|AI_PROVIDER|AI_MODEL|AI_DAILY_LIMIT|OCR_ENABLED|COOL_OFF_MINUTES|RETENTION_HOURS|TZ_DISPLAY) ;;
  *) echo "Unknown setting: \$1"; echo "Use one of: WA_LINKED_ENABLED GK_TUNNEL TUNNEL_TOKEN TUNNEL_URL SUMMARY_TIME WA_HUBHOP_ALERTS WA_READMIT_REMINDERS WA_SUPERVISOR_ONLY WA_PRIVATE_CHATS WA_BOT_PHONE_COMMANDS WA_NIGHTLY_BACKUP WA_HEALTH_ALERTS ANTHROPIC_API_KEY GEMINI_API_KEY GROQ_API_KEY AI_BASE_URL AI_PROVIDER AI_MODEL AI_DAILY_LIMIT OCR_ENABLED COOL_OFF_MINUTES RETENTION_HOURS TZ_DISPLAY"; exit 1 ;;
esac
case "\$2" in *\'*) echo "Values can't contain quotes."; exit 1 ;; esac
grep -v "^\$1=" "\$F" > "\$F.tmp" || true
echo "\$1='\$2'" >> "\$F.tmp"
mv "\$F.tmp" "\$F"; chmod 600 "\$F"
if [ "\$1" = ANTHROPIC_API_KEY ] || [ "\$1" = GEMINI_API_KEY ] || [ "\$1" = GROQ_API_KEY ] || [ "\$1" = TUNNEL_TOKEN ]; then echo "Saved \$1 (hidden). Restarting…"; else echo "Saved \$1=\$2. Restarting…"; fi
gk-stop >/dev/null
gk-start
EOF
cat > "$BIN/gk-demo" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# gk-demo         delete ALL records and load made-up demo records (for practice)
# gk-demo clear   delete ALL records, no demo records
DEMO=true
[ "\${1:-}" = clear ] && DEMO=false
if [ "\$DEMO" = true ]; then echo "This deletes ALL records (with photos and notes) and loads demo records."; else echo "This deletes ALL records (with photos and notes)."; fi
echo "Your WhatsApp link, groups, policy and map are kept."
read -r -p "Type YES to continue: " ok
[ "\$ok" = YES ] || { echo "Cancelled. Nothing changed."; exit 1; }
curl -fsS -X POST "http://127.0.0.1:$PORT/admin/api/demo/reset" \\
  -H "x-admin-key: \$(cat "$DATA/admin-key.txt")" -H 'Content-Type: application/json' \\
  -d "{\"confirm\":\"DELETE ALL\",\"demo\":\$DEMO}" && echo || echo "Failed: is Gatekeeper running? (gk-status)"
EOF
cat > "$BIN/gk-unset" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# gk-unset GEMINI_API_KEY   remove a setting (back to its default) and restart the bot
F="$DATA/settings.env"
[ \$# -eq 1 ] || { echo "Usage: gk-unset NAME   (see the names with gk-set)"; exit 1; }
if [ -f "\$F" ] && grep -q "^\$1=" "\$F"; then
  grep -v "^\$1=" "\$F" > "\$F.tmp" || true
  mv "\$F.tmp" "\$F"; chmod 600 "\$F"
  echo "Removed \$1. Restarting…"
  gk-stop >/dev/null
  gk-start
else
  echo "\$1 isn't set."
fi
EOF
chmod +x "$BIN"/gk-start "$BIN"/gk-stop "$BIN"/gk-status "$BIN"/gk-url "$BIN"/gk-key "$BIN"/gk-log "$BIN"/gk-update "$BIN"/gk-set "$BIN"/gk-demo "$BIN"/gk-unset

# ---- start again after the phone restarts (needs the Termux:Boot app, opened once)
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/gatekeeper" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
"$HOME/.gatekeeper-run.sh" >/dev/null 2>&1 &
"$HOME/.gatekeeper-tunnel.sh" >/dev/null 2>&1 &
EOF
chmod +x "$HOME/.termux/boot/gatekeeper"

say "Installed. Starting Gatekeeper"
gk-start

cat <<'EOF'

Next:
  1. Open Chrome on this phone: http://localhost:3000/app/
  2. First time only: enter the admin key above, your name and a 6-digit PIN (you're the superadmin).
  3. Add your supervisors in People, then run gk-url and let them scan the QR code.

Commands: gk-status · gk-url · gk-key · gk-log · gk-stop · gk-start · gk-update · gk-set · gk-unset · gk-demo
EOF
