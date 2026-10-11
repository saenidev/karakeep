#!/usr/bin/env bash

# Keeps `pnpm local` (scripts/run-local.sh) running as a launchd agent: it
# starts at login, restarts if it dies, and binds the Tailscale IP plus
# 127.0.0.1 on PORT. The Meilisearch container is set to come back whenever
# Docker starts.
#
# Usage:
#   scripts/local-service.sh install     # install (or reinstall) and start it
#   scripts/local-service.sh restart     # restart, rebuilding if the code changed
#   scripts/local-service.sh status
#   scripts/local-service.sh uninstall
#
# Env overrides (read at install):
#   PORT               web port (default: 3100)
#   MEILI_CONTAINER    Meilisearch docker container (default: karakeep-meilisearch)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="app.karakeep.local"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/karakeep-local.log"
DOMAIN="gui/$(id -u)"
PORT="${PORT:-3100}"
MEILI_CONTAINER="${MEILI_CONTAINER:-karakeep-meilisearch}"

log() {
    printf '==> %s\n' "$*"
}

# bootout returns before the job has stopped, and bootstrapping it again
# before then fails, so wait for it to go away.
stop_job() {
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || return 0
    for _ in $(seq 1 60); do
        launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || return 0
        sleep 0.5
    done
    log "$LABEL didn't stop within 30s"
    exit 1
}

# What launchd runs: bind the Tailscale IP (fails until Tailscale is up, and
# launchd retries) and 127.0.0.1.
run() {
    local ip
    ip="$(tailscale ip -4 | head -n 1)"
    if [ -z "$ip" ]; then
        log "No Tailscale IP yet"
        exit 1
    fi
    HOST="$ip,127.0.0.1" exec bash "$ROOT/scripts/run-local.sh"
}

install() {
    local node_bin pnpm_bin
    node_bin="$(dirname "$(command -v node)")"
    pnpm_bin="$(dirname "$(command -v pnpm)")"

    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$ROOT/scripts/local-service.sh</string>
        <string>run</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$node_bin:$pnpm_bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>PORT</key>
        <string>$PORT</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <!-- Don't respawn faster than every 30s, e.g. while Tailscale is down. -->
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <!-- run-local.sh needs up to 5s to stop web and workers. -->
    <key>ExitTimeOut</key>
    <integer>15</integer>
    <!-- Not Background: that throttles CPU and I/O, which made page loads
         several times slower. Idle, it uses next to no CPU either way. -->
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
EOF

    if command -v docker >/dev/null && docker inspect "$MEILI_CONTAINER" >/dev/null 2>&1; then
        log "Starting $MEILI_CONTAINER and restarting it with Docker"
        docker update --restart unless-stopped "$MEILI_CONTAINER" >/dev/null
        docker start "$MEILI_CONTAINER" >/dev/null
    else
        log "No $MEILI_CONTAINER container found; start Meilisearch yourself"
    fi

    stop_job
    launchctl bootstrap "$DOMAIN" "$PLIST"
    log "Installed $LABEL (log: $LOG)"
    log "It builds first if the code changed, so the first start can take a few minutes"
}

uninstall() {
    stop_job
    rm -f "$PLIST"
    log "Removed $LABEL ($MEILI_CONTAINER keeps its restart policy)"
}

status() {
    if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        log "$LABEL is not installed"
        exit 1
    fi
    launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid|last exit code) ='
    if curl -s -o /dev/null -m 5 "http://127.0.0.1:$PORT/api/health"; then
        log "Healthy at http://127.0.0.1:$PORT"
    else
        log "Not answering on http://127.0.0.1:$PORT yet (see $LOG)"
    fi
}

case "${1:-}" in
    run) run ;;
    install) install ;;
    restart) launchctl kickstart -k "$DOMAIN/$LABEL" ;;
    status) status ;;
    uninstall) uninstall ;;
    *)
        echo "Usage: $0 install|restart|status|uninstall" >&2
        exit 1
        ;;
esac
