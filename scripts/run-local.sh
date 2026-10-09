#!/usr/bin/env bash

# Runs Karakeep (web + workers) from production builds, for day-to-day use on
# this machine. Compared to `pnpm dev:worktree` there's no on-demand compiling,
# no file watching, and no pnpm/tsx wrapper processes, so pages load fast and
# it uses a fraction of the memory.
#
# Usage:
#   pnpm local           # build if the code changed, migrate, then run until stopped
#   pnpm local build     # rebuild web + workers only
#
# Env overrides:
#   PORT   web port (default: 3100)
#   HOST   address to bind and to use in NEXTAUTH_URL (default: localhost)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${TMPDIR:-/tmp}/karakeep-local"
STANDALONE="apps/web/.next/standalone"
BUILT_AT=".local-build-rev"

log() {
    printf '==> %s\n' "$*"
}

# The commit plus a hash of uncommitted changes, so edits trigger a rebuild.
source_rev() {
    {
        git rev-parse HEAD
        git diff HEAD -- apps packages | shasum
    } | shasum | cut -d' ' -f1
}

build() {
    log "Building web"
    (cd apps/web && pnpm exec next build --experimental-build-mode compile)
    # The standalone server doesn't serve static files or public/ itself.
    rsync -a --delete apps/web/.next/static/ "$STANDALONE/apps/web/.next/static/"
    rsync -a --delete apps/web/public/ "$STANDALONE/apps/web/public/"
    log "Building workers"
    (cd apps/workers && pnpm build)
    source_rev >"$BUILT_AT"
}

build_if_stale() {
    if [ ! -f "$BUILT_AT" ] || [ "$(cat "$BUILT_AT")" != "$(source_rev)" ]; then
        build
    fi
}

WEB_PID=""
WORKERS_PID=""

cleanup() {
    trap - EXIT INT TERM
    log "Stopping web and workers"
    for pid in $WEB_PID $WORKERS_PID; do
        kill -TERM "$pid" 2>/dev/null || true
    done
    # Give them up to 5 seconds to exit, then force it.
    for _ in $(seq 1 25); do
        kill -0 $WEB_PID $WORKERS_PID 2>/dev/null || break
        sleep 0.2
    done
    kill -KILL $WEB_PID $WORKERS_PID 2>/dev/null || true
}

fail_if_dead() {
    local name pid
    for name in web workers; do
        if [ "$name" = web ]; then pid=$WEB_PID; else pid=$WORKERS_PID; fi
        if ! kill -0 "$pid" 2>/dev/null; then
            log "The $name process exited. Last lines of $LOG_DIR/$name.log:"
            tail -n 30 "$LOG_DIR/$name.log"
            exit 1
        fi
    done
}

start() {
    build_if_stale

    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
    export PORT="${PORT:-3100}"
    export HOSTNAME="${HOST:-localhost}"
    export NEXTAUTH_URL="http://$HOSTNAME:$PORT"
    export NODE_ENV=production
    # A small young generation keeps V8 from holding on to ~100MB of heap it
    # grew into during startup and no longer uses.
    local node_flags="--max-semi-space-size=2"

    log "Migrating the database and the queue"
    (cd packages/db && node --import tsx migrate.ts)
    (cd apps/workers && node --import tsx scripts/migrateQueue.ts)

    mkdir -p "$LOG_DIR"
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    log "Starting workers (log: $LOG_DIR/workers.log)"
    (cd apps/workers && exec node $node_flags dist/index.js) >"$LOG_DIR/workers.log" 2>&1 &
    WORKERS_PID=$!

    log "Starting web on $NEXTAUTH_URL (log: $LOG_DIR/web.log)"
    (cd "$STANDALONE/apps/web" && exec node $node_flags server.js) >"$LOG_DIR/web.log" 2>&1 &
    WEB_PID=$!

    local deadline=$((SECONDS + 60))
    until curl -s -o /dev/null -m 5 "$NEXTAUTH_URL/api/health"; do
        fail_if_dead
        if [ "$SECONDS" -ge "$deadline" ]; then
            log "The web app didn't become ready within a minute"
            exit 1
        fi
        sleep 0.5
    done
    log "Karakeep is ready at $NEXTAUTH_URL (Ctrl+C to stop)"

    while :; do
        fail_if_dead
        sleep 2
    done
}

case "${1:-start}" in
    build) build ;;
    start) start ;;
    *)
        echo "Usage: $0 [build|start]" >&2
        exit 1
        ;;
esac
