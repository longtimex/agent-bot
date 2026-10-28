#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PID_FILE="data/bot.pid"
LOG_FILE="data/bot.log"
mkdir -p data

# Guard against a stale PID file that now points at an unrelated process
is_bot_process() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [ -r "/proc/$pid/cmdline" ] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'dist/index.js'
}

if [ -f "$PID_FILE" ]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_bot_process "${pid:-}"; then
    echo "stopping bot $pid"
    kill -TERM "$pid"
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "bot did not exit in time, sending SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  elif [ -n "${pid:-}" ]; then
    echo "ignoring stale pid file: $pid is not this bot"
    rm -f "$PID_FILE"
  fi
fi

if [ ! -f dist/index.js ]; then
  echo "dist/index.js not found, run npm run build first" >&2
  exit 1
fi

if [ -f "$LOG_FILE" ]; then
  size="$(wc -c < "$LOG_FILE" | tr -d ' ')"
  if [ "${size:-0}" -gt 10485760 ]; then
    rotated="$LOG_FILE.$(date +%Y%m%d-%H%M%S)"
    mv "$LOG_FILE" "$rotated"
    echo "rotated $LOG_FILE -> $rotated"
  fi
fi

nohup env BOT_LOG_FILE="$PWD/$LOG_FILE" node dist/index.js >> "$LOG_FILE" 2>&1 &
pid=$!
echo "$pid" > "$PID_FILE"

sleep 1
if ! kill -0 "$pid" 2>/dev/null; then
  echo "bot failed to start, last log lines:" >&2
  tail -n 20 "$LOG_FILE" >&2 || true
  rm -f "$PID_FILE"
  exit 1
fi

echo "started bot $pid"
