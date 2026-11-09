#!/usr/bin/env bash
# Activate the release recorded as pending in data/releases/state.json, start it,
# probe /health and roll back automatically if the new process never answers.
#
# The Bot starts this script detached: its own SIGTERM/exit must not take the
# supervisor with it. All state writes go through release-control.js so the JSON
# format has one implementation.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
DATA_DIR="${DATA_DIR:-data}"
STATE="$DATA_DIR/releases/state.json"
PID_FILE="$DATA_DIR/bot.pid"
LOCK_FILE="$DATA_DIR/bot.lock"
LOG_FILE="$DATA_DIR/bot.log"
HEALTH_TIMEOUT="${RELEASE_HEALTH_TIMEOUT:-45}"
HEALTH_INTERVAL="${RELEASE_HEALTH_INTERVAL:-1}"
HEALTH_PROBE="${RELEASE_HEALTH_PROBE:-scripts/release-health.mjs}"
SUPERVISOR="${RELEASE_SUPERVISOR:-auto}"
if [ "$SUPERVISOR" = "auto" ]; then
  if [ -n "${INVOCATION_ID:-}${SYSTEMD_EXEC_PID:-}" ] || [ -f /run/systemd/system ]; then
    SUPERVISOR=systemd
  else
    SUPERVISOR=script
  fi
fi
mkdir -p "$DATA_DIR"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"; }

# Use the checkout's control CLI while it exists; otherwise borrow the one from
# the active release. A managed release can legitimately be the only built tree
# after `npm run build` output is cleaned from the checkout.
control_js="$ROOT/dist/release-control.js"
if [ ! -f "$control_js" ]; then
  candidate="$(node -e 'const fs=require("fs");const p=process.argv[1];try{const s=JSON.parse(fs.readFileSync(p,"utf8"));for(const key of ["current","pending","previous"]){const r=s[key];if(r&&r.path&&fs.existsSync(r.path+"/dist/release-control.js")){process.stdout.write(r.path+"/dist/release-control.js");break}}}catch{}' "$STATE" 2>/dev/null || true)"
  [ -n "$candidate" ] && [ -f "$candidate" ] && control_js="$candidate"
fi
if [ ! -f "$control_js" ]; then
  log "apply-release: release-control.js is unavailable in both the checkout and the release store"
  exit 1
fi

entry_for() {
  node "$control_js" entry "$1"
}

current_entry="$(entry_for current 2>/dev/null || true)"
if [ -z "$current_entry" ] || [ ! -f "$current_entry" ]; then
  # Bootstrap: the checkout itself is the first release source.
  current_entry="$ROOT/dist/index.js"
fi
if [ ! -f "$current_entry" ]; then
  log "apply-release: no usable entrypoint at $current_entry"
  exit 1
fi

pending_entry="$(entry_for pending 2>/dev/null || true)"
has_pending=1
if [ -z "$pending_entry" ] || [ ! -f "$pending_entry" ]; then
  # A plain restart with no update still has to start the active release, not the
  # checkout's dist/ directory; otherwise the App and systemd would disagree about
  # which code is running.
  has_pending=0
  pending_entry="$current_entry"
  log "apply-release: no pending release; restarting current entry $current_entry"
else
  log "apply-release: activating $pending_entry (rollback target $current_entry, supervisor $SUPERVISOR)"
fi
# systemd owns the process: never kill or start it here. Activation is a state
# write, then `systemctl restart` starts the new entry; rollback is a second
# restart after moving the state pointer back.
if [ "$SUPERVISOR" = "systemd" ]; then
  service="${RELEASE_SYSTEMD_UNIT:-telegram-bot}"
  if ! command -v systemctl >/dev/null 2>&1; then
    log "apply-release: systemd selected but systemctl is unavailable"
    exit 1
  fi
  if [ "$has_pending" -eq 1 ]; then
    node "$control_js" activate >> "$LOG_FILE" 2>&1
    active_entry="$(entry_for current 2>/dev/null || true)"
    if [ -z "$active_entry" ] || [ ! -f "$active_entry" ]; then
      log "apply-release: activation produced no usable entry; rolling back"
      node "$control_js" rollback >> "$LOG_FILE" 2>&1 || true
      exit 1
    fi
  fi
  # A restart triggered by the service itself cannot use plain `systemctl restart`: the
  # command kills this installer before it can start the new unit. `systemd-run` launches
  # the restart in a transient unit outside the bot's cgroup; manual runs still use sudo.
  restart_systemd() {
    if [ "${RELEASE_APPLY_MODE:-}" = "1" ] && command -v systemd-run >/dev/null 2>&1; then
      sudo -n systemd-run --collect --unit="agent-bot-restart-$$" --description="Restart $service" systemctl restart "$service" >> "$LOG_FILE" 2>&1 && return 0
      systemd-run --collect --unit="agent-bot-restart-$$" --description="Restart $service" systemctl restart "$service" >> "$LOG_FILE" 2>&1 && return 0
    fi
    sudo -n systemctl restart "$service" >> "$LOG_FILE" 2>&1 || systemctl restart "$service" >> "$LOG_FILE" 2>&1
  }
  # Capture the launch boundary before restarting. The health probe rejects a
  # startup-check.json older than this instant, which prevents a stale success
  # record from accepting a process that failed before writing its own check.
  release_start_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
  restart_systemd || {
    log "apply-release: systemctl restart $service failed"
    [ "$has_pending" -eq 1 ] && node "$control_js" rollback >> "$LOG_FILE" 2>&1 || true
    exit 1
  }
  healthy=0
  for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
    if DATA_DIR="$DATA_DIR" RELEASE_EXPECTED_ID="$(node "$control_js" current-id 2>/dev/null || true)" RELEASE_START_AT="$release_start_at" node "$HEALTH_PROBE" >> "$LOG_FILE" 2>&1; then
      healthy=1
      break
    fi
    sleep "$HEALTH_INTERVAL"
  done
  if [ "$healthy" -eq 1 ]; then
    [ "$has_pending" -eq 1 ] && node "$control_js" record-ok >> "$LOG_FILE" 2>&1 || true
    log "apply-release: systemd release healthy"
    exit 0
  fi
  log "apply-release: systemd release failed health check; rolling back"
  [ "$has_pending" -eq 1 ] && node "$control_js" rollback >> "$LOG_FILE" 2>&1 || true
  restart_systemd || true
  exit 1
