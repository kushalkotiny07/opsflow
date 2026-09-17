#!/usr/bin/env bash
#
# Keep the WhatsApp gateway running.
#
# It has died three times, every time for the same reason: it was started in a
# foreground terminal, so closing that window (or Ctrl-C, or the laptop
# sleeping the shell) took it with it. The logs show no crash — the last line
# is always a normal one. So this is a supervision problem, not a bug, and the
# fix is to detach it from the terminal and restart it if it ever does exit.
#
#   ./run-gateway.sh start     detach and supervise (safe to re-run)
#   ./run-gateway.sh stop      stop it and the supervisor
#   ./run-gateway.sh status    is it up, and since when
#   ./run-gateway.sh logs      follow the log
#
# DRY_RUN defaults to false here because a supervised gateway is one you intend
# to be live. Override for a dry run:  DRY_RUN=true ./run-gateway.sh start
set -euo pipefail

cd "$(dirname "$0")"

PIDFILE=".gateway.pid"
SUPERVISOR_PIDFILE=".gateway-supervisor.pid"
LOG="gateway.log"
DRY_RUN="${DRY_RUN:-false}"

is_running() {
  local file="$1"
  [ -f "$file" ] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

case "${1:-start}" in
  start)
    # Starting a second copy against the same auth/ folder makes WhatsApp close
    # BOTH sessions — the surest way to break a working link.
    if is_running "$SUPERVISOR_PIDFILE" || is_running "$PIDFILE"; then
      echo "Already running (pid $(cat "$PIDFILE" 2>/dev/null || echo '?')). Use ./run-gateway.sh status"
      exit 0
    fi

    # setsid detaches from the controlling terminal so closing the window is
    # no longer fatal; nohup covers the SIGHUP if setsid is unavailable.
    supervise() {
      local attempt=0
      while true; do
        echo "[supervisor] starting gateway (DRY_RUN=$DRY_RUN) at $(date -u +%FT%TZ)" >> "$LOG"
        set +e
        DRY_RUN="$DRY_RUN" node index.mjs >> "$LOG" 2>&1 &
        local child=$!
        echo "$child" > "$PIDFILE"
        wait "$child"
        local code=$?
        set -e
        rm -f "$PIDFILE"
        echo "[supervisor] gateway exited with $code at $(date -u +%FT%TZ)" >> "$LOG"

        # A clean stop (SIGTERM/SIGINT from ./run-gateway.sh stop) must not be
        # undone by an automatic restart.
        if [ "$code" -eq 143 ] || [ "$code" -eq 130 ]; then
          echo "[supervisor] stopped deliberately — not restarting" >> "$LOG"
          break
        fi

        # A logged-out session (WhatsApp code 401) exits 0, so the exit code
        # alone looks like a clean shutdown. Restarting it just fails again a
        # few seconds later, forever — only a human with a phone can fix it.
        if tail -30 "$LOG" | grep -q "Logged out"; then
          echo "[supervisor] WhatsApp session is LOGGED OUT — re-link required." >> "$LOG"
          echo "[supervisor] Run: ./run-gateway.sh relink    then scan the QR." >> "$LOG"
          break
        fi

        attempt=$((attempt + 1))
        local delay=$(( attempt < 6 ? attempt * 5 : 30 ))
        echo "[supervisor] restart #$attempt in ${delay}s" >> "$LOG"
        sleep "$delay"
      done
      rm -f "$SUPERVISOR_PIDFILE"
    }

    export -f is_running 2>/dev/null || true
    if command -v setsid >/dev/null 2>&1; then
      setsid bash -c "$(declare -f supervise); DRY_RUN=$DRY_RUN LOG=$LOG PIDFILE=$PIDFILE SUPERVISOR_PIDFILE=$SUPERVISOR_PIDFILE supervise" >/dev/null 2>&1 &
    else
      nohup bash -c "$(declare -f supervise); DRY_RUN=$DRY_RUN LOG=$LOG PIDFILE=$PIDFILE SUPERVISOR_PIDFILE=$SUPERVISOR_PIDFILE supervise" >/dev/null 2>&1 &
    fi
    echo "$!" > "$SUPERVISOR_PIDFILE"
    disown 2>/dev/null || true

    echo "Gateway starting (DRY_RUN=$DRY_RUN). Log: $(pwd)/$LOG"
    echo "Watch it:   ./run-gateway.sh logs"
    echo "Check it:   node ../node_modules/.bin/tsx ../prisma/check_poll_readiness.ts"
    ;;

  stop)
    if is_running "$SUPERVISOR_PIDFILE"; then
      kill "$(cat "$SUPERVISOR_PIDFILE")" 2>/dev/null || true
    fi
    if is_running "$PIDFILE"; then
      kill "$(cat "$PIDFILE")" 2>/dev/null || true
      echo "Stopped gateway."
    else
      echo "Gateway was not running."
    fi
    rm -f "$PIDFILE" "$SUPERVISOR_PIDFILE"
    ;;

  status)
    if is_running "$PIDFILE"; then
      pid="$(cat "$PIDFILE")"
      echo "Gateway RUNNING (pid $pid)"
      ps -p "$pid" -o pid,etime,command | tail -1
    else
      echo "Gateway NOT running"
    fi
    is_running "$SUPERVISOR_PIDFILE" && echo "Supervisor running (will restart on exit)" || echo "Supervisor not running"
    ;;

  relink)
    # Retire the dead credentials so the next start produces a fresh QR.
    # Moved rather than deleted: if the session turns out to have been fine
    # after all, it can be put back. A 401 means these are already useless.
    if is_running "$PIDFILE" || is_running "$SUPERVISOR_PIDFILE"; then
      echo "Stop it first: ./run-gateway.sh stop"
      exit 1
    fi
    if [ -d auth ] && [ -n "$(ls -A auth 2>/dev/null)" ]; then
      backup="auth.loggedout.$(date -u +%Y%m%dT%H%M%SZ)"
      mv auth "$backup"
      mkdir -p auth
      echo "Old credentials moved to $backup"
    else
      echo "No existing credentials — nothing to retire."
      mkdir -p auth
    fi
    echo "Now run: ./run-gateway.sh start"
    echo "Then scan the QR in the console (Settings -> WhatsApp) or in $LOG"
    ;;

  logs)
    tail -f "$LOG"
    ;;

  *)
    echo "Usage: ./run-gateway.sh [start|stop|status|logs|relink]"
    exit 1
    ;;
esac
