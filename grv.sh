#!/usr/bin/env bash
# Run / stop the Git Remote Viewer server in the background.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$DIR/.grv.pid"
LOG="$DIR/grv.log"
PORT="${PORT:-4570}"

# True only if $1 is alive AND is our `node server.js` from THIS directory.
is_ours() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local cmd; cmd="$(tr '\0' ' ' 2>/dev/null < "/proc/$pid/cmdline" || true)"
  [[ "$cmd" == *"server.js"* ]] || return 1
  local cwd; cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$cwd" == "$DIR" ]] || return 1
  return 0
}

running_pid() {           # echo the verified PID if running, else nothing
  [[ -f "$PIDFILE" ]] || return 1
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if is_ours "$pid"; then echo "$pid"; return 0; fi
  rm -f "$PIDFILE"; return 1        # stale pidfile
}

start() {
  if pid="$(running_pid)"; then
    echo "Already running (pid $pid) → http://localhost:$PORT"; return 0
  fi
  cd "$DIR"
  PORT="$PORT" nohup node server.js >"$LOG" 2>&1 &
  local pid=$!
  echo "$pid" > "$PIDFILE"
  sleep 1
  if is_ours "$pid"; then
    echo "Started (pid $pid) → http://localhost:$PORT  (logs: $LOG)"
  else
    echo "Failed to start; see $LOG"; rm -f "$PIDFILE"; return 1
  fi
}

stop() {
  local pid; pid="$(running_pid || true)"
  if [[ -z "${pid:-}" ]]; then echo "Not running (no tracked process)."; return 0; fi
  kill "$pid" 2>/dev/null || true          # SIGTERM
  for _ in $(seq 1 10); do is_ours "$pid" || break; sleep 0.3; done
  if is_ours "$pid"; then kill -9 "$pid" 2>/dev/null || true; sleep 0.3; fi
  rm -f "$PIDFILE"
  echo "Stopped (pid $pid)."
}

status() {
  if pid="$(running_pid)"; then echo "Running (pid $pid) → http://localhost:$PORT";
  else echo "Not running."; fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  *) echo "Usage: $0 {start|stop|restart|status}"; exit 2 ;;
esac