fi

# Script mode does not have systemd to restart the old process for us. Activate
# and validate the new pointer while the old bot is still serving; if the state
# write fails there is no downtime at all.
if [ "$has_pending" -eq 1 ]; then
  node "$control_js" activate >> "$LOG_FILE" 2>&1
fi
active_entry="$(entry_for current 2>/dev/null || true)"
if [ -z "$active_entry" ] || [ ! -f "$active_entry" ]; then
  log "apply-release: activation did not produce a usable entry; rolling back"
  [ "$has_pending" -eq 1 ] && node "$control_js" rollback >> "$LOG_FILE" 2>&1 || true
  exit 1
fi

# Stop the old process before swapping. The lock guard uses the same identity
# checks as restart.sh, so a stale PID can never kill an unrelated process.
stop_pid=""
if [ -f "$PID_FILE" ]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'dist/index.js'; then
    stop_pid="$pid"
  fi
fi
if [ -z "$stop_pid" ] && [ -f "$LOCK_FILE" ]; then
  read -r lock_pid _ < "$LOCK_FILE" || true
  if [ -n "${lock_pid:-}" ] && kill -0 "$lock_pid" 2>/dev/null && [ -r "/proc/$lock_pid/cmdline" ] && tr '\0' ' ' < "/proc/$lock_pid/cmdline" | grep -q 'dist/index.js'; then
    stop_pid="$lock_pid"
  fi
fi
if [ -n "$stop_pid" ]; then
  log "apply-release: stopping old bot $stop_pid"
  kill -TERM "$stop_pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$stop_pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$stop_pid" 2>/dev/null; then
    log "apply-release: old bot did not exit, SIGKILL"
    kill -KILL "$stop_pid" 2>/dev/null || true
  fi
fi

# Rotate the log the same way restart.sh does, then start under nohup. The
# health probe reads the new process's API, not just "process exists".
if [ -f "$LOG_FILE" ]; then
  size="$(wc -c < "$LOG_FILE" | tr -d ' ')"
  if [ "${size:-0}" -gt 10485760 ]; then
    mv "$LOG_FILE" "$LOG_FILE.$(date +%Y%m%d-%H%M%S)"
  fi
fi
# Capture the launch boundary before starting the new process. The health probe
# additionally verifies the PID for this supervisor mode.
release_start_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
nohup env BOT_LOG_FILE="$PWD/$LOG_FILE" RELEASE_APPLY_MODE=1 node "$active_entry" >> "$LOG_FILE" 2>&1 &
new_pid=$!
echo "$new_pid" > "$PID_FILE"
log "apply-release: started $new_pid from $active_entry"

healthy=0
for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
  if ! kill -0 "$new_pid" 2>/dev/null; then
    log "apply-release: new process exited before becoming healthy"
    break
  fi
  if DATA_DIR="$DATA_DIR" RELEASE_EXPECTED_ID="$(node "$control_js" current-id 2>/dev/null || true)" RELEASE_EXPECTED_PID="$new_pid" RELEASE_START_AT="$release_start_at" node "$HEALTH_PROBE" >> "$LOG_FILE" 2>&1; then
    healthy=1
    break
  fi
  sleep "$HEALTH_INTERVAL"
done

if [ "$healthy" -eq 1 ]; then
  if [ "$has_pending" -eq 1 ]; then
    node "$control_js" record-ok >> "$LOG_FILE" 2>&1 || true
  fi
  log "apply-release: release healthy (pid $new_pid)"
  exit 0
fi

log "apply-release: health check failed; killing $new_pid and rolling back"
kill -TERM "$new_pid" 2>/dev/null || true
for _ in $(seq 1 50); do kill -0 "$new_pid" 2>/dev/null || break; sleep 0.2; done
kill -KILL "$new_pid" 2>/dev/null || true
if [ "$has_pending" -eq 1 ]; then
  node "$control_js" rollback >> "$LOG_FILE" 2>&1 || true
fi
rollback_entry="$(entry_for current 2>/dev/null || true)"
if [ -n "$rollback_entry" ] && [ -f "$rollback_entry" ]; then
  nohup env BOT_LOG_FILE="$PWD/$LOG_FILE" RELEASE_APPLY_MODE=1 node "$rollback_entry" >> "$LOG_FILE" 2>&1 &
  rollback_pid=$!
  echo "$rollback_pid" > "$PID_FILE"
  log "apply-release: restored $rollback_entry as pid $rollback_pid"
else
  log "apply-release: no rollback entry available; bot is offline"
  exit 1
fi
# The old release is serving again, but this invocation still represents a
# failed update. Report that to the caller instead of letting a successful
# rollback masquerade as a successful activation.
exit 1
